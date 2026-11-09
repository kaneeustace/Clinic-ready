"use strict";
/*
 * Emergency admin password reset, run from a shell on the server (e.g. Render → Shell):
 *   npm run reset-admin -- you@clinic.com 'New-Strong-Pass-2026!'
 * Creates the admin if the email doesn't exist; otherwise resets the password, unlocks and reactivates
 * the account, clears its two-factor setup and signs out its sessions. Audited.
 */
const path = require("node:path");
const { openDb } = require("../src/db");
const { bootstrap } = require("../src/bootstrap");

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npm run reset-admin -- <email> <new password>");
  process.exit(1);
}
const db = openDb(process.env.EHR_DB_PATH || path.join(__dirname, "..", "data", "ehr.sqlite"));
const result = bootstrap(db, { EHR_ADMIN_EMAIL: email, EHR_ADMIN_PASSWORD: password, EHR_ADMIN_RESET: "1" },
  { warn: (m) => console.log(m), error: (m) => console.error(m) });
if (result === "error") process.exit(1);
db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery = NULL WHERE email = ?").run(email);
console.log(`Done. Sign in at /ehr as ${email}.`);
