"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid;
before(async () => { t = await start(); pid = t.ctx.patients[6]; });
after(async () => { await t.stop(); });

test("supportive housing form renders without a treatment plan", async () => {
  const c = await t.login("therapist");
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
  const r = await c.get(`/ehr/patients/${pid}/notes/new?type=supportive_housing`);
  assert.equal(r.status, 200);
  for (const s of [/Supportive housing assessment/, /chronic homelessness/, /Tenancy supports needed/, /Coordinated Entry/, /Continuum of Care/]) assert.match(r.text, s);
  assert.match((await c.get(`/ehr/patients/${pid}/notes`)).text, /notes\/new\?type=supportive_housing/);
});

test("create, validate and sign a supportive housing assessment", async () => {
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/notes`, { type: "supportive_housing", format: "supportive_housing", service_date: "2026-11-02", housing_status: "castle" });
  assert.equal(bad.status, 400);
  const base = { type: "supportive_housing", format: "supportive_housing", service_date: "2026-11-02", housing_status: "unsheltered",
    housing_history: "Lost apartment 14 months ago after job loss.", chronic_homelessness: "yes_continuous", disabling_condition: "yes",
    income_sources: ["SSI", "Made-up income"], benefits: ["Medicaid", "SNAP"], documents: ["Photo ID"], barriers: ["Prior eviction(s)"],
    coc_consent: "yes", referrals: ["Coordinated Entry (CoC) assessment", "Permanent supportive housing (PSH)"],
    plan: "Complete coordinated entry by 11/15; request birth certificate.", risk_level: "low" };
  const r = await c.post(`/ehr/patients/${pid}/notes`, base);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const id = Number(r.location.match(/(\d+)$/)[1]);
  const content = JSON.parse(t.db.prepare("SELECT content FROM notes WHERE id = ?").get(id).content);
  assert.deepEqual(content.income_sources, ["SSI"], "unknown options dropped");
  // Tenancy supports are required to sign
  const s1 = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s1.status, 400);
  assert.match(s1.text, /Tenancy supports needed to obtain and keep housing: select at least one/);
  await c.post(`/ehr/notes/${id}/edit`, { ...base, tenancy_supports: ["Budgeting and paying rent", "Benefits enrollment"] });
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Literally homeless: unsheltered/);
  assert.match(v.text, /Budgeting and paying rent, Benefits enrollment/);
  assert.match(v.text, /Permanent supportive housing \(PSH\)/);
});

test("older databases are upgraded to allow the new note type", () => {
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openDb } = require("../src/db");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-")), "old.sqlite");
  const old = new DatabaseSync(file);
  old.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8").split(",'supportive_housing'").join(""));
  old.close();
  const db = openDb(file);
  db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES ('a@b.c','A','clinician','x')").run();
  db.prepare("INSERT INTO patients (mrn, first_name, last_name, dob) VALUES ('X1','A','B','2000-01-01')").run();
  db.prepare("INSERT INTO notes (patient_id, author_id, type, format) VALUES (1, 1, 'supportive_housing', 'supportive_housing')").run();
  db.close();
});
