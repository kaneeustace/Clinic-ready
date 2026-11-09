"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { audit, verifyAuditChain, backfillAuditChain, raiseAlert, isAfterHours, GENESIS } = require("../src/audit");

process.env.EHR_AFTER_HOURS = "0-0"; // disable the after-hours rule except where a test turns it on

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const reqFor = (userKey, ip = "10.0.0.1") => {
  const u = userKey ? t.db.prepare("SELECT * FROM users WHERE id = ?").get(t.ctx.users[userKey]) : null;
  return { db: t.db, user: u, ip };
};
const alerts = (kind, userId) => t.db.prepare(
  "SELECT * FROM security_alerts WHERE kind = ? AND user_id IS ? ORDER BY id").all(kind, userId ?? null);
const clearAlerts = (kind) => t.db.prepare("UPDATE security_alerts SET status = 'resolved', resolved_at = datetime('now') WHERE kind = ?").run(kind);

test("every audit row is hash-chained and the chain verifies", () => {
  t.db.prepare("INSERT INTO audit_log (action, entity_type) VALUES ('legacy_unhashed', 'test')").run(); // pre-chain row
  for (let i = 0; i < 8; i++) audit(reqFor("admin"), "view", "patient", t.ctx.patients[0], t.ctx.patients[0], `n=${i}`);
  const rows = t.db.prepare("SELECT * FROM audit_log ORDER BY id").all();
  assert.ok(rows.length > 1);
  assert.equal(rows[0].prev_hash, GENESIS);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].hash && /^[0-9a-f]{64}$/.test(rows[i].hash));
    assert.equal(rows[i].prev_hash, rows[i - 1].hash);
  }
  const r = verifyAuditChain(t.db);
  assert.deepEqual(r, { ok: true, checked: rows.length, firstBadId: null });
});

test("rows inserted without a hash are sealed in id order (backfill is idempotent)", () => {
  t.db.prepare("INSERT INTO audit_log (action, entity_type, detail) VALUES ('raw_insert', 'test', 'a')").run();
  t.db.prepare("INSERT INTO audit_log (action, entity_type, detail) VALUES ('raw_insert', 'test', 'b')").run();
  assert.equal(backfillAuditChain(t.db), 2);
  assert.equal(backfillAuditChain(t.db), 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE hash IS NULL").get().n, 0);
  t.db.prepare("INSERT INTO audit_log (action, entity_type, detail) VALUES ('raw_insert', 'test', 'c')").run();
  audit(reqFor("admin"), "after_raw", "test"); // audit() seals pending rows before appending
  assert.ok(verifyAuditChain(t.db).ok);
});

test("UPDATE and DELETE on audit_log are blocked", () => {
  verifyAuditChain(t.db);
  const id = t.db.prepare("SELECT MAX(id) AS id FROM audit_log").get().id;
  assert.throws(() => t.db.prepare("UPDATE audit_log SET detail = 'x' WHERE id = ?").run(id), /append-only/);
  assert.throws(() => t.db.prepare("UPDATE audit_log SET hash = 'x' WHERE id = ?").run(id), /append-only/);
  assert.throws(() => t.db.prepare("DELETE FROM audit_log WHERE id = ?").run(id), /append-only/);
  assert.throws(() => t.db.prepare("DELETE FROM audit_log").run(), /append-only/);
});

test("tampering is detected and raises an audit_chain_broken alert", () => {
  const target = t.db.prepare("SELECT id, detail FROM audit_log ORDER BY id LIMIT 1 OFFSET 3").get();
  t.db.exec("DROP TRIGGER audit_log_no_update");
  t.db.prepare("UPDATE audit_log SET detail = 'tampered' WHERE id = ?").run(target.id);
  const r = verifyAuditChain(t.db);
  assert.equal(r.ok, false);
  assert.equal(r.firstBadId, target.id);
  const a = alerts("audit_chain_broken");
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "high");
  // Verification re-installs the guard.
  assert.throws(() => t.db.prepare("UPDATE audit_log SET detail = 'again' WHERE id = ?").run(target.id), /append-only/);
  verifyAuditChain(t.db); // de-duplicated
  assert.equal(alerts("audit_chain_broken").length, 1);
  // Restore so later tests start from an intact chain.
  t.db.exec("DROP TRIGGER audit_log_no_update");
  t.db.prepare("UPDATE audit_log SET detail = ? WHERE id = ?").run(target.detail, target.id);
  assert.ok(verifyAuditChain(t.db).ok);
  clearAlerts("audit_chain_broken");
});

test("deleting a row breaks the chain at the next row", () => {
  const rows = t.db.prepare("SELECT id FROM audit_log ORDER BY id LIMIT 2 OFFSET 5").all();
  const saved = t.db.prepare("SELECT * FROM audit_log WHERE id = ?").get(rows[0].id);
  t.db.exec("DROP TRIGGER audit_log_no_delete");
  t.db.prepare("DELETE FROM audit_log WHERE id = ?").run(rows[0].id);
  const r = verifyAuditChain(t.db, { alert: false });
  assert.equal(r.ok, false);
  assert.equal(r.firstBadId, rows[1].id);
  t.db.prepare(`INSERT INTO audit_log (id, ts, user_id, action, entity_type, entity_id, patient_id, ip, detail, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(saved.id, saved.ts, saved.user_id, saved.action, saved.entity_type,
    saved.entity_id, saved.patient_id, saved.ip, saved.detail, saved.prev_hash, saved.hash);
  assert.ok(verifyAuditChain(t.db).ok);
});

test("failed_logins: 5 failures for one account alert, then de-duplicate and escalate", async () => {
  const c = t.client();
  for (let i = 0; i < 5; i++) {
    const res = await c.post("/ehr/login", { email: "billing@example.com", password: "wrong-password" });
    assert.equal(res.status, 401);
  }
  const uid = t.ctx.users.billing;
  let a = alerts("failed_logins", uid);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "medium");
  assert.doesNotMatch(a[0].detail, /billing@example\.com/); // no identifiers beyond the user id
  for (let i = 0; i < 10; i++) audit({ db: t.db, user: null, ip: "10.9.9.9" }, "login_failed", "user", uid);
  a = alerts("failed_logins", uid);
  assert.equal(a.length, 1, "de-duplicated within the hour");
  assert.equal(a[0].severity, "high", "escalated at 15 failures");
});

test("failed_logins: 5 failures from one IP (unknown accounts) alert once", () => {
  const before = t.db.prepare("SELECT COUNT(*) AS n FROM security_alerts WHERE kind = 'failed_logins' AND detail LIKE '[ip 10.7.7.7]%'").get().n;
  assert.equal(before, 0);
  for (let i = 0; i < 4; i++) audit({ db: t.db, user: null, ip: "10.7.7.7" }, "login_failed", "user", null, null, "nobody@example.com");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM security_alerts WHERE detail LIKE '[ip 10.7.7.7]%'").get().n, 0);
  audit({ db: t.db, user: null, ip: "10.7.7.7" }, "mfa_failed", "user", null);
  for (let i = 0; i < 3; i++) audit({ db: t.db, user: null, ip: "10.7.7.7" }, "login_failed", "user", null);
  const rows = t.db.prepare("SELECT * FROM security_alerts WHERE detail LIKE '[ip 10.7.7.7]%'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, null);
});

test("bulk_access: 25 distinct patients in an hour alerts once; query uses idx_audit_user", () => {
  const req = reqFor("therapist2");
  for (let i = 1; i <= 24; i++) audit(req, "view", "patient", 100000 + i, 100000 + i);
  audit(req, "view", "patient", 100001, 100001); // repeat view does not count twice
  assert.equal(alerts("bulk_access", req.user.id).length, 0);
  audit(req, "view", "patient", 100025, 100025);
  for (let i = 26; i <= 30; i++) audit(req, "view", "patient", 100000 + i, 100000 + i);
  const a = alerts("bulk_access", req.user.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "high");
  const plan = t.db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT patient_id) AS n FROM audit_log
    WHERE user_id = ? AND ts >= ? AND action = 'view' AND patient_id IS NOT NULL`).all(1, "2000-01-01 00:00:00");
  assert.ok(plan.some((p) => /idx_audit_user/.test(p.detail)), JSON.stringify(plan));
});

test("after_hours: non-admin patient views in the configured window alert (deduped); admins exempt", () => {
  assert.equal(isAfterHours(new Date(), { start: 0, end: 0 }), false);
  process.env.EHR_AFTER_HOURS = "0-24";
  try {
    const pid = t.ctx.patients[0];
    audit(reqFor("admin"), "view", "patient", pid, pid);
    assert.equal(alerts("after_hours", t.ctx.users.admin).length, 0);
    audit(reqFor("prescriber"), "view", "patient", pid, pid);
    audit(reqFor("prescriber"), "view", "patient", pid, pid);
    const a = alerts("after_hours", t.ctx.users.prescriber);
    assert.equal(a.length, 1);
    assert.equal(a[0].severity, "low");
    assert.equal(a[0].patient_id, pid);
    audit(reqFor("prescriber"), "update", "patient", pid, pid); // not a view
    assert.equal(alerts("after_hours", t.ctx.users.prescriber).length, 1);
  } finally {
    process.env.EHR_AFTER_HOURS = "0-0";
  }
  // Wrap-around window parsing: 22-6 contains 23:00 and 05:00 but not 12:00 (clinic time).
  process.env.EHR_TZ = "UTC";
  try {
    const at = (h) => new Date(Date.UTC(2026, 0, 5, h, 30));
    assert.equal(isAfterHours(at(23), { start: 22, end: 6 }), true);
    assert.equal(isAfterHours(at(5), { start: 22, end: 6 }), true);
    assert.equal(isAfterHours(at(12), { start: 22, end: 6 }), false);
    assert.equal(isAfterHours(at(12), { start: 9, end: 17 }), true);
  } finally {
    delete process.env.EHR_TZ;
  }
});

test("forbidden_burst: 10 denied requests in 15 minutes alert once", async () => {
  const c = await t.login("frontdesk");
  for (let i = 0; i < 9; i++) assert.equal((await c.get("/ehr/security")).status, 403);
  assert.equal(alerts("forbidden_burst", t.ctx.users.frontdesk).length, 0);
  assert.equal((await c.get("/ehr/admin")).status, 403);
  for (let i = 0; i < 3; i++) await c.get("/ehr/admin");
  const a = alerts("forbidden_burst", t.ctx.users.frontdesk);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "medium");
});

test("raiseAlert is exported for other modules and de-duplicates by kind + user", () => {
  const a = raiseAlert(t.db, { kind: "backup_failed", severity: "high", detail: "nightly backup failed" });
  const b = raiseAlert(t.db, { kind: "backup_failed", severity: "high", detail: "nightly backup failed" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.id, b.id);
});

test("non-admins get 403 on security routes", async () => {
  const c = await t.login("therapist");
  const id = t.db.prepare("SELECT id FROM security_alerts WHERE status = 'open' LIMIT 1").get().id;
  assert.equal((await c.get("/ehr/security")).status, 403);
  assert.equal((await c.post("/ehr/security/verify-audit")).status, 403);
  assert.equal((await c.post(`/ehr/security/alerts/${id}/acknowledge`)).status, 403);
  assert.equal((await c.post(`/ehr/security/alerts/${id}/resolve`, { resolution_note: "x" })).status, 403);
  assert.equal(t.db.prepare("SELECT status FROM security_alerts WHERE id = ?").get(id).status, "open");
  const dash = await c.get("/ehr");
  assert.doesNotMatch(dash.text, /href="\/ehr\/security"/);
});

test("admin dashboard, acknowledge and resolve flow (audited), verify now", async () => {
  const c = await t.login("admin");
  const id = raiseAlert(t.db, { kind: "flow_test", severity: "medium", detail: "flow test" }).id;
  let res = await c.get("/ehr/security");
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/ehr\/security"/); // sidebar entry
  assert.match(res.text, /flow test/);
  assert.match(res.text, /Chain intact/);
  assert.match(res.text, /without MFA/);

  res = await c.post(`/ehr/security/alerts/${id}/acknowledge`);
  assert.equal(res.status, 302);
  assert.equal(t.db.prepare("SELECT status FROM security_alerts WHERE id = ?").get(id).status, "acknowledged");

  res = await c.post(`/ehr/security/alerts/${id}/resolve`, { resolution_note: "   " });
  assert.equal(t.db.prepare("SELECT status FROM security_alerts WHERE id = ?").get(id).status, "acknowledged", "note required");

  res = await c.post(`/ehr/security/alerts/${id}/resolve`, { resolution_note: "Confirmed with staff member; expected." });
  assert.equal(res.status, 302);
  const row = t.db.prepare("SELECT * FROM security_alerts WHERE id = ?").get(id);
  assert.equal(row.status, "resolved");
  assert.equal(row.resolved_by, t.ctx.users.admin);
  assert.ok(row.resolved_at);
  assert.equal(row.resolution_note, "Confirmed with staff member; expected.");
  const acts = t.db.prepare("SELECT action FROM audit_log WHERE entity_type = 'security_alert' AND entity_id = ? ORDER BY id").all(id).map((r) => r.action);
  assert.deepEqual(acts, ["alert_acknowledge", "alert_resolve"]);

  res = await c.get("/ehr/security");
  assert.match(res.text, /Confirmed with staff member/);

  res = await c.post("/ehr/security/verify-audit");
  assert.equal(res.status, 302);
  const v = t.db.prepare("SELECT detail FROM audit_log WHERE action = 'audit_verify' ORDER BY id DESC LIMIT 1").get();
  assert.match(v.detail, /^ok=true checked=\d+/);
  assert.ok(verifyAuditChain(t.db).ok, "chain still intact after the whole HTTP flow");
});
