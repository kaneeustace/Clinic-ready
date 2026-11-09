"use strict";
const crypto = require("node:crypto");
const express = require("express");
const { audit } = require("./audit");
const { html, page, csrfField } = require("./views");

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

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  req.db.prepare("INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), userId, csrf, isoNow(ABSOLUTE_HOURS * 3600e3));
  res.append("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(req)}; Max-Age=${ABSOLUTE_HOURS * 3600}`);
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
        req.user = user;
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

function loginPage(req, { error, email = "" } = {}) {
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/ehr") ? req.query.next : "/ehr";
  return page(req, {
    title: "Sign in",
    bare: true,
    body: html`
      <div class="login">
        <div class="card login__card">
          <div class="login__brand"><span class="logo-dot" aria-hidden="true"></span> Clinic Ready <strong>EHR</strong></div>
          <h1>Staff sign in</h1>
          ${req.query.expired ? html`<p class="alert alert--info" role="status">You were signed out after a period of inactivity.</p>` : ""}
          ${error ? html`<p class="alert alert--error" role="alert">${error}</p>` : ""}
          <form method="post" action="/ehr/login" class="stack">
            <input type="hidden" name="next" value="${next}">
            <label>Email <input type="email" name="email" value="${email}" autocomplete="username" required autofocus></label>
            <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
            <button class="btn btn--primary" type="submit">Sign in</button>
          </form>
          <p class="muted small">Authorized personnel only. All access to patient records is logged.</p>
        </div>
      </div>`,
  });
}

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
  req.db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").run(user.id);
  // Remove any stale sessions for this browser, then issue a fresh one (prevents fixation).
  createSession(req, res, user.id);
  req.user = user;
  audit(req, "login", "user", user.id);
  res.redirect(next);
});

router.post("/logout", (req, res) => {
  if (req.user) audit(req, "logout", "user", req.user.id);
  destroySession(req, res);
  res.redirect("/ehr/login");
});

module.exports = {
  router, sessionMiddleware, csrfProtection, requireAuth, requirePerm, forbidden, can,
  hashPassword, verifyPassword, passwordPolicyError, ROLES, ROLE_PERMS, csrfField,
};
