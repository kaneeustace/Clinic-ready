#!/usr/bin/env node
"use strict";
// One-off encrypted backup: snapshot -> gzip -> AES-256-GCM, then prune and verify.
//   EHR_BACKUP_KEY=... npm run backup
// Uses EHR_DB_PATH (default data/ehr.sqlite), EHR_BACKUP_DIR, EHR_BACKUP_RETENTION.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const backup = require("../src/backup");

const dbPath = path.resolve(process.env.EHR_DB_PATH || path.join(__dirname, "..", "data", "ehr.sqlite"));
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath} (set EHR_DB_PATH).`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
const cfg = backup.backupConfig(db);
if (!cfg.enabled) {
  console.error(`Backup NOT taken. ${cfg.reason}`);
  process.exit(2);
}
const r = backup.runBackupJob(db, cfg);
db.close();
if (!r.ok) {
  console.error(`Backup FAILED: ${r.error}`);
  process.exit(1);
}
console.log(`Backup written:  ${r.backup.file}`);
console.log(`Size:            ${r.backup.bytes} bytes`);
console.log(`SHA-256:         ${r.backup.sha256}`);
console.log(`Verified:        integrity ${r.verify.integrity}; users ${r.verify.counts.users}, patients ${r.verify.counts.patients}, notes ${r.verify.counts.notes}`);
console.log(`Pruned:          ${r.pruned.deleted.length ? r.pruned.deleted.join(", ") : "nothing"}`);
console.log("Reminder: copy backups off this server (HIPAA-covered storage) and keep EHR_BACKUP_KEY safe.");
