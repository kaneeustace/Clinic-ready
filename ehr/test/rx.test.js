"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");
const rx = require("../src/routes/rx");

let t, pid;
const PW = "Test-Password-123!";
before(async () => {
  t = await start();
  pid = t.ctx.patients[9];
});
after(async () => { await t.stop(); });

const base = () => ({ drug: "Testosterone cypionate", strength: "200 mg/mL", dosage_form: "Injectable solution", route: "Intramuscular",
  sig: "Inject 0.5 mL (100 mg) IM once weekly.", quantity: "10", quantity_unit: "mL", days_supply: "140", refills: "1", schedule: "III",
  diagnosis: "E29.1", delivery: "print", written_on: today(), pdmp_checked: "1", password: PW });

test("DEA check digit and quantity in words", () => {
  assert.equal(rx.deaValid("BP1234563"), true);
  assert.equal(rx.deaValid("BP1234564"), false);
  assert.equal(rx.deaValid("12345678"), false);
  assert.equal(rx.toWords(10), "ten");
  assert.equal(rx.toWords(142), "one hundred forty-two");
  assert.equal(rx.toWords(2.5), "two and 50/100");
});

test("prescribing credentials turn prescribing on automatically", async () => {
  assert.equal(rx.prescribingCredential("PMHNP-BC"), true);
  assert.equal(rx.prescribingCredential("MSN, PMHNP"), true);
  for (const c of ["FNP-C", "NP", "MD", "DO", "PA-C", "APRN", "AGNP-C", "CNP"]) assert.equal(rx.prescribingCredential(c), true, c);
  for (const c of ["LCSW", "LPC", "LISAC", "BHT", "RN", "", null, "PhD"]) assert.equal(rx.prescribingCredential(c), false, String(c));
  // The seeded PMHNP can prescribe; the LCSW can't
  assert.equal(t.db.prepare("SELECT can_prescribe FROM users WHERE id = ?").get(t.ctx.users.prescriber).can_prescribe, 1);
  assert.equal(t.db.prepare("SELECT can_prescribe FROM users WHERE id = ?").get(t.ctx.users.therapist).can_prescribe, 0);
  // A new PMHNP added by the admin can prescribe right away
  const admin = await t.login("admin");
  let r = await admin.post("/ehr/admin/users", { name: "Nia Nurse", email: "nia@example.com", role: "clinician", credentials: "PMHNP-BC", npi: "1234567893", password: "Another-Password-456!" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const nia = t.db.prepare("SELECT id, can_prescribe FROM users WHERE email = 'nia@example.com'").get();
  assert.equal(nia.can_prescribe, 1);
  // Changing a counselor's credentials to FNP turns it on too
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.therapist2}/edit`, { name: "Casey Counselor", role: "clinician", credentials: "FNP-C", npi: "0000000002", active: "1" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT can_prescribe FROM users WHERE id = ?").get(t.ctx.users.therapist2).can_prescribe, 1);
});

test("only set-up prescribers can write; admin sets DEA (validated)", async () => {
  const admin0 = await t.login("admin");
  await admin0.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, {}); // switched off by the admin
  const c = await t.login("prescriber");
  let tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Only prescribers can write prescriptions/);
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, base());
  assert.equal(r.status, 403);

  const admin = await t.login("admin");
  const edit = await admin.get(`/ehr/admin/users/${t.ctx.users.prescriber}/edit`);
  assert.match(edit.text, /Can write prescriptions/);
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", dea_number: "BP1234564" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT can_prescribe FROM users WHERE id = ?").get(t.ctx.users.prescriber).can_prescribe, 0);
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.frontdesk}/prescriber`, { can_prescribe: "1" });
  assert.equal(t.db.prepare("SELECT can_prescribe FROM users WHERE id = ?").get(t.ctx.users.frontdesk).can_prescribe, 0);
  // Without a DEA number: non-controlled is fine, controlled is refused
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", license_state: "AZ", license_number: "NP-1" });
  assert.equal(t.db.prepare("SELECT can_prescribe FROM users WHERE id = ?").get(t.ctx.users.prescriber).can_prescribe, 1);
  tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.match(tab.text, /Write a prescription/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base());
  assert.equal(r.status, 400);
  assert.match(r.text, /need a DEA number/);
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", dea_number: "bp1234563", dea_expires: "2030-01-01", license_state: "AZ", license_number: "NP-1" });
  assert.equal(t.db.prepare("SELECT dea_number FROM users WHERE id = ?").get(t.ctx.users.prescriber).dea_number, "BP1234563");
  // Therapist (not a prescriber) can view but not write
  const th = await t.login("therapist");
  assert.equal((await th.post(`/ehr/patients/${pid}/prescriptions`, base())).status, 403);
});

test("controlled-substance rules, signing, print/reprint, medication list, renew, discontinue", async () => {
  const c = await t.login("prescriber");
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...base(), refills: "6" });
  assert.equal(r.status, 400);
  assert.match(r.text, /At most 5 refills for Schedule III/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...base(), schedule: "II", refills: "1" });
  assert.match(r.text, /Schedule II prescriptions can&#39;t have refills|Schedule II prescriptions can't have refills/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...base(), schedule: "II", refills: "0", delivery: "fax", pharmacy: "X" });
  assert.match(r.text, /can(&#39;|')t be faxed/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...base(), pdmp_checked: undefined });
  assert.match(r.text, /PDMP/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...base(), password: "wrong" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Password is incorrect/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM prescriptions").get().n, 0);

  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base());
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.match(r.location, /\/ehr\/prescriptions\/\d+\/print/);
  const p1 = t.db.prepare("SELECT * FROM prescriptions ORDER BY id DESC").get();
  assert.equal(p1.schedule, "III");
  const med = t.db.prepare("SELECT * FROM medications WHERE id = ?").get(p1.medication_id);
  assert.equal(med.active, 1);
  assert.match(med.prescriber, /Pat Prescriber/);

  let pr = await c.get(r.location);
  assert.equal(pr.status, 200);
  assert.match(pr.text, /10 \(ten\) mL/);
  assert.match(pr.text, /DEA BP1234563/);
  assert.match(pr.text, /not valid without the prescriber/);
  assert.doesNotMatch(pr.text, /COPY · NOT VALID/);
  pr = await c.get(r.location);
  assert.match(pr.text, /COPY · NOT VALID FOR DISPENSING/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'prescription' AND action = 'reprint'").get());

  // Duplicate active prescription needs confirmation
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, base());
  assert.equal(r.status, 400);
  assert.match(r.text, /already an active Testosterone cypionate/);

  // Renew replaces the old one
  const tab = await c.get(`/ehr/patients/${pid}/prescriptions?renew=${p1.id}`);
  assert.match(tab.text, /Renew prescription/);
  assert.match(tab.text, new RegExp(`name="renewed_from" value="${p1.id}"`));
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...base(), renewed_from: String(p1.id), delivery: "external" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT status FROM prescriptions WHERE id = ?").get(p1.id).status, "discontinued");
  assert.equal(t.db.prepare("SELECT active FROM medications WHERE id = ?").get(p1.medication_id).active, 0);
  const p2 = t.db.prepare("SELECT * FROM prescriptions ORDER BY id DESC").get();
  assert.equal(p2.renewed_from, p1.id);

  // Allergy check
  t.db.prepare("INSERT INTO allergies (patient_id, substance) VALUES (?, 'Sulfamethoxazole')").run(pid);
  const noControl = { ...base(), drug: "Sulfamethoxazole-trimethoprim", strength: "800-160 mg", schedule: "", quantity_unit: "tablets", quantity: "14", pdmp_checked: undefined, refills: "0" };
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, noControl);
  assert.equal(r.status, 400);
  assert.match(r.text, /Allergy on file: Sulfamethoxazole/);
  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...noControl, allergy_override: "1" });
  assert.equal(r.status, 302);

  // Discontinue
  r = await c.post(`/ehr/prescriptions/${p2.id}/discontinue`, { reason: "Dose change" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT status, end_reason FROM prescriptions WHERE id = ?").get(p2.id).end_reason, "Dose change");

  // Log + CSV
  const log = await c.get("/ehr/prescriptions?controlled=1");
  assert.equal(log.status, 200);
  assert.match(log.text, /Testosterone cypionate/);
  assert.doesNotMatch(log.text, /Sulfamethoxazole/);
  const csv = await c.get("/ehr/prescriptions?format=csv");
  assert.match(csv.text, /^written_on,rx_id,client_mrn/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'prescription' AND action = 'sign'").get());
});

test("TRT tab links to prescriptions and the testosterone template", async () => {
  t.db.prepare("UPDATE clinic_settings SET trt_enabled = 1 WHERE id = 1").run();
  const c = await t.login("prescriber");
  const tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /Write a testosterone prescription/);
  const form = await c.get(`/ehr/patients/${pid}/prescriptions?template=cypionate`);
  assert.match(form.text, /value="Testosterone cypionate"/);
  assert.match(form.text, /Inject 0\.5 mL \(100 mg\)/);
});
