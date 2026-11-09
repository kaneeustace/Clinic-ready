"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { scoreInstrument, INSTRUMENTS } = require("../src/routes/clinical");
const { progressPct } = require("../src/routes/plans");
const { migrateLegacyGoals } = require("../src/db");
const { today, addDays } = require("../src/views");

const PW = "Test-Password-123!";
let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

/* ---------------- helpers ---------------- */

function newPatient({ name = "Plancase", dob = "1990-01-01", clinician = null } = {}) {
  const id = Number(t.db.prepare(`INSERT INTO patients (mrn, first_name, last_name, dob, primary_clinician_id) VALUES (?, ?, 'Synthetic', ?, ?)`)
    .run(`T-${Math.random().toString(36).slice(2, 10)}`, name, dob, clinician).lastInsertRowid);
  return id;
}
function addDx(pid, code, description, primary = 0) {
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, status, is_primary) VALUES (?, ?, ?, 'active', ?)").run(pid, code, description, primary);
}
function addScore(pid, instrument, total, daysAgo = 0) {
  const n = INSTRUMENTS[instrument].items.length;
  const r = new Array(n).fill(0);
  let left = total;
  for (let i = 0; left > 0; i = (i + 1) % n) { if (instrument === "PHQ9" && i === 8) continue; if (r[i] < 3) { r[i]++; left--; } }
  const s = scoreInstrument(instrument, r);
  t.db.prepare(`INSERT INTO assessments (patient_id, instrument, responses, total_score, severity, flagged, administered_on)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(pid, instrument, JSON.stringify(r), s.total, s.severity, s.flagged, addDays(today(), -daysAgo));
}
const planIdFrom = (res) => Number(new URL(res.location, "http://x").searchParams.get("plan"));
const getPlan = (id) => t.db.prepare("SELECT * FROM treatment_plans WHERE id = ?").get(id);
const last = (table) => t.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).get();

async function createDraft(c, pid, body = {}) {
  const r = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: 90, ...body });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  return planIdFrom(r);
}
const objective = (extra = {}) => ({ text: "Complete 3 planned pleasant activities per week.", measure_type: "frequency", baseline_value: 0,
  target_value: 3, unit: "per week", target_date: addDays(today(), 60), status: "not_started", ...extra });
/** Adds problem → goal → objective → intervention; returns ids. */
async function addChain(c, planId, { obj = {}, icd = "" } = {}) {
  let r = await c.post(`/ehr/treatment-plans/${planId}/problems`, { title: "Depressed mood", behavioral_definition: "Low mood most days.", icd10_code: icd, status: "active" });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const problem = last("plan_problems");
  r = await c.post(`/ehr/treatment-plans/${planId}/goals`, { parent_id: problem.id, client_words: "Feel like me again", goal_text: "Restore mood and routine." });
  assert.equal(r.status, 302);
  const goal = last("plan_goals");
  r = await c.post(`/ehr/treatment-plans/${planId}/objectives`, { parent_id: goal.id, ...objective(obj) });
  assert.equal(r.status, 302, r.text.slice(0, 800));
  const obj1 = last("plan_objectives");
  r = await c.post(`/ehr/treatment-plans/${planId}/interventions`, { parent_id: obj1.id, kind: "professional", modality: "Behavioral activation",
    description: "Activity scheduling.", frequency: "Weekly, 53 min", duration: "12 weeks", responsible_user_id: c.userId });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  return { problem, goal, objective: obj1, intervention: last("plan_interventions") };
}
async function signClinicianAndClient(c, planId) {
  let r = await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "clinician", password: PW });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  r = await c.post(`/ehr/treatment-plans/${planId}/signatures`, { role: "client", signer_name: "Plancase Synthetic", method: "in_person", copy_offered: 1 });
  assert.equal(r.status, 302, r.text.slice(0, 300));
}
async function activePlan(c, pid) {
  const id = await createDraft(c, pid);
  const chain = await addChain(c, id);
  await signClinicianAndClient(c, id);
  const r = await c.post(`/ehr/treatment-plans/${id}/activate`);
  assert.equal(r.status, 302, r.text.slice(0, 500));
  return { id, ...chain };
}

/* ---------------- drafts ---------------- */

test("progress % math is clamped and direction-agnostic", () => {
  assert.equal(progressPct(18, 12, 9), 67);
  assert.equal(progressPct(18, 6, 9), 100);
  assert.equal(progressPct(18, 20, 9), 0);
  assert.equal(progressPct(0, 2, 4), 50);   // increase
  assert.equal(progressPct(5, 5, 5), null);
  assert.equal(progressPct(null, 2, 4), null);
});

test("draft creation snapshots active diagnoses (primary first); one draft per patient", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  addDx(pid, "F41.1", "Generalized anxiety disorder", 0);
  addDx(pid, "F32.1", "Major depressive disorder, single episode, moderate", 1);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, status) VALUES (?, 'F43.20', 'Old', 'resolved')").run(pid);
  const form = await c.get(`/ehr/patients/${pid}/treatment-plan/new`);
  assert.equal(form.status, 200);
  assert.match(form.text, /F32\.1/);
  const id = await createDraft(c, pid, { review_interval_days: 30 });
  const plan = getPlan(id);
  assert.equal(plan.status, "draft");
  assert.equal(plan.version, 1);
  assert.equal(plan.review_interval_days, 30);
  const dx = JSON.parse(plan.diagnoses);
  assert.deepEqual(dx.map((d) => d.code), ["F32.1", "F41.1"]);
  assert.equal(dx[0].primary, 1);
  // second draft is refused (redirect to the existing one)
  const again = await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: 90 });
  assert.equal(planIdFrom(again), id);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM treatment_plans WHERE patient_id = ?").get(pid).n, 1);
  // invalid header input
  const pid2 = newPatient();
  assert.equal((await c.post(`/ehr/patients/${pid2}/treatment-plan`, { plan_type: "bogus", review_interval_days: 90 })).status, 400);
  assert.equal((await c.post(`/ehr/patients/${pid2}/treatment-plan`, { plan_type: "sud", review_interval_days: 3 })).status, 400);
  const view = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(view.text, /Draft, not in effect/);
  assert.match(view.text, /Major depressive disorder/);
});

test("header fields: validation, SUD level-of-care reason, safety plan must belong to patient", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const id = await createDraft(c, pid, { plan_type: "co_occurring" });
  assert.equal((await c.get(`/ehr/treatment-plans/${id}/edit`)).status, 200);
  const base = { plan_type: "co_occurring", review_interval_days: 30, client_vision: "I want my life back." };
  let r = await c.post(`/ehr/treatment-plans/${id}/edit`, { ...base, start_date: "2026-02-31" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${id}/edit`, { ...base, loc_indicated: "2.1", loc_adjusted: "1.5" });
  assert.equal(r.status, 400);
  assert.match(r.text, /differs from the level indicated/);
  r = await c.post(`/ehr/treatment-plans/${id}/edit`, { ...base, loc_indicated: "9.9" });
  assert.equal(r.status, 400);
  const other = newPatient();
  const sp = Number(t.db.prepare("INSERT INTO notes (patient_id, author_id, type, format) VALUES (?, ?, 'safety_plan', 'safety_plan')").run(other, c.userId).lastInsertRowid);
  r = await c.post(`/ehr/treatment-plans/${id}/edit`, { ...base, safety_plan_note_id: sp });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${id}/edit`, { ...base, loc_indicated: "2.1", loc_adjusted: "1.5", loc_reason: "Client declined IOP.", mat_plan: "<script>x</script>" });
  assert.equal(r.status, 302);
  const plan = getPlan(id);
  assert.equal(plan.loc_adjusted, "1.5");
  assert.equal(plan.client_vision, "I want my life back.");
  const view = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(view.text, /42 CFR Part 2/);
  assert.match(view.text, /“I want my life back\.”/);
  assert.doesNotMatch(view.text, /<script>x<\/script>/);
  assert.match(view.text, /&lt;script&gt;x/);
});

test("tree CRUD with validation, soft warnings, reorder and cascade delete", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  addDx(pid, "F32.1", "MDD", 1);
  const id = await createDraft(c, pid);
  // problem validation
  let r = await c.post(`/ehr/treatment-plans/${id}/problems`, { title: "" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${id}/problems`, { title: "Mood", icd10_code: "Z99.9" });
  assert.equal(r.status, 400);
  assert.match(r.text, /one of the plan&#39;s diagnoses/);
  const chain = await addChain(c, id, { icd: "F32.1" });
  assert.equal(chain.problem.icd10_code, "F32.1");
  // goal / objective parent must belong to this plan
  const otherPlan = await createDraft(c, newPatient());
  assert.equal((await c.post(`/ehr/treatment-plans/${otherPlan}/goals`, { parent_id: chain.problem.id, goal_text: "x" })).status, 404);
  assert.equal((await c.get(`/ehr/treatment-plans/${otherPlan}/objectives/${chain.objective.id}/edit`)).status, 404);
  // objective validation
  const ob = (extra) => c.post(`/ehr/treatment-plans/${id}/objectives`, { parent_id: chain.goal.id, ...objective(extra) });
  assert.equal((await ob({ text: "" })).status, 400);
  assert.equal((await ob({ baseline_value: "abc" })).status, 400);
  assert.equal((await ob({ target_date: "" })).status, 400);
  assert.equal((await ob({ target_date: "2026-13-01" })).status, 400);
  assert.equal((await ob({ measure_type: "bogus" })).status, 400);
  assert.equal((await ob({ status: "bogus" })).status, 400);
  assert.equal((await ob({ baseline_value: "" })).status, 400);
  r = await ob({ direction: "decrease", baseline_value: 2, target_value: 5 });
  assert.equal(r.status, 400);
  assert.match(r.text, /target must be lower/);
  r = await ob({ measure_type: "instrument", instrument: "PHQ9", baseline_value: 30, target_value: 5 });
  assert.equal(r.status, 400);
  assert.match(r.text, /between 0 and 27/);
  assert.equal((await ob({ measure_type: "instrument", instrument: "MDQ", baseline_value: 5, target_value: 1 })).status, 400);
  // vague objective: saved with a soft warning
  r = await ob({ text: "Client will understand triggers and feel better.", measure_type: "attainment", baseline_value: "", target_value: "" });
  assert.equal(r.status, 302);
  const vague = last("plan_objectives");
  assert.equal(vague.direction, "achieve");
  let view = await c.get(`/ehr/patients/${pid}/treatment-plan?plan=${id}`);
  assert.match(view.text, /hard-to-measure wording/);
  // intervention validation: responsible must be active clinical staff
  const iv = (extra) => c.post(`/ehr/treatment-plans/${id}/interventions`, { parent_id: vague.id, kind: "professional", description: "CBT.", frequency: "Weekly", ...extra });
  assert.equal((await iv({ responsible_user_id: t.ctx.users.frontdesk })).status, 400);
  const inactive = Number(t.db.prepare("INSERT INTO users (email, name, role, password_hash, active) VALUES (?, 'Gone', 'clinician', 'x', 0)").run(`gone${Date.now()}@example.com`).lastInsertRowid);
  assert.equal((await iv({ responsible_user_id: inactive })).status, 400);
  assert.equal((await iv({})).status, 400);
  assert.equal((await iv({ kind: "bogus", responsible_text: "Client" })).status, 400);
  assert.equal((await iv({ description: "", responsible_text: "Client" })).status, 400);
  assert.equal((await iv({ kind: "self_directed", responsible_text: "Client" })).status, 302);
  // edit objective
  r = await c.post(`/ehr/treatment-plans/${id}/objectives/${vague.id}`, objective({ text: "Do 2 grounding exercises per day.", baseline_value: 0, target_value: 2 }));
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT text, direction FROM plan_objectives WHERE id = ?").get(vague.id).direction, "increase");
  // reorder: vague objective (2nd) moves up
  r = await c.post(`/ehr/treatment-plans/${id}/objectives/${vague.id}/move`, { dir: "up" });
  assert.equal(r.status, 302);
  const order = t.db.prepare("SELECT id FROM plan_objectives WHERE goal_id = ? ORDER BY sort, id").all(chain.goal.id).map((o) => o.id);
  assert.deepEqual(order, [vague.id, chain.objective.id]);
  view = await c.get(`/ehr/patients/${pid}/treatment-plan?plan=${id}`);
  assert.ok(view.text.indexOf("Do 2 grounding exercises") < view.text.indexOf("Complete 3 planned pleasant"));
  // delete problem cascades
  r = await c.post(`/ehr/treatment-plans/${id}/problems/${chain.problem.id}/delete`);
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_objectives WHERE goal_id = ?").get(chain.goal.id).n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_interventions WHERE id = ?").get(chain.intervention.id).n, 0);
});

test("instrument objective: baseline prefilled from latest score; current auto-updates; % progress shown", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  addScore(pid, "PHQ9", 18, 10);
  const id = await createDraft(c, pid);
  const chain = await addChain(c, id);
  const form = await c.get(`/ehr/treatment-plans/${id}/objectives/new?parent=${chain.goal.id}&instrument=PHQ9`);
  assert.match(form.text, /name="baseline_value" inputmode="decimal" value="18"/);
  const r = await c.post(`/ehr/treatment-plans/${id}/objectives`, { parent_id: chain.goal.id, text: "Reduce depressive symptoms (PHQ-9 ≤ 9).",
    measure_type: "instrument", instrument: "PHQ9", baseline_value: "", target_value: 9, target_date: addDays(today(), 90) });
  assert.equal(r.status, 302);
  const o = last("plan_objectives");
  assert.equal(o.baseline_value, 18);
  assert.equal(o.direction, "decrease");
  assert.equal(o.unit, "points");
  addScore(pid, "PHQ9", 12, 0);
  const view = await c.get(`/ehr/patients/${pid}/treatment-plan?plan=${id}`);
  assert.match(view.text, /<small>Current<\/small><strong>12<\/strong>/);
  assert.match(view.text, /aria-valuenow="67"/);   // (18 - 12) / (18 - 9)
  assert.match(view.text, /67%/);
});

/* ---------------- signatures & activation ---------------- */

test("activation is blocked without a complete chain and signatures", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const id = await createDraft(c, pid);
  let r = await c.post(`/ehr/treatment-plans/${id}/activate`);
  assert.equal(r.status, 400);
  assert.match(r.text, /complete problem → goal → objective → intervention chain/);
  assert.match(r.text, /Clinician signature is required/);
  // problem + goal + objective but no intervention: still blocked
  await c.post(`/ehr/treatment-plans/${id}/problems`, { title: "Worry" });
  const p = last("plan_problems");
  await c.post(`/ehr/treatment-plans/${id}/goals`, { parent_id: p.id, goal_text: "Manage worry." });
  const g = last("plan_goals");
  await c.post(`/ehr/treatment-plans/${id}/objectives`, { parent_id: g.id, ...objective() });
  r = await c.post(`/ehr/treatment-plans/${id}/activate`);
  assert.equal(r.status, 400);
  assert.match(r.text, /intervention chain/);
  const o = last("plan_objectives");
  await c.post(`/ehr/treatment-plans/${id}/interventions`, { parent_id: o.id, kind: "professional", description: "CBT", responsible_user_id: c.userId });
  r = await c.post(`/ehr/treatment-plans/${id}/activate`);
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /intervention chain\./);
  assert.match(r.text, /Client signature/);
  // wrong password
  r = await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "clinician", password: "nope" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Password is incorrect/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'sign_failed' AND entity_id = ?").get(id));
  await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "clinician", password: PW });
  // duplicate role refused
  assert.equal((await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "clinician", password: PW })).status, 400);
  r = await c.post(`/ehr/treatment-plans/${id}/activate`);
  assert.equal(r.status, 400);
  assert.equal(getPlan(id).status, "draft");
});

test("client decline path: reason required; activation then succeeds", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const id = await createDraft(c, pid);
  await addChain(c, id);
  await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "clinician", password: PW });
  let r = await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "client", signer_name: "Plancase Synthetic", declined: 1 });
  assert.equal(r.status, 400);
  assert.match(r.text, /Document why/);
  r = await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "client", signer_name: "Plancase Synthetic", declined: 1,
    declined_reason: "Telehealth session; client agreed verbally but no e-sign available", copy_offered: 1 });
  assert.equal(r.status, 302);
  const sig = t.db.prepare("SELECT * FROM plan_signatures WHERE plan_id = ? AND role = 'client'").get(id);
  assert.equal(sig.declined, 1);
  assert.equal(sig.copy_offered, 1);
  assert.equal(sig.method, null);
  r = await c.post(`/ehr/treatment-plans/${id}/activate`);
  assert.equal(r.status, 302);
  assert.equal(getPlan(id).status, "active");
  const print = await c.get(`/ehr/treatment-plans/${id}/print`);
  assert.equal(print.status, 200);
  assert.match(print.text, /Declined \/ unable to sign/);
  assert.match(print.text, /Copy offered to client: Yes/);
  assert.match(print.text, /data-print/);
});

test("guardian prompt for clients under 18", async () => {
  const c = await t.login("therapist");
  const pid = newPatient({ dob: addDays(today(), -365 * 15) });
  const id = await createDraft(c, pid);
  const r = await c.get(`/ehr/treatment-plans/${id}/sign`);
  assert.match(r.text, /Client is under 18/);
  assert.match(r.text, /Obtain a parent\/guardian signature/);
});

test("supervisor co-signature required when EHR_PLAN_REQUIRE_SUPERVISOR=1", async () => {
  const prev = process.env.EHR_PLAN_REQUIRE_SUPERVISOR;
  process.env.EHR_PLAN_REQUIRE_SUPERVISOR = "1";
  try {
    const c = await t.login("therapist");
    const pid = newPatient();
    const id = await createDraft(c, pid);
    await addChain(c, id);
    await signClinicianAndClient(c, id);
    let r = await c.post(`/ehr/treatment-plans/${id}/activate`);
    assert.equal(r.status, 400);
    assert.match(r.text, /Supervisor co-signature is required/);
    // the author can't co-sign
    r = await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "supervisor", password: PW });
    assert.equal(r.status, 400);
    assert.match(r.text, /other than the plan&#39;s author/);
    const sup = await t.login("therapist2");
    r = await sup.post(`/ehr/treatment-plans/${id}/signatures`, { role: "supervisor", password: "wrong-password" });
    assert.equal(r.status, 400);
    r = await sup.post(`/ehr/treatment-plans/${id}/signatures`, { role: "supervisor", password: PW });
    assert.equal(r.status, 302);
    const s = t.db.prepare("SELECT * FROM plan_signatures WHERE plan_id = ? AND role = 'supervisor'").get(id);
    assert.equal(s.signer_user_id, t.ctx.users.therapist2);
    r = await c.post(`/ehr/treatment-plans/${id}/activate`);
    assert.equal(r.status, 302);
  } finally {
    if (prev === undefined) delete process.env.EHR_PLAN_REQUIRE_SUPERVISOR; else process.env.EHR_PLAN_REQUIRE_SUPERVISOR = prev;
  }
  // optional again once the setting is off
  const c = await t.login("therapist");
  const pid = newPatient();
  await activePlan(c, pid);
});

test("activation sets dates and supersedes the previous active plan in one step", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const v1 = await activePlan(c, pid);
  let p1 = getPlan(v1.id);
  assert.equal(p1.status, "active");
  assert.ok(p1.activated_at);
  assert.equal(p1.start_date, today());
  assert.equal(p1.review_date, addDays(today(), 90));
  // a new blank version (not a copy) also supersedes on activation
  const v2 = await createDraft(c, pid, { copy_from_active: "0", review_interval_days: 30 });
  assert.equal(getPlan(v2).version, 2);
  assert.equal(getPlan(v2).supersedes_id, v1.id);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_problems WHERE plan_id = ?").get(v2).n, 0);
  await addChain(c, v2);
  await signClinicianAndClient(c, v2);
  const r = await c.post(`/ehr/treatment-plans/${v2}/activate`);
  assert.equal(r.status, 302);
  p1 = getPlan(v1.id);
  assert.equal(p1.status, "superseded");
  assert.equal(p1.ended_at, today());
  assert.equal(getPlan(v2).status, "active");
  assert.equal(getPlan(v2).review_date, addDays(today(), 30));
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM treatment_plans WHERE patient_id = ? AND status = 'active'").get(pid).n, 1);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'supersede' AND entity_type = 'treatment_plan' AND entity_id = ?").get(v1.id));
  // old version viewable read-only
  const old = await c.get(`/ehr/patients/${pid}/treatment-plan?plan=${v1.id}`);
  assert.equal(old.status, 200);
  assert.match(old.text, /You are viewing version 1 \(Superseded\), read-only/);
  assert.doesNotMatch(old.text, /\/objectives\/\d+\/edit/);
});

test("signed and active plans are immutable (409); signatures lock a draft until cleared", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const a = await activePlan(c, pid);
  const id = a.id;
  const checks = [
    c.get(`/ehr/treatment-plans/${id}/edit`),
    c.post(`/ehr/treatment-plans/${id}/edit`, { plan_type: "sud", review_interval_days: 30 }),
    c.post(`/ehr/treatment-plans/${id}/problems`, { title: "New" }),
    c.post(`/ehr/treatment-plans/${id}/problems/${a.problem.id}`, { title: "Changed" }),
    c.post(`/ehr/treatment-plans/${id}/objectives/${a.objective.id}`, objective({ status: "met" })),
    c.post(`/ehr/treatment-plans/${id}/interventions/${a.intervention.id}/delete`),
    c.post(`/ehr/treatment-plans/${id}/goals/${a.goal.id}/move`, { dir: "up" }),
    c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "guardian", signer_name: "X", method: "in_person" }),
    c.post(`/ehr/treatment-plans/${id}/signatures/clear`),
    c.post(`/ehr/treatment-plans/${id}/activate`),
    c.post(`/ehr/treatment-plans/${id}/diagnoses`),
    c.post(`/ehr/treatment-plans/${id}/discard`),
  ];
  for (const r of await Promise.all(checks)) assert.equal(r.status, 409);
  assert.equal(t.db.prepare("SELECT title FROM plan_problems WHERE id = ?").get(a.problem.id).title, "Depressed mood");
  assert.equal(t.db.prepare("SELECT status FROM plan_objectives WHERE id = ?").get(a.objective.id).status, "not_started");
  assert.equal(getPlan(id).status, "active");

  // draft with signatures is locked
  const pid2 = newPatient();
  const d = await createDraft(c, pid2);
  const ch = await addChain(c, d);
  await c.post(`/ehr/treatment-plans/${d}/signatures`, { role: "clinician", password: PW });
  assert.equal((await c.post(`/ehr/treatment-plans/${d}/problems/${ch.problem.id}`, { title: "Changed" })).status, 409);
  assert.equal((await c.post(`/ehr/treatment-plans/${d}/signatures/clear`)).status, 302);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_signatures WHERE plan_id = ?").get(d).n, 0);
  assert.equal((await c.post(`/ehr/treatment-plans/${d}/problems/${ch.problem.id}`, { title: "Changed" })).status, 302);
});

test("revise copies the whole plan into a v2 draft; active stays active", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  addDx(pid, "F32.1", "MDD", 1);
  const a = await activePlan(c, pid);
  t.db.prepare("UPDATE treatment_plans SET client_vision = 'Run again', service_summary = 'Weekly 90837' WHERE id = ?").run(a.id);
  const r = await c.post(`/ehr/treatment-plans/${a.id}/revise`);
  assert.equal(r.status, 302);
  const v2 = planIdFrom(r);
  const p2 = getPlan(v2);
  assert.equal(p2.status, "draft");
  assert.equal(p2.version, 2);
  assert.equal(p2.supersedes_id, a.id);
  assert.equal(p2.client_vision, "Run again");
  assert.equal(p2.service_summary, "Weekly 90837");
  assert.equal(p2.activated_at, null);
  assert.equal(getPlan(a.id).status, "active");
  const count = (planId) => t.db.prepare(
    `SELECT COUNT(DISTINCT p.id) AS p, COUNT(DISTINCT g.id) AS g, COUNT(DISTINCT o.id) AS o, COUNT(DISTINCT i.id) AS i
     FROM plan_problems p LEFT JOIN plan_goals g ON g.problem_id = p.id LEFT JOIN plan_objectives o ON o.goal_id = g.id
     LEFT JOIN plan_interventions i ON i.objective_id = o.id WHERE p.plan_id = ?`).get(planId);
  assert.deepEqual({ ...count(v2) }, { ...count(a.id) });
  assert.deepEqual({ ...count(v2) }, { p: 1, g: 1, o: 1, i: 1 });
  const copiedObj = t.db.prepare(`SELECT o.* FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id WHERE p.plan_id = ?`).get(v2);
  assert.notEqual(copiedObj.id, a.objective.id);
  assert.equal(copiedObj.text, a.objective.text);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_signatures WHERE plan_id = ?").get(v2).n, 0);
  // second revise goes to the same draft
  const again = await c.post(`/ehr/treatment-plans/${a.id}/revise`);
  assert.equal(planIdFrom(again), v2);
  const view = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(view.text, /Unsigned draft revision in progress/);
  // the draft revision can be edited while v1 stays untouched
  assert.equal((await c.post(`/ehr/treatment-plans/${v2}/objectives/${copiedObj.id}`, objective({ text: "Revised objective", baseline_value: 1, target_value: 4 }))).status, 302);
  assert.equal(t.db.prepare("SELECT text FROM plan_objectives WHERE id = ?").get(a.objective.id).text, a.objective.text);
});

/* ---------------- reviews ---------------- */

function reviewBody(objId, extra = {}) {
  return { review_date: today(), participants: "Client; clinician", client_perspective: "Going better", summary: "Progressing.",
    diagnosis_changes: "None", level_of_care_appropriate: "1", outcome: "continue", password: PW,
    [`status_${objId}`]: "progressing", [`current_${objId}`]: "2", [`rationale_${objId}`]: "Log shows 2 per week", [`action_${objId}`]: "continue", ...extra };
}

test("review: continue pushes the next review date and updates objectives", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const a = await activePlan(c, pid);
  const form = await c.get(`/ehr/treatment-plans/${a.id}/review`);
  assert.equal(form.status, 200);
  assert.match(form.text, new RegExp(`name="status_${a.objective.id}"`));
  let r = await c.post(`/ehr/treatment-plans/${a.id}/review`, reviewBody(a.objective.id, { password: "wrong" }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${a.id}/review`, reviewBody(a.objective.id, { [`status_${a.objective.id}`]: "bogus" }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${a.id}/review`, reviewBody(a.objective.id, { level_of_care_appropriate: "" }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${a.id}/review`, reviewBody(a.objective.id, { review_date: addDays(today(), 3) }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/treatment-plans/${a.id}/review`, reviewBody(a.objective.id));
  assert.equal(r.status, 302);
  const review = last("plan_reviews");
  assert.equal(review.outcome, "continue");
  assert.ok(review.signed_at);
  assert.equal(review.reviewer_id, c.userId);
  assert.equal(getPlan(a.id).review_date, addDays(today(), 90));
  const o = t.db.prepare("SELECT * FROM plan_objectives WHERE id = ?").get(a.objective.id);
  assert.equal(o.status, "progressing");
  assert.equal(o.current_value, 2);
  assert.equal(o.current_value_on, today());
  const item = t.db.prepare("SELECT * FROM plan_review_items WHERE review_id = ?").get(review.id);
  assert.equal(item.action, "continue");
  const view = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(view.text, /aria-valuenow="67"/); // (0 - 2) / (0 - 3)
  const rv = await c.get(`/ehr/treatment-plans/${a.id}/reviews/${review.id}`);
  assert.equal(rv.status, 200);
  assert.match(rv.text, /Log shows 2 per week/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'plan_review' AND action = 'sign' AND entity_id = ?").get(review.id));
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'plan_review' AND action = 'view' AND entity_id = ?").get(review.id));
});

test("review: revise creates a draft revision; discharge ends the plan", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const a = await activePlan(c, pid);
  let r = await c.post(`/ehr/treatment-plans/${a.id}/review`, reviewBody(a.objective.id, { outcome: "revise", [`status_${a.objective.id}`]: "partially_met" }));
  assert.equal(r.status, 302);
  const draftId = planIdFrom(r);
  const draft = getPlan(draftId);
  assert.equal(draft.status, "draft");
  assert.equal(draft.supersedes_id, a.id);
  assert.equal(draft.version, 2);
  const copied = t.db.prepare(`SELECT o.status FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id WHERE p.plan_id = ?`).get(draftId);
  assert.equal(copied.status, "partially_met");
  assert.equal(getPlan(a.id).status, "active");

  const pid2 = newPatient();
  const b = await activePlan(c, pid2);
  r = await c.post(`/ehr/treatment-plans/${b.id}/review`, reviewBody(b.objective.id, { outcome: "discharge", end_reason: "goals_met", [`status_${b.objective.id}`]: "met" }));
  assert.equal(r.status, 302);
  const ended = getPlan(b.id);
  assert.equal(ended.status, "completed");
  assert.equal(ended.end_reason, "goals_met");
  assert.equal(ended.ended_at, today());
  assert.equal((await c.get(`/ehr/treatment-plans/${b.id}/review`)).status, 409);
});

test("end plan with a reason", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const a = await activePlan(c, pid);
  assert.equal((await c.get(`/ehr/treatment-plans/${a.id}/end`)).status, 200);
  assert.equal((await c.post(`/ehr/treatment-plans/${a.id}/end`, { end_reason: "other", end_date: today() })).status, 400);
  assert.equal((await c.post(`/ehr/treatment-plans/${a.id}/end`, { end_reason: "bogus", end_date: today() })).status, 400);
  assert.equal((await c.post(`/ehr/treatment-plans/${a.id}/end`, { end_reason: "transferred", end_date: addDays(today(), 1) })).status, 400);
  const r = await c.post(`/ehr/treatment-plans/${a.id}/end`, { end_reason: "transferred", end_date: today() });
  assert.equal(r.status, 302);
  assert.equal(getPlan(a.id).status, "completed");
  assert.equal(getPlan(a.id).end_reason, "transferred");
  const view = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(view.text, /No active treatment plan/);
  assert.match(view.text, /Transferred to another provider/);
});

test("discard an unsigned draft", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const id = await createDraft(c, pid);
  assert.equal((await c.post(`/ehr/treatment-plans/${id}/discard`)).status, 302);
  assert.equal(getPlan(id), undefined);
});

/* ---------------- alerts, golden thread, dashboard ---------------- */

test("seeded plans: overdue alert, no-reliable-improvement heuristic, golden thread, SUD Part 2 notice", async () => {
  const c = await t.login("therapist");
  const [jordan, morgan, , , , quinn] = t.ctx.patients;
  const m = await c.get(`/ehr/patients/${morgan}/treatment-plan`);
  assert.equal(m.status, 200);
  assert.match(m.text, /Plan review overdue/);
  assert.match(m.text, /No reliable improvement on PHQ-9/);
  assert.match(m.text, /Addressed in 1 note/);
  assert.match(m.text, /pill pill--bad" href="[^"]+">Plan review overdue/); // chart banner
  const j = await c.get(`/ehr/patients/${jordan}/treatment-plan`);
  assert.match(j.text, /Plan review due soon/);
  assert.doesNotMatch(j.text, /No reliable improvement/);
  assert.match(j.text, /Version history/);
  const q = await c.get(`/ehr/patients/${quinn}/treatment-plan`);
  assert.match(q.text, /42 CFR Part 2/);
  assert.match(q.text, /ASAM D4/);
  assert.match(q.text, /Level 2\.1/);
  const plan = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active'").get(quinn);
  const pr = await c.get(`/ehr/treatment-plans/${plan.id}/print`);
  assert.match(pr.text, /42 CFR Part 2/);
  assert.match(pr.text, /Supervisor/);
});

test("seed data: realistic v2 plans", () => {
  const db = t.db;
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM treatment_plans WHERE status = 'active'").get().n >= 4);
  assert.ok(db.prepare("SELECT 1 FROM treatment_plans WHERE plan_type = 'co_occurring' AND status = 'active'").get());
  assert.ok(db.prepare("SELECT 1 FROM treatment_plans WHERE status = 'active' AND review_date < date('now')").get());
  assert.ok(db.prepare("SELECT 1 FROM plan_objectives WHERE instrument = 'PHQ9'").get());
  assert.ok(db.prepare("SELECT 1 FROM plan_problems WHERE asam_dimension IS NOT NULL").get());
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM note_objectives").get().n > 0);
  // every active seeded plan has the required signatures and a full chain
  for (const p of db.prepare("SELECT id FROM treatment_plans WHERE status = 'active'").all()) {
    assert.ok(db.prepare("SELECT 1 FROM plan_signatures WHERE plan_id = ? AND role = 'clinician'").get(p.id));
    assert.ok(db.prepare("SELECT 1 FROM plan_signatures WHERE plan_id = ? AND role = 'client'").get(p.id));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM treatment_goals").get().n, 0);
});

test("dashboard: plans due for review (own patients for clinicians, all for admins)", async () => {
  const [jordan, morgan, , riley] = t.ctx.patients;
  const name = (id) => t.db.prepare("SELECT last_name FROM patients WHERE id = ?").get(id).last_name;
  const th = await t.login("therapist");
  let r = await th.get("/ehr");
  assert.match(r.text, /Treatment plans due for review/);
  assert.match(r.text, new RegExp(name(jordan)));
  assert.match(r.text, new RegExp(`${name(morgan)}[\\s\\S]{0,400}Overdue`));
  assert.match(r.text, /Safety follow-up/); // existing content kept
  const th2 = await t.login("therapist2");
  r = await th2.get("/ehr");
  assert.match(r.text, /Treatment plans due for review/);
  assert.doesNotMatch(r.text, new RegExp(`treatment-plan">${name(jordan)}`));
  const admin = await t.login("admin");
  r = await admin.get("/ehr");
  assert.match(r.text, new RegExp(`treatment-plan">${name(jordan)}`));
  assert.match(r.text, new RegExp(`treatment-plan">${name(morgan)}`));
  assert.doesNotMatch(r.text, new RegExp(`treatment-plan">${name(riley)}`)); // due in 60 days
  const fd = await t.login("frontdesk");
  r = await fd.get("/ehr");
  assert.doesNotMatch(r.text, /Treatment plans due for review/);
});

test("chart banner: no active treatment plan for a patient in care", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type) VALUES (?, ?, ?, ?, 'therapy')`)
    .run(pid, c.userId, `${addDays(today(), 3)}T10:00`, `${addDays(today(), 3)}T10:50`);
  const r = await c.get(`/ehr/patients/${pid}`);
  assert.match(r.text, /pill pill--warn" href="[^"]+">No active treatment plan/);
});

/* ---------------- legacy migration ---------------- */

test("legacy treatment_goals convert to the v2 tree, idempotently", () => {
  const db = t.db;
  const pid = newPatient();
  const plan = Number(db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, signed_at)
    VALUES (?, ?, 'active', '2026-01-01', '2026-04-01', '2026-01-01 10:00:00')`).run(pid, t.ctx.users.therapist).lastInsertRowid);
  const ins = db.prepare("INSERT INTO treatment_goals (plan_id, problem, goal, objectives, interventions, target_date, status, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  ins.run(plan, "Low mood", "Reduce symptoms", "PHQ-9 below 10", "CBT weekly", "2026-06-01", "in_progress", 0);
  ins.run(plan, "Sleep", "Sleep better", null, null, null, "met", 1);
  const n = migrateLegacyGoals(db);
  assert.ok(n >= 1);
  const rows = db.prepare(
    `SELECT p.title, p.status AS pstatus, g.goal_text, o.text, o.status, o.target_date, o.measure_type, i.description
     FROM plan_problems p JOIN plan_goals g ON g.problem_id = p.id JOIN plan_objectives o ON o.goal_id = g.id
     JOIN plan_interventions i ON i.objective_id = o.id WHERE p.plan_id = ? ORDER BY p.sort`).all(plan);
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { title: "Low mood", pstatus: "active", goal_text: "Reduce symptoms", text: "PHQ-9 below 10", status: "progressing",
    target_date: "2026-06-01", measure_type: "attainment", description: "CBT weekly" });
  assert.equal(rows[1].text, "Sleep better");
  assert.equal(rows[1].status, "met");
  assert.equal(rows[1].description, "See objective");
  assert.equal(getPlan(plan).activated_at, "2026-01-01 10:00:00");
  assert.equal(migrateLegacyGoals(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plan_problems WHERE plan_id = ?").get(plan).n, 2);
});

/* ---------------- permissions, audit, 404 ---------------- */

test("frontdesk and billing are forbidden from plans", async () => {
  const pid = t.ctx.patients[0];
  const plan = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active'").get(pid);
  const draft = t.db.prepare("SELECT id FROM treatment_plans WHERE status = 'draft' LIMIT 1").get();
  for (const role of ["frontdesk", "billing"]) {
    const c = await t.login(role);
    assert.equal((await c.get(`/ehr/patients/${pid}/treatment-plan`)).status, 403, role);
    assert.equal((await c.get(`/ehr/treatment-plans/${plan.id}/print`)).status, 403, role);
    assert.equal((await c.get(`/ehr/patients/${pid}/treatment-plan/new`)).status, 403, role);
    assert.equal((await c.post(`/ehr/patients/${pid}/treatment-plan`, { plan_type: "mental_health", review_interval_days: 90 })).status, 403, role);
    assert.equal((await c.post(`/ehr/treatment-plans/${draft.id}/problems`, { title: "x" })).status, 403, role);
    assert.equal((await c.post(`/ehr/treatment-plans/${draft.id}/activate`)).status, 403, role);
    assert.equal((await c.post(`/ehr/treatment-plans/${plan.id}/review`, {})).status, 403, role);
    assert.equal((await c.post(`/ehr/treatment-plans/${plan.id}/revise`)).status, 403, role);
  }
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'forbidden' AND detail LIKE '%treatment-plan%'").get());
});

test("audit: views and changes are logged without PHI", async () => {
  const c = await t.login("therapist");
  const pid = newPatient({ name: "Auditcase" });
  const a = await activePlan(c, pid);
  await c.get(`/ehr/patients/${pid}/treatment-plan`);
  await c.get(`/ehr/treatment-plans/${a.id}/print`);
  const rows = t.db.prepare("SELECT action, detail FROM audit_log WHERE entity_type = 'treatment_plan' AND patient_id = ?").all(pid);
  const actions = new Set(rows.map((r) => r.action));
  for (const act of ["create", "update", "sign", "activate", "view", "print"]) assert.ok(actions.has(act), act);
  for (const r of rows) {
    assert.doesNotMatch(String(r.detail), /Depressed mood|pleasant activities|Activity scheduling|Auditcase|Feel like me/);
  }
});

test("unknown patient / plan / item -> 404", async () => {
  const c = await t.login("admin");
  assert.equal((await c.get("/ehr/patients/999999/treatment-plan")).status, 404);
  assert.equal((await c.post("/ehr/treatment-plans/999999/activate")).status, 404);
  assert.equal((await c.get("/ehr/treatment-plans/999999/print")).status, 404);
  assert.equal((await c.get(`/ehr/patients/${t.ctx.patients[0]}/treatment-plan?plan=999999`)).status, 404);
  const other = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ?").get(t.ctx.patients[1]);
  assert.equal((await c.get(`/ehr/patients/${t.ctx.patients[0]}/treatment-plan?plan=${other.id}`)).status, 404);
  const draft = t.db.prepare("SELECT id FROM treatment_plans WHERE status = 'draft' LIMIT 1").get();
  assert.equal((await c.get(`/ehr/treatment-plans/${draft.id}/objectives/999999/edit`)).status, 404);
  assert.equal((await c.get(`/ehr/treatment-plans/${draft.id}/goals/new?parent=999999`)).status, 404);
});

test("signatures can't be collected on an empty draft; a locked draft can be unlocked from the plan page", async () => {
  const c = await t.login("therapist");
  const pid = newPatient({ name: "Locktest" });
  addDx(pid, "F41.1", "Generalized anxiety disorder", 1);
  const id = await createDraft(c, pid);
  // Empty draft: signing is refused and nothing is recorded
  const r = await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "clinician", password: PW });
  assert.equal(r.status, 400);
  assert.match(r.text, /Finish the plan before collecting signatures/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_signatures WHERE plan_id = ?").get(id).n, 0);
  // Simulate a draft that was signed before it was finished (legacy data)
  t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_user_id, signer_name, method) VALUES (?, 'clinician', ?, 'X', 'password')").run(id, c.userId);
  const page = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(page.text, /Clear signatures &amp; edit/);
  const clear = await c.post(`/ehr/treatment-plans/${id}/signatures/clear`, { return: "plan" });
  assert.equal(clear.status, 302);
  assert.match(clear.location, /treatment-plan\?plan=/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM plan_signatures WHERE plan_id = ?").get(id).n, 0);
  // Editable again, and signing works once the chain exists
  await addChain(c, id);
  assert.equal((await c.post(`/ehr/treatment-plans/${id}/signatures`, { role: "clinician", password: PW })).status, 302);
});
