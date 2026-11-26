"use strict";
// Staff credentials, clinic state/taxonomy and prescription route/form/license-state dropdowns.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");
const sup = require("../src/supervision");
const { educationModifier } = require("../src/payers");
const rx = require("../src/routes/rx");

let t;
const PW = "Test-Password-123!";
const NEW_PW = "Another-Password-456!";
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const userByEmail = (email) => t.db.prepare("SELECT * FROM users WHERE email = ?").get(email);

test("add/edit user forms show credential dropdowns from the shared list", async () => {
  const admin = await t.login("admin");
  const r = await admin.get("/ehr/admin/users/new");
  assert.equal(r.status, 200);
  assert.match(r.text, /<select id="credentials" name="credentials"/);
  assert.match(r.text, /<select id="credentials_2" name="credentials_2"/);
  assert.match(r.text, /name="credentials_other"/);
  assert.match(r.text, /<option value="LCSW">LCSW · Licensed Clinical Social Worker<\/option>/);
  // Editing splits the saved "LCSW, PhD" across the two dropdowns
  t.db.prepare("UPDATE users SET credentials = 'LCSW, PhD' WHERE id = ?").run(t.ctx.users.therapist2);
  const e = await admin.get(`/ehr/admin/users/${t.ctx.users.therapist2}/edit`);
  assert.match(e.text, /<select id="credentials" name="credentials"[^>]*>[\s\S]*?<option value="LCSW" selected>/);
  assert.match(e.text, /<select id="credentials_2" name="credentials_2"[^>]*>[\s\S]*?<option value="PhD" selected>/);
});

test("LCSW added from the dropdown needs no co-sign and can supervise; LMSW needs co-sign", async () => {
  const admin = await t.login("admin");
  let r = await admin.post("/ehr/admin/users", { name: "Lena Lcsw", email: "lena@example.com", role: "clinician", credentials: "LCSW", credentials_2: "", password: NEW_PW });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const lena = userByEmail("lena@example.com");
  assert.equal(lena.credentials, "LCSW");
  assert.equal(sup.requiresCosign(lena), false);
  assert.equal(sup.canSupervise(lena), true);

  r = await admin.post("/ehr/admin/users", { name: "Max Lmsw", email: "max@example.com", role: "clinician", credentials: "LMSW", password: NEW_PW });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const max = userByEmail("max@example.com");
  assert.equal(sup.requiresCosign(max), true);
  assert.equal(sup.canSupervise(max), false);
});

test("two dropdowns are stored joined; Other text is kept", async () => {
  const admin = await t.login("admin");
  let r = await admin.post("/ehr/admin/users", { name: "Dana Dual", email: "dana@example.com", role: "clinician", credentials: "LMSW", credentials_2: "__other",
    credentials_2_other: "CCTP", password: NEW_PW });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const dana = userByEmail("dana@example.com");
  assert.equal(dana.credentials, "LMSW, CCTP");
  // Edit: second credential PhD makes her independent; a duplicate is dropped
  r = await admin.post(`/ehr/admin/users/${dana.id}/edit`, { name: "Dana Dual", role: "clinician", credentials: "LMSW", credentials_2: "PhD", npi: "", active: "1" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(userByEmail("dana@example.com").credentials, "LMSW, PhD");
  assert.equal(sup.requiresCosign(userByEmail("dana@example.com")), false);
  r = await admin.post(`/ehr/admin/users/${dana.id}/edit`, { name: "Dana Dual", role: "clinician", credentials: "LPC", credentials_2: "LPC", npi: "", active: "1" });
  assert.equal(userByEmail("dana@example.com").credentials, "LPC");
});

test("legacy free-text credentials still count (dots ignored, list flags first, regex fallback)", () => {
  const u = (credentials) => ({ role: "clinician", credentials, requires_cosign: null, active: 1 });
  assert.equal(sup.requiresCosign(u("L.C.S.W.")), false);
  assert.equal(sup.canSupervise(u("L.C.S.W.")), true);
  assert.equal(sup.requiresCosign(u("Psy.D.")), false);
  assert.equal(sup.requiresCosign(u("lpc")), false);
  assert.equal(sup.requiresCosign(u("LPC-S")), false); // not in the list: regex fallback
  assert.equal(sup.requiresCosign(u("DNP")), false);   // not in the list: regex fallback
  assert.equal(sup.requiresCosign(u("L.M.S.W.")), true);
  assert.equal(sup.requiresCosign(u("BHT")), true);
  assert.equal(sup.requiresCosign(u("")), true);
  assert.equal(sup.INDEPENDENT_RE instanceof RegExp, true);
  // Education modifier: list flags (highest wins), regex for other text
  assert.equal(educationModifier({ credentials: "LCSW, PhD" }), "HP");
  assert.equal(educationModifier({ credentials: "L.M.S.W." }), "HO");
  assert.equal(educationModifier({ credentials: "LBSW" }), "HN");
  assert.equal(educationModifier({ credentials: "BHPP" }), "HM");
  assert.equal(educationModifier({ credentials: "MSW" }), "HO");
  assert.equal(educationModifier({ credentials: "Ed.D." }), "HP");
  assert.equal(educationModifier({ credentials: "LMSW", education_level: "HP" }), "HP");
  assert.equal(educationModifier({ credentials: "" }), null);
  // Prescribing
  assert.equal(rx.prescribingCredential("PMHNP-BC"), true);
  assert.equal(rx.prescribingCredential("M.D."), true);
  assert.equal(rx.prescribingCredential("AGNP-C"), true); // regex fallback
  assert.equal(rx.prescribingCredential("LCSW, PhD"), false);
  assert.equal(rx.prescribingCredential("RN"), false);
});

test("legacy L.C.S.W. saved on a user is independent in the app", async () => {
  t.db.prepare("UPDATE users SET credentials = 'L.C.S.W.', requires_cosign = NULL, supervisor_id = NULL WHERE id = ?").run(t.ctx.users.therapist2);
  const u = t.db.prepare("SELECT * FROM users WHERE id = ?").get(t.ctx.users.therapist2);
  assert.equal(sup.requiresCosign(u), false);
  assert.equal(sup.canSupervise(u), true);
  // The edit form keeps the legacy text visible under "Other"
  const admin = await t.login("admin");
  const e = await admin.get(`/ehr/admin/users/${u.id}/edit`);
  assert.match(e.text, /<option value="__other" selected>/);
  assert.match(e.text, /name="credentials_other"[^>]*value="L\.C\.S\.W\."/);
});

test("PMHNP-BC from the dropdown turns prescribing on", async () => {
  const admin = await t.login("admin");
  const r = await admin.post("/ehr/admin/users", { name: "Pia Pmhnp", email: "pia@example.com", role: "clinician", credentials: "PMHNP-BC", credentials_2: "",
    npi: "1234567893", password: NEW_PW });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(userByEmail("pia@example.com").can_prescribe, 1);
});

test("clinic settings: state is a validated dropdown; taxonomy dropdown with Other", async () => {
  const admin = await t.login("admin");
  const page = await admin.get("/ehr/admin/clinic");
  assert.match(page.text, /<select id="state" name="state"/);
  assert.match(page.text, /<select id="taxonomy" name="taxonomy"/);
  assert.match(page.text, /261QM0801X · Mental Health Clinic/);
  const base = { name: "Sunrise Counseling", city: "Mesa", state: "AZ", zip: "85201", npi: "1234567893", tax_id: "861234567", color: "teal" };
  let r = await admin.post("/ehr/admin/clinic", { ...base, state: "ZZ" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Choose the state from the list/);
  r = await admin.post("/ehr/admin/clinic", { ...base, taxonomy: "261QM0801X" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  let row = t.db.prepare("SELECT state, taxonomy FROM clinic_settings WHERE id = 1").get();
  assert.deepEqual([row.state, row.taxonomy], ["AZ", "261QM0801X"]);
  // Other: any valid code; still validated by the taxonomy pattern
  r = await admin.post("/ehr/admin/clinic", { ...base, taxonomy: "__other", taxonomy_other: "bad" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Taxonomy codes are 10 characters/);
  r = await admin.post("/ehr/admin/clinic", { ...base, taxonomy: "__other", taxonomy_other: "225x00000x" });
  assert.equal(r.status, 302);
  row = t.db.prepare("SELECT taxonomy FROM clinic_settings WHERE id = 1").get();
  assert.equal(row.taxonomy, "225X00000X");
  const again = await admin.get("/ehr/admin/clinic");
  assert.match(again.text, /<option value="__other" selected>/);
});

test("prescriber license state is a validated dropdown", async () => {
  const admin = await t.login("admin");
  let r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", dea_number: "BP1234563", dea_expires: "2030-01-01",
    license_number: "NP-1", license_state: "AZ" });
  assert.equal(r.status, 302);
  const e = await admin.get(`/ehr/admin/users/${t.ctx.users.prescriber}/edit`);
  assert.match(e.text, /<select id="license_state" name="license_state"[^>]*>[\s\S]*?<option value="AZ" selected>/);
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", dea_number: "BP1234563", dea_expires: "2030-01-01",
    license_number: "NP-1", license_state: "ZZ" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT license_state FROM users WHERE id = ?").get(t.ctx.users.prescriber).license_state, "AZ");
  r = await admin.post(`/ehr/admin/users/${t.ctx.users.prescriber}/prescriber`, { can_prescribe: "1", dea_number: "BP1234563", dea_expires: "2030-01-01",
    license_number: "NP-1", license_state: "NM" });
  assert.equal(t.db.prepare("SELECT license_state FROM users WHERE id = ?").get(t.ctx.users.prescriber).license_state, "NM");
});

test("prescription form: route/form dropdowns, template prefill, print shows them", async () => {
  t.db.prepare("UPDATE clinic_settings SET trt_enabled = 1 WHERE id = 1").run();
  const pid = t.ctx.patients[3];
  const c = await t.login("prescriber");
  const tab = await c.get(`/ehr/patients/${pid}/prescriptions`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /<select id="route" name="route"/);
  assert.match(tab.text, /<select id="dosage_form" name="dosage_form"/);
  const tpl = await c.get(`/ehr/patients/${pid}/prescriptions?template=cypionate`);
  assert.match(tpl.text, /<select id="route" name="route"[^>]*>[\s\S]*?<option value="Intramuscular \(IM\)" selected>/);
  assert.match(tpl.text, /<select id="dosage_form" name="dosage_form"[^>]*>[\s\S]*?<option value="Injectable solution \(vial\)" selected>/);
  assert.match(tpl.text, /value="200 mg\/mL \(10 mL multi-dose vial\)"/);
  // Every template's route and form are list values (or blank)
  const O = require("../src/options");
  for (const x of rx.TEMPLATES) {
    assert.ok(!x.route || O.inList(O.MED_ROUTES, x.route), `${x.key} route`);
    assert.ok(!x.dosage_form || O.inList(O.DOSAGE_FORMS, x.dosage_form), `${x.key} form`);
  }
  // Sign one with the dropdown values and an "Other" route
  const body = { drug: "Testosterone cypionate", strength: "200 mg/mL (10 mL multi-dose vial)", dosage_form: "Injectable solution (vial)", route: "Intramuscular (IM)",
    sig: "Inject 0.5 mL (100 mg) IM once weekly.", quantity: "10", quantity_unit: "mL", days_supply: "140", refills: "1", schedule: "III", diagnosis: "E29.1",
    delivery: "print", written_on: today(), pdmp_checked: "1", allow_duplicate: "1", allergy_override: "1", password: PW };
  let r = await c.post(`/ehr/patients/${pid}/prescriptions`, body);
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const row = t.db.prepare("SELECT id, route, dosage_form FROM prescriptions WHERE patient_id = ? ORDER BY id DESC LIMIT 1").get(pid);
  assert.deepEqual([row.route, row.dosage_form], ["Intramuscular (IM)", "Injectable solution (vial)"]);
  const print = await c.get(`/ehr/prescriptions/${row.id}/print`);
  assert.equal(print.status, 200);
  assert.match(print.text, /Injectable solution \(vial\) · Intramuscular \(IM\)/);
  assert.match(print.text, /200 mg\/mL \(10 mL multi-dose vial\)/);

  r = await c.post(`/ehr/patients/${pid}/prescriptions`, { ...body, drug: "Testosterone enanthate", route: "__other", route_other: "Ventrogluteal IM", dosage_form: "Long-acting injectable suspension" });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const row2 = t.db.prepare("SELECT route, dosage_form FROM prescriptions WHERE patient_id = ? ORDER BY id DESC LIMIT 1").get(pid);
  assert.deepEqual([row2.route, row2.dosage_form], ["Ventrogluteal IM", "Long-acting injectable suspension"]);
});
