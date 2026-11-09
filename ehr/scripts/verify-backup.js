#!/usr/bin/env node
"use strict";
// Restore-test a backup without touching the live database.
//   EHR_BACKUP_KEY=... npm run backup:verify -- <file.sqlite.gz.enc>
const backup = require("../src/backup");

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run backup:verify -- <backup file>");
  process.exit(64);
}
let key;
try {
  key = backup.parseKey(process.env.EHR_BACKUP_KEY);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const r = backup.verifyBackup(file, key);
if (!r.ok) {
  console.error(`FAILED: ${file}\n  ${r.error}`);
  process.exit(1);
}
console.log(`OK: ${file}`);
console.log(`  integrity_check: ${r.integrity}`);
for (const [t, n] of Object.entries(r.counts)) console.log(`  ${t}: ${n === null ? "(table missing)" : n}`);
