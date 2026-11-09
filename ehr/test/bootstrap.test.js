"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/db");
const { bootstrap } = require("../src/bootstrap");
const { verifyPassword } = require("../src/auth");

const quiet = { warn() {} };

test("creates the first admin from env vars", () => {
  const db = openDb(":memory:");
  const r = bootstrap(db, { EHR_ADMIN_EMAIL: "owner@clinic.example", EHR_ADMIN_PASSWORD: "Strong-Pass-2026!" }, quiet);
  assert.equal(r, "admin");
  const u = db.prepare("SELECT * FROM users").get();
  assert.equal(u.role, "admin");
  assert.ok(verifyPassword("Strong-Pass-2026!", u.password_hash));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patients").get().n, 0, "no demo data in production bootstrap");
});

test("rejects a weak admin password", () => {
  const db = openDb(":memory:");
  assert.throws(() => bootstrap(db, { EHR_ADMIN_EMAIL: "a@b.co", EHR_ADMIN_PASSWORD: "short" }, quiet), /rejected/);
});

test("does nothing once users exist", () => {
  const db = openDb(":memory:");
  bootstrap(db, { EHR_ADMIN_EMAIL: "owner@clinic.example", EHR_ADMIN_PASSWORD: "Strong-Pass-2026!" }, quiet);
  assert.equal(bootstrap(db, { EHR_DEMO: "1" }, quiet), "existing");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
});

test("empty without config, demo only when asked", () => {
  assert.equal(bootstrap(openDb(":memory:"), {}, quiet), "empty");
  const db = openDb(":memory:");
  assert.equal(bootstrap(db, { EHR_DEMO: "1" }, quiet), "demo");
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM patients").get().n > 0);
});
