"use strict";
/*
 * Patient portal. Clients sign in at /portal with their own account (separate from staff users), created only from a
 * staff invitation. They see upcoming appointments (and can check in), message the clinic, read their record (allergies,
 * medications, problems, results, treatment plan goals, signed visit notes), download it as FHIR, and connect health
 * apps (SMART on FHIR, patient/ scopes).
 *
 * Client side (mounted at /portal, own session cookie):
 *   GET/POST /login, POST /logout, GET/POST /invite/:token, GET/POST /forgot, GET/POST /reset/:token
 *   GET /                     home            GET /appointments         POST /appointments/:id/checkin
 *   GET /messages, /messages/new, /messages/:id    POST /messages, /messages/:id/reply
 *   GET /record, /record/notes/:id, /record/download (FHIR Bundle JSON)
 *   GET /apps, POST /apps/:id/revoke      GET /account, POST /account/password, /account/email
 *   GET/POST /smart/authorize  (patient-facing SMART consent)
 * Staff side (under /ehr):
 *   GET /patients/:id/portal  chart tab: access, invite, messages     POST .../portal/invite, /invite/send, /access, /messages
 *   GET /messages             inbox                                     POST /portal-messages/:id/handled
 *
 * Privacy: psychotherapy notes and release forms are never shown. Signed visit notes are shown unless the clinic turns
 * that off (Clinic settings -> Programs). Emails and texts never contain clinical information, only a link.
 * Not yet supported: parent/guardian (proxy) access.
 */
const crypto = require("node:crypto");
const express = require("express");
const { hashPassword, verifyPassword, passwordPolicyError, requirePerm } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, raw, page, chartPage, notFound, getPatient, patientName, today, addDays, fmtDate, fmtTime, fmtDateTime, fmtTimestamp, age, humanize, nowLocal } = require("../views");
const { getClinic } = require("../clinic");
const mailer = require("../mailer");
const O = require("../options");
const sms = require("../sms");

const clientRouter = express.Router();
const router = express.Router();

const COOKIE = "portal_sid";
const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const INVITE_DAYS = 7;
const RESET_MINUTES = 60;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const nowSql = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString().replace("T", " ").slice(0, 19);
const str = (v, n = 500) => String(v ?? "").trim().slice(0, n);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sys = (req, patientId) => ({ db: req.db, user: null, ip: req.ip, patientId });
const paudit = (req, action, entity, id, patientId, detail = "portal") => audit({ db: req.db, user: req.user || null, ip: req.ip }, action, entity, id, patientId, detail);
function publicBase(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim() === "https" ? "https" : req.protocol;
  return String(process.env.EHR_PUBLIC_URL || `${proto}://${req.get("host")}`).replace(/\/+$/, "");
}
const portalNotesOn = (db) => { try { const r = db.prepare("SELECT portal_notes FROM clinic_settings WHERE id = 1").get(); return !r || r.portal_notes !== 0; } catch { return true; } };

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const cookieAttrs = (req) => `Path=/; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" || req.secure ? "; Secure" : ""}`;

function createSession(req, res, accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  req.db.prepare("INSERT INTO portal_sessions (id, account_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), accountId, crypto.randomBytes(24).toString("base64url"), nowSql(ABSOLUTE_HOURS * 3600));
  res.append("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(req)}; Max-Age=${ABSOLUTE_HOURS * 3600}`);
}

/** Load the portal session (if any) for this request. Returns { session, account, patient } or null. */
function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const row = req.db.prepare(`SELECT s.*, (s.last_seen_at < datetime('now', ?)) AS idle, (s.expires_at < datetime('now')) AS expired FROM portal_sessions s WHERE s.id = ?`)
    .get(`-${IDLE_MINUTES} minutes`, id);
  if (!row) return null;
  if (row.idle || row.expired) { req.db.prepare("DELETE FROM portal_sessions WHERE id = ?").run(id); return null; }
  const account = req.db.prepare("SELECT * FROM portal_accounts WHERE id = ? AND active = 1").get(row.account_id);
  if (!account) return null;
  const patient = req.db.prepare("SELECT * FROM patients WHERE id = ?").get(account.patient_id);
  if (!patient) return null;
  req.db.prepare("UPDATE portal_sessions SET last_seen_at = datetime('now') WHERE id = ?").run(id);
  return { session: row, account, patient };
}

clientRouter.use((req, res, next) => {
  req.portal = loadSession(req);
  req.pflash = (type, message) => {
    if (!req.portal) return;
    const list = JSON.parse(req.portal.session.flash || "[]");
    list.push({ type, message });
    req.portal.session.flash = JSON.stringify(list);
    req.db.prepare("UPDATE portal_sessions SET flash = ? WHERE id = ?").run(req.portal.session.flash, req.portal.session.id);
  };
  req.takeFlash = () => {
    if (!req.portal || !req.portal.session.flash) return [];
    const list = JSON.parse(req.portal.session.flash);
    req.db.prepare("UPDATE portal_sessions SET flash = NULL WHERE id = ?").run(req.portal.session.id);
    req.portal.session.flash = null;
    return list;
  };
  // CSRF: signed-in forms carry the session token. (Sign-in forms rely on SameSite cookies + the app's same-origin check.)
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.portal) {
    const sent = Buffer.from(String((req.body && req.body._csrf) || ""));
    const want = Buffer.from(req.portal.session.csrf_token);
    if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) return res.status(403).send(layout(req, { title: "Please try again", body: html`<h1>That form expired</h1><p>Go back, refresh the page and try again.</p>` }));
  }
  next();
});

function requirePortal(req, res, next) {
  if (req.portal) return next();
  const nextUrl = req.method === "GET" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
  res.redirect(`/portal/login${nextUrl}`);
}
const safeNext = (v) => (typeof v === "string" && v.startsWith("/portal/") && !v.startsWith("//") ? v : "/portal");
const csrf = (req) => (req.portal ? html`<input type="hidden" name="_csrf" value="${req.portal.session.csrf_token}">` : "");

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const NAV = [["", "Home"], ["/appointments", "Appointments"], ["/messages", "Messages"], ["/record", "My record"], ["/account", "Account"]];

function layout(req, { title, body, active = null }) {
  const c = getClinic(req.db);
  const p = req.portal;
  const unread = p ? req.db.prepare("SELECT COUNT(*) AS n FROM portal_messages WHERE patient_id = ? AND from_patient = 0 AND read_at IS NULL").get(p.patient.id).n : 0;
  const flashes = (req.takeFlash ? req.takeFlash() : []).map((f) => html`<div class="alert alert--${f.type}" role="${f.type === "error" ? "alert" : "status"}">${f.message}</div>`);
  return page(req, { title: `${title} · ${c.name}`, bare: true, body: html`
    <div class="portal">
      <header class="portal__top">
        <a class="portal__brand" href="/portal">${c.logoUrl ? html`<img src="${c.logoUrl}" alt="">` : html`<span class="logo-dot" aria-hidden="true"></span>`}<span>${c.name}<small>Patient portal</small></span></a>
        ${p ? html`<form method="post" action="/portal/logout">${csrf(req)}<button class="btn btn--sm btn--ghost" type="submit">Sign out</button></form>` : ""}
      </header>
      ${p ? html`<nav class="portal__nav" aria-label="Portal">${NAV.map(([path, label]) => html`<a href="/portal${path}" ${active === path ? raw('aria-current="page"') : ""}>${label}${path === "/messages" && unread ? html` <span class="nav-count">${unread}</span>` : ""}</a>`)}</nav>` : ""}
      <main class="portal__main">${flashes}${body}</main>
      <footer class="portal__foot"><p>For an emergency, call 911. For a mental health crisis, call or text 988.</p>${c.phone ? html`<p>${c.name} · ${c.phone}</p>` : ""}</footer>
    </div>` });
}
const firstName = (p) => p.preferred_name || p.first_name;

/* ------------------------------------------------------------------ */
/* Sign in, invitations, password reset                                */
/* ------------------------------------------------------------------ */

const ipFails = new Map();
function tooManyIp(ip) { const f = ipFails.get(ip); return f && f.n >= 20 && f.until > Date.now(); }
function failIp(ip) { const f = ipFails.get(ip) || { n: 0, until: 0 }; if (f.until < Date.now()) f.n = 0; f.n++; f.until = Date.now() + 15 * 60000; ipFails.set(ip, f); }
function resetPortalRateLimit() { ipFails.clear(); }

function loginPage(req, res, { error = null, email = "", next = "", status = 200 } = {}) {
  res.status(status).send(layout(req, { title: "Sign in", body: html`
    <section class="card portal__narrow stack">
      <h1>Sign in</h1>
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      ${req.query.expired ? html`<div class="alert alert--info" role="status">You were signed out after a period of inactivity.</div>` : ""}
      <form method="post" action="/portal/login" class="stack">
        <input type="hidden" name="next" value="${safeNext(next || req.query.next)}">
        <label>Email <input type="email" name="email" value="${email}" autocomplete="username" required></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn btn--primary" type="submit">Sign in</button>
      </form>
      <p class="small"><a href="/portal/forgot">Forgot your password?</a></p>
      <p class="small muted">New here? Your clinic sends you an invitation link to set up your account.</p>
      ${process.env.EHR_DEMO === "1" ? html`<p class="small muted">Demo: sign in as <code>jordan.rivera@example.com</code> with the demo password.</p>` : ""}
    </section>` }));
}

clientRouter.get("/login", (req, res) => (req.portal ? res.redirect(safeNext(req.query.next)) : loginPage(req, res)));

clientRouter.post("/login", (req, res) => {
  const email = str((req.body || {}).email, 200).toLowerCase();
  const password = typeof (req.body || {}).password === "string" ? req.body.password : "";
  const next = safeNext((req.body || {}).next);
  const generic = "That email and password don't match. Check them and try again.";
  if (tooManyIp(req.ip)) return loginPage(req, res, { error: "Too many attempts. Please wait 15 minutes and try again.", email, next, status: 429 });
  const acct = req.db.prepare("SELECT * FROM portal_accounts WHERE email = ?").get(email);
  if (acct && acct.locked_until && acct.locked_until > nowSql()) return loginPage(req, res, { error: "This account is locked for 15 minutes after too many attempts.", email, next, status: 429 });
  const ok = verifyPassword(password, acct ? acct.password_hash : hashPassword("timing-dummy-password"));
  if (!acct || !ok || !acct.active) {
    failIp(req.ip);
    if (acct && !ok) {
      const n = acct.failed_logins + 1;
      req.db.prepare("UPDATE portal_accounts SET failed_logins = ?, locked_until = ? WHERE id = ?").run(n >= MAX_FAILED ? 0 : n, n >= MAX_FAILED ? nowSql(LOCK_MINUTES * 60) : null, acct.id);
    }
    audit(sys(req), "portal_login_failed", "portal_account", acct ? acct.id : null, acct ? acct.patient_id : null, acct && !acct.active ? "disabled" : "bad credentials");
    return loginPage(req, res, { error: generic, email, next, status: 401 });
  }
  req.db.prepare("UPDATE portal_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").run(acct.id);
  createSession(req, res, acct.id);
  audit(sys(req), "portal_login", "portal_account", acct.id, acct.patient_id);
  res.redirect(next);
});

clientRouter.post("/logout", (req, res) => {
  if (req.portal) { req.db.prepare("DELETE FROM portal_sessions WHERE id = ?").run(req.portal.session.id); audit(sys(req), "portal_logout", "portal_account", req.portal.account.id, req.portal.patient.id); }
  res.append("Set-Cookie", `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
  res.redirect("/portal/login");
});

function tokenRow(req, kind) {
  const t = String(req.params.token || "");
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(t)) return null;
  return req.db.prepare("SELECT * FROM portal_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > datetime('now')").get(sha256(t), kind) || null;
}
const expiredLink = (req, res) => res.status(410).send(layout(req, { title: "Link expired", body: html`<section class="card portal__narrow"><h1>This link has expired or was already used</h1><p>Ask your clinic for a new invitation, or <a href="/portal/login">sign in</a> if you already have an account.</p></section>` }));

function setupPage(req, res, row, { error = null, v = {}, status = 200 } = {}) {
  const p = req.db.prepare("SELECT first_name, preferred_name, email FROM patients WHERE id = ?").get(row.patient_id);
  const existing = req.db.prepare("SELECT email FROM portal_accounts WHERE patient_id = ?").get(row.patient_id);
  res.status(status).send(layout(req, { title: "Set up your account", body: html`
    <section class="card portal__narrow stack">
      <h1>Welcome, ${firstName(p)}</h1>
      <p>${existing ? "Set a new password for your account." : `Set up your account for ${getClinic(req.db).name}'s patient portal.`}</p>
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      <form method="post" action="${req.originalUrl.split("?")[0]}" class="stack" novalidate>
        <label>Your date of birth <span class="hint">(to confirm it's you)</span><input type="date" name="dob" value="${v.dob || ""}" required></label>
        <label>Email <span class="hint">(you'll sign in with this)</span><input type="email" name="email" value="${v.email ?? (existing ? existing.email : p.email || "")}" autocomplete="username" required></label>
        <label>Password <span class="hint">At least 12 characters, with 3 of: lowercase, uppercase, number, symbol.</span><input type="password" name="password" autocomplete="new-password" required></label>
        <label>Password again <input type="password" name="confirm" autocomplete="new-password" required></label>
        <label class="check"><input type="checkbox" name="agree" value="1" ${v.agree ? raw("checked") : ""}> I understand messages are not for emergencies and may take a business day to answer.</label>
        <button class="btn btn--primary" type="submit">${existing ? "Save password" : "Create account"}</button>
      </form>
    </section>` }));
}

clientRouter.get("/invite/:token", (req, res) => { const row = tokenRow(req, "invite"); return row ? setupPage(req, res, row) : expiredLink(req, res); });
clientRouter.get("/reset/:token", (req, res) => { const row = tokenRow(req, "reset"); return row ? setupPage(req, res, row) : expiredLink(req, res); });

function completeSetup(kind) {
  return (req, res) => {
    const row = tokenRow(req, kind);
    if (!row) return expiredLink(req, res);
    const b = req.body || {};
    const v = { dob: str(b.dob, 10), email: str(b.email, 200).toLowerCase(), agree: b.agree === "1" };
    const p = req.db.prepare("SELECT * FROM patients WHERE id = ?").get(row.patient_id);
    const attempts = req.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'portal_setup_failed' AND patient_id = ? AND ts > datetime('now', '-1 hour')").get(p.id).n;
    if (attempts >= 5) return setupPage(req, res, row, { error: "Too many attempts. Please try again in an hour, or call the clinic.", v, status: 429 });
    if (v.dob !== p.dob) { audit(sys(req), "portal_setup_failed", "portal_token", null, p.id, "dob"); return setupPage(req, res, row, { error: "That date of birth doesn't match our records.", v, status: 400 }); }
    if (!EMAIL_RE.test(v.email)) return setupPage(req, res, row, { error: "Enter a valid email address.", v, status: 400 });
    const pw = typeof b.password === "string" ? b.password : "";
    const pwErr = passwordPolicyError(pw);
    if (pwErr) return setupPage(req, res, row, { error: pwErr, v, status: 400 });
    if (pw !== b.confirm) return setupPage(req, res, row, { error: "The two passwords don't match.", v, status: 400 });
    if (!v.agree) return setupPage(req, res, row, { error: "Please confirm you understand messages aren't for emergencies.", v, status: 400 });
    const taken = req.db.prepare("SELECT patient_id FROM portal_accounts WHERE email = ?").get(v.email);
    if (taken && taken.patient_id !== p.id) return setupPage(req, res, row, { error: "That email is already used by another portal account. Use a different email, or call the clinic.", v, status: 400 });
    const existing = req.db.prepare("SELECT * FROM portal_accounts WHERE patient_id = ?").get(p.id);
    let accountId;
    if (existing) {
      req.db.prepare("UPDATE portal_accounts SET email = ?, password_hash = ?, active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?").run(v.email, hashPassword(pw), existing.id);
      req.db.prepare("DELETE FROM portal_sessions WHERE account_id = ?").run(existing.id);
      accountId = existing.id;
    } else {
      accountId = Number(req.db.prepare("INSERT INTO portal_accounts (patient_id, email, password_hash) VALUES (?, ?, ?)").run(p.id, v.email, hashPassword(pw)).lastInsertRowid);
    }
    req.db.prepare("UPDATE portal_tokens SET used_at = datetime('now') WHERE token_hash = ?").run(row.token_hash);
    audit(sys(req), existing ? "portal_password_set" : "portal_account_created", "portal_account", accountId, p.id, kind);
    createSession(req, res, accountId);
    res.redirect("/portal");
  };
}
clientRouter.post("/invite/:token", completeSetup("invite"));
clientRouter.post("/reset/:token", completeSetup("reset"));

clientRouter.get("/forgot", (req, res) => res.send(layout(req, { title: "Forgot password", body: html`
  <section class="card portal__narrow stack">
    <h1>Forgot your password?</h1>
    ${mailer.mailConfig().enabled ? html`
      <p>Enter the email you sign in with. If it has an account, we'll email you a link to set a new password.</p>
      <form method="post" action="/portal/forgot" class="stack"><label>Email <input type="email" name="email" required autocomplete="username"></label>
        <button class="btn btn--primary" type="submit">Email me a link</button></form>`
      : html`<p>Call the clinic and ask for a new portal invitation. It lets you set a new password.</p>`}
    <p class="small"><a href="/portal/login">Back to sign in</a></p>
  </section>` })));

clientRouter.post("/forgot", async (req, res) => {
  const email = str((req.body || {}).email, 200).toLowerCase();
  const acct = EMAIL_RE.test(email) ? req.db.prepare("SELECT * FROM portal_accounts WHERE email = ? AND active = 1").get(email) : null;
  const recent = acct ? req.db.prepare("SELECT COUNT(*) AS n FROM portal_tokens WHERE patient_id = ? AND kind = 'reset' AND created_at > datetime('now', '-1 hour')").get(acct.patient_id).n : 0;
  if (acct && recent < 3 && mailer.mailConfig().enabled) {
    const token = crypto.randomBytes(32).toString("base64url");
    req.db.prepare("INSERT INTO portal_tokens (token_hash, kind, patient_id, expires_at) VALUES (?, 'reset', ?, ?)").run(sha256(token), acct.patient_id, nowSql(RESET_MINUTES * 60));
    const c = getClinic(req.db);
    const link = `${publicBase(req)}/portal/reset/${token}`;
    mailer.sendMail({ to: acct.email, subject: `Reset your ${c.name} portal password`,
      text: `Someone asked to reset the password for your ${c.name} patient portal account.\n\nSet a new password (link works for one hour):\n${link}\n\nIf this wasn't you, you can ignore this email.`,
      html: `<p>Someone asked to reset the password for your ${escHtml(c.name)} patient portal account.</p><p><a href="${escHtml(link)}">Set a new password</a> (works for one hour).</p><p>If this wasn't you, you can ignore this email.</p>` })
      .catch((e) => console.error("[portal] reset email failed:", e.message));
    audit(sys(req), "portal_reset_sent", "portal_account", acct.id, acct.patient_id);
  }
  res.send(layout(req, { title: "Check your email", body: html`<section class="card portal__narrow"><h1>Check your email</h1><p>If that email has a portal account, we've sent a link to set a new password. It works for one hour.</p><p><a href="/portal/login">Back to sign in</a></p></section>` }));
});
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------------ */
/* Signed-in pages                                                     */
/* ------------------------------------------------------------------ */

const upcomingAppts = (db, pid) => db.prepare(`SELECT a.*, u.name AS clinician_name, u.credentials FROM appointments a JOIN users u ON u.id = a.clinician_id
  WHERE a.patient_id = ? AND a.start_at >= ? AND a.status IN ('scheduled', 'checked_in') ORDER BY a.start_at LIMIT 20`).all(pid, nowLocal().slice(0, 10));
const canCheckIn = (a) => a.status === "scheduled" && a.start_at.slice(0, 10) === today();

function apptLine(req, a, { withCheckin = true } = {}) {
  return html`<li class="portal__appt">
    <div><strong>${fmtDate(a.start_at.slice(0, 10))}</strong> at ${fmtTime(a.start_at)}<br>
      <span class="muted">${humanize(a.type)} with ${a.clinician_name}${a.credentials ? `, ${a.credentials}` : ""} · ${a.modality === "telehealth" ? "Video visit" : "In person"}</span></div>
    <div class="row">
      ${a.status === "checked_in" ? html`<span class="badge badge--good">Checked in</span>` : ""}
      ${withCheckin && canCheckIn(a) ? html`<form method="post" action="/portal/appointments/${a.id}/checkin">${csrf(req)}<button class="btn btn--sm btn--primary" type="submit">Check in</button></form>` : ""}
      ${a.modality === "telehealth" && a.telehealth_url && a.start_at.slice(0, 10) === today() ? html`<a class="btn btn--sm" href="${a.telehealth_url}" target="_blank" rel="noopener">Join video visit</a>` : ""}
    </div></li>`;
}

clientRouter.get("/", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const appts = upcomingAppts(req.db, p.id);
  const unread = req.db.prepare("SELECT COUNT(*) AS n FROM portal_messages WHERE patient_id = ? AND from_patient = 0 AND read_at IS NULL").get(p.id).n;
  audit(sys(req), "portal_view", "portal", null, p.id, "home");
  res.send(layout(req, { title: "Home", active: "", body: html`
    <h1>Hello, ${firstName(p)}</h1>
    ${unread ? html`<div class="alert alert--info" role="status">You have ${unread} new message${unread === 1 ? "" : "s"}. <a href="/portal/messages">Read ${unread === 1 ? "it" : "them"}</a></div>` : ""}
    <section class="card">
      <div class="card__head"><h2>Next appointment</h2><a class="small" href="/portal/appointments">All appointments</a></div>
      ${appts.length ? html`<ul class="list-plain">${apptLine(req, appts[0])}</ul>` : html`<p class="muted">No upcoming appointments. <a href="/portal/messages/new?topic=appointment">Ask for one</a></p>`}
    </section>
    <div class="portal__tiles">
      <a class="tile" href="/portal/messages/new"><span class="tile__label">Send a message to your care team</span></a>
      <a class="tile" href="/portal/record"><span class="tile__label">See your medications, results and visit notes</span></a>
      <a class="tile" href="/portal/record/download"><span class="tile__label">Download your health record</span></a>
    </div>` }));
});

clientRouter.get("/appointments", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const past = req.db.prepare(`SELECT a.*, u.name AS clinician_name, u.credentials FROM appointments a JOIN users u ON u.id = a.clinician_id
    WHERE a.patient_id = ? AND (a.start_at < ? OR a.status NOT IN ('scheduled', 'checked_in')) ORDER BY a.start_at DESC LIMIT 20`).all(p.id, nowLocal().slice(0, 10));
  audit(sys(req), "portal_view", "portal", null, p.id, "appointments");
  res.send(layout(req, { title: "Appointments", active: "/appointments", body: html`
    <div class="page-head"><h1>Appointments</h1><a class="btn btn--sm" href="/portal/messages/new?topic=appointment">Request or change an appointment</a></div>
    <section class="card"><h2>Upcoming</h2>
      ${(() => { const up = upcomingAppts(req.db, p.id); return up.length ? html`<ul class="list-plain">${up.map((a) => apptLine(req, a))}</ul>` : html`<p class="muted">None scheduled.</p>`; })()}</section>
    <section class="card"><h2>Past</h2>
      ${past.length ? html`<ul class="list-plain">${past.map((a) => html`<li class="portal__appt"><div>${fmtDate(a.start_at.slice(0, 10))} at ${fmtTime(a.start_at)}<br><span class="muted">${humanize(a.type)} with ${a.clinician_name}</span></div><span class="badge">${humanize(a.status)}</span></li>`)}</ul>` : html`<p class="muted">No past appointments.</p>`}</section>` }));
});

clientRouter.post("/appointments/:id/checkin", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const a = req.db.prepare("SELECT * FROM appointments WHERE id = ? AND patient_id = ?").get(Number(req.params.id) || -1, p.id);
  if (!a || !canCheckIn(a)) { req.pflash("error", "That appointment can't be checked in to right now."); return res.redirect("/portal/appointments"); }
  const token = require("./checkin").newToken(req.db, a.id, p.id);
  audit(sys(req), "portal_checkin_start", "appointment", a.id, p.id);
  res.redirect(`/checkin/s/${token}`);
});

/* Messages */
function threadsFor(db, pid) {
  return db.prepare(`SELECT t.thread_id, MAX(t.created_at) AS last_at, COUNT(*) AS n,
      (SELECT subject FROM portal_messages f WHERE f.id = t.thread_id) AS subject,
      SUM(CASE WHEN t.from_patient = 0 AND t.read_at IS NULL THEN 1 ELSE 0 END) AS unread_by_patient,
      SUM(CASE WHEN t.from_patient = 1 AND t.handled_at IS NULL THEN 1 ELSE 0 END) AS waiting
    FROM portal_messages t WHERE t.patient_id = ? GROUP BY t.thread_id ORDER BY last_at DESC`).all(pid);
}
const threadMessages = (db, pid, threadId) => db.prepare(`SELECT m.*, u.name AS staff_name, u.credentials FROM portal_messages m LEFT JOIN users u ON u.id = m.staff_user_id
  WHERE m.patient_id = ? AND m.thread_id = ? ORDER BY m.created_at, m.id`).all(pid, threadId);

/*
 * Message topics. There is no topic column, so the topic label leads the thread's subject ("Medication or refill
 * question: …", or just the label when the client left the subject blank); topicOf() reads it back for replies.
 */
const FRONTDESK_TOPICS = ["appointment", "cancel", "billing", "records", "technical"];
function topicOf(subject) {
  const s = String(subject || "").replace(/^Re: /, "");
  const t = O.PORTAL_TOPICS.find((x) => s === x.label || s.startsWith(`${x.label}: `));
  return t ? t.value : null;
}

/**
 * Who hears about a new client message (email body is PHI-free: no name, topic or text).
 *   medication             -> the client's prescribers (prescriptions on file, still able to prescribe) + primary clinician
 *   appointment / cancel / billing / records / technical -> active front desk staff + primary clinician
 *   anything else          -> primary clinician
 * With no primary clinician, administrators are added (as before). Staff who turned off email (digest_email = 0) are skipped.
 */
function staffRecipients(db, p, topic) {
  const pc = p.primary_clinician_id || null;
  const medication = topic === "medication" ? 1 : 0;
  const frontdesk = FRONTDESK_TOPICS.includes(topic) ? 1 : 0;
  return db.prepare(`SELECT id, email FROM users WHERE active = 1 AND COALESCE(digest_email, 1) = 1 AND (
      id = ?
      OR (? IS NULL AND role = 'admin')
      OR (? = 1 AND can_prescribe = 1 AND id IN (SELECT prescriber_id FROM prescriptions WHERE patient_id = ?))
      OR (? = 1 AND role = 'frontdesk'))`).all(pc, pc, medication, p.id, frontdesk);
}

function notifyStaff(req, p, topic = null) {
  const cfg = mailer.mailConfig();
  if (!cfg.enabled) return;
  const to = staffRecipients(req.db, p, topic);
  const link = `${publicBase(req)}/ehr/messages`;
  for (const u of to) mailer.sendMail({ to: u.email, subject: "New patient portal message", text: `A client sent a new message in the patient portal.\n\nRead it in ChartReady: ${link}`,
    html: `<p>A client sent a new message in the patient portal.</p><p><a href="${escHtml(link)}">Read it in ChartReady</a></p>` }).catch((e) => console.error("[portal] staff notice failed:", e.message));
}

clientRouter.get("/messages", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const threads = threadsFor(req.db, p.id);
  audit(sys(req), "portal_view", "portal", null, p.id, "messages");
  res.send(layout(req, { title: "Messages", active: "/messages", body: html`
    <div class="page-head"><h1>Messages</h1><a class="btn btn--primary btn--sm" href="/portal/messages/new">New message</a></div>
    <p class="small muted">Messages go to your care team and are usually answered within one business day. Don't use them for emergencies.</p>
    <section class="card">${threads.length ? html`<ul class="list-plain">${threads.map((t) => html`<li class="portal__thread">
      <a href="/portal/messages/${t.thread_id}"><strong>${t.subject}</strong></a>
      <span class="small muted">${fmtTimestamp(t.last_at)} · ${t.n} message${t.n === 1 ? "" : "s"}</span>
      ${t.unread_by_patient ? html`<span class="badge badge--info">New reply</span>` : ""}</li>`)}</ul>` : html`<p class="muted">No messages yet.</p>`}</section>` }));
});

clientRouter.get("/messages/new", requirePortal, (req, res) => {
  // ?topic= (appointment, medication, billing, other, ...) pre-selects the topic.
  const topic = O.inList(O.PORTAL_TOPICS, req.query.topic) ? String(req.query.topic) : "";
  res.send(layout(req, { title: "New message", active: "/messages", body: html`
    <h1>New message</h1>
    <div class="alert alert--warn" role="note">Not for emergencies. If you're in danger or thinking about harming yourself, call 911 or call or text 988 now.</div>
    <form class="card stack" method="post" action="/portal/messages">${csrf(req)}
      <label for="topic">Topic ${O.choice({ name: "topic", list: O.PORTAL_TOPICS, value: topic, required: true, placeholder: "What is this about?" })}</label>
      <label>Subject <span class="hint">(optional)</span><input name="subject" maxlength="80" value=""></label>
      <label>Message <textarea name="body" rows="7" maxlength="4000" required>${topic === "appointment" ? "I'd like to request an appointment." : ""}</textarea></label>
      <fieldset class="stack" id="appt-prefs"><legend>If you're asking about an appointment <span class="hint">(optional)</span></legend>
        <div><span class="small">Days that work</span><div class="row">${O.APPT_DAYS.map((d) => html`<label class="check"><input type="checkbox" name="appt_days" value="${d}"> ${d}</label>`)}</div></div>
        <div><span class="small">Times that work</span><div class="row">${O.APPT_TIMES.map((x) => html`<label class="check"><input type="checkbox" name="appt_times" value="${x}"> ${x}</label>`)}</div></div>
        <label for="visit_pref">Visit type ${O.choice({ name: "visit_pref", list: O.VISIT_PREFS, placeholder: "No preference" })}</label>
      </fieldset>
      <div class="row"><button class="btn btn--primary" type="submit">Send</button><a class="btn btn--ghost" href="/portal/messages">Cancel</a></div>
    </form>` }));
});

/** Appointment preferences (checkboxes + visit type) as one readable line, or "" when nothing was chosen. */
function apptPrefsLine(b) {
  const picks = (v, list) => [].concat(v ?? []).map(String).filter((x) => list.includes(x)).filter((x, i, a) => a.indexOf(x) === i);
  const days = picks(b.appt_days, O.APPT_DAYS), times = picks(b.appt_times, O.APPT_TIMES);
  const visit = O.readChoice(b, "visit_pref", { list: O.VISIT_PREFS });
  const parts = [];
  if (days.length) parts.push(`Days: ${days.join(", ")}`);
  if (times.length) parts.push(`Times: ${times.join(", ")}`);
  if (visit) parts.push(`Visit: ${visit}`);
  return parts.join(" · ");
}

clientRouter.post("/messages", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const b = req.body || {};
  const topic = O.readChoice(b, "topic", { list: O.PORTAL_TOPICS });
  const typed = str(b.subject, 120);
  let body = str(b.body, 4000);
  if (!topic) { req.pflash("error", "Choose what your message is about."); return res.redirect("/portal/messages/new"); }
  const prefs = apptPrefsLine(b);
  if (prefs) body = body ? `${body}\n\n${prefs}`.slice(0, 4400) : prefs;
  if (!body) { req.pflash("error", "Write your message."); return res.redirect(`/portal/messages/new?topic=${encodeURIComponent(topic)}`); }
  const label = O.labelFor(O.PORTAL_TOPICS, topic);
  const subject = (typed ? `${label}: ${typed}` : label).slice(0, 120);
  const recent = req.db.prepare("SELECT COUNT(*) AS n FROM portal_messages WHERE patient_id = ? AND from_patient = 1 AND created_at > datetime('now', '-1 hour')").get(p.id).n;
  if (recent >= 10) { req.pflash("error", "You've sent a lot of messages in the last hour. Please wait, or call the clinic."); return res.redirect("/portal/messages"); }
  const id = Number(req.db.prepare("INSERT INTO portal_messages (patient_id, from_patient, subject, body) VALUES (?, 1, ?, ?)").run(p.id, subject, body).lastInsertRowid);
  req.db.prepare("UPDATE portal_messages SET thread_id = ? WHERE id = ?").run(id, id);
  audit(sys(req), "portal_message_sent", "portal_message", id, p.id, `topic=${topic}`);
  notifyStaff(req, p, topic);
  req.pflash("success", "Message sent. Your care team will reply here.");
  res.redirect(`/portal/messages/${id}`);
});

clientRouter.get("/messages/:id", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const list = threadMessages(req.db, p.id, Number(req.params.id) || -1);
  if (!list.length) return res.status(404).send(layout(req, { title: "Not found", body: html`<h1>Message not found</h1><p><a href="/portal/messages">Back to messages</a></p>` }));
  req.db.prepare("UPDATE portal_messages SET read_at = datetime('now') WHERE patient_id = ? AND thread_id = ? AND from_patient = 0 AND read_at IS NULL").run(p.id, list[0].thread_id);
  audit(sys(req), "portal_view", "portal_message", list[0].thread_id, p.id);
  res.send(layout(req, { title: list[0].subject, active: "/messages", body: html`
    <p><a href="/portal/messages">← Messages</a></p>
    <h1>${list[0].subject}</h1>
    <ol class="portal__msgs">${list.map((m) => html`<li class="${m.from_patient ? "from-me" : "from-team"}">
      <div class="small muted">${m.from_patient ? "You" : `${m.staff_name || "Care team"}${m.credentials ? `, ${m.credentials}` : ""}`} · ${fmtTimestamp(m.created_at)}</div>
      <p>${m.body}</p></li>`)}</ol>
    <form class="card stack" method="post" action="/portal/messages/${list[0].thread_id}/reply">${csrf(req)}
      <label>Reply <textarea name="body" rows="4" maxlength="4000" required></textarea></label>
      <button class="btn btn--primary" type="submit">Send reply</button>
    </form>` }));
});

clientRouter.post("/messages/:id/reply", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const first = req.db.prepare("SELECT * FROM portal_messages WHERE id = ? AND patient_id = ? AND thread_id = id").get(Number(req.params.id) || -1, p.id);
  const body = str((req.body || {}).body, 4000);
  if (!first) return res.redirect("/portal/messages");
  if (!body) { req.pflash("error", "Write a reply first."); return res.redirect(`/portal/messages/${first.id}`); }
  const id = Number(req.db.prepare("INSERT INTO portal_messages (patient_id, thread_id, from_patient, subject, body) VALUES (?, ?, 1, ?, ?)").run(p.id, first.id, `Re: ${first.subject}`.slice(0, 120), body).lastInsertRowid);
  audit(sys(req), "portal_message_sent", "portal_message", id, p.id);
  notifyStaff(req, p, topicOf(first.subject));
  req.pflash("success", "Reply sent.");
  res.redirect(`/portal/messages/${first.id}`);
});

/* My record */
const SHOWN_NOTE = (n) => !["psychotherapy", "roi"].includes(n.type);
clientRouter.get("/record", requirePortal, (req, res) => {
  const db = req.db;
  const { patient: p } = req.portal;
  const allergies = db.prepare("SELECT * FROM allergies WHERE patient_id = ? AND active = 1 ORDER BY substance").all(p.id);
  const meds = db.prepare("SELECT * FROM medications WHERE patient_id = ? AND active = 1 ORDER BY name COLLATE NOCASE").all(p.id);
  const dx = db.prepare("SELECT * FROM diagnoses WHERE patient_id = ? AND status = 'active' ORDER BY is_primary DESC, id").all(p.id);
  const scores = db.prepare("SELECT * FROM assessments WHERE patient_id = ? ORDER BY administered_on DESC, id DESC LIMIT 12").all(p.id);
  let labs = [];
  try { labs = db.prepare("SELECT * FROM trt_labs WHERE patient_id = ? ORDER BY drawn_on DESC LIMIT 6").all(p.id); } catch { labs = []; }
  const plan = db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(p.id);
  const goals = plan ? db.prepare(`SELECT g.goal_text, g.client_words, pr.title FROM plan_goals g JOIN plan_problems pr ON pr.id = g.problem_id WHERE pr.plan_id = ? ORDER BY pr.sort, pr.id, g.sort, g.id`).all(plan.id) : [];
  const notes = portalNotesOn(db) ? db.prepare("SELECT id, type, service_date, signed_at, author_id FROM notes WHERE patient_id = ? AND status = 'signed' ORDER BY COALESCE(service_date, signed_at) DESC, id DESC LIMIT 60").all(p.id).filter(SHOWN_NOTE) : [];
  const { TYPES: NOTE_TYPES } = require("./notes");
  const LAB = [["total_t", "Testosterone", "ng/dL"], ["hematocrit", "Hematocrit", "%"], ["psa", "PSA", "ng/mL"], ["estradiol", "Estradiol", "pg/mL"]];
  audit(sys(req), "portal_view", "portal", null, p.id, "record");
  res.send(layout(req, { title: "My record", active: "/record", body: html`
    <div class="page-head"><h1>My record</h1><div class="row"><a class="btn btn--sm" href="/portal/record/download">Download (FHIR)</a><button class="btn btn--sm btn--ghost" type="button" data-print>Print</button></div></div>
    <section class="card"><h2>Allergies</h2>${allergies.length ? html`<ul class="list-plain">${allergies.map((a) => html`<li><strong>${a.substance}</strong>${a.reaction ? html` · ${a.reaction}` : ""}${a.severity ? html` <span class="badge">${a.severity}</span>` : ""}</li>`)}</ul>` : html`<p class="muted">No known allergies on file.</p>`}</section>
    <section class="card"><h2>Medications</h2>${meds.length ? html`<ul class="list-plain">${meds.map((m) => html`<li><strong>${m.name}</strong>${m.dose ? ` ${m.dose}` : ""}${m.frequency ? html`<br><span class="muted">${m.frequency}</span>` : ""}${m.prescriber ? html`<br><span class="small muted">Prescribed by ${m.prescriber}</span>` : ""}</li>`)}</ul>` : html`<p class="muted">No medications on file.</p>`}</section>
    <section class="card"><h2>Health concerns</h2>${dx.length ? html`<ul class="list-plain">${dx.map((d) => html`<li>${d.description} <span class="small muted">(${d.icd10_code})</span></li>`)}</ul>` : html`<p class="muted">None on file.</p>`}</section>
    ${goals.length ? html`<section class="card"><h2>Your treatment plan goals</h2><ul class="list-plain">${goals.map((g) => html`<li><strong>${g.goal_text}</strong>${g.client_words ? html`<br><span class="muted">In your words: “${g.client_words}”</span>` : ""}</li>`)}</ul>
      ${plan.review_date ? html`<p class="small muted">Next plan review: ${fmtDate(plan.review_date)}</p>` : ""}</section>` : ""}
    <section class="card"><h2>Results</h2>
      ${scores.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Questionnaire</th><th class="num">Score</th><th>Meaning</th></tr></thead>
        <tbody>${scores.map((s) => html`<tr><td>${fmtDate(s.administered_on)}</td><td>${s.instrument.replace(/^PHQ9$/, "PHQ-9").replace(/^GAD7$/, "GAD-7")}</td><td class="num">${s.total_score}</td><td>${humanize(s.severity)}</td></tr>`)}</tbody></table></div>` : ""}
      ${labs.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Lab date</th>${LAB.map(([, l, u]) => html`<th class="num">${l} <span class="small muted">${u}</span></th>`)}</tr></thead>
        <tbody>${labs.map((l) => html`<tr><td>${fmtDate(l.drawn_on)}</td>${LAB.map(([k]) => html`<td class="num">${l[k] ?? "—"}</td>`)}</tr>`)}</tbody></table></div>` : ""}
      ${!scores.length && !labs.length ? html`<p class="muted">No results yet.</p>` : ""}</section>
    ${portalNotesOn(db) ? html`<section class="card"><h2>Visit notes</h2>${notes.length ? html`<ul class="list-plain">${notes.map((n) => html`<li><a href="/portal/record/notes/${n.id}">${NOTE_TYPES[n.type] ? NOTE_TYPES[n.type].label : humanize(n.type)}</a> <span class="small muted">${fmtDate(n.service_date || n.signed_at.slice(0, 10))}</span></li>`)}</ul>` : html`<p class="muted">No signed visit notes yet.</p>`}</section>` : ""}
    <p class="small muted">If something here looks wrong, <a href="/portal/messages/new">send us a message</a>. You have the right to ask us to correct your record.</p>` }));
});

clientRouter.get("/record/notes/:id", requirePortal, (req, res) => {
  const { patient: p } = req.portal;
  const n = portalNotesOn(req.db) ? req.db.prepare("SELECT * FROM notes WHERE id = ? AND patient_id = ? AND status = 'signed'").get(Number(req.params.id) || -1, p.id) : null;
  if (!n || !SHOWN_NOTE(n)) return res.status(404).send(layout(req, { title: "Not found", body: html`<h1>Note not found</h1><p><a href="/portal/record">Back to my record</a></p>` }));
  const { noteSections } = require("./records");
  const { TYPES: NOTE_TYPES } = require("./notes");
  const author = req.db.prepare("SELECT name, credentials FROM users WHERE id = ?").get(n.signed_by || n.author_id);
  const addenda = req.db.prepare("SELECT content, created_at FROM note_addenda WHERE note_id = ? ORDER BY id").all(n.id);
  audit(sys(req), "portal_view", "note", n.id, p.id);
  res.send(layout(req, { title: "Visit note", active: "/record", body: html`
    <p><a href="/portal/record">← My record</a></p>
    <article class="card stack"><h1>${NOTE_TYPES[n.type] ? NOTE_TYPES[n.type].label : humanize(n.type)}</h1>
      <p class="muted">${fmtDate(n.service_date || n.signed_at.slice(0, 10))}${author ? ` · ${author.name}${author.credentials ? `, ${author.credentials}` : ""}` : ""}</p>
      <dl class="portal__note">${noteSections(n).map((s) => html`<dt>${s.label}</dt><dd>${s.value}</dd>`)}</dl>
      ${addenda.map((a) => html`<div class="alert alert--info"><strong>Addendum, ${fmtTimestamp(a.created_at)}:</strong> ${a.content}</div>`)}
    </article>` }));
});

clientRouter.get("/record/download", requirePortal, (req, res) => {
  const R = require("../fhir/resources");
  const { patient: p } = req.portal;
  const resources = [R.patientResource(p)];
  for (const type of R.COMPARTMENT) {
    if (type === "DocumentReference" && !portalNotesOn(req.db)) continue;
    resources.push(...R.loadForPatient(req.db, type, p.id, { part2: true })); // the client's own record, including Part 2 data
  }
  resources.push(...R.referencedSupport(req.db, resources), R.organizationResource(getClinic(req.db)));
  audit(sys(req), "portal_download", "portal", null, p.id, `${resources.length} resources`);
  res.set("content-disposition", `attachment; filename="my-health-record-${today()}.json"`).type("application/fhir+json")
    .send(JSON.stringify({ resourceType: "Bundle", type: "collection", timestamp: new Date().toISOString(), entry: resources.map((r) => ({ fullUrl: `urn:chartready:${r.resourceType}/${r.id}`, resource: r })) }, null, 2));
});

/* Connected apps (SMART on FHIR, patient-facing) */
clientRouter.get("/apps", requirePortal, (req, res) => {
  const { account } = req.portal;
  const apps = req.db.prepare(`SELECT c.id, c.name, MAX(t.created_at) AS last_at FROM fhir_tokens t JOIN fhir_clients c ON c.id = t.client_ref
    WHERE t.portal_account_id = ? AND t.expires_at > datetime('now') GROUP BY c.id ORDER BY c.name`).all(account.id);
  res.send(layout(req, { title: "Connected apps", active: "/account", body: html`
    <p><a href="/portal/account">← Account</a></p><h1>Connected apps</h1>
    <p>Health apps you've allowed to read your record. Access lasts one hour each time you connect.</p>
    <section class="card">${apps.length ? html`<ul class="list-plain">${apps.map((a) => html`<li class="row"><strong>${a.name}</strong><span class="small muted">connected ${fmtTimestamp(a.last_at)}</span>
      <form method="post" action="/portal/apps/${a.id}/revoke">${csrf(req)}<button class="btn btn--sm btn--ghost" type="submit">Disconnect</button></form></li>`)}</ul>` : html`<p class="muted">No apps connected right now.</p>`}</section>` }));
});
clientRouter.post("/apps/:id/revoke", requirePortal, (req, res) => {
  const { account, patient } = req.portal;
  req.db.prepare("DELETE FROM fhir_tokens WHERE portal_account_id = ? AND client_ref = ?").run(account.id, Number(req.params.id) || -1);
  audit(sys(req), "portal_app_disconnected", "fhir_client", Number(req.params.id) || null, patient.id);
  req.pflash("success", "App disconnected.");
  res.redirect("/portal/apps");
});

/* Account */
clientRouter.get("/account", requirePortal, (req, res) => {
  const { account } = req.portal;
  res.send(layout(req, { title: "Account", active: "/account", body: html`
    <h1>Account</h1>
    <div class="grid grid--2">
      <form class="card stack" method="post" action="/portal/account/email">${csrf(req)}<h2>Email</h2>
        <label>Email you sign in with <input type="email" name="email" value="${account.email}" required></label>
        <label>Current password <input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn" type="submit">Save email</button></form>
      <form class="card stack" method="post" action="/portal/account/password">${csrf(req)}<h2>Password</h2>
        <label>Current password <input type="password" name="password" autocomplete="current-password" required></label>
        <label>New password <span class="hint">12+ characters, 3 of: lowercase, uppercase, number, symbol.</span><input type="password" name="new_password" autocomplete="new-password" required></label>
        <label>New password again <input type="password" name="confirm" autocomplete="new-password" required></label>
        <button class="btn" type="submit">Change password</button></form>
    </div>
    <section class="card"><h2>Health apps</h2><p>Connect apps like a personal health record to your information. <a href="/portal/apps">See connected apps</a></p></section>` }));
});
function checkCurrent(req, res) {
  const pw = typeof (req.body || {}).password === "string" ? req.body.password : "";
  if (verifyPassword(pw, req.portal.account.password_hash)) return true;
  req.pflash("error", "Your current password isn't right.");
  res.redirect("/portal/account");
  return false;
}
clientRouter.post("/account/email", requirePortal, (req, res) => {
  if (!checkCurrent(req, res)) return;
  const email = str((req.body || {}).email, 200).toLowerCase();
  const { account, patient } = req.portal;
  if (!EMAIL_RE.test(email)) { req.pflash("error", "Enter a valid email."); return res.redirect("/portal/account"); }
  const taken = req.db.prepare("SELECT id FROM portal_accounts WHERE email = ? AND id <> ?").get(email, account.id);
  if (taken) { req.pflash("error", "That email is used by another account."); return res.redirect("/portal/account"); }
  req.db.prepare("UPDATE portal_accounts SET email = ? WHERE id = ?").run(email, account.id);
  audit(sys(req), "portal_email_changed", "portal_account", account.id, patient.id);
  req.pflash("success", "Email saved.");
  res.redirect("/portal/account");
});
clientRouter.post("/account/password", requirePortal, (req, res) => {
  if (!checkCurrent(req, res)) return;
  const b = req.body || {};
  const err = passwordPolicyError(b.new_password);
  if (err || b.new_password !== b.confirm) { req.pflash("error", err || "The new passwords don't match."); return res.redirect("/portal/account"); }
  const { account, patient, session } = req.portal;
  req.db.prepare("UPDATE portal_accounts SET password_hash = ? WHERE id = ?").run(hashPassword(b.new_password), account.id);
  req.db.prepare("DELETE FROM portal_sessions WHERE account_id = ? AND id <> ?").run(account.id, session.id);
  audit(sys(req), "portal_password_changed", "portal_account", account.id, patient.id);
  req.pflash("success", "Password changed. Other devices were signed out.");
  res.redirect("/portal/account");
});

/* ------------------------------------------------------------------ */
/* SMART on FHIR: a client connects a health app to their own record   */
/* ------------------------------------------------------------------ */

function smartCheck(req, q) {
  const A = require("../fhir/auth");
  const a = A.checkAuthorize(req, q);
  if (a.fatal || a.redirectError) return a;
  a.scopes = a.scopes.filter((s) => s.startsWith("patient/") || ["openid", "fhirUser", "launch/patient"].includes(s));
  if (!a.scopes.some((s) => s.startsWith("patient/"))) {
    return { redirectError: `${a.redirect}${a.redirect.includes("?") ? "&" : "?"}${new URLSearchParams({ error: "invalid_scope", error_description: "Clients can only share their own record (patient/ scopes).", state: a.state })}` };
  }
  if (!a.scopes.includes("launch/patient")) a.scopes.push("launch/patient");
  return a;
}

clientRouter.get("/smart/authorize", requirePortal, (req, res) => {
  const a = smartCheck(req, req.query);
  if (a.fatal) return res.status(400).send(layout(req, { title: "Can't connect", body: html`<h1>Can't connect this app</h1><p>${a.fatal}</p>` }));
  if (a.redirectError) return res.redirect(a.redirectError);
  const A = require("../fhir/auth");
  res.set("Content-Security-Policy", String(res.get("Content-Security-Policy") || "").replace("form-action 'self'", `form-action 'self' ${new URL(a.redirect).origin}`));
  const hidden = (n, v) => html`<input type="hidden" name="${n}" value="${v || ""}">`;
  res.send(layout(req, { title: `Connect ${a.client.name}`, body: html`
    <section class="card portal__narrow stack">
      <h1>Connect ${a.client.name}?</h1>
      <p><strong>${a.client.name}</strong> wants to read your health record from ${getClinic(req.db).name}. It can read, not change, your information.</p>
      <ul class="list"><li>Your demographics, appointments, health concerns, allergies, medications, results, treatment plan goals and visit notes</li><li>Your name, so the app knows who you are</li></ul>
      <p class="small muted">Only connect apps you trust. The app's own privacy policy, not HIPAA, decides what it does with your information. Access lasts one hour; you can disconnect it under Account.</p>
      <form method="post" action="/portal/smart/authorize" class="row">${csrf(req)}
        ${hidden("client_id", a.client.client_id)}${hidden("redirect_uri", a.redirect)}${hidden("scope", a.scopes.join(" "))}${hidden("state", a.state)}
        ${hidden("code_challenge", a.challenge)}${hidden("code_challenge_method", "S256")}${hidden("response_type", "code")}${hidden("aud", A.baseUrl(req))}${a.nonce ? hidden("nonce", a.nonce) : ""}
        <button class="btn btn--primary" type="submit" name="decision" value="allow">Allow</button>
        <button class="btn" type="submit" name="decision" value="deny">Don't allow</button>
      </form>
    </section>` }));
});

clientRouter.post("/smart/authorize", requirePortal, (req, res) => {
  const a = smartCheck(req, req.body || {});
  if (a.fatal) return res.status(400).send(layout(req, { title: "Can't connect", body: html`<h1>Can't connect this app</h1><p>${a.fatal}</p>` }));
  if (a.redirectError) return res.redirect(a.redirectError);
  const { account, patient } = req.portal;
  const sep = a.redirect.includes("?") ? "&" : "?";
  if ((req.body || {}).decision !== "allow") {
    audit(sys(req), "fhir_authorize_denied", "fhir_client", a.client.id, patient.id, "portal");
    return res.redirect(`${a.redirect}${sep}${new URLSearchParams({ error: "access_denied", state: a.state })}`);
  }
  const code = crypto.randomBytes(32).toString("base64url");
  req.db.prepare(`INSERT INTO fhir_auth_codes (code_hash, client_ref, user_id, portal_account_id, patient_id, scopes, redirect_uri, code_challenge, nonce, expires_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(code), a.client.id, account.id, patient.id, a.scopes.join(" "), a.redirect, a.challenge, a.nonce, nowSql(120));
  audit(sys(req), "fhir_authorize", "fhir_client", a.client.id, patient.id, `portal client ${a.client.client_id}`);
  res.redirect(`${a.redirect}${sep}${new URLSearchParams({ code, state: a.state })}`);
});

/** /ehr/smart/authorize without a staff sign-in: send portal users to their consent screen, otherwise ask who's signing in. */
function smartEntry(req, res) {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  if (loadSession(req)) return res.redirect(`/portal/smart/authorize${qs}`);
  req.portal = null;
  res.send(layout(req, { title: "Sign in to connect an app", body: html`
    <section class="card portal__narrow stack">
      <h1>Sign in to connect an app</h1>
      <p>An app is asking to read records from ${getClinic(req.db).name}. Who are you?</p>
      <a class="btn btn--primary" href="/portal/login?next=${encodeURIComponent(`/portal/smart/authorize${qs}`)}">I'm a client (patient portal)</a>
      <a class="btn" href="/ehr/login?next=${encodeURIComponent(req.originalUrl)}">I'm on the clinic's staff</a>
    </section>` }));
}

/* ------------------------------------------------------------------ */
/* Staff side                                                          */
/* ------------------------------------------------------------------ */

const canMessage = (u) => can(u, "patients:write");
const unreadCount = (db) => { try { return db.prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM portal_messages WHERE from_patient = 1 AND handled_at IS NULL").get().n; } catch { return 0; } };

function portalTab(req, res, patient, { inviteLink = null } = {}, status = 200) {
  const db = req.db;
  const u = req.user;
  const acct = db.prepare("SELECT * FROM portal_accounts WHERE patient_id = ?").get(patient.id);
  const pending = db.prepare("SELECT created_at, expires_at FROM portal_tokens WHERE patient_id = ? AND kind = 'invite' AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1").get(patient.id);
  const threads = threadsFor(db, patient.id);
  const openThread = Number(req.query.thread) || (threads[0] && threads[0].thread_id) || null;
  const msgs = openThread ? threadMessages(db, patient.id, openThread) : [];
  if (msgs.length) db.prepare("UPDATE portal_messages SET read_at = datetime('now') WHERE patient_id = ? AND thread_id = ? AND from_patient = 1 AND read_at IS NULL").run(patient.id, openThread);
  audit(req, "view", "portal", null, patient.id, "chart tab");
  const base = `/ehr/patients/${patient.id}`;
  const writer = can(u, "patients:write");
  const minor = age(patient.dob) < 18;
  const mailOn = mailer.mailConfig().enabled, smsOn = sms.smsConfig().enabled;
  const qr = inviteLink ? require("../totp").qrSvg(inviteLink, { scale: 4, title: "Portal invitation link" }) : "";

  res.status(status).send(chartPage(req, patient, "portal", html`
    <section class="card" aria-labelledby="pt-access">
      <div class="card__head"><h2 id="pt-access">Portal access</h2>${acct ? html`<span class="badge badge--${acct.active ? "good" : "muted"}">${acct.active ? "Active" : "Turned off"}</span>` : html`<span class="badge">Not set up</span>`}</div>
      ${acct ? html`<p>Signs in as <strong>${acct.email}</strong>${acct.last_login_at ? html` · last signed in ${fmtTimestamp(acct.last_login_at)}` : " · hasn't signed in yet"}.</p>` : html`<p class="muted">This client doesn't have a portal account yet.</p>`}
      ${pending && !inviteLink ? html`<p class="small muted">An invitation sent ${fmtTimestamp(pending.created_at)} is still open until ${fmtTimestamp(pending.expires_at)}.</p>` : ""}
      ${minor ? html`<div class="alert alert--warn" role="note">This client is under 18. Parent or guardian (proxy) access isn't supported yet, so an invitation goes to the client. Check your state's rules on minors' records first.</div>` : ""}
      ${inviteLink ? html`
        <div class="portal-invite">
          <div><p><strong>Invitation link</strong> (works for ${INVITE_DAYS} days, once):</p>
            <p><input class="mono" type="text" readonly value="${inviteLink}" aria-label="Invitation link"> <button class="btn btn--sm" type="button" data-copy="${inviteLink}">Copy</button></p>
            <p class="small muted">The client confirms their date of birth when they open it. Give it to them in person, or send it:</p>
            <form method="post" action="${base}/portal/invite/send" class="row">${raw(`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">`)}
              <input type="hidden" name="link" value="${inviteLink}">
              ${mailOn && patient.email ? html`<button class="btn btn--sm" name="via" value="email" type="submit">Email to ${patient.email}</button>` : ""}
              ${smsOn && patient.phone ? html`<button class="btn btn--sm" name="via" value="sms" type="submit">Text to ${patient.phone}</button>` : ""}
              ${!(mailOn && patient.email) && !(smsOn && patient.phone) ? html`<span class="small muted">Set up email or texting (Administration) to send it automatically.</span>` : ""}
            </form></div>
          <div class="portal-invite__qr" aria-hidden="true">${raw(qr)}</div>
        </div>` : ""}
      ${writer ? html`<div class="row">
        <form method="post" action="${base}/portal/invite">${raw(`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">`)}<button class="btn btn--sm btn--primary" type="submit">${acct ? "New invitation (resets password)" : "Invite to the portal"}</button></form>
        ${acct ? html`<form method="post" action="${base}/portal/access">${raw(`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">`)}<input type="hidden" name="active" value="${acct.active ? "0" : "1"}"><button class="btn btn--sm btn--ghost" type="submit">${acct.active ? "Turn off portal access" : "Turn portal access back on"}</button></form>` : ""}
      </div>` : ""}
    </section>
    <section class="card" aria-labelledby="pt-msgs">
      <div class="card__head"><h2 id="pt-msgs">Messages</h2><span class="muted small">${threads.length} conversation${threads.length === 1 ? "" : "s"}</span></div>
      ${threads.length ? html`<div class="portal-staff">
        <ul class="list-plain portal-staff__threads">${threads.map((t) => html`<li ${t.thread_id === openThread ? raw('class="is-open"') : ""}><a href="${base}/portal?thread=${t.thread_id}">${t.subject}</a><br><span class="small muted">${fmtTimestamp(t.last_at)}</span>${t.waiting ? html` <span class="badge badge--warn">Needs reply</span>` : ""}</li>`)}</ul>
        <div><ol class="portal__msgs">${msgs.map((m) => html`<li class="${m.from_patient ? "from-team" : "from-me"}"><div class="small muted">${m.from_patient ? patientName(patient) : `${m.staff_name}${m.credentials ? `, ${m.credentials}` : ""}`} · ${fmtTimestamp(m.created_at)}${m.from_patient && m.read_at ? " · read" : ""}</div><p>${m.body}</p></li>`)}</ol>
          ${canMessage(u) && msgs.length ? html`
            <form method="post" action="${base}/portal/messages" class="stack">${raw(`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">`)}<input type="hidden" name="thread_id" value="${openThread}">
              <label>Reply <textarea name="body" rows="4" maxlength="4000" required></textarea></label>
              <p class="small muted">The client sees your name and credentials. They're notified by email without the message text.</p>
              <div class="row"><button class="btn btn--primary btn--sm" type="submit">Send reply</button></div></form>
            ${msgs.some((m) => m.from_patient && !m.handled_at) ? html`<form method="post" action="/ehr/portal-messages/${openThread}/handled">${raw(`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">`)}<button class="btn btn--sm btn--ghost" type="submit">Mark handled without replying</button></form>` : ""}` : ""}
        </div></div>` : html`<p class="muted">No messages.</p>`}
      ${canMessage(u) && acct ? html`<details class="loc-action"><summary class="btn btn--sm">New message to the client</summary>
        <form method="post" action="${base}/portal/messages" class="stack">${raw(`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">`)}
          <label for="template">Template <span class="hint">(optional, fills a blank subject)</span> ${O.choice({ name: "template", list: O.STAFF_MESSAGE_TEMPLATES, placeholder: "No template" })}</label>
          <label>Subject <span class="hint">(or choose a template)</span><input name="subject" maxlength="120"></label>
          <label>Message <textarea name="body" rows="4" maxlength="4000" required></textarea></label>
          <button class="btn btn--primary btn--sm" type="submit">Send</button></form></details>` : ""}
    </section>`, { title: `Portal · ${patientName(patient)}` }));
}

function loadPatient(req, res) { const p = getPatient(req, req.params.id); if (!p) notFound(req, res, "Patient"); return p; }

router.get("/patients/:id/portal", requirePerm("patients:read"), (req, res) => { const p = loadPatient(req, res); if (p) portalTab(req, res, p); });

router.post("/patients/:id/portal/invite", requirePerm("patients:write"), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  req.db.prepare("UPDATE portal_tokens SET used_at = datetime('now') WHERE patient_id = ? AND kind = 'invite' AND used_at IS NULL").run(p.id); // one open invitation at a time
  const token = crypto.randomBytes(32).toString("base64url");
  req.db.prepare("INSERT INTO portal_tokens (token_hash, kind, patient_id, created_by, expires_at) VALUES (?, 'invite', ?, ?, ?)").run(sha256(token), p.id, req.user.id, nowSql(INVITE_DAYS * 86400));
  audit(req, "create", "portal_invite", null, p.id);
  portalTab(req, res, p, { inviteLink: `${publicBase(req)}/portal/invite/${token}` });
});

router.post("/patients/:id/portal/invite/send", requirePerm("patients:write"), async (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const link = String((req.body || {}).link || "");
  const m = /\/portal\/invite\/([A-Za-z0-9_-]{30,64})$/.exec(link);
  const row = m && req.db.prepare("SELECT * FROM portal_tokens WHERE token_hash = ? AND patient_id = ? AND kind = 'invite' AND used_at IS NULL AND expires_at > datetime('now')").get(sha256(m[1]), p.id);
  if (!row) { req.flash("error", "That invitation is no longer open. Create a new one."); return res.redirect(`/ehr/patients/${p.id}/portal`); }
  const c = getClinic(req.db);
  const via = (req.body || {}).via;
  try {
    if (via === "email" && p.email) {
      await mailer.sendMail({ to: p.email, subject: `Your ${c.name} patient portal invitation`,
        text: `${c.name} invited you to its patient portal, where you can see appointments, message your care team and view your record.\n\nSet up your account (link works for ${INVITE_DAYS} days):\n${link}`,
        html: `<p>${escHtml(c.name)} invited you to its patient portal, where you can see appointments, message your care team and view your record.</p><p><a href="${escHtml(link)}">Set up your account</a> (works for ${INVITE_DAYS} days).</p>` });
    } else if (via === "sms" && p.phone) {
      await sms.sendSms({ to: p.phone, body: `${c.name}: set up your patient portal account: ${link}` });
    } else throw new Error("No email address or phone number to send to.");
    audit(req, "send", "portal_invite", null, p.id, via);
    req.flash("success", via === "email" ? "Invitation emailed." : "Invitation texted.");
  } catch (e) {
    req.flash("error", `Couldn't send the invitation: ${e.message}`);
  }
  res.redirect(`/ehr/patients/${p.id}/portal`);
});

router.post("/patients/:id/portal/access", requirePerm("patients:write"), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const on = (req.body || {}).active === "1" ? 1 : 0;
  const acct = req.db.prepare("SELECT id FROM portal_accounts WHERE patient_id = ?").get(p.id);
  if (acct) {
    req.db.prepare("UPDATE portal_accounts SET active = ? WHERE id = ?").run(on, acct.id);
    if (!on) { req.db.prepare("DELETE FROM portal_sessions WHERE account_id = ?").run(acct.id); req.db.prepare("DELETE FROM fhir_tokens WHERE portal_account_id = ?").run(acct.id); }
    audit(req, "update", "portal_account", acct.id, p.id, on ? "enabled" : "disabled");
    req.flash("success", on ? "Portal access turned back on." : "Portal access turned off. The client was signed out.");
  }
  res.redirect(`/ehr/patients/${p.id}/portal`);
});

router.post("/patients/:id/portal/messages", requirePerm("patients:write"), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const b = req.body || {};
  const body = str(b.body, 4000);
  let threadId = Number(b.thread_id) || null, subject = str(b.subject, 120);
  if (!threadId && !subject) subject = O.readChoice(b, "template", { list: O.STAFF_MESSAGE_TEMPLATES }) || "";
  if (threadId) {
    const first = req.db.prepare("SELECT * FROM portal_messages WHERE id = ? AND patient_id = ? AND thread_id = id").get(threadId, p.id);
    if (!first) { req.flash("error", "That conversation wasn't found."); return res.redirect(`/ehr/patients/${p.id}/portal`); }
    subject = `Re: ${first.subject}`.slice(0, 120);
  }
  if (!body || !subject) { req.flash("error", "Write a subject and a message."); return res.redirect(`/ehr/patients/${p.id}/portal${threadId ? `?thread=${threadId}` : ""}`); }
  const id = Number(req.db.prepare("INSERT INTO portal_messages (patient_id, thread_id, from_patient, staff_user_id, subject, body) VALUES (?, ?, 0, ?, ?, ?)").run(p.id, threadId, req.user.id, subject, body).lastInsertRowid);
  if (!threadId) { threadId = id; req.db.prepare("UPDATE portal_messages SET thread_id = ? WHERE id = ?").run(id, id); }
  req.db.prepare("UPDATE portal_messages SET handled_at = datetime('now'), handled_by = ? WHERE patient_id = ? AND thread_id = ? AND from_patient = 1 AND handled_at IS NULL").run(req.user.id, p.id, threadId);
  audit(req, "create", "portal_message", id, p.id);
  // Notify the client without the message text.
  const acct = req.db.prepare("SELECT email FROM portal_accounts WHERE patient_id = ? AND active = 1").get(p.id);
  if (acct && mailer.mailConfig().enabled) {
    const c = getClinic(req.db);
    const link = `${publicBase(req)}/portal/messages`;
    mailer.sendMail({ to: acct.email, subject: `New message from ${c.name}`, text: `You have a new message in the ${c.name} patient portal.\n\nSign in to read it: ${link}`,
      html: `<p>You have a new message in the ${escHtml(c.name)} patient portal.</p><p><a href="${escHtml(link)}">Sign in to read it</a></p>` }).catch((e) => console.error("[portal] client notice failed:", e.message));
  }
  req.flash("success", "Message sent to the client.");
  res.redirect(`/ehr/patients/${p.id}/portal?thread=${threadId}`);
});

router.post("/portal-messages/:id/handled", requirePerm("patients:write"), (req, res) => {
  const first = req.db.prepare("SELECT * FROM portal_messages WHERE id = ? AND thread_id = id").get(Number(req.params.id) || -1);
  if (!first) return notFound(req, res, "Message");
  req.db.prepare("UPDATE portal_messages SET handled_at = datetime('now'), handled_by = ? WHERE thread_id = ? AND from_patient = 1 AND handled_at IS NULL").run(req.user.id, first.id);
  audit(req, "update", "portal_message", first.id, first.patient_id, "handled");
  req.flash("success", "Marked as handled.");
  res.redirect(`/ehr/patients/${first.patient_id}/portal?thread=${first.id}`);
});

router.get("/messages", requirePerm("patients:write"), (req, res) => {
  const db = req.db;
  const mine = req.query.who !== "all";
  const rows = db.prepare(`SELECT m.thread_id, m.patient_id, MAX(m.created_at) AS last_at, p.first_name, p.last_name, p.preferred_name, p.mrn, p.primary_clinician_id,
      (SELECT subject FROM portal_messages f WHERE f.id = m.thread_id) AS subject,
      SUM(CASE WHEN m.from_patient = 1 AND m.handled_at IS NULL THEN 1 ELSE 0 END) AS waiting
    FROM portal_messages m JOIN patients p ON p.id = m.patient_id
    WHERE m.created_at > datetime('now', '-90 days') ${mine ? "AND (p.primary_clinician_id = ? OR p.primary_clinician_id IS NULL)" : ""}
    GROUP BY m.thread_id ORDER BY waiting > 0 DESC, last_at DESC LIMIT 300`).all(...(mine ? [req.user.id] : []));
  audit(req, "view", "portal_message", null, null, `inbox ${rows.length}`);
  res.send(page(req, { title: "Messages", active: "messages", body: html`
    <div class="page-head"><div><h1>Messages</h1><p>Conversations with clients through the patient portal.</p></div>
      <div class="row"><a class="btn btn--sm ${mine ? "btn--primary" : ""}" href="/ehr/messages">My clients</a><a class="btn btn--sm ${mine ? "" : "btn--primary"}" href="/ehr/messages?who=all">Everyone</a></div></div>
    <section class="card">${rows.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Client</th><th>Subject</th><th>Last message</th><th></th></tr></thead>
      <tbody>${rows.map((r) => html`<tr>
        <td><a href="/ehr/patients/${r.patient_id}/portal?thread=${r.thread_id}">${patientName(r)}</a><br><span class="small muted">MRN ${r.mrn}</span></td>
        <td>${r.subject}</td><td class="small">${fmtTimestamp(r.last_at)}</td>
        <td>${r.waiting ? html`<span class="badge badge--warn">Needs reply</span>` : html`<span class="badge badge--good">Handled</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No portal messages in the last 90 days.${mine ? " (Showing your clients and clients without a primary clinician.)" : ""}</p>`}</section>` }));
});

module.exports = { clientRouter, router, smartEntry, unreadCount, resetPortalRateLimit };
