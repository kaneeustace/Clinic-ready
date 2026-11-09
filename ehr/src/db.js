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
    ["notes", "'safety_plan'", 2, ["CREATE INDEX IF NOT EXISTS idx_notes_patient ON notes(patient_id, created_at);"]],
    ["assessments", "'ASRS'", 1, ["CREATE INDEX IF NOT EXISTS idx_assess_patient ON assessments(patient_id, instrument, administered_on);"]],
  ];
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

module.exports = { openDb, tx, nextMrn };
