"use strict";
// Billing dropdowns: modifier slots, place of service list, fee schedule "Add a code" picker.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { addDays, today } = require("../src/views");

let t, pid;
const dos = () => addDays(today(), -3);
const lastCharge = (p) => t.db.prepare("SELECT * FROM charges WHERE patient_id = ? ORDER BY id DESC").get(p);
const charge = (body) => ({
  date_of_service: dos(), cpt_code: "90834", units: "1", rendering_provider_id: t.ctx.users.therapist, bill_to: "insurance", dx_other: "F41.1", ...body,
});
// The <select name="..."> element's HTML, for checking options inside one dropdown only.
const selectHtml = (text, name) => {
  const m = text.match(new RegExp(`<select[^>]*name="${name}"[^>]*>[\\s\\S]*?</select>`));
  return m ? m[0] : "";
};

before(async () => {
  t = await start();
  pid = t.ctx.patients[t.ctx.patients.length - 1];
  t.db.prepare("UPDATE patients SET ahcccs_id = NULL WHERE id = ?").run(pid);
});
after(async () => { await t.stop(); });

test("charge form shows four modifier dropdowns and the full place-of-service list", async () => {
  const c = await t.login("billing");
  const r = await c.get(`/ehr/patients/${pid}/charges/new`);
  assert.equal(r.status, 200);
  for (const i of [1, 2, 3, 4]) {
    const s = selectHtml(r.text, `modifier_${i}`);
    assert.ok(s, `modifier_${i} select present`);
    assert.match(s, /<option value="" selected>—<\/option>/);
    assert.match(s, /<option value="HO">/);
    assert.match(s, /<optgroup label="Telehealth">/);
  }
  assert.doesNotMatch(r.text, /<input name="modifier"/);
  const pos = selectHtml(r.text, "pos");
  for (const code of ["53", "57", "55", "49", "22", "11", "02", "10"]) assert.match(pos, new RegExp(`<option value="${code}"`));
});

test("suggested modifiers are pre-selected in the slots on first render", async () => {
  const c = await t.login("billing");
  const d = dos();
  const appt = Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, status, modality)
    VALUES (?, ?, ?, ?, 'therapy', 'completed', 'telehealth')`).run(pid, t.ctx.users.therapist, `${d}T09:00`, `${d}T09:55`).lastInsertRowid);
  const r = await c.get(`/ehr/patients/${pid}/charges/new?appointment_id=${appt}`);
  assert.equal(r.status, 200);
  assert.match(selectHtml(r.text, "modifier_1"), /<option value="95" selected>/);
  assert.match(selectHtml(r.text, "modifier_2"), /<option value="" selected>/);
});

test("modifier slots combine into the stored space-separated value; old text field still works", async () => {
  const c = await t.login("billing");
  let r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier_1: "HO", modifier_2: "95", modifier_3: "", modifier_4: "" }));
  assert.equal(r.status, 302, r.text.slice(0, 1500));
  assert.equal(lastCharge(pid).modifier, "HO 95");

  // blank slots in the middle are skipped, order kept
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier_1: "", modifier_2: "XE", modifier_3: "", modifier_4: "59" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).modifier, "XE 59");

  // no modifiers -> NULL, as before
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier_1: "", modifier_2: "" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).modifier, null);

  // older free-text fields
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier: "gt ho" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).modifier, "GT HO");
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifiers: "95" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).modifier, "95");

  // a less common but valid modifier still passes MODIFIER_RE validation; a bad one does not
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier_1: "U4" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).modifier, "U4");
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier_1: "ABC" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /Each modifier must be 2 letters or digits/);

  // more than 4 (slots plus old text) is rejected
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ modifier_1: "HO", modifier_2: "95", modifier_3: "XE", modifier_4: "59", modifier: "25" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /at most 4 modifiers/);
  // the re-rendered form keeps the chosen slots
  assert.match(selectHtml(r.text, "modifier_1"), /<option value="HO" selected>/);
  assert.match(selectHtml(r.text, "modifier_4"), /<option value="59" selected>/);
});

test("new place-of-service codes are accepted; AHCCCS still rejects telehealth POS 02/10", async () => {
  const c = await t.login("billing");
  let r = await c.post(`/ehr/patients/${pid}/charges`, charge({ pos: "53" }));
  assert.equal(r.status, 302);
  assert.equal(lastCharge(pid).pos, "53");
  r = await c.post(`/ehr/patients/${pid}/charges`, charge({ pos: "XX" }));
  assert.equal(r.status, 400);

  t.db.prepare("UPDATE patients SET ahcccs_id = 'A99999999' WHERE id = ?").run(pid);
  try {
    for (const pos of ["02", "10"]) {
      r = await c.post(`/ehr/patients/${pid}/charges`, charge({ pos, modifier_1: "GT" }));
      assert.equal(r.status, 400);
      assert.match(r.text, /not POS 02\/10/);
    }
    r = await c.post(`/ehr/patients/${pid}/charges`, charge({ pos: "57", modifier_1: "95" }));
    assert.equal(r.status, 400);
    assert.match(r.text, /does not accept modifier 95 or 93/);
  } finally {
    t.db.prepare("UPDATE patients SET ahcccs_id = NULL WHERE id = ?").run(pid);
  }
});

test("fee schedule: Add a code is a dropdown; a listed code fills the description; Other saves a custom code", async () => {
  const a = await t.login("admin");
  const page = await a.get("/ehr/billing/fee-schedule");
  assert.equal(page.status, 200);
  const s = selectHtml(page.text, "cpt_code");
  assert.match(s, /<option value="H2019">/);
  assert.match(s, /<option value="__other">/);
  assert.match(page.text, /name="cpt_code_other"/);

  t.db.prepare("DELETE FROM fee_schedule WHERE cpt_code IN ('H2019', '0592T', 'H2020')").run();
  let r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "H2019", cpt_code_other: "", description: "", fee: "30", active: "1" });
  assert.equal(r.status, 302, r.text.slice(0, 1500));
  let row = t.db.prepare("SELECT * FROM fee_schedule WHERE cpt_code = 'H2019'").get();
  assert.equal(row.description, "Therapeutic behavioral services, per 15 minutes");
  assert.equal(row.fee_cents, 3000);

  // a typed description wins
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "H2019", description: "TBS (custom)", fee: "31", active: "1" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT description FROM fee_schedule WHERE cpt_code = 'H2019'").get().description, "TBS (custom)");
  // updating an existing code without a description keeps the saved description
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "H2019", fee: "32", active: "1" });
  assert.equal(r.status, 302);
  row = t.db.prepare("SELECT * FROM fee_schedule WHERE cpt_code = 'H2019'").get();
  assert.equal(row.description, "TBS (custom)");
  assert.equal(row.fee_cents, 3200);

  // Other: custom code, validated by CPT_RE
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "__other", cpt_code_other: "0592t", description: "Custom category III", fee: "45", active: "1" });
  assert.equal(r.status, 302, r.text.slice(0, 1500));
  assert.equal(t.db.prepare("SELECT fee_cents FROM fee_schedule WHERE cpt_code = '0592T'").get().fee_cents, 4500);
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "__other", cpt_code_other: "9X83A", description: "Bad", fee: "45", active: "1" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Code must be a CPT code/);
  // Other without a description for an unlisted code still needs one
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "__other", cpt_code_other: "H2020", description: "", fee: "45", active: "1" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Description is required/);
  // nothing chosen
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "", cpt_code_other: "", description: "x", fee: "45", active: "1" });
  assert.equal(r.status, 400);
});
