"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

/**
 * Open (and migrate) the database. Pass ':memory:' for tests.
 * Usage in routes: req.db.prepare(sql).get(...)/.all(...)/.run(...)
 */
function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db, schema);
  return db;
}

/**
 * Upgrade older databases in place. SQLite can't ALTER a CHECK constraint, so a table
 * whose constraint changed is rebuilt (the documented 12-step procedure, simplified).
 */
function migrate(db, schema) {
  // [table, marker that must appear `count` times in the current definition, indexes to recreate]
  const REBUILDS = [
    ["notes", "'supportive_housing'", 2, ["CREATE INDEX IF NOT EXISTS idx_notes_patient ON notes(patient_id, created_at);"]],
    ["assessments", "'ASRS'", 1, ["CREATE INDEX IF NOT EXISTS idx_assess_patient ON assessments(patient_id, instrument, administered_on);"]],
  ];
  // Columns added after first release (ALTER TABLE ADD COLUMN is safe and instant in SQLite).
  const ADD_COLUMNS = {
    // HIPAA hardening (see docs/hipaa/)
    users: [
      ["education_level", "TEXT"],            // AHCCCS modifier HM/HN/HO/HP; derived from credentials when empty
      ["mfa_secret", "TEXT"],                 // base32 TOTP secret (encrypted at rest when EHR_DATA_KEY is set)
      ["mfa_enabled", "INTEGER NOT NULL DEFAULT 0"],
      ["mfa_recovery", "TEXT"],               // JSON array of sha256 hashes of one-time recovery codes
      ["mfa_enrolled_at", "TEXT"],
      ["password_changed_at", "TEXT"],
    ],
    sessions: [
      ["mfa_pending", "INTEGER NOT NULL DEFAULT 0"], // password accepted, second factor not yet verified
    ],
    // AHCCCS (Arizona Medicaid) support, see src/payers.js
    patients: [
      ["ahcccs_id", "TEXT"],                  // AHCCCS member ID (e.g. A12345678)
      ["gender", "TEXT"],                     // AHCCCS expects gender in member demographics
    ],
    charges: [
      ["pos", "TEXT"],                        // place of service (member's location for telehealth under AHCCCS)
      ["minutes", "INTEGER"],                 // documented minutes supporting time-based units
      ["note_id", "INTEGER REFERENCES notes(id)"],
    ],
    audit_log: [
      ["prev_hash", "TEXT"],                  // tamper-evident hash chain
      ["hash", "TEXT"],
    ],
    treatment_plans: [
      ["plan_type", "TEXT NOT NULL DEFAULT 'mental_health'"],   // mental_health | sud | co_occurring
      ["version", "INTEGER NOT NULL DEFAULT 1"],
      ["supersedes_id", "INTEGER REFERENCES treatment_plans(id)"],
      ["diagnoses", "TEXT"],                 // JSON snapshot [{code, description, primary}]
      ["client_vision", "TEXT"],             // client's overall goal, own words
      ["needs", "TEXT"], ["abilities", "TEXT"], ["preferences", "TEXT"],
      ["natural_supports", "TEXT"], ["family_involvement", "TEXT"],
      ["service_summary", "TEXT"],           // type, amount, frequency, duration of services
      ["modality_rationale", "TEXT"],        // why this treatment approach
      ["estimated_duration", "TEXT"],        // e.g. '16-20 sessions over 6 months'
      ["expected_outcome", "TEXT"],          // expected improvement / capacity to benefit
      ["discharge_criteria", "TEXT"], ["aftercare_referrals", "TEXT"],
      ["safety_plan_note_id", "INTEGER REFERENCES notes(id)"],
      ["review_interval_days", "INTEGER NOT NULL DEFAULT 90"],
      ["level_of_care", "TEXT"], ["loc_indicated", "TEXT"], ["loc_adjusted", "TEXT"], ["loc_reason", "TEXT"],
      ["continued_stay", "TEXT"], ["mat_plan", "TEXT"], ["drug_testing_plan", "TEXT"],
      ["relapse_prevention", "TEXT"], ["recovery_supports", "TEXT"],
      ["activated_at", "TEXT"], ["ended_at", "TEXT"], ["end_reason", "TEXT"],
    ],
  };
  for (const [table, cols] of Object.entries(ADD_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }

  migrateLegacyGoals(db);

  for (const [table, marker, count, indexes] of REBUILDS) {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!current || current.sql.split(marker).length - 1 >= count) continue;
    const create = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]
      .replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_new (`);
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      tx(db, () => {
        db.exec(create);
        db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table};`);
        db.exec(`DROP TABLE ${table};`);
        db.exec(`ALTER TABLE ${table}_new RENAME TO ${table};`);
        indexes.forEach((sql) => db.exec(sql));
      });
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}

/**
 * One-time conversion of v1 treatment plans (free-text rows in treatment_goals) into the v2
 * problem → goal → objective → intervention tables. Only touches plans that have treatment_goals
 * rows and no plan_problems yet, so it is idempotent; treatment_goals is left as read-only history.
 */
const LEGACY_STATUS = { not_started: "not_started", in_progress: "progressing", met: "met", revised: "revised", discontinued: "discontinued" };
function migrateLegacyGoals(db) {
  const plans = db.prepare(
    `SELECT tp.* FROM treatment_plans tp
     WHERE EXISTS (SELECT 1 FROM treatment_goals g WHERE g.plan_id = tp.id)
       AND NOT EXISTS (SELECT 1 FROM plan_problems p WHERE p.plan_id = tp.id)`).all();
  if (!plans.length) return 0;
  const goalsOf = db.prepare("SELECT * FROM treatment_goals WHERE plan_id = ? ORDER BY sort, id");
  const insP = db.prepare("INSERT INTO plan_problems (plan_id, sort, title, status) VALUES (?, ?, ?, ?)");
  const insG = db.prepare("INSERT INTO plan_goals (problem_id, sort, goal_text) VALUES (?, 0, ?)");
  const insO = db.prepare(`INSERT INTO plan_objectives (goal_id, sort, text, measure_type, direction, target_date, status)
    VALUES (?, 0, ?, 'attainment', 'achieve', ?, ?)`);
  const insI = db.prepare("INSERT INTO plan_interventions (objective_id, sort, kind, description) VALUES (?, 0, 'professional', ?)");
  tx(db, () => {
    for (const plan of plans) {
      goalsOf.all(plan.id).forEach((g, i) => {
        const status = LEGACY_STATUS[g.status] || "not_started";
        const pid = Number(insP.run(plan.id, i, g.problem, g.status === "met" ? "resolved" : "active").lastInsertRowid);
        const gid = Number(insG.run(pid, g.goal).lastInsertRowid);
        const oid = Number(insO.run(gid, (g.objectives && g.objectives.trim()) || g.goal, g.target_date || null, status).lastInsertRowid);
        insI.run(oid, (g.interventions && g.interventions.trim()) || "See objective");
      });
      // v1 recorded only signed_at; treat it as the activation time for plans that were in effect.
      if (plan.status !== "draft") db.prepare("UPDATE treatment_plans SET activated_at = COALESCE(activated_at, signed_at) WHERE id = ?").run(plan.id);
    }
  });
  return plans.length;
}

/** Run fn inside a transaction; rolls back on throw. */
function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Generate the next MRN, e.g. 'CR-000123'. */
function nextMrn(db) {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM patients").get();
  return "CR-" + String(row.n).padStart(6, "0");
}

module.exports = { openDb, tx, nextMrn, migrateLegacyGoals };
