"use strict";
/*
 * Audit log (HIPAA 45 CFR 164.312(b) audit controls, 164.312(c)(1) integrity) and security alerting.
 *
 *   audit(req, action, entityType, entityId, patientId, detail)   append one event
 *   verifyAuditChain(db)        -> { ok, checked, firstBadId }  recompute the hash chain
 *   backfillAuditChain(db)      -> number of rows sealed         chain rows written without a hash
 *   raiseAlert(db, { kind, severity, user_id, patient_id, detail, key })  open a de-duplicated security alert
 *
 * Tamper evidence: every row stores prev_hash (the previous row's hash, 'GENESIS' for the first row) and
 * hash = sha256(prev_hash + canonical JSON of ts, user_id, action, entity_type, entity_id, patient_id, ip, detail).
 * Editing or deleting any row breaks the chain from that row on, which verifyAuditChain() reports.
 * Rows inserted with raw SQL (bootstrap, tests) are sealed in id order the next time audit() or verification runs.
 *
 * Append-only: BEFORE UPDATE / BEFORE DELETE triggers (created at runtime, idempotently) abort any change to a
 * sealed row. The only permitted UPDATE is sealing an unsealed row (setting prev_hash/hash, nothing else).
 *
 * Retention: audit rows are never deleted by the application. HIPAA requires documentation of policies, procedures
 * and required activity records to be retained for 6 years (45 CFR 164.316(b)(2)); the log is kept indefinitely,
 * and archival (if ever needed) must copy the whole chain, never prune it in place.
 */
const crypto = require("node:crypto");

const GENESIS = "GENESIS";
const nowTs = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
const intOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/* ------------------------------------------------------------------ */
/* Hash chain                                                         */
/* ------------------------------------------------------------------ */
/** Canonical JSON of the hashed fields (fixed key order, explicit nulls). */
function canonical(row) {
  return JSON.stringify({
    ts: row.ts == null ? null : String(row.ts),
    user_id: intOrNull(row.user_id),
    action: row.action == null ? null : String(row.action),
    entity_type: row.entity_type == null ? null : String(row.entity_type),
    entity_id: row.entity_id == null ? null : Number(row.entity_id),
    patient_id: row.patient_id == null ? null : Number(row.patient_id),
    ip: row.ip == null ? null : String(row.ip),
    detail: row.detail == null ? null : String(row.detail),
  });
}
function hashRow(prevHash, row) {
  return crypto.createHash("sha256").update(String(prevHash) + canonical(row)).digest("hex");
}

const prepared = new WeakSet(); // databases whose triggers have been installed in this process

const UPDATE_GUARD = `CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  WHEN OLD.hash IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.ts IS NOT OLD.ts OR NEW.user_id IS NOT OLD.user_id
    OR NEW.action IS NOT OLD.action OR NEW.entity_type IS NOT OLD.entity_type OR NEW.entity_id IS NOT OLD.entity_id
    OR NEW.patient_id IS NOT OLD.patient_id OR NEW.ip IS NOT OLD.ip OR NEW.detail IS NOT OLD.detail
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`;
const DELETE_GUARD = `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`;

/** Install the append-only triggers (idempotent). */
function ensureAuditGuards(db) {
  db.exec(UPDATE_GUARD);
  db.exec(DELETE_GUARD);
  prepared.add(db);
}

/** Run fn inside a SAVEPOINT (nests safely inside a caller's BEGIN ... COMMIT). */
function savepoint(db, fn) {
  db.exec("SAVEPOINT audit_chain");
  try {
    const out = fn();
    db.exec("RELEASE audit_chain");
    return out;
  } catch (err) {
    db.exec("ROLLBACK TO audit_chain");
    db.exec("RELEASE audit_chain");
    throw err;
  }
}

function lastSealed(db) {
  return db.prepare("SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1").get() || null;
}

/** Seal unsealed rows after the last sealed one, in id order. Idempotent; returns the number of rows sealed. */
function sealPending(db) {
  const tail = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
  if (!tail || tail.hash != null) return 0; // fast path: chain head is sealed
  const last = lastSealed(db);
  let prev = last ? last.hash : GENESIS;
  const rows = db.prepare("SELECT * FROM audit_log WHERE id > ? AND hash IS NULL ORDER BY id").all(last ? last.id : 0);
  const upd = db.prepare("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?");
  for (const r of rows) {
    const h = hashRow(prev, r);
    upd.run(prev, h, r.id);
    prev = h;
  }
  return rows.length;
}

function backfillAuditChain(db) {
  if (!prepared.has(db)) ensureAuditGuards(db);
  return savepoint(db, () => sealPending(db));
}

const lastResults = new WeakMap();

/**
 * Recompute the whole chain. Returns { ok, checked, firstBadId }. On failure raises an
 * 'audit_chain_broken' alert (unless opts.alert === false).
 */
function verifyAuditChain(db, opts = {}) {
  ensureAuditGuards(db); // re-create the guards if someone dropped them
  backfillAuditChain(db);
  let prev = GENESIS;
  let checked = 0;
  let firstBadId = null;
  for (const r of db.prepare("SELECT * FROM audit_log ORDER BY id").iterate()) {
    checked++;
    const expected = r.hash == null ? null : hashRow(prev, r);
    if (firstBadId == null && (r.hash == null || r.prev_hash !== prev || r.hash !== expected)) firstBadId = r.id;
    prev = r.hash == null ? prev : r.hash;
  }
  const result = { ok: firstBadId == null, checked, firstBadId };
  lastResults.set(db, { ...result, at: nowTs() });
  if (!result.ok && opts.alert !== false) {
    raiseAlert(db, { kind: "audit_chain_broken", severity: "high",
      detail: `Audit log hash chain fails verification at entry #${firstBadId} (${checked} entries checked)` });
  }
  return result;
}
/** Most recent verification result in this process (or null). */
function lastVerification(db) {
  return lastResults.get(db) || null;
}

/* ------------------------------------------------------------------ */
/* Append                                                             */
/* ------------------------------------------------------------------ */
/**
 * Append an entry to the audit log. Call for every view or change of PHI.
 *   audit(req, 'view', 'patient', patient.id, patient.id)
 *   audit(req, 'sign', 'note', note.id, note.patient_id)
 * Never put PHI content in `detail`; record what happened, not the data itself.
 */
function audit(req, action, entityType = null, entityId = null, patientId = null, detail = null) {
  const db = req.db;
  if (!prepared.has(db)) ensureAuditGuards(db);
  const row = {
    ts: nowTs(),
    user_id: req.user ? intOrNull(req.user.id) : null,
    action: String(action),
    entity_type: entityType == null ? null : String(entityType),
    entity_id: intOrNull(entityId),
    patient_id: intOrNull(patientId),
    ip: req.ip || null,
    detail: detail == null ? null : String(detail).slice(0, 500),
  };
  savepoint(db, () => {
    sealPending(db);
    const last = lastSealed(db);
    const prev = last ? last.hash : GENESIS;
    db.prepare(
      `INSERT INTO audit_log (ts, user_id, action, entity_type, entity_id, patient_id, ip, detail, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.ts, row.user_id, row.action, row.entity_type, row.entity_id, row.patient_id, row.ip, row.detail,
      prev, hashRow(prev, row));
  });
  try {
    evaluateAlerts(db, row, req.user || null);
  } catch (err) {
    // Detection must never block the audited action itself.
    console.error("security alert evaluation failed:", err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Security alerts                                                    */
/* ------------------------------------------------------------------ */
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
const DEDUPE_MINUTES = 60;

/**
 * Open a security alert unless an open/acknowledged alert of the same kind for the same user (and same `key`,
 * e.g. an IP address) was raised in the last hour; in that case the existing alert is escalated if the new
 * severity is higher. `detail` must never contain PHI. Returns { id, created }.
 */
function raiseAlert(db, { kind, severity = "medium", user_id = null, patient_id = null, detail = null, key = null }) {
  if (!SEVERITY_RANK[severity]) severity = "medium";
  const text = key ? `[${key}] ${detail || ""}`.trim() : detail;
  const keyPrefix = key ? `[${key}]` : null;
  const existing = db.prepare(
    `SELECT id, severity FROM security_alerts
     WHERE kind = ? AND user_id IS ? AND status IN ('open','acknowledged') AND ts >= ?
       AND (? IS NULL OR substr(detail, 1, length(?)) = ?)
     ORDER BY id DESC LIMIT 1`).get(kind, intOrNull(user_id), nowTs(-DEDUPE_MINUTES * 60e3), keyPrefix, keyPrefix, keyPrefix);
  if (existing) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
      db.prepare("UPDATE security_alerts SET severity = ?, detail = ? WHERE id = ?").run(severity, text, existing.id);
    }
    return { id: existing.id, created: false };
  }
  const info = db.prepare(
    "INSERT INTO security_alerts (ts, kind, severity, user_id, patient_id, detail) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(nowTs(), kind, severity, intOrNull(user_id), intOrNull(patient_id), text == null ? null : String(text).slice(0, 500));
  return { id: Number(info.lastInsertRowid), created: true };
}

/** Parse EHR_AFTER_HOURS ("22-6" = 22:00 to 06:00 clinic time). */
function afterHoursWindow() {
  const m = String(process.env.EHR_AFTER_HOURS || "22-6").match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  const start = m ? Number(m[1]) : 22;
  const end = m ? Number(m[2]) : 6;
  return { start, end };
}
/** Clinic-local hour (0-23) of a Date. */
function clinicHour(date = new Date()) {
  const tz = process.env.EHR_TZ || "America/New_York";
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(date));
  return h % 24;
}
function isAfterHours(date = new Date(), { start, end } = afterHoursWindow()) {
  if (start === end) return false;
  const h = clinicHour(date);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

const FAILED_ACTIONS = ["login_failed", "mfa_failed"];

/** Run the detection rules relevant to one just-written audit row. */
function evaluateAlerts(db, row, user) {
  const { action } = row;
  if (FAILED_ACTIONS.includes(action)) {
    const since = nowTs(-15 * 60e3);
    // Failed sign-ins have no session user; the account is recorded as entity 'user'.
    const subject = row.user_id ?? (row.entity_type === "user" ? row.entity_id : null);
    // patient_id IS NULL lets SQLite use idx_audit_patient(patient_id, ts) to bound the scan to the window.
    const base = `SELECT COUNT(*) AS n FROM audit_log WHERE patient_id IS NULL AND ts >= ? AND action IN ('login_failed','mfa_failed')`;
    if (subject != null) {
      const n = db.prepare(`${base} AND (user_id = ? OR (user_id IS NULL AND entity_type = 'user' AND entity_id = ?))`)
        .get(since, subject, subject).n;
      if (n >= 5) raiseAlert(db, { kind: "failed_logins", severity: n >= 15 ? "high" : "medium", user_id: subject,
        detail: `${n} failed sign-in attempts for this account in 15 minutes` });
    }
    if (row.ip) {
      const n = db.prepare(`${base} AND ip = ?`).get(since, row.ip).n;
      if (n >= 5) raiseAlert(db, { kind: "failed_logins", severity: n >= 15 ? "high" : "medium", key: `ip ${row.ip}`,
        detail: `${n} failed sign-in attempts from this address in 15 minutes` });
    }
    return;
  }
  if (action === "forbidden" && row.user_id != null) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND ts >= ? AND action = 'forbidden'")
      .get(row.user_id, nowTs(-15 * 60e3)).n;
    if (n >= 10) raiseAlert(db, { kind: "forbidden_burst", severity: "medium", user_id: row.user_id,
      detail: `${n} denied requests in 15 minutes` });
    return;
  }
  if (action === "view" && row.patient_id != null && row.user_id != null) {
    // Uses idx_audit_user(user_id, ts).
    const n = db.prepare(
      `SELECT COUNT(DISTINCT patient_id) AS n FROM audit_log
       WHERE user_id = ? AND ts >= ? AND action = 'view' AND patient_id IS NOT NULL`).get(row.user_id, nowTs(-60 * 60e3)).n;
    if (n >= 25) raiseAlert(db, { kind: "bulk_access", severity: "high", user_id: row.user_id,
      detail: `Viewed ${n} distinct patient records in 60 minutes` });
    if (user && user.role !== "admin" && isAfterHours(new Date(row.ts.replace(" ", "T") + "Z"))) {
      const { start, end } = afterHoursWindow();
      raiseAlert(db, { kind: "after_hours", severity: "low", user_id: row.user_id, patient_id: row.patient_id,
        detail: `Patient record viewed outside clinic hours (${start}:00-${end}:00 clinic time)` });
    }
  }
}

module.exports = {
  audit, raiseAlert, verifyAuditChain, backfillAuditChain, ensureAuditGuards, lastVerification,
  hashRow, canonical, isAfterHours, afterHoursWindow, evaluateAlerts, GENESIS,
};
