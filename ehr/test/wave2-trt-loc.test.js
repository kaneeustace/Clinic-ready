"use strict";
/* Wave 2 dropdowns: TRT (side effects, stop reason, ancillary meds, void reason, frequency, supplier) and level of care (payer, program, reviewer). */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");

let t, pid, lpid;
before(async () => {
  t = await start();
  t.db.prepare("UPDATE clinic_settings SET trt_enabled = 1 WHERE id = 1").run();
  pid = t.ctx.patients[3];
  lpid = t.ctx.patients[4];
  t.db.prepare("DELETE FROM loc_episodes WHERE patient_id = ?").run(lpid);
  t.db.prepare("DELETE FROM loc_authorizations WHERE patient_id = ?").run(lpid);
  t.db.prepare("DELETE FROM insurance_policies WHERE patient_id = ?").run(lpid);
});
after(async () => { await t.stop(); });

const prog = () => t.db.prepare("SELECT * FROM trt_programs WHERE patient_id = ?").get(pid);
const base = { status: "active", medication: "cypionate", route: "im", dose_mg: "100", start_date: addDays(today(), -30) };

test("TRT frequency dropdown: listed value, Other whole number, invalid Other refused", async () => {
  const c = await t.login("therapist");
  let tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /<select id="frequency_days" name="frequency_days"/);
  assert.match(tab.text, /Every 2 weeks \(14 days\)/);
  let r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "14" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(prog().frequency_days, 14);
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "__other", frequency_days_other: "5" });
  assert.equal(r.status, 302);
  assert.equal(prog().frequency_days, 5);
  tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /name="frequency_days_other" id="frequency_days_other" value="5"/);
  for (const bad of ["0", "400", "2.5", "abc"]) {
    r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "__other", frequency_days_other: bad });
    assert.equal(r.status, 400, bad);
  }
  assert.equal(prog().frequency_days, 5);
});

test("TRT ancillary meds: checkboxes with doses plus Other, stored as text, pre-checked; plain text still works", async () => {
  const c = await t.login("therapist");
  let r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "7",
    anc: ["Anastrozole", "hCG (human chorionic gonadotropin)"], anc_dose_0: "0.5 mg twice weekly", anc_dose_1: "500 IU twice weekly", ancillary_other: "DHEA 25 mg daily" });
  assert.equal(r.status, 302);
  assert.equal(prog().ancillary, "Anastrozole 0.5 mg twice weekly; hCG 500 IU twice weekly; DHEA 25 mg daily");
  const tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /name="anc" value="Anastrozole" checked/);
  assert.match(tab.text, /name="anc_dose_0"[^>]*value="0\.5 mg twice weekly"/);
  assert.match(tab.text, /name="anc" value="hCG \(human chorionic gonadotropin\)" checked/);
  assert.doesNotMatch(tab.text, /name="anc" value="Finasteride" checked/);
  assert.match(tab.text, /name="ancillary_other"[^>]*value="DHEA 25 mg daily"/);
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "7", ancillary: "Anastrozole 1 mg weekly" });
  assert.equal(prog().ancillary, "Anastrozole 1 mg weekly");
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "7", anc: "Finasteride" });
  assert.equal(prog().ancillary, "Finasteride");
});

test("TRT stop reason: dropdown with Other, required when stopped", async () => {
  const c = await t.login("therapist");
  let r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, status: "stopped", frequency_days: "7" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Say why therapy stopped/);
  assert.match(r.text, /<select id="stop_reason" name="stop_reason"/);
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, status: "stopped", frequency_days: "7", stop_reason: "Hematocrit too high" });
  assert.equal(r.status, 302);
  assert.equal(prog().stop_reason, "Hematocrit too high");
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, status: "stopped", frequency_days: "7", stop_reason: "__other", stop_reason_other: "Moved away" });
  assert.equal(prog().stop_reason, "Moved away");
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, status: "stopped", frequency_days: "7", stop_reason: "__other", stop_reason_other: "" });
  assert.equal(r.status, 400);
  // back to active for the rest
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { ...base, frequency_days: "7" });
  assert.equal(r.status, 302);
});

test("TRT side effects: checkboxes + notes joined into side_effects; pre-checked on error re-render; plain text works", async () => {
  const c = await t.login("therapist");
  const tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /name="side_effect" value="Acne \/ oily skin"/);
  let r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), bp_sys: "120", bp_dia: "80", side_effect: ["Acne / oily skin", "Headache"], side_effects_notes: "mild, improving" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const last = () => t.db.prepare("SELECT side_effects FROM trt_visits WHERE patient_id = ? ORDER BY id DESC LIMIT 1").get(pid).side_effects;
  assert.equal(last(), "Acne / oily skin; Headache — mild, improving");
  r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), side_effect: "Hair loss" });
  assert.equal(r.status, 302);
  assert.equal(last(), "Hair loss");
  r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), side_effects: "Mild acne" });
  assert.equal(last(), "Mild acne");
  // Error (bad BP) keeps the ticks and notes
  r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), bp_sys: "999", bp_dia: "80", side_effect: ["Swelling / edema"], side_effects_notes: "ankles" });
  assert.equal(r.status, 400);
  assert.match(r.text, /name="side_effect" value="Swelling \/ edema" checked/);
  assert.doesNotMatch(r.text, /name="side_effect" value="Headache" checked/);
  assert.match(r.text, /name="side_effects_notes"[^>]*value="ankles"/);
});

test("TRT void reason: dropdown with Other, required; supplier datalist lists suppliers used", async () => {
  const c = await t.login("therapist");
  let r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "administered", medication: "cypionate", dose_mg: "100" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const doses = () => t.db.prepare("SELECT * FROM trt_doses WHERE patient_id = ? ORDER BY id DESC").all(pid);
  let d = doses()[0];
  const tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, new RegExp(`<select id="void_reason_${d.id}" name="void_reason" required`));
  r = await c.post(`/ehr/patients/${pid}/trt/doses/${d.id}/void`, { void_reason: "" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/trt/doses/${d.id}/void`, { void_reason: "__other", void_reason_other: "" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/trt/doses/${d.id}/void`, { void_reason: "Duplicate entry" });
  assert.equal(r.status, 302);
  assert.equal(doses()[0].void_reason, "Duplicate entry");
  await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "administered", medication: "cypionate", dose_mg: "100" });
  d = doses()[0];
  r = await c.post(`/ehr/patients/${pid}/trt/doses/${d.id}/void`, { void_reason: "__other", void_reason_other: "Pharmacy recall" });
  assert.equal(r.status, 302);
  assert.equal(doses()[0].void_reason, "Pharmacy recall");

  for (const [lot, supplier] of [["S1", "Acme Pharma"], ["S2", "Acme Pharma"], ["S3", "Beta Wholesale"]]) {
    r = await c.post("/ehr/trt/inventory/lots", { product: "Testosterone cypionate 200 mg/mL", lot_number: lot, expiration: addDays(today(), 300), concentration_mg_ml: "200", quantity_ml: "10", received_on: today(), supplier });
    assert.equal(r.status, 302, r.text.slice(0, 300));
  }
  const inv = await c.get("/ehr/trt/inventory");
  assert.match(inv.text, /name="supplier"[^>]*list="trt-suppliers"/);
  const dl = inv.text.match(/<datalist id="trt-suppliers">([\s\S]*?)<\/datalist>/)[1];
  assert.equal((dl.match(/value="Acme Pharma"/g) || []).length, 1);
  assert.match(dl, /value="Beta Wholesale"/);
});

test("LOC payer: client's policies first (primary pre-filled), standard payers, Other; plain text works", async () => {
  t.db.prepare("INSERT INTO insurance_policies (patient_id, priority, payer_name, member_id, active) VALUES (?, 'secondary', 'Second Plan Co', 'S1', 1)").run(lpid);
  t.db.prepare("INSERT INTO insurance_policies (patient_id, priority, payer_name, member_id, active) VALUES (?, 'primary', 'Mercy Care', 'P1', 1)").run(lpid);
  t.db.prepare("INSERT INTO insurance_policies (patient_id, priority, payer_name, member_id, active) VALUES (?, 'primary', 'Old Plan', 'O1', 0)").run(lpid);
  const c = await t.login("therapist");
  let r = await c.post(`/ehr/patients/${lpid}/level-of-care`, { level: "iop", start_date: addDays(today(), -5), program: "Evening IOP" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const tab = await c.get(`/ehr/patients/${lpid}/level-of-care`);
  const sel = tab.text.match(/<select id="new-payer" name="payer"[\s\S]*?<\/select>/)[0];
  assert.match(sel, /<optgroup label="This client&#39;s insurance"><option value="Mercy Care" selected>Mercy Care<\/option><option value="Second Plan Co">/);
  assert.doesNotMatch(sel, /Old Plan/);
  assert.equal((sel.match(/value="Mercy Care"/g) || []).length, 1, "client's payer not repeated in the standard list");
  assert.match(sel, /<optgroup label="Commercial">/);
  assert.match(sel, /value="__other"/);
  const auth = () => t.db.prepare("SELECT * FROM loc_authorizations WHERE patient_id = ? ORDER BY id DESC LIMIT 1").get(lpid);
  r = await c.post(`/ehr/patients/${lpid}/authorizations`, { level: "iop", status: "pending", unit_type: "sessions", payer: "Second Plan Co", reviewer: "Dana R." });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(auth().payer, "Second Plan Co");
  r = await c.post(`/ehr/patients/${lpid}/authorizations`, { level: "iop", status: "pending", unit_type: "sessions", payer: "__other", payer_other: "Tiny Local Plan" });
  assert.equal(auth().payer, "Tiny Local Plan");
  r = await c.post(`/ehr/patients/${lpid}/authorizations`, { level: "iop", status: "pending", unit_type: "sessions", payer: "Free Text Payer" });
  assert.equal(auth().payer, "Free Text Payer");
  // Saved non-listed payer shows in the edit form's Other box
  const page = await c.get(`/ehr/patients/${lpid}/level-of-care`);
  assert.match(page.text, new RegExp(`id="a${auth().id}-payer_other" value="Free Text Payer"`));
});

test("LOC program dropdown from clinic programs list with Other", async () => {
  const c = await t.login("therapist");
  const tab = await c.get(`/ehr/patients/${lpid}/level-of-care`);
  const ep = t.db.prepare("SELECT * FROM loc_episodes WHERE patient_id = ? AND end_date IS NULL").get(lpid);
  assert.equal(ep.program, "Evening IOP");
  assert.match(tab.text, new RegExp(`<select id="ep${ep.id}-program" name="program"[^>]*>[\\s\\S]*?<option value="Evening IOP" selected>`));
  assert.match(tab.text, /<select id="new-ep-program" name="program"[^>]*>[\s\S]*?Women&#39;s program[\s\S]*?value="__other"/);
  let r = await c.post(`/ehr/patients/${lpid}/level-of-care/${ep.id}/edit`, { level: "iop", start_date: ep.start_date, program: "__other", program_other: "Veterans track" });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(t.db.prepare("SELECT program FROM loc_episodes WHERE id = ?").get(ep.id).program, "Veterans track");
  const page = await c.get(`/ehr/patients/${lpid}/level-of-care`);
  assert.match(page.text, new RegExp(`id="ep${ep.id}-program_other" value="Veterans track"`));
});

test("LOC reviewer datalist: distinct reviewers saved for that payer", async () => {
  const c = await t.login("therapist");
  for (const [payer, reviewer] of [["Mercy Care", "Pat Q."], ["Mercy Care", "Pat Q."], ["Mercy Care", "Lee W."], ["Aetna", "Aetna Person"]]) {
    const r = await c.post(`/ehr/patients/${lpid}/authorizations`, { level: "iop", status: "pending", unit_type: "sessions", payer, reviewer });
    assert.equal(r.status, 302);
  }
  const tab = await c.get(`/ehr/patients/${lpid}/level-of-care`);
  assert.match(tab.text, /name="reviewer"[^>]*list="new-reviewers"/);
  const dl = tab.text.match(/<datalist id="new-reviewers">([\s\S]*?)<\/datalist>/)[1];
  assert.equal((dl.match(/value="Pat Q\."/g) || []).length, 1);
  assert.match(dl, /value="Lee W\."/);
  assert.doesNotMatch(dl, /Aetna Person|Dana R\./);
  const aetna = t.db.prepare("SELECT id FROM loc_authorizations WHERE patient_id = ? AND payer = 'Aetna'").get(lpid);
  const dl2 = tab.text.match(new RegExp(`<datalist id="a${aetna.id}-reviewers">([\\s\\S]*?)</datalist>`))[1];
  assert.match(dl2, /value="Aetna Person"/);
  assert.doesNotMatch(dl2, /Pat Q\./);
});
