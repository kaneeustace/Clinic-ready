"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { nowLocal } = require("../src/views");
const mailer = require("../src/mailer");
const sms = require("../src/sms");
const rem = require("../src/checkin-reminders");

let t, emails = [], texts = [];
before(async () => {
  t = await start();
  mailer.setTestTransport(async (m) => { emails.push(m); });
  sms.setTestTransport(async (m) => { texts.push(m); });
});
after(async () => { mailer.setTestTransport(null); sms.setTestTransport(null); await t.stop(); });

function apptIn(pid, minutes, type = "therapy") {
  const start = rem.addMinutesLocal(nowLocal(), minutes);
  if (start.slice(0, 10) !== nowLocal().slice(0, 10)) return null; // too close to midnight for this test
  return Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status)
    VALUES (?, ?, ?, ?, ?, 'in_person', 'scheduled')`).run(pid, t.ctx.users.therapist, start, rem.addMinutesLocal(start, 50), type).lastInsertRowid);
}

test("automatic links: preferred contact decides email vs text, sent once, only inside the lead window", async (tt) => {
  const [p1, p2, p3] = [t.ctx.patients[2], t.ctx.patients[3], t.ctx.patients[4]];
  t.db.prepare("UPDATE patients SET email = 'one@example.com', phone = '(602) 555-0101', preferred_contact = 'email' WHERE id = ?").run(p1);
  t.db.prepare("UPDATE patients SET email = 'two@example.com', phone = '(602) 555-0102', preferred_contact = 'text' WHERE id = ?").run(p2);
  t.db.prepare("UPDATE patients SET email = 'three@example.com', phone = NULL, preferred_contact = NULL WHERE id = ?").run(p3);
  const a1 = apptIn(p1, 30), a2 = apptIn(p2, 45, "group"), a3 = apptIn(p3, 300);
  if (!a1 || !a2) return tt.skip("too close to midnight");
  const cfg = { on: true, lead: 60, base: "https://ehr.example.org" };
  const r = await rem.runReminders(t.db, { cfg });
  assert.ok(r.sent >= 2, JSON.stringify(r));
  const e = emails.find((m) => m.to === "one@example.com");
  assert.ok(e, "emailed the email-preferring client");
  assert.match(e.text, /https:\/\/ehr\.example\.org\/checkin\/s\//);
  const sm = texts.find((m) => m.to === "+16025550102");
  assert.ok(sm, "texted the text-preferring client");
  assert.match(sm.body, /group/);
  assert.match(sm.body, /\/checkin\/s\//);
  assert.ok(!emails.some((m) => m.to === "three@example.com"), "5 hours away: not yet");
  // The texted link actually works
  const tok = sm.body.match(/\/checkin\/s\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await t.client().get(`/checkin/s/${tok}`)).status, 200);
  // Never twice
  const before2 = emails.length + texts.length;
  await rem.runReminders(t.db, { cfg });
  assert.equal(emails.length + texts.length, before2);
  assert.equal(t.db.prepare("SELECT link_sent_via FROM checkins WHERE appointment_id = ?").get(a2).link_sent_via, "text");
  // Off switch
  const a4 = apptIn(t.ctx.patients[5], 20);
  t.db.prepare("UPDATE patients SET email = 'four@example.com' WHERE id = ?").run(t.ctx.patients[5]);
  const r2 = await rem.runReminders(t.db, { cfg: { ...cfg, on: false } });
  assert.equal(r2.sent, 0);
  void a3; void a4;
});

test("staff can text a link through Twilio from the appointment", async () => {
  const pid = t.ctx.patients[6];
  t.db.prepare("UPDATE patients SET phone = '602-555-0199' WHERE id = ?").run(pid);
  const a = apptIn(pid, 90);
  if (!a) return;
  const staff = await t.login("frontdesk");
  const r = await staff.post(`/ehr/appointments/${a}/checkin-link`, { send: "text" });
  assert.match(r.text, /Texted to the client/);
  assert.ok(texts.some((m) => m.to === "+16025550199"));
  assert.equal(sms.toE164("(602) 555-0199"), "+16025550199");
  assert.equal(sms.toE164("12"), null);
});

test("kiosk: set up from the EHR (signs staff out), start screen, resets close the previous client's link", async () => {
  const staff = await t.login("frontdesk");
  const page = await staff.get("/ehr/kiosk");
  assert.match(page.text, /Make this device a kiosk/);
  const r = await staff.post("/ehr/kiosk", { name: "Lobby iPad" });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/checkin/kiosk");
  const set = r.headers.getSetCookie();
  const kc = set.find((c) => c.startsWith("ci_kiosk="));
  assert.ok(kc && /Path=\/checkin/.test(kc) && /HttpOnly/.test(kc));
  assert.ok(set.some((c) => /^ehr_sid=;/.test(c)), "staff signed out on the kiosk");
  const cookie = kc.split(";")[0];
  const k = (path, opts = {}) => fetch(t.base + path, { redirect: "manual", ...opts, headers: { cookie, ...(opts.headers || {}) } });
  const home = await (await k("/checkin/kiosk")).text();
  assert.match(home, /Welcome! Check in here/);
  assert.match(home, /data-kiosk="90"/);
  // Not a kiosk without the cookie
  assert.equal((await fetch(t.base + "/checkin/kiosk")).status, 403);
  // A client finds their appointment at the kiosk
  const pid = t.ctx.patients[7];
  t.db.prepare("UPDATE patients SET last_name = 'Kioskson', dob = '1988-08-08' WHERE id = ?").run(pid);
  const a = apptIn(pid, 15);
  if (!a) return;
  const found = await k("/checkin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: t.base }, body: "last_name=Kioskson&dob=1988-08-08" });
  assert.equal(found.status, 303);
  const tok = found.headers.get("location").match(/\/checkin\/s\/([A-Za-z0-9_-]+)/)[1];
  const step = await (await k(`/checkin/s/${tok}`)).text();
  assert.match(step, /Start over/);
  // Start over / idle reset ends that client's link on this device
  await k(`/checkin/kiosk?end=${tok}`);
  assert.equal((await k(`/checkin/s/${tok}`)).status, 404);
  // Turning the kiosk off stops it
  const kid = t.db.prepare("SELECT id FROM checkin_kiosks WHERE name = 'Lobby iPad'").get().id;
  const staff2 = await t.login("frontdesk");
  await staff2.post(`/ehr/kiosk/${kid}/revoke`, {});
  assert.equal((await k("/checkin/kiosk")).status, 403);
});

test("check-ins page shows how clients get their link", async () => {
  const staff = await t.login("frontdesk");
  const pg = await staff.get("/ehr/checkins");
  assert.match(pg.text, /How clients get their check-in/);
  assert.match(pg.text, /Front-desk kiosk/);
});
