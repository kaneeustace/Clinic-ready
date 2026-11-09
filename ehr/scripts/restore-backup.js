#!/usr/bin/env node
"use strict";
// Decrypt a backup into a NEW database file. Never overwrites an existing file.
//   EHR_BACKUP_KEY=... npm run backup:restore -- <file.sqlite.gz.enc> <new-target.sqlite>
// Then: stop the app, move the live ehr.sqlite (+ -wal/-shm) aside, rename the restored file
// into place, start the app and check it.
const backup = require("../src/backup");

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error("Usage: npm run backup:restore -- <backup file> <target path (must not exist)>");
  process.exit(64);
}
try {
  const key = backup.parseKey(process.env.EHR_BACKUP_KEY);
  const r = backup.restoreBackup(file, key, target);
  console.log(`Restored ${file}\n      to ${r.file} (${r.bytes} bytes)`);
  console.log(`  integrity_check: ${r.integrity}`);
  for (const [t, n] of Object.entries(r.counts)) console.log(`  ${t}: ${n === null ? "(table missing)" : n}`);
  console.log("Next: stop the app, move the current database (and -wal/-shm files) aside, rename this file into place, then start the app.");
} catch (err) {
  console.error(`Restore FAILED: ${err.message}`);
  process.exit(1);
}
