"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { start } = require("./helpers");
const { npiValid } = require("../src/routes/clinic");

let t;
before(async () => { t = await start(); });
after(async () => { delete process.env.EHR_OPS_TOKEN; delete process.env.EHR_FLEET; await t.stop(); });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("clinic settings: validated, saved, and shown across the app", async () => {
  const admin = await t.login("admin");
  assert.equal((await admin.get("/ehr/admin/clinic")).status, 200);
  const base = { name: "Sunrise Counseling", tagline: "Behavioral Health", address1: "1 Main St", city: "Mesa", state: "az", zip: "85201",
    phone: "(480) 555-0100", npi: "1234567890", tax_id: "861234567", color: "teal" };
  let r = await admin.post("/ehr/admin/clinic", base);
  assert.equal(r.status, 400);
  assert.match(r.text, /valid 10-digit NPI/);
  r = await admin.post("/ehr/admin/clinic", { ...base, npi: "1234567893" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const row = t.db.prepare("SELECT * FROM clinic_settings WHERE id = 1").get();
  assert.deepEqual([row.state, row.tax_id, row.color], ["AZ", "86-1234567", "teal"]);
  const dash = await admin.get("/ehr");
  assert.match(dash.text, /Sunrise Counseling/);
  assert.match(dash.text, /<title>[^<]*Sunrise Counseling<\/title>/);
  assert.match(dash.text, /--primary:#0f8f86/);
  const login = await t.client().get("/ehr/login");
  assert.match(login.text, /Sunrise Counseling/);
  const man = JSON.parse((await t.client().get("/ehr/manifest.webmanifest")).text);
  assert.equal(man.name, "Sunrise Counseling");
  // Non-admins can't change it
  const clin = await t.login("therapist");
  assert.equal((await clin.post("/ehr/admin/clinic", base)).status, 403);
  assert.ok(npiValid("1234567893") && !npiValid("1234567890"));
});

test("logo upload: public image used in the sidebar; non-images refused", async () => {
  const admin = await t.login("admin");
  let r = await admin.post("/ehr/admin/clinic/logo", { image_data: `data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}` });
  assert.equal(r.status, 400);
  r = await admin.post("/ehr/admin/clinic/logo", { image_data: `data:image/png;base64,${PNG}` });
  assert.equal(r.status, 302);
  const logo = await t.client().get("/ehr/brand/logo");
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type"), /image\/png/);
  assert.match((await admin.get("/ehr")).text, /class="brand-logo/);
  await admin.post("/ehr/admin/clinic/logo/delete", {});
  assert.equal((await t.client().get("/ehr/brand/logo")).status, 404);
});

test("setup wizard names the clinic", async () => {
  const { openDb } = require("../src/db");
  const { createApp } = require("../src/app");
  const db = openDb(":memory:");
  const server = await new Promise((r) => { const sv = createApp(db).listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(base + "/ehr/setup")).text(), /Set up your clinic/);
    const r = await fetch(base + "/ehr/setup", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ clinic_name: "Desert Bloom BH", name: "Owner", email: "o@desert.example", password: "Strong-Pass-2026!", confirm: "Strong-Pass-2026!" }).toString() });
    assert.equal(r.status, 302);
    assert.equal(db.prepare("SELECT name FROM clinic_settings").get().name, "Desert Bloom BH");
  } finally { await new Promise((r) => server.close(r)); }
});

test("ops status: token required, counts only; customers page checks every clinic", async () => {
  const c = t.client();
  assert.equal((await c.get("/ops/status")).status, 404); // no token configured
  process.env.EHR_OPS_TOKEN = "test-token-0123456789abcdef";
  assert.equal((await c.get("/ops/status")).status, 404); // wrong/missing token
  const r = await c.request("GET", "/ops/status", undefined, { headers: { authorization: "Bearer test-token-0123456789abcdef" } });
  assert.equal(r.status, 200);
  const s = JSON.parse(r.text);
  assert.equal(s.clinic, "Sunrise Counseling");
  assert.ok(s.patients_active > 0 && s.users_active > 0);
  const names = t.db.prepare("SELECT last_name FROM patients").all().map((p) => p.last_name);
  for (const n of names) assert.ok(!r.text.includes(n), "no patient names in status");

  // A fake remote clinic, plus one that's down
  const remote = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer remote-token") { res.statusCode = 404; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ clinic: "Desert Bloom BH", version: "abc1234", setup_complete: true, users_active: 4, patients_active: 37,
      notes_signed_30d: 210, last_sign_in: "2026-11-09 18:00:00", storage_persistent: true, last_backup: null, ai_review: false, email: true, billing_details_complete: true }));
  });
  await new Promise((ok) => remote.listen(0, "127.0.0.1", ok));
  process.env.EHR_FLEET = JSON.stringify([{ name: "Desert Bloom", url: `http://127.0.0.1:${remote.address().port}`, token: "remote-token" },
    { name: "Gone Clinic", url: "http://127.0.0.1:1", token: "x" }]);
  try {
  const admin = await t.login("admin");
  const page = await admin.get("/ehr/admin/customers");
  assert.equal(page.status, 200);
  assert.match(page.text, /Desert Bloom BH/);
  assert.match(page.text, />37</);
  assert.match(page.text, /Gone Clinic[\s\S]*Down/);
  assert.match(page.text, /This copy/);
  assert.equal((await (await t.login("therapist")).get("/ehr/admin/customers")).status, 403);
  } finally { remote.closeAllConnections(); remote.close(); }
});
