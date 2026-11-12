"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");

let t, pid, apptId;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
before(async () => {
  t = await start();
  pid = t.ctx.patients[6] || t.ctx.patients[t.ctx.patients.length - 1];
  t.db.prepare("DELETE FROM assessments WHERE patient_id = ?").run(pid);
  t.db.prepare("UPDATE patients SET last_name = 'Checkington', dob = '1990-02-03', phone = '(602) 555-0199', email = 'old@example.com' WHERE id = ?").run(pid);
  apptId = Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status)
    VALUES (?, ?, ?, ?, 'therapy', 'in_person', 'scheduled')`).run(pid, t.ctx.users.therapist, `${today()}T23:00`, `${today()}T23:50`).lastInsertRowid);
});
after(async () => { await t.stop(); });

const tokenFrom = (loc) => (loc.match(/\/checkin\/s\/([A-Za-z0-9_-]+)/) || [])[1];

test("lobby lookup: wrong details fail; right details start a check-in without exposing contact details", async () => {
  const c = t.client();
  assert.match((await c.get("/checkin")).text, /Check in for your appointment/);
  let r = await c.post("/checkin", { last_name: "Nobody", dob: "1990-02-03" });
  assert.equal(r.status, 404);
  r = await c.post("/checkin", { last_name: "checkington", dob: "1990-02-03" });
  assert.equal(r.status, 303);
  const tok = tokenFrom(r.location);
  assert.ok(tok);
  const page = await c.get(`/checkin/s/${tok}`);
  assert.match(page.text, /Is your contact information still correct/);
  assert.match(page.text, /•••-0199/);
  assert.doesNotMatch(page.text, /555-0199|old@example\.com/);
  assert.ok(t.db.prepare("SELECT 1 FROM checkins WHERE patient_id = ? AND started_at IS NOT NULL").get(pid));
});

test("full flow: contact change, new insurance with card photos, PHQ-9 safety item, GAD-7, consent", async () => {
  const staff = await t.login("frontdesk");
  const link = await staff.post(`/ehr/appointments/${apptId}/checkin-link`, {});
  assert.equal(link.status, 200);
  const tok = tokenFrom(link.text);
  const c = t.client();
  const base = `/checkin/s/${tok}`;
  // old lobby token no longer works (new link replaced it)
  assert.equal((await c.post(`${base}/contact`, { same: "0", phone: "(480) 555-0111", email: "bad" })).status, 400);
  assert.equal((await c.post(`${base}/contact`, { same: "0", phone: "(480) 555-0111", email: "new@example.com" })).status, 303);
  assert.match((await c.get(base)).text, /Has your insurance changed/);
  assert.equal((await c.post(`${base}/insurance`, { changed: "1", payer: "", image_data: "" })).status, 400);
  assert.equal((await c.post(`${base}/insurance`, { changed: "1", payer: "Mercy Care", member_id: "A12345678", image_data: `data:image/png;base64,${PNG}` })).status, 303);
  assert.match((await c.get(base)).text, /Back of your card/);
  await c.post(`${base}/card-back`, { image_data: `data:image/png;base64,${PNG}` });
  assert.match((await c.get(base)).text, /PHQ-9|How have you been feeling/);
  const phq = {}; for (let i = 0; i < 9; i++) phq[`q${i}`] = i === 8 ? "1" : "1";
  assert.equal((await c.post(`${base}/phq9`, { q0: "1" })).status, 400);
  const r = await c.post(`${base}/phq9`, phq);
  assert.equal(r.status, 303);
  assert.match(r.location, /\?c=1$/);
  assert.match((await c.get(`${base}?c=1`)).text, /Your care team has been notified/);
  const gad = {}; for (let i = 0; i < 7; i++) gad[`q${i}`] = "2";
  await c.post(`${base}/gad7`, gad);
  assert.equal((await c.post(`${base}/consent`, { signature: "Pat Checkington" })).status, 400);
  await c.post(`${base}/consent`, { agree: "1", signature: "Pat Checkington" });
  const done = await c.get(base);
  assert.match(done.text, /You&#39;re checked in|You're checked in/);
  assert.equal(t.db.prepare("SELECT status FROM appointments WHERE id = ?").get(apptId).status, "checked_in");
  const ci = t.db.prepare("SELECT * FROM checkins WHERE appointment_id = ?").get(apptId);
  assert.equal(ci.flagged, 1);
  assert.equal(JSON.parse(ci.contact_changes).email, "new@example.com");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM patient_images WHERE patient_id = ? AND uploaded_by IS NULL").get(pid).n, 2);
  assert.equal(t.db.prepare("SELECT flagged FROM assessments WHERE id = ?").get(ci.phq9_id).flagged, 1);
  // Staff see it on the dashboard and can apply the contact changes
  const dash = await staff.get("/ehr");
  assert.match(dash.text, /Checked in today/);
  assert.match(dash.text, /Safety screen positive/);
  const review = await staff.get(`/ehr/checkins/${ci.id}`);
  assert.match(review.text, /Mercy Care/);
  assert.match(review.text, /new@example\.com/);
  await staff.post(`/ehr/checkins/${ci.id}/apply-contact`, {});
  assert.equal(t.db.prepare("SELECT email FROM patients WHERE id = ?").get(pid).email, "new@example.com");
  // A finished check-in can't be changed with the same link
  await c.post(`${base}/consent`, { agree: "1", signature: "Someone Else" });
  assert.equal(t.db.prepare("SELECT consent_name FROM checkins WHERE id = ?").get(ci.id).consent_name, "Pat Checkington");
});

test("security: bad or expired tokens, lobby rate limit, staff-only pages", async () => {
  const c = t.client();
  assert.equal((await c.get("/checkin/s/not-a-real-token-xxxxxxxxxxxxxxxx")).status, 404);
  t.db.prepare("UPDATE checkins SET token_expires_at = datetime('now','-1 minute')").run();
  assert.equal((await c.get("/ehr/checkins")).status, 302); // requires staff login
  let last;
  for (let i = 0; i < 10; i++) last = await c.post("/checkin", { last_name: "Nobody", dob: "2000-01-01" });
  assert.equal(last.status, 429);
});
