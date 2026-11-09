"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid;

before(async () => {
  t = await start();
  pid = t.ctx.patients[0];
  // Keep these note-flow tests independent of seeded treatment plans (the golden-thread sign rule
  // is covered in golden-thread.test.js).
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
  // Progress/group notes require an active plan; give this patient a minimal active plan (no objectives).
  t.db.prepare("INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at) VALUES (?, ?, 'active', date('now'), date('now', '+90 days'), datetime('now'))").run(pid, t.ctx.users.therapist);
});
after(async () => { await t.stop(); });

const noteIdFrom = (res) => Number((res.location || "").match(/\/ehr\/notes\/(\d+)$/)[1]);
const lastAudit = (action, noteId) =>
  t.db.prepare("SELECT * FROM audit_log WHERE action = ? AND entity_type = 'note' AND entity_id IS ? ORDER BY id DESC").get(action, noteId);

async function createDap(c, extra = {}) {
  const r = await c.post(`/ehr/patients/${pid}/notes`, {
    type: "progress", format: "dap", service_date: "2026-11-02", session_start: "10:00", session_end: "10:50",
    data: "Synthetic data section", assessment: "", plan: "Synthetic plan", interventions: ["CBT", "Mindfulness"],
    risk_level: "low", risk_narrative: "", ...extra,
  });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  return noteIdFrom(r);
}

test("patient notes tab lists notes and is audited", async () => {
  const c = await t.login("therapist");
  const r = await c.get(`/ehr/patients/${pid}/notes`);
  assert.equal(r.status, 200);
  assert.match(r.text, /New note/);
  assert.match(r.text, /Progress note/);
  const row = t.db.prepare("SELECT * FROM audit_log WHERE action = 'view' AND entity_type = 'note' AND patient_id = ? AND user_id = ?").get(pid, c.userId);
  assert.ok(row);
});

test("new form prefills from an appointment and rejects another patient's appointment", async () => {
  const c = await t.login("therapist");
  const appt = t.db.prepare("SELECT * FROM appointments WHERE patient_id = ? ORDER BY id LIMIT 1").get(pid);
  const r = await c.get(`/ehr/patients/${pid}/notes/new?type=progress&appointment_id=${appt.id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`name="service_date" value="${appt.start_at.slice(0, 10)}"`));
  assert.match(r.text, /Data/);
  const soap = await c.get(`/ehr/patients/${pid}/notes/new?type=progress&format=soap`);
  assert.match(soap.text, /Subjective/);
  const other = t.db.prepare("SELECT * FROM appointments WHERE patient_id <> ? LIMIT 1").get(pid);
  const bad = await c.get(`/ehr/patients/${pid}/notes/new?type=progress&appointment_id=${other.id}`);
  assert.equal(bad.status, 302);
  const badPost = await c.post(`/ehr/patients/${pid}/notes`, { type: "progress", format: "dap", service_date: "2026-11-02", appointment_id: other.id });
  assert.equal(badPost.status, 400);
});

test("every note type renders its form", async () => {
  const c = await t.login("prescriber");
  for (const [type, marker] of [["intake", /Presenting problem/], ["psychiatry", /Chief complaint/], ["psychotherapy", /kept separate from the medical record/],
    ["contact", /Narrative/], ["discharge", /Reason for discharge/]]) {
    const r = await c.get(`/ehr/patients/${pid}/notes/new?type=${type}`);
    assert.equal(r.status, 200, type);
    assert.match(r.text, marker, type);
  }
  const intake = await c.get(`/ehr/patients/${pid}/notes/new?type=intake`);
  assert.match(intake.text, /Thought content/);
});

test("validation errors re-render with 400", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, { type: "progress", format: "dap", service_date: "not-a-date", session_start: "11:00", session_end: "10:00" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Use YYYY-MM-DD/);
  assert.match(r.text, /End time must be after start time/);
});

test("create, edit, sign flow; signed note is immutable", async () => {
  const c = await t.login("therapist");
  const id = await createDap(c);
  let note = t.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  assert.equal(note.status, "draft");
  assert.equal(note.author_id, c.userId);
  assert.deepEqual(JSON.parse(note.content).interventions, ["CBT", "Mindfulness"]);
  assert.ok(lastAudit("create", id));

  // Sign fails while Assessment is empty.
  let s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Assessment is required/);

  const editForm = await c.get(`/ehr/notes/${id}/edit`);
  assert.equal(editForm.status, 200);
  assert.match(editForm.text, /Synthetic data section/);

  // Moderate risk requires a narrative to sign.
  let e = await c.post(`/ehr/notes/${id}/edit`, {
    service_date: "2026-11-02", session_start: "10:00", session_end: "10:50", data: "Synthetic data section",
    assessment: "Synthetic assessment", plan: "Synthetic plan", interventions: "CBT", risk_level: "moderate", risk_narrative: "",
  });
  assert.equal(e.status, 302);
  assert.ok(lastAudit("update", id));
  s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /risk narrative is required/i);

  e = await c.post(`/ehr/notes/${id}/edit`, {
    service_date: "2026-11-02", session_start: "10:00", session_end: "10:50", data: "Synthetic data section",
    assessment: "Synthetic assessment", plan: "Synthetic plan", interventions: "CBT", risk_level: "moderate",
    risk_narrative: "Passive SI, no plan or intent; safety plan reviewed.",
  });
  assert.equal(e.status, 302);

  // Wrong password fails.
  s = await c.post(`/ehr/notes/${id}/sign`, { password: "wrong-password" });
  assert.equal(s.status, 400);
  assert.match(s.text, /Password is incorrect/);
  assert.equal(t.db.prepare("SELECT status FROM notes WHERE id = ?").get(id).status, "draft");
  assert.ok(lastAudit("sign_failed", id));

  s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 302);
  note = t.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  assert.equal(note.status, "signed");
  assert.equal(note.signed_by, c.userId);
  assert.ok(note.signed_at);
  assert.ok(lastAudit("sign", id));

  const view = await c.get(`/ehr/notes/${id}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /Electronically signed by Taylor Therapist, LCSW on /);
  assert.match(view.text, /data-print/);
  assert.ok(lastAudit("view", id));

  // Immutable.
  assert.equal((await c.get(`/ehr/notes/${id}/edit`)).status, 403);
  const blocked = await c.post(`/ehr/notes/${id}/edit`, { service_date: "2026-11-03", data: "changed" });
  assert.equal(blocked.status, 403);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 403);
  assert.equal((await c.post(`/ehr/notes/${id}/delete`)).status, 403);
  note = t.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  assert.equal(note.service_date, "2026-11-02");
  assert.match(note.content, /Synthetic data section/);

  // Shows in My notes as signed.
  const mine = await c.get("/ehr/notes");
  assert.equal(mine.status, 200);
  assert.match(mine.text, new RegExp(`/ehr/notes/${id}"`));
});

test("only the author may edit, sign or delete a draft", async () => {
  const author = await t.login("therapist");
  const other = await t.login("therapist2");
  const id = await createDap(author, { assessment: "x" });
  assert.equal((await other.get(`/ehr/notes/${id}/edit`)).status, 403);
  assert.equal((await other.post(`/ehr/notes/${id}/edit`, { service_date: "2026-11-02" })).status, 403);
  assert.equal((await other.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 403);
  assert.equal((await other.post(`/ehr/notes/${id}/delete`)).status, 403);
  // Drafts are listed first in the author's My notes.
  const mine = await author.get("/ehr/notes");
  assert.match(mine.text, /Unsigned drafts/);
  assert.ok(mine.text.indexOf(`/ehr/notes/${id}"`) < mine.text.indexOf("Recently signed"));
  // Author can delete.
  const d = await author.post(`/ehr/notes/${id}/delete`);
  assert.equal(d.status, 302);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = ?").get(id).n, 0);
  assert.ok(lastAudit("delete", id));
});

test("addenda on signed notes only, by any clinician", async () => {
  const author = await t.login("therapist");
  const other = await t.login("prescriber");
  const draftId = await createDap(author, { assessment: "x" });
  assert.equal((await other.post(`/ehr/notes/${draftId}/addenda`, { content: "nope" })).status, 403);
  assert.equal((await author.post(`/ehr/notes/${draftId}/sign`, { password: PW })).status, 302);
  assert.equal((await other.post(`/ehr/notes/${draftId}/addenda`, { content: "" })).status, 400);
  const r = await other.post(`/ehr/notes/${draftId}/addenda`, { content: "Synthetic addendum: collateral call received." });
  assert.equal(r.status, 302);
  const rows = t.db.prepare("SELECT * FROM note_addenda WHERE note_id = ?").all(draftId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].author_id, other.userId);
  assert.ok(lastAudit("addendum", draftId));
  const view = await author.get(`/ehr/notes/${draftId}`);
  assert.match(view.text, /Synthetic addendum: collateral call received\./);
  assert.match(view.text, /Addendum by Pat Prescriber, PMHNP-BC/);
});

test("psychotherapy notes are private to the author", async () => {
  const author = await t.login("therapist");
  const r = await author.post(`/ehr/patients/${pid}/notes`, { type: "psychotherapy", format: "narrative", service_date: "2026-11-02", process_notes: "Synthetic private process notes" });
  assert.equal(r.status, 302);
  const id = noteIdFrom(r);
  const own = await author.get(`/ehr/notes/${id}`);
  assert.equal(own.status, 200);
  assert.match(own.text, /kept separate from the medical record/);
  assert.match((await author.get(`/ehr/patients/${pid}/notes`)).text, new RegExp(`/ehr/notes/${id}"`));

  for (const key of ["therapist2", "admin"]) {
    const c = await t.login(key);
    const v = await c.get(`/ehr/notes/${id}`);
    assert.equal(v.status, 403, key);
    assert.doesNotMatch(v.text, /Synthetic private process notes/);
    const list = await c.get(`/ehr/patients/${pid}/notes`);
    assert.equal(list.status, 200);
    assert.doesNotMatch(list.text, new RegExp(`/ehr/notes/${id}"`), key);
    assert.doesNotMatch(list.text.split("<tbody>")[1] || "", /Psychotherapy note/, key);
    assert.equal((await c.post(`/ehr/notes/${id}/addenda`, { content: "x" })).status, 403);
  }
  // Signed psychotherapy note still private.
  assert.equal((await author.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const admin = await t.login("admin");
  assert.equal((await admin.get(`/ehr/notes/${id}`)).status, 403);
});

test("frontdesk and billing have no clinical access", async () => {
  const note = t.db.prepare("SELECT id FROM notes WHERE type <> 'psychotherapy' LIMIT 1").get();
  for (const key of ["frontdesk", "billing"]) {
    const c = await t.login(key);
    assert.equal((await c.get(`/ehr/patients/${pid}/notes`)).status, 403, key);
    assert.equal((await c.get(`/ehr/patients/${pid}/notes/new?type=progress`)).status, 403, key);
    assert.equal((await c.post(`/ehr/patients/${pid}/notes`, { type: "progress", service_date: "2026-11-02" })).status, 403, key);
    assert.equal((await c.get(`/ehr/notes/${note.id}`)).status, 403, key);
    assert.equal((await c.get("/ehr/notes")).status, 403, key);
    assert.equal((await c.post(`/ehr/notes/${note.id}/addenda`, { content: "x" })).status, 403, key);
  }
});

test("seeded notes exist with signed and draft notes", () => {
  const signed = t.db.prepare("SELECT COUNT(*) AS n FROM notes n JOIN appointments a ON a.id = n.appointment_id WHERE n.status = 'signed' AND a.status = 'completed'").get().n;
  assert.ok(signed >= 1);
  assert.ok(t.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'draft' AND appointment_id IS NOT NULL").get().n >= 1);
});

test("audit detail contains no note content", () => {
  const rows = t.db.prepare("SELECT detail FROM audit_log WHERE entity_type = 'note' AND detail IS NOT NULL").all();
  for (const r of rows) assert.doesNotMatch(r.detail, /Synthetic/);
});
