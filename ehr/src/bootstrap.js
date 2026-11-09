"use strict";
/*
 * First-run setup for an empty database.
 *   EHR_DEMO=1                               -> load demo staff + synthetic patients (never with real data)
 *   EHR_ADMIN_EMAIL + EHR_ADMIN_PASSWORD     -> create the first admin account (production)
 * Does nothing once any user exists.
 */
const { hashPassword, passwordPolicyError } = require("./auth");

function bootstrap(db, env = process.env, log = console) {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (users > 0) return "existing";

  if (env.EHR_DEMO === "1") {
    require("./seed").seed(db);
    log.warn("EHR_DEMO=1: loaded demo accounts and synthetic patients. Do not enter real patient data.");
    return "demo";
  }

  const email = String(env.EHR_ADMIN_EMAIL || "").trim();
  const password = String(env.EHR_ADMIN_PASSWORD || "");
  if (email && password) {
    const err = passwordPolicyError(password);
    if (err) throw new Error(`EHR_ADMIN_PASSWORD rejected: ${err}`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("EHR_ADMIN_EMAIL is not a valid email address.");
    db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)")
      .run(email, String(env.EHR_ADMIN_NAME || "Administrator").trim(), hashPassword(password));
    log.warn(`Created admin account ${email}. Sign in at /ehr, then remove EHR_ADMIN_PASSWORD from the environment.`);
    return "admin";
  }

  log.warn("No users yet. Set EHR_ADMIN_EMAIL and EHR_ADMIN_PASSWORD (or EHR_DEMO=1 for a demo) and restart, or run `npm run seed` locally.");
  return "empty";
}

module.exports = { bootstrap };
