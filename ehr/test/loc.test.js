"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

let t, pid;
before(async () => {
  t = await start();
  pid = t.ctx.patients[7] || t.ctx.patients[t.ctx.patients.length - 1];
  t.db.prepare("DELETE FROM loc_episodes WHERE patient_id = ?").run(pid);
  t.db.prepare("DELETE FROM loc_authorizations WHERE patient_id = ?").run(pid);
});
after(async () => { await t.stop(); });
const episodes = () => t.db.prepare("SELECT * FROM loc_episodes WHERE patient_id = ? ORDER BY start_date, id").all(pid);

test("admit, step down (closes the old level the day the new one starts), banner pill, discharge", async () => {
  const c = await t.login("therapist");
  let tab = await c.get(`/ehr/patients/${pid}/level-of-care`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Admit to a level of care/);

  const d0 = addDays(today(), -10);
  let r = await c.post(`/ehr/patients/${pid}/level-of-care`, { level: "php", asam_level: "2.5", start_date: d0, reason: "Needs daily structure." });
  assert.equal(r.status, 302, r.text.slice(0, 400));
  // Changing level requires a reason
  r = await c.post(`/ehr/patients/${pid}/level-of-care`, { level: "iop", asam_level: "2.1", start_date: today() });
  assert.equal(r.status, 400);
  assert.match(r.text, /Say why the level is changing/);
  // Can't start before the current level
  r = await c.post(`/ehr/patients/${pid}/level-of-care`, { level: "iop", start_date: addDays(d0, -1), change_reason: "step_down" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/level-of-care`, { level: "iop", asam_level: "2.1", start_date: today(), change_reason: "step_down", reason: "Met PHP goals." });
  assert.equal(r.status, 302);
  const eps = episodes();
  assert.equal(eps.length, 2);
  assert.deepEqual([eps[0].level, eps[0].end_date, eps[0].end_reason], ["php", today(), "step_down"]);
  assert.equal(eps[1].end_date, null);

  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, /LOC: IOP \(ASAM 2\.1\) · day 1/);
  tab = await c.get(`/ehr/patients/${pid}/level-of-care`);
  assert.match(tab.text, /Intensive outpatient \(IOP\)/);
  assert.match(tab.text, /Step down/);

  r = await c.post(`/ehr/patients/${pid}/level-of-care/${eps[1].id}/discharge`, { end_date: today() });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/level-of-care/${eps[1].id}/discharge`, { end_date: today(), end_reason: "completed" });
  assert.equal(r.status, 302);
  assert.equal(episodes()[1].end_reason, "completed");
  assert.doesNotMatch((await c.get(`/ehr/patients/${pid}`)).text, /LOC: /);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'level_of_care' AND patient_id = ? AND action = 'update'").get(pid));
});

test("authorizations: days counted automatically, review-due alerts on census and dashboard", async () => {
  const c = await t.login("therapist");
  const start = addDays(today(), -4);
  await c.post(`/ehr/patients/${pid}/level-of-care`, { level: "residential", asam_level: "3.5", start_date: start, reason: "Relapse." });
  let r = await c.post(`/ehr/patients/${pid}/authorizations`, { level: "residential", status: "approved", unit_type: "days", units_approved: "x" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/authorizations`, { level: "residential", status: "approved", unit_type: "days", units_approved: "7",
    payer: "Test Payer", auth_number: "A-1", start_date: start, end_date: addDays(today(), 2), next_review_date: addDays(today(), 1) });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const tab = await c.get(`/ehr/patients/${pid}/level-of-care`);
  assert.match(tab.text, /5 \/ 7 days/);
  assert.match(tab.text, /Review due/);
  assert.match(tab.text, /2 days left/);

  const census = await c.get("/ehr/census");
  assert.equal(census.status, 200);
  assert.match(census.text, /Utilization reviews/);
  assert.match(census.text, /Residential/);
  const filtered = await c.get("/ehr/census?level=residential");
  assert.match(filtered.text, /Test Payer|5\/7 days/);

  // Clinician's dashboard lists UR due for their clients
  t.db.prepare("UPDATE patients SET primary_clinician_id = ? WHERE id = ?").run(t.ctx.users.therapist, pid);
  assert.match((await c.get("/ehr")).text, /Utilization reviews due/);

  // Billing staff can update an authorization but can't change the level of care
  const a = t.db.prepare("SELECT * FROM loc_authorizations WHERE patient_id = ?").get(pid);
  const billing = await t.login("billing");
  r = await billing.post(`/ehr/patients/${pid}/authorizations/${a.id}/edit`, { level: "residential", status: "approved", unit_type: "days",
    units_approved: "14", start_date: start, end_date: addDays(today(), 9), next_review_date: addDays(today(), 7) });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT units_approved FROM loc_authorizations WHERE id = ?").get(a.id).units_approved, 14);
  assert.equal((await billing.post(`/ehr/patients/${pid}/level-of-care`, { level: "op", start_date: today(), change_reason: "step_down" })).status, 403);
});

test("ASAM recommendation that differs from the current level is flagged", async () => {
  const c = await t.login("therapist");
  t.db.prepare(`INSERT INTO notes (patient_id, author_id, type, format, status, service_date, signed_at, content)
    VALUES (?, ?, 'asam', 'asam', 'signed', ?, datetime('now'), ?)`).run(pid, t.ctx.users.therapist, today(), JSON.stringify({ indicated_level: "2.1" }));
  const tab = await c.get(`/ehr/patients/${pid}/level-of-care`);
  assert.match(tab.text, /recommends <strong>ASAM 2\.1<\/strong>, but the client is at ASAM 3\.5/);
});

test("correcting an entry: an earlier level can't be left open while another is current", async () => {
  const c = await t.login("therapist");
  const old = episodes()[0];
  const r = await c.post(`/ehr/patients/${pid}/level-of-care/${old.id}/edit`, { level: old.level, start_date: old.start_date, end_date: "" });
  assert.equal(r.status, 400);
  assert.match(r.text, /needs an end date/);
});
