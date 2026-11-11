"use strict";
const path = require("node:path");
const { openDb } = require("./src/db");
const { createApp } = require("./src/app");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.EHR_DB_PATH || path.join(__dirname, "data", "ehr.sqlite");

// Never start on temporary storage when a persistent disk is expected (see src/disk-guard.js).
const guard = require("./src/disk-guard");
(async () => {
  if (guard.diskRequired(DB_PATH)) {
    const strict = process.env.EHR_REQUIRE_DISK === "1";
    try { await guard.waitForDisk(DB_PATH, { timeoutMs: strict ? 90000 : 30000 }); }
    catch (e) {
      if (strict) { console.error(`[disk] ${e.message}`); process.exit(1); }
      console.error(`[disk] WARNING: no persistent disk at ${require("node:path").dirname(DB_PATH)}. Starting anyway; data will be ERASED on every restart or update. Attach a disk there.`);
    }
  }
  main();
})();

/** In the container we start as root only to make the mounted disk writable, then drop to EHR_RUN_AS. */
function dropPrivileges() {
  const user = process.env.EHR_RUN_AS;
  if (!user || typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const fs = require("node:fs");
  const dir = path.dirname(DB_PATH);
  try {
    const { execFileSync } = require("node:child_process");
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("chown", ["-R", `${user}:${user}`, dir]);
  } catch (e) { console.error(`[disk] couldn't hand ${dir} to ${user}: ${e.message}`); }
  process.setgid(user);
  process.setuid(user);
  console.log(`[server] running as ${user}`);
}

function main() {
  dropPrivileges();
  const fs = require("node:fs");
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const existed = fs.existsSync(DB_PATH);
  console.log(`[db] ${DB_PATH}: ${existed ? `existing database, ${Math.round(sizeOf(DB_PATH) / 1024)} KB + ${Math.round(sizeOf(DB_PATH + "-wal") / 1024)} KB journal` : "NO DATABASE FOUND, creating a new empty one"}`);
  const db = openDb(DB_PATH);
  try {
    const n = (sql) => db.prepare(sql).get().n;
    console.log(`[db] ${n("SELECT COUNT(*) AS n FROM users")} users, ${n("SELECT COUNT(*) AS n FROM patients")} patients, ${n("SELECT COUNT(*) AS n FROM notes")} notes`);
  } catch { /* first start */ }

  db.prepare("INSERT INTO server_starts (version) VALUES (?)").run(String(process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const starts = db.prepare("SELECT COUNT(*) AS n, MIN(started_at) AS first FROM server_starts").get();
  console.log(`[db] start #${starts.n} of this database (first start ${starts.first} UTC)${starts.n === 1 && existed ? " · WARNING: database file existed but had no start history" : ""}`);

  // Fold the write-ahead journal into the main file every 5 minutes and on shutdown, so a stop during a deploy
  // never leaves recent changes only in the journal.
  const checkpoint = () => { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { console.error("[db] checkpoint failed:", e.message); } };
  setInterval(checkpoint, 5 * 60e3).unref();
  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      console.log(`[db] ${sig}: saving and closing the database`);
      checkpoint();
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  }
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
}
