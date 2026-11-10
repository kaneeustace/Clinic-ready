"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const g = require("../src/disk-guard");

test("disk guard: required for /var/data, waits for the mount, gives up after the timeout", async () => {
  assert.equal(g.diskRequired("/var/data/ehr.sqlite", {}), true);
  assert.equal(g.diskRequired("/opt/app/data/ehr.sqlite", {}), false);
  assert.equal(g.diskRequired("/var/data/ehr.sqlite", { EHR_REQUIRE_DISK: "0" }), false);
  assert.equal(g.diskRequired("/x/ehr.sqlite", { EHR_REQUIRE_DISK: "1" }), true);
  let n = 0;
  await g.waitForDisk("/var/data/ehr.sqlite", { intervalMs: 5, mounted: () => ++n >= 3, log: () => {} });
  assert.equal(n, 3);
  await assert.rejects(g.waitForDisk("/var/data/ehr.sqlite", { timeoutMs: 30, intervalMs: 5, mounted: () => false, log: () => {} }), /not mounted/);
});
