"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const lastAudit = (action, entityType) =>
  t.db.prepare("SELECT * FROM audit_log WHERE action = ? AND entity_type = ? ORDER BY id DESC").get(action, entityType);

function makePatient(over = {}) {
  const id = Number(t.db.prepare(
    `INSERT INTO patients (mrn, first_name, last_name, dob, status) VALUES (?, ?, ?, ?, ?)`)
    .run(`TST-${Math.random().toString(36).slice(2, 10)}`, over.first || "Testy", over.last || "Fixture", over.dob || "1990-01-01",
      over.status || "active").lastInsertRowid);
  return id;
}

/* ---------------- list & search ---------------- */

test("patient list shows active patients with key columns and is audited", async () => {
  const c = await t.login("frontdesk");
  const r = await c.get("/ehr/patients");
  assert.equal(r.status, 200);
  assert.match(r.text, /Rivera, Jordan/);
  assert.match(r.text, /CR-000001/);
  assert.match(r.text, /<th scope="col">Primary clinician<\/th>/);
  assert.match(r.text, /Next appointment/);
  const a = lastAudit("list", "patient");
  assert.ok(a);
  assert.equal(a.user_id, c.userId);
});

test("search by name, preferred name, MRN, phone and DOB", async () => {
  const c = await t.login("therapist");
  const cases = [["Okafor", "Okafor, Sam"], ["Mo", "Lee, Morgan"], ["CR-000004", "Nguyen, Riley"],
    ["010-1005", "Brooks, Devon"], ["5550101005", "Brooks, Devon"], ["1994-02-08", "Patel, Quinn"], ["rowan kim", "Kim, Rowan"]];
  for (const [q, expect] of cases) {
    const r = await c.get(`/ehr/patients?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(expect), `query ${q} should find ${expect}`);
  }
  const r = await c.get("/ehr/patients?q=Okafor");
  assert.ok(!r.text.includes("Rivera, Jordan"));
  // Search text is not logged (could be PHI).
  assert.ok(!lastAudit("list", "patient").detail.includes("Okafor"));
});

test("status filter defaults to active; my patients filter for clinicians; sort and pagination", async () => {
  const id = makePatient({ first: "Dana", last: "Dischargedtest", status: "discharged" });
  const c = await t.login("therapist");
  assert.ok(!(await c.get("/ehr/patients?q=Dischargedtest")).text.includes("Dischargedtest, Dana"));
  assert.ok((await c.get("/ehr/patients?q=Dischargedtest&status=discharged")).text.includes("Dischargedtest, Dana"));
  assert.ok((await c.get("/ehr/patients?q=Dischargedtest&status=all")).text.includes(`/ehr/patients/${id}`));

  const mine = await c.get("/ehr/patients?mine=1");
  assert.ok(mine.text.includes("Rivera, Jordan")); // therapist's patient
  assert.ok(!mine.text.includes("Johansson, Harper")); // prescriber's patient, no appts with therapist

  const asc = await c.get("/ehr/patients");
  const desc = await c.get("/ehr/patients?dir=desc");
  assert.ok(asc.text.indexOf("Brooks, Devon") < asc.text.indexOf("Thompson, Avery"));
  assert.ok(desc.text.indexOf("Brooks, Devon") > desc.text.indexOf("Thompson, Avery"));

  for (let i = 0; i < 30; i++) makePatient({ first: `P${i}`, last: `Zzpage${String(i).padStart(2, "0")}` });
  const p1 = await c.get("/ehr/patients?q=Zzpage");
  assert.match(p1.text, /30 active patients/);
  assert.match(p1.text, /Page 1 of 2/);
  assert.equal((p1.text.match(/<tr>\s*<td>TST-/g) || []).length, 25);
  const p2 = await c.get("/ehr/patients?q=Zzpage&page=2");
  assert.equal((p2.text.match(/<tr>\s*<td>TST-/g) || []).length, 5);
  assert.ok(p2.text.includes("Zzpage29"));
});

/* ---------------- create ---------------- */

test("create patient: validation errors re-render the form with values", async () => {
  const c = await t.login("frontdesk");
  assert.equal((await c.get("/ehr/patients/new")).status, 200);
  const r = await c.post("/ehr/patients", { first_name: "Keep<Me>", last_name: "", dob: addDays(today(), 3), email: "nope", phone: "12", state: "New York", zip: "1234" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Last name is required/);
  assert.match(r.text, /can&#39;t be in the future/);
  assert.match(r.text, /valid email/);
  assert.match(r.text, /valid phone/);
  assert.match(r.text, /2-letter state/);
  assert.match(r.text, /5-digit ZIP/);
  assert.match(r.text, /value="Keep&lt;Me&gt;"/);
  const bad = await c.post("/ehr/patients", { first_name: "A", last_name: "B", dob: "2001-02-30" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /valid date/);
  const badClin = await c.post("/ehr/patients", { first_name: "A", last_name: "B", dob: "2001-02-03", primary_clinician_id: String(t.ctx.users.frontdesk) });
  assert.equal(badClin.status, 400);
});

test("create patient: happy path assigns MRN, normalizes, redirects to chart and audits", async () => {
  const c = await t.login("frontdesk");
  const r = await c.post("/ehr/patients", {
    first_name: "Newly", last_name: "Created", dob: "1987-05-06", phone: "555.010.4444", email: "newly@example.com",
    state: "ny", zip: "10001", preferred_contact: "text", ok_voicemail: "1", primary_clinician_id: String(t.ctx.users.therapist2),
  });
  assert.equal(r.status, 302);
  const p = t.db.prepare("SELECT * FROM patients WHERE last_name = 'Created'").get();
  assert.ok(p);
  assert.equal(r.location, `/ehr/patients/${p.id}`);
  assert.match(p.mrn, /^CR-\d{6}$/);
  assert.equal(p.phone, "(555) 010-4444");
  assert.equal(p.state, "NY");
  assert.equal(p.ok_voicemail, 1);
  assert.equal(p.primary_clinician_id, t.ctx.users.therapist2);
  const a = lastAudit("create", "patient");
  assert.equal(a.entity_id, p.id);
  assert.equal(a.patient_id, p.id);
  const chart = await c.get(r.location);
  assert.equal(chart.status, 200);
  assert.match(chart.text, /Patient created/);

  // Duplicate name + DOB is flagged until confirmed.
  const dup = await c.post("/ehr/patients", { first_name: "newly", last_name: "created", dob: "1987-05-06" });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /Possible duplicate/);
  const ok = await c.post("/ehr/patients", { first_name: "newly", last_name: "created", dob: "1987-05-06", confirm_duplicate: "1" });
  assert.equal(ok.status, 302);
});

test("billing cannot create or edit patients", async () => {
  const c = await t.login("billing");
  assert.equal((await c.get("/ehr/patients")).status, 200);
  assert.equal((await c.get("/ehr/patients/new")).status, 403);
  assert.equal((await c.post("/ehr/patients", { first_name: "X", last_name: "Y", dob: "2000-01-01" })).status, 403);
  const pid = t.ctx.patients[0];
  assert.equal((await c.get(`/ehr/patients/${pid}/edit`)).status, 403);
  assert.equal((await c.post(`/ehr/patients/${pid}/insurance`, { payer_name: "X", priority: "primary" })).status, 403);
  assert.equal((await c.post(`/ehr/patients/${pid}/allergies`, { substance: "X" })).status, 403);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'forbidden' AND user_id = ?").get(c.userId));
});

/* ---------------- overview ---------------- */

test("overview shows clinical data to clinicians and audits the view", async () => {
  const pid = t.ctx.patients[3]; // Riley Nguyen: seeded meds, dx, allergy
  t.db.prepare(`INSERT INTO notes (patient_id, author_id, type, status, service_date, signed_at, content)
    VALUES (?, ?, 'progress', 'signed', ?, datetime('now'), '{"d":"secret progress text"}')`).run(pid, t.ctx.users.prescriber, today());
  t.db.prepare(`INSERT INTO notes (patient_id, author_id, type, status, service_date, signed_at)
    VALUES (?, ?, 'psychotherapy', 'signed', ?, datetime('now'))`).run(pid, t.ctx.users.therapist, today());
  const c = await t.login("prescriber");
  const r = await c.get(`/ehr/patients/${pid}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Sertraline/);
  assert.match(r.text, /F33\.1/);
  assert.match(r.text, /Sulfa drugs/);
  assert.match(r.text, /Progress note/);
  assert.ok(!r.text.includes("secret progress text"));
  assert.ok(!r.text.includes("Psychotherapy note"), "psychotherapy notes hidden from non-authors");
  assert.match(r.text, /Upcoming appointments/);
  const a = lastAudit("view", "patient");
  assert.equal(a.patient_id, pid);
  assert.equal(a.user_id, c.userId);

  const author = await t.login("therapist");
  assert.match((await author.get(`/ehr/patients/${pid}`)).text, /Psychotherapy note/);
});

test("front desk and billing do not see medications, diagnoses or notes", async () => {
  const pid = t.ctx.patients[3];
  for (const role of ["frontdesk", "billing"]) {
    const c = await t.login(role);
    const r = await c.get(`/ehr/patients/${pid}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Sulfa drugs/, `${role} sees allergies`);
    assert.match(r.text, /Demographics/);
    assert.match(r.text, /Insurance/);
    assert.ok(!r.text.includes("Sertraline"), `${role} must not see meds`);
    assert.ok(!r.text.includes("F33.1"), `${role} must not see diagnoses`);
    assert.ok(!r.text.includes("Recent signed notes"), `${role} must not see notes`);
    assert.equal((await c.post(`/ehr/patients/${pid}/medications`, { name: "X" })).status, 403);
    assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "F41.1" })).status, 403);
  }
});

test("unknown patient is 404", async () => {
  const c = await t.login("admin");
  assert.equal((await c.get("/ehr/patients/999999")).status, 404);
  assert.equal((await c.get("/ehr/patients/abc")).status, 404);
});

/* ---------------- edit ---------------- */

test("edit demographics: validation and save with audit", async () => {
  const pid = makePatient({ first: "Edit", last: "Me" });
  const c = await t.login("frontdesk");
  const form = await c.get(`/ehr/patients/${pid}/edit`);
  assert.equal(form.status, 200);
  assert.match(form.text, /value="Edit"/);
  const bad = await c.post(`/ehr/patients/${pid}/edit`, { first_name: "", last_name: "Me", dob: "1990-01-01", status: "active" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /First name is required/);
  const badStatus = await c.post(`/ehr/patients/${pid}/edit`, { first_name: "E", last_name: "Me", dob: "1990-01-01", status: "bogus" });
  assert.equal(badStatus.status, 400);
  const ok = await c.post(`/ehr/patients/${pid}/edit`, {
    first_name: "Edited", last_name: "Me", dob: "1990-01-01", status: "inactive", emergency_name: "Pat Contact",
    emergency_relation: "Sibling", emergency_phone: "5550109876", preferred_contact: "phone", phone: "555-010-1212",
    primary_clinician_id: String(t.ctx.users.therapist),
  });
  assert.equal(ok.status, 302);
  const p = t.db.prepare("SELECT * FROM patients WHERE id = ?").get(pid);
  assert.equal(p.first_name, "Edited");
  assert.equal(p.status, "inactive");
  assert.equal(p.emergency_phone, "(555) 010-9876");
  assert.equal(p.ok_voicemail, 0);
  const a = lastAudit("update", "patient");
  assert.equal(a.entity_id, pid);
  assert.match(a.detail, /first_name/);
  assert.ok(!a.detail.includes("Edited"), "no PHI in audit detail");
});

/* ---------------- insurance ---------------- */

test("insurance add (with validation) and delete", async () => {
  const pid = makePatient({ last: "Insured" });
  const c = await t.login("frontdesk");
  const bad = await c.post(`/ehr/patients/${pid}/insurance`, { priority: "primary", payer_name: "", copay: "abc" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Payer name is required/);
  assert.match(bad.text, /dollar amount/);
  const ok = await c.post(`/ehr/patients/${pid}/insurance`, { priority: "primary", payer_name: "Sample Health Plan", member_id: "M1", copay: "$30.50", subscriber_relation: "self" });
  assert.equal(ok.status, 302);
  const pol = t.db.prepare("SELECT * FROM insurance_policies WHERE patient_id = ?").get(pid);
  assert.equal(pol.copay_cents, 3050);
  assert.equal(lastAudit("create", "insurance_policy").entity_id, pol.id);
  assert.match((await c.get(`/ehr/patients/${pid}`)).text, /\$30\.50/);
  const del = await c.post(`/ehr/patients/${pid}/insurance/${pol.id}/delete`);
  assert.equal(del.status, 302);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM insurance_policies WHERE patient_id = ?").get(pid).n, 0);
  assert.equal(lastAudit("delete", "insurance_policy").entity_id, pol.id);
  // Policy of another patient can't be deleted through this chart.
  const other = t.db.prepare("SELECT id FROM insurance_policies WHERE patient_id = ?").get(t.ctx.patients[0]);
  assert.equal((await c.post(`/ehr/patients/${pid}/insurance/${other.id}/delete`)).status, 404);
});

/* ---------------- allergies ---------------- */

test("allergies: front desk and clinicians can add and deactivate", async () => {
  const pid = makePatient({ last: "Allergic" });
  const fd = await t.login("frontdesk");
  assert.equal((await fd.post(`/ehr/patients/${pid}/allergies`, { substance: "" })).status, 400);
  assert.equal((await fd.post(`/ehr/patients/${pid}/allergies`, { substance: "Codeine", severity: "extreme" })).status, 400);
  assert.equal((await fd.post(`/ehr/patients/${pid}/allergies`, { substance: "Codeine", reaction: "Nausea", severity: "moderate" })).status, 302);
  const al = t.db.prepare("SELECT * FROM allergies WHERE patient_id = ?").get(pid);
  assert.equal(al.severity, "moderate");
  assert.equal(lastAudit("create", "allergy").entity_id, al.id);
  const doc = await t.login("therapist");
  assert.equal((await doc.post(`/ehr/patients/${pid}/allergies/${al.id}/deactivate`)).status, 302);
  assert.equal(t.db.prepare("SELECT active FROM allergies WHERE id = ?").get(al.id).active, 0);
  assert.equal(lastAudit("update", "allergy").entity_id, al.id);
});

/* ---------------- medications ---------------- */

test("medications: add, edit, discontinue (clinical:write only)", async () => {
  const pid = makePatient({ last: "Medicated" });
  const fd = await t.login("frontdesk");
  assert.equal((await fd.post(`/ehr/patients/${pid}/medications`, { name: "Sertraline" })).status, 403);

  const c = await t.login("prescriber");
  const bad = await c.post(`/ehr/patients/${pid}/medications`, { name: "", start_date: "2024-13-01" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Medication name is required/);
  assert.match(bad.text, /valid start date/);
  const ok = await c.post(`/ehr/patients/${pid}/medications`, { name: "Bupropion XL", dose: "150 mg", route: "by mouth", frequency: "every morning", start_date: "2026-01-02" });
  assert.equal(ok.status, 302);
  const med = t.db.prepare("SELECT * FROM medications WHERE patient_id = ?").get(pid);
  assert.equal(med.created_by, c.userId);
  assert.equal(lastAudit("create", "medication").entity_id, med.id);

  assert.equal((await c.get(`/ehr/patients/${pid}/medications/${med.id}/edit`)).status, 200);
  const badEdit = await c.post(`/ehr/patients/${pid}/medications/${med.id}/edit`, { name: "Bupropion XL", start_date: "2026-01-02", end_date: "2025-01-01" });
  assert.equal(badEdit.status, 400);
  const edit = await c.post(`/ehr/patients/${pid}/medications/${med.id}/edit`, { name: "Bupropion XL", dose: "300 mg", start_date: "2026-01-02" });
  assert.equal(edit.status, 302);
  assert.equal(t.db.prepare("SELECT dose FROM medications WHERE id = ?").get(med.id).dose, "300 mg");
  assert.equal(lastAudit("update", "medication").entity_id, med.id);

  const disc = await c.post(`/ehr/patients/${pid}/medications/${med.id}/discontinue`);
  assert.equal(disc.status, 302);
  const after = t.db.prepare("SELECT * FROM medications WHERE id = ?").get(med.id);
  assert.equal(after.active, 0);
  assert.equal(after.end_date, today());
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, /No active medications/);
  assert.match(chart.text, /Discontinued medications \(1\)/);
});

/* ---------------- diagnoses ---------------- */

test("diagnoses: ICD-10 validation, description fill, single primary, resolve and reactivate", async () => {
  const pid = makePatient({ last: "Diagnosed" });
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "U07.1" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /valid ICD-10 code/);
  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "F99.XYZ12" })).status, 400);
  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "R45.851" })).status, 400, "description required for unknown codes");

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "f41.1" })).status, 302);
  const first = t.db.prepare("SELECT * FROM diagnoses WHERE patient_id = ? AND icd10_code = 'F41.1'").get(pid);
  assert.equal(first.description, "Generalized anxiety disorder");
  assert.equal(first.is_primary, 1, "first diagnosis becomes primary");
  assert.equal(lastAudit("create", "diagnosis").entity_id, first.id);

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "F41.1" })).status, 400, "duplicate active");

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "F33.1", is_primary: "1", onset_date: "2025-03-01" })).status, 302);
  const second = t.db.prepare("SELECT * FROM diagnoses WHERE patient_id = ? AND icd10_code = 'F33.1'").get(pid);
  const primaries = () => t.db.prepare("SELECT id FROM diagnoses WHERE patient_id = ? AND is_primary = 1").all(pid).map((r) => r.id);
  assert.deepEqual(primaries(), [second.id]);

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses/${first.id}/primary`)).status, 302);
  assert.deepEqual(primaries(), [first.id]);
  assert.equal(lastAudit("update", "diagnosis").detail, "set_primary");

  // Primary listed first on the overview.
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.ok(chart.text.indexOf("F41.1") < chart.text.indexOf("F33.1"));
  assert.match(chart.text, /<datalist id="icd10-common">/);

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses/${first.id}/resolve`)).status, 302);
  let d = t.db.prepare("SELECT * FROM diagnoses WHERE id = ?").get(first.id);
  assert.equal(d.status, "resolved");
  assert.equal(d.is_primary, 0);
  await c.post(`/ehr/patients/${pid}/diagnoses/${first.id}/primary`);
  assert.deepEqual(primaries(), [], "resolved diagnosis can't be primary");

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses/${first.id}/reactivate`)).status, 302);
  d = t.db.prepare("SELECT * FROM diagnoses WHERE id = ?").get(first.id);
  assert.equal(d.status, "active");
  assert.equal(lastAudit("update", "diagnosis").detail, "reactivated");
});
