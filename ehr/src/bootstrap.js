"use strict";
/*
 * Startup account setup.
 *   EHR_DEMO=1                               -> empty DB: load demo staff + synthetic patients (never with real data)
 *   EHR_ADMIN_EMAIL + EHR_ADMIN_PASSWORD     -> empty DB: create the first admin account
 *   ... + EHR_ADMIN_RESET=1                  -> recovery: create that admin, or reset its password, unlock and
 *                                               reactivate it, even if other users exist. Remove afterwards.
 * Problems are logged, never thrown, so a bad setting can't take the site down.
 */
const { hashPassword, passwordPolicyError } = require("./auth");

function adminFromEnv(env) {
  const email = String(env.EHR_ADMIN_EMAIL || "").trim();
  const password = String(env.EHR_ADMIN_PASSWORD || "");
  if (!email || !password) return { error: null, missing: true };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "EHR_ADMIN_EMAIL is not a valid email address." };
  const err = passwordPolicyError(password);
  if (err) return { error: `EHR_ADMIN_PASSWORD rejected: ${err}` };
  return { email, password, name: String(env.EHR_ADMIN_NAME || "Administrator").trim() };
}

function bootstrap(db, env = process.env, log = console) {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;

  if (users > 0) {
    if (env.EHR_ADMIN_RESET !== "1") return "existing";
    const a = adminFromEnv(env);
    if (a.missing || a.error) {
      log.error(`EHR_ADMIN_RESET=1 ignored: ${a.error || "set EHR_ADMIN_EMAIL and EHR_ADMIN_PASSWORD."}`);
      return "error";
    }
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(a.email);
    if (existing) {
      db.prepare(`UPDATE users SET password_hash = ?, role = 'admin', active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?`)
        .run(hashPassword(a.password), existing.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    } else {
      db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)").run(a.email, a.name, hashPassword(a.password));
    }
    db.prepare("INSERT INTO audit_log (action, entity_type, detail) VALUES ('admin_reset', 'user', ?)").run("startup EHR_ADMIN_RESET");
    log.warn(`EHR_ADMIN_RESET: admin ${a.email} is ready. Remove EHR_ADMIN_RESET and EHR_ADMIN_PASSWORD from the environment now.`);
    return "reset";
  }

  if (env.EHR_DEMO === "1") {
    require("./seed").seed(db);
    log.warn("EHR_DEMO=1: loaded demo accounts and synthetic patients. Do not enter real patient data.");
    return "demo";
  }

  const a = adminFromEnv(env);
  if (a.error) {
    log.error(`Admin account NOT created. ${a.error}`);
    return "error";
  }
  if (!a.missing) {
    db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)").run(a.email, a.name, hashPassword(a.password));
    log.warn(`Created admin account ${a.email}. Sign in at /ehr, then remove EHR_ADMIN_PASSWORD from the environment.`);
    return "admin";
  }

  log.warn("No users yet. Set EHR_ADMIN_EMAIL and EHR_ADMIN_PASSWORD (or EHR_DEMO=1 for a demo) and restart.");
  return "empty";
}

module.exports = { bootstrap };
