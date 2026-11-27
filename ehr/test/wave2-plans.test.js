"use strict";
// Treatment-plan dropdowns, wave 2: objective unit + measurement, responsible people, review interval, level of care,
// signature declined reason, review participants and diagnosis changes.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

const PW = "Test-Password-123!";
let t, c;
before(async () => { t = await start(); c = await t.login("therapist"); });
after(async () => { await t.stop(); });

const last = (table) => t.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).get();
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const selected = (text, name) => {
  const m = text.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(m, `no <select name="${name}">`);
  const s = m[1].match(/<option value="([^"]*)" selected>/);
  return s ? unesc(s[1]) : null;
};
const otherBox = (text, name) => unesc((text.match(new RegExp(`name="${name}_other"[^>]*value="([^"]*)"`)) || [])[1] ?? "");
const checkedBoxes = (text, name) => [...text.matchAll(new RegExp(`<input type="checkbox" name="${name}" value="([^"]*)"\\s*checked>`, "g"))].map((m) => unesc(m[1]));
const inputValue = (text, id) => unesc((text.match(new RegExp(`id="${id}" name="[^"]*" value="([^"]*)"`)) || [])[1] ?? "");
const planIdFrom = (res) => Number(new URL(res.location, "http://x").searchParams.get("plan"));

function newPatient() {
  return Number(t.db.prepare("INSERT INTO patients (mrn, first_name, last_name, dob) VALUES (?, 'Wavetwo', 'Synthetic', '1990-01-01')")
    .run(`T-${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
}
async function draft(body = {}) {
  const pid = newPatient();
  const r = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: 90, ...body });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  return { pid, planId: planIdFrom(r) };
}
const objBody = (goalId, extra = {}) => ({ parent_id: goalId, text: "Complete 3 pleasant activities per week.", measure_type: "frequency",
  baseline_value: 0, target_value: 3, unit: "times per week", target_date: addDays(today(), 60), status: "not_started", ...extra });
const ivBody = (objectiveId, extra = {}) => ({ parent_id: objectiveId, kind: "professional", modality: "Behavioral activation",
  description: "Activity scheduling.", frequency: "Weekly", ...extra });
async function chain(planId, { obj = {}, iv = {} } = {}) {
  let r = await c.post(`/ehr/treatment-plans/${planId}/problems`, { title: "Depressed mood", behavioral_definition: "Low mood most days.", status: "active" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${planId}/goals`, { parent_id: last("plan_problems").id, client_words: "Feel better", goal_text: "Restore mood." });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${planId}/objectives`, objBody(last("plan_goals").id, obj));
  assert.equal(r.status, 302, r.text.slice(0, 800));
  const objective = last("plan_objectives");
  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objective.id, { responsible_people: "Client", ...iv }));
  assert.equal(r.status, 302, r.text.slice(0, 800));
  return { objective, intervention: last("plan_interventions") };
}
async function activePlan() {
  const { pid, planId } = await draft();
  const ch = await chain(planId);
  assert.equal((await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "clinician", password: PW })).status, 302);
  assert.equal((await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "client", signer_name: "Wavetwo Synthetic", method: "in_person", copy_offered: 1 })).status, 302);
  const r = await c.post(`/ehr/treatment-plans/${planId}/activate`);
  assert.equal(r.status, 302, r.text.slice(0, 500));
  return { pid, planId, ...ch };
}
const reviewBody = (objId, extra = {}) => ({ review_date: today(), client_perspective: "Going better", summary: "Progressing.",
  level_of_care_appropriate: "1", outcome: "continue", password: PW, [`status_${objId}`]: "progressing", [`current_${objId}`]: "2",
  [`action_${objId}`]: "continue", ...extra });

/* ---------------- 1-2. objective unit and measurement ---------------- */

test("objective form: unit, measurement method and frequency dropdowns", async () => {
  const { planId } = await draft();
  await chain(planId);
  const goal = last("plan_goals");
  const r = await c.get(`/ehr/treatment-plans/${planId}/objectives/new?parent=${goal.id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<select[^>]*name="unit"/);
  assert.match(r.text, /name="unit_other"/);
  assert.match(r.text, /<select[^>]*name="measurement_method"/);
  assert.match(r.text, /name="measurement_method_other"/);
  assert.match(r.text, /<select[^>]*name="measurement_frequency"/);
  assert.match(r.text, /Client log \/ diary/);
  assert.match(r.text, /At each plan review/);
});

test("objective: listed unit + method + frequency save and split back on edit", async () => {
  const { planId } = await draft();
  const { objective } = await chain(planId, { obj: { unit: "days per week", measurement_method: "Client log / diary", measurement_frequency: "Weekly" } });
  assert.equal(objective.unit, "days per week");
  assert.equal(objective.measurement_method, "Client log / diary, weekly");
  const r = await c.get(`/ehr/treatment-plans/${planId}/objectives/${objective.id}/edit`);
  assert.equal(r.status, 200);
  assert.equal(selected(r.text, "unit"), "days per week");
  assert.equal(selected(r.text, "measurement_method"), "Client log / diary");
  assert.equal(selected(r.text, "measurement_frequency"), "Weekly");
  const plan = await c.get(`/ehr/patients/${last("treatment_plans").patient_id}/treatment-plan?plan=${planId}`);
  assert.match(plan.text, /Client log \/ diary, weekly/);
});

test("objective: Other unit and Other method save; unmatched old text goes to the method Other box", async () => {
  const { planId } = await draft();
  const { objective } = await chain(planId, { obj: { unit: "__other", unit_other: "drinks per week",
    measurement_method: "__other", measurement_method_other: "Breathalyzer", measurement_frequency: "Every session" } });
  assert.equal(objective.unit, "drinks per week");
  assert.equal(objective.measurement_method, "Breathalyzer, every session");
  // Method only, frequency only
  let r = await c.post(`/ehr/treatment-plans/${planId}/objectives/${objective.id}`, objBody(objective.goal_id, { measurement_method: "Clinician observation" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(t.db.prepare("SELECT measurement_method FROM plan_objectives WHERE id = ?").get(objective.id).measurement_method, "Clinician observation");
  r = await c.post(`/ehr/treatment-plans/${planId}/objectives/${objective.id}`, objBody(objective.goal_id, { measurement_frequency: "Monthly" }));
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT measurement_method FROM plan_objectives WHERE id = ?").get(objective.id).measurement_method, "Monthly");
  r = await c.get(`/ehr/treatment-plans/${planId}/objectives/${objective.id}/edit`);
  assert.equal(selected(r.text, "measurement_frequency"), "Monthly");
  // Invalid frequency rejected
  r = await c.post(`/ehr/treatment-plans/${planId}/objectives/${objective.id}`, objBody(objective.goal_id, { measurement_frequency: "Hourly" }));
  assert.equal(r.status, 400);
  // Legacy plain text still saves and shows in the Other boxes
  r = await c.post(`/ehr/treatment-plans/${planId}/objectives/${objective.id}`, objBody(objective.goal_id, { unit: "per week", measurement_method: "PHQ-9 every 2 weeks in session" }));
  assert.equal(r.status, 302);
  const o = t.db.prepare("SELECT unit, measurement_method FROM plan_objectives WHERE id = ?").get(objective.id);
  assert.deepEqual({ ...o }, { unit: "per week", measurement_method: "PHQ-9 every 2 weeks in session" });
  r = await c.get(`/ehr/treatment-plans/${planId}/objectives/${objective.id}/edit`);
  assert.equal(selected(r.text, "unit"), "__other");
  assert.equal(otherBox(r.text, "unit"), "per week");
  assert.equal(selected(r.text, "measurement_method"), "__other");
  assert.equal(otherBox(r.text, "measurement_method"), "PHQ-9 every 2 weeks in session");
  assert.equal(selected(r.text, "measurement_frequency"), "");
});

/* ---------------- 3. responsible people ---------------- */

test("intervention: responsible people checkboxes + Other text, joined with '; ' and pre-checked on edit", async () => {
  const { planId } = await draft();
  const { objective } = await chain(planId);
  let r = await c.get(`/ehr/treatment-plans/${planId}/interventions/new?parent=${objective.id}`);
  assert.match(r.text, /<input type="checkbox" name="responsible_people" value="Parent \/ guardian"/);
  assert.match(r.text, /id="responsible_text" name="responsible_text"/);
  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objective.id, { responsible_people: ["Client", "Sponsor", "Not a real option"], responsible_text: "Aunt Maria" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const iv = last("plan_interventions");
  assert.equal(iv.responsible_text, "Client; Sponsor; Aunt Maria");
  r = await c.get(`/ehr/treatment-plans/${planId}/interventions/${iv.id}/edit`);
  assert.deepEqual(checkedBoxes(r.text, "responsible_people"), ["Client", "Sponsor"]);
  assert.equal(inputValue(r.text, "responsible_text"), "Aunt Maria");
  // Nobody responsible is still an error
  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objective.id, {}));
  assert.equal(r.status, 400);
  // Legacy plain text post
  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objective.id, { responsible_text: "Client; partner" }));
  assert.equal(r.status, 302);
  const iv2 = last("plan_interventions");
  assert.equal(iv2.responsible_text, "Client; partner");
  r = await c.get(`/ehr/treatment-plans/${planId}/interventions/${iv2.id}/edit`);
  assert.deepEqual(checkedBoxes(r.text, "responsible_people"), ["Client"]);
  assert.equal(inputValue(r.text, "responsible_text"), "partner");
});

/* ---------------- 4. review interval ---------------- */

test("review interval: dropdown on new plan and plan details; Other days validated", async () => {
  const pid = newPatient();
  let r = await c.get(`/ehr/patients/${pid}/treatment-plan/new`);
  assert.match(r.text, /<select[^>]*name="review_interval_days"/);
  assert.equal(selected(r.text, "review_interval_days"), "90");
  assert.match(r.text, /name="review_interval_days_other"/);
  r = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: "__other", review_interval_days_other: "3" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: "__other", review_interval_days_other: "abc" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: "__other", review_interval_days_other: "45" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const planId = planIdFrom(r);
  assert.equal(t.db.prepare("SELECT review_interval_days FROM treatment_plans WHERE id = ?").get(planId).review_interval_days, 45);
  r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.equal(selected(r.text, "review_interval_days"), "__other");
  assert.equal(otherBox(r.text, "review_interval_days"), "45");
  r = await c.post(`/ehr/treatment-plans/${planId}/edit`, { plan_type: "mental_health", review_interval_days: "180" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT review_interval_days FROM treatment_plans WHERE id = ?").get(planId).review_interval_days, 180);
  r = await c.post(`/ehr/treatment-plans/${planId}/edit`, { plan_type: "mental_health", review_interval_days: "__other", review_interval_days_other: "500" });
  assert.equal(r.status, 400);
  assert.equal(otherBox(r.text, "review_interval_days"), "500");
  r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.equal(selected(r.text, "review_interval_days"), "180");
});

/* ---------------- 5. level of care ---------------- */

test("plan details: level of care / program dropdown with Other; shown on plan and print view", async () => {
  const { pid, planId } = await draft();
  let r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.match(r.text, /<select[^>]*name="level_of_care"/);
  assert.match(r.text, /Intensive outpatient \(IOP\)/);
  r = await c.post(`/ehr/treatment-plans/${planId}/edit`, { plan_type: "mental_health", review_interval_days: 90, level_of_care: "Intensive outpatient (IOP)" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT level_of_care FROM treatment_plans WHERE id = ?").get(planId).level_of_care, "Intensive outpatient (IOP)");
  r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.equal(selected(r.text, "level_of_care"), "Intensive outpatient (IOP)");
  r = await c.post(`/ehr/treatment-plans/${planId}/edit`, { plan_type: "mental_health", review_interval_days: 90, level_of_care: "__other", level_of_care_other: "Drug court program" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT level_of_care FROM treatment_plans WHERE id = ?").get(planId).level_of_care, "Drug court program");
  r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.equal(otherBox(r.text, "level_of_care"), "Drug court program");
  r = await c.get(`/ehr/patients/${pid}/treatment-plan?plan=${planId}`);
  assert.match(r.text, /Drug court program/);
  r = await c.get(`/ehr/treatment-plans/${planId}/print`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Drug court program/);
});

/* ---------------- 6. signature declined reason ---------------- */

test("signature declined reason: dropdown for client and guardian; listed and Other values save", async () => {
  const { planId } = await draft();
  await chain(planId);
  let r = await c.get(`/ehr/treatment-plans/${planId}/sign`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<select id="client_reason" name="declined_reason"/);
  assert.match(r.text, /<select id="g_reason" name="declined_reason"/);
  assert.match(r.text, /Unable to sign due to symptoms or capacity/);
  r = await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "client", signer_name: "Wavetwo Synthetic", declined: 1 });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "client", signer_name: "Wavetwo Synthetic", declined: 1, declined_reason: "__other", declined_reason_other: "" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "client", signer_name: "Wavetwo Synthetic", declined: 1, declined_reason: "Client refused to sign" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(t.db.prepare("SELECT declined_reason FROM plan_signatures WHERE plan_id = ? AND role = 'client'").get(planId).declined_reason, "Client refused to sign");
  r = await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "guardian", signer_name: "Pat Example (mother)", declined: 1, declined_reason: "__other", declined_reason_other: "Out of state this month" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(t.db.prepare("SELECT declined_reason FROM plan_signatures WHERE plan_id = ? AND role = 'guardian'").get(planId).declined_reason, "Out of state this month");
  r = await c.get(`/ehr/treatment-plans/${planId}/sign`);
  assert.match(r.text, /Reason: Out of state this month/);
});

/* ---------------- 7-8. review participants and diagnosis changes ---------------- */

test("review form: participant checkboxes, names box prefilled with clinician, diagnosis change select", async () => {
  const a = await activePlan();
  const r = await c.get(`/ehr/treatment-plans/${a.planId}/review`);
  assert.equal(r.status, 200);
  assert.deepEqual(checkedBoxes(r.text, "participant_list"), ["Client"]);
  assert.match(r.text, /<input type="checkbox" name="participant_list" value="Prescriber"/);
  assert.ok(inputValue(r.text, "participants").length > 0, "clinician name prefilled");
  assert.match(r.text, /<select[^>]*name="diagnosis_change_status"/);
  assert.match(r.text, /Changes \(describe below\)/);
});

test("review: participants join, No changes stores None, Changes requires text", async () => {
  const a = await activePlan();
  const oid = a.objective.id;
  let r = await c.post(`/ehr/treatment-plans/${a.planId}/review`, reviewBody(oid, { participant_list: ["Client", "Prescriber"], participants: "Dr. Example",
    diagnosis_change_status: "changes", diagnosis_changes: "" }));
  assert.equal(r.status, 400);
  assert.deepEqual(checkedBoxes(r.text, "participant_list"), ["Client", "Prescriber"]);
  assert.equal(inputValue(r.text, "participants"), "Dr. Example");
  r = await c.post(`/ehr/treatment-plans/${a.planId}/review`, reviewBody(oid, { participant_list: ["Client", "Prescriber"], participants: "Dr. Example",
    diagnosis_change_status: "none" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  let rev = last("plan_reviews");
  assert.equal(rev.participants, "Client; Prescriber; Dr. Example");
  assert.equal(rev.diagnosis_changes, "None");

  const b = await activePlan();
  r = await c.post(`/ehr/treatment-plans/${b.planId}/review`, reviewBody(b.objective.id, { participant_list: "Family member",
    diagnosis_change_status: "changes", diagnosis_changes: "Added F41.1 generalized anxiety." }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  rev = last("plan_reviews");
  assert.equal(rev.participants, "Family member");
  assert.equal(rev.diagnosis_changes, "Added F41.1 generalized anxiety.");
  r = await c.post(`/ehr/treatment-plans/${b.planId}/review`, reviewBody(b.objective.id, { diagnosis_change_status: "bogus" }));
  assert.ok([400, 409].includes(r.status));
});

test("review: legacy plain-text participants and diagnosis changes still save", async () => {
  const a = await activePlan();
  const r = await c.post(`/ehr/treatment-plans/${a.planId}/review`, reviewBody(a.objective.id, { participants: "Client; clinician", diagnosis_changes: "None" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const rev = last("plan_reviews");
  assert.equal(rev.participants, "Client; clinician");
  assert.equal(rev.diagnosis_changes, "None");
});

/* ---------------- copy / revision keeps values ---------------- */

test("revising an active plan copies the new dropdown values", async () => {
  const a = await activePlan();
  t.db.prepare("UPDATE plan_objectives SET measurement_method = 'Client self-report, weekly', unit = 'times per week' WHERE id = ?").run(a.objective.id);
  t.db.prepare("UPDATE plan_interventions SET responsible_text = 'Client; Sponsor; Joe' WHERE id = ?").run(a.intervention.id);
  t.db.prepare("UPDATE treatment_plans SET level_of_care = 'Residential' WHERE id = ?").run(a.planId);
  const r = await c.post(`/ehr/treatment-plans/${a.planId}/revise`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const v2 = planIdFrom(r);
  assert.notEqual(v2, a.planId);
  assert.equal(t.db.prepare("SELECT level_of_care FROM treatment_plans WHERE id = ?").get(v2).level_of_care, "Residential");
  const o = last("plan_objectives"), iv = last("plan_interventions");
  assert.equal(o.measurement_method, "Client self-report, weekly");
  assert.equal(iv.responsible_text, "Client; Sponsor; Joe");
  let e = await c.get(`/ehr/treatment-plans/${v2}/objectives/${o.id}/edit`);
  assert.equal(selected(e.text, "measurement_method"), "Client self-report");
  assert.equal(selected(e.text, "measurement_frequency"), "Weekly");
  e = await c.get(`/ehr/treatment-plans/${v2}/interventions/${iv.id}/edit`);
  assert.deepEqual(checkedBoxes(e.text, "responsible_people"), ["Client", "Sponsor"]);
  assert.equal(inputValue(e.text, "responsible_text"), "Joe");
});
