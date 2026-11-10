"use strict";
/*
 * End-of-day note emails: admin setup/status page and each user's on/off switch.
 *
 *   GET  /admin/email              setup status, schedule, recent sends (admin)
 *   POST /admin/email/test         send a sample summary to me (admin)
 *   POST /admin/email/send-now     send today's summaries now to everyone not yet emailed today (admin)
 *   POST /account/digest           turn my end-of-day email on/off (any user who writes notes)
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, page, csrfField, nowLocal, fmtTimestamp, TZ } = require("../views");
const mailer = require("../mailer");
const digest = require("../digest");

const router = express.Router();
const adminOnly = requirePerm("admin");

function emailPage(req, res, { result = null, error = null } = {}, status = 200) {
  const db = req.db;
  const mc = mailer.mailConfig();
  const dc = digest.digestConfig();
  const today = nowLocal().slice(0, 10);
  const recips = digest.recipients(db);
  const optedOut = db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND digest_email = 0").get().n;
  const runs = db.prepare("SELECT * FROM digest_runs ORDER BY run_date DESC LIMIT 10").all();
  const log = db.prepare(`SELECT d.*, u.name FROM digest_log d JOIN users u ON u.id = d.user_id WHERE d.run_date = ? ORDER BY u.name`).all(today);
  audit(req, "view", "email_settings");
  res.status(status).send(page(req, {
    title: "End-of-day emails",
    active: "admin",
    body: html`
      <div class="page-head"><div><h1>End-of-day note emails</h1><p>Each clinician gets an email before they leave listing how many notes they still need to write, sign or co-sign.</p></div>
        <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      ${result ? html`<div class="alert alert--${result.failed ? "warn" : "success"}" role="status">Sent ${result.sent}, skipped ${result.skipped}${result.failed ? `, failed ${result.failed} (see below)` : ""}.</div>` : ""}
      <div class="grid grid--2">
        <section class="card">
          <div class="card__head"><h2>Status</h2>${mc.enabled ? html`<span class="badge badge--good">Email ready (${mc.provider})</span>` : html`<span class="badge badge--bad">Not set up</span>`}</div>
          <dl class="facts">
            <dt>Sends at</dt><dd>${dc.off ? "Turned off (EHR_DIGEST=off)" : `${digest.fmt12(dc.time)} ${TZ.replace(/_/g, " ")}`}</dd>
            <dt>Days</dt><dd>${digest.dayLabel(dc.days)}</dd>
            <dt>From</dt><dd>${mc.from || html`<span class="muted">Not set</span>`}</dd>
            <dt>Link in email</dt><dd>${dc.url ? `${dc.url}/ehr` : html`<span class="muted">Not set (EHR_PUBLIC_URL)</span>`}</dd>
            <dt>Recipients</dt><dd>${recips.length} staff who write notes${optedOut ? ` · ${optedOut} turned it off` : ""}</dd>
          </dl>
          ${mc.enabled ? "" : html`<p class="alert alert--warn" style="margin-top:1rem">${mc.reason}</p>`}
          <p class="hint">Only people with something outstanding get an email. The email contains counts and a sign-in link, never patient names or details.</p>
          ${mc.enabled ? html`<div class="row" style="margin-top:1rem">
            <form method="post" action="/ehr/admin/email/test">${csrfField(req)}<button class="btn btn--sm" type="submit">Send me a sample</button></form>
            <form method="post" action="/ehr/admin/email/send-now" data-confirm="Send today's summaries now to everyone who hasn't had one today?">${csrfField(req)}<button class="btn btn--sm btn--primary" type="submit">Send today's emails now</button></form>
          </div>` : ""}
        </section>
        <section class="card">
          <h2>How to set it up</h2>
          <p class="small">In Render, open the <strong>clinic-ready</strong> service → <strong>Environment</strong> and add:</p>
          <p class="small"><strong>Gmail / Google Workspace</strong> (needs an App Password from your Google account security settings):</p>
          <pre class="small prewrap"><code>EHR_MAIL_PROVIDER=smtp
EHR_SMTP_HOST=smtp.gmail.com
EHR_SMTP_PORT=465
EHR_SMTP_USER=you@yourclinic.com
EHR_SMTP_PASS=(16-letter app password)
EHR_MAIL_FROM=Clinic Ready &lt;you@yourclinic.com&gt;</code></pre>
          <p class="small"><strong>Or Resend</strong> (works where outgoing mail ports are blocked): <code>EHR_MAIL_PROVIDER=resend</code>, <code>RESEND_API_KEY</code>, <code>EHR_MAIL_FROM</code>.</p>
          <p class="small">Optional: <code>EHR_DIGEST_TIME=16:30</code>, <code>EHR_DIGEST_DAYS=1-5</code> (0 = Sunday), <code>EHR_PUBLIC_URL=https://clinic-ready.onrender.com</code>.</p>
        </section>
      </div>
      <section class="card">
        <div class="card__head"><h2>Today</h2><span class="muted small">${today}</span></div>
        ${log.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Staff</th><th>Result</th><th>Detail</th><th>Time</th></tr></thead>
          <tbody>${log.map((l) => html`<tr><td>${l.name}</td><td><span class="badge badge--${l.status === "sent" ? "good" : l.status === "failed" ? "bad" : "muted"}">${l.status === "nothing" ? "Nothing outstanding" : l.status === "sent" ? "Sent" : "Failed"}</span></td><td class="small">${l.detail || ""}</td><td class="small">${fmtTimestamp(l.created_at)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">No emails sent yet today.</p>`}
      </section>
      ${runs.length ? html`<section class="card"><h2>Recent days</h2>
        <div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th class="num">Sent</th><th class="num">Skipped</th><th class="num">Failed</th></tr></thead>
        <tbody>${runs.map((r) => html`<tr><td>${r.run_date}</td><td class="num">${r.sent ?? "…"}</td><td class="num">${r.skipped ?? "…"}</td><td class="num">${r.failed ?? "…"}</td></tr>`)}</tbody></table></div></section>` : ""}`,
  }));
}

router.get("/admin/email", adminOnly, (req, res) => emailPage(req, res));

router.post("/admin/email/test", adminOnly, async (req, res) => {
  const u = req.db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const sample = { write: 2, sign: 1, cosign: can(u, "clinical:write") ? 1 : 0, awaiting: 0, overdue: 1, dueSoon: 2, oldestOverdueHours: 30 };
  sample.total = sample.write + sample.sign + sample.cosign;
  const mail = digest.composeEmail(u, sample);
  try {
    await mailer.sendMail({ to: u.email, ...mail, subject: `[Sample] ${mail.subject}` });
    audit(req, "email_test", "user", u.id, null, "sent");
    req.flash("success", `Sample email sent to ${u.email}.`);
    res.redirect("/ehr/admin/email");
  } catch (e) {
    audit(req, "email_test", "user", u.id, null, "failed");
    emailPage(req, res, { error: `Sending failed: ${String(e.message || e).slice(0, 300)}` }, 502);
  }
});

router.post("/admin/email/send-now", adminOnly, async (req, res) => {
  try {
    const r = await digest.runDigest(req.db);
    audit(req, "email_digest_run", null, null, null, `manual: sent ${r.sent}, skipped ${r.skipped}, failed ${r.failed}`);
    emailPage(req, res, { result: r });
  } catch (e) {
    emailPage(req, res, { error: String(e.message || e).slice(0, 300) }, 502);
  }
});

router.post("/account/digest", (req, res) => {
  const on = req.body && req.body.digest_email === "1" ? 1 : 0;
  req.db.prepare("UPDATE users SET digest_email = ? WHERE id = ?").run(on, req.user.id);
  audit(req, "update", "user", req.user.id, null, `digest_email=${on}`);
  req.flash("success", on ? "You'll get an end-of-day email when notes are outstanding." : "End-of-day emails turned off.");
  res.redirect("/ehr/account");
});

/** Card for the Account page. */
function accountCard(req) {
  if (!can(req.user, "clinical:write")) return "";
  const u = req.db.prepare("SELECT digest_email FROM users WHERE id = ?").get(req.user.id);
  const dc = digest.digestConfig();
  return html`
    <form class="card stack" method="post" action="/ehr/account/digest">
      ${csrfField(req)}
      <h2>End-of-day email</h2>
      <label class="check"><input type="checkbox" name="digest_email" value="1" ${u && u.digest_email ? html`checked` : ""}> Email me a summary of my outstanding notes</label>
      <p class="hint">Sent at ${digest.fmt12(dc.time)} on ${digest.dayLabel(dc.days)} only when you have notes to write, sign or co-sign. No patient information is included.</p>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Save</button></div>
    </form>`;
}

module.exports = { router, accountCard };
