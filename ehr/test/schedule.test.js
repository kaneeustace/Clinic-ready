"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const FUTURE = addDays(today(), 60);
const PAST = addDays(today(), -40);

function form(overrides = {}) {
  return {
    patient_id: t.ctx.patients[0],
    clinician_id: t.ctx.users.therapist,
    date: FUTURE,
    time: "10:00",
    duration: "50",
    type: "therapy",
    modality: "in_person",
    location: "Office 2",
    telehealth_url: "",
    notes: "",
    repeat_weeks: "1",
    ...overrides,
  };
}
const lastAudit = (action, entityId) => t.db.prepare(
  "SELECT * FROM audit_log WHERE action = ? AND entity_type = 'appointment' AND entity_id = ? ORDER BY id DESC").get(action, entityId);

test("week view renders with appointments, filter defaults and navigation", async () => {
  const c = await t.login("therapist");
  const r = await c.get("/ehr/schedule");
  assert.equal(r.status, 200);
  assert.match(r.text, /class="cal"/);
  assert.match(r.text, /cal__day--today/);
  assert.match(r.text, /class="appt appt--/);
  assert.match(r.text, /Prev/);
  // Defaults to the logged-in clinician: only their appointments appear.
  const ids = [...r.text.matchAll(/href="\/ehr\/appointments\/(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.equal(t.db.prepare("SELECT clinician_id FROM appointments WHERE id = ?").get(id).clinician_id, t.ctx.users.therapist);
  }
  const all = await c.get("/ehr/schedule?clinician=all");
  const allIds = [...all.text.matchAll(/href="\/ehr\/appointments\/(\d+)"/g)];
  assert.ok(allIds.length > ids.length);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'schedule' AND user_id = ?").get(c.userId));
  // Bad date falls back to today; day view renders a table.
  assert.equal((await c.get("/ehr/schedule?date=nope")).status, 200);
  const day = await c.get(`/ehr/schedule?view=day&clinician=all&date=${today()}`);
  assert.equal(day.status, 200);
  assert.match(day.text, /<table class="table">|No appointments on this day/);
});

test("frontdesk defaults to all clinicians; day view has quick actions", async () => {
  const c = await t.login("frontdesk");
  const r = await c.get(`/ehr/schedule?view=day&date=${addDays(today(), -1)}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<option value="all" selected>/);
});

test("create appointment: happy path, audit, detail and chart tab", async () => {
  const c = await t.login("frontdesk");
  const nf = await c.get(`/ehr/schedule/new?patient_id=${t.ctx.patients[0]}&date=${FUTURE}`);
  assert.equal(nf.status, 200);
  assert.match(nf.text, new RegExp(`value="${FUTURE}"`));
  // Patients sorted by last name: Brooks before Rivera.
  assert.ok(nf.text.indexOf("Brooks") < nf.text.indexOf("Rivera, Jordan"));

  const r = await c.post("/ehr/schedule", form({ notes: "Prefers morning reminder" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const id = Number(r.location.match(/\/ehr\/appointments\/(\d+)$/)[1]);
  const a = t.db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
  assert.equal(a.start_at, `${FUTURE}T10:00`);
  assert.equal(a.end_at, `${FUTURE}T10:50`);
  assert.equal(a.status, "scheduled");
  assert.equal(a.created_by, c.userId);
  const au = lastAudit("create", id);
  assert.ok(au);
  assert.equal(au.patient_id, t.ctx.patients[0]);

  const d = await c.get(`/ehr/appointments/${id}`);
  assert.equal(d.status, 200);
  assert.match(d.text, /Appointment scheduled/);
  assert.match(d.text, /Prefers morning reminder/);
  assert.ok(lastAudit("view", id));
  // Frontdesk has no clinical:write -> no note link.
  assert.doesNotMatch(d.text, /notes\/new\?appointment_id=/);

  const th = await t.login("therapist");
  const d2 = await th.get(`/ehr/appointments/${id}`);
  assert.match(d2.text, new RegExp(`/ehr/patients/${t.ctx.patients[0]}/notes/new\\?appointment_id=${id}`));

  const tab = await c.get(`/ehr/patients/${t.ctx.patients[0]}/appointments`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Upcoming appointments/);
  assert.match(tab.text, /Schedule appointment/);
  assert.match(tab.text, new RegExp(`/ehr/appointments/${id}"`));
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'appointment' AND entity_id IS NULL AND patient_id = ?").get(t.ctx.patients[0]));
  assert.equal((await c.get("/ehr/patients/999999/appointments")).status, 404);
  assert.equal((await c.get("/ehr/appointments/999999")).status, 404);
});

test("create validation re-renders with values and messages", async () => {
  const c = await t.login("frontdesk");
  const before = t.db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n;
  const r = await c.post("/ehr/schedule", form({ patient_id: "", date: "2026-02-30", type: "bogus", telehealth_url: "http://insecure.example", location: "Room <9>" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Choose a patient/);
  assert.match(r.text, /Enter a valid date/);
  assert.match(r.text, /Choose an appointment type/);
  assert.match(r.text, /https:\/\/ URL/);
  assert.match(r.text, /value="Room &lt;9&gt;"/);
  const r2 = await c.post("/ehr/schedule", form({ duration: "17", repeat_weeks: "13", time: "25:00" }));
  assert.equal(r2.status, 400);
  assert.match(r2.text, /Choose a duration/);
  assert.match(r2.text, /Repeat must be between 1 and 12/);
  const r3 = await c.post("/ehr/schedule", form({ time: "23:30", duration: "60" }));
  assert.equal(r3.status, 400);
  assert.match(r3.text, /same day/);
  const r4 = await c.post("/ehr/schedule", form({ clinician_id: t.ctx.users.frontdesk }));
  assert.equal(r4.status, 400);
  assert.match(r4.text, /active clinician/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n, before);
});

test("overlapping appointment is refused; cancelled ones do not block", async () => {
  const c = await t.login("frontdesk");
  const date = addDays(FUTURE, 1);
  const r = await c.post("/ehr/schedule", form({ date, time: "13:00" }));
  assert.equal(r.status, 302);
  const id = Number(r.location.split("/").pop());
  const r2 = await c.post("/ehr/schedule", form({ date, time: "13:30", patient_id: t.ctx.patients[1] }));
  assert.equal(r2.status, 409);
  assert.match(r2.text, /Scheduling conflict/);
  assert.match(r2.text, /value="13:30"/);
  // Back-to-back is fine.
  const r3 = await c.post("/ehr/schedule", form({ date, time: "13:50", duration: "30", patient_id: t.ctx.patients[1] }));
  assert.equal(r3.status, 302);
  // Different clinician same time is fine.
  const r4 = await c.post("/ehr/schedule", form({ date, time: "13:00", clinician_id: t.ctx.users.therapist2 }));
  assert.equal(r4.status, 302);
  // Cancel the first; the slot frees up.
  const s = await c.post(`/ehr/appointments/${id}/status`, { status: "cancelled", reason: "Patient called" });
  assert.equal(s.status, 302);
  const r5 = await c.post("/ehr/schedule", form({ date, time: "13:00", patient_id: t.ctx.patients[2] }));
  assert.equal(r5.status, 302);
  // Restoring the cancelled one would now double-book.
  await c.post(`/ehr/appointments/${id}/status`, { status: "scheduled" });
  assert.equal(t.db.prepare("SELECT status FROM appointments WHERE id = ?").get(id).status, "cancelled");
});

test("weekly series creates in one go and skips conflicts", async () => {
  const c = await t.login("frontdesk");
  const base = addDays(FUTURE, 14);
  // Pre-existing block in week 3.
  const blocker = await c.post("/ehr/schedule", form({ date: addDays(base, 14), time: "08:00", duration: "90", patient_id: t.ctx.patients[3] }));
  assert.equal(blocker.status, 302);
  const r = await c.post("/ehr/schedule", form({ date: base, time: "08:30", repeat_weeks: "4", patient_id: t.ctx.patients[4] }));
  assert.equal(r.status, 302);
  const rows = t.db.prepare("SELECT start_at FROM appointments WHERE patient_id = ? AND start_at >= ? ORDER BY start_at").all(t.ctx.patients[4], base);
  assert.deepEqual(rows.map((x) => x.start_at), [base, addDays(base, 7), addDays(base, 21)].map((d) => `${d}T08:30`));
  const d = await c.get(r.location);
  assert.match(d.text, /Scheduled 3 of 4 weekly appointments/);
  assert.match(d.text, /Skipped because of scheduling conflicts/);
});

test("edit / reschedule with conflict check excluding itself", async () => {
  const c = await t.login("frontdesk");
  const date = addDays(FUTURE, 3);
  const a = Number((await c.post("/ehr/schedule", form({ date, time: "09:00" }))).location.split("/").pop());
  const b = Number((await c.post("/ehr/schedule", form({ date, time: "11:00", patient_id: t.ctx.patients[1] }))).location.split("/").pop());
  const ef = await c.get(`/ehr/appointments/${a}/edit`);
  assert.equal(ef.status, 200);
  assert.match(ef.text, /value="09:00"/);
  // Shift within own slot: no self-conflict.
  const r1 = await c.post(`/ehr/appointments/${a}/edit`, form({ date, time: "09:15" }));
  assert.equal(r1.status, 302);
  assert.equal(t.db.prepare("SELECT start_at FROM appointments WHERE id = ?").get(a).start_at, `${date}T09:15`);
  assert.ok(lastAudit("reschedule", a));
  // Move onto b: conflict.
  const r2 = await c.post(`/ehr/appointments/${a}/edit`, form({ date, time: "10:30" }));
  assert.equal(r2.status, 409);
  assert.match(r2.text, /Scheduling conflict/);
  assert.match(r2.text, new RegExp(`/ehr/appointments/${b}`));
  // Validation on edit.
  const r3 = await c.post(`/ehr/appointments/${a}/edit`, form({ date, time: "", telehealth_url: "javascript:alert(1)" }));
  assert.equal(r3.status, 400);
  // Patient cannot be changed by edit.
  await c.post(`/ehr/appointments/${a}/edit`, form({ date, time: "09:15", patient_id: t.ctx.patients[5], location: "Office 4" }));
  const row = t.db.prepare("SELECT patient_id, location FROM appointments WHERE id = ?").get(a);
  assert.equal(row.patient_id, t.ctx.patients[0]);
  assert.equal(row.location, "Office 4");
});

test("status changes: past-only rules, cancel reason, audit", async () => {
  const c = await t.login("frontdesk");
  const fut = Number((await c.post("/ehr/schedule", form({ date: addDays(FUTURE, 5), time: "15:00" }))).location.split("/").pop());
  const past = Number((await c.post("/ehr/schedule", form({ date: PAST, time: "15:00" }))).location.split("/").pop());
  const st = (id) => t.db.prepare("SELECT status, notes FROM appointments WHERE id = ?").get(id);

  await c.post(`/ehr/appointments/${fut}/status`, { status: "completed" });
  assert.equal(st(fut).status, "scheduled");
  await c.post(`/ehr/appointments/${fut}/status`, { status: "no_show" });
  assert.equal(st(fut).status, "scheduled");
  await c.post(`/ehr/appointments/${fut}/status`, { status: "bogus" });
  assert.equal(st(fut).status, "scheduled");

  await c.post(`/ehr/appointments/${fut}/status`, { status: "cancelled", reason: "" });
  assert.equal(st(fut).status, "scheduled");
  const r = await c.post(`/ehr/appointments/${fut}/status`, { status: "late_cancel", reason: "Car trouble" });
  assert.equal(r.status, 302);
  assert.equal(st(fut).status, "late_cancel");
  assert.match(st(fut).notes, /Late cancel .* Car trouble/);
  const au = lastAudit("status", fut);
  assert.equal(au.detail, "scheduled -> late_cancel");
  assert.doesNotMatch(au.detail, /Car trouble/);
  // Cancelled appointments can't be edited.
  const e = await c.get(`/ehr/appointments/${fut}/edit`);
  assert.equal(e.status, 302);

  const r2 = await c.post(`/ehr/appointments/${past}/status`, { status: "checked_in", return_to: "/ehr/schedule?view=day" });
  assert.equal(r2.location, "/ehr/schedule?view=day");
  const dv = await c.get(`/ehr/schedule?view=day&clinician=all&date=${PAST}`);
  assert.match(dv.text, new RegExp(`action="/ehr/appointments/${past}/status"`));
  assert.match(dv.text, /value="completed"/);
  assert.match(dv.text, /No-show/);
  await c.post(`/ehr/appointments/${past}/status`, { status: "completed", return_to: "https://evil.example/" });
  assert.equal(st(past).status, "completed");

  // Same-day completion is allowed.
  const sameDay = Number((await c.post("/ehr/schedule", form({ date: today(), time: "23:00", duration: "30" }))).location.split("/").pop());
  await c.post(`/ehr/appointments/${sameDay}/status`, { status: "no_show" });
  assert.equal(st(sameDay).status, "no_show");
});

test("billing can view but not write (403)", async () => {
  const c = await t.login("billing");
  assert.equal((await c.get("/ehr/schedule")).status, 200);
  const anyId = t.db.prepare("SELECT id, patient_id FROM appointments ORDER BY id LIMIT 1").get();
  const d = await c.get(`/ehr/appointments/${anyId.id}`);
  assert.equal(d.status, 200);
  assert.doesNotMatch(d.text, /Update status/);
  assert.equal((await c.get(`/ehr/patients/${anyId.patient_id}/appointments`)).status, 200);
  assert.equal((await c.get("/ehr/schedule/new")).status, 403);
  const before = t.db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n;
  assert.equal((await c.post("/ehr/schedule", form({ date: addDays(FUTURE, 9) }))).status, 403);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n, before);
  assert.equal((await c.get(`/ehr/appointments/${anyId.id}/edit`)).status, 403);
  assert.equal((await c.post(`/ehr/appointments/${anyId.id}/edit`, form())).status, 403);
  assert.equal((await c.post(`/ehr/appointments/${anyId.id}/status`, { status: "cancelled", reason: "x" })).status, 403);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'forbidden' AND user_id = ?").get(c.userId));
});

test("unauthenticated access redirects to login", async () => {
  const r = await t.client().get("/ehr/schedule");
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/ehr\/login/);
});
