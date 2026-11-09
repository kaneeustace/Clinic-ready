"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const STRONG = "Brand-New-Pass-42!";

test("non-admins get 403 on admin routes", async () => {
  const c = await t.login("therapist");
  const id = t.ctx.users.frontdesk;
  for (const p of ["/ehr/admin", "/ehr/admin/users", "/ehr/admin/users/new", `/ehr/admin/users/${id}/edit`,
    "/ehr/admin/audit", "/ehr/admin/audit.csv", `/ehr/admin/patients/${t.ctx.patients[0]}/access-report`]) {
    assert.equal((await c.get(p)).status, 403, p);
  }
  assert.equal((await c.post("/ehr/admin/users", { name: "X", email: "x@example.com", role: "admin", password: STRONG })).status, 403);
  assert.equal((await c.post(`/ehr/admin/users/${id}/unlock`)).status, 403);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'x@example.com'").get().n, 0);
});

test("admin overview and users list render", async () => {
  const c = await t.login("admin");
  const o = await c.get("/ehr/admin");
  assert.equal(o.status, 200);
  assert.match(o.text, /Users by role/);
  assert.match(o.text, /Active sessions/);
  const u = await c.get("/ehr/admin/users");
  assert.equal(u.status, 200);
  assert.match(u.text, /therapist@example\.com/);
  assert.match(u.text, /0000000001/);
});

test("admin creates a user who can then sign in", async () => {
  const c = await t.login("admin");
  const r = await c.post("/ehr/admin/users", {
    name: "Nora New", email: "Nora@Example.com", role: "clinician", credentials: "LMFT", npi: "1234567890", password: STRONG,
  });
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM users WHERE email = 'nora@example.com'").get();
  assert.equal(row.role, "clinician");
  assert.equal(row.npi, "1234567890");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='create' AND entity_type='user' AND entity_id=?").get(row.id));

  const n = t.client();
  const login = await n.post("/ehr/login", { email: "nora@example.com", password: STRONG });
  assert.equal(login.status, 302);
  assert.equal((await n.get("/ehr")).status, 200);
});

test("user creation validates password, NPI, email and role", async () => {
  const c = await t.login("admin");
  const weak = await c.post("/ehr/admin/users", { name: "W", email: "weak@example.com", role: "clinician", password: "short" });
  assert.equal(weak.status, 400);
  assert.match(weak.text, /at least 12 characters/);
  const classes = await c.post("/ehr/admin/users", { name: "W", email: "weak@example.com", role: "clinician", password: "alllowercaseletters" });
  assert.equal(classes.status, 400);
  const npi = await c.post("/ehr/admin/users", { name: "W", email: "weak@example.com", role: "clinician", npi: "123", password: STRONG });
  assert.equal(npi.status, 400);
  assert.match(npi.text, /NPI/);
  const dup = await c.post("/ehr/admin/users", { name: "W", email: "THERAPIST@example.com", role: "clinician", password: STRONG });
  assert.equal(dup.status, 400);
  const role = await c.post("/ehr/admin/users", { name: "W", email: "weak@example.com", role: "superuser", password: STRONG });
  assert.equal(role.status, 400);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'weak@example.com'").get().n, 0);
});

test("deactivating a user kills their sessions", async () => {
  const admin = await t.login("admin");
  const fd = await t.login("frontdesk");
  assert.equal((await fd.get("/ehr")).status, 200);
  const id = t.ctx.users.frontdesk;
  const r = await admin.post(`/ehr/admin/users/${id}/edit`, { name: "Frankie Frontdesk", role: "frontdesk", credentials: "", npi: "", active: "0" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT active FROM users WHERE id = ?").get(id).active, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id).n, 0);
  const next = await fd.get("/ehr/patients");
  assert.equal(next.status, 302);
  assert.match(next.location, /^\/ehr\/login/);
  // Reactivate for other tests.
  await admin.post(`/ehr/admin/users/${id}/edit`, { name: "Frankie Frontdesk", role: "frontdesk", active: "1" });
  assert.equal(t.db.prepare("SELECT active FROM users WHERE id = ?").get(id).active, 1);
});

test("admins can't deactivate themselves or drop their own admin role", async () => {
  const c = await t.login("admin");
  const id = t.ctx.users.admin;
  const a = await c.post(`/ehr/admin/users/${id}/edit`, { name: "Alex Admin", role: "admin", active: "0" });
  assert.equal(a.status, 400);
  assert.match(a.text, /deactivate your own/);
  const b = await c.post(`/ehr/admin/users/${id}/edit`, { name: "Alex Admin", role: "clinician", active: "1" });
  assert.equal(b.status, 400);
  const row = t.db.prepare("SELECT role, active FROM users WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { role: "admin", active: 1 });
});

test("edit changes role/credentials/NPI and is audited", async () => {
  const c = await t.login("admin");
  const id = t.ctx.users.therapist2;
  const page = await c.get(`/ehr/admin/users/${id}/edit`);
  assert.equal(page.status, 200);
  const bad = await c.post(`/ehr/admin/users/${id}/edit`, { name: "Casey Counselor", role: "clinician", npi: "abc", active: "1" });
  assert.equal(bad.status, 400);
  const r = await c.post(`/ehr/admin/users/${id}/edit`, { name: "Casey Counselor", role: "billing", credentials: "LPC-S", npi: "0000000009", active: "1" });
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT role, credentials, npi FROM users WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { role: "billing", credentials: "LPC-S", npi: "0000000009" });
  assert.match(t.db.prepare("SELECT detail FROM audit_log WHERE action='update' AND entity_id=? ORDER BY id DESC").get(id).detail, /clinician->billing/);
  await c.post(`/ehr/admin/users/${id}/edit`, { name: "Casey Counselor", role: "clinician", credentials: "LPC", npi: "0000000002", active: "1" });
});

test("admin password reset and unlock", async () => {
  const admin = await t.login("admin");
  const target = await t.login("billing");
  const id = t.ctx.users.billing;
  const weak = await admin.post(`/ehr/admin/users/${id}/reset-password`, { password: "weak" });
  assert.equal(weak.status, 400);
  const r = await admin.post(`/ehr/admin/users/${id}/reset-password`, { password: STRONG });
  assert.equal(r.status, 302);
  assert.equal((await target.get("/ehr")).status, 302);
  assert.equal((await t.client().post("/ehr/login", { email: "billing@example.com", password: "Test-Password-123!" })).status, 401);
  assert.equal((await t.client().post("/ehr/login", { email: "billing@example.com", password: STRONG })).status, 302);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='password_reset' AND entity_id=?").get(id));

  t.db.prepare("UPDATE users SET locked_until = datetime('now','+10 minutes') WHERE id = ?").run(id);
  assert.match((await admin.get("/ehr/admin/users")).text, /Locked/);
  const u = await admin.post(`/ehr/admin/users/${id}/unlock`);
  assert.equal(u.status, 302);
  assert.equal(t.db.prepare("SELECT locked_until FROM users WHERE id = ?").get(id).locked_until, null);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='unlock' AND entity_id=?").get(id));

  // Restore the shared test password.
  await admin.post(`/ehr/admin/users/${id}/reset-password`, { password: "Test-Password-123!" });
});

test("account page and change password flow", async () => {
  const c = await t.login("prescriber");
  const other = await t.login("prescriber");
  const page = await c.get("/ehr/account");
  assert.equal(page.status, 200);
  assert.match(page.text, /prescriber@example\.com/);
  assert.match(page.text, /PMHNP-BC/);

  const wrong = await c.post("/ehr/account/password", { current_password: "nope", new_password: STRONG, confirm_password: STRONG });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /Current password is incorrect/);
  const weak = await c.post("/ehr/account/password", { current_password: "Test-Password-123!", new_password: "weakweak", confirm_password: "weakweak" });
  assert.equal(weak.status, 400);
  const mismatch = await c.post("/ehr/account/password", { current_password: "Test-Password-123!", new_password: STRONG, confirm_password: STRONG + "x" });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.text, /match/);

  const ok = await c.post("/ehr/account/password", { current_password: "Test-Password-123!", new_password: STRONG, confirm_password: STRONG });
  assert.equal(ok.status, 302);
  assert.equal((await c.get("/ehr/account")).status, 200, "current session kept");
  assert.equal((await other.get("/ehr")).status, 302, "other session revoked");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='password_change' AND user_id=?").get(t.ctx.users.prescriber));
  assert.equal((await t.client().post("/ehr/login", { email: "prescriber@example.com", password: STRONG })).status, 302);

  await c.post("/ehr/account/password", { current_password: STRONG, new_password: "Test-Password-123!", confirm_password: "Test-Password-123!" });
});

test("audit viewer filters and is itself audited", async () => {
  const c = await t.login("admin");
  const p = t.db.prepare("SELECT * FROM patients WHERE id = ?").get(t.ctx.patients[0]);
  const q = t.db.prepare("SELECT * FROM patients WHERE id = ?").get(t.ctx.patients[1]);
  const uid = t.ctx.users.therapist;
  const ins = t.db.prepare("INSERT INTO audit_log (user_id, action, entity_type, entity_id, patient_id, detail) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(uid, "view", "patient", p.id, p.id, "marker-one");
  ins.run(uid, "sign", "note", 99, q.id, "marker-two");
  t.db.prepare("INSERT INTO audit_log (ts, user_id, action, entity_type, detail) VALUES ('2020-01-15 12:00:00', ?, 'view', 'patient', 'marker-old')").run(uid);

  const byMrn = await c.get(`/ehr/admin/audit?mrn=${encodeURIComponent(p.mrn)}`);
  assert.equal(byMrn.status, 200);
  assert.match(byMrn.text, /marker-one/);
  assert.doesNotMatch(byMrn.text, /marker-two/);
  assert.match(byMrn.text, new RegExp(`href="/ehr/patients/${p.id}"`));

  const byAction = await c.get(`/ehr/admin/audit?action=sign&user_id=${uid}`);
  assert.match(byAction.text, /marker-two/);
  assert.doesNotMatch(byAction.text, /marker-one/);

  const byEntity = await c.get("/ehr/admin/audit?entity_type=note");
  assert.match(byEntity.text, /marker-two/);
  assert.doesNotMatch(byEntity.text, /marker-one/);

  const byDate = await c.get("/ehr/admin/audit?from=2020-01-01&to=2020-01-31");
  assert.match(byDate.text, /marker-old/);
  assert.doesNotMatch(byDate.text, /marker-one/);
  const notOld = await c.get("/ehr/admin/audit?from=2020-01-16");
  assert.doesNotMatch(notOld.text, /marker-old/);

  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='view' AND entity_type='audit_log' AND user_id=?").get(t.ctx.users.admin));
});

test("audit viewer paginates at 100", async () => {
  const c = await t.login("admin");
  const ins = t.db.prepare("INSERT INTO audit_log (user_id, action, entity_type, detail) VALUES (?, 'bulk_test', 'test', ?)");
  for (let i = 0; i < 105; i++) ins.run(t.ctx.users.admin, `bulk-${i}`);
  const p1 = await c.get("/ehr/admin/audit?action=bulk_test");
  assert.equal((p1.text.match(/bulk-\d+/g) || []).length, 100);
  assert.match(p1.text, /page=2/);
  const p2 = await c.get("/ehr/admin/audit?action=bulk_test&page=2");
  assert.equal((p2.text.match(/bulk-\d+/g) || []).length, 5);
});

test("audit CSV export escapes formulas and quotes", async () => {
  const c = await t.login("admin");
  const ins = t.db.prepare("INSERT INTO audit_log (user_id, action, entity_type, detail) VALUES (?, 'csv_test', 'test', ?)");
  ins.run(t.ctx.users.admin, '=HYPERLINK("http://evil")');
  ins.run(t.ctx.users.admin, "+1+2");
  ins.run(t.ctx.users.admin, "-cmd");
  ins.run(t.ctx.users.admin, "@SUM(A1)");
  ins.run(t.ctx.users.admin, "plain, with comma");
  const r = await c.get("/ehr/admin/audit.csv?action=csv_test");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="audit-log-.*\.csv"/);
  const lines = r.text.trim().split("\r\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /"timestamp_utc"/);
  assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(r.text.includes(`"'+1+2"`));
  assert.ok(r.text.includes(`"'-cmd"`));
  assert.ok(r.text.includes(`"'@SUM(A1)"`));
  assert.ok(r.text.includes(`"plain, with comma"`));
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='export' AND entity_type='audit_log'").get());

  const { csvCell } = require("../src/routes/admin");
  assert.equal(csvCell("=1"), `"'=1"`);
  assert.equal(csvCell(null), `""`);
  assert.equal(csvCell(5), `"5"`);
});

test("patient access report lists every event for one patient", async () => {
  const c = await t.login("admin");
  const pid = t.ctx.patients[2];
  const other = t.ctx.patients[3];
  const ins = t.db.prepare("INSERT INTO audit_log (user_id, action, entity_type, entity_id, patient_id, detail) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(t.ctx.users.therapist, "view", "patient", pid, pid, "report-mine");
  ins.run(t.ctx.users.frontdesk, "update", "appointment", 1, pid, "report-mine-2");
  ins.run(t.ctx.users.therapist, "view", "patient", other, other, "report-other");
  const r = await c.get(`/ehr/admin/patients/${pid}/access-report`);
  assert.equal(r.status, 200);
  assert.match(r.text, /report-mine/);
  assert.match(r.text, /report-mine-2/);
  assert.match(r.text, /Taylor Therapist/);
  assert.match(r.text, /Frankie Frontdesk/);
  assert.doesNotMatch(r.text, /report-other/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type='access_report' AND patient_id=?").get(pid));
  assert.equal((await c.get("/ehr/admin/patients/999999/access-report")).status, 404);
});
