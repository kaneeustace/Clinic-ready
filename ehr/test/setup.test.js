"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/db");
const { createApp } = require("../src/app");

async function serve(db) {
  const server = await new Promise((r) => { const s = createApp(db).listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const form = (o) => ({ method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

test("first-run setup creates the admin once, then closes", async () => {
  const db = openDb(":memory:");
  const s = await serve(db);
  try {
    assert.match(await (await fetch(s.base + "/ehr/login")).text(), /\/ehr\/setup/);
    assert.equal((await fetch(s.base + "/ehr/setup")).status, 200);
    const weak = await fetch(s.base + "/ehr/setup", form({ name: "Kane", email: "owner@clinic.example", password: "short", confirm: "short" }));
    assert.equal(weak.status, 400);
    const ok = await fetch(s.base + "/ehr/setup", form({ name: "Kane", email: "owner@clinic.example", password: "Strong-Pass-2026!", confirm: "Strong-Pass-2026!" }));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/ehr");
    assert.match(ok.headers.get("set-cookie") || "", /ehr_sid=/);
    assert.equal(db.prepare("SELECT role FROM users").get().role, "admin");
    // Closed now
    assert.equal((await fetch(s.base + "/ehr/setup", { redirect: "manual" })).status, 302);
    const again = await fetch(s.base + "/ehr/setup", form({ name: "X", email: "x@evil.example", password: "Strong-Pass-2026!", confirm: "Strong-Pass-2026!" }));
    assert.equal(again.status, 302);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
    // Can sign in
    const login = await fetch(s.base + "/ehr/login", form({ email: "owner@clinic.example", password: "Strong-Pass-2026!" }));
    assert.equal(login.status, 302);
  } finally { await s.close(); }
});
