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

test("weak admin password is logged, not thrown, and creates nothing", () => {
  const db = openDb(":memory:");
  const errors = [];
  const r = bootstrap(db, { EHR_ADMIN_EMAIL: "a@b.co", EHR_ADMIN_PASSWORD: "short" }, { warn() {}, error: (m) => errors.push(m) });
  assert.equal(r, "error");
  assert.match(errors[0], /rejected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
});

test("EHR_ADMIN_RESET resets an existing admin's password and unlocks it", () => {
  const db = openDb(":memory:");
  const env = { EHR_ADMIN_EMAIL: "owner@clinic.example", EHR_ADMIN_PASSWORD: "Strong-Pass-2026!" };
  bootstrap(db, env, quiet);
  db.prepare("UPDATE users SET locked_until = '2999-01-01 00:00:00', active = 0").run();
  const r = bootstrap(db, { ...env, EHR_ADMIN_PASSWORD: "Another-Pass-2026!", EHR_ADMIN_RESET: "1" }, quiet);
  assert.equal(r, "reset");
  const u = db.prepare("SELECT * FROM users").get();
  assert.ok(verifyPassword("Another-Pass-2026!", u.password_hash));
  assert.equal(u.active, 1);
  assert.equal(u.locked_until, null);
});

test("EHR_ADMIN_RESET creates the admin when other users exist", () => {
  const db = openDb(":memory:");
  bootstrap(db, { EHR_DEMO: "1" }, quiet);
  bootstrap(db, { EHR_ADMIN_EMAIL: "new@clinic.example", EHR_ADMIN_PASSWORD: "Strong-Pass-2026!", EHR_ADMIN_RESET: "1" }, quiet);
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'new@clinic.example'").get().role, "admin");
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
