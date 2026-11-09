"use strict";
/*
 * Encrypted database backups (HIPAA 164.308(a)(7): data backup plan, disaster recovery,
 * testing and revision). Every backup is:
 *   1. a consistent snapshot taken with `VACUUM INTO` (safe while the app is running, WAL included),
 *   2. gzip-compressed,
 *   3. encrypted with AES-256-GCM using EHR_BACKUP_KEY (authenticated: any tampering is detected).
 * File format: "CRBK1" (5 bytes) + IV (12 bytes) + ciphertext + GCM tag (16 bytes).
 * The magic header is also bound into the GCM tag as additional authenticated data.
 *
 * Plaintext never lands in the backup directory except as a short-lived 0600 temp file that is
 * overwritten and unlinked as soon as it has been read. Without a valid key, backups are disabled:
 * an unencrypted backup is never written.
 *
 * Environment:
 *   EHR_BACKUP_KEY             32 random bytes, base64 (44 chars) or hex (64 chars). Required.
 *                              Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   EHR_BACKUP_DIR             where backups are written (default: <database dir>/backups)
 *   EHR_BACKUP_INTERVAL_HOURS  scheduled interval (default 24)
 *   EHR_BACKUP_RETENTION       "daily,weekly,monthly" copies to keep (default "14,8,12")
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const MAGIC = Buffer.from("CRBK1", "ascii");
const IV_LEN = 12;
const TAG_LEN = 16;
const FILE_RE = /^ehr-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?\.sqlite\.gz\.enc$/;
const DEFAULT_RETENTION = { keepDaily: 14, keepWeekly: 8, keepMonthly: 12 };
const COUNT_TABLES = ["users", "patients", "notes"];

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

/** Parse a 32-byte key given as base64 or 64 hex characters. Throws on anything else. */
function parseKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new Error("Backup key must be exactly 32 bytes.");
    return value;
  }
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new Error("EHR_BACKUP_KEY is not set.");
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(s) || /^[A-Za-z0-9_-]{43}$/.test(s)) {
    const buf = Buffer.from(s, s.includes("+") || s.includes("/") || s.endsWith("=") ? "base64" : "base64url");
    if (buf.length === 32) return buf;
  }
  throw new Error("EHR_BACKUP_KEY must be 32 random bytes encoded as base64 (44 characters) or hex (64 characters).");
}

function parseRetention(value) {
  if (!value) return { ...DEFAULT_RETENTION };
  const parts = String(value).split(",").map((x) => x.trim());
  const nums = parts.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error('EHR_BACKUP_RETENTION must look like "14,8,12" (daily,weekly,monthly).');
  }
  return { keepDaily: nums[0], keepWeekly: nums[1], keepMonthly: nums[2] };
}

/** File path of an open database, or null for :memory:. */
function dbFile(db) {
  try {
    const loc = typeof db.location === "function" ? db.location() : null;
    if (loc) return loc;
  } catch { /* older node:sqlite */ }
  return process.env.EHR_DB_PATH || null;
}

/**
 * Resolve the backup configuration from the environment. Never throws: a bad key or setting
 * yields { enabled: false, reason }.
 */
function backupConfig(db, env = process.env) {
  const file = db ? dbFile(db) : env.EHR_DB_PATH || null;
  const dir = path.resolve(env.EHR_BACKUP_DIR || path.join(file ? path.dirname(file) : path.join(__dirname, "..", "data"), "backups"));
  let intervalHours = Number(env.EHR_BACKUP_INTERVAL_HOURS || 24);
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) intervalHours = 24;
  const cfg = { enabled: false, reason: "", key: null, dir, intervalHours, retention: { ...DEFAULT_RETENTION } };
  try {
    cfg.retention = parseRetention(env.EHR_BACKUP_RETENTION);
  } catch (err) {
    cfg.reason = err.message;
    return cfg;
  }
  if (!env.EHR_BACKUP_KEY) {
    cfg.reason = "EHR_BACKUP_KEY is not set, so automatic backups are DISABLED. Set a 32-byte key (base64 or hex) to enable encrypted backups.";
    return cfg;
  }
  try {
    cfg.key = parseKey(env.EHR_BACKUP_KEY);
  } catch (err) {
    cfg.reason = err.message + " Backups are DISABLED.";
    return cfg;
  }
  cfg.enabled = true;
  return cfg;
}

/* ------------------------------------------------------------------ */
/* Low-level helpers                                                  */
/* ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function tmpName(dir, label) {
  return path.join(dir, `.tmp-${label}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
}

/** Overwrite a file with zeros, then unlink it. Best effort (journaling/SSD/COW filesystems may keep copies). */
function secureDelete(file) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    fd = fs.openSync(file, "r+");
    const chunk = Buffer.alloc(Math.min(size, 1 << 20) || 1);
    for (let off = 0; off < size; off += chunk.length) fs.writeSync(fd, chunk, 0, Math.min(chunk.length, size - off), off);
    fs.fsyncSync(fd);
  } catch { /* fall through to unlink */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  for (const f of [file, file + "-wal", file + "-shm", file + "-journal"]) {
    try { fs.unlinkSync(f); } catch { /* not there */ }
  }
}

function writeAtomic(file, data) {
  const tmp = file + ".partial-" + crypto.randomBytes(4).toString("hex");
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(MAGIC);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, ct, cipher.getAuthTag()]);
}

/** Decrypt + gunzip a backup file into the raw SQLite bytes. Throws a readable error on failure. */
function decryptBackup(file, key) {
  key = parseKey(key);
  const buf = fs.readFileSync(file);
  if (buf.length < MAGIC.length + IV_LEN + TAG_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a Clinic Ready backup file (bad header).");
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(MAGIC.length + IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  let gz;
  try {
    gz = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("Decryption failed: wrong key, or the file is corrupted or has been tampered with.");
  }
  return zlib.gunzipSync(gz);
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Parse the UTC timestamp out of a backup filename; null if the name isn't a backup. */
function backupDate(name) {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return isNaN(d) ? null : d;
}

/** Backups in a directory, newest first: [{ name, file, bytes, date }]. */
function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, date: backupDate(name) }))
    .filter((b) => b.date)
    .map((b) => {
      const file = path.join(dir, b.name);
      let bytes = 0;
      try { bytes = fs.statSync(file).size; } catch { /* raced with prune */ }
      return { ...b, file, bytes };
    })
    .sort((a, b) => b.date - a.date || b.name.localeCompare(a.name));
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Snapshot the database, compress, encrypt and write it atomically.
 * Returns { file, name, bytes, sha256 } (sha256 of the encrypted file).
 */
function createBackup(db, { dir, key, now = new Date() } = {}) {
  key = parseKey(key);
  if (!dir) throw new Error("createBackup: dir is required.");
  ensureDir(dir);
  let name = `ehr-${stamp(now)}.sqlite.gz.enc`;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `ehr-${stamp(now)}-${i}.sqlite.gz.enc`;
  const target = path.join(dir, name);
  const snap = tmpName(dir, "snapshot");
  try {
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    try { fs.chmodSync(snap, 0o600); } catch { /* ignore */ }
    const enc = encrypt(zlib.gzipSync(fs.readFileSync(snap), { level: 9 }), key);
    writeAtomic(target, enc);
    return { file: target, name, bytes: enc.length, sha256: crypto.createHash("sha256").update(enc).digest("hex") };
  } finally {
    secureDelete(snap);
  }
}

/**
 * Restore-test a backup without touching the live database: decrypt, open the copy,
 * run PRAGMA integrity_check and count key tables. Never throws.
 * Returns { ok, file, integrity, counts: {users, patients, notes}, error? }.
 */
function verifyBackup(file, key) {
  const result = { ok: false, file, integrity: null, counts: {} };
  const tmp = tmpName(path.dirname(file), "verify");
  let vdb;
  try {
    const raw = decryptBackup(file, key);
    fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
    vdb = new DatabaseSync(tmp, { readOnly: true });
    const rows = vdb.prepare("PRAGMA integrity_check").all();
    result.integrity = rows.map((r) => Object.values(r)[0]).join("; ");
    for (const t of COUNT_TABLES) {
      const exists = vdb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      result.counts[t] = exists ? vdb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : null;
    }
    result.ok = result.integrity === "ok";
    if (!result.ok) result.error = "Integrity check failed: " + result.integrity;
  } catch (err) {
    result.error = err.message;
  } finally {
    if (vdb) try { vdb.close(); } catch { /* ignore */ }
    secureDelete(tmp);
  }
  return result;
}

/**
 * Grandfather-father-son retention. Keeps the newest backup of each of the last `keepDaily` days,
 * `keepWeekly` ISO weeks and `keepMonthly` months that have backups; the newest backup is always kept.
 * Only files matching the backup name pattern are touched. Also removes stale temp files (>1 day).
 * Returns { kept: [names], deleted: [names] }.
 */
function pruneBackups(dir, opts = {}) {
  const r = { ...DEFAULT_RETENTION, ...(opts || {}) };
  const all = listBackups(dir);
  const keep = new Set();
  if (all.length) keep.add(all[0].name);
  const buckets = [
    [r.keepDaily, (d) => d.toISOString().slice(0, 10)],
    [r.keepWeekly, isoWeek],
    [r.keepMonthly, (d) => d.toISOString().slice(0, 7)],
  ];
  for (const [limit, keyOf] of buckets) {
    const seen = new Set();
    for (const b of all) {
      const k = keyOf(b.date);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.name);
    }
  }
  const deleted = [];
  for (const b of all) {
    if (keep.has(b.name)) continue;
    try { fs.unlinkSync(b.file); deleted.push(b.name); } catch { /* ignore */ }
  }
  // Leftovers from a crash mid-backup (plaintext snapshots must not linger).
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(".tmp-") && !name.includes(".partial-")) continue;
      const f = path.join(dir, name);
      if (Date.now() - fs.statSync(f).mtimeMs > 864e5) secureDelete(f);
    }
  } catch { /* ignore */ }
  return { kept: all.filter((b) => keep.has(b.name)).map((b) => b.name), deleted };
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - yearStart) / 864e5 + 1) / 7)).padStart(2, "0")}`;
}

/**
 * Decrypt a backup into a NEW database file at targetPath. Refuses if targetPath (or its WAL/SHM)
 * already exists, so a live database is never overwritten. The restored copy is integrity-checked
 * before it is moved into place. Returns { file, bytes, integrity, counts }.
 */
function restoreBackup(file, key, targetPath) {
  if (!targetPath) throw new Error("A target path is required.");
  targetPath = path.resolve(targetPath);
  for (const f of [targetPath, targetPath + "-wal", targetPath + "-shm"]) {
    if (fs.existsSync(f)) throw new Error(`Refusing to restore: ${f} already exists. Restore to a new path, stop the app, then swap files.`);
  }
  const raw = decryptBackup(file, key);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tmp = tmpName(path.dirname(targetPath), "restore");
  fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
  try {
    const vdb = new DatabaseSync(tmp, { readOnly: true });
    let integrity, counts = {};
    try {
      integrity = vdb.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]).join("; ");
      for (const t of COUNT_TABLES) {
        const exists = vdb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
        counts[t] = exists ? vdb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : null;
      }
    } finally {
      vdb.close();
    }
    if (integrity !== "ok") throw new Error("Restored database failed integrity check: " + integrity);
    fs.linkSync(tmp, targetPath); // fails (EEXIST) rather than overwrite if the target appeared meanwhile
    return { file: targetPath, bytes: raw.length, integrity, counts };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Scheduled job                                                      */
/* ------------------------------------------------------------------ */

/** Last run outcome for this process (shown on the admin page). */
const state = { lastSuccess: null, lastFailure: null, lastVerify: null, running: false };

function alert(db, detail) {
  try {
    const a = require("./audit");
    if (typeof a.raiseAlert === "function") a.raiseAlert(db, { kind: "backup_failed", severity: "high", detail });
  } catch (err) {
    console.error("[backup] could not raise alert:", err.message);
  }
}

/**
 * Full cycle: back up, prune, verify the new file. Records outcome in `state`, logs, and raises a
 * 'backup_failed' alert on any failure. Returns { ok, backup?, verify?, pruned?, error? }.
 */
function runBackupJob(db, cfg = backupConfig(db)) {
  if (!cfg.enabled) return { ok: false, error: cfg.reason };
  if (state.running) return { ok: false, error: "A backup is already running." };
  state.running = true;
  const at = new Date().toISOString();
  try {
    const backup = createBackup(db, { dir: cfg.dir, key: cfg.key });
    const pruned = pruneBackups(cfg.dir, cfg.retention);
    const verify = verifyBackup(backup.file, cfg.key);
    state.lastVerify = { at, name: backup.name, ok: verify.ok, error: verify.error || null };
    if (!verify.ok) throw new Error(`Backup ${backup.name} failed verification: ${verify.error}`);
    state.lastSuccess = { at, name: backup.name, bytes: backup.bytes, sha256: backup.sha256 };
    console.log(`[backup] ${backup.name} written (${backup.bytes} bytes, sha256 ${backup.sha256.slice(0, 16)}…), verified; pruned ${pruned.deleted.length}.`);
    return { ok: true, backup, verify, pruned };
  } catch (err) {
    state.lastFailure = { at, error: err.message };
    console.error("[backup] FAILED:", err.message);
    alert(db, `Scheduled/manual database backup failed: ${err.message}`.slice(0, 500));
    return { ok: false, error: err.message };
  } finally {
    state.running = false;
  }
}

/**
 * Start-up hook for server.js: runs a backup now and every intervalHours (timers are unref'd).
 * Returns the interval handle, or null when disabled (after logging a clear warning).
 */
function scheduleBackups(db, cfg = backupConfig(db)) {
  if (!cfg.enabled) {
    console.warn(`[backup] WARNING: ${cfg.reason}`);
    return null;
  }
  console.log(`[backup] Encrypted backups enabled: every ${cfg.intervalHours}h to ${cfg.dir} (retention ${cfg.retention.keepDaily}d/${cfg.retention.keepWeekly}w/${cfg.retention.keepMonthly}m).`);
  setTimeout(() => runBackupJob(db, cfg), 5000).unref();
  const t = setInterval(() => runBackupJob(db, cfg), cfg.intervalHours * 3600e3);
  t.unref();
  return t;
}

module.exports = {
  parseKey, parseRetention, backupConfig, createBackup, verifyBackup, pruneBackups, restoreBackup,
  listBackups, backupDate, decryptBackup, runBackupJob, scheduleBackups, state, FILE_RE,
};
