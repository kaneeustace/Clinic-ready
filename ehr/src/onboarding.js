"use strict";
/*
 * "Get your clinic ready" checklist on the administrator's dashboard. Every item checks itself off from the real
 * state of the system, so it can't drift. Hidden once all required items are done (or the admin hides it).
 */
const { html } = require("./views");
const { getClinic } = require("./clinic");
const { can } = require("./permissions");

function items(db) {
  const n = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  const c = getClinic(db);
  const product = require("./product").PRODUCT.name;
  let backups = false;
  try { backups = require("./backup").backupConfig(db).enabled; } catch { backups = false; }
  let persistent = false;
  try { const st = require("./routes/admin").storageStatus(db); persistent = st.persistent && st.starts && st.starts.n > 1; } catch { persistent = false; }
  return [
    { key: "clinic", label: "Add your clinic's details", hint: "Name, address, phone, group NPI and tax ID for superbills and printouts.", done: c.name !== product && c.billingReady, href: "/ehr/admin/clinic", required: true },
    { key: "logo", label: "Upload your logo and pick a color", hint: "Shows in the app, on sign-in and on your clients' phones.", done: c.hasLogo, href: "/ehr/admin/clinic", required: false },
    { key: "staff", label: "Add your staff", hint: "Clinicians, front desk and billing, each with the right role.", done: n("SELECT COUNT(*) AS n FROM users WHERE active = 1") > 1, href: "/ehr/admin/users/new", required: true },
    { key: "supervision", label: "Set clinical supervisors", hint: "Who co-signs for associate-level and BHT staff (edit each user).", done: n("SELECT COUNT(*) AS n FROM users WHERE supervisor_id IS NOT NULL") > 0, href: "/ehr/admin/users", required: false },
    { key: "mfa", label: "Turn on two-factor sign-in", hint: "Required for HIPAA-grade security. Start with your own account.", done: process.env.EHR_REQUIRE_MFA === "1" || n("SELECT COUNT(*) AS n FROM users WHERE mfa_enabled = 1 AND role = 'admin'") > 0, href: "/ehr/account", required: true },
    { key: "client", label: "Add your first client", hint: "Then a treatment plan, which progress notes require.", done: n("SELECT COUNT(*) AS n FROM patients") > 0, href: "/ehr/patients/new", required: true },
    { key: "email", label: "Set up email", hint: "For end-of-day note reminders and automatic check-in links.", done: require("./mailer").mailConfig().enabled, href: "/ehr/admin/email", required: false },
    { key: "checkin", label: "Set up client check-in", hint: "A front-desk iPad kiosk, or automatic links by email/text.", done: n("SELECT COUNT(*) AS n FROM checkin_kiosks WHERE revoked_at IS NULL") > 0 || require("./sms").smsConfig().enabled, href: "/ehr/checkins", required: false },
    { key: "storage", label: "Confirm your data is saved", hint: "The database must survive restarts (Administration → Data storage).", done: persistent, href: "/ehr/admin#storage", required: true },
    { key: "backups", label: "Turn on encrypted backups", hint: "Your hosting provider sets the backup key.", done: backups, href: "/ehr/backups", required: true },
  ];
}

function onboardingCard(db, user) {
  if (!can(user, "admin")) return "";
  const list = items(db);
  const required = list.filter((i) => i.required);
  const doneCount = list.filter((i) => i.done).length;
  if (required.every((i) => i.done)) return "";
  const pct = Math.round((doneCount / list.length) * 100);
  return html`
    <section class="card onboard" aria-labelledby="ob-h">
      <div class="card__head"><h2 id="ob-h">Get your clinic ready</h2><span class="muted small">${doneCount} of ${list.length} done</span></div>
      <div class="onboard__bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
      <ol class="onboard__list">${list.map((i) => html`
        <li class="${i.done ? "is-done" : ""}">
          <span class="onboard__tick" aria-hidden="true">${i.done ? "✓" : ""}</span>
          <div><a href="${i.href}">${i.label}</a>${i.required ? "" : html` <span class="muted small">(optional)</span>`}<p class="small muted">${i.hint}</p></div>
          <span class="visually-hidden">${i.done ? "Done" : "Not done"}</span>
        </li>`)}</ol>
    </section>`;
}

module.exports = { items, onboardingCard };
