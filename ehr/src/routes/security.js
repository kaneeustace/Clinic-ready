"use strict";
/*
 * Security monitoring (admin only). HIPAA 164.308(a)(1)(ii)(D) information system activity review,
 * 164.308(a)(6) security incident procedures, 164.312(b) audit controls.
 *   GET  /security                         open alerts, history, audit-chain status, 24h sign-in summary
 *   POST /security/alerts/:id/acknowledge  mark an open alert as being investigated
 *   POST /security/alerts/:id/resolve      close an alert with a resolution note
 *   POST /security/verify-audit            recompute the audit log hash chain now
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { audit, verifyAuditChain, lastVerification } = require("../audit");
const { html, page, csrfField, badge, humanize, fmtTimestamp } = require("../views");

const router = express.Router();
const adminOnly = requirePerm("admin");

const SEV_TONE = { high: "bad", medium: "warn", low: "info" };
const sevBadge = (s) => html`<span class="badge badge--${SEV_TONE[s] || "muted"}">${humanize(s)}</span>`;
const KIND_LABEL = {
  failed_logins: "Repeated failed sign-ins",
  bulk_access: "Bulk record access",
  after_hours: "After-hours record access",
  forbidden_burst: "Repeated denied requests",
  audit_chain_broken: "Audit log integrity failure",
  backup_failed: "Backup failed",
};
const kindLabel = (k) => KIND_LABEL[k] || humanize(k);

const ALERT_SELECT = `SELECT a.*, u.name AS user_name, u.role AS user_role, r.name AS resolver_name
  FROM security_alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.resolved_by`;

function getAlert(req) {
  if (!/^\d+$/.test(req.params.id)) return null;
  return req.db.prepare("SELECT * FROM security_alerts WHERE id = ?").get(Number(req.params.id)) || null;
}

router.get("/security", adminOnly, (req, res) => {
  const db = req.db;
  const open = db.prepare(`${ALERT_SELECT} WHERE a.status IN ('open','acknowledged')
    ORDER BY CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.ts DESC, a.id DESC`).all();
  const resolved = db.prepare(`${ALERT_SELECT} WHERE a.status = 'resolved' ORDER BY a.resolved_at DESC, a.id DESC LIMIT 50`).all();
  const counts = { high: 0, medium: 0, low: 0 };
  for (const a of open) counts[a.severity] = (counts[a.severity] || 0) + 1;

  const since = "datetime('now','-1 day')";
  const n = (sql) => db.prepare(sql).get().n;
  const logins = n(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login' AND ts >= ${since}`);
  const failed = n(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('login_failed','mfa_failed') AND ts >= ${since}`);
  const lockouts = n(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login_locked' AND ts >= ${since}`);
  const locked = db.prepare("SELECT id, name, email, locked_until FROM users WHERE locked_until > datetime('now') ORDER BY name").all();
  const noMfa = db.prepare("SELECT id, name, email, role FROM users WHERE active = 1 AND COALESCE(mfa_enabled, 0) = 0 ORDER BY name").all();

  let chain = lastVerification(db);
  if (!chain) chain = { ...verifyAuditChain(db), at: lastVerification(db).at };
  audit(req, "view", "security_dashboard", null, null, `open_alerts=${open.length}`);

  const alertRow = (a) => html`
    <tr>
      <td>${fmtTimestamp(a.ts)}</td>
      <td>${sevBadge(a.severity)}</td>
      <td><strong>${kindLabel(a.kind)}</strong>${a.detail ? html`<br><span class="muted small">${a.detail}</span>` : ""}</td>
      <td>${a.user_name ? html`${a.user_name} <span class="muted small">${humanize(a.user_role)}</span>` : html`<span class="muted">None</span>`}</td>
      <td>${a.patient_id ? html`<a href="/ehr/admin/patients/${a.patient_id}/access-report">Access report</a>` : ""}</td>
      <td>${badge(a.status === "acknowledged" ? "in_progress" : "new", humanize(a.status))}</td>
      <td>
        <div class="stack">
          ${a.status === "open" ? html`
            <form class="inline-form" method="post" action="/ehr/security/alerts/${a.id}/acknowledge">${csrfField(req)}
              <button class="btn btn--sm" type="submit">Acknowledge</button></form>` : ""}
          <form class="stack" method="post" action="/ehr/security/alerts/${a.id}/resolve">${csrfField(req)}
            <label class="visually-hidden" for="note-${a.id}">Resolution note</label>
            <textarea class="ta-sm" id="note-${a.id}" name="resolution_note" required maxlength="1000" placeholder="Resolution note (no PHI)"></textarea>
            <button class="btn btn--sm btn--primary" type="submit">Resolve</button>
          </form>
        </div>
      </td>
    </tr>`;

  res.send(page(req, {
    title: "Security",
    active: "security",
    body: html`
      <div class="page-head">
        <div><h1>Security</h1><p>Alerts, audit log integrity and sign-in activity.</p></div>
      </div>
      <div class="tiles">
        <div class="tile"><span class="tile__num">${open.length}</span><span class="tile__label">Open alerts (${counts.high} high, ${counts.medium} medium, ${counts.low} low)</span></div>
        <a class="tile" href="/ehr/admin/audit?action=login"><span class="tile__num">${logins}</span><span class="tile__label">Sign-ins (24h)</span></a>
        <a class="tile" href="/ehr/admin/audit?action=login_failed"><span class="tile__num">${failed}</span><span class="tile__label">Failed sign-ins (24h)</span></a>
        <div class="tile"><span class="tile__num">${locked.length}</span><span class="tile__label">Locked accounts (${lockouts} lockout events, 24h)</span></div>
        <div class="tile"><span class="tile__num">${noMfa.length}</span><span class="tile__label">Active users without MFA</span></div>
      </div>

      <section class="card">
        <div class="card__head"><h2>Open alerts</h2></div>
        ${open.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Raised</th><th>Severity</th><th>Alert</th><th>User</th><th>Patient</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${open.map(alertRow)}</tbody></table></div>` : html`<p class="muted">No open alerts.</p>`}
      </section>

      <div class="grid grid--2">
        <section class="card stack">
          <h2>Audit log integrity</h2>
          <p>${chain.ok ? badge("active", "Chain intact") : badge("denied", "Chain broken")}
            <span class="muted small">${chain.checked} entries checked · ${fmtTimestamp(chain.at)}</span></p>
          ${chain.ok ? "" : html`<div class="alert alert--error" role="alert">Verification failed at entry #${chain.firstBadId}. Entries from that point may have been altered or removed. Preserve the database and begin incident response.</div>`}
          <p class="hint">Each audit entry is hash-chained to the one before it, and the log is append-only. Entries are retained indefinitely (HIPAA requires at least 6 years).</p>
          <form method="post" action="/ehr/security/verify-audit">${csrfField(req)}
            <button class="btn btn--sm" type="submit">Verify now</button></form>
        </section>
        <section class="card stack">
          <h2>Accounts</h2>
          <h3>Locked</h3>
          ${locked.length ? html`<ul class="list-plain">${locked.map((u) => html`<li><a href="/ehr/admin/users/${u.id}/edit">${u.name}</a> <span class="muted small">until ${fmtTimestamp(u.locked_until)}</span></li>`)}</ul>`
            : html`<p class="muted">No locked accounts.</p>`}
          <h3>Without multi-factor authentication</h3>
          ${noMfa.length ? html`<ul class="list-plain">${noMfa.map((u) => html`<li><a href="/ehr/admin/users/${u.id}/edit">${u.name}</a> <span class="muted small">${humanize(u.role)}</span></li>`)}</ul>`
            : html`<p class="muted">All active users have MFA enabled.</p>`}
        </section>
      </div>

      <section class="card">
        <h2>Resolved alerts</h2>
        ${resolved.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Raised</th><th>Severity</th><th>Alert</th><th>User</th><th>Resolved</th><th>Resolution</th></tr></thead>
          <tbody>${resolved.map((a) => html`<tr>
            <td>${fmtTimestamp(a.ts)}</td><td>${sevBadge(a.severity)}</td>
            <td>${kindLabel(a.kind)}${a.detail ? html`<br><span class="muted small">${a.detail}</span>` : ""}</td>
            <td>${a.user_name || ""}</td>
            <td>${fmtTimestamp(a.resolved_at)}${a.resolver_name ? html`<br><span class="muted small">${a.resolver_name}</span>` : ""}</td>
            <td>${a.resolution_note || ""}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No resolved alerts yet.</p>`}
      </section>`,
  }));
});

router.post("/security/alerts/:id/acknowledge", adminOnly, (req, res) => {
  const alert = getAlert(req);
  if (!alert) return res.status(404).send(page(req, { title: "Not found", body: html`<div class="card"><h1>Alert not found</h1></div>` }));
  if (alert.status === "open") {
    req.db.prepare("UPDATE security_alerts SET status = 'acknowledged' WHERE id = ?").run(alert.id);
    audit(req, "alert_acknowledge", "security_alert", alert.id, null, `kind=${alert.kind}`);
    req.flash("success", "Alert acknowledged.");
  }
  res.redirect("/ehr/security");
});

router.post("/security/alerts/:id/resolve", adminOnly, (req, res) => {
  const alert = getAlert(req);
  if (!alert) return res.status(404).send(page(req, { title: "Not found", body: html`<div class="card"><h1>Alert not found</h1></div>` }));
  const note = typeof req.body.resolution_note === "string" ? req.body.resolution_note.trim().slice(0, 1000) : "";
  if (!note) {
    req.flash("error", "A resolution note is required to resolve an alert.");
    return res.redirect("/ehr/security");
  }
  if (alert.status !== "resolved") {
    req.db.prepare("UPDATE security_alerts SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?")
      .run(req.user.id, note, alert.id);
    audit(req, "alert_resolve", "security_alert", alert.id, null, `kind=${alert.kind}`);
    req.flash("success", "Alert resolved.");
  }
  res.redirect("/ehr/security");
});

router.post("/security/verify-audit", adminOnly, (req, res) => {
  const r = verifyAuditChain(req.db);
  audit(req, "audit_verify", "audit_log", null, null, `ok=${r.ok} checked=${r.checked}${r.ok ? "" : ` first_bad=${r.firstBadId}`}`);
  req.flash(r.ok ? "success" : "error", r.ok
    ? `Audit log verified: ${r.checked} entries, chain intact.`
    : `Audit log verification FAILED at entry #${r.firstBadId}. A high-severity alert has been raised.`);
  res.redirect("/ehr/security");
});

module.exports = { router };
