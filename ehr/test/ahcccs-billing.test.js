"use strict";
// AHCCCS (Arizona Medicaid) billing, patient record and service plan rules. See docs/ahcccs-spec.md §C–D.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { isAhcccs, unitsFor15 } = require("../src/payers");
const { suggestModifiers } = require("../src/routes/billing");
const { addDays, today } = require("../src/views");

let t, adult, minor, commercial;
const dos = () => addDays(today(), -3);

function newPatient(first, dob, ahcccsId) {
  const n = t.db.prepare("SELECT COUNT(*) n FROM patients").get().n + 1;
  const id = Number(t.db.prepare(`INSERT INTO patients (mrn, first_name, last_name, dob, ahcccs_id, primary_clinician_id)
    VALUES (?, ?, 'Ahcccs', ?, ?, ?)`).run(`CR-T${String(n).padStart(5, "0")}`, first, dob, ahcccsId, t.ctx.users.therapist).lastInsertRowid);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, is_primary) VALUES (?, 'F41.1', 'Generalized anxiety disorder', 1)").run(id);
  return id;
}
function insertNote(pid, { type = "progress", status = "signed", date = dos(), content = {}, appt = null } = {}) {
  return Number(t.db.prepare(`INSERT INTO notes (patient_id, appointment_id, author_id, type, format, content, status, service_date, signed_at, signed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, appt, t.ctx.users.therapist, type, type === "intake" ? "intake" : type === "group" ? "group" : "dap",
    JSON.stringify(content), status, date, status === "signed" ? `${date} 12:00:00` : null, status === "signed" ? t.ctx.users.therapist : null).lastInsertRowid);
}
function insertActivePlan(pid, activatedOn) {
  t.db.prepare("UPDATE treatment_plans SET status = 'superseded', ended_at = ? WHERE patient_id = ? AND status = 'active'").run(activatedOn, pid);
  return Number(t.db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, version, review_interval_days, activated_at, start_date)
    VALUES (?, ?, 'active', 1, 365, ?, ?)`).run(pid, t.ctx.users.therapist, `${activatedOn} 10:00:00`, activatedOn).lastInsertRowid);
}
const charge = (pid, body) => ({
  date_of_service: dos(), units: "1", rendering_provider_id: t.ctx.users.therapist, bill_to: "insurance", dx_other: "F41.1", pos: "11", ...body,
});
const lastCharge = (pid) => t.db.prepare("SELECT * FROM charges WHERE patient_id = ? ORDER BY id DESC").get(pid);

before(async () => {
  t = await start();
  adult = newPatient("Adult", "1990-05-05", "A12345678");
  minor = newPatient("Minor", "2015-05-05", "B87654321");
  commercial = newPatient("Commercial", "1990-05-05", null);
  t.db.prepare("INSERT INTO insurance_policies (patient_id, payer_name, member_id) VALUES (?, 'Sample Health Plan', 'X1')").run(commercial);
});
after(async () => { await t.stop(); });

test("AHCCCS detection via AHCCCS ID or an AHCCCS health plan policy", async () => {
  assert.equal(isAhcccs(t.db, adult), true);
  assert.equal(isAhcccs(t.db, commercial), false);
  const viaPlan = newPatient("ViaPlan", "1980-01-01", null);
  assert.equal(isAhcccs(t.db, viaPlan), false);
  t.db.prepare("INSERT INTO insurance_policies (patient_id, payer_name, member_id) VALUES (?, 'Mercy Care', 'M1')").run(viaPlan);
  assert.equal(isAhcccs(t.db, viaPlan), true);

  // Patient form stores the AHCCCS ID uppercased and validates the format; the overview shows the pill.
  const c = await t.login("frontdesk");
  const base = { first_name: "Form", last_name: "Ahcccs", dob: "1985-01-01", gender: "F" };
  let r = await c.post("/ehr/patients", { ...base, ahcccs_id: "not-an-id" });
  assert.equal(r.status, 400);
  assert.match(r.text, /AHCCCS ID is a letter followed by 8 digits/);
  r = await c.post("/ehr/patients", { ...base, ahcccs_id: "c11223344" });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const p = t.db.prepare("SELECT * FROM patients WHERE first_name = 'Form' AND last_name = 'Ahcccs'").get();
  assert.equal(p.ahcccs_id, "C11223344");
  assert.equal(p.gender, "F");
  const ov = await c.get(`/ehr/patients/${p.id}`);
  assert.match(ov.text, /<span class="pill"[^>]*>AHCCCS<\/span>/);
  assert.match(ov.text, /C11223344/);
  assert.match(ov.text, /list="payer-suggestions"/);
  assert.match(ov.text, /Molina Complete Care of Arizona/);
  const ov2 = await c.get(`/ehr/patients/${commercial}`);
  assert.doesNotMatch(ov2.text, /data-ahcccs/);
});

test("15-minute units must match documented minutes", async () => {
  assert.deepEqual([7, 8, 22, 23, 37, 38, 52, 53, 67].map(unitsFor15), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  const c = await t.login("billing");
  let r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "H0004", modifier: "HO", minutes: "7", units: "" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /at least 8 documented minutes/);
  for (const [mins, units] of [["8", 1], ["22", 1], ["23", 2], ["53", 4]]) {
    r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "H0004", modifier: "HO", minutes: mins, units: String(units) }));
    assert.equal(r.status, 302, `${mins} min: ${r.text.slice(0, 300)}`);
    const ch = lastCharge(adult);
    assert.equal(ch.units, units);
    assert.equal(ch.minutes, Number(mins));
    assert.equal(ch.fee_cents, 3000 * units);
    assert.equal(ch.pos, "11");
  }
  // blank units are computed
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "T1016", modifier: "HO", minutes: "40", units: "" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(adult).units, 3);
  // mismatch rejected (MD418), also for non-AHCCCS patients
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "H0004", modifier: "HO", minutes: "23", units: "1" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /MD418/);
  r = await c.post(`/ehr/patients/${commercial}/charges`, charge(commercial, { cpt_code: "H2014", minutes: "53", units: "2" }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "H2017", modifier: "HO", units: "2" }));
  assert.equal(r.status, 400); // timed code needs minutes
});

test("telehealth modifier 95 is rejected for AHCCCS but allowed for commercial; POS 02 rejected; FQ not on E/M", async () => {
  const c = await t.login("billing");
  let r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "95" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Telehealth Code Set/);
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "93" }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${commercial}/charges`, charge(commercial, { cpt_code: "90834", modifier: "95", pos: "10" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(commercial).modifier, "95");

  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "GT", pos: "02" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /member location POS/);
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "GT", pos: "" }));
  assert.equal(r.status, 400); // POS required for AHCCCS
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "GT", pos: "12" }));
  assert.equal(r.status, 302);

  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "99214", modifier: "FQ" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /FQ \(audio-only\) is not allowed on E\/M/);
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "GT FQ" }));
  assert.equal(r.status, 400);
  // up to 4 modifiers
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "GT HO XE 59 25" }));
  assert.equal(r.status, 400);
  // note modality must match
  const avNote = insertNote(adult, { content: { telehealth_modality: "audio_video" } });
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", modifier: "FQ", note_id: avNote }));
  assert.equal(r.status, 400);
});

test("group services require HQ for AHCCCS", async () => {
  const c = await t.login("billing");
  const groupNote = insertNote(adult, { type: "group" });
  let r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90853", note_id: groupNote }));
  assert.equal(r.status, 400);
  assert.match(r.text, /HQ/);
  const st = insertNote(adult, { content: { service_type: "group" } });
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "H2014", modifier: "HO", minutes: "60", units: "4", note_id: st }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90853", modifier: "HQ", note_id: groupNote }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(adult).note_id, groupNote);
  // non-AHCCCS keeps old behavior
  r = await c.post(`/ehr/patients/${commercial}/charges`, charge(commercial, { cpt_code: "90853" }));
  assert.equal(r.status, 302);
});

test("billed is blocked without a signed note, with a stale plan, and for a minor without guardian signature", async () => {
  const c = await t.login("billing");
  const billIt = (id) => c.post(`/ehr/charges/${id}/status`, { status: "billed" });

  // no linked note
  let r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834" }));
  assert.equal(r.status, 302);
  r = await billIt(lastCharge(adult).id);
  assert.equal(r.status, 400);
  assert.match(r.text, /signed progress note/);

  // unsigned note
  const draft = insertNote(adult, { status: "draft" });
  await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", note_id: draft }));
  r = await billIt(lastCharge(adult).id);
  assert.equal(r.status, 400);
  assert.match(r.text, /must be signed/);

  // signed note, but plan older than 365 days and no intake
  const signed = insertNote(adult);
  await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "90834", note_id: signed }));
  const ch = lastCharge(adult);
  insertActivePlan(adult, addDays(today(), -400));
  r = await billIt(ch.id);
  assert.equal(r.status, 400);
  assert.match(r.text, /MD466/);
  assert.match(r.text, /more than 1 year/);
  assert.match(r.text, /no signed assessment/);
  assert.equal(t.db.prepare("SELECT status FROM charges WHERE id = ?").get(ch.id).status, "unbilled");

  // a recent signed review renews the plan; still needs an intake
  const planId = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active'").get(adult).id;
  t.db.prepare(`INSERT INTO plan_reviews (plan_id, review_date, reviewer_id, outcome, signed_at) VALUES (?, ?, ?, 'continue', datetime('now'))`)
    .run(planId, addDays(today(), -30), t.ctx.users.therapist);
  r = await billIt(ch.id);
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /more than 1 year before/);
  insertNote(adult, { type: "intake", date: addDays(today(), -100) });
  r = await billIt(ch.id);
  assert.equal(r.status, 302, r.text.slice(0, 1500));
  assert.equal(t.db.prepare("SELECT status FROM charges WHERE id = ?").get(ch.id).status, "billed");

  // minor: plan without guardian signature blocks (MD454)
  insertNote(minor, { type: "intake", date: addDays(today(), -60) });
  const mPlan = insertActivePlan(minor, addDays(today(), -30));
  const mNote = insertNote(minor);
  r = await c.post(`/ehr/patients/${minor}/charges`, charge(minor, { cpt_code: "90834", note_id: mNote }));
  assert.equal(r.status, 302);
  const mc = lastCharge(minor);
  r = await billIt(mc.id);
  assert.equal(r.status, 400);
  assert.match(r.text, /MD454/);
  t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_name, method) VALUES (?, 'guardian', 'Pat Example (mother)', 'in_person')").run(mPlan);
  r = await billIt(mc.id);
  assert.equal(r.status, 302);

  // non-AHCCCS: unchanged
  await c.post(`/ehr/patients/${commercial}/charges`, charge(commercial, { cpt_code: "90834" }));
  r = await billIt(lastCharge(commercial).id);
  assert.equal(r.status, 302);
});

test("superbill shows POS, modifiers, minutes and facility-NPI note for non-independent providers", async () => {
  t.db.prepare("UPDATE users SET credentials = 'LAC' WHERE id = ?").run(t.ctx.users.therapist2);
  const c = await t.login("billing");
  const r0 = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, {
    cpt_code: "H0004", modifier: "HO GT", minutes: "45", units: "3", pos: "12", rendering_provider_id: t.ctx.users.therapist2,
  }));
  assert.equal(r0.status, 302, r0.text.slice(0, 400));
  const r = await c.get(`/ehr/patients/${adult}/superbill?from=${addDays(today(), -10)}&to=${today()}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<th>POS<\/th>/);
  assert.match(r.text, /HO GT/);
  assert.match(r.text, /Bill under facility NPI; rendering provider in Box 19/);
  assert.match(r.text, /AHCCCS ID A12345678/);
});

test("AHCCCS service plans default to a 365-day review interval", async () => {
  const c = await t.login("therapist");
  const fresh = newPatient("PlanDefault", "1990-01-01", "D10000001");
  const form = await c.get(`/ehr/patients/${fresh}/treatment-plan/new`);
  assert.equal(form.status, 200);
  assert.match(form.text, /name="review_interval_days" min="7" max="365" value="365"/);
  const r = await c.post(`/ehr/patients/${fresh}/treatment-plan`, { plan_type: "mental_health" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT review_interval_days FROM treatment_plans WHERE patient_id = ?").get(fresh).review_interval_days, 365);
  const tab = await c.get(`/ehr/patients/${fresh}/treatment-plan`);
  assert.match(tab.text, /Service Plan \(AHCCCS\)/);
  assert.match(tab.text, /edit MD466/); // no signed assessment alert
  // stricter interval allowed; non-AHCCCS keeps 90
  const fresh2 = newPatient("PlanStrict", "1990-01-01", "D10000002");
  await c.post(`/ehr/patients/${fresh2}/treatment-plan`, { plan_type: "mental_health", review_interval_days: "90" });
  assert.equal(t.db.prepare("SELECT review_interval_days FROM treatment_plans WHERE patient_id = ?").get(fresh2).review_interval_days, 90);
  const nonA = await c.get(`/ehr/patients/${commercial}/treatment-plan/new`);
  assert.match(nonA.text, /value="90"/);
});

test("minor without guardian signature cannot activate an AHCCCS plan; AHCCCS header fields required", async () => {
  const c = await t.login("therapist");
  const kid = newPatient("Kid", "2014-02-02", "E10000001");
  const safety = insertNote(kid, { type: "safety_plan" });
  const build = (pid, extra = {}) => {
    const planId = Number(t.db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, version, review_interval_days, safety_plan_note_id,
      crisis_contacts, peer_support_offered, team_members) VALUES (?, ?, 'draft', 1, 365, ?, ?, ?, ?)`).run(pid, t.ctx.users.therapist,
      extra.safety ?? null, extra.crisis ?? null, extra.peer ?? null, "Mother; therapist; school counselor").lastInsertRowid);
    const prob = Number(t.db.prepare("INSERT INTO plan_problems (plan_id, title) VALUES (?, 'Anxiety')").run(planId).lastInsertRowid);
    const goal = Number(t.db.prepare("INSERT INTO plan_goals (problem_id, goal_text) VALUES (?, 'Less worry')").run(prob).lastInsertRowid);
    const obj = Number(t.db.prepare("INSERT INTO plan_objectives (goal_id, text) VALUES (?, 'Use coping skill 3x/week')").run(goal).lastInsertRowid);
    t.db.prepare("INSERT INTO plan_interventions (objective_id, description) VALUES (?, 'CBT weekly')").run(obj);
    t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_user_id, signer_name, method) VALUES (?, 'clinician', ?, 'Taylor Therapist', 'password')").run(planId, t.ctx.users.therapist);
    t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_name, method) VALUES (?, 'client', 'Kid Ahcccs', 'in_person')").run(planId);
    return planId;
  };
  // Missing AHCCCS header fields
  let planId = build(kid);
  let r = await c.post(`/ehr/treatment-plans/${planId}/activate`, {});
  assert.equal(r.status, 400);
  assert.match(r.text, /MD454/);
  assert.match(r.text, /safety plan/);
  assert.match(r.text, /crisis contacts/);
  assert.match(r.text, /peer or family support partner/);
  t.db.prepare("UPDATE treatment_plans SET safety_plan_note_id = ?, crisis_contacts = '988; mother (555) 010-0000', peer_support_offered = 'declined' WHERE id = ?").run(safety, planId);
  // A documented guardian decline doesn't satisfy MD454 for AHCCCS
  t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_name, declined, declined_reason) VALUES (?, 'guardian', 'Guardian', 1, 'unavailable')").run(planId);
  r = await c.post(`/ehr/treatment-plans/${planId}/activate`, {});
  assert.equal(r.status, 400);
  assert.match(r.text, /MD454/);
  t.db.prepare("DELETE FROM plan_signatures WHERE plan_id = ? AND role = 'guardian'").run(planId);
  t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_name, method) VALUES (?, 'guardian', 'Pat Example (mother)', 'in_person')").run(planId);
  r = await c.post(`/ehr/treatment-plans/${planId}/activate`, {});
  assert.equal(r.status, 302, r.text.slice(0, 1500));
  assert.equal(t.db.prepare("SELECT status FROM treatment_plans WHERE id = ?").get(planId).status, "active");

  // non-AHCCCS minor: still only a warning
  const kid2 = newPatient("Kid2", "2014-02-02", null);
  planId = build(kid2);
  r = await c.post(`/ehr/treatment-plans/${planId}/activate`, {});
  assert.equal(r.status, 302);

  // Header form saves the AHCCCS fields; revisions copy them
  const draft = await c.post(`/ehr/treatment-plans/${t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active'").get(kid).id}/revise`, {});
  assert.equal(draft.status, 302);
  const rev = t.db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'draft'").get(kid);
  assert.equal(rev.peer_support_offered, "declined");
  assert.match(rev.crisis_contacts, /988/);
  const ed = await c.get(`/ehr/treatment-plans/${rev.id}/edit`);
  assert.match(ed.text, /Child and Family Team/);
});

test("education-level modifier suggestion from the rendering provider", async () => {
  assert.deepEqual(suggestModifiers({ ahcccs: true, cpt: "H0004", provider: { name: "A", credentials: "BHT" } }).modifiers, ["HN"]);
  assert.deepEqual(suggestModifiers({ ahcccs: true, cpt: "H2014", provider: { name: "A", credentials: "LMSW" } }).modifiers, ["HO"]);
  assert.deepEqual(suggestModifiers({ ahcccs: true, cpt: "H2014", provider: { name: "A", credentials: "LMSW", education_level: "HP" } }).modifiers, ["HP"]);
  assert.deepEqual(suggestModifiers({ ahcccs: true, cpt: "90834", provider: { name: "A", credentials: "LCSW" } }).modifiers, []); // CPT: no education modifier
  const note = { type: "progress", content: JSON.stringify({ telehealth_modality: "audio_only", service_type: "family_member_absent" }) };
  assert.deepEqual(suggestModifiers({ ahcccs: true, cpt: "H0004", note, provider: { credentials: "LAC" } }).modifiers, ["FQ", "HS", "HO"]);
  const av = { type: "group", content: JSON.stringify({ telehealth_modality: "audio_video" }) };
  assert.deepEqual(suggestModifiers({ ahcccs: true, cpt: "90853", note: av }).modifiers, ["GT", "HQ"]);
  assert.deepEqual(suggestModifiers({ ahcccs: false, cpt: "90834", appt: { modality: "telehealth" } }).modifiers, ["95"]);

  // Admin sets education level; missing education modifier warns but does not block.
  const a = await t.login("admin");
  const u = t.db.prepare("SELECT * FROM users WHERE id = ?").get(t.ctx.users.therapist2);
  let r = await a.post(`/ehr/admin/users/${u.id}/edit`, { name: u.name, role: u.role, credentials: u.credentials || "", npi: u.npi || "", active: "1", education_level: "HN" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT education_level FROM users WHERE id = ?").get(u.id).education_level, "HN");
  r = await a.post(`/ehr/admin/users/${u.id}/edit`, { name: u.name, role: u.role, active: "1", education_level: "ZZ" });
  assert.equal(r.status, 400);

  const c = await t.login("billing");
  r = await c.post(`/ehr/patients/${adult}/charges`, charge(adult, { cpt_code: "H2014", minutes: "30", units: "2", rendering_provider_id: u.id }));
  assert.equal(r.status, 302);
  const led = await c.get(`/ehr/patients/${adult}/billing`);
  assert.match(led.text, /Education-level modifier missing: Casey Counselor would bill HN/);
  const form = await c.get(`/ehr/patients/${adult}/charges/new`);
  assert.match(form.text, /AHCCCS member/);
  assert.match(form.text, /name="pos"/);
  assert.match(form.text, /name="note_id"/);
});
