"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const backup = require("../src/backup");
const { start } = require("./helpers");

const KEY_B64 = crypto.randomBytes(32).toString("base64");
const KEY = backup.parseKey(KEY_B64);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ehr-bk-test-"));

test("parseKey accepts base64 and hex 32-byte keys only", () => {
  assert.equal(backup.parseKey(KEY_B64).length, 32);
  assert.equal(backup.parseKey(crypto.randomBytes(32).toString("hex")).length, 32);
  for (const bad of ["", "short", crypto.randomBytes(16).toString("base64"), crypto.randomBytes(31).toString("hex"), "x".repeat(64)]) {
    assert.throws(() => backup.parseKey(bad));
  }
});

test("disabled (no file written) when EHR_BACKUP_KEY is missing or invalid", () => {
  const dir = tmpDir();
  const cfg = backup.backupConfig(null, { EHR_BACKUP_DIR: dir });
  assert.equal(cfg.enabled, false);
  assert.match(cfg.reason, /EHR_BACKUP_KEY/);
  assert.equal(backup.backupConfig(null, { EHR_BACKUP_DIR: dir, EHR_BACKUP_KEY: "nope" }).enabled, false);
  const db = new DatabaseSync(":memory:");
  const r = backup.runBackupJob(db, cfg);
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
  const ok = backup.backupConfig(null, { EHR_BACKUP_DIR: dir, EHR_BACKUP_KEY: KEY_B64, EHR_BACKUP_RETENTION: "3,2,1" });
  assert.equal(ok.enabled, true);
  assert.deepEqual(ok.retention, { keepDaily: 3, keepWeekly: 2, keepMonthly: 1 });
});

test("create -> verify roundtrip, wrong key, tampering, restore", async () => {
  const t = await start();
  try {
    const dir = tmpDir();
    const expected = Object.fromEntries(["users", "patients", "notes"].map((tb) => [tb, t.db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n]));
    assert.ok(expected.patients > 0);

    const b = backup.createBackup(t.db, { dir, key: KEY_B64 });
    assert.match(path.basename(b.file), backup.FILE_RE);
    assert.equal(fs.statSync(b.file).size, b.bytes);
    assert.equal(b.sha256, crypto.createHash("sha256").update(fs.readFileSync(b.file)).digest("hex"));
    // Only the encrypted file remains; no plaintext temp files, and no SQLite header visible.
    assert.deepEqual(fs.readdirSync(dir), [path.basename(b.file)]);
    const bytes = fs.readFileSync(b.file);
    assert.equal(bytes.subarray(0, 5).toString(), "CRBK1");
    assert.equal(bytes.includes(Buffer.from("SQLite format 3")), false);

    const v = backup.verifyBackup(b.file, KEY);
    assert.equal(v.ok, true, v.error);
    assert.equal(v.integrity, "ok");
    assert.deepEqual(v.counts, expected);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(b.file)]);

    const wrong = backup.verifyBackup(b.file, crypto.randomBytes(32));
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /Decryption failed/);

    const tampered = path.join(dir, "ehr-20200101-000000.sqlite.gz.enc");
    const copy = Buffer.from(bytes);
    copy[Math.floor(copy.length / 2)] ^= 0x01;
    fs.writeFileSync(tampered, copy);
    const tv = backup.verifyBackup(tampered, KEY);
    assert.equal(tv.ok, false);
    assert.match(tv.error, /tampered/);
    const tagTamper = Buffer.from(bytes);
    tagTamper[tagTamper.length - 1] ^= 0xff;
    fs.writeFileSync(tampered, tagTamper);
    assert.equal(backup.verifyBackup(tampered, KEY).ok, false);

    // Restore into a new path works; refuses to overwrite an existing file.
    const target = path.join(tmpDir(), "restored.sqlite");
    const r = backup.restoreBackup(b.file, KEY, target);
    assert.equal(r.integrity, "ok");
    assert.deepEqual(r.counts, expected);
    const rdb = new DatabaseSync(target, { readOnly: true });
    assert.equal(rdb.prepare("SELECT COUNT(*) AS n FROM patients").get().n, expected.patients);
    rdb.close();
    const before = fs.readFileSync(target);
    assert.throws(() => backup.restoreBackup(b.file, KEY, target), /Refusing to restore/);
    assert.ok(fs.readFileSync(target).equals(before));
    assert.throws(() => backup.restoreBackup(tampered, KEY, path.join(tmpDir(), "x.sqlite")), /Decryption failed/);
  } finally {
    await t.stop();
  }
});

test("pruneBackups keeps daily/weekly/monthly copies and ignores other files", () => {
  const dir = tmpDir();
  const names = [];
  const base = Date.UTC(2026, 10, 9, 3, 0, 0); // 2026-11-09
  for (let i = 0; i < 400; i++) {
    const d = new Date(base - i * 864e5);
    const n = `ehr-${d.toISOString().slice(0, 10).replace(/-/g, "")}-030000.sqlite.gz.enc`;
    names.push(n);
    fs.writeFileSync(path.join(dir, n), "x");
  }
  // A second, older backup on the newest day: superseded by the later one that day.
  fs.writeFileSync(path.join(dir, "ehr-20261109-010000.sqlite.gz.enc"), "x");
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
  fs.writeFileSync(path.join(dir, "ehr-garbage.enc"), "keep me");

  const r = backup.pruneBackups(dir, { keepDaily: 14, keepWeekly: 8, keepMonthly: 12 });
  const left = new Set(fs.readdirSync(dir));
  assert.ok(left.has("notes.txt") && left.has("ehr-garbage.enc"));
  assert.ok(!left.has("ehr-20261109-010000.sqlite.gz.enc"));
  for (const n of names.slice(0, 14)) assert.ok(left.has(n), `daily ${n} kept`);
  assert.ok(!left.has(names[14]) || r.kept.includes(names[14]));
  const kept = r.kept.map((n) => backup.backupDate(n));
  const months = new Set(kept.map((d) => d.toISOString().slice(0, 7)));
  assert.equal(months.size, 12);
  // 14 daily + weekly + monthly with overlap; far fewer than 401.
  assert.ok(r.kept.length >= 14 && r.kept.length <= 14 + 8 + 12, `kept ${r.kept.length}`);
  assert.equal(r.kept.length + r.deleted.length, 401);
  // Oldest kept is within the 12-month window; a 400-day-old file is gone.
  assert.ok(!left.has(names[399]));
  // Idempotent.
  assert.equal(backup.pruneBackups(dir, { keepDaily: 14, keepWeekly: 8, keepMonthly: 12 }).deleted.length, 0);
});

test("routes: admin only, run + verify, path traversal rejected, no download", async () => {
  const dir = tmpDir();
  process.env.EHR_BACKUP_DIR = dir;
  process.env.EHR_BACKUP_KEY = KEY_B64;
  const t = await start();
  try {
    const therapist = await t.login("therapist");
    assert.equal((await therapist.get("/ehr/backups")).status, 403);
    assert.equal((await therapist.post("/ehr/backups/run")).status, 403);
    assert.equal((await therapist.post("/ehr/backups/verify", { file: "x" })).status, 403);
    assert.equal(fs.readdirSync(dir).length, 0);

    const admin = await t.login("admin");
    let res = await admin.get("/ehr/backups");
    assert.equal(res.status, 200);
    assert.match(res.text, /Enabled/);
    assert.match(res.text, /No backups yet/);

    res = await admin.post("/ehr/backups/run");
    assert.equal(res.status, 303);
    const files = backup.listBackups(dir);
    assert.equal(files.length, 1);
    assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup_run' AND detail LIKE 'ok %'").get());
    res = await admin.get("/ehr/backups");
    assert.match(res.text, /created and verified/);
    assert.ok(res.text.includes(files[0].name));

    res = await admin.post("/ehr/backups/verify", { file: files[0].name });
    assert.equal(res.status, 303);
    assert.match((await admin.get("/ehr/backups")).text, /verified: integrity ok/);
    assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup_verify' AND detail LIKE 'ok %'").get());

    // Path traversal / unlisted files are rejected before any file is opened.
    fs.writeFileSync(path.join(path.dirname(dir), "ehr-20990101-000000.sqlite.gz.enc"), "x");
    for (const file of ["../ehr-20990101-000000.sqlite.gz.enc", "/etc/passwd", "..%2Fx", `${files[0].name}/..`, ""]) {
      res = await admin.post("/ehr/backups/verify", { file });
      assert.equal(res.status, 303);
      assert.match((await admin.get("/ehr/backups")).text, /not found/);
    }
    assert.ok(t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup_verify' AND detail LIKE 'rejected%'").get().n >= 5);

    // No way to download a backup through the web.
    assert.notEqual((await admin.get(`/ehr/backups/${files[0].name}`)).status, 200);
    assert.ok(!(await admin.get("/ehr/backups")).text.includes(`href="/ehr/backups/${files[0].name}`));
  } finally {
    await t.stop();
    delete process.env.EHR_BACKUP_DIR;
    delete process.env.EHR_BACKUP_KEY;
    try { fs.unlinkSync(path.join(path.dirname(dir), "ehr-20990101-000000.sqlite.gz.enc")); } catch { /* ignore */ }
  }
});

test("routes: page shows disabled state without a key", async () => {
  delete process.env.EHR_BACKUP_KEY;
  process.env.EHR_BACKUP_DIR = tmpDir();
  const t = await start();
  try {
    const admin = await t.login("admin");
    const res = await admin.get("/ehr/backups");
    assert.equal(res.status, 200);
    assert.match(res.text, /Backups are disabled/);
    await admin.post("/ehr/backups/run");
    assert.equal(fs.readdirSync(process.env.EHR_BACKUP_DIR).length, 0);
  } finally {
    await t.stop();
    delete process.env.EHR_BACKUP_DIR;
  }
});
