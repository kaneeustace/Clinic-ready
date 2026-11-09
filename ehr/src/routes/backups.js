"use strict";
/*
 * Backup status and controls (admin only). HIPAA 164.308(a)(7).
 *   GET  /backups          status, schedule, list of encrypted backups, restore instructions
 *   POST /backups/run      take a backup now (then prune + verify)
 *   POST /backups/verify   restore-test one listed backup (decrypt + integrity check), never touches the live DB
 * Backups cannot be downloaded or restored through the web: restore is a command-line procedure.
 */
const express = require("express");
const path = require("node:path");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, page, csrfField, badge, fmtTimestamp } = require("../views");
const backup = require("../backup");

const router = express.Router();
const adminOnly = requirePerm("admin");

const sqliteTs = (iso) => (iso ? iso.replace("T", " ").slice(0, 19) : "");
const fmtIso = (iso) => (iso ? fmtTimestamp(sqliteTs(iso)) : "");
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

router.get("/backups", adminOnly, (req, res) => {
  const cfg = backup.backupConfig(req.db);
  const list = backup.listBackups(cfg.dir);
  const s = backup.state;
  res.send(page(req, {
    title: "Backups",
    active: "admin",
    body: html`
      <div class="page-head"><h1>Backups</h1><p><a href="/ehr/admin">Back to administration</a></p></div>
      ${cfg.enabled ? "" : html`<div class="alert alert--error" role="alert"><strong>Backups are disabled.</strong> ${cfg.reason}</div>`}
      ${s.lastFailure && (!s.lastSuccess || s.lastFailure.at > s.lastSuccess.at)
        ? html`<div class="alert alert--error" role="alert">The last backup failed at ${fmtIso(s.lastFailure.at)}: ${s.lastFailure.error}</div>` : ""}
      <div class="grid grid--2">
        <section class="card stack">
          <h2>Status</h2>
          <table class="table">
            <tbody>
              <tr><th>Encrypted backups</th><td>${cfg.enabled ? badge("active", "Enabled") : badge("inactive", "Disabled")}</td></tr>
              <tr><th>Directory</th><td>${cfg.dir}</td></tr>
              <tr><th>Schedule</th><td>At start-up and every ${cfg.intervalHours} hours</td></tr>
              <tr><th>Retention</th><td>${cfg.retention.keepDaily} daily, ${cfg.retention.keepWeekly} weekly, ${cfg.retention.keepMonthly} monthly</td></tr>
              <tr><th>Last success</th><td>${s.lastSuccess ? html`${fmtIso(s.lastSuccess.at)} <span class="muted small">${s.lastSuccess.name}</span>` : html`<span class="muted">None since the app started</span>`}</td></tr>
              <tr><th>Last failure</th><td>${s.lastFailure ? html`${fmtIso(s.lastFailure.at)} <span class="muted small">${s.lastFailure.error}</span>` : html`<span class="muted">None</span>`}</td></tr>
              <tr><th>Last verification</th><td>${s.lastVerify ? html`${fmtIso(s.lastVerify.at)} ${s.lastVerify.ok ? badge("active", "Passed") : badge("high", "Failed")} <span class="muted small">${s.lastVerify.name}</span>` : html`<span class="muted">None since the app started</span>`}</td></tr>
            </tbody>
          </table>
          <form method="post" action="/ehr/backups/run" class="form-actions">
            ${csrfField(req)}
            <button class="btn btn--primary" type="submit" ${cfg.enabled ? "" : html`disabled`}>Back up now</button>
          </form>
        </section>
        <section class="card stack">
          <h2>Restoring</h2>
          <p>Restores are done from the command line only, never through the web. A restore never overwrites the live database.</p>
          <ol class="list">
            <li>Open a shell on the server (Render: the service's <strong>Shell</strong> tab), in the <code>ehr</code> folder.</li>
            <li>Verify the chosen file: <code>npm run backup:verify -- ${cfg.dir}/ehr-YYYYMMDD-HHMMSS.sqlite.gz.enc</code></li>
            <li>Restore to a new file: <code>npm run backup:restore -- &lt;backup file&gt; /var/data/ehr-restored.sqlite</code></li>
            <li>Stop the app (suspend the service), move the current <code>ehr.sqlite</code> (and any <code>-wal</code>/<code>-shm</code>) aside, rename the restored file to <code>ehr.sqlite</code>, start the app, and confirm sign-in and recent records.</li>
            <li>Record the restore (date, file, reason, who) in your contingency plan log.</li>
          </ol>
          <p class="muted small">Backups stored on the same disk do not protect against losing that disk. Keep off-site copies (Render disk snapshots, or copies in a HIPAA-covered object store under a BAA), and keep EHR_BACKUP_KEY in a password manager: without it, backups cannot be decrypted.</p>
        </section>
      </div>
      <section class="card table-wrap">
        <div class="card__head"><h2>Backup files</h2><span class="muted small">${list.length} file${list.length === 1 ? "" : "s"}</span></div>
        ${list.length ? html`
        <table class="table">
          <thead><tr><th>File</th><th>Taken (UTC)</th><th>Size</th><th></th></tr></thead>
          <tbody>${list.map((b) => html`
            <tr>
              <td>${b.name}</td>
              <td>${b.date.toISOString().replace("T", " ").slice(0, 19)}</td>
              <td>${fmtBytes(b.bytes)}</td>
              <td>
                <form method="post" action="/ehr/backups/verify">
                  ${csrfField(req)}
                  <input type="hidden" name="file" value="${b.name}">
                  <button class="btn btn--sm" type="submit" ${cfg.enabled ? "" : html`disabled`}>Verify</button>
                </form>
              </td>
            </tr>`)}</tbody>
        </table>` : html`<p class="muted">No backups yet.</p>`}
      </section>`,
  }));
});

router.post("/backups/run", adminOnly, (req, res) => {
  const cfg = backup.backupConfig(req.db);
  if (!cfg.enabled) {
    audit(req, "backup_run", "backup", null, null, "refused: backups disabled");
    req.flash("error", "Backups are disabled: " + cfg.reason);
    return res.redirect(303, "/ehr/backups");
  }
  const r = backup.runBackupJob(req.db, cfg);
  audit(req, "backup_run", "backup", null, null, r.ok ? `ok ${r.backup.name} sha256=${r.backup.sha256}` : `failed: ${r.error}`);
  if (r.ok) req.flash("success", `Backup ${r.backup.name} created and verified (${fmtBytes(r.backup.bytes)}).`);
  else req.flash("error", `Backup failed: ${r.error}`);
  res.redirect(303, "/ehr/backups");
});

router.post("/backups/verify", adminOnly, (req, res) => {
  const cfg = backup.backupConfig(req.db);
  const name = typeof req.body.file === "string" ? req.body.file : "";
  // Only names that are in the current listing are accepted (no paths, no traversal).
  const entry = backup.listBackups(cfg.dir).find((b) => b.name === name && path.basename(name) === name);
  if (!entry) {
    audit(req, "backup_verify", "backup", null, null, "rejected: unknown file");
    req.flash("error", "That backup file was not found.");
    return res.redirect(303, "/ehr/backups");
  }
  if (!cfg.enabled) {
    req.flash("error", "Backups are disabled: " + cfg.reason);
    return res.redirect(303, "/ehr/backups");
  }
  const r = backup.verifyBackup(entry.file, cfg.key);
  backup.state.lastVerify = { at: new Date().toISOString(), name: entry.name, ok: r.ok, error: r.error || null };
  audit(req, "backup_verify", "backup", null, null, r.ok ? `ok ${entry.name}` : `failed ${entry.name}: ${r.error}`);
  if (r.ok) {
    const c = r.counts;
    req.flash("success", `${entry.name} verified: integrity ok; ${c.users ?? 0} users, ${c.patients ?? 0} patients, ${c.notes ?? 0} notes.`);
  } else {
    req.flash("error", `${entry.name} failed verification: ${r.error}`);
  }
  res.redirect(303, "/ehr/backups");
});

module.exports = { router };
