"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");

let t, pid, c;
const PW = "Test-Password-123!";
before(async () => {
  t = await start();
  pid = t.ctx.patients[8];
  const admin = await t.login("admin");
  const r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", dea_number: "BP1234563" });
  assert.equal(r.status, 302);
  c = await t.login("prescriber");
});
after(async () => { await t.stop(); });

const base = (o = {}) => ({ drug: "Sertraline", strength: "50 mg", dosage_form: "Tablet", route: "By mouth (PO)", sig: "Take 1 tablet by mouth once daily.",
  quantity: "30", quantity_unit: "tablets", days_supply: "30", refills: "1", schedule: "", delivery: "print", written_on: today(),
  allow_duplicate: "1", allergy_override: "1", password: PW, ...o });
const last = () => t.db.prepare("SELECT * FROM prescriptions WHERE patient_id = ? ORDER BY id DESC LIMIT 1").get(pid);

test("form shows the sig builder, days-supply and drug datalists, pharmacy select and save checkbox", async () => {
  const r = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<select id="sig_action" name="sig_action"/);
  assert.match(r.text, /<select id="sig_frequency" name="sig_frequency"/);
  assert.match(r.text, /name="sig_amount"/);
  assert.match(r.text, /name="days_supply"[^>]*list="rx-days-supply"/);
  assert.match(r.text, /<datalist id="rx-days-supply"><option value="7"><\/option>/);
  assert.match(r.text, /<datalist id="rx-drug-list">[\s\S]*?<option value="Testosterone cypionate">/);
  assert.match(r.text, /<select name="pharmacy_id" id="pharmacy_id"/);
  assert.match(r.text, /Save this pharmacy to the clinic list/);
  assert.match(r.text, /<select id="diagnosis" name="diagnosis"/);
});

test("sig is built from builder fields when the textarea is empty; typed sig wins", async () => {
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Trazodone", sig: "", sig_action: "Take", sig_amount: "1", sig_unit: "tablet(s)",
    sig_route: "by mouth", sig_frequency: "at bedtime", sig_for: "sleep" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(last().sig, "Take 1 tablet(s) by mouth at bedtime for sleep.");
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Hydroxyzine", sig: "",
    sig_action: "Inject", sig_amount: "0.50", sig_unit: "mL", sig_route: "into the muscle", sig_frequency: "once weekly" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(last().sig, "Inject 0.5 mL into the muscle once weekly.");
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Buspirone", sig: "Take as directed.", sig_action: "Take", sig_frequency: "twice daily" }));
  assert.equal(r.status, 302);
  assert.equal(last().sig, "Take as directed.");
  // Sig still required overall
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Prazosin", sig: "" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Enter the directions \(sig\)/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Prazosin", sig: "", sig_frequency: "at bedtime" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Choose at least an action/);
  // The drug datalist now includes drugs prescribed earlier
  const tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.match(tab.text, /<datalist id="rx-drug-list">[\s\S]*?<option value="Trazodone">/);
});

test("diagnosis select lists the client's active diagnoses; Other is ICD-checked", async () => {
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, status) VALUES (?, 'F41.1', 'Generalized anxiety disorder', 'active')").run(pid);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, status) VALUES (?, 'F32.0', 'Old resolved episode', 'resolved')").run(pid);
  const tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.match(tab.text, /<option value="F41.1">F41.1 · Generalized anxiety disorder<\/option>/);
  assert.doesNotMatch(tab.text, /Old resolved episode/);
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Escitalopram", diagnosis: "F41.1" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(last().diagnosis, "F41.1");
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Fluoxetine", diagnosis: "__other", diagnosis_other: "f33.1" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(last().diagnosis, "F33.1");
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Paroxetine", diagnosis: "__other", diagnosis_other: "anxiety" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Enter an ICD-10 code/);
});

test("pharmacy management on the log page: add, list, remove (audited)", async () => {
  let page = await c.get("/ehr/prescriptions");
  assert.match(page.text, /Saved pharmacies/);
  let r = await c.post("/ehr/prescriptions/pharmacies", { name: "", address: "x" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT count(*) n FROM pharmacies").get().n, 0);
  r = await c.post("/ehr/prescriptions/pharmacies", { name: "Main St Pharmacy", address: "1 Main St, Phoenix, AZ 85001", phone: "", fax: "602-555-0199", ncpdp: "1234567" });
  assert.equal(r.status, 302);
  const ph = t.db.prepare("SELECT * FROM pharmacies WHERE name = 'Main St Pharmacy'").get();
  assert.equal(ph.active, 1);
  assert.equal(ph.ncpdp, "1234567");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'pharmacy' AND entity_id = ? AND action = 'create'").get(ph.id));
  r = await c.post("/ehr/prescriptions/pharmacies", { name: "Gone Drugs", address: "9 Old Rd" });
  const gone = t.db.prepare("SELECT * FROM pharmacies WHERE name = 'Gone Drugs'").get();
  page = await c.get("/ehr/prescriptions");
  assert.match(page.text, /Main St Pharmacy/);
  assert.match(page.text, /Gone Drugs/);
  r = await c.post(`/ehr/prescriptions/pharmacies/${gone.id}/remove`, {});
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT active FROM pharmacies WHERE id = ?").get(gone.id).active, 0);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'pharmacy' AND entity_id = ? AND action = 'update'").get(gone.id));
  page = await c.get("/ehr/prescriptions");
  assert.doesNotMatch(page.text, /<strong>Gone Drugs<\/strong>/);
  // A therapist (not a prescriber) can't manage the list
  const th = await t.login("therapist");
  assert.equal((await th.post("/ehr/prescriptions/pharmacies", { name: "Nope" })).status, 403);
  assert.doesNotMatch((await th.get("/ehr/prescriptions")).text, /Saved pharmacies/);
});

test("saved pharmacy fills the pharmacy fields; typed values win", async () => {
  const ph = t.db.prepare("SELECT * FROM pharmacies WHERE name = 'Main St Pharmacy'").get();
  const tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.match(tab.text, new RegExp(`<option value="${ph.id}" >Main St Pharmacy · 1 Main St, Phoenix, AZ 85001</option>`));
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Mirtazapine", delivery: "fax", pharmacy_id: String(ph.id), pharmacy: "", pharmacy_phone: "" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  let row = last();
  assert.equal(row.pharmacy, "Main St Pharmacy, 1 Main St, Phoenix, AZ 85001");
  assert.equal(row.pharmacy_phone, "602-555-0199");
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Bupropion", pharmacy_id: String(ph.id), pharmacy: "Typed Pharmacy", pharmacy_phone: "555-0000" }));
  assert.equal(r.status, 302);
  row = last();
  assert.equal(row.pharmacy, "Typed Pharmacy");
  assert.equal(row.pharmacy_phone, "555-0000");
});

test("'Save this pharmacy' adds a typed pharmacy to the clinic list (once)", async () => {
  const before = t.db.prepare("SELECT count(*) n FROM pharmacies").get().n;
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Lamotrigine", pharmacy: "Corner Drug, 22 Elm St, Tucson, AZ", pharmacy_phone: "520-555-0101", save_pharmacy: "1" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const ph = t.db.prepare("SELECT * FROM pharmacies WHERE name = 'Corner Drug'").get();
  assert.ok(ph);
  assert.equal(ph.address, "22 Elm St, Tucson, AZ");
  assert.equal(ph.phone, "520-555-0101");
  assert.equal(ph.active, 1);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'pharmacy' AND entity_id = ? AND action = 'create'").get(ph.id));
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Lithium", pharmacy: "Corner Drug, 22 Elm St, Tucson, AZ", save_pharmacy: "1" }));
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT count(*) n FROM pharmacies").get().n, before + 1);
  // Not ticked: nothing saved
  await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Clonidine", pharmacy: "Unsaved Rx, 3 Oak" }));
  assert.equal(t.db.prepare("SELECT count(*) n FROM pharmacies WHERE name = 'Unsaved Rx'").get().n, 0);
});

test("discontinue with a listed reason; void with Other; reason required", async () => {
  const r1 = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Quetiapine" }));
  assert.equal(r1.status, 302);
  const a = last();
  const tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.match(tab.text, new RegExp(`<select id="disc_reason_${a.id}" name="reason" required[^>]*>[\\s\\S]*?<option value="Side effects">`));
  assert.match(tab.text, new RegExp(`<select id="void_reason_${a.id}" name="reason" required[^>]*>[\\s\\S]*?<option value="Wrong client">`));
  assert.match(tab.text, new RegExp(`name="reason_other" id="void_reason_${a.id}_other"`));
  let r = await c.post(`/ehr/prescriptions/${a.id}/discontinue`, { reason: "" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT status FROM prescriptions WHERE id = ?").get(a.id).status, "active");
  r = await c.post(`/ehr/prescriptions/${a.id}/discontinue`, { reason: "__other", reason_other: "" });
  assert.equal(t.db.prepare("SELECT status FROM prescriptions WHERE id = ?").get(a.id).status, "active");
  r = await c.post(`/ehr/prescriptions/${a.id}/discontinue`, { reason: "Side effects" });
  assert.equal(r.status, 302);
  let row = t.db.prepare("SELECT status, end_reason FROM prescriptions WHERE id = ?").get(a.id);
  assert.deepEqual([row.status, row.end_reason], ["discontinued", "Side effects"]);

  await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Olanzapine" }));
  const b = last();
  r = await c.post(`/ehr/prescriptions/${b.id}/void`, { reason: "__other", reason_other: "Pharmacy closed permanently" });
  assert.equal(r.status, 302);
  row = t.db.prepare("SELECT status, end_reason FROM prescriptions WHERE id = ?").get(b.id);
  assert.deepEqual([row.status, row.end_reason], ["voided", "Pharmacy closed permanently"]);
});

test("controlled prescription still works with the new fields (DEA + PDMP)", async () => {
  const r = await c.post(`/ehr/patients/${pid}/prescriptions`, base({ drug: "Testosterone cypionate", schedule: "III", pdmp_checked: "1", quantity_unit: "mL", quantity: "10",
    sig: "", sig_action: "Inject", sig_amount: "0.5", sig_unit: "mL", sig_route: "into the muscle", sig_frequency: "once weekly", diagnosis: "__other", diagnosis_other: "E29.1" }));
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const row = last();
  assert.equal(row.schedule, "III");
  assert.equal(row.sig, "Inject 0.5 mL into the muscle once weekly.");
  assert.equal(row.diagnosis, "E29.1");
});
