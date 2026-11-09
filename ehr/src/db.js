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
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
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
