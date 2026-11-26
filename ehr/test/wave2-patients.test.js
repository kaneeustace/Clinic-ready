"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t;
before(async () => {
  t = await start();
  // Make the prescriber's flag explicit (seeding may or may not turn it on), and make sure the therapist can't prescribe.
  t.db.prepare("UPDATE users SET can_prescribe = 1 WHERE id = ?").run(t.ctx.users.prescriber);
  t.db.prepare("UPDATE users SET can_prescribe = 0 WHERE id = ?").run(t.ctx.users.therapist);
});
after(async () => { await t.stop(); });

function makePatient(last = "Wave") {
  return Number(t.db.prepare("INSERT INTO patients (mrn, first_name, last_name, dob, status) VALUES (?, 'Wen', ?, '1980-02-03', 'active')")
    .run(`W2-${Math.random().toString(36).slice(2, 10)}`, last).lastInsertRowid);
}
const selectRe = (name) => new RegExp(`<select[^>]*name="${name}"`);
const base = { first_name: "Wave", dob: "1990-01-01" };

/* ---------------- allergies ---------------- */

test("allergy: type select + reaction dropdown render; listed values save and show; Other reaction saves", async () => {
  const pid = makePatient("Allergyson");
  const c = await t.login("therapist");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, selectRe("allergy_type"));
  assert.match(chart.text, /<option value="latex">Latex<\/option>/);
  assert.match(chart.text, selectRe("reaction"));
  assert.match(chart.text, /name="reaction_other"/);
  assert.match(chart.text, /<option value="Hives">Hives<\/option>/);

  const r1 = await c.post(`/ehr/patients/${pid}/allergies`, { substance: "Penicillin", allergy_type: "drug", reaction: "Hives", reaction_other: "", severity: "moderate" });
  assert.equal(r1.status, 302);
  const r2 = await c.post(`/ehr/patients/${pid}/allergies`, { substance: "Peanuts", allergy_type: "", reaction: "__other", reaction_other: "Throat tingling" });
  assert.equal(r2.status, 302);
  const rows = t.db.prepare("SELECT substance, allergy_type, reaction FROM allergies WHERE patient_id = ? ORDER BY id").all(pid);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { substance: "Penicillin", allergy_type: "drug", reaction: "Hives" },
    { substance: "Peanuts", allergy_type: null, reaction: "Throat tingling" },
  ]);
  const after = await c.get(`/ehr/patients/${pid}`);
  assert.match(after.text, /Penicillin<\/strong> <span class="muted small">\(Drug \/ medication\)<\/span>/);
  assert.match(after.text, /Throat tingling/);
});

test("allergy: invalid type is rejected", async () => {
  const pid = makePatient("Badtype");
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/allergies`, { substance: "Dust", allergy_type: "radioactive" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose an allergy type from the list/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM allergies WHERE patient_id = ?").get(pid).n, 0);
});

/* ---------------- patient form: emergency relation, pronouns, gender identity ---------------- */

test("patient form: relationship, pronouns, gender identity are dropdowns with Other", async () => {
  const c = await t.login("frontdesk");
  const form = await c.get("/ehr/patients/new");
  for (const n of ["emergency_relation", "pronouns", "gender_identity"]) {
    assert.match(form.text, selectRe(n), n);
    assert.match(form.text, new RegExp(`name="${n}_other"`), n);
  }
  assert.match(form.text, /<option value="Legal guardian">Legal guardian<\/option>/);
  assert.match(form.text, /<option value="they\/them">they\/them<\/option>/);
  assert.match(form.text, /<option value="Non-binary">Non-binary<\/option>/);
});

test("patient form: listed values save and reselect on edit", async () => {
  const c = await t.login("frontdesk");
  const r = await c.post("/ehr/patients", { ...base, last_name: "Listedvals", emergency_name: "Sam", emergency_relation: "Sibling",
    pronouns: "they/them", gender_identity: "Non-binary" });
  assert.equal(r.status, 302);
  const p = t.db.prepare("SELECT * FROM patients WHERE last_name = 'Listedvals'").get();
  assert.equal(p.emergency_relation, "Sibling");
  assert.equal(p.pronouns, "they/them");
  assert.equal(p.gender_identity, "Non-binary");
  const edit = await c.get(`/ehr/patients/${p.id}/edit`);
  assert.match(edit.text, /<option value="Sibling" selected>/);
  assert.match(edit.text, /<option value="they\/them" selected>/);
  assert.match(edit.text, /<option value="Non-binary" selected>/);
});

test("patient form: Other text saves, blank stays optional, legacy value shows in Other box", async () => {
  const c = await t.login("frontdesk");
  const r = await c.post("/ehr/patients", { ...base, last_name: "Othervals", emergency_relation: "__other", emergency_relation_other: "Godparent",
    pronouns: "__other", pronouns_other: "xe/xem", gender_identity: "__other", gender_identity_other: "Agender" });
  assert.equal(r.status, 302);
  const p = t.db.prepare("SELECT * FROM patients WHERE last_name = 'Othervals'").get();
  assert.equal(p.emergency_relation, "Godparent");
  assert.equal(p.pronouns, "xe/xem");
  assert.equal(p.gender_identity, "Agender");
  const edit = await c.get(`/ehr/patients/${p.id}/edit`);
  assert.match(edit.text, /name="pronouns_other"[^>]*value="xe\/xem"/);
  assert.match(edit.text, /name="emergency_relation_other"[^>]*value="Godparent"/);

  const blank = await c.post("/ehr/patients", { ...base, last_name: "Blankvals", pronouns: "", gender_identity: "", emergency_relation: "" });
  assert.equal(blank.status, 302);
  const b = t.db.prepare("SELECT * FROM patients WHERE last_name = 'Blankvals'").get();
  assert.equal(b.pronouns, null);
  assert.equal(b.gender_identity, null);
  assert.equal(b.emergency_relation, null);
});

/* ---------------- insurance subscriber relationship ---------------- */

test("insurance: subscriber relationship uses X12 list; new and old values save; invalid rejected", async () => {
  const pid = makePatient("Subscriber");
  const c = await t.login("frontdesk");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, selectRe("subscriber_relation"));
  assert.match(chart.text, /<option value="self" selected>18 · Self<\/option>/);
  assert.match(chart.text, /<option value="life_partner">53 · Life partner<\/option>/);

  for (const [priority, rel] of [["primary", "life_partner"], ["secondary", "spouse"]]) {
    const r = await c.post(`/ehr/patients/${pid}/insurance`, { priority, payer_name: "Mercy Care", subscriber_name: "Pat Doe", subscriber_relation: rel });
    assert.equal(r.status, 302, rel);
  }
  const rels = t.db.prepare("SELECT subscriber_relation FROM insurance_policies WHERE patient_id = ? ORDER BY id").all(pid).map((r) => r.subscriber_relation);
  assert.deepEqual(rels, ["life_partner", "spouse"]);
  const after = await c.get(`/ehr/patients/${pid}`);
  assert.match(after.text, /\(Life partner\)/);

  const bad = await c.post(`/ehr/patients/${pid}/insurance`, { priority: "secondary", payer_name: "Mercy Care", subscriber_relation: "cousin" });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose a relationship from the list/);
});

/* ---------------- medication prescriber ---------------- */

test("medication prescriber: dropdown of active prescribers; listed and outside prescriber save; edit reselects", async () => {
  const pid = makePatient("Medsworth");
  const c = await t.login("therapist");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, selectRe("prescriber"));
  assert.match(chart.text, /<option value="Pat Prescriber, PMHNP-BC">Pat Prescriber, PMHNP-BC<\/option>/);
  assert.doesNotMatch(chart.text, /<option value="Taylor Therapist, LCSW">/);
  assert.match(chart.text, /name="prescriber_other"/);

  const r1 = await c.post(`/ehr/patients/${pid}/medications`, { name: "Sertraline", prescriber: "Pat Prescriber, PMHNP-BC", prescriber_other: "" });
  assert.equal(r1.status, 302);
  const r2 = await c.post(`/ehr/patients/${pid}/medications`, { name: "Lisinopril", prescriber: "__other", prescriber_other: "Dr. Outside, MD" });
  assert.equal(r2.status, 302);
  const meds = t.db.prepare("SELECT id, name, prescriber FROM medications WHERE patient_id = ? ORDER BY id").all(pid);
  assert.deepEqual(meds.map((m) => m.prescriber), ["Pat Prescriber, PMHNP-BC", "Dr. Outside, MD"]);

  const e1 = await c.get(`/ehr/patients/${pid}/medications/${meds[0].id}/edit`);
  assert.match(e1.text, /<option value="Pat Prescriber, PMHNP-BC" selected>/);
  const e2 = await c.get(`/ehr/patients/${pid}/medications/${meds[1].id}/edit`);
  assert.match(e2.text, /name="prescriber_other"[^>]*value="Dr. Outside, MD"/);

  const up = await c.post(`/ehr/patients/${pid}/medications/${meds[1].id}/edit`, { name: "Lisinopril", prescriber: "Pat Prescriber, PMHNP-BC", prescriber_other: "" });
  assert.equal(up.status, 302);
  assert.equal(t.db.prepare("SELECT prescriber FROM medications WHERE id = ?").get(meds[1].id).prescriber, "Pat Prescriber, PMHNP-BC");
});
