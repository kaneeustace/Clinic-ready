"use strict";
const path = require("node:path");
const { openDb } = require("./src/db");
const { createApp } = require("./src/app");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.EHR_DB_PATH || path.join(__dirname, "data", "ehr.sqlite");

const db = openDb(DB_PATH);
require("./src/bootstrap").bootstrap(db);

// Purge expired sessions hourly.
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(), 3600e3).unref();

// Encrypted backups (HIPAA contingency plan): at startup, then every EHR_BACKUP_INTERVAL_HOURS.
// Disabled with a warning when EHR_BACKUP_KEY is missing; never writes unencrypted backups.
require("./src/backup").scheduleBackups(db);

// End-of-day outstanding-notes emails (counts only, no PHI). Needs EHR_MAIL_PROVIDER; see src/digest.js.
require("./src/digest").scheduleDigests(db);

createApp(db).listen(PORT, () => {
  console.log(`Clinic Ready running at http://localhost:${PORT}  (EHR: http://localhost:${PORT}/ehr)`);
});
