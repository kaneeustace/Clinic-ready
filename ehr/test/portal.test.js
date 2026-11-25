"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { start } = require("./helpers");
const { today, nowLocal } = require("../src/views");
const mailer = require("../src/mailer");
const portal = require("../src/routes/portal");
const fhir = require("../src/routes/fhir");

let t, pid, otherPid, inviteUrl;
const PW = "Portal-Pass-2026!";
const sent = [];
before(async () => {
  t = await start();
  pid = t.ctx.patients[3];
  otherPid = t.ctx.patients[4];
  mailer.setTestTransport((m) => { sent.push(m); });
});
after(async () => { mailer.setTestTransport(null); await t.stop(); });

/** A browser for the portal: keeps the portal_sid cookie and the last CSRF token. */
function browser() {
  let cookie = "", csrf = "";
  async function request(method, path, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) if (v !== undefined) params.append(k, String(v));
      if (csrf && !params.has("_csrf")) params.append("_csrf", csrf);
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = params.toString();
    }
    const res = await fetch(t.base + path, { method, headers, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); if (pair.startsWith("portal_sid=")) cookie = pair.endsWith("=") ? "" : pair; }
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, text, location: res.headers.get("location"), headers: res.headers };
  }
  return { get: (p) => request("GET", p), post: (p, b = {}) => request("POST", p, b), get cookie() { return cookie; } };
}
const dob = (id) => t.db.prepare("SELECT dob FROM patients WHERE id = ?").get(id).dob;

test("staff invite: link, QR and audit; billing can't invite; client sets up the account (date of birth checked)", async () => {
  const billing = await t.login("billing");
  assert.equal((await billing.post(`/ehr/patients/${pid}/portal/invite`)).status, 403);
  const fd = await t.login("frontdesk");
  let tab = await fd.get(`/ehr/patients/${pid}/portal`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Invite to the portal/);
  const r = await fd.post(`/ehr/patients/${pid}/portal/invite`);
  assert.equal(r.status, 200);
  inviteUrl = r.text.match(/value="(http[^"]+\/portal\/invite\/[A-Za-z0-9_-]+)"/)[1];
  assert.match(r.text, /<svg/);
  assert.ok(!t.db.prepare("SELECT 1 FROM portal_tokens WHERE token_hash = ?").get(inviteUrl.split("/").pop()), "only the hash is stored");

  const b = browser();
  const path = new URL(inviteUrl).pathname;
  let page = await b.get(path);
  assert.equal(page.status, 200);
  assert.match(page.text, /Welcome/);
  let s = await b.post(path, { dob: "1900-01-01", email: "client@example.com", password: PW, confirm: PW, agree: "1" });
  assert.equal(s.status, 400);
  assert.match(s.text, /date of birth doesn(&#39;|')t match/);
  s = await b.post(path, { dob: dob(pid), email: "client@example.com", password: "short", confirm: "short", agree: "1" });
  assert.equal(s.status, 400);
  s = await b.post(path, { dob: dob(pid), email: "client@example.com", password: PW, confirm: PW, agree: "1" });
  assert.equal(s.status, 302);
  assert.equal(s.location, "/portal");
  const home = await b.get("/portal");
  assert.equal(home.status, 200);
  assert.match(home.text, /Hello, /);
  // The link is single-use
  assert.equal((await browser().get(path)).status, 410);
  tab = await fd.get(`/ehr/patients/${pid}/portal`);
  assert.match(tab.text, /client@example\.com/);
});

test("sign in, wrong password, lockout after 5 tries, sign out", async () => {
  portal.resetPortalRateLimit();
  const b = browser();
  assert.equal((await b.get("/portal")).location, "/portal/login?next=%2Fportal");
  for (let i = 0; i < 5; i++) assert.equal((await b.post("/portal/login", { email: "client@example.com", password: "Wrong-Password-1!" })).status, 401);
  let r = await b.post("/portal/login", { email: "client@example.com", password: PW });
  assert.equal(r.status, 429, "locked");
  t.db.prepare("UPDATE portal_accounts SET locked_until = NULL, failed_logins = 0").run();
  r = await b.post("/portal/login", { email: "CLIENT@example.com", password: PW, next: "/portal/record" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/portal/record");
  assert.equal((await b.get("/portal/record")).status, 200);
  r = await b.post("/portal/logout");
  assert.equal(r.location, "/portal/login");
  assert.equal((await b.get("/portal")).status, 302);
});

async function signedIn() {
  portal.resetPortalRateLimit();
  const b = browser();
  const r = await b.post("/portal/login", { email: "client@example.com", password: PW });
  assert.equal(r.status, 302);
  await b.get("/portal");
  return b;
}

test("my record: allergies, medications, results, notes (never psychotherapy), download; clinic can hide notes", async () => {
  t.db.prepare("INSERT INTO allergies (patient_id, substance, reaction) VALUES (?, 'Penicillin-test', 'Hives')").run(pid);
  const signed = t.db.prepare("INSERT INTO notes (patient_id, author_id, type, format, content, status, service_date, signed_at, signed_by) VALUES (?, ?, 'progress', 'dap', ?, 'signed', date('now'), datetime('now'), ?)")
    .run(pid, t.ctx.users.therapist, JSON.stringify({ data: "Client discussed sleep routine." }), t.ctx.users.therapist).lastInsertRowid;
  const psy = t.db.prepare("INSERT INTO notes (patient_id, author_id, type, format, content, status, service_date, signed_at, signed_by) VALUES (?, ?, 'psychotherapy', 'narrative', ?, 'signed', date('now'), datetime('now'), ?)")
    .run(pid, t.ctx.users.therapist, JSON.stringify({ narrative: "Private process notes." }), t.ctx.users.therapist).lastInsertRowid;
  const b = await signedIn();
  const rec = await b.get("/portal/record");
  assert.equal(rec.status, 200);
  assert.match(rec.text, /Penicillin-test/);
  assert.match(rec.text, new RegExp(`/portal/record/notes/${signed}`));
  assert.doesNotMatch(rec.text, new RegExp(`/portal/record/notes/${psy}"`));
  const note = await b.get(`/portal/record/notes/${signed}`);
  assert.match(note.text, /sleep routine/);
  assert.equal((await b.get(`/portal/record/notes/${psy}`)).status, 404);
  const other = t.db.prepare("SELECT id FROM notes WHERE patient_id = ? AND status = 'signed' AND type <> 'psychotherapy' LIMIT 1").get(otherPid);
  if (other) assert.equal((await b.get(`/portal/record/notes/${other.id}`)).status, 404, "another client's note");

  const dl = await b.get("/portal/record/download");
  assert.match(dl.headers.get("content-type"), /application\/fhir\+json/);
  const bundle = JSON.parse(dl.text);
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.entry.find((e) => e.resource.resourceType === "Patient").resource.id, String(pid));
  assert.ok(!bundle.entry.some((e) => e.resource.resourceType === "DocumentReference" && e.resource.id === String(psy)));

  t.db.prepare("UPDATE clinic_settings SET portal_notes = 0 WHERE id = 1").run();
  assert.doesNotMatch((await b.get("/portal/record")).text, /Visit notes/);
  assert.equal((await b.get(`/portal/record/notes/${signed}`)).status, 404);
  t.db.prepare("UPDATE clinic_settings SET portal_notes = 1 WHERE id = 1").run();
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'portal_download' AND patient_id = ?").get(pid));
});

test("messages: client writes, staff inbox shows it, staff replies, client is notified without the text", async () => {
  const b = await signedIn();
  let r = await b.post("/portal/messages", { subject: "Question about my plan", body: "Can we talk about my goals next time?" });
  assert.equal(r.status, 302);
  const threadId = Number(r.location.split("/").pop());
  const th = await t.login("therapist");
  const inbox = await th.get("/ehr/messages?who=all");
  assert.match(inbox.text, /Question about my plan/);
  assert.match(inbox.text, /Needs reply/);
  const dash = await th.get("/ehr");
  assert.match(dash.text, /class="nav-count"/);
  const tab = await th.get(`/ehr/patients/${pid}/portal?thread=${threadId}`);
  assert.match(tab.text, /Can we talk about my goals/);
  sent.length = 0;
  r = await th.post(`/ehr/patients/${pid}/portal/messages`, { thread_id: String(threadId), body: "Yes, let's start there on Tuesday." });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "client@example.com");
  assert.doesNotMatch(sent[0].text + sent[0].html, /Tuesday|goals/, "no message text in the email");
  assert.match((await th.get("/ehr/messages?who=all")).text, /Handled/);
  const home = await b.get("/portal");
  assert.match(home.text, /1 new message/);
  const view = await b.get(`/portal/messages/${threadId}`);
  assert.match(view.text, /start there on Tuesday/);
  assert.doesNotMatch((await b.get("/portal")).text, /new message/);
  // Another client's thread isn't visible
  const otherMsg = t.db.prepare("INSERT INTO portal_messages (patient_id, from_patient, subject, body) VALUES (?, 1, 'x', 'y')").run(otherPid).lastInsertRowid;
  t.db.prepare("UPDATE portal_messages SET thread_id = id WHERE id = ?").run(otherMsg);
  assert.equal((await b.get(`/portal/messages/${otherMsg}`)).status, 404);
});

test("check in from the portal for today's appointment", async () => {
  const start = nowLocal().slice(0, 11) + "23:00";
  const appt = t.db.prepare("INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type) VALUES (?, ?, ?, ?, 'therapy')")
    .run(pid, t.ctx.users.therapist, start, nowLocal().slice(0, 11) + "23:50").lastInsertRowid;
  const b = await signedIn();
  const home = await b.get("/portal");
  assert.match(home.text, new RegExp(`/portal/appointments/${appt}/checkin`));
  const r = await b.post(`/portal/appointments/${appt}/checkin`);
  assert.match(r.location, /^\/checkin\/s\/[A-Za-z0-9_-]+$/);
  assert.equal(today(), start.slice(0, 10));
});

test("patient-facing SMART: client approves an app for their own record; turning off access ends it", async () => {
  fhir.resetFhirRateLimit();
  const admin = await t.login("admin");
  const REDIRECT = "https://phr.example.com/cb";
  const reg = await admin.post("/ehr/admin/api/clients", { kind: "smart", name: "My Health Record app", redirect_uris: REDIRECT, public_client: "1", scopes: "launch/patient openid fhirUser patient/*.read patient/*.rs" });
  const clientId = reg.text.match(/<code>(cr_[^<]+)<\/code>/)[1];
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "launch/patient openid fhirUser patient/*.read user/*.read",
    state: "s1", aud: `${t.base}/fhir`, code_challenge: challenge, code_challenge_method: "S256" });
  // No one signed in: a chooser
  const anon = browser();
  let r = await anon.get(`/ehr/smart/authorize?${q}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /I(&#39;|')m a client/);
  // Signed in to the portal: sent to the client consent screen
  const b = await signedIn();
  r = await b.get(`/ehr/smart/authorize?${q}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/portal\/smart\/authorize\?/);
  r = await b.get(r.location);
  assert.equal(r.status, 200);
  assert.match(r.text, /Connect My Health Record app/);
  r = await b.post("/portal/smart/authorize", { ...Object.fromEntries(q), scope: "launch/patient openid fhirUser patient/*.read", decision: "allow" });
  assert.equal(r.status, 302);
  const code = new URL(r.location).searchParams.get("code");
  const tk = await (await fetch(`${t.base}/fhir/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) })).json();
  assert.equal(tk.patient, String(pid));
  assert.doesNotMatch(tk.scope, /user\//, "clients never get user/ scopes");
  const claims = JSON.parse(Buffer.from(tk.id_token.split(".")[1], "base64url"));
  assert.equal(claims.fhirUser, `${t.base}/fhir/Patient/${pid}`);
  const get = (p) => fetch(t.base + p, { headers: { authorization: `Bearer ${tk.access_token}` } });
  assert.equal((await get(`/fhir/Patient/${pid}`)).status, 200);
  assert.equal((await get(`/fhir/Patient/${otherPid}`)).status, 404);
  assert.match((await b.get("/portal/apps")).text, /My Health Record app/);

  const fd = await t.login("frontdesk");
  await fd.post(`/ehr/patients/${pid}/portal/access`, { active: "0" });
  assert.equal((await get(`/fhir/Patient/${pid}`)).status, 401);
  assert.equal((await b.get("/portal")).status, 302, "signed out");
  await fd.post(`/ehr/patients/${pid}/portal/access`, { active: "1" });
});

test("forgot password emails a one-hour link (no hint whether the email exists)", async () => {
  sent.length = 0;
  const b = browser();
  let r = await b.post("/portal/forgot", { email: "nobody@example.com" });
  assert.match(r.text, /Check your email/);
  assert.equal(sent.length, 0);
  r = await b.post("/portal/forgot", { email: "client@example.com" });
  assert.match(r.text, /Check your email/);
  assert.equal(sent.length, 1);
  const link = sent[0].text.match(/https?:\/\/\S+\/portal\/reset\/\S+/)[0];
  const path = new URL(link).pathname;
  const NEW = "Brand-New-Pass-77!";
  r = await b.post(path, { dob: dob(pid), email: "client@example.com", password: NEW, confirm: NEW, agree: "1" });
  assert.equal(r.status, 302);
  portal.resetPortalRateLimit();
  assert.equal((await browser().post("/portal/login", { email: "client@example.com", password: NEW })).status, 302);
});
