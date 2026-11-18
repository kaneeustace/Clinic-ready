"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t;
before(async () => { t = await start(); });
after(async () => { delete process.env.EHR_SITE_MODE; await t.stop(); });

test("site root: sales page by default, clinic site or EHR by EHR_SITE_MODE", async () => {
  const c = t.client();
  let r = await c.get("/");
  assert.equal(r.status, 302);
  assert.equal(r.location, "/software");
  process.env.EHR_SITE_MODE = "ehr";
  assert.equal((await c.get("/")).location, "/ehr");
  process.env.EHR_SITE_MODE = "clinic";
  assert.equal((await c.get("/")).status, 200);
  delete process.env.EHR_SITE_MODE;
  const p = await c.get("/software");
  assert.equal(p.status, 200);
  assert.match(p.text, /ChartReady/);
  assert.match(p.text, /\$399/);
  assert.match(p.text, /Book a 20-minute demo/);
  assert.equal((await c.get("/api/software")).status, 404);
});

test("book a demo: validated, saved as a lead, honeypot ignored; admins see leads", async () => {
  const c = t.client();
  assert.equal((await c.post("/software/demo", { name: "", email: "x" })).status, 400);
  const r = await c.post("/software/demo", { name: "Alex Buyer", email: "alex@exampleclinic.com", organization: "Example Clinic", clinicians: "6–20" });
  assert.equal(r.status, 303);
  assert.match((await c.get("/software?sent=1")).text, /We&#39;ll be in touch|We'll be in touch/);
  await c.post("/software/demo", { name: "Bot", email: "bot@spam.example", website: "http://spam" });
  const rows = t.db.prepare("SELECT * FROM sales_leads").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].organization, "Example Clinic");
  const admin = await t.login("admin");
  const page = await admin.get("/ehr/admin/leads");
  assert.match(page.text, /Alex Buyer/);
  await admin.post(`/ehr/admin/leads/${rows[0].id}`, { status: "demo_scheduled" });
  assert.equal(t.db.prepare("SELECT status FROM sales_leads WHERE id = ?").get(rows[0].id).status, "demo_scheduled");
  assert.equal((await (await t.login("therapist")).get("/ehr/admin/leads")).status, 403);
});

test("onboarding checklist shows for admins until required steps are done", async () => {
  const admin = await t.login("admin");
  const d = await admin.get("/ehr");
  assert.match(d.text, /Get your clinic ready/);
  assert.match(d.text, /Add your clinic&#39;s details|Add your clinic's details/);
  assert.doesNotMatch((await (await t.login("therapist")).get("/ehr")).text, /Get your clinic ready/);
  const items = require("../src/onboarding").items(t.db);
  assert.ok(items.find((i) => i.key === "staff").done, "seeded staff counts");
  assert.ok(items.find((i) => i.key === "client").done);
});

test("lobby poster: printable QR code for the check-in page", async () => {
  const staff = await t.login("frontdesk");
  const r = await staff.get("/ehr/checkins/poster");
  assert.equal(r.status, 200);
  assert.match(r.text, /Check in with your phone/);
  assert.match(r.text, /<svg[^>]*>/);
  assert.match(r.text, /\/checkin<\/strong>/);
});
