"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t;
let pid; // a patient with no seeded billing activity, for clean balance math
before(async () => {
  t = await start();
  pid = t.ctx.patients[t.ctx.patients.length - 1];
  t.db.prepare("DELETE FROM payments WHERE patient_id = ?").run(pid);
  t.db.prepare("DELETE FROM charges WHERE patient_id = ?").run(pid);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, is_primary) VALUES (?, 'F41.1', 'Generalized anxiety disorder', 0)").run(pid);
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, is_primary) VALUES (?, 'F33.1', 'Major depressive disorder, recurrent, moderate', 1)").run(pid);
});
after(async () => { await t.stop(); });

const balance = (patientId) => {
  const c = t.db.prepare("SELECT COALESCE(SUM(fee_cents),0) n FROM charges WHERE patient_id = ? AND status != 'void'").get(patientId).n;
  const p = t.db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE patient_id = ?").get(patientId).n;
  return c - p;
};

function pastCompletedAppt(patientId) {
  const d = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  const clin = t.ctx.users.therapist;
  return Number(t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, status)
    VALUES (?, ?, ?, ?, 'therapy', 'completed')`).run(patientId, clin, `${d}T09:00`, `${d}T09:55`).lastInsertRowid);
}

test("billing dashboard renders totals, work queue and charges", async () => {
  const c = await t.login("billing");
  const r = await c.get("/ehr/billing");
  assert.equal(r.status, 200);
  assert.match(r.text, /Unbilled charges/);
  assert.match(r.text, /Completed appointments without charges/);
  assert.match(r.text, /Create charge/);
  const f = await c.get("/ehr/billing?status=unbilled&from=2000-01-01&to=2100-01-01");
  assert.equal(f.status, 200);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'charge' AND action = 'view' AND detail = 'billing dashboard'").get());
});

test("charge form prefills from the appointment and creates a charge from the fee schedule", async () => {
  const c = await t.login("billing");
  const apptId = pastCompletedAppt(pid);
  const q = await c.get("/ehr/billing");
  assert.match(q.text, new RegExp(`appointment_id=${apptId}`));

  const form = await c.get(`/ehr/patients/${pid}/charges/new?appointment_id=${apptId}`);
  assert.equal(form.status, 200);
  assert.match(form.text, /<option value="90837" selected>/); // 55 min therapy
  assert.ok(form.text.indexOf("F33.1") < form.text.indexOf("F41.1"), "primary diagnosis first");

  const r = await c.post(`/ehr/patients/${pid}/charges`, {
    appointment_id: apptId, date_of_service: t.db.prepare("SELECT substr(start_at,1,10) d FROM appointments WHERE id = ?").get(apptId).d,
    cpt_code: "90837", units: "1", fee: "", rendering_provider_id: t.ctx.users.therapist, bill_to: "insurance", dx: ["F41.1", "F33.1"],
  });
  assert.equal(r.status, 302, r.text.slice(0, 2000));
  const ch = t.db.prepare("SELECT * FROM charges WHERE appointment_id = ?").get(apptId);
  assert.equal(ch.fee_cents, 17500);
  assert.equal(ch.status, "unbilled");
  assert.equal(ch.diagnosis_codes, "F33.1,F41.1"); // problem-list order, primary first
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'create' AND entity_type = 'charge' AND entity_id = ?").get(ch.id));
  const q2 = await c.get("/ehr/billing");
  assert.doesNotMatch(q2.text, new RegExp(`appointment_id=${apptId}"`));
});

test("units multiply the scheduled fee", async () => {
  const c = await t.login("billing");
  const r = await c.post(`/ehr/patients/${pid}/charges`, {
    date_of_service: "2026-01-05", cpt_code: "96127", units: "2", rendering_provider_id: t.ctx.users.therapist, bill_to: "patient", dx_other: "F41.1",
  });
  assert.equal(r.status, 302);
  const ch = t.db.prepare("SELECT * FROM charges WHERE patient_id = ? AND cpt_code = '96127' ORDER BY id DESC").get(pid);
  assert.equal(ch.fee_cents, 3000);
  assert.equal(ch.units, 2);
});

test("invalid charges are rejected with 400", async () => {
  const c = await t.login("billing");
  const base = { date_of_service: "2026-01-05", units: "1", rendering_provider_id: t.ctx.users.therapist, dx_other: "F41.1" };
  const before = t.db.prepare("SELECT COUNT(*) n FROM charges").get().n;
  for (const body of [
    { ...base, cpt_code: "12345" },             // not in fee schedule
    { ...base, cpt_code: "9083" },              // bad format
    { ...base, cpt_code: "90834", units: "11" },
    { ...base, cpt_code: "90834", units: "0" },
    { ...base, cpt_code: "90834", dx_other: "not-a-code" },
  ]) {
    const r = await c.post(`/ehr/patients/${pid}/charges`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // appointment belonging to another patient
  const other = t.ctx.patients[0];
  const otherAppt = pastCompletedAppt(other);
  const r = await c.post(`/ehr/patients/${pid}/charges`, { ...base, cpt_code: "90834", appointment_id: otherAppt });
  assert.equal(r.status, 400);
  assert.match(r.text, /does not belong to this patient/);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM charges").get().n, before);
});

test("ledger balance math with payments, adjustments and void", async () => {
  const c = await t.login("billing");
  const start = balance(pid);
  await c.post(`/ehr/patients/${pid}/charges`, {
    date_of_service: "2026-02-02", cpt_code: "90834", units: "1", rendering_provider_id: t.ctx.users.therapist, dx_other: "F41.1",
  });
  const ch = t.db.prepare("SELECT * FROM charges WHERE patient_id = ? ORDER BY id DESC").get(pid);
  assert.equal(balance(pid), start + 13500);

  let r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "$25.00", method: "card", reference: "T1", received_on: "2026-02-02" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/patients/${pid}/payments`, { amount: "10.50", method: "adjustment", received_on: "2026-02-03" });
  assert.equal(r.status, 302);
  assert.equal(balance(pid), start + 13500 - 2500 - 1050);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'create' AND entity_type = 'payment' AND patient_id = ?").get(pid));

  for (const bad of [{ amount: "0" }, { amount: "-5" }, { amount: "abc" }, { amount: "5", method: "bitcoin" }, { amount: "5", received_on: "2026-13-01" }]) {
    const x = await c.post(`/ehr/patients/${pid}/payments`, { method: "cash", received_on: "2026-02-03", ...bad });
    assert.equal(x.status, 400, JSON.stringify(bad));
  }

  const page = await c.get(`/ehr/patients/${pid}/billing`);
  assert.equal(page.status, 200);
  const expected = (balance(pid) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  assert.ok(page.text.includes(expected), `balance ${expected} shown`);
  assert.match(page.text, /Insurance on file/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'charge' AND patient_id = ? AND detail = 'ledger'").get(pid));

  // status workflow
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "paid" });
  assert.equal(r.status, 400); // unbilled cannot jump to paid
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "billed" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "void" });
  assert.equal(r.status, 400); // needs confirmation
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "void", confirm: "yes" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT status FROM charges WHERE id = ?").get(ch.id).status, "void");
  assert.equal(balance(pid), start - 2500 - 1050);
  r = await c.post(`/ehr/charges/${ch.id}/status`, { status: "billed" });
  assert.equal(r.status, 400); // void is final
  assert.equal(t.db.prepare("SELECT status FROM charges WHERE id = ?").get(ch.id).status, "void");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'void' AND entity_type = 'charge' AND entity_id = ?").get(ch.id));
});

test("clinicians and front desk can view but not change billing", async () => {
  const ch = t.db.prepare("SELECT * FROM charges WHERE status = 'unbilled' LIMIT 1").get();
  for (const key of ["therapist", "frontdesk"]) {
    const c = await t.login(key);
    assert.equal((await c.get("/ehr/billing")).status, 200);
    assert.equal((await c.get(`/ehr/patients/${pid}/billing`)).status, 200);
    const r = await c.post(`/ehr/patients/${pid}/charges`, { date_of_service: "2026-01-05", cpt_code: "90834", units: "1", rendering_provider_id: t.ctx.users.therapist, dx_other: "F41.1" });
    assert.equal(r.status, 403);
    assert.equal((await c.post(`/ehr/patients/${pid}/payments`, { amount: "5", method: "cash", received_on: "2026-01-05" })).status, 403);
    assert.equal((await c.post(`/ehr/charges/${ch.id}/status`, { status: "billed" })).status, 403);
    assert.equal((await c.get(`/ehr/patients/${pid}/charges/new`)).status, 403);
  }
  assert.equal(t.db.prepare("SELECT status FROM charges WHERE id = ?").get(ch.id).status, "unbilled");
});

test("fee schedule: everyone with billing:read views, only admin edits", async () => {
  const b = await t.login("billing");
  assert.equal((await b.get("/ehr/billing/fee-schedule")).status, 200);
  assert.equal((await b.post("/ehr/billing/fee-schedule", { cpt_code: "90834", fee: "1" })).status, 403);

  const a = await t.login("admin");
  let r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "90834", fee: "140.00", active: "1" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT fee_cents FROM fee_schedule WHERE cpt_code = '90834'").get().fee_cents, 14000);
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "0591t", description: "Demo category III code", fee: "50", active: "1" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT fee_cents FROM fee_schedule WHERE cpt_code = '0591T'").get().fee_cents, 5000);
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "9X83A", description: "Bad", fee: "50" });
  assert.equal(r.status, 400);
  r = await a.post("/ehr/billing/fee-schedule", { cpt_code: "90999", description: "No fee", fee: "" });
  assert.equal(r.status, 400);
});

test("superbill renders printable statement and is audited", async () => {
  const c = await t.login("billing");
  await c.post(`/ehr/patients/${pid}/charges`, {
    date_of_service: "2026-03-10", cpt_code: "90837", units: "1", rendering_provider_id: t.ctx.users.therapist, dx: ["F33.1"],
  });
  await c.post(`/ehr/patients/${pid}/payments`, { amount: "40", method: "check", reference: "CHK-9", received_on: "2026-03-10" });
  const r = await c.get(`/ehr/patients/${pid}/superbill?from=2026-03-01&to=2026-03-31`);
  assert.equal(r.status, 200);
  assert.match(r.text, /data-print/);
  assert.match(r.text, /Clinic Ready Behavioral Health/);
  assert.match(r.text, /123 Placeholder Ave/);
  assert.match(r.text, /90837/);
  assert.match(r.text, /F33\.1/);
  assert.match(r.text, /Taylor Therapist, LCSW/);
  assert.match(r.text, /NPI 0000000001/);
  assert.match(r.text, /\$175\.00/);
  assert.match(r.text, /\$40\.00/);
  assert.match(r.text, /\$135\.00/);
  const a = t.db.prepare("SELECT * FROM audit_log WHERE entity_type = 'superbill' AND action = 'view' ORDER BY id DESC").get();
  assert.equal(a.patient_id, pid);
  assert.doesNotMatch(a.detail || "", /F33|90837|Therapist/);
  // clinicians can view a superbill
  const th = await t.login("therapist");
  assert.equal((await th.get(`/ehr/patients/${pid}/superbill`)).status, 200);
});

test("unknown patient or charge returns 404", async () => {
  const c = await t.login("billing");
  assert.equal((await c.get("/ehr/patients/999999/billing")).status, 404);
  assert.equal((await c.post("/ehr/charges/999999/status", { status: "billed" })).status, 404);
});
