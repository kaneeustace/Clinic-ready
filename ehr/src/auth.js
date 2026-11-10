"use strict";
const crypto = require("node:crypto");
const express = require("express");
const { audit } = require("./audit");
const { html, raw, page, csrfField } = require("./views");
const totp = require("./totp");
const { encryptField, decryptField, hasDataKey, isEncrypted, warnIfNoDataKey } = require("./crypto-field");

warnIfNoDataKey();

const { ROLE_PERMS, ROLES, can } = require("./permissions");

/* ------------------------------------------------------------------ */
/* Passwords (scrypt)                                                 */
/* ------------------------------------------------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

/** Minimum policy: 12+ chars with at least 3 of 4 character classes. Returns error string or null. */
function passwordPolicyError(pw) {
  if (typeof pw !== "string" || pw.length < 12) return "Password must be at least 12 characters.";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) return "Password must include at least 3 of: lowercase, uppercase, number, symbol.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */
const COOKIE = "ehr_sid";
const IDLE_MINUTES = Number(process.env.EHR_IDLE_MINUTES || 30);
const ABSOLUTE_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const PENDING_MINUTES = 10; // a password-only (second factor pending) session must finish quickly
// sessions.mfa_pending values
const MFA_CHALLENGE = 1;    // password accepted, waiting for a TOTP / recovery code
const MFA_ENROLL = 2;       // password accepted, EHR_REQUIRE_MFA=1 and the user must set up 2FA first
const mfaRequired = () => process.env.EHR_REQUIRE_MFA === "1";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const isoNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieAttrs(req) {
  const secure = process.env.NODE_ENV === "production" || req.secure;
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** Issue a new session (new random id). `pending` = sessions.mfa_pending. Returns the session row. */
function createSession(req, res, userId, { pending = 0 } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const ttl = pending ? PENDING_MINUTES * 60 : ABSOLUTE_HOURS * 3600;
  req.db.prepare("INSERT INTO sessions (id, user_id, csrf_token, expires_at, mfa_pending) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), userId, csrf, isoNow(ttl * 1000), pending);
  res.append("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(req)}; Max-Age=${ttl}`);
  return req.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sha256(token));
}

function destroySession(req, res) {
  if (req.session) req.db.prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
  res.append("Set-Cookie", `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
}

/** Loads req.session / req.user from the cookie. Never rejects; see requireAuth. */
function sessionMiddleware(req, res, next) {
  req.session = null;
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const id = sha256(token);
    const row = req.db.prepare(
      `SELECT s.*, (s.last_seen_at < datetime('now', ?)) AS idle_expired, (s.expires_at < datetime('now')) AS abs_expired
       FROM sessions s WHERE s.id = ?`).get(`-${IDLE_MINUTES} minutes`, id);
    if (row && !row.idle_expired && !row.abs_expired) {
      const user = req.db.prepare("SELECT id, email, name, credentials, role, npi, active FROM users WHERE id = ?").get(row.user_id);
      if (user && user.active === 1) {
        req.session = row;
        // A session whose second factor is still pending is NOT authenticated: req.user stays null.
        if (row.mfa_pending) req.pendingUser = user;
        else req.user = user;
        req.db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(id);
      }
    } else if (row) {
      req.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      req.sessionExpired = true;
    }
  }
  /** Queue a one-time message shown on the next rendered page. type: 'success' | 'error' | 'info' */
  req.flash = (type, message) => {
    if (!req.session) return;
    const list = JSON.parse(req.session.flash || "[]");
    list.push({ type, message });
    req.session.flash = JSON.stringify(list);
    req.db.prepare("UPDATE sessions SET flash = ? WHERE id = ?").run(req.session.flash, req.session.id);
  };
  req.takeFlash = () => {
    if (!req.session || !req.session.flash) return [];
    const list = JSON.parse(req.session.flash);
    req.session.flash = null;
    req.db.prepare("UPDATE sessions SET flash = NULL WHERE id = ?").run(req.session.id);
    return list;
  };
  // Password-only sessions may reach only the second-factor page (or enrollment) and sign-out.
  if (req.session && req.session.mfa_pending) {
    const target = req.session.mfa_pending === MFA_ENROLL ? "/login/mfa/setup" : "/login/mfa";
    if (req.path !== target && req.path !== "/logout") {
      if (["GET", "HEAD"].includes(req.method)) return res.redirect("/ehr" + target);
      return res.status(403).send(page(req, { title: "Finish signing in", bare: true, body: html`
        <div class="login"><div class="card login__card"><h1>Finish signing in</h1>
        <p>Two-factor verification is required before you can continue.</p>
        <p><a class="btn btn--primary" href="/ehr${target}">Continue</a></p></div></div>` }));
    }
  }
  next();
}

/** Reject state-changing requests without a valid CSRF token (form field `_csrf` or header `x-csrf-token`). */
function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.session) return next(); // requireAuth will handle unauthenticated requests
  const sent = (req.body && req.body._csrf) || req.get("x-csrf-token") || "";
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).send(page(req, { title: "Session check failed", body: html`<div class="card"><h1>Your form expired</h1><p>For your security, please go back, refresh the page and try again.</p></div>` }));
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.accepts(["html", "json"]) === "json") return res.status(401).json({ error: "unauthenticated" });
  const nextUrl = req.method === "GET" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
  res.redirect(`/ehr/login${nextUrl}${req.sessionExpired ? (nextUrl ? "&" : "?") + "expired=1" : ""}`);
}

function forbidden(req, res) {
  audit(req, "forbidden", null, null, null, `${req.method} ${req.originalUrl}`);
  res.status(403).send(page(req, { title: "Not permitted", body: html`<div class="card"><h1>Not permitted</h1><p>Your role doesn't have access to this page. Contact an administrator if you think this is a mistake.</p></div>` }));
}

function requirePerm(...perms) {
  return (req, res, next) => (perms.every((p) => can(req.user, p)) ? next() : forbidden(req, res));
}

/* ------------------------------------------------------------------ */
/* Login / logout routes (mounted at /ehr)                            */
/* ------------------------------------------------------------------ */
const router = express.Router();

/** Clinic logo and name for sign-in pages. */
function loginBrand(req) {
  const c = require("./clinic").getClinic(req.db);
  return html`${require("./views").brandMark(c)} <span>${c.name}</span>`;
}

function loginPage(req, { error, email = "" } = {}) {
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/ehr") ? req.query.next : "/ehr";
  return page(req, {
    title: "Sign in",
    bare: true,
    body: html`
      <div class="login">
        <div class="card login__card"><div data-install-hint></div>
          <div class="login__brand">${loginBrand(req)}</div>
          <h1>Staff sign in</h1>
          ${req.db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0 ? html`<p class="alert alert--warn" role="status"><strong>Setup isn't finished: no staff accounts exist yet.</strong> <a href="/ehr/setup">Create the administrator account</a>.</p>` : ""}
          ${req.query.expired ? html`<p class="alert alert--info" role="status">You were signed out after a period of inactivity.</p>` : ""}
          ${error ? html`<p class="alert alert--error" role="alert">${error}</p>` : ""}
          <form method="post" action="/ehr/login" class="stack">
            <input type="hidden" name="next" value="${next}">
            <label>Email <input type="email" name="email" value="${email}" autocomplete="username" required autofocus></label>
            <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
            <button class="btn btn--primary" type="submit">Sign in</button>
          </form>
          ${process.env.EHR_DEMO === "1" ? html`
          <div class="alert alert--info small">
            <strong>Demo site with fictional patients.</strong> Never enter real information here.<br>
            Password for all accounts: <code>${require("./seed").DEMO_PASSWORD}</code><br>
            therapist@example.com · prescriber@example.com · frontdesk@example.com · billing@example.com · admin@example.com
          </div>` : ""}
          <p class="muted small">Forgot your password? Ask an administrator to reset it under Admin → Users. The clinic's owner can also reset an admin account from the server (<code>npm run reset-admin</code>).</p>
          <p class="muted small">Authorized personnel only. All access to patient records is logged.</p>
        </div>
      </div>`,
  });
}

/* ---------- First-run setup: create the first admin from the browser ----------
 * Only while the database has zero users, and only within SETUP_WINDOW_MINUTES of
 * server start (restart the service to reopen it). Closes permanently after use. */
const SETUP_WINDOW_MINUTES = Number(process.env.EHR_SETUP_WINDOW_MINUTES || 60);
const STARTED_AT = Date.now();
const noUsers = (db) => db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
const setupOpen = () => Date.now() - STARTED_AT < SETUP_WINDOW_MINUTES * 60e3;

function setupPage(req, { errors = {}, values = {} } = {}) {
  const err = (k) => (errors[k] ? html`<span class="error-text">${errors[k]}</span>` : "");
  return page(req, {
    title: "First-time setup",
    bare: true,
    body: html`
      <div class="login">
        <div class="card login__card">
          <div class="login__brand">${loginBrand(req)}</div>
          <h1>Set up your clinic</h1>
          <p class="muted">Name your clinic and create the first administrator account. This page works once, while no accounts exist. Afterwards, add staff from Admin → Users.</p>
          ${errors._ ? html`<p class="alert alert--error" role="alert">${errors._}</p>` : ""}
          <form method="post" action="/ehr/setup" class="stack">
            <label>Clinic name <input name="clinic_name" value="${values.clinic_name ?? require("./clinic").getClinic(req.db).name}" maxlength="120" autocomplete="organization">${err("clinic_name")}</label>
            <label>Your name <input name="name" value="${values.name || ""}" autocomplete="name" required>${err("name")}</label>
            <label>Email <input type="email" name="email" value="${values.email || ""}" autocomplete="username" required>${err("email")}</label>
            <label>Password <input type="password" name="password" autocomplete="new-password" required>
              <span class="hint">12+ characters, using 3 of: lowercase, uppercase, number, symbol.</span>${err("password")}</label>
            <label>Confirm password <input type="password" name="confirm" autocomplete="new-password" required>${err("confirm")}</label>
            <button class="btn btn--primary" type="submit">Create account and sign in</button>
          </form>
        </div>
      </div>`,
  });
}

function setupClosedPage(req) {
  return page(req, { title: "Setup closed", bare: true, body: html`
    <div class="login"><div class="card login__card">
      <h1>Setup window closed</h1>
      <p>For security, first-time setup is only open for ${SETUP_WINDOW_MINUTES} minutes after the server starts.
      Restart the service in your hosting dashboard (Render: Manual Deploy → Restart service), then open this page again.</p>
    </div></div>` });
}

router.get("/setup", (req, res) => {
  if (!noUsers(req.db)) return res.redirect("/ehr/login");
  if (!setupOpen()) return res.status(403).send(setupClosedPage(req));
  res.send(setupPage(req));
});

router.post("/setup", (req, res) => {
  if (!noUsers(req.db)) return res.redirect("/ehr/login");
  if (!setupOpen()) return res.status(403).send(setupClosedPage(req));
  const values = {
    name: String(req.body.name || "").trim().slice(0, 100),
    email: String(req.body.email || "").trim().slice(0, 200),
    clinic_name: req.body.clinic_name === undefined ? undefined : String(req.body.clinic_name).trim().slice(0, 120),
  };
  const password = String(req.body.password || "");
  const errors = {};
  if (!values.name) errors.name = "Enter your name.";
  if (values.clinic_name !== undefined && !values.clinic_name) errors.clinic_name = "Enter the clinic's name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = "Enter a valid email address.";
  const pwErr = passwordPolicyError(password);
  if (pwErr) errors.password = pwErr;
  else if (password !== String(req.body.confirm || "")) errors.confirm = "Passwords don't match.";
  if (Object.keys(errors).length) return res.status(400).send(setupPage(req, { errors, values }));

  let userId;
  req.db.exec("BEGIN IMMEDIATE");
  try {
    if (!noUsers(req.db)) { req.db.exec("ROLLBACK"); return res.redirect("/ehr/login"); }
    userId = Number(req.db.prepare("INSERT INTO users (email, name, role, password_hash, last_login_at, password_changed_at) VALUES (?, ?, 'admin', ?, datetime('now'), datetime('now'))")
      .run(values.email, values.name, hashPassword(password)).lastInsertRowid);
    if (values.clinic_name) req.db.prepare("UPDATE clinic_settings SET name = ?, updated_by = ?, updated_at = datetime('now') WHERE id = 1").run(values.clinic_name, userId);
    req.db.exec("COMMIT");
  } catch (e) {
    req.db.exec("ROLLBACK");
    throw e;
  }
  req.user = { id: userId };
  audit(req, "setup_admin_created", "user", userId);
  if (mfaRequired()) {
    createSession(req, res, userId, { pending: MFA_ENROLL });
    return res.redirect("/ehr/login/mfa/setup");
  }
  createSession(req, res, userId);
  res.redirect("/ehr");
});

router.get("/login", (req, res) => {
  if (req.user) return res.redirect("/ehr");
  res.send(loginPage(req));
});

router.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const next = typeof req.body.next === "string" && req.body.next.startsWith("/ehr") && !req.body.next.startsWith("//") ? req.body.next : "/ehr";
  const user = req.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const generic = "Email or password is incorrect.";

  if (user && user.locked_until && user.locked_until > isoNow()) {
    audit(req, "login_locked", "user", user.id);
    return res.status(429).send(loginPage(req, { error: "Too many failed attempts. Try again in a few minutes.", email }));
  }
  // Always run a hash comparison to keep timing uniform.
  const ok = verifyPassword(password, user ? user.password_hash : hashPassword("timing-dummy-password"));
  if (!user || !ok || user.active !== 1) {
    if (user) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? isoNow(LOCK_MINUTES * 60e3) : null;
      req.db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failed, lock, user.id);
    }
    audit(req, "login_failed", "user", user ? user.id : null, null, email);
    return res.status(401).send(loginPage(req, { error: generic, email }));
  }
  // Remove any stale session for this browser, then issue a fresh one (prevents fixation).
  if (req.session) req.db.prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
  if (user.mfa_enabled === 1) {
    // Second factor still needed. The failed-attempt counter is deliberately NOT reset here, so
    // re-entering the password can't be used to get unlimited guesses at the code.
    createSession(req, res, user.id, { pending: MFA_CHALLENGE });
    auditAs(req, user, "login_password_ok", "user", user.id, null, "mfa_challenge");
    return res.redirect("/ehr/login/mfa" + (next !== "/ehr" ? `?next=${encodeURIComponent(next)}` : ""));
  }
  req.db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").run(user.id);
  if (mfaRequired()) {
    createSession(req, res, user.id, { pending: MFA_ENROLL });
    auditAs(req, user, "login_password_ok", "user", user.id, null, "mfa_enrollment_required");
    return res.redirect("/ehr/login/mfa/setup");
  }
  createSession(req, res, user.id);
  req.user = user;
  audit(req, "login", "user", user.id);
  res.redirect(next);
});

/* ------------------------------------------------------------------ */
/* Two-factor sign-in (TOTP, RFC 6238)                                */
/* ------------------------------------------------------------------ */
const SECRET_AAD = "users.mfa_secret";
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

/** Audit on behalf of a user who is not (yet) req.user, e.g. during the second-factor step. */
function auditAs(req, user, ...args) {
  const prev = req.user;
  req.user = user;
  try { audit(req, ...args); } finally { req.user = prev; }
}

const normRecovery = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * users.mfa_recovery holds JSON {codes: [sha256 of unused recovery codes], lastStep: n}.
 * lastStep is the last TOTP time step accepted, so a code can't be replayed inside its window.
 * (A bare JSON array, the original format, is read as {codes: array}.)
 */
function readMfaState(row) {
  let v = null;
  try { v = JSON.parse((row && row.mfa_recovery) || "null"); } catch { v = null; }
  if (Array.isArray(v)) return { codes: v, lastStep: -1 };
  return { codes: (v && Array.isArray(v.codes)) ? v.codes : [], lastStep: (v && Number.isInteger(v.lastStep)) ? v.lastStep : -1 };
}
function writeMfaState(db, userId, state) {
  db.prepare("UPDATE users SET mfa_recovery = ? WHERE id = ?").run(JSON.stringify({ codes: state.codes, lastStep: state.lastStep }), userId);
}

/** Decrypted base32 secret (or null). */
function mfaSecretOf(row) {
  return row && row.mfa_secret ? decryptField(row.mfa_secret, SECRET_AAD) : null;
}
function storeMfaSecret(db, userId, secret) {
  db.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").run(secret == null ? null : encryptField(secret, SECRET_AAD), userId);
}

/** Start (or restart) enrollment: new secret, not yet enabled. Returns the base32 secret. */
function beginMfaEnrollment(db, userId) {
  const secret = totp.generateSecret();
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_recovery = NULL, mfa_enrolled_at = NULL WHERE id = ?").run(userId);
  storeMfaSecret(db, userId, secret);
  return secret;
}

function newRecoveryCodes() {
  const plain = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    let c = "";
    for (let j = 0; j < 10; j++) c += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    plain.push(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  return { plain, hashes: plain.map((c) => sha256(normRecovery(c))) };
}

/** Replace recovery codes; returns the plaintext codes (show once, never stored). */
function regenerateRecoveryCodes(db, userId) {
  const row = db.prepare("SELECT mfa_recovery FROM users WHERE id = ?").get(userId);
  const state = readMfaState(row);
  const { plain, hashes } = newRecoveryCodes();
  writeMfaState(db, userId, { codes: hashes, lastStep: state.lastStep });
  return plain;
}

/** Turn MFA on for a user whose secret is stored (or `secret` if given). Returns recovery codes. */
function enableMfa(db, userId, secret) {
  if (secret) storeMfaSecret(db, userId, secret);
  const row = db.prepare("SELECT mfa_recovery FROM users WHERE id = ?").get(userId);
  const { plain, hashes } = newRecoveryCodes();
  writeMfaState(db, userId, { codes: hashes, lastStep: readMfaState(row).lastStep });
  db.prepare("UPDATE users SET mfa_enabled = 1, mfa_enrolled_at = datetime('now') WHERE id = ?").run(userId);
  return plain;
}

function clearMfa(db, userId) {
  db.prepare("UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, mfa_recovery = NULL, mfa_enrolled_at = NULL WHERE id = ?").run(userId);
}

/** Verify a TOTP code for a user (±1 step, no replay). Records the accepted step. */
function checkTotp(db, userId, code) {
  const row = db.prepare("SELECT mfa_secret, mfa_recovery FROM users WHERE id = ?").get(userId);
  const secret = mfaSecretOf(row);
  if (!secret) return false;
  const state = readMfaState(row);
  const step = totp.verify(secret, code, { afterStep: state.lastStep });
  if (step === null) return false;
  writeMfaState(db, userId, { codes: state.codes, lastStep: step });
  // Rows written before EHR_DATA_KEY was configured get encrypted on first use.
  if (!isEncrypted(row.mfa_secret) && hasDataKey()) storeMfaSecret(db, userId, secret);
  return true;
}

/** Use (and burn) a one-time recovery code. */
function useRecoveryCode(db, userId, code) {
  const norm = normRecovery(code);
  if (norm.length !== 10) return false;
  const row = db.prepare("SELECT mfa_recovery FROM users WHERE id = ?").get(userId);
  const state = readMfaState(row);
  const h = Buffer.from(sha256(norm));
  const idx = state.codes.findIndex((c) => c.length === h.length && crypto.timingSafeEqual(Buffer.from(c), h));
  if (idx < 0) return false;
  state.codes.splice(idx, 1);
  writeMfaState(db, userId, state);
  return true;
}

const recoveryRemaining = (row) => readMfaState(row).codes.length;

/** Test helper: forget the last accepted TOTP step so a test can sign in twice within 30 seconds. */
function forgetMfaStep(db, userId) {
  const row = db.prepare("SELECT mfa_recovery FROM users WHERE id = ?").get(userId);
  if (row && row.mfa_recovery) writeMfaState(db, userId, { codes: readMfaState(row).codes, lastStep: -1 });
}

/** QR code + manual key + confirmation form. `withPassword` adds a current-password field. */
function mfaEnrollmentPanel(req, { email, secret, action, errors = [], withPassword = false, cancelHref = null }) {
  const uri = totp.otpauthUri(secret, email);
  let qr = "";
  try { qr = totp.qrSvg(uri, { scale: 4, title: "QR code for your authenticator app" }); } catch { qr = ""; }
  return html`
    <section class="card stack">
      <h2>Set up two-factor sign-in</h2>
      <ol class="stack">
        <li>Install an authenticator app on your phone (for example Microsoft Authenticator, Google Authenticator, 1Password or Authy).</li>
        <li>Scan this QR code with the app${qr ? "" : " (QR unavailable: use the key below)"}, or choose “enter a setup key” and type the key below.</li>
      </ol>
      ${qr ? html`<div class="mfa-qr" style="background:#fff;padding:8px;display:inline-block;align-self:flex-start">${raw(qr)}</div>` : ""}
      <p><strong>Setup key</strong> <span class="hint">time-based, 6 digits, 30 seconds</span><br>
        <code class="mfa-key" style="font-size:1.1em;letter-spacing:.05em">${totp.groupSecret(secret)}</code></p>
      <details><summary class="small">Show setup link</summary><p class="small" style="word-break:break-all"><code>${uri}</code></p></details>
      ${errors.length ? html`<div class="alert alert--error" role="alert"><ul class="list-plain">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form method="post" action="${action}" class="stack">
        ${csrfField(req)}
        <label>6-digit code from the app <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></label>
        ${withPassword ? html`<label>Current password <input type="password" name="password" autocomplete="current-password" required></label>` : ""}
        <div class="form-actions"><button class="btn btn--primary" type="submit">Turn on two-factor sign-in</button>
          ${cancelHref ? html`<a class="btn btn--ghost" href="${cancelHref}">Cancel</a>` : ""}</div>
      </form>
    </section>`;
}

/** One-time display of recovery codes. */
function recoveryCodesPanel(codes, continueHref) {
  return html`
    <section class="card stack">
      <h2>Save your recovery codes</h2>
      <p class="alert alert--warn" role="status"><strong>These codes are shown only once.</strong> Store them somewhere safe (a password manager or a printed copy kept securely).
        Each code works one time if you lose access to your authenticator app.</p>
      <ul class="list-plain mfa-codes" style="columns:2;font-family:monospace;font-size:1.1em">${codes.map((c) => html`<li>${c}</li>`)}</ul>
      <p><a class="btn btn--primary" href="${continueHref}">I've saved these codes, continue</a></p>
    </section>`;
}

function mfaPage(req, { error, next = "/ehr" } = {}) {
  return page(req, {
    title: "Two-factor verification",
    bare: true,
    body: html`
      <div class="login">
        <div class="card login__card">
          <div class="login__brand">${loginBrand(req)}</div>
          <h1>Two-factor verification</h1>
          <p class="muted">Enter the 6-digit code from your authenticator app.</p>
          ${error ? html`<p class="alert alert--error" role="alert">${error}</p>` : ""}
          <form method="post" action="/ehr/login/mfa" class="stack">
            ${csrfField(req)}
            <input type="hidden" name="next" value="${next}">
            <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" required autofocus>
              <span class="hint">Lost your phone? Enter one of your recovery codes instead (format xxxxx-xxxxx).</span></label>
            <button class="btn btn--primary" type="submit">Verify</button>
          </form>
          <form method="post" action="/ehr/logout">${csrfField(req)}<button class="btn btn--ghost btn--sm" type="submit">Cancel and sign out</button></form>
        </div>
      </div>`,
  });
}

const safeNext = (v) => (typeof v === "string" && v.startsWith("/ehr") && !v.startsWith("//") ? v : "/ehr");

/** Replace the pending session with a fully authenticated one (new id: no fixation). */
function completeSignIn(req, res, user) {
  req.db.prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
  req.db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").run(user.id);
  req.session = createSession(req, res, user.id);
  req.user = user;
  req.pendingUser = null;
}

router.get("/login/mfa", (req, res) => {
  if (!req.pendingUser) return res.redirect(req.user ? "/ehr" : "/ehr/login");
  res.send(mfaPage(req, { next: safeNext(req.query.next) }));
});

router.post("/login/mfa", (req, res) => {
  if (!req.pendingUser) return res.redirect(req.user ? "/ehr" : "/ehr/login");
  const user = req.db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user_id);
  const next = safeNext(req.body.next);
  if (user.locked_until && user.locked_until > isoNow()) {
    destroySession(req, res);
    auditAs(req, user, "login_locked", "user", user.id, null, "mfa");
    return res.status(429).send(loginPage(req, { error: "Too many failed attempts. Try again in a few minutes.", email: user.email }));
  }
  const code = String(req.body.code || "").trim();
  let method = null;
  if (/^\d{3} ?\d{3}$/.test(code)) { if (checkTotp(req.db, user.id, code)) method = "totp"; }
  else if (useRecoveryCode(req.db, user.id, code)) method = "recovery_code";

  if (!method) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED ? isoNow(LOCK_MINUTES * 60e3) : null;
    req.db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failed, lock, user.id);
    auditAs(req, user, "mfa_failed", "user", user.id, null, lock ? "locked" : `attempt=${failed}`);
    if (lock) {
      destroySession(req, res);
      return res.status(429).send(loginPage(req, { error: "Too many failed attempts. Try again in a few minutes.", email: user.email }));
    }
    return res.status(401).send(mfaPage(req, { error: "That code didn't work. Check the time on your phone and try again.", next }));
  }
  completeSignIn(req, res, user);
  if (method === "recovery_code") {
    audit(req, "mfa_recovery_used", "user", user.id, null, `remaining=${recoveryRemaining(req.db.prepare("SELECT mfa_recovery FROM users WHERE id = ?").get(user.id))}`);
  }
  audit(req, "mfa_success", "user", user.id, null, method);
  audit(req, "login", "user", user.id, null, "mfa");
  if (method === "recovery_code") req.flash("info", "You signed in with a recovery code; it can't be used again. Generate new codes from My account if you're running low.");
  res.redirect(next);
});

/* Forced enrollment (EHR_REQUIRE_MFA=1): session limited to this page and sign-out until done. */
function forcedEnrollPage(req, user, errors = []) {
  let secret = mfaSecretOf(user);
  if (!secret || user.mfa_enabled === 1) secret = beginMfaEnrollment(req.db, user.id);
  return page(req, {
    title: "Set up two-factor sign-in",
    bare: true,
    body: html`
      <div class="login"><div class="login__card" style="max-width:40rem">
        <div class="login__brand">${loginBrand(req)}</div>
        <p class="alert alert--info" role="status">Your organization requires two-factor sign-in. Set it up to continue.</p>
        ${mfaEnrollmentPanel(req, { email: user.email, secret, action: "/ehr/login/mfa/setup", errors })}
        <form method="post" action="/ehr/logout">${csrfField(req)}<button class="btn btn--ghost btn--sm" type="submit">Cancel and sign out</button></form>
      </div></div>`,
  });
}

router.get("/login/mfa/setup", (req, res) => {
  if (!req.pendingUser || req.session.mfa_pending !== MFA_ENROLL) return res.redirect(req.user ? "/ehr" : "/ehr/login");
  const user = req.db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user_id);
  res.send(forcedEnrollPage(req, user));
});

router.post("/login/mfa/setup", (req, res) => {
  if (!req.pendingUser || req.session.mfa_pending !== MFA_ENROLL) return res.redirect(req.user ? "/ehr" : "/ehr/login");
  const user = req.db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user_id);
  if (user.mfa_enabled === 1 || !user.mfa_secret || !checkTotp(req.db, user.id, req.body.code)) {
    auditAs(req, user, "mfa_enroll_failed", "user", user.id);
    return res.status(400).send(forcedEnrollPage(req, req.db.prepare("SELECT * FROM users WHERE id = ?").get(user.id),
      ["That code didn't match. Make sure the app shows Clinic Ready EHR and try the newest code."]));
  }
  const codes = enableMfa(req.db, user.id);
  completeSignIn(req, res, user);
  audit(req, "mfa_enrolled", "user", user.id);
  audit(req, "login", "user", user.id, null, "mfa_enrolled");
  res.send(page(req, { title: "Recovery codes", body: html`
    <div class="page-head"><h1>Two-factor sign-in is on</h1></div>
    ${recoveryCodesPanel(codes, "/ehr")}` }));
});

router.post("/logout", (req, res) => {
  if (req.user) audit(req, "logout", "user", req.user.id);
  destroySession(req, res);
  res.redirect("/ehr/login");
});

const mfa = {
  required: mfaRequired, readState: readMfaState, secretOf: mfaSecretOf, beginEnrollment: beginMfaEnrollment,
  enable: enableMfa, clear: clearMfa, checkTotp, useRecoveryCode, regenerateRecoveryCodes, recoveryRemaining,
  enrollmentPanel: mfaEnrollmentPanel, recoveryCodesPanel, forgetStep: forgetMfaStep,
};

module.exports = {
  router, sessionMiddleware, csrfProtection, requireAuth, requirePerm, forbidden, can,
  hashPassword, verifyPassword, passwordPolicyError, ROLES, ROLE_PERMS, csrfField, mfa,
};
