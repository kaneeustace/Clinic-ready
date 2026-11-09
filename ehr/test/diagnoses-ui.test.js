"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t, pid;
before(async () => { t = await start(); pid = t.ctx.patients[4]; });
after(async () => { await t.stop(); });

const planDx = (id) => JSON.parse(t.db.prepare("SELECT diagnoses FROM treatment_plans WHERE id = ?").get(id).diagnoses || "[]");

test("chart banner shows active diagnoses to clinical staff, not front desk or billing", async () => {
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, status, is_primary) VALUES (?, 'F43.10', 'Post-traumatic stress disorder, unspecified', 'active', 1)").run(pid);
  for (const role of ["therapist", "prescriber", "admin"]) {
    const r = await (await t.login(role)).get(`/ehr/patients/${pid}`);
    assert.match(r.text, /chart-head__dx/, role);
    assert.match(r.text, /F43\.10/, role);
  }
  for (const role of ["frontdesk", "billing"]) {
    const r = await (await t.login(role)).get(`/ehr/patients/${pid}`);
    assert.doesNotMatch(r.text, /chart-head__dx/, role);
  }
  // Banner appears on every chart tab
  const c = await t.login("therapist");
  assert.match((await c.get(`/ehr/patients/${pid}/measures`)).text, /F43\.10/);
});

test("treatment plan diagnosis dropdown: add from problem list, add common code, primary, remove", async () => {
  const c = await t.login("therapist");
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status IN ('draft','active')").run(pid);
  const created = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: 90 });
  assert.equal(created.status, 302, created.text.slice(0, 300));
  const plan = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'draft'").get(pid);
  const page = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(page.text, /Add a diagnosis/);
  assert.match(page.text, /Common behavioral health diagnoses/);

  // Snapshot includes the patient's active diagnoses; remove them all, then re-add from the problem list
  assert.ok(planDx(plan.id).some((d) => d.code === "F43.10"));
  for (const d of planDx(plan.id)) await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/remove`, { code: d.code });
  assert.equal(planDx(plan.id).length, 0);
  await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/add`, { code: "F43.10" });
  assert.deepEqual(planDx(plan.id).map((d) => [d.code, d.primary]), [["F43.10", 1]]);

  // Add a common code not on the problem list: lands on the plan AND the problem list
  await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/add`, { code: "F41.1", primary: "1" });
  assert.deepEqual(planDx(plan.id).map((d) => [d.code, d.primary]), [["F41.1", 1], ["F43.10", 0]]);
  assert.ok(t.db.prepare("SELECT 1 FROM diagnoses WHERE patient_id = ? AND icd10_code = 'F41.1' AND status = 'active'").get(pid));

  await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/primary`, { code: "F43.10" });
  assert.equal(planDx(plan.id)[0].code, "F43.10");

  // Unknown code and duplicate are rejected without changes
  await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/add`, { code: "Z99.999" });
  await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/add`, { code: "F41.1" });
  assert.equal(planDx(plan.id).length, 2);

  // A diagnosis linked to a problem can't be removed; problem dropdown offers plan diagnoses
  const pr = await c.post(`/ehr/treatment-plans/${plan.id}/problems`, { title: "Trauma symptoms", icd10_code: "F43.10", priority: "high" });
  assert.equal(pr.status, 302, pr.text.slice(0, 400));
  await c.post(`/ehr/treatment-plans/${plan.id}/diagnoses/remove`, { code: "F43.10" });
  assert.ok(planDx(plan.id).some((d) => d.code === "F43.10"));
  const form = await c.get(`/ehr/treatment-plans/${plan.id}/problems/new`);
  assert.match(form.text, /<option value="F41\.1"/);

  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'treatment_plan' AND entity_id = ? AND detail LIKE 'diagnosis%'").get(plan.id));
});

test("front desk cannot change plan diagnoses", async () => {
  const plan = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'draft'").get(pid);
  const r = await (await t.login("frontdesk")).post(`/ehr/treatment-plans/${plan.id}/diagnoses/add`, { code: "F32.9" });
  assert.equal(r.status, 403);
});
