"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

function makePatient(last = "Dropdown") {
  return Number(t.db.prepare("INSERT INTO patients (mrn, first_name, last_name, dob, status) VALUES (?, 'Dee', ?, '1985-04-05', 'active')")
    .run(`DD-${Math.random().toString(36).slice(2, 10)}`, last).lastInsertRowid);
}
const selectRe = (name) => new RegExp(`<select[^>]*name="${name}"`);

/* ---------------- patient address state ---------------- */

test("patient form: state is a dropdown; listed code saves, invalid code rejected, blank allowed", async () => {
  const c = await t.login("frontdesk");
  const form = await c.get("/ehr/patients/new");
  assert.match(form.text, selectRe("state"));
  assert.match(form.text, /<option value="AZ">AZ · Arizona<\/option>/);

  const bad = await c.post("/ehr/patients", { first_name: "Stat", last_name: "Invalid", dob: "1990-01-01", state: "ZZ" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose a state from the list/);

  const ok = await c.post("/ehr/patients", { first_name: "Stat", last_name: "Valid", dob: "1990-01-01", state: "AZ" });
  assert.equal(ok.status, 302);
  const p = t.db.prepare("SELECT * FROM patients WHERE last_name = 'Valid'").get();
  assert.equal(p.state, "AZ");
  const edit = await c.get(`/ehr/patients/${p.id}/edit`);
  assert.match(edit.text, /<option value="AZ" selected>/);

  const blank = await c.post("/ehr/patients", { first_name: "Stat", last_name: "Blankstate", dob: "1990-01-01", state: "" });
  assert.equal(blank.status, 302);
  assert.equal(t.db.prepare("SELECT state FROM patients WHERE last_name = 'Blankstate'").get().state, null);
});

/* ---------------- insurance payer ---------------- */

test("insurance payer: dropdown of payers; listed and Other values save; Other blank is required", async () => {
  const pid = makePatient("Payerson");
  const c = await t.login("frontdesk");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, selectRe("payer_name"));
  assert.match(chart.text, /<optgroup label="Arizona Medicaid \(AHCCCS\)">/);
  assert.match(chart.text, /name="payer_name_other"/);
  assert.doesNotMatch(chart.text, /payer-suggestions/);

  const missing = await c.post(`/ehr/patients/${pid}/insurance`, { priority: "primary", payer_name: "__other", payer_name_other: "" });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Payer name is required/);

  const listed = await c.post(`/ehr/patients/${pid}/insurance`, { priority: "primary", payer_name: "Mercy Care", payer_name_other: "" });
  assert.equal(listed.status, 302);
  const other = await c.post(`/ehr/patients/${pid}/insurance`, { priority: "secondary", payer_name: "__other", payer_name_other: "Tiny Local Plan" });
  assert.equal(other.status, 302);
  const names = t.db.prepare("SELECT payer_name FROM insurance_policies WHERE patient_id = ? ORDER BY id").all(pid).map((r) => r.payer_name);
  assert.deepEqual(names, ["Mercy Care", "Tiny Local Plan"]);

  // AHCCCS-plan reminder still fires for the listed AHCCCS plan (patient has no AHCCCS ID)
  const after = await c.get(`/ehr/patients/${pid}`);
  assert.match(after.text, /This looks like an AHCCCS health plan/);
});

/* ---------------- diagnoses ---------------- */

test("diagnosis: ICD-10 dropdown; listed code auto-fills description; Other code is format-checked", async () => {
  const pid = makePatient("Dxdrop");
  const c = await t.login("therapist");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, selectRe("icd10_code"));
  assert.match(chart.text, /<option value="F41\.1">F41\.1 · /);
  assert.match(chart.text, /name="icd10_code_other"/);

  assert.equal((await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "F41.1", icd10_code_other: "" })).status, 302);
  const d = t.db.prepare("SELECT * FROM diagnoses WHERE patient_id = ? AND icd10_code = 'F41.1'").get(pid);
  assert.ok(d.description && d.description.length > 3, "description filled from the common list");

  const badOther = await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "__other", icd10_code_other: "not-a-code", description: "X" });
  assert.equal(badOther.status, 400);
  assert.match(badOther.text, /valid ICD-10 code/);

  const noDesc = await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "__other", icd10_code_other: "R45.851" });
  assert.equal(noDesc.status, 400);
  assert.match(noDesc.text, /Description is required/);

  const ok = await c.post(`/ehr/patients/${pid}/diagnoses`, { icd10_code: "__other", icd10_code_other: "r45.851", description: "Suicidal ideations" });
  assert.equal(ok.status, 302);
  assert.equal(t.db.prepare("SELECT description FROM diagnoses WHERE patient_id = ? AND icd10_code = 'R45.851'").get(pid).description, "Suicidal ideations");
});

/* ---------------- medications ---------------- */

test("medications: route and frequency dropdowns on add and edit; listed and Other values save", async () => {
  const pid = makePatient("Medroute");
  const c = await t.login("prescriber");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, selectRe("route"));
  assert.match(chart.text, selectRe("frequency"));
  assert.match(chart.text, /name="route_other"/);

  const add = await c.post(`/ehr/patients/${pid}/medications`, {
    name: "Sertraline", dose: "50 mg", route: "By mouth (PO)", route_other: "", frequency: "Once daily", frequency_other: "", start_date: today(),
  });
  assert.equal(add.status, 302);
  const med = t.db.prepare("SELECT * FROM medications WHERE patient_id = ?").get(pid);
  assert.equal(med.route, "By mouth (PO)");
  assert.equal(med.frequency, "Once daily");

  const editPage = await c.get(`/ehr/patients/${pid}/medications/${med.id}/edit`);
  assert.match(editPage.text, selectRe("route"));
  assert.match(editPage.text, /<option value="By mouth \(PO\)" selected>/);

  const edit = await c.post(`/ehr/patients/${pid}/medications/${med.id}/edit`, {
    name: "Sertraline", dose: "50 mg", route: "__other", route_other: "Via G-tube", frequency: "__other", frequency_other: "Every 5 days", start_date: today(),
  });
  assert.equal(edit.status, 302);
  const row = t.db.prepare("SELECT route, frequency FROM medications WHERE id = ?").get(med.id);
  assert.deepEqual({ ...row }, { route: "Via G-tube", frequency: "Every 5 days" });
  // Saved value not in the list shows as Other with the text filled in
  const again = await c.get(`/ehr/patients/${pid}/medications/${med.id}/edit`);
  assert.match(again.text, /<option value="__other" selected>/);
  assert.match(again.text, /name="route_other"[^>]*value="Via G-tube"/);
});

/* ---------------- client check-in ---------------- */

async function checkinLink(pid) {
  const appt = Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status)
    VALUES (?, ?, ?, ?, 'therapy', 'in_person', 'scheduled')`).run(pid, t.ctx.users.therapist, `${today()}T23:00`, `${today()}T23:50`).lastInsertRowid);
  const staff = await t.login("frontdesk");
  const link = await staff.post(`/ehr/appointments/${appt}/checkin-link`, {});
  assert.equal(link.status, 200);
  const tok = (link.text.match(/\/checkin\/s\/([A-Za-z0-9_-]+)/) || [])[1];
  assert.ok(tok);
  return `/checkin/s/${tok}`;
}

test("check-in: state dropdown defaults to AZ; invalid state rejected; changed state saved", async () => {
  const pid = makePatient("Cistate");
  const base = await checkinLink(pid);
  const c = t.client();
  const page = await c.get(base);
  assert.match(page.text, selectRe("state"));
  assert.match(page.text, /<option value="AZ" selected>/);

  assert.equal((await c.post(`${base}/contact`, { same: "0", state: "XX" })).status, 400);
  assert.equal((await c.post(`${base}/contact`, { same: "0", city: "Tucson", state: "NM" })).status, 303);
  const ci = t.db.prepare("SELECT contact_changes FROM checkins WHERE patient_id = ?").get(pid);
  assert.deepEqual(JSON.parse(ci.contact_changes), { city: "Tucson", state: "NM" });
});

test("check-in: untouched default state is not recorded as a change", async () => {
  const pid = makePatient("Cidefault");
  const base = await checkinLink(pid);
  const c = t.client();
  assert.equal((await c.post(`${base}/contact`, { same: "0", phone: "(480) 555-0123", state: "AZ" })).status, 303);
  const ci = t.db.prepare("SELECT contact_changes FROM checkins WHERE patient_id = ?").get(pid);
  assert.deepEqual(JSON.parse(ci.contact_changes), { phone: "(480) 555-0123" });
});

test("check-in: insurance company dropdown, required; listed and Other values save", async () => {
  const pid = makePatient("Ciins");
  const base = await checkinLink(pid);
  const c = t.client();
  await c.post(`${base}/contact`, { same: "1" });
  const page = await c.get(base);
  assert.match(page.text, /<select[^>]*name="payer"[^>]*required/);
  assert.match(page.text, /name="payer_other"/);

  assert.equal((await c.post(`${base}/insurance`, { changed: "1", payer: "", payer_other: "", image_data: "" })).status, 400);
  assert.equal((await c.post(`${base}/insurance`, { changed: "1", payer: "__other", payer_other: "", image_data: "" })).status, 400);
  assert.equal((await c.post(`${base}/insurance`, { changed: "1", payer: "__other", payer_other: "Small Town Health", member_id: "Z9", image_data: "" })).status, 303);
  assert.equal(t.db.prepare("SELECT insurance_payer FROM checkins WHERE patient_id = ?").get(pid).insurance_payer, "Small Town Health");

  const pid2 = makePatient("Ciins2");
  const base2 = await checkinLink(pid2);
  const c2 = t.client();
  await c2.post(`${base2}/contact`, { same: "1" });
  assert.equal((await c2.post(`${base2}/insurance`, { changed: "1", payer: "Aetna", payer_other: "", image_data: "" })).status, 303);
  assert.equal(t.db.prepare("SELECT insurance_payer FROM checkins WHERE patient_id = ?").get(pid2).insurance_payer, "Aetna");
});
