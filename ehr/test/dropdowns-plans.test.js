"use strict";
// Treatment-plan dropdowns: intervention frequency + session length, intervention duration, plan estimated duration.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

let t, c;
before(async () => { t = await start(); c = await t.login("therapist"); });
after(async () => { await t.stop(); });

const last = (table) => t.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).get();
const selected = (text, name) => {
  const m = text.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(m, `no <select name="${name}">`);
  const s = m[1].match(/<option value="([^"]*)" selected>/);
  return s ? s[1].replace(/&amp;/g, "&") : null;
};
const otherBox = (text, name) => (text.match(new RegExp(`name="${name}_other"[^>]*value="([^"]*)"`)) || [])[1];

async function setup() {
  const pid = Number(t.db.prepare("INSERT INTO patients (mrn, first_name, last_name, dob) VALUES (?, 'Dropdown', 'Synthetic', '1990-01-01')")
    .run(`T-${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  let r = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: 90 });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const planId = Number(new URL(r.location, "http://x").searchParams.get("plan"));
  r = await c.post(`/ehr/treatment-plans/${planId}/problems`, { title: "Depressed mood", behavioral_definition: "Low mood most days.", status: "active" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${planId}/goals`, { parent_id: last("plan_problems").id, client_words: "Feel better", goal_text: "Restore mood." });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${planId}/objectives`, { parent_id: last("plan_goals").id, text: "Complete 3 pleasant activities per week.",
    measure_type: "frequency", baseline_value: 0, target_value: 3, unit: "per week", target_date: addDays(today(), 60), status: "not_started" });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  return { pid, planId, objectiveId: last("plan_objectives").id };
}
const ivBody = (objectiveId, extra) => ({ parent_id: objectiveId, kind: "professional", modality: "Behavioral activation",
  description: "Activity scheduling.", responsible_text: "Client", ...extra });

test("intervention form shows frequency, session length and duration dropdowns", async () => {
  const { planId, objectiveId } = await setup();
  const r = await c.get(`/ehr/treatment-plans/${planId}/interventions/new?parent=${objectiveId}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<select[^>]*name="frequency"/);
  assert.match(r.text, /<select[^>]*name="session_length"/);
  assert.match(r.text, /<select[^>]*name="duration"/);
  assert.match(r.text, /name="frequency_other"/);
  assert.match(r.text, /53\+ minutes \(90837\)/);
});

test("frequency + session length combine, and editing pre-selects both", async () => {
  const { planId, objectiveId } = await setup();
  let r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objectiveId, { frequency: "Weekly", session_length: "53+ minutes (90837)", duration: "12 weeks" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const iv = last("plan_interventions");
  assert.equal(iv.frequency, "Weekly, 53+ minutes (90837)");
  assert.equal(iv.duration, "12 weeks");
  r = await c.get(`/ehr/treatment-plans/${planId}/interventions/${iv.id}/edit`);
  assert.equal(r.status, 200);
  assert.equal(selected(r.text, "frequency"), "Weekly");
  assert.equal(selected(r.text, "session_length"), "53+ minutes (90837)");
  assert.equal(selected(r.text, "duration"), "12 weeks");
  // The plan view and print view show the stored string.
  const view = await c.get(`/ehr/treatment-plans/${planId}/print`);
  assert.equal(view.status, 200);
  assert.match(view.text, /Weekly, 53\+ minutes \(90837\), 12 weeks/);
});

test("frequency alone, Other text, Other duration, and legacy free text", async () => {
  const { planId, objectiveId } = await setup();
  let r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objectiveId, { frequency: "Weekly" }));
  assert.equal(r.status, 302);
  assert.equal(last("plan_interventions").frequency, "Weekly");

  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objectiveId, { frequency: "__other", frequency_other: "Twice a month",
    session_length: "38-52 minutes (90834)", duration: "__other", duration_other: "20 sessions" }));
  assert.equal(r.status, 302);
  let iv = last("plan_interventions");
  assert.equal(iv.frequency, "Twice a month, 38-52 minutes (90834)");
  assert.equal(iv.duration, "20 sessions");
  r = await c.get(`/ehr/treatment-plans/${planId}/interventions/${iv.id}/edit`);
  assert.equal(selected(r.text, "frequency"), "__other");
  assert.equal(otherBox(r.text, "frequency"), "Twice a month");
  assert.equal(selected(r.text, "session_length"), "38-52 minutes (90834)");
  assert.equal(selected(r.text, "duration"), "__other");
  assert.equal(otherBox(r.text, "duration"), "20 sessions");

  // An old free-text value keeps its whole text in the frequency Other box.
  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, ivBody(objectiveId, { frequency: "Weekly, 53 min" }));
  assert.equal(r.status, 302);
  iv = last("plan_interventions");
  assert.equal(iv.frequency, "Weekly, 53 min");
  r = await c.get(`/ehr/treatment-plans/${planId}/interventions/${iv.id}/edit`);
  assert.equal(selected(r.text, "frequency"), "__other");
  assert.equal(otherBox(r.text, "frequency"), "Weekly, 53 min");
  assert.equal(selected(r.text, "session_length"), "");
});

test("plan header estimated duration is a dropdown and saves", async () => {
  const { planId } = await setup();
  let r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<select[^>]*name="estimated_duration"/);
  r = await c.post(`/ehr/treatment-plans/${planId}/edit`, { plan_type: "mental_health", review_interval_days: 90, estimated_duration: "6 months" });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(t.db.prepare("SELECT estimated_duration FROM treatment_plans WHERE id = ?").get(planId).estimated_duration, "6 months");
  r = await c.get(`/ehr/treatment-plans/${planId}/edit`);
  assert.equal(selected(r.text, "estimated_duration"), "6 months");
  r = await c.post(`/ehr/treatment-plans/${planId}/edit`, { plan_type: "mental_health", review_interval_days: 90, estimated_duration: "__other", estimated_duration_other: "16-20 sessions" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT estimated_duration FROM treatment_plans WHERE id = ?").get(planId).estimated_duration, "16-20 sessions");
});
