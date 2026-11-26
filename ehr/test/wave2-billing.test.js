"use strict";
// Wave 2 billing: payment methods (ACH, insurance EFT/check), adjustment types, CARC denial reasons, diagnosis code pickers.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { addDays, today } = require("../src/views");

let t, pid;
const dos = () => addDays(today(), -3);
const lastPayment = (p) => t.db.prepare("SELECT * FROM payments WHERE patient_id = ? ORDER BY id DESC").get(p);
const lastCharge = (p) => t.db.prepare("SELECT * FROM charges WHERE patient_id = ? ORDER BY id DESC").get(p);
const selectHtml = (text, name) => {
  const m = text.match(new RegExp(`<select[^>]*name="${name}"[^>]*>[\\s\\S]*?</select>`));
  return m ? m[0] : "";
};
const charge = (body) => ({
  date_of_service: dos(), cpt_code: "90834", units: "1", rendering_provider_id: t.ctx.users.therapist, bill_to: "patient", ...body,
});

before(async () => {
  t = await start();
  pid = t.ctx.patients[t.ctx.patients.length - 1];
  t.db.prepare("UPDATE patients SET ahcccs_id = NULL WHERE id = ?").run(pid);
  t.db.prepare("DELETE FROM payments WHERE patient_id = ?").run(pid);
  t.db.prepare("DELETE FROM charges WHERE patient_id = ?").run(pid);
  t.db.prepare("DELETE FROM diagnoses WHERE patient_id = ?").run(pid);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, is_primary) VALUES (?, 'F33.1', 'Major depressive disorder, recurrent, moderate', 1)").run(pid);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, is_primary) VALUES (?, 'F41.1', 'Generalized anxiety disorder', 0)").run(pid);
});
after(async () => { await t.stop(); });

test("payment form lists every payment method, an adjustment type menu and the check/EFT hint", async () => {
  const c = await t.login("billing");
  const r = await c.get(`/ehr/patients/${pid}/billing`);
  assert.equal(r.status, 200);
  const m = selectHtml(r.text, "method");
  for (const v of ["card", "cash", "check", "ach", "insurance_eft", "insurance_check", "insurance", "adjustment"]) assert.match(m, new RegExp(`<option value="${v}"`));
  const a = selectHtml(r.text, "adjustment_type");
  assert.match(a, /Contractual adjustment/);
  assert.match(a, /value="__other"/);
  assert.match(r.text, /Check or EFT number/);
});

test("ACH and insurance EFT payments save", async () => {
  const c = await t.login("billing");
  let r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "50", method: "ach", reference: "ACH-123", received_on: dos() });
  assert.equal(r.status, 302);
  let p = lastPayment(pid);
  assert.equal(p.method, "ach");
  assert.equal(p.amount_cents, 5000);
  assert.equal(p.adjustment_type, null);
  r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "80", method: "insurance_eft", reference: "EFT-9", received_on: dos(), adjustment_type: "Write-off" });
  assert.equal(r.status, 302);
  p = lastPayment(pid);
  assert.equal(p.method, "insurance_eft");
  assert.equal(p.adjustment_type, null, "adjustment type only saved for adjustments");
  const page = await c.get(`/ehr/patients/${pid}/billing`);
  assert.match(page.text, /Bank transfer \(ACH\)/);
  assert.match(page.text, /Insurance payment \(EFT\)/);
});

test("an adjustment requires an adjustment type, which is saved and shown", async () => {
  const c = await t.login("billing");
  const before = t.db.prepare("SELECT COUNT(*) n FROM payments WHERE patient_id = ?").get(pid).n;
  let r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "10", method: "adjustment", received_on: dos() });
  assert.equal(r.status, 400);
  assert.match(r.text, /Choose an adjustment type/);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM payments WHERE patient_id = ?").get(pid).n, before);

  r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "10", method: "adjustment", adjustment_type: "Contractual adjustment", received_on: dos() });
  assert.equal(r.status, 302);
  assert.equal(lastPayment(pid).adjustment_type, "Contractual adjustment");

  r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "3", method: "adjustment", adjustment_type: "__other", adjustment_type_other: "Promo credit", received_on: dos() });
  assert.equal(r.status, 302);
  assert.equal(lastPayment(pid).adjustment_type, "Promo credit");

  const page = await c.get(`/ehr/patients/${pid}/billing`);
  assert.match(page.text, /Contractual adjustment/);
  assert.match(page.text, /Promo credit/);
});

test("marking a charge denied requires a CARC reason, which is saved and shown", async () => {
  const c = await t.login("billing");
  let r = await c.post(`/ehr/patients/${pid}/charges`, charge({ dx_other: "F41.1" }));
  assert.equal(r.status, 302);
  const ch = lastCharge(pid);
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "billed" });
  assert.equal(r.status, 302);

  let page = await c.get(`/ehr/patients/${pid}/billing`);
  assert.match(selectHtml(page.text, "denial_reason"), /CO-16 · Missing or invalid claim information/);

  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "denied" });
  assert.equal(r.status, 400);
  assert.match(r.text, /denial reason/i);
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "denied", denial_reason: "XX-1" });
  assert.equal(r.status, 400);
  assert.equal(lastCharge(pid).status, "billed");

  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "denied", denial_reason: "CO-197" });
  assert.equal(r.status, 302);
  const after = lastCharge(pid);
  assert.equal(after.status, "denied");
  assert.equal(after.denial_reason, "CO-197");
  page = await c.get(`/ehr/patients/${pid}/billing`);
  assert.match(page.text, /CO-197 · Prior authorization missing/);
  const dash = await c.get(`/ehr/billing?status=denied`);
  assert.match(dash.text, /CO-197/);

  // Re-billing keeps the earlier denial reason for history; other transitions need no reason.
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "billed" });
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).denial_reason, "CO-197");
});

test("charge form offers active diagnoses, a common ICD-10 menu and other codes, combined into one list", async () => {
  const c = await t.login("billing");
  const form = await c.get(`/ehr/patients/${pid}/charges/new`);
  assert.equal(form.status, 200);
  assert.match(form.text, /name="dx" value="F33.1"/);
  assert.match(selectHtml(form.text, "dx_common"), /<option value="F43.10"|<option value="F32.1"/);
  assert.match(form.text, /Other codes/);

  let r = await c.post(`/ehr/patients/${pid}/charges`, charge({ dx: ["F41.1", "F33.1"], dx_common: "F32.1", dx_other: "Z63.0, F41.1" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).diagnosis_codes, "F33.1,F41.1,F32.1,Z63.0");

  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ dx_common: "F32.1" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).diagnosis_codes, "F32.1");

  const n = t.db.prepare("SELECT COUNT(*) n FROM charges WHERE patient_id = ?").get(pid).n;
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ dx_common: "F32.1", dx_other: "bogus" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Not a valid ICD-10 code: BOGUS/);
  assert.match(selectHtml(r.text, "dx_common"), /<option value="F32.1" selected>/);
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ dx_common: "nope" }));
  assert.equal(r.status, 400);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM charges WHERE patient_id = ?").get(pid).n, n);
});
