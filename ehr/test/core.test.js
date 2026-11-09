"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

test("public site pages are served, source files are not", async () => {
  const c = t.client();
  assert.equal((await c.get("/")).status, 200);
  assert.equal((await c.get("/services.html")).status, 200);
  assert.equal((await c.get("/assets/css/styles.css")).status, 200);
  for (const p of ["/ehr/src/db.js", "/ehr/package.json", "/.git/config", "/README.md", "/ehr/data/ehr.sqlite"]) {
    const r = await c.get(p);
    assert.notEqual(r.status, 200, p);
  }
});

test("EHR requires login", async () => {
  const r = await t.client().get("/ehr/patients");
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/ehr\/login/);
});

test("login with bad password fails and is audited", async () => {
  const r = await t.client().post("/ehr/login", { email: "admin@example.com", password: "wrong" });
  assert.equal(r.status, 401);
  const row = t.db.prepare("SELECT * FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC").get();
  assert.ok(row);
});

test("account locks after repeated failures", async () => {
  const c = t.client();
  for (let i = 0; i < 5; i++) await c.post("/ehr/login", { email: "billing@example.com", password: "nope" });
  const r = await c.post("/ehr/login", { email: "billing@example.com", password: "Test-Password-123!" });
  assert.equal(r.status, 429);
  t.db.prepare("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'billing@example.com'").run();
});

test("login, dashboard, logout", async () => {
  const c = await t.login("therapist");
  const d = await c.get("/ehr");
  assert.equal(d.status, 200);
  assert.match(d.text, /Today's schedule/);
  assert.equal(d.headers.get("cache-control"), "no-store");
  const out = await c.post("/ehr/logout");
  assert.equal(out.status, 302);
  assert.equal((await c.get("/ehr")).status, 302);
});

test("POST without CSRF token is rejected", async () => {
  const c = await t.login("admin");
  const r = await c.post("/ehr/logout", { _csrf: "bogus" });
  assert.equal(r.status, 403);
});

test("cross-origin POST is rejected", async () => {
  const c = await t.login("admin");
  const r = await c.request("POST", "/ehr/logout", { _csrf: c.csrf }, { headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

test("security headers present", async () => {
  const r = await t.client().get("/ehr/login");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("html helper escapes interpolations", () => {
  const { html } = require("../src/views");
  assert.equal(String(html`<p>${"<script>"}</p>`), "<p>&lt;script&gt;</p>");
});
