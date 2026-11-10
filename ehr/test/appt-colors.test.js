"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

test("each appointment type has its own color, shown on the schedule; admins can change and reset", async () => {
  const admin = await t.login("admin");
  let sched = await admin.get("/ehr/schedule");
  assert.match(sched.text, /class="appt-legend"/);
  assert.match(sched.text, /--appt:#315de7/); // default therapy color
  const page = await admin.get("/ehr/admin/appointment-colors");
  assert.equal(page.status, 200);
  assert.match(page.text, /type="color"/);
  let r = await admin.post("/ehr/admin/appointment-colors", { therapy: "#DC2626", intake: "not-a-color" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT color FROM appointment_type_colors WHERE type = 'therapy'").get().color, "#dc2626");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM appointment_type_colors WHERE type = 'intake'").get().n, 0);
  sched = await admin.get("/ehr/schedule");
  assert.match(sched.text, /--appt:#dc2626/);
  r = await admin.post("/ehr/admin/appointment-colors", { reset: "1" });
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM appointment_type_colors").get().n, 0);
  const clin = await t.login("therapist");
  assert.equal((await clin.post("/ehr/admin/appointment-colors", { therapy: "#000000" })).status, 403);
  assert.doesNotMatch((await clin.get("/ehr/schedule")).text, /Change colors/);
});
