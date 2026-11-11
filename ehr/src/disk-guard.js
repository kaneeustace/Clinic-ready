"use strict";
/*
 * Start-up safety check: on hosts with a persistent disk (Render), don't start until the disk is mounted.
 * If the server started before the disk was attached, it would create a fresh, empty database on temporary
 * storage and serve it (empty sign-in, open setup page), and anything entered would be lost. Instead we wait for the
 * mount, and if it never appears we exit so the deploy fails and the previous server keeps running.
 *
 *   Active when EHR_DB_PATH is under /var/data (the documented mount) or EHR_REQUIRE_DISK=1. EHR_REQUIRE_DISK=0 turns it off.
 *   With EHR_REQUIRE_DISK=1 the server refuses to start without the disk; otherwise it waits briefly, then starts
 *   with a loud warning (the Administration → Data storage card then says data is erased on restart).
 */
const fs = require("node:fs");
const path = require("node:path");

function isMounted(dir) {
  try { return fs.statSync(dir).dev !== fs.statSync(path.dirname(dir)).dev; } catch { return false; }
}

function diskRequired(dbPath, env = process.env) {
  if (env.EHR_REQUIRE_DISK === "0") return false;
  if (env.EHR_REQUIRE_DISK === "1") return true;
  return /^\/var\/data(\/|$)/.test(String(dbPath || ""));
}

/** Resolves when the database folder's disk is mounted; rejects after timeoutMs. */
async function waitForDisk(dbPath, { timeoutMs = 90000, intervalMs = 1000, mounted = isMounted, log = console.log } = {}) {
  const dir = path.dirname(dbPath);
  const start = Date.now();
  let warned = false;
  while (!mounted(dir)) {
    if (Date.now() - start >= timeoutMs) throw new Error(`Persistent disk is not mounted at ${dir}; refusing to start with temporary storage.`);
    if (!warned) { log(`[disk] Waiting for the persistent disk at ${dir}…`); warned = true; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { isMounted, diskRequired, waitForDisk };
