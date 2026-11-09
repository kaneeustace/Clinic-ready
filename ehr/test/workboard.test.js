"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");

const PW = "Test-Password-123!";
let t, pid;
before(async () => {
  t = await start();
  pid = t.ctx.patients[5];
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
  t.db.prepare("INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at) VALUES (?, ?, 'active', date('now'), date('now','+90 days'), datetime('now'))")
    .run(pid, t.ctx.users.therapist);
  // Casey becomes an associate-level counselor supervised by Taylor (LCSW).
  t.db.prepare("UPDATE users SET credentials = 'LAC', supervisor_id = ? WHERE id = ?").run(t.ctx.users.therapist, t.ctx.users.therapist2);
});
after(async () => { await t.stop(); });

const dap = (extra = {}) => ({ type: "progress", format: "dap", service_date: today(), session_start: "09:00", session_end: "09:53",
  data: "Reported panic twice this week; PHQ-9 12.", assessment: "Improving sleep.", plan: "Continue CBT.", interventions: ["CBT"], risk_level: "low", ...extra });
const noteIdFrom = (r) => Number(r.location.match(/(\d+)$/)[1]);

test("supervisee note: draft in progress, then waiting on supervisor, then done after co-sign", async () => {
  const casey = await t.login("therapist2");
  const r = await casey.post(`/ehr/patients/${pid}/notes`, dap());
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const id = noteIdFrom(r);
  let dash = await casey.get("/ehr");
  assert.match(dash.text, /Workboard/);
  assert.match(dash.text, /Waiting on your signature/);
  assert.match(dash.text, /data-deadline="/);

  assert.equal((await casey.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const n = t.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  assert.equal(n.cosign_required, 1);
  const hours = (Date.parse(n.cosign_due_at.replace(" ", "T") + "Z") - Date.parse(n.signed_at.replace(" ", "T") + "Z")) / 3.6e6;
  assert.equal(Math.round(hours), 48);
  dash = await casey.get("/ehr");
  assert.match(dash.text, /Waiting on Taylor Therapist&#39;s co-signature/);
  assert.match((await casey.get(`/ehr/notes/${id}`)).text, /Awaiting supervisor co-signature/);

  // Someone who isn't the supervisor can't co-sign
  const pat = await t.login("prescriber");
  assert.equal((await pat.post(`/ehr/notes/${id}/cosign`, { password: PW })).status, 403);

  const taylor = await t.login("therapist");
  dash = await taylor.get("/ehr");
  assert.match(dash.text, /Needs your co-signature/);
  assert.equal((await taylor.post(`/ehr/notes/${id}/cosign`, { password: PW, comment: "Agree." })).status, 302);
  assert.ok(t.db.prepare("SELECT cosigned_at FROM notes WHERE id = ?").get(id).cosigned_at);
  assert.match((await taylor.get(`/ehr/notes/${id}`)).text, /Co-signed by supervisor Taylor Therapist, LCSW/);
  assert.match((await taylor.get("/ehr")).text, /You co-signed/);
  assert.match((await casey.get("/ehr")).text, /Signed and co-signed/);
});

test("independently licensed clinicians don't need a co-signature", async () => {
  const taylor = await t.login("therapist");
  const id = noteIdFrom(await taylor.post(`/ehr/patients/${pid}/notes`, dap({ data: "Different content for an independent note; GAD-7 9." })));
  await taylor.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(t.db.prepare("SELECT cosign_required FROM notes WHERE id = ?").get(id).cosign_required, 0);
});

test("sessions without a note are To do with a 24-hour countdown; overdue items raise the alert", async () => {
  const casey = await t.login("therapist2");
  const day = today();
  const apptId = Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status)
    VALUES (?, ?, ?, ?, 'therapy', 'in_person', 'completed')`).run(pid, t.ctx.users.therapist2, `${day}T00:00`, `${day}T00:50`).lastInsertRowid);
  const dash = await casey.get("/ehr");
  assert.match(dash.text, new RegExp(`notes/new\\?appointment_id=${apptId}`));
  assert.match(dash.text, /Write note/);
  // An old session is overdue and shows in the alert
  const old = Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status)
    VALUES (?, ?, date('now','-3 days') || 'T09:00', date('now','-3 days') || 'T09:50', 'therapy', 'in_person', 'completed')`).run(pid, t.ctx.users.therapist2).lastInsertRowid);
  const d2 = await casey.get("/ehr");
  assert.match(d2.text, /Signatures due/);
  assert.match(d2.text, /Overdue by/);
  assert.match(d2.text, new RegExp(`appointment_id=${old}`));
});

test("admin sets supervisor and co-signature requirement", async () => {
  const admin = await t.login("admin");
  const page = await admin.get(`/ehr/admin/users/${t.ctx.users.prescriber}/edit`);
  assert.match(page.text, /Clinical supervisor/);
  const u = t.db.prepare("SELECT * FROM users WHERE id = ?").get(t.ctx.users.prescriber);
  const r = await admin.post(`/ehr/admin/users/${u.id}/edit`, { name: u.name, role: u.role, credentials: u.credentials, npi: u.npi || "",
    active: "1", supervisor_id: String(t.ctx.users.therapist), requires_cosign: "1" });
  assert.equal(r.status, 302, r.text.slice(0, 400));
  const after = t.db.prepare("SELECT supervisor_id, requires_cosign FROM users WHERE id = ?").get(u.id);
  assert.deepEqual([after.supervisor_id, after.requires_cosign], [t.ctx.users.therapist, 1]);
  // A supervisor must be able to supervise (billing user can't)
  const bad = await admin.post(`/ehr/admin/users/${u.id}/edit`, { name: u.name, role: u.role, credentials: u.credentials, active: "1",
    supervisor_id: String(t.ctx.users.billing) });
  assert.equal(bad.status, 400);
});
