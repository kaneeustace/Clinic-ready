"use strict";
/*
 * Administration, security and account settings.
 *   /admin...          user management, audit log viewer + CSV export, patient access report (admin only)
 *   /account...        own profile and password change (any logged-in user)
 */
const express = require("express");
const { requirePerm, hashPassword, verifyPassword, passwordPolicyError, ROLES, mfa } = require("../auth");
const { audit } = require("../audit");
const { html, page, csrfField, select, badge, humanize, fmtTimestamp, patientName, getPatient, notFound } = require("../views");

const router = express.Router();
const adminOnly = requirePerm("admin");
const IDLE_MINUTES = Number(process.env.EHR_IDLE_MINUTES || 30);
const PAGE_SIZE = 100;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00:00Z"));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorList(errors) {
  return errors.length
    ? html`<div class="alert alert--error" role="alert"><ul class="list-plain">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`
    : "";
}

function getUser(req, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return req.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id)) || null;
}

function isLocked(u) {
  return !!u.is_locked;
}

const USER_COLS = `id, email, name, credentials, role, npi, education_level, supervisor_id, requires_cosign, active, failed_logins, locked_until, last_login_at, created_at,
  mfa_enabled, mfa_enrolled_at, mfa_recovery, password_changed_at, (mfa_secret IS NOT NULL) AS mfa_started,
  (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked`;

// AHCCCS education-level modifier (HM < bachelor, HN bachelor, HO master, HP doctoral). Empty = derive from credentials.
const EDU_LEVELS = ["HM", "HN", "HO", "HP"];
const EDU_OPTIONS = [
  { value: "", label: "Auto (from credentials)" }, { value: "HM", label: "HM · less than bachelor's" },
  { value: "HN", label: "HN · bachelor's" }, { value: "HO", label: "HO · master's" }, { value: "HP", label: "HP · doctoral" },
];
const supervision = require("../supervision");
/** Supervisor + co-signature fields for the user forms. */
function supFields(req, v, selfId = null) {
  const sups = req.db.prepare("SELECT id, name, credentials, role, active FROM users WHERE active = 1 ORDER BY name").all()
    .filter((u) => u.id !== selfId && supervision.canSupervise(u));
  const auto = supervision.requiresCosign({ role: v.role || "clinician", credentials: v.credentials, requires_cosign: null });
  return html`
    <label for="supervisor_id">Clinical supervisor ${select("supervisor_id", [{ value: "", label: "None" }, ...sups.map((u) => ({ value: u.id, label: `${u.name}${u.credentials ? `, ${u.credentials}` : ""}` }))], v.supervisor_id || "")}
      <span class="hint">Co-signs this person's notes. Required for BHTs, BHPPs and associate-level clinicians.</span></label>
    <label for="requires_cosign">Notes need supervisor co-signature ${select("requires_cosign", [
      { value: "", label: `Automatic from credentials (currently: ${auto ? "yes" : "no"})` }, { value: "1", label: "Yes" }, { value: "0", label: "No" }],
      v.requires_cosign == null ? "" : String(v.requires_cosign))}
      <span class="hint">Independently licensed clinicians (LCSW, LPC, LMFT, LISAC, psychologists, prescribers) sign on their own.</span></label>`;
}
function readSup(req, errors, selfId = null) {
  const raw = str(req.body.supervisor_id);
  let supervisor_id = null;
  if (raw) {
    const u = /^\d+$/.test(raw) ? req.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(raw)) : null;
    if (!u || u.id === selfId || !supervision.canSupervise(u)) errors.push("Choose a supervisor who is an active, independently licensed clinician or an administrator.");
    else supervisor_id = u.id;
  }
  const rc = str(req.body.requires_cosign);
  const requires_cosign = rc === "1" ? 1 : rc === "0" ? 0 : null;
  return { supervisor_id, requires_cosign };
}
const eduField = (v) => html`<label for="education_level">Education level for AHCCCS modifiers ${select("education_level", EDU_OPTIONS, v.education_level || "")}<span class="hint">Used to suggest HM/HN/HO/HP on AHCCCS HCPCS charges.</span></label>`;

function mfaBadge(u) {
  if (u.mfa_enabled === 1) return badge("active", "On");
  return u.mfa_started ? badge("draft", "Setup not finished") : badge("inactive", "Off");
}

/** The signed-in user's own password check (for confirmations). */
function ownPasswordOk(req, password) {
  const row = req.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  return typeof password === "string" && password.length > 0 && verifyPassword(password, row.password_hash);
}

/** Escape one CSV cell, neutralising spreadsheet formula injection. */
function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\r\n";
}

/* ------------------------------------------------------------------ */
/* Overview                                                           */
/* ------------------------------------------------------------------ */
router.get("/admin", adminOnly, (req, res) => {
  const db = req.db;
  const byRole = Object.fromEntries(ROLES.map((r) => [r, { active: 0, inactive: 0 }]));
  for (const row of db.prepare("SELECT role, active, COUNT(*) AS n FROM users GROUP BY role, active").all()) {
    if (byRole[row.role]) byRole[row.role][row.active === 1 ? "active" : "inactive"] = row.n;
  }
  const sessions = db.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE expires_at > datetime('now') AND last_seen_at > datetime('now', ?)`
  ).get(`-${IDLE_MINUTES} minutes`).n;
  const events = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= datetime('now','-1 day')").get().n;
  const locked = db.prepare("SELECT COUNT(*) AS n FROM users WHERE locked_until > datetime('now')").get().n;
  const failed = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login_failed' AND ts >= datetime('now','-1 day')").get().n;

  res.send(page(req, {
    title: "Administration",
    active: "admin",
    body: html`
      <div class="page-head"><h1>Administration</h1></div>
      <div class="tiles">
        <a class="tile" href="/ehr/admin/users"><span class="tile__num">${Object.values(byRole).reduce((a, r) => a + r.active, 0)}</span><span class="tile__label">Active users</span></a>
        <div class="tile"><span class="tile__num">${sessions}</span><span class="tile__label">Active sessions</span></div>
        <a class="tile" href="/ehr/admin/audit"><span class="tile__num">${events}</span><span class="tile__label">Audit events (24h)</span></a>
        <a class="tile" href="/ehr/admin/audit?action=login_failed"><span class="tile__num">${failed}</span><span class="tile__label">Failed sign-ins (24h)</span></a>
        <a class="tile" href="/ehr/admin/users"><span class="tile__num">${locked}</span><span class="tile__label">Locked accounts</span></a>
      </div>
      <div class="grid grid--2">
        <section class="card">
          <div class="card__head"><h2>Users by role</h2><a class="btn btn--sm" href="/ehr/admin/users">Manage users</a></div>
          <table class="table">
            <thead><tr><th>Role</th><th>Active</th><th>Inactive</th></tr></thead>
            <tbody>${ROLES.map((r) => html`<tr><td>${humanize(r)}</td><td>${byRole[r].active}</td><td>${byRole[r].inactive}</td></tr>`)}</tbody>
          </table>
        </section>
        ${aiCard(req)}
        <section class="card">
          <h2>Security</h2>
          <ul class="list">
            <li><a href="/ehr/admin/users">Users and access</a></li>
            <li><a href="/ehr/admin/users/new">Add a user</a></li>
            <li><a href="/ehr/admin/audit">Audit log</a></li>
            <li><a href="/ehr/admin/audit.csv">Export audit log (CSV)</a></li>
            <li><a href="/ehr/account">My account and password</a></li>
            <li><a href="/ehr/admin/email">End-of-day note emails</a></li>
          </ul>
          <p class="muted small">Patient access reports are available from the audit log by filtering on a patient MRN.</p>
        </section>
      </div>`,
  }));
});

/* ------------------------------------------------------------------ */
/* AI note review status + connection test (no patient data is sent)  */
/* ------------------------------------------------------------------ */
function aiCard(req, result = null) {
  const ai = require("../ai-review");
  const st = ai.aiStatus();
  const row = (ok, label) => html`<li class="row"><span class="badge badge--${ok ? "good" : "bad"}">${ok ? "Yes" : "No"}</span> ${label}</li>`;
  return html`
    <section class="card" id="ai">
      <div class="card__head"><h2>AI note review</h2>${st.enabled ? html`<span class="badge badge--good">On</span>` : html`<span class="badge badge--muted">Off</span>`}</div>
      <ul class="list-plain">
        ${row(st.flag, html`Turned on (<code>EHR_AI_REVIEW=1</code>)`)}
        ${row(st.hasKey, html`Anthropic key set (<code>ANTHROPIC_API_KEY</code>)${st.keyKind ? ` · ${st.keyKind}` : ""}`)}
        <li class="row"><span class="badge badge--muted">${st.workspace ? "Set" : "Not set"}</span> Workspace ID (only needed for some personal keys)</li>
      </ul>
      ${result ? (result.ok
        ? html`<div class="alert alert--success" role="status" style="margin-top:1rem">Working. ${result.model} answered "${result.reply}" in ${(result.ms / 1000).toFixed(1)} s.</div>`
        : html`<div class="alert alert--error" role="alert" style="margin-top:1rem">Not working: ${result.error}${result.status ? ` (HTTP ${result.status})` : ""}</div>`) : ""}
      ${st.enabled ? html`<form method="post" action="/ehr/admin/ai-test" style="margin-top:1rem">${csrfField(req)}<button class="btn btn--sm" type="submit">Test connection</button>
        <span class="hint">Sends a one-line test message with no patient information.</span></form>`
        : html`<p class="hint" style="margin-top:1rem">To turn it on, add <code>EHR_AI_REVIEW=1</code> and <code>ANTHROPIC_API_KEY</code> in the hosting settings, after signing a BAA with Anthropic.</p>`}
    </section>`;
}

router.post("/admin/ai-test", adminOnly, async (req, res) => {
  const result = await require("../ai-review").testConnection();
  audit(req, "ai_test", null, null, null, result.ok ? "ok" : `failed${result.status ? ` ${result.status}` : ""}`);
  res.status(result.ok ? 200 : 502).send(page(req, { title: "AI connection test", active: "admin", body: html`
    <div class="page-head"><h1>AI connection test</h1><a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
    ${aiCard(req, result)}` }));
});

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */
router.get("/admin/users", adminOnly, (req, res) => {
  const users = req.db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, name`).all();
  res.send(page(req, {
    title: "Users",
    active: "admin",
    body: html`
      <div class="page-head row"><h1>Users</h1><span class="spacer"></span><a class="btn btn--primary" href="/ehr/admin/users/new">Add user</a></div>
      <section class="card table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Credentials</th><th>NPI</th><th>Status</th><th>Two-factor</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>${users.map((u) => html`
            <tr>
              <td>${u.name}</td>
              <td>${u.email}</td>
              <td>${humanize(u.role)}</td>
              <td>${u.credentials || ""}</td>
              <td>${u.npi || ""}</td>
              <td>${badge(u.active === 1 ? "active" : "inactive")} ${isLocked(u) ? badge("high", "Locked") : ""}</td>
              <td>${mfaBadge(u)}</td>
              <td>${u.last_login_at ? fmtTimestamp(u.last_login_at) : html`<span class="muted">Never</span>`}</td>
              <td><a class="btn btn--sm" href="/ehr/admin/users/${u.id}/edit">Edit</a></td>
            </tr>`)}</tbody>
        </table>
      </section>`,
  }));
});

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: humanize(r) }));

function newUserForm(req, v = {}, errors = []) {
  return page(req, {
    title: "Add user",
    active: "admin",
    body: html`
      <div class="page-head"><h1>Add user</h1><p><a href="/ehr/admin/users">Back to users</a></p></div>
      ${errorList(errors)}
      <form class="card" method="post" action="/ehr/admin/users">
        ${csrfField(req)}
        <div class="form-grid">
          <label>Full name <input name="name" value="${v.name || ""}" required maxlength="120"></label>
          <label>Email <input type="email" name="email" value="${v.email || ""}" required maxlength="200" autocomplete="off"></label>
          <label for="role">Role ${select("role", ROLE_OPTIONS, v.role || "clinician")}</label>
          <label>Credentials <span class="hint">e.g. LCSW, MD</span><input name="credentials" value="${v.credentials || ""}" maxlength="60"></label>
          <label>NPI <span class="hint">10 digits, optional</span><input name="npi" value="${v.npi || ""}" inputmode="numeric" pattern="\\d{10}" maxlength="10"></label>
          ${eduField(v)}
          ${supFields(req, v)}
          <label>Initial password <span class="hint">12+ characters, 3 of: lowercase, uppercase, number, symbol</span>
            <input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Create user</button><a class="btn btn--ghost" href="/ehr/admin/users">Cancel</a></div>
      </form>`,
  });
}

router.get("/admin/users/new", adminOnly, (req, res) => res.send(newUserForm(req)));

router.post("/admin/users", adminOnly, (req, res) => {
  const v = {
    name: str(req.body.name), email: str(req.body.email).toLowerCase(), role: str(req.body.role),
    credentials: str(req.body.credentials), npi: str(req.body.npi), education_level: str(req.body.education_level).toUpperCase(),
  };
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const errors = [];
  if (!v.name) errors.push("Name is required.");
  if (!EMAIL_RE.test(v.email)) errors.push("A valid email is required.");
  else if (req.db.prepare("SELECT 1 FROM users WHERE email = ?").get(v.email)) errors.push("A user with that email already exists.");
  if (!ROLES.includes(v.role)) errors.push("Choose a valid role.");
  if (v.npi && !/^\d{10}$/.test(v.npi)) errors.push("NPI must be exactly 10 digits.");
  if (v.education_level && !EDU_LEVELS.includes(v.education_level)) errors.push("Choose a valid education level.");
  Object.assign(v, readSup(req, errors));
  const pwErr = passwordPolicyError(password);
  if (pwErr) errors.push(pwErr);
  if (errors.length) return res.status(400).send(newUserForm(req, v, errors));

  const id = Number(req.db.prepare(
    "INSERT INTO users (email, name, role, credentials, npi, education_level, supervisor_id, requires_cosign, password_hash, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).run(v.email, v.name, v.role, v.credentials || null, v.npi || null, v.education_level || null, v.supervisor_id, v.requires_cosign, hashPassword(password)).lastInsertRowid);
  audit(req, "create", "user", id, null, `role=${v.role}`);
  req.flash("success", `User ${v.name} created.`);
  res.redirect("/ehr/admin/users");
});

function editUserForm(req, user, v = user, errors = []) {
  const self = user.id === req.user.id;
  return page(req, {
    title: `Edit ${user.name}`,
    active: "admin",
    body: html`
      <div class="page-head"><h1>${user.name}</h1><p><a href="/ehr/admin/users">Back to users</a></p></div>
      ${errorList(errors)}
      <div class="grid grid--2">
        <form class="card" method="post" action="/ehr/admin/users/${user.id}/edit">
          ${csrfField(req)}
          <h2>Profile and access</h2>
          <p class="muted">${user.email}${user.last_login_at ? ` · last sign-in ${fmtTimestamp(user.last_login_at)}` : ""}</p>
          <div class="form-grid">
            <label>Full name <input name="name" value="${v.name || ""}" required maxlength="120"></label>
            <label for="role">Role ${select("role", ROLE_OPTIONS, v.role)}</label>
            <label>Credentials <input name="credentials" value="${v.credentials || ""}" maxlength="60"></label>
            <label>NPI <span class="hint">10 digits, optional</span><input name="npi" value="${v.npi || ""}" inputmode="numeric" pattern="\\d{10}" maxlength="10"></label>
            ${eduField(v)}
            ${supFields(req, v, user.id)}
            <label for="active">Status ${select("active", [{ value: "1", label: "Active" }, { value: "0", label: "Inactive (cannot sign in)" }], String(v.active))}</label>
          </div>
          ${self ? html`<p class="hint">You can't deactivate your own account or remove your own admin role.</p>` : ""}
          <div class="form-actions"><button class="btn btn--primary" type="submit">Save changes</button></div>
        </form>
        <div class="stack">
          <form class="card" method="post" action="/ehr/admin/users/${user.id}/reset-password">
            ${csrfField(req)}
            <h2>Reset password</h2>
            <p class="muted">Signs the user out of all sessions.</p>
            <label>New password <span class="hint">12+ characters, 3 of: lowercase, uppercase, number, symbol</span>
              <input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
            <div class="form-actions"><button class="btn btn--danger" type="submit">Reset password</button></div>
          </form>
          <section class="card">
            <h2>Sign-in lockout</h2>
            ${isLocked(user)
              ? html`<p>${badge("high", "Locked")} until ${fmtTimestamp(user.locked_until)} after repeated failed sign-ins.</p>
                <form method="post" action="/ehr/admin/users/${user.id}/unlock">${csrfField(req)}<button class="btn" type="submit">Unlock account</button></form>`
              : html`<p class="muted">Not locked. Failed attempts since last success: ${user.failed_logins}.</p>`}
          </section>
          <section class="card">
            <h2>Two-factor sign-in</h2>
            <p>${mfaBadge(user)}${user.mfa_enabled === 1 && user.mfa_enrolled_at ? html` <span class="muted">since ${fmtTimestamp(user.mfa_enrolled_at)} · ${mfa.recoveryRemaining(user)} recovery codes left</span>` : ""}</p>
            ${user.mfa_enabled === 1 || user.mfa_started ? html`
              <form method="post" action="/ehr/admin/users/${user.id}/reset-mfa" class="stack">
                ${csrfField(req)}
                <p class="muted small">Use when the user lost their phone and recovery codes. Clears their authenticator and recovery codes and signs them out everywhere; they set it up again at next sign-in${mfa.required() ? "" : " (or from My account)"}. Verify their identity first.</p>
                <label>Your password (to confirm) <input type="password" name="admin_password" required autocomplete="current-password"></label>
                <div class="form-actions"><button class="btn btn--danger" type="submit">Reset two-factor</button></div>
              </form>`
              : html`<p class="muted small">${mfa.required() ? "Required for all staff: they'll be asked to set it up at next sign-in." : "The user can turn it on from My account."}</p>`}
          </section>
        </div>
      </div>`,
  });
}

function loadUserWithLock(req, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return req.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(Number(id)) || null;
}

router.get("/admin/users/:id/edit", adminOnly, (req, res) => {
  const user = loadUserWithLock(req, req.params.id);
  if (!user) return notFound(req, res, "User");
  res.send(editUserForm(req, user));
});

router.post("/admin/users/:id/edit", adminOnly, (req, res) => {
  const user = loadUserWithLock(req, req.params.id);
  if (!user) return notFound(req, res, "User");
  const v = {
    name: str(req.body.name), role: str(req.body.role), credentials: str(req.body.credentials),
    npi: str(req.body.npi), active: str(req.body.active) === "0" ? 0 : 1, education_level: str(req.body.education_level).toUpperCase(),
  };
  const errors = [];
  if (!v.name) errors.push("Name is required.");
  if (!ROLES.includes(v.role)) errors.push("Choose a valid role.");
  if (v.npi && !/^\d{10}$/.test(v.npi)) errors.push("NPI must be exactly 10 digits.");
  if (v.education_level && !EDU_LEVELS.includes(v.education_level)) errors.push("Choose a valid education level.");
  Object.assign(v, readSup(req, errors, user.id));
  if (user.id === req.user.id) {
    if (v.active === 0) errors.push("You can't deactivate your own account.");
    if (v.role !== "admin") errors.push("You can't remove your own admin role.");
  }
  if (errors.length) return res.status(400).send(editUserForm(req, user, v, errors));

  req.db.prepare("UPDATE users SET name = ?, role = ?, credentials = ?, npi = ?, education_level = ?, supervisor_id = ?, requires_cosign = ?, active = ? WHERE id = ?")
    .run(v.name, v.role, v.credentials || null, v.npi || null, v.education_level || null, v.supervisor_id, v.requires_cosign, v.active, user.id);
  const changes = [];
  if (user.role !== v.role) changes.push(`role ${user.role}->${v.role}`);
  if ((user.supervisor_id || null) !== v.supervisor_id || (user.requires_cosign ?? null) !== v.requires_cosign) changes.push("supervision");
  if (user.active !== v.active) changes.push(v.active ? "activated" : "deactivated");
  if (user.name !== v.name || (user.credentials || "") !== v.credentials || (user.npi || "") !== v.npi || (user.education_level || "") !== v.education_level) changes.push("profile");
  audit(req, "update", "user", user.id, null, changes.join("; ") || "no changes");
  if (user.active === 1 && v.active === 0) {
    const n = req.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
    audit(req, "deactivate", "user", user.id, null, `sessions_revoked=${n}`);
  }
  req.flash("success", `Saved ${v.name}.`);
  res.redirect(`/ehr/admin/users/${user.id}/edit`);
});

router.post("/admin/users/:id/reset-password", adminOnly, (req, res) => {
  const user = loadUserWithLock(req, req.params.id);
  if (!user) return notFound(req, res, "User");
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const err = passwordPolicyError(password);
  if (err) return res.status(400).send(editUserForm(req, user, user, [err]));
  req.db.prepare("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(password), user.id);
  const n = req.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
  audit(req, "password_reset", "user", user.id, null, `sessions_revoked=${n}`);
  if (user.id === req.user.id) return res.redirect("/ehr/login"); // own session is gone
  req.flash("success", `Password reset for ${user.name}. They have been signed out everywhere.`);
  res.redirect(`/ehr/admin/users/${user.id}/edit`);
});

router.post("/admin/users/:id/unlock", adminOnly, (req, res) => {
  const user = getUser(req, req.params.id);
  if (!user) return notFound(req, res, "User");
  req.db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(user.id);
  audit(req, "unlock", "user", user.id);
  req.flash("success", `${user.name} unlocked.`);
  res.redirect(`/ehr/admin/users/${user.id}/edit`);
});

router.post("/admin/users/:id/reset-mfa", adminOnly, (req, res) => {
  const user = loadUserWithLock(req, req.params.id);
  if (!user) return notFound(req, res, "User");
  if (!ownPasswordOk(req, req.body.admin_password)) {
    audit(req, "mfa_reset_failed", "user", user.id, null, "wrong admin password");
    return res.status(400).send(editUserForm(req, user, user, ["Your password was incorrect; two-factor was not reset."]));
  }
  mfa.clear(req.db, user.id);
  const n = req.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
  audit(req, "mfa_reset", "user", user.id, null, `sessions_revoked=${n}`);
  if (user.id === req.user.id) return res.redirect("/ehr/login"); // own session is gone
  req.flash("success", `Two-factor sign-in reset for ${user.name}. They have been signed out everywhere.`);
  res.redirect(`/ehr/admin/users/${user.id}/edit`);
});

/* ------------------------------------------------------------------ */
/* Audit log                                                          */
/* ------------------------------------------------------------------ */
function auditFilters(req) {
  const q = req.query;
  const f = {
    user_id: /^\d+$/.test(str(q.user_id)) ? str(q.user_id) : "",
    mrn: str(q.mrn).slice(0, 40),
    action: str(q.action).slice(0, 60),
    entity_type: str(q.entity_type).slice(0, 60),
    from: isYmd(str(q.from)) ? str(q.from) : "",
    to: isYmd(str(q.to)) ? str(q.to) : "",
  };
  const where = [];
  const params = [];
  if (f.user_id) { where.push("a.user_id = ?"); params.push(Number(f.user_id)); }
  if (f.mrn) { where.push("p.mrn = ?"); params.push(f.mrn); }
  if (f.action) { where.push("a.action = ?"); params.push(f.action); }
  if (f.entity_type) { where.push("a.entity_type = ?"); params.push(f.entity_type); }
  if (f.from) { where.push("a.ts >= ?"); params.push(f.from); }
  if (f.to) { where.push("a.ts < date(?, '+1 day')"); params.push(f.to); }
  const summary = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
  return { f, sql: where.length ? "WHERE " + where.join(" AND ") : "", params, summary };
}

const AUDIT_SELECT = `
  SELECT a.*, u.name AS user_name, u.email AS user_email, p.mrn, p.first_name, p.last_name, p.preferred_name
  FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN patients p ON p.id = a.patient_id`;

function qs(f, extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v !== "" && v != null) p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
}

router.get("/admin/audit", adminOnly, (req, res) => {
  const db = req.db;
  const { f, sql, params, summary } = auditFilters(req);
  const pg = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const rows = db.prepare(`${AUDIT_SELECT} ${sql} ORDER BY a.ts DESC, a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE + 1, (pg - 1) * PAGE_SIZE);
  const hasNext = rows.length > PAGE_SIZE;
  if (hasNext) rows.pop();
  audit(req, "view", "audit_log", null, null, `page=${pg}${summary ? " " + summary : ""}`);

  const users = db.prepare("SELECT id, name FROM users ORDER BY name").all();
  const actions = db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);
  const entities = db.prepare("SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type").all().map((r) => r.entity_type);
  const anyOpt = { value: "", label: "Any" };
  const mrnPatient = f.mrn ? db.prepare("SELECT id FROM patients WHERE mrn = ?").get(f.mrn) : null;

  res.send(page(req, {
    title: "Audit log",
    active: "admin",
    body: html`
      <div class="page-head row"><h1>Audit log</h1><span class="spacer"></span>
        <a class="btn" href="/ehr/admin/audit.csv${qs(f)}">Export CSV</a></div>
      <form class="card" method="get" action="/ehr/admin/audit">
        <div class="form-grid">
          <label for="user_id">User ${select("user_id", [anyOpt, ...users.map((u) => ({ value: u.id, label: u.name }))], f.user_id)}</label>
          <label>Patient MRN <input name="mrn" value="${f.mrn}" placeholder="CR-000001"></label>
          <label for="action">Action ${select("action", [anyOpt, ...actions.map((a) => ({ value: a, label: a }))], f.action)}</label>
          <label for="entity_type">Entity ${select("entity_type", [anyOpt, ...entities.map((e) => ({ value: e, label: e }))], f.entity_type)}</label>
          <label>From <span class="hint">UTC date</span><input type="date" name="from" value="${f.from}"></label>
          <label>To <span class="hint">UTC date, inclusive</span><input type="date" name="to" value="${f.to}"></label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Filter</button><a class="btn btn--ghost" href="/ehr/admin/audit">Clear</a>
          ${mrnPatient ? html`<a class="btn btn--ghost" href="/ehr/admin/patients/${mrnPatient.id}/access-report">Access report for ${f.mrn}</a>` : ""}</div>
      </form>
      <section class="card table-wrap">
        ${rows.length ? auditTable(rows, { showPatient: true }) : html`<p class="muted">No audit events match these filters.</p>`}
        <div class="form-actions">
          ${pg > 1 ? html`<a class="btn btn--sm" href="/ehr/admin/audit${qs(f, { page: pg - 1 })}">Newer</a>` : ""}
          <span class="muted small">Page ${pg}</span>
          ${hasNext ? html`<a class="btn btn--sm" href="/ehr/admin/audit${qs(f, { page: pg + 1 })}">Older</a>` : ""}
        </div>
      </section>`,
  }));
});

function auditTable(rows, { showPatient }) {
  return html`
    <table class="table">
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th>${showPatient ? html`<th>Patient</th>` : ""}<th>IP</th><th>Detail</th></tr></thead>
      <tbody>${rows.map((r) => html`
        <tr>
          <td title="${r.ts} UTC">${fmtTimestamp(r.ts)}</td>
          <td>${r.user_name || html`<span class="muted">${r.user_id ? `#${r.user_id}` : "Anonymous"}</span>`}</td>
          <td>${r.action}</td>
          <td>${r.entity_type || ""}${r.entity_id != null ? ` #${r.entity_id}` : ""}</td>
          ${showPatient ? html`<td>${r.patient_id
            ? (r.mrn ? html`<a href="/ehr/patients/${r.patient_id}">${patientName(r)}</a> <span class="muted small">${r.mrn}</span>` : `#${r.patient_id}`)
            : ""}</td>` : ""}
          <td>${r.ip || ""}</td>
          <td>${r.detail || ""}</td>
        </tr>`)}</tbody>
    </table>`;
}

router.get("/admin/audit.csv", adminOnly, (req, res) => {
  const { sql, params, summary } = auditFilters(req);
  const rows = req.db.prepare(`${AUDIT_SELECT} ${sql} ORDER BY a.ts DESC, a.id DESC`).all(...params);
  audit(req, "export", "audit_log", null, null, `rows=${rows.length}${summary ? " " + summary : ""}`);
  let out = csvRow(["id", "timestamp_utc", "user_id", "user_name", "user_email", "action", "entity_type", "entity_id",
    "patient_id", "patient_mrn", "patient_name", "ip", "detail"]);
  for (const r of rows) {
    out += csvRow([r.id, r.ts, r.user_id, r.user_name, r.user_email, r.action, r.entity_type, r.entity_id,
      r.patient_id, r.mrn, r.mrn ? patientName(r) : "", r.ip, r.detail]);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="audit-log-${stamp}.csv"`);
  res.send(out);
});

/* ------------------------------------------------------------------ */
/* Patient access report (accounting of disclosures)                  */
/* ------------------------------------------------------------------ */
router.get("/admin/patients/:id/access-report", adminOnly, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return notFound(req, res, "Patient");
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const rows = req.db.prepare(`${AUDIT_SELECT} WHERE a.patient_id = ? ORDER BY a.ts DESC, a.id DESC`).all(patient.id);
  const byUser = req.db.prepare(
    `SELECT u.name, u.role, COUNT(*) AS n, MAX(a.ts) AS last_ts FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.patient_id = ? GROUP BY a.user_id ORDER BY n DESC`).all(patient.id);
  audit(req, "view", "access_report", patient.id, patient.id, `events=${rows.length}`);
  res.send(page(req, {
    title: `Access report: ${patient.mrn}`,
    active: "admin",
    body: html`
      <div class="page-head">
        <h1>Access report</h1>
        <p>${patientName(patient)} · MRN ${patient.mrn} · <a href="/ehr/patients/${patient.id}">Open chart</a> ·
          <a href="/ehr/admin/audit.csv${qs({ mrn: patient.mrn })}">Export CSV</a></p>
        <p class="muted small">Every recorded access to or change of this patient's record, newest first. Generated ${fmtTimestamp(new Date().toISOString().replace("T", " ").slice(0, 19))}.</p>
      </div>
      <section class="card">
        <h2>Summary by user</h2>
        ${byUser.length ? html`<table class="table"><thead><tr><th>User</th><th>Role</th><th>Events</th><th>Most recent</th></tr></thead>
          <tbody>${byUser.map((b) => html`<tr><td>${b.name || "Anonymous"}</td><td>${b.role ? humanize(b.role) : ""}</td><td>${b.n}</td><td>${fmtTimestamp(b.last_ts)}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">No recorded access.</p>`}
      </section>
      <section class="card table-wrap">
        <h2>All events (${rows.length})</h2>
        ${rows.length ? auditTable(rows, { showPatient: false }) : html`<p class="muted">No recorded access.</p>`}
      </section>`,
  }));
});

/* ------------------------------------------------------------------ */
/* My account (any logged-in user)                                    */
/* ------------------------------------------------------------------ */
function mfaAccountCard(req, u, mfaErrors = []) {
  const errs = mfaErrors.length ? errorList(mfaErrors) : "";
  if (u.mfa_enabled !== 1) {
    return html`
      <section class="card stack" id="two-factor">
        <h2>Two-factor sign-in</h2>
        ${errs}
        <p>${mfaBadge(u)} Protect your account with a code from an authenticator app on your phone, in addition to your password.</p>
        <form method="post" action="/ehr/account/mfa/start">${csrfField(req)}
          <button class="btn btn--primary" type="submit">${u.mfa_started ? "Restart two-factor setup" : "Set up two-factor sign-in"}</button></form>
        ${u.mfa_started ? html`<p class="small"><a href="/ehr/account/mfa/setup">Continue the setup you started</a></p>` : ""}
      </section>`;
  }
  const remaining = mfa.recoveryRemaining(u);
  return html`
    <section class="card stack" id="two-factor">
      <h2>Two-factor sign-in</h2>
      ${errs}
      <p>${mfaBadge(u)} ${u.mfa_enrolled_at ? html`<span class="muted">since ${fmtTimestamp(u.mfa_enrolled_at)}</span>` : ""}</p>
      <p class="${remaining <= 3 ? "alert alert--warn" : "muted"}">${remaining} unused recovery code${remaining === 1 ? "" : "s"} left.</p>
      <form method="post" action="/ehr/account/mfa/recovery-codes" class="stack">
        ${csrfField(req)}
        <h3>New recovery codes</h3>
        <p class="hint">Replaces all of your existing recovery codes.</p>
        <div class="form-grid">
          <label>Current password <input type="password" name="password" required autocomplete="current-password"></label>
          <label>Code from your app <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>
        </div>
        <div class="form-actions"><button class="btn" type="submit">Generate new recovery codes</button></div>
      </form>
      ${mfa.required()
        ? html`<p class="hint">Two-factor sign-in is required by your organization and can't be turned off.</p>`
        : html`<form method="post" action="/ehr/account/mfa/disable" class="stack">
          ${csrfField(req)}
          <h3>Turn off two-factor sign-in</h3>
          <div class="form-grid">
            <label>Current password <input type="password" name="password" required autocomplete="current-password"></label>
            <label>Code from your app <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>
          </div>
          <div class="form-actions"><button class="btn btn--danger" type="submit">Turn off</button></div>
        </form>`}
    </section>`;
}

function accountPage(req, errors = [], mfaErrors = []) {
  const u = req.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.user.id);
  return page(req, {
    title: "My account",
    active: "account",
    body: html`
      <div class="page-head"><h1>My account</h1></div>
      <div class="grid grid--2">
        <section class="card">
          <h2>Profile</h2>
          <dl class="list-plain">
            <dt class="muted small">Name</dt><dd>${u.name}</dd>
            <dt class="muted small">Email</dt><dd>${u.email}</dd>
            <dt class="muted small">Role</dt><dd>${humanize(u.role)}</dd>
            <dt class="muted small">Credentials</dt><dd>${u.credentials || "None on file"}</dd>
            ${u.npi ? html`<dt class="muted small">NPI</dt><dd>${u.npi}</dd>` : ""}
            <dt class="muted small">Last sign-in</dt><dd>${u.last_login_at ? fmtTimestamp(u.last_login_at) : "Never"}</dd>
          </dl>
          <p class="hint">Contact an administrator to change your name, role or credentials.</p>
        </section>
        <form class="card stack" method="post" action="/ehr/account/password">
          ${csrfField(req)}
          <h2>Change password</h2>
          ${errorList(errors)}
          <label>Current password <input type="password" name="current_password" required autocomplete="current-password"></label>
          <label>New password <span class="hint">12+ characters, 3 of: lowercase, uppercase, number, symbol</span>
            <input type="password" name="new_password" required minlength="12" autocomplete="new-password"></label>
          <label>Confirm new password <input type="password" name="confirm_password" required minlength="12" autocomplete="new-password"></label>
          <p class="hint">Changing your password signs you out on all other devices.</p>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Change password</button></div>
        </form>
        ${mfaAccountCard(req, u, mfaErrors)}
        ${require("./email").accountCard(req)}
      </div>`,
  });
}

router.get("/account", (req, res) => res.send(accountPage(req)));

router.post("/account/password", (req, res) => {
  const cur = typeof req.body.current_password === "string" ? req.body.current_password : "";
  const next = typeof req.body.new_password === "string" ? req.body.new_password : "";
  const confirm = typeof req.body.confirm_password === "string" ? req.body.confirm_password : "";
  const row = req.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  const errors = [];
  if (!verifyPassword(cur, row.password_hash)) {
    errors.push("Current password is incorrect.");
    audit(req, "password_change_failed", "user", req.user.id, null, "wrong current password");
  } else {
    const pwErr = passwordPolicyError(next);
    if (pwErr) errors.push(pwErr);
    else if (next !== confirm) errors.push("New password and confirmation don't match.");
    else if (next === cur) errors.push("New password must be different from the current one.");
  }
  if (errors.length) return res.status(400).send(accountPage(req, errors));

  req.db.prepare("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?").run(hashPassword(next), req.user.id);
  const n = req.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.session.id).changes;
  audit(req, "password_change", "user", req.user.id, null, `other_sessions_revoked=${n}`);
  req.flash("success", "Password changed.");
  res.redirect("/ehr/account");
});

/* ---------- Two-factor sign-in (own account) ---------- */
const fullUser = (req) => req.db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);

function setupPage(req, errors = []) {
  const u = fullUser(req);
  return page(req, {
    title: "Set up two-factor sign-in",
    active: "account",
    body: html`
      <div class="page-head"><h1>Two-factor sign-in</h1><p><a href="/ehr/account">Back to my account</a></p></div>
      ${mfa.enrollmentPanel(req, { email: u.email, secret: mfa.secretOf(u), action: "/ehr/account/mfa/confirm", errors, withPassword: true, cancelHref: "/ehr/account" })}`,
  });
}

router.post("/account/mfa/start", (req, res) => {
  const u = fullUser(req);
  if (u.mfa_enabled === 1) return res.redirect("/ehr/account");
  mfa.beginEnrollment(req.db, u.id);
  audit(req, "mfa_enroll_started", "user", u.id);
  res.redirect("/ehr/account/mfa/setup");
});

router.get("/account/mfa/setup", (req, res) => {
  const u = fullUser(req);
  if (u.mfa_enabled === 1 || !u.mfa_secret) return res.redirect("/ehr/account");
  res.send(setupPage(req));
});

router.post("/account/mfa/confirm", (req, res) => {
  const u = fullUser(req);
  if (u.mfa_enabled === 1 || !u.mfa_secret) return res.redirect("/ehr/account");
  const errors = [];
  if (!ownPasswordOk(req, req.body.password)) errors.push("Current password is incorrect.");
  else if (!mfa.checkTotp(req.db, u.id, req.body.code)) errors.push("That code didn't match. Make sure the app shows Clinic Ready EHR and try the newest code.");
  if (errors.length) {
    audit(req, "mfa_enroll_failed", "user", u.id);
    return res.status(400).send(setupPage(req, errors));
  }
  const codes = mfa.enable(req.db, u.id);
  const n = req.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(u.id, req.session.id).changes;
  audit(req, "mfa_enrolled", "user", u.id, null, `other_sessions_revoked=${n}`);
  res.send(page(req, { title: "Recovery codes", active: "account", body: html`
    <div class="page-head"><h1>Two-factor sign-in is on</h1></div>
    ${mfa.recoveryCodesPanel(codes, "/ehr/account")}` }));
});

/** Password + current TOTP code check for changes to an enabled second factor. */
function confirmFactor(req, u) {
  if (!ownPasswordOk(req, req.body.password)) return "Current password is incorrect.";
  if (!mfa.checkTotp(req.db, u.id, req.body.code)) return "The code from your authenticator app didn't match.";
  return null;
}

router.post("/account/mfa/disable", (req, res) => {
  const u = fullUser(req);
  if (u.mfa_enabled !== 1) return res.redirect("/ehr/account");
  if (mfa.required()) return res.status(403).send(accountPage(req, [], ["Two-factor sign-in is required by your organization and can't be turned off."]));
  const err = confirmFactor(req, u);
  if (err) {
    audit(req, "mfa_disable_failed", "user", u.id);
    return res.status(400).send(accountPage(req, [], [err]));
  }
  mfa.clear(req.db, u.id);
  audit(req, "mfa_disabled", "user", u.id);
  req.flash("success", "Two-factor sign-in is off.");
  res.redirect("/ehr/account");
});

router.post("/account/mfa/recovery-codes", (req, res) => {
  const u = fullUser(req);
  if (u.mfa_enabled !== 1) return res.redirect("/ehr/account");
  const err = confirmFactor(req, u);
  if (err) {
    audit(req, "mfa_recovery_regenerate_failed", "user", u.id);
    return res.status(400).send(accountPage(req, [], [err]));
  }
  const codes = mfa.regenerateRecoveryCodes(req.db, u.id);
  audit(req, "mfa_recovery_regenerated", "user", u.id);
  res.send(page(req, { title: "Recovery codes", active: "account", body: html`
    <div class="page-head"><h1>New recovery codes</h1><p class="muted">Your previous recovery codes no longer work.</p></div>
    ${mfa.recoveryCodesPanel(codes, "/ehr/account")}` }));
});

module.exports = { router, csvCell };
