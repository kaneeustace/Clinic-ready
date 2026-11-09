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
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get();
  if (current && (current.sql.match(/'safety_plan'/g) || []).length < 2) { // both type and format checks must be current
    const create = schema.match(/CREATE TABLE IF NOT EXISTS notes \([\s\S]*?\n\);/)[0]
      .replace("CREATE TABLE IF NOT EXISTS notes (", "CREATE TABLE notes_new (");
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      tx(db, () => {
        db.exec(create);
        db.exec("INSERT INTO notes_new SELECT * FROM notes;");
        db.exec("DROP TABLE notes;");
        db.exec("ALTER TABLE notes_new RENAME TO notes;");
        db.exec("CREATE INDEX IF NOT EXISTS idx_notes_patient ON notes(patient_id, created_at);");
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
