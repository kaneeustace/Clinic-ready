"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");
const trt = require("../src/routes/trt");

let t, pid;
before(async () => {
  t = await start();
  pid = t.ctx.patients[2];
});
after(async () => { await t.stop(); });

const onHand = (lotId) => t.db.prepare("SELECT COALESCE(SUM(quantity_ml),0) AS q FROM trt_ledger WHERE lot_id = ?").get(lotId).q;

test("off by default: no tab, no nav, pages explain how to turn it on", async () => {
  t.db.prepare("UPDATE clinic_settings SET trt_enabled = 0 WHERE id = 1").run();
  const c = await t.login("therapist");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.equal(chart.status, 200);
  assert.doesNotMatch(chart.text, /Hormone therapy/);
  const r = await c.get(`/ehr/patients/${pid}/trt`);
  assert.equal(r.status, 404);
  assert.match(r.text, /Hormone therapy is turned off/);
  assert.equal((await c.get("/ehr/trt")).status, 404);
});

test("admin turns it on in Clinic settings; tab and nav appear; front desk can't open it", async () => {
  const admin = await t.login("admin");
  const page = await admin.get("/ehr/admin/clinic");
  assert.match(page.text, /Hormone therapy \(testosterone replacement, TRT\)/);
  let r = await admin.post("/ehr/admin/clinic/programs", { trt_enabled: "1" });
  assert.equal(r.status, 302);
  assert.equal(trt.trtEnabled(t.db), true);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'clinic_settings' AND detail = 'trt on'").get());

  const c = await t.login("therapist");
  const chart = await c.get(`/ehr/patients/${pid}`);
  assert.match(chart.text, /href="\/ehr\/patients\/\d+\/trt"[^>]*>Hormone therapy/);
  assert.match(chart.text, /href="\/ehr\/trt"/);
  const fd = await t.login("frontdesk");
  assert.equal((await fd.get(`/ehr/patients/${pid}/trt`)).status, 403);
  assert.doesNotMatch((await fd.get(`/ehr/patients/${pid}`)).text, /Hormone therapy/);
});

test("start a program (validated), banner pill, labs flags and labs due", async () => {
  const c = await t.login("therapist");
  let r = await c.post(`/ehr/patients/${pid}/trt/program`, { status: "active", medication: "cypionate" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Active therapy needs a start date/);
  assert.match(r.text, /Enter how often/);
  const start = addDays(today(), -120);
  // Baseline before starting
  r = await c.post(`/ehr/patients/${pid}/trt/labs`, { drawn_on: addDays(start, -10), timing: "baseline", total_t: "210", hematocrit: "44", psa: "0.8" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { status: "active", medication: "cypionate", route: "im", dose_mg: "100", frequency_days: "7", start_date: start, prescriber_id: String(t.ctx.users.prescriber) });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const prog = t.db.prepare("SELECT * FROM trt_programs WHERE patient_id = ?").get(pid);
  assert.equal(prog.dose_mg, 100);
  assert.equal(prog.frequency_days, 7);

  // No follow-up labs 120 days after start (first labs due at 90): overdue
  let tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.equal(tab.status, 200);
  assert.match(tab.text, /Labs overdue since/);
  assert.match((await c.get(`/ehr/patients/${pid}`)).text, /TRT: 1 alert/);

  // Empty lab entry rejected; future date rejected
  r = await c.post(`/ehr/patients/${pid}/trt/labs`, { drawn_on: today() });
  assert.equal(r.status, 400);
  assert.match(r.text, /at least one result/);
  r = await c.post(`/ehr/patients/${pid}/trt/labs`, { drawn_on: addDays(today(), 2), total_t: "500" });
  assert.equal(r.status, 400);

  // Follow-up: Hct 55 (above 54) and PSA rise of 1.6 within 12 months
  r = await c.post(`/ehr/patients/${pid}/trt/labs`, { drawn_on: today(), timing: "trough", total_t: "650", hematocrit: "55.2", psa: "2.4" });
  assert.equal(r.status, 302);
  const flags = trt.flagsFor(trt.settings(t.db) && t.db.prepare("SELECT * FROM trt_programs WHERE patient_id = ?").get(pid),
    t.db.prepare("SELECT * FROM trt_labs WHERE patient_id = ? ORDER BY drawn_on DESC, id DESC").all(pid), trt.settings(t.db));
  const keys = flags.map((f) => f.key);
  assert.ok(keys.includes("hct"));
  assert.ok(keys.includes("psa_rise"));
  assert.ok(!keys.includes("labs_overdue"));
  assert.ok(!keys.includes("baseline"));
  tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /Hematocrit 55\.2% .* above 54%/);
  assert.match(tab.text, /PSA rose 1\.6 ng\/mL/);
  // Next labs due = today + 180 days
  assert.equal(trt.nextLabsDue(prog, t.db.prepare("SELECT * FROM trt_labs WHERE patient_id = ? ORDER BY drawn_on DESC").all(pid), trt.settings(t.db)), addDays(today(), 180));

  // Raising the threshold (admin) clears the hematocrit alert
  const admin = await t.login("admin");
  r = await c.post("/ehr/trt/settings", { hct_max: "56" });
  assert.equal(r.status, 403);
  const s = trt.settings(t.db);
  const body = { hct_max: "56", psa_max: String(s.psa_max), psa_rise: String(s.psa_rise), t_low: "700", t_high: "600", first_labs_days: "90", labs_every_days: "180" };
  r = await admin.post("/ehr/trt/settings", body);
  assert.equal(r.status, 400);
  assert.match(r.text, /high end of the target must be above/);
  r = await admin.post("/ehr/trt/settings", { ...body, t_low: "400", t_high: "700" });
  assert.equal(r.status, 302);
  assert.equal(trt.settings(t.db).hct_max, 56);
  assert.doesNotMatch((await c.get(`/ehr/patients/${pid}/trt`)).text, /Hematocrit 55\.2% .* above/);
});

test("stock: receive a lot, doses draw it down, expired/over-draw refused, void returns it, waste needs a witness", async () => {
  const c = await t.login("therapist");
  let r = await c.post("/ehr/trt/inventory/lots", { product: "Testosterone cypionate 200 mg/mL", lot_number: "", expiration: "", concentration_mg_ml: "200", quantity_ml: "10", received_on: today() });
  assert.equal(r.status, 400);
  r = await c.post("/ehr/trt/inventory/lots", { product: "Testosterone cypionate 200 mg/mL", lot_number: "AB123", expiration: addDays(today(), 400), concentration_mg_ml: "200", quantity_ml: "10", received_on: today(), supplier: "Example Wholesale" });
  assert.equal(r.status, 302);
  const lot = t.db.prepare("SELECT * FROM trt_lots WHERE lot_number = 'AB123'").get();
  assert.equal(onHand(lot.id), 10);

  // 100 mg at 200 mg/mL = 0.5 mL, worked out automatically
  r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "administered", medication: "cypionate", lot_id: String(lot.id), dose_mg: "100", site: "Left glute" });
  assert.equal(r.status, 302, r.text.slice(0, 400));
  assert.equal(onHand(lot.id), 9.5);
  const dose = t.db.prepare("SELECT * FROM trt_doses WHERE patient_id = ? ORDER BY id DESC").get(pid);
  assert.equal(dose.volume_ml, 0.5);
  assert.match((await c.get(`/ehr/patients/${pid}`)).text, /TRT: .*|next dose/);

  // Mismatched mL vs mg refused; more than on hand refused
  r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "administered", medication: "cypionate", lot_id: String(lot.id), dose_mg: "100", volume_ml: "1" });
  assert.equal(r.status, 400);
  assert.match(r.text, /is 200 mg, not 100 mg/);
  r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "dispensed", medication: "cypionate", lot_id: String(lot.id), dose_mg: "2400", days_supply: "28" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Only 9\.5 mL left/);
  // Dispensed needs days supply
  r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "dispensed", medication: "cypionate", lot_id: String(lot.id), dose_mg: "400" });
  assert.equal(r.status, 400);
  assert.match(r.text, /days supply/);
  r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "dispensed", medication: "cypionate", lot_id: String(lot.id), dose_mg: "400", days_supply: "28" });
  assert.equal(r.status, 302);
  assert.equal(onHand(lot.id), 7.5);
  const prog = t.db.prepare("SELECT * FROM trt_programs WHERE patient_id = ?").get(pid);
  const last = t.db.prepare("SELECT * FROM trt_doses WHERE patient_id = ? AND voided_at IS NULL ORDER BY given_on DESC, id DESC").get(pid);
  assert.equal(trt.nextDoseDue(prog, last), addDays(today(), 28));

  // Expired lot can't be used
  t.db.prepare("INSERT INTO trt_lots (product, lot_number, expiration, concentration_mg_ml, received_on) VALUES ('Old stock', 'EXP1', ?, 200, ?)").run(addDays(today(), -1), addDays(today(), -400));
  const old = t.db.prepare("SELECT id FROM trt_lots WHERE lot_number = 'EXP1'").get();
  t.db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on) VALUES (?, 'received', 2, ?)").run(old.id, addDays(today(), -400));
  r = await c.post(`/ehr/patients/${pid}/trt/doses`, { given_on: today(), kind: "administered", medication: "cypionate", lot_id: String(old.id), dose_mg: "100" });
  assert.equal(r.status, 400);
  assert.match(r.text, /expired/);

  // Void needs a reason and returns stock
  r = await c.post(`/ehr/patients/${pid}/trt/doses/${dose.id}/void`, { void_reason: "" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/trt/doses/${dose.id}/void`, { void_reason: "Wrong client" });
  assert.equal(r.status, 302);
  assert.equal(onHand(lot.id), 8);
  assert.ok(t.db.prepare("SELECT voided_at FROM trt_doses WHERE id = ?").get(dose.id).voided_at);

  // Waste: witness must be someone else
  r = await c.post("/ehr/trt/inventory/waste", { lot_id: String(old.id), quantity_ml: "2", witness_id: String(t.ctx.users.therapist), reason: "Expired" });
  assert.equal(r.status, 400);
  assert.match(r.text, /witness must be someone else/);
  r = await c.post("/ehr/trt/inventory/waste", { lot_id: String(old.id), quantity_ml: "2", witness_id: String(t.ctx.users.prescriber), reason: "Expired" });
  assert.equal(r.status, 302);
  assert.equal(onHand(old.id), 0);
  // Close only when empty
  r = await c.post(`/ehr/trt/inventory/lots/${lot.id}/close`);
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT closed_at FROM trt_lots WHERE id = ?").get(lot.id).closed_at, null);
  r = await c.post(`/ehr/trt/inventory/lots/${old.id}/close`);
  assert.ok(t.db.prepare("SELECT closed_at FROM trt_lots WHERE id = ?").get(old.id).closed_at);

  // Count corrections are admin-only
  r = await c.post("/ehr/trt/inventory/adjust", { lot_id: String(lot.id), quantity_ml: "-0.5", reason: "Count" });
  assert.equal(r.status, 403);
  const admin = await t.login("admin");
  r = await admin.post("/ehr/trt/inventory/adjust", { lot_id: String(lot.id), quantity_ml: "-20", reason: "Count" });
  assert.equal(r.status, 400);
  r = await admin.post("/ehr/trt/inventory/adjust", { lot_id: String(lot.id), quantity_ml: "-0.5", reason: "Physical count" });
  assert.equal(r.status, 302);
  assert.equal(onHand(lot.id), 7.5);

  const inv = await c.get("/ehr/trt/inventory");
  assert.equal(inv.status, 200);
  assert.match(inv.text, /AB123/);
  assert.match(inv.text, /Dose voided \(returned\)/);
  const csv = await c.get("/ehr/trt/inventory.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.text, /^date,event,product,lot,quantity_ml/);
  assert.match(csv.text, /wasted/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE entity_type = 'trt_inventory' AND action = 'export'").get());
});

test("overview lists clients with alerts; visit check validates", async () => {
  const c = await t.login("therapist");
  const ov = await c.get("/ehr/trt");
  assert.equal(ov.status, 200);
  assert.match(ov.text, /On therapy/);
  assert.match(ov.text, new RegExp(`/ehr/patients/${pid}/trt`));
  let r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), bp_sys: "150" });
  assert.equal(r.status, 400);
  assert.match(r.text, /both blood pressure numbers/);
  r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), energy: "11" });
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/trt/visits`, { visit_date: today(), bp_sys: "150", bp_dia: "92", heart_rate: "70", weight_lb: "201.5", energy: "6", libido: "5", mood: "7", sleep: "6", side_effects: "Mild acne" });
  assert.equal(r.status, 302);
  const tab = await c.get(`/ehr/patients/${pid}/trt`);
  assert.match(tab.text, /150\/92/);
  assert.match(tab.text, /Mild acne/);
  // Stopping requires a reason
  r = await c.post(`/ehr/patients/${pid}/trt/program`, { status: "stopped", medication: "cypionate" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Say why therapy stopped/);
});
