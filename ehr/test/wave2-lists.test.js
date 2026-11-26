"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const rows = (kind) => t.db.prepare("SELECT id, label, sort, active FROM clinic_lists WHERE kind = ? ORDER BY sort, label").all(kind);
const activeLabels = (kind) => rows(kind).filter((r) => r.active).map((r) => r.label);
const idOf = (kind, label) => t.db.prepare("SELECT id FROM clinic_lists WHERE kind = ? AND label = ?").get(kind, label).id;

test("Clinic lists page renders the three lists with defaults; linked from Administration", async () => {
  const admin = await t.login("admin");
  const r = await admin.get("/ehr/admin/lists");
  assert.equal(r.status, 200);
  assert.match(r.text, /Rooms and locations/);
  assert.match(r.text, /Programs and tracks/);
  assert.match(r.text, /Therapy groups/);
  assert.match(r.text, /value="Office 1"/);
  assert.match(r.text, /value="Relapse prevention"/);
  assert.match(r.text, /Move up/);
  assert.match((await admin.get("/ehr/admin")).text, /href="\/ehr\/admin\/lists"/);
});

test("add, rename, move and remove items, with validation and audit", async () => {
  const admin = await t.login("admin");
  await admin.get("/ehr/admin/lists");
  let r = await admin.post("/ehr/admin/lists", { action: "add", kind: "room", label: "  Office   7 " });
  assert.equal(r.status, 302);
  assert.deepEqual(activeLabels("room"), ["Office 1", "Office 2", "Group room", "Office 7"]);
  const id7 = idOf("room", "Office 7");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'clinic_lists' AND entity_id = ? AND action = 'update'").get(id7));

  // Duplicates (any case), blank and over-long names are refused.
  await admin.post("/ehr/admin/lists", { action: "add", kind: "room", label: "office 7" });
  await admin.post("/ehr/admin/lists", { action: "add", kind: "room", label: "" });
  await admin.post("/ehr/admin/lists", { action: "add", kind: "room", label: "x".repeat(81) });
  await admin.post("/ehr/admin/lists", { action: "add", kind: "nope", label: "X" });
  assert.equal(activeLabels("room").length, 4);
  // The same name is fine in another list.
  await admin.post("/ehr/admin/lists", { action: "add", kind: "group", label: "Office 7" });
  assert.ok(activeLabels("group").includes("Office 7"));

  r = await admin.post("/ehr/admin/lists", { action: "rename", id: id7, label: "Office 2" });
  assert.equal(activeLabels("room").filter((l) => l === "Office 2").length, 1);
  await admin.post("/ehr/admin/lists", { action: "rename", id: id7, label: "Telehealth suite" });
  assert.ok(activeLabels("room").includes("Telehealth suite"));

  await admin.post("/ehr/admin/lists", { action: "up", id: id7 });
  assert.deepEqual(activeLabels("room"), ["Office 1", "Office 2", "Telehealth suite", "Group room"]);
  await admin.post("/ehr/admin/lists", { action: "down", id: idOf("room", "Office 1") });
  assert.deepEqual(activeLabels("room"), ["Office 2", "Office 1", "Telehealth suite", "Group room"]);
  await admin.post("/ehr/admin/lists", { action: "up", id: idOf("room", "Office 2") }); // already first: no change
  assert.deepEqual(activeLabels("room"), ["Office 2", "Office 1", "Telehealth suite", "Group room"]);

  await admin.post("/ehr/admin/lists", { action: "remove", id: idOf("room", "Group room") });
  assert.deepEqual(activeLabels("room"), ["Office 2", "Office 1", "Telehealth suite"]);
  assert.equal(t.db.prepare("SELECT active FROM clinic_lists WHERE kind = 'room' AND label = 'Group room'").get().active, 0);
  const page = await admin.get("/ehr/admin/lists");
  assert.doesNotMatch(page.text, /value="Group room"/);
  // Adding a removed name back brings it back.
  await admin.post("/ehr/admin/lists", { action: "add", kind: "room", label: "Group room" });
  assert.deepEqual(activeLabels("room"), ["Office 2", "Office 1", "Telehealth suite", "Group room"]);
});

test("non-admins cannot see or change clinic lists", async () => {
  for (const key of ["frontdesk", "therapist"]) {
    const c = await t.login(key);
    assert.equal((await c.get("/ehr/admin/lists")).status, 403);
    assert.equal((await c.post("/ehr/admin/lists", { action: "add", kind: "room", label: "Hacked" })).status, 403);
  }
  assert.ok(!activeLabels("room").includes("Hacked"));
});

test("appointment Location is a room dropdown with off-site places and Other; old values still show", async () => {
  const admin = await t.login("admin");
  await admin.get("/ehr/admin/lists");
  await admin.post("/ehr/admin/lists", { action: "add", kind: "room", label: "Annex B" });
  const fd = await t.login("frontdesk");
  const f = await fd.get("/ehr/schedule/new");
  assert.equal(f.status, 200);
  assert.match(f.text, /<select id="location" name="location"/);
  assert.match(f.text, /<optgroup label="Rooms">[^]*<option value="Annex B">Annex B<\/option>[^]*<\/optgroup><optgroup label="Off site">/);
  assert.match(f.text, /Telehealth \(client&#39;s home\)|Telehealth \(client's home\)/);
  assert.match(f.text, /name="location_other"/);

  const base = {
    patient_id: t.ctx.patients[0], clinician_id: t.ctx.users.therapist, time: "07:00", duration: "50",
    type: "therapy", modality: "in_person", telehealth_url: "", notes: "", repeat_weeks: "1",
  };
  let r = await fd.post("/ehr/schedule", { ...base, date: addDays(today(), 71), location: "Annex B", location_other: "" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const id1 = Number(r.location.match(/appointments\/(\d+)/)[1]);
  assert.equal(t.db.prepare("SELECT location FROM appointments WHERE id = ?").get(id1).location, "Annex B");

  r = await fd.post("/ehr/schedule", { ...base, date: addDays(today(), 72), location: "__other", location_other: "Library study room" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const id2 = Number(r.location.match(/appointments\/(\d+)/)[1]);
  assert.equal(t.db.prepare("SELECT location FROM appointments WHERE id = ?").get(id2).location, "Library study room");

  // A free-text value saved earlier shows as Other with the text filled in on the edit form.
  const e = await fd.get(`/ehr/appointments/${id2}/edit`);
  assert.equal(e.status, 200);
  assert.match(e.text, /<option value="__other" selected>/);
  assert.match(e.text, /name="location_other" id="location_other" value="Library study room"/);
  assert.match((await fd.get(`/ehr/appointments/${id2}`)).text, /Library study room/);
});
