"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { scoreInstrument, INSTRUMENTS } = require("../src/routes/clinical");

const fill = (n, v) => Array(n).fill(v);

test("C-SSRS risk levels", () => {
  assert.equal(scoreInstrument("CSSRS", fill(7, 0)).severity, "no risk identified");
  assert.deepEqual(scoreInstrument("CSSRS", [1, 0, 0, 0, 0, 0, 0]), { total: 1, severity: "low risk", flagged: 0 });
  assert.equal(scoreInstrument("CSSRS", [1, 1, 1, 0, 0, 0, 0]).severity, "moderate risk");
  assert.equal(scoreInstrument("CSSRS", [0, 0, 0, 0, 0, 1, 0]).severity, "moderate risk", "lifetime behavior > 3 months ago");
  const high = scoreInstrument("CSSRS", [1, 1, 1, 1, 0, 0, 0]);
  assert.equal(high.severity, "high risk");
  assert.equal(high.flagged, 1);
  assert.equal(scoreInstrument("CSSRS", [0, 0, 0, 0, 0, 1, 1]).severity, "high risk", "behavior within 3 months");
  assert.throws(() => scoreInstrument("CSSRS", [1, 0, 1, 0, 0, 0, 0]), /question 2 is No/);
});

test("AUDIT zones and 0/2/4 items", () => {
  assert.equal(scoreInstrument("AUDIT", fill(10, 0)).severity, "low risk");
  assert.equal(scoreInstrument("AUDIT", [4, 4, 0, 0, 0, 0, 0, 0, 0, 0]).severity, "hazardous");
  assert.equal(scoreInstrument("AUDIT", [4, 4, 4, 4, 0, 0, 0, 0, 0, 0]).severity, "harmful");
  assert.deepEqual(scoreInstrument("AUDIT", [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]).total, 40);
  assert.throws(() => scoreInstrument("AUDIT", [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]), /Invalid response for item 9/);
});

test("DAST-10 reverse-scored item 3 and bands", () => {
  // Item 3 "No" (value 1) scores a point.
  assert.equal(scoreInstrument("DAST10", [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).total, 1);
  assert.equal(scoreInstrument("DAST10", fill(10, 0)).severity, "no problems reported");
  assert.equal(scoreInstrument("DAST10", [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]).severity, "moderate");
  assert.equal(scoreInstrument("DAST10", fill(10, 1)).severity, "severe");
});

test("PCL-5 threshold", () => {
  assert.equal(scoreInstrument("PCL5", fill(20, 1)).severity, "below threshold");
  const r = fill(20, 1); r[0] = 4; r[1] = 4; r[2] = 3; r[3] = 3; r[4] = 4; // 20 + 3 + 3 + 2 + 2 + 3 = 33
  assert.equal(scoreInstrument("PCL5", r).total, 33);
  assert.equal(scoreInstrument("PCL5", r).severity, "probable PTSD");
  r[4] = 3; // 32
  assert.equal(scoreInstrument("PCL5", r).severity, "below threshold");
});

test("MDQ needs all three criteria", () => {
  const yes7 = [...fill(7, 1), ...fill(6, 0)];
  assert.equal(scoreInstrument("MDQ", [...yes7, 1, 2]).severity, "positive screen");
  assert.equal(scoreInstrument("MDQ", [...yes7, 0, 3]).severity, "negative screen", "not same period");
  assert.equal(scoreInstrument("MDQ", [...yes7, 1, 1]).severity, "negative screen", "minor problem");
  assert.equal(scoreInstrument("MDQ", [...fill(6, 1), ...fill(7, 0), 1, 3]).severity, "negative screen", "only 6 yes");
});

test("ASRS item thresholds", () => {
  assert.deepEqual(scoreInstrument("ASRS", [2, 2, 2, 3, 0, 0]), { total: 4, severity: "positive screen", flagged: 0 });
  assert.equal(scoreInstrument("ASRS", [2, 2, 2, 2, 2, 2]).total, 3, "items 4-6 need Often");
  assert.equal(scoreInstrument("ASRS", [1, 1, 1, 4, 4, 4]).severity, "negative screen");
});

test("PHQ-9 and GAD-7 unchanged", () => {
  assert.deepEqual(scoreInstrument("PHQ9", [3, 3, 3, 3, 3, 3, 3, 3, 0]), { total: 24, severity: "severe", flagged: 0 });
  assert.equal(scoreInstrument("GAD7", fill(7, 1)).severity, "mild");
});

/* ---------- UI ---------- */
let t, pid;
before(async () => { t = await start(); pid = t.ctx.patients[2]; });
after(async () => { await t.stop(); });

test("every screening form renders", async () => {
  const c = await t.login("therapist");
  for (const def of Object.values(INSTRUMENTS)) {
    const r = await c.get(`/ehr/patients/${pid}/measures/new?instrument=${def.key}`);
    assert.equal(r.status, 200, def.key);
    assert.ok(r.text.includes(def.title.replace(/&/g, "&amp;")), def.key);
  }
  const m = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(m.text, /Administer a screening/);
});

test("saving a high-risk C-SSRS flags the patient", async () => {
  const c = await t.login("therapist");
  const body = { instrument: "CSSRS", administered_on: "2026-11-01", q1: 1, q2: 1, q3: 1, q4: 1, q5: 0, q6: 0, q7: 0 };
  const r = await c.post(`/ehr/patients/${pid}/measures`, body);
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM assessments WHERE patient_id = ? AND instrument = 'CSSRS' ORDER BY id DESC").get(pid);
  assert.equal(row.severity, "high risk");
  assert.equal(row.flagged, 1);
  const m = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(m.text, /C-SSRS screen showed high risk/);
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, /Safety flag/);
});

test("inconsistent or invalid answers are rejected", async () => {
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/measures`, { instrument: "CSSRS", administered_on: "2026-11-01", q1: 0, q2: 0, q3: 1, q4: 0, q5: 0, q6: 0, q7: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /question 2 is No/);
  const audit = { instrument: "AUDIT", administered_on: "2026-11-01" };
  for (let i = 1; i <= 10; i++) audit[`q${i}`] = 0;
  audit.q9 = 1; // only 0/2/4 allowed
  assert.equal((await c.post(`/ehr/patients/${pid}/measures`, audit)).status, 400);
});

test("AUDIT saves with trend card", async () => {
  const c = await t.login("therapist");
  const body = { instrument: "AUDIT", administered_on: "2026-11-01" };
  [3, 2, 2, 1, 0, 0, 1, 0, 2, 2].forEach((v, i) => { body[`q${i + 1}`] = v; });
  const r = await c.post(`/ehr/patients/${pid}/measures`, body);
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM assessments WHERE patient_id = ? AND instrument = 'AUDIT'").get(pid);
  assert.equal(row.total_score, 13);
  assert.equal(row.severity, "hazardous");
  const m = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(m.text, /AUDIT scores over time/);
});
