"use strict";
// Wave 2 note dropdowns: discharge status, CALOCUS level, ROI purpose, safety-plan copy given,
// preferred language, group name (clinic list) and the optional MSE on progress notes.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid, ahPid;
const activePlan = (p) => {
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(p);
  t.db.prepare("INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at) VALUES (?, ?, 'active', date('now'), date('now', '+90 days'), datetime('now'))").run(p, t.ctx.users.therapist);
};
before(async () => {
  t = await start();
  pid = t.ctx.patients[1];
  ahPid = t.ctx.patients[2];
  activePlan(pid);
  activePlan(ahPid);
  t.db.prepare("UPDATE patients SET ahcccs_id = 'A33333333' WHERE id = ?").run(ahPid);
});
after(async () => { await t.stop(); });

const noteIdFrom = (res) => Number((res.location || "").match(/\/ehr\/notes\/(\d+)$/)[1]);
const content = (id) => JSON.parse(t.db.prepare("SELECT content FROM notes WHERE id = ?").get(id).content);
const status = (id) => t.db.prepare("SELECT status FROM notes WHERE id = ?").get(id).status;
async function create(c, fields, p = pid) {
  const r = await c.post(`/ehr/patients/${p}/notes`, { service_date: "2026-11-02", ...fields });
  assert.equal(r.status, 302, r.text.slice(0, 600));
  return noteIdFrom(r);
}
let seq = 0;
const progress = (extra = {}) => {
  const n = ++seq * 7919;
  return { type: "progress", format: "dap", session_start: "10:00", session_end: "10:50",
    data: `Client reported topic ${n} and sleep item ${n + 1}.`, assessment: `Progress ${n} on goal ${n + 3}.`,
    plan: `Homework ${n} and next visit ${n + 5}.`, interventions: ["CBT"], risk_level: "low", ...extra };
};

test("discharge 'Status at discharge' is a dropdown with Other; signing still requires it", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${pid}/notes/new?type=discharge`);
  assert.match(f.text, /<select id="discharge_status" name="discharge_status"/);
  assert.match(f.text, /<option value="Improved">Improved<\/option>/);
  assert.match(f.text, /name="discharge_status_other"/);
  const base = { type: "discharge", format: "narrative", discharge_reason: "Treatment goals met",
    treatment_summary: "12 sessions of CBT", recommendations: "PCP follow-up" };
  const id = await create(c, { ...base, discharge_status: "Improved" });
  assert.equal(content(id).discharge_status, "Improved");
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const o = await create(c, { ...base, discharge_status: "__other", discharge_status_other: "Partially improved" });
  assert.equal(content(o).discharge_status, "Partially improved");
  const blank = await create(c, base);
  const s = await c.post(`/ehr/notes/${blank}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Status at discharge is required/);
});

test("CALOCUS level is a select storing the value and displaying the label", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${ahPid}/notes/new?type=intake`);
  assert.match(f.text, /<select[^>]*name="calocus_level"/);
  assert.match(f.text, /<option value="3"[^>]*>Level 3 · High-intensity community-based services<\/option>/);
  const intake = { type: "intake", format: "intake", presenting_problem: "Worry", hpi: "Six months", diagnostic_impression: "GAD",
    recommendations: "Weekly CBT", risk_level: "low", loc_tool: "calocus", calocus_score: "18" };
  const id = await create(c, { ...intake, calocus_level: "3" }, ahPid);
  assert.equal(content(id).calocus_level, "3");
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Level 3 · High-intensity community-based services/);
  const bad = await c.post(`/ehr/patients/${ahPid}/notes`, { service_date: "2026-11-02", ...intake, calocus_level: "Level 9" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose a valid option for CALOCUS level of care/);
  // A free-text level saved before the dropdown stays visible and survives an unchanged re-save.
  const old = await create(c, intake, ahPid);
  const k = content(old); k.calocus_level = "Level 2 (old text)";
  t.db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(JSON.stringify(k), old);
  const e = await c.get(`/ehr/notes/${old}/edit`);
  assert.match(e.text, /Level 2 \(old text\) \(saved earlier\)/);
  const r = await c.post(`/ehr/notes/${old}/edit`, { service_date: "2026-11-02", ...intake, calocus_level: "Level 2 (old text)" });
  assert.equal(r.status, 302);
  assert.equal(content(old).calocus_level, "Level 2 (old text)");
});

test("ROI purpose is a dropdown with Other", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${pid}/notes/new?type=roi`);
  assert.match(f.text, /<select id="purpose" name="purpose"/);
  assert.match(f.text, /<option value="Coordination of care">/);
  const roi = { type: "roi", format: "roi", direction: "release_to", recipient: "Dr. PCP", information: "Dates of attendance",
    expires_on: "2027-11-02", includes_sud: "no", consent_method: "signed_paper", signed_by: "Client", signed_on: "2026-11-02" };
  const id = await create(c, { ...roi, purpose: "Coordination of care" });
  assert.equal(content(id).purpose, "Coordination of care");
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const o = await create(c, { ...roi, purpose: "__other", purpose_other: "Housing application" });
  assert.equal(content(o).purpose, "Housing application");
  const blank = await create(c, roi);
  const s = await c.post(`/ehr/notes/${blank}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Purpose is required/);
});

test("safety plan 'Copy given to client' is a dropdown; old free text stays visible", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${pid}/notes/new?type=safety_plan`);
  assert.match(f.text, /<select id="copy_given" name="copy_given"/);
  assert.match(f.text, /<option value="Printed copy given">/);
  const sp = { type: "safety_plan", format: "safety_plan", warning_signs: "Isolation", coping_strategies: "Walk",
    help_contacts: "Sister 555-0100", professional_contacts: "988", means_safety: "Meds locked", risk_level: "low" };
  const id = await create(c, { ...sp, copy_given: "Printed copy given" });
  assert.equal(content(id).copy_given, "Printed copy given");
  const bad = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...sp, copy_given: "Something else" });
  assert.equal(bad.status, 400);
  const k = content(id); k.copy_given = "Photo on phone";
  t.db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(JSON.stringify(k), id);
  const e = await c.get(`/ehr/notes/${id}/edit`);
  assert.match(e.text, /<option value="Photo on phone" selected>Photo on phone \(saved earlier\)<\/option>/);
  const r = await c.post(`/ehr/notes/${id}/edit`, { service_date: "2026-11-02", ...sp, copy_given: "Photo on phone" });
  assert.equal(r.status, 302);
  assert.equal(content(id).copy_given, "Photo on phone");
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
});

test("preferred language is a dropdown with Other", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${ahPid}/notes/new?type=progress`);
  assert.match(f.text, /<select id="preferred_language" name="preferred_language"/);
  assert.match(f.text, /<option value="Spanish">Spanish<\/option>/);
  const id = await create(c, progress({ preferred_language: "Spanish" }));
  assert.equal(content(id).preferred_language, "Spanish");
  const o = await create(c, progress({ preferred_language: "__other", preferred_language_other: "Somali" }));
  assert.equal(content(o).preferred_language, "Somali");
});

test("group name uses the clinic's group list with Other", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${pid}/notes/new?type=group`);
  assert.match(f.text, /<select id="group_name" name="group_name"/);
  assert.match(f.text, /<option value="Relapse prevention">Relapse prevention<\/option>/);
  assert.match(f.text, /name="group_name_other"/);
  // A group the clinic adds shows up.
  t.db.prepare("INSERT INTO clinic_lists (kind, label, sort) VALUES ('group', 'Seeking safety', 99)").run();
  const f2 = await c.get(`/ehr/patients/${pid}/notes/new?type=group`);
  assert.match(f2.text, /<option value="Seeking safety">Seeking safety<\/option>/);
  const g = { type: "group", format: "group", group_topic: "Triggers", session_start: "17:00", session_end: "18:00",
    group_content: "Identifying triggers", participation: "Engaged and shared", interventions: ["Psychoeducation"], plan: "Continue weekly", risk_level: "low" };
  const id = await create(c, { ...g, group_name: "Relapse prevention" });
  assert.equal(content(id).group_name, "Relapse prevention");
  const o = await create(c, { ...g, group_name: "__other", group_name_other: "Men's group" });
  assert.equal(content(o).group_name, "Men's group");
  const e = await c.get(`/ehr/notes/${o}/edit`);
  assert.match(e.text, /value="Men&#39;s group"|value="Men's group"/);
  const blank = await create(c, g);
  const s = await c.post(`/ehr/notes/${blank}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Group name is required/);
});

test("progress notes (DAP and SOAP) have an optional MSE section before interventions", async () => {
  const c = await t.login("therapist");
  for (const format of ["dap", "soap"]) {
    const f = await c.get(`/ehr/patients/${pid}/notes/new?type=progress&format=${format}`);
    assert.match(f.text, /<select id="mse_mood" name="mse_mood"/, format);
    const mse = f.text.indexOf('name="mse_mood"');
    assert.ok(mse > f.text.indexOf('name="plan"') && mse < f.text.indexOf('name="interventions"'), `${format}: MSE after Plan, before interventions`);
  }
  // Optional: signs without an MSE, and the empty section is hidden on the read view.
  const plain = await create(c, progress());
  assert.equal((await c.post(`/ehr/notes/${plain}/sign`, { password: PW })).status, 302);
  assert.equal(status(plain), "signed");
  assert.doesNotMatch((await c.get(`/ehr/notes/${plain}`)).text, /Mental status exam/);
  // With values it saves plain strings and shows them.
  const soap = { type: "progress", format: "soap", session_start: "11:00", session_end: "11:50", subjective: "Feeling calmer this week overall",
    objective: "Calm, engaged", assessment: "Improving steadily", plan: "Continue CBT next week", interventions: ["CBT"], risk_level: "low",
    mse_mood: "Anxious", mse_affect: "__other", mse_affect_other: "Bright" };
  const id = await create(c, soap);
  const k = content(id);
  assert.equal(k.mse_mood, "Anxious");
  assert.equal(k.mse_affect, "Bright");
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Mental status exam/);
  assert.match(v.text, /Bright/);
});

test("intake MSE stays required for AHCCCS psychiatry; progress MSE never required for AHCCCS members", async () => {
  const { signErrors } = require("../src/routes/notes");
  const note = (type, format, c, extra = {}) => ({ type, format, content: JSON.stringify(c), risk_level: "low", service_date: "2026-11-02", ...extra });
  const prog = signErrors(note("progress", "dap", { data: "x", assessment: "y", plan: "z", interventions: ["CBT"], session_start: "10:00", session_end: "10:50" }), { ahcccs: true });
  assert.equal(prog.mse, undefined);
  const psy = signErrors(note("psychiatry", "soap", {}), { ahcccs: true });
  assert.match(psy.mse, /Mental status exam/);
});
