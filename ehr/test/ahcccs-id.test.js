"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t, pid;
before(async () => { t = await start(); pid = t.ctx.patients[2]; t.db.prepare("UPDATE patients SET ahcccs_id = 'A12345678' WHERE id = ?").run(pid); });
after(async () => { await t.stop(); });

test("AHCCCS ID shows on every chart tab and in the per-page print identifier", async () => {
  const c = await t.login("therapist");
  for (const tab of ["", "/notes", "/treatment-plan", "/measures", "/appointments"]) {
    const r = await c.get(`/ehr/patients/${pid}${tab}`);
    assert.equal(r.status, 200, tab);
    assert.match(r.text, /<dt>AHCCCS ID<\/dt><dd>A12345678<\/dd>/, `banner ${tab}`);
    assert.match(r.text, /class="print-id"[^>]*>[^<]*AHCCCS ID A12345678/, `print id ${tab}`);
  }
  const other = t.ctx.patients[3];
  assert.doesNotMatch((await c.get(`/ehr/patients/${other}`)).text, /chart-head__ahcccs/);
});
