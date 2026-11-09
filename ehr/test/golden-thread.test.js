"use strict";
/* Golden thread: session notes record which active treatment plan objectives they addressed. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid, otherPid, objA, objB, otherObj;

const noteIdFrom = (res) => Number((res.location || "").match(/\/ehr\/notes\/(\d+)$/)[1]);

/** Build an active plan (problem > goal > objectives) directly in the DB. Returns objective ids. */
function makePlan(patientId, authorId, problem, objectives, status = "active") {
  const db = t.db;
  db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(patientId);
  const plan = Number(db.prepare("INSERT INTO treatment_plans (patient_id, author_id, status, start_date) VALUES (?, ?, ?, '2026-10-01')")
    .run(patientId, authorId, status).lastInsertRowid);
  const prob = Number(db.prepare("INSERT INTO plan_problems (plan_id, sort, title) VALUES (?, 0, ?)").run(plan, problem).lastInsertRowid);
  const goal = Number(db.prepare("INSERT INTO plan_goals (problem_id, sort, client_words, goal_text) VALUES (?, 0, 'Feel like myself', ?)")
    .run(prob, `${problem} goal`).lastInsertRowid);
  return objectives.map((text, i) => Number(db.prepare(
    "INSERT INTO plan_objectives (goal_id, sort, text, target_date, status) VALUES (?, ?, ?, '2027-01-15', 'progressing')")
    .run(goal, i, text).lastInsertRowid));
}

const dap = (extra = {}) => ({
  type: "progress", format: "dap", service_date: "2026-11-02", session_start: "10:00", session_end: "10:50",
  data: "Synthetic data", assessment: "Synthetic assessment", plan: "Synthetic plan", interventions: ["CBT"], risk_level: "low", ...extra,
});
const links = (noteId) => t.db.prepare("SELECT objective_id, progress, comment FROM note_objectives WHERE note_id = ? ORDER BY objective_id").all(noteId);

before(async () => {
  t = await start();
  pid = t.ctx.patients[2];
  otherPid = t.ctx.patients[3];
  const author = t.ctx.users.therapist;
  [objA, objB] = makePlan(pid, author, "Depressed mood", ["PHQ-9 below 10 by January", "Walk 3 times per week"]);
  [otherObj] = makePlan(otherPid, author, "Other patient problem", ["Other patient objective"]);
});
after(async () => { await t.stop(); });

test("progress, group and psychiatry forms list the active plan's objectives", async () => {
  const c = await t.login("therapist");
  for (const type of ["progress", "group", "psychiatry"]) {
    const r = await c.get(`/ehr/patients/${pid}/notes/new?type=${type}`);
    assert.equal(r.status, 200, type);
    assert.match(r.text, /Treatment plan objectives addressed/, type);
    assert.match(r.text, /<strong>Depressed mood<\/strong> › Depressed mood goal/, type);
    assert.match(r.text, /PHQ-9 below 10 by January/, type);
    assert.match(r.text, new RegExp(`name="obj_${objA}_addressed"`), type);
    assert.match(r.text, new RegExp(`name="obj_${objB}_progress"`), type);
    assert.match(r.text, /status: Progressing/, type);
    assert.doesNotMatch(r.text, /Other patient objective/, type);
  }
  // Not on other note types.
  const intake = await c.get(`/ehr/patients/${pid}/notes/new?type=intake`);
  assert.doesNotMatch(intake.text, /Treatment plan objectives addressed/);
});

test("saving with addressed objectives stores note_objectives; read view lists them", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, dap({
    [`obj_${objA}_addressed`]: "1", [`obj_${objA}_progress`]: "progressing", [`obj_${objA}_comment`]: "PHQ-9 down to 12",
    [`obj_${objB}_progress`]: "regressed", // not ticked: ignored
  }));
  assert.equal(r.status, 302, r.text.slice(0, 400));
  const id = noteIdFrom(r);
  assert.deepEqual(links(id).map((x) => ({ ...x })), [{ objective_id: objA, progress: "progressing", comment: "PHQ-9 down to 12" }]);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Treatment plan objectives addressed/);
  assert.match(v.text, /PHQ-9 below 10 by January · <strong>Progressing<\/strong>/);
  assert.match(v.text, /PHQ-9 down to 12/);
  assert.doesNotMatch(v.text, /Walk 3 times per week/);
  // Notes never change the objective's status on the plan.
  assert.equal(t.db.prepare("SELECT status FROM plan_objectives WHERE id = ?").get(objA).status, "progressing");
  // Edit form shows the saved selection.
  const ef = await c.get(`/ehr/notes/${id}/edit`);
  assert.match(ef.text, new RegExp(`name="obj_${objA}_addressed" value="1" checked`));
  assert.match(ef.text, /value="PHQ-9 down to 12"/);
});

test("objective from another patient's plan is rejected with 400", async () => {
  const c = await t.login("therapist");
  const before = t.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n;
  const r = await c.post(`/ehr/patients/${pid}/notes`, dap({ [`obj_${otherObj}_addressed`]: "1" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /aren&#39;t on this patient&#39;s active treatment plan/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, before);
  // Invalid progress value also rejected.
  const bad = await c.post(`/ehr/patients/${pid}/notes`, dap({ [`obj_${objA}_addressed`]: "1", [`obj_${objA}_progress`]: "great" }));
  assert.equal(bad.status, 400);
  // And on edit.
  const ok = await c.post(`/ehr/patients/${pid}/notes`, dap());
  const id = noteIdFrom(ok);
  const e = await c.post(`/ehr/notes/${id}/edit`, dap({ [`obj_${otherObj}_addressed`]: "1" }));
  assert.equal(e.status, 400);
  assert.equal(links(id).length, 0);
});

test("signing requires an addressed objective when the patient has an active plan", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, dap());
  const id = noteIdFrom(r);
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Select at least one treatment plan objective addressed in this session\./);
  assert.equal(t.db.prepare("SELECT status FROM notes WHERE id = ?").get(id).status, "draft");
  assert.equal((await c.post(`/ehr/notes/${id}/edit`, dap({ [`obj_${objB}_addressed`]: "1", [`obj_${objB}_progress`]: "no_change" }))).status, 302);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  assert.equal(t.db.prepare("SELECT status FROM notes WHERE id = ?").get(id).status, "signed");
});

test("without an active plan: warning shown, signing allowed", async () => {
  const c = await t.login("therapist");
  const noPlanPid = t.ctx.patients[4];
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(noPlanPid);
  const f = await c.get(`/ehr/patients/${noPlanPid}/notes/new?type=progress`);
  assert.match(f.text, /No active treatment plan\. Payers expect a plan before ongoing therapy\./);
  assert.match(f.text, new RegExp(`href="/ehr/patients/${noPlanPid}/treatment-plan"`));
  assert.doesNotMatch(f.text, /_addressed"/);
  const r = await c.post(`/ehr/patients/${noPlanPid}/notes`, dap());
  assert.equal(r.status, 302);
  const id = noteIdFrom(r);
  assert.match((await c.get(`/ehr/notes/${id}`)).text, /No active treatment plan/);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
});

test("edit replaces the set of addressed objectives", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, dap({ [`obj_${objA}_addressed`]: "1", [`obj_${objB}_addressed`]: "1" }));
  const id = noteIdFrom(r);
  assert.deepEqual(links(id).map((x) => x.objective_id), [objA, objB]);
  const e = await c.post(`/ehr/notes/${id}/edit`, dap({ [`obj_${objB}_addressed`]: "1", [`obj_${objB}_progress`]: "met", [`obj_${objB}_comment`]: "x".repeat(800) }));
  assert.equal(e.status, 302);
  const after = links(id);
  assert.deepEqual(after.map((x) => x.objective_id), [objB]);
  assert.equal(after[0].progress, "met");
  assert.equal(after[0].comment.length, 500);
  // Unticking everything clears the set.
  await c.post(`/ehr/notes/${id}/edit`, dap());
  assert.equal(links(id).length, 0);
});

test("signed note's objective links can't change", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, dap({ [`obj_${objA}_addressed`]: "1", [`obj_${objA}_progress`]: "progressing" }));
  const id = noteIdFrom(r);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const e = await c.post(`/ehr/notes/${id}/edit`, dap({ [`obj_${objB}_addressed`]: "1" }));
  assert.equal(e.status, 403);
  assert.deepEqual(links(id).map((x) => x.objective_id), [objA]);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /PHQ-9 below 10 by January · <strong>Progressing<\/strong>/);
});

test("group and psychiatry notes follow the same sign rule", async () => {
  const c = await t.login("prescriber");
  const psych = {
    type: "psychiatry", format: "soap", service_date: "2026-11-02", chief_complaint: "Follow-up", interval_history: "Stable",
    assessment: "Improving", plan_medications: "Continue", plan_followup: "4 weeks", risk_level: "none",
  };
  const r = await c.post(`/ehr/patients/${pid}/notes`, psych);
  const id = noteIdFrom(r);
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Select at least one treatment plan objective/);
  assert.equal((await c.post(`/ehr/notes/${id}/edit`, { ...psych, [`obj_${objA}_addressed`]: "1" })).status, 302);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  // Intake notes are not plan-linked: no objective requirement.
  const intake = await c.post(`/ehr/patients/${pid}/notes`, { type: "intake", format: "intake", service_date: "2026-11-02",
    presenting_problem: "x", hpi: "x", diagnostic_impression: "x", recommendations: "x", risk_level: "none" });
  assert.equal((await c.post(`/ehr/notes/${noteIdFrom(intake)}/sign`, { password: PW })).status, 302);
});
