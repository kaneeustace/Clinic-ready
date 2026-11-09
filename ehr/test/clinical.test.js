"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { scoreInstrument, INSTRUMENTS } = require("../src/routes/clinical");
const { today, addDays } = require("../src/views");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

/** Responses for an instrument summing to `total` (item 9 kept at `item9` for PHQ-9). */
function resp(instrument, total, item9 = 0) {
  const n = INSTRUMENTS[instrument].items.length;
  const r = new Array(n).fill(0);
  let left = total;
  if (instrument === "PHQ9") { r[8] = item9; left -= item9; }
  for (let i = 0; left > 0; i = (i + 1) % n) {
    if (instrument === "PHQ9" && i === 8) continue;
    if (r[i] < 3) { r[i]++; left--; }
  }
  return r;
}
const form = (instrument, responses, extra = {}) => {
  const body = { instrument, administered_on: today(), ...extra };
  responses.forEach((v, i) => { if (v !== undefined) body[`q${i + 1}`] = v; });
  return body;
};
function newPatient(name = "Testcase") {
  return Number(t.db.prepare(`INSERT INTO patients (mrn, first_name, last_name, dob) VALUES (?, ?, 'Synthetic', '1990-01-01')`)
    .run(`T-${Math.random().toString(36).slice(2, 10)}`, name).lastInsertRowid);
}

/* ---------------- scoring ---------------- */

test("instrument definitions have standard item counts", () => {
  assert.equal(INSTRUMENTS.PHQ9.items.length, 9);
  assert.equal(INSTRUMENTS.GAD7.items.length, 7);
});

test("PHQ-9 severity boundaries", () => {
  const cases = [[0, "minimal"], [4, "minimal"], [5, "mild"], [9, "mild"], [10, "moderate"], [14, "moderate"],
    [15, "moderately severe"], [19, "moderately severe"], [20, "severe"], [27, "severe"]];
  for (const [total, sev] of cases) {
    const s = scoreInstrument("PHQ9", resp("PHQ9", total, total === 27 ? 3 : 0));
    assert.equal(s.total, total);
    assert.equal(s.severity, sev, `PHQ-9 ${total}`);
  }
});

test("GAD-7 severity boundaries", () => {
  const cases = [[0, "minimal"], [4, "minimal"], [5, "mild"], [9, "mild"], [10, "moderate"], [14, "moderate"], [15, "severe"], [21, "severe"]];
  for (const [total, sev] of cases) {
    const s = scoreInstrument("GAD7", resp("GAD7", total));
    assert.equal(s.total, total);
    assert.equal(s.severity, sev, `GAD-7 ${total}`);
    assert.equal(s.flagged, 0);
  }
});

test("PHQ-9 item 9 > 0 flags", () => {
  assert.equal(scoreInstrument("PHQ9", resp("PHQ9", 3, 0)).flagged, 0);
  assert.equal(scoreInstrument("PHQ9", [0, 0, 0, 0, 0, 0, 0, 0, 1]).flagged, 1);
  assert.equal(scoreInstrument("PHQ9", [0, 0, 0, 0, 0, 0, 0, 0, 3]).flagged, 1);
  // Item 9 on a GAD-7 doesn't exist; item 7 high is not a flag.
  assert.equal(scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, 3]).flagged, 0);
});

test("scoreInstrument rejects bad input", () => {
  assert.throws(() => scoreInstrument("BDI", [0]));
  assert.throws(() => scoreInstrument("PHQ9", [0, 0, 0]));
  assert.throws(() => scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, 4]));
  assert.throws(() => scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, -1]));
  assert.throws(() => scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, 1.5]));
});

/* ---------------- measures routes ---------------- */

test("measures page and form render for clinician", async () => {
  const c = await t.login("therapist");
  const pid = t.ctx.patients[0];
  const page = await c.get(`/ehr/patients/${pid}/measures`);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="spark"/);
  assert.match(page.text, /<desc id=/);
  assert.match(page.text, /Chart data table/);
  const f = await c.get(`/ehr/patients/${pid}/measures/new?instrument=GAD7`);
  assert.equal(f.status, 200);
  assert.match(f.text, /data-score-total/);
  assert.match(f.text, /Over the last 2 weeks/);
  assert.equal((f.text.match(/<fieldset/g) || []).length, 7);
  assert.equal((await c.get(`/ehr/patients/${pid}/measures/new?instrument=XYZ`)).status, 400);
});

test("saving a PHQ-9 stores the score and audits", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const r = await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", 12)));
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM assessments WHERE patient_id = ?").get(pid);
  assert.equal(row.total_score, 12);
  assert.equal(row.severity, "moderate");
  assert.equal(row.flagged, 0);
  assert.equal(row.entered_by, c.userId);
  assert.deepEqual(JSON.parse(row.responses), resp("PHQ9", 12));
  const a = t.db.prepare("SELECT * FROM audit_log WHERE action = 'create' AND entity_type = 'assessment' AND entity_id = ?").get(row.id);
  assert.ok(a);
  assert.equal(a.patient_id, pid);
  const view = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(view.text, /12/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'assessment' AND patient_id = ?").get(pid));
});

test("PHQ-9 item 9 endorsed: flagged and urgent alert with 988", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const r = await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", 8, 1)));
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM assessments WHERE patient_id = ?").get(pid);
  assert.equal(row.flagged, 1);
  const next = await c.get(r.location);
  assert.match(next.text, /role="alert"[^>]*>URGENT/);
  assert.match(next.text, /988/);
  assert.match(next.text, /same-day/);
  assert.match(next.text, /Safety flag/); // chart header pill
});

test("validation: missing item, bad value, future date, foreign appointment -> 400", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const missing = resp("GAD7", 5); missing[3] = undefined;
  let r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", missing));
  assert.equal(r.status, 400);
  assert.match(r.text, /item 4/);
  const bad = resp("GAD7", 5); bad[0] = 4;
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", bad));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 5), { administered_on: addDays(today(), 2) }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 5), { administered_on: "2026-02-30" }));
  assert.equal(r.status, 400);
  const otherAppt = t.db.prepare("SELECT id FROM appointments WHERE patient_id <> ? LIMIT 1").get(pid).id;
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 5), { appointment_id: otherAppt }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/measures`, form("NOPE", resp("GAD7", 5)));
  assert.equal(r.status, 400);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM assessments WHERE patient_id = ?").get(pid).n, 0);
});

test("own appointment can be linked", async () => {
  const c = await t.login("therapist");
  const pid = t.ctx.patients[2];
  const appt = t.db.prepare("SELECT id FROM appointments WHERE patient_id = ? LIMIT 1").get(pid).id;
  const r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 3), { appointment_id: appt }));
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT appointment_id FROM assessments WHERE patient_id = ? ORDER BY id DESC").get(pid).appointment_id, appt);
});

test("response and remission indicators", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  for (const [total, d] of [[16, -42], [10, -28], [4, -14]]) {
    const r = await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", total), { administered_on: addDays(today(), d) }));
    assert.equal(r.status, 302);
  }
  const page = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(page.text, /badge--good">Response</);
  assert.match(page.text, /badge--good">Remission</);
  assert.match(page.text, /75% reduction/);
});

/* Treatment plan tests live in plans.test.js. */

/* ---------------- permissions ---------------- */

test("frontdesk and billing are forbidden", async () => {
  const pid = t.ctx.patients[0];
  for (const role of ["frontdesk", "billing"]) {
    const c = await t.login(role);
    assert.equal((await c.get(`/ehr/patients/${pid}/measures`)).status, 403, role);
    assert.equal((await c.get(`/ehr/patients/${pid}/measures/new?instrument=PHQ9`)).status, 403, role);
    assert.equal((await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", 3)))).status, 403, role);
  }
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'forbidden'").get());
});

test("unknown patient -> 404", async () => {
  const c = await t.login("admin");
  assert.equal((await c.get("/ehr/patients/999999/measures")).status, 404);
});

/* ---------------- seed ---------------- */

test("seed data: improving series, recent flagged PHQ-9", () => {
  const db = t.db;
  assert.ok(db.prepare("SELECT 1 FROM assessments WHERE instrument = 'PHQ9' AND flagged = 1 AND administered_on >= date('now','-14 days')").get());
  const rows = db.prepare("SELECT * FROM assessments").all();
  for (const r of rows) {
    const s = scoreInstrument(r.instrument, JSON.parse(r.responses));
    assert.equal(s.total, r.total_score);
    assert.equal(s.severity, r.severity);
    assert.equal(s.flagged, r.flagged);
  }
});

test("dashboard safety panel shows seeded flag", async () => {
  const c = await t.login("therapist");
  const r = await c.get("/ehr");
  assert.match(r.text, /Safety follow-up/);
});
