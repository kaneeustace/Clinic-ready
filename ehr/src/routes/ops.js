"use strict";
/*
 * Running the EHR as a service for several clinics: each clinic has its own deployment and database.
 *
 *   GET /ops/status               health and usage counts for THIS clinic, as JSON. Requires
 *                                 "Authorization: Bearer <EHR_OPS_TOKEN>"; returns 404 when EHR_OPS_TOKEN isn't set.
 *                                 Counts only: never names, notes or any other patient information.
 *   GET /ehr/admin/customers      (admin) your customer list: calls /ops/status on every clinic in EHR_FLEET
 *                                 and shows them side by side.
 *
 *   EHR_FLEET = JSON list of clinics, e.g.
 *     [{"name":"Sunrise Counseling","url":"https://sunrise-ehr.onrender.com","token":"..."}]
 */
const crypto = require("node:crypto");
const express = require("express");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, page, fmtTimestamp } = require("../views");
const { getClinic } = require("../clinic");

const publicRouter = express.Router(); // mounted at /ops in app.js (no session, token only)
const router = express.Router();
const adminOnly = requirePerm("admin");
const STARTED = new Date().toISOString();
const version = () => String(process.env.RENDER_GIT_COMMIT || process.env.EHR_VERSION || "dev").slice(0, 7);

function tokenOk(req) {
  const want = String(process.env.EHR_OPS_TOKEN || "");
  if (want.length < 16) return false;
  const got = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const a = crypto.createHash("sha256").update(got).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Health and usage counts for this deployment (no PHI). */
function statusOf(db) {
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  const n = (sql, ...a) => (one(sql, ...a) || { n: 0 }).n;
  const c = getClinic(db);
  let storage = { persistent: null };
  try { storage = require("./admin").storageStatus(db); } catch { /* admin module not loaded */ }
  let backup = null;
  try { const s = require("../backup").state; backup = s.lastSuccess ? (s.lastSuccess.at || s.lastSuccess.time || s.lastSuccess) : null; } catch { backup = null; }
  return {
    clinic: c.name,
    version: version(),
    started_at: STARTED,
    checked_at: new Date().toISOString(),
    setup_complete: n("SELECT COUNT(*) AS n FROM users") > 0,
    users_active: n("SELECT COUNT(*) AS n FROM users WHERE active = 1"),
    clinicians_active: n("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role IN ('clinician','admin')"),
    patients_active: n("SELECT COUNT(*) AS n FROM patients WHERE status = 'active'"),
    notes_signed_30d: n("SELECT COUNT(*) AS n FROM notes WHERE status = 'signed' AND signed_at >= datetime('now','-30 days')"),
    last_sign_in: (one("SELECT MAX(last_login_at) AS t FROM users") || {}).t || null,
    storage_persistent: storage.persistent,
    last_backup: typeof backup === "string" ? backup : backup ? String(backup) : null,
    ai_review: require("../ai-review").aiStatus().enabled,
    email: require("../mailer").mailConfig().enabled,
    billing_details_complete: c.billingReady,
  };
}

publicRouter.get("/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!tokenOk(req)) return res.status(404).json({ error: "not found" });
  res.json(statusOf(req.db));
});

function fleet() {
  try {
    const list = JSON.parse(process.env.EHR_FLEET || "[]");
    return Array.isArray(list) ? list.filter((x) => x && x.url).map((x) => ({ name: String(x.name || x.url), url: String(x.url).replace(/\/+$/, ""), token: String(x.token || "") })) : [];
  } catch { return null; }
}

async function check(entry) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(`${entry.url}/ops/status`, { headers: { authorization: `Bearer ${entry.token}` }, signal: ctl.signal });
    if (r.status === 404) return { ...entry, ok: false, error: "Status link not enabled or wrong token (set EHR_OPS_TOKEN on that clinic)." };
    if (!r.ok) return { ...entry, ok: false, error: `HTTP ${r.status}` };
    return { ...entry, ok: true, s: await r.json() };
  } catch (e) {
    return { ...entry, ok: false, error: e.name === "AbortError" ? "No response in 12 s (asleep or down)." : "Couldn't connect." };
  } finally { clearTimeout(t); }
}

const yes = (v) => v === true ? html`<span class="badge badge--good">Yes</span>` : v === false ? html`<span class="badge badge--bad">No</span>` : html`<span class="badge badge--muted">?</span>`;

router.get("/admin/customers", adminOnly, async (req, res) => {
  const list = fleet();
  const self = { name: getClinic(req.db).name, url: "", ok: true, s: statusOf(req.db) };
  const results = list ? [self, ...(await Promise.all(list.map(check)))] : [self];
  audit(req, "view", "customers", null, null, `${results.length} clinics`);
  const mine = version();
  res.send(page(req, {
    title: "Customers",
    active: "admin",
    body: html`
      <div class="page-head"><div><h1>Customers</h1><p>Every clinic you host, checked live. Counts only, no patient information.</p></div>
        <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
      ${list === null ? html`<div class="alert alert--error" role="alert">EHR_FLEET isn't valid JSON. See the launch guide.</div>` : ""}
      ${list && !list.length ? html`<div class="alert alert--info" role="note">No other clinics yet. After you launch one, add it to <code>EHR_FLEET</code> on this service (see <code>docs/selling/launch-a-clinic.md</code>).</div>` : ""}
      <section class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Clinic</th><th>Status</th><th class="num">Staff</th><th class="num">Active clients</th><th class="num">Notes (30 d)</th><th>Last sign-in</th><th>Data saved</th><th>Backups</th><th>AI</th><th>Email</th><th>Version</th></tr></thead>
        <tbody>${results.map((r) => r.ok ? html`<tr>
            <td><strong>${r.s.clinic}</strong>${r.url ? "" : html` <span class="pill">This copy</span>`}${r.url ? html`<br><a class="small" href="${r.url}/ehr" target="_blank" rel="noopener">${r.url.replace(/^https?:\/\//, "")}</a>` : ""}
              ${r.s.setup_complete ? "" : html`<br><span class="badge badge--warn">Setup not finished</span>`}${r.s.billing_details_complete ? "" : html`<br><span class="badge badge--warn">NPI / tax ID missing</span>`}</td>
            <td><span class="badge badge--good">Up</span></td>
            <td class="num">${r.s.users_active}</td><td class="num">${r.s.patients_active}</td><td class="num">${r.s.notes_signed_30d}</td>
            <td class="small">${r.s.last_sign_in ? fmtTimestamp(r.s.last_sign_in) : "Never"}</td>
            <td>${yes(r.s.storage_persistent)}</td>
            <td class="small">${r.s.last_backup ? fmtTimestamp(String(r.s.last_backup).replace("T", " ").slice(0, 19)) : html`<span class="badge badge--bad">None</span>`}</td>
            <td>${yes(r.s.ai_review)}</td><td>${yes(r.s.email)}</td>
            <td class="small">${r.s.version}${r.s.version !== mine ? html` <span class="badge badge--warn">differs</span>` : ""}</td></tr>`
          : html`<tr><td><strong>${r.name}</strong><br><span class="small muted">${r.url}</span></td><td colspan="10"><span class="badge badge--bad">Down</span> <span class="small">${r.error}</span></td></tr>`)}</tbody>
      </table></div></section>
      <p class="hint">A clinic on Render's free plan may show "asleep". Paid clinics should always be Up, with Data saved = Yes and a recent backup.</p>`,
  }));
});

module.exports = { router, publicRouter, statusOf, tokenOk };
