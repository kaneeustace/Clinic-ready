"use strict";
/*
 * Billing demo data (SYNTHETIC ONLY). Creates charges for most completed past
 * appointments and a few payments. The most recent completed visits are left
 * uncharged so the billing work queue has something in it.
 * Runs inside seed()'s transaction; do not open another one here.
 */
const { nowLocal } = require("../views");

const FALLBACK_DX = { therapy: "F41.1", med_management: "F33.1" };

module.exports = function seedBilling(db, ctx) {
  const appts = db.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM insurance_policies i WHERE i.patient_id = a.patient_id AND i.active = 1) AS insured
     FROM appointments a WHERE a.status = 'completed' AND a.start_at < ? ORDER BY a.start_at, a.id`).all(nowLocal());
  if (!appts.length) return;
  const fee = (cpt) => db.prepare("SELECT fee_cents FROM fee_schedule WHERE cpt_code = ?").get(cpt);
  const dxFor = db.prepare("SELECT icd10_code FROM diagnoses WHERE patient_id = ? AND status = 'active' ORDER BY is_primary DESC, id");
  const insCharge = db.prepare(
    `INSERT INTO charges (patient_id, appointment_id, date_of_service, cpt_code, modifier, units, fee_cents, diagnosis_codes,
      rendering_provider_id, bill_to, status, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
  const insPay = db.prepare(
    `INSERT INTO payments (patient_id, amount_cents, method, reference, received_on, note, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const biller = (ctx.users && (ctx.users.billing || ctx.users.admin)) || null;

  const chargeable = appts.slice(0, Math.max(0, appts.length - 3)); // leave the newest 3 for the work queue
  chargeable.forEach((a, i) => {
    let cpt;
    if (a.type === "med_management") cpt = "99214";
    else if (a.type === "therapy") cpt = i % 3 === 0 ? "90837" : "90834";
    else cpt = { intake: "90791", psychiatry_eval: "90792", family: "90847", group: "90853" }[a.type] || "90834";
    const f = fee(cpt);
    if (!f) return;
    const dx = dxFor.all(a.patient_id).map((d) => d.icd10_code);
    const codes = (dx.length ? dx : [FALLBACK_DX[a.type] || "F41.1"]).join(",");
    const dos = a.start_at.slice(0, 10);
    // Older charges move through the cycle; recent ones are still unbilled.
    const age = chargeable.length - i;
    const status = age > 8 ? (i % 5 === 0 ? "denied" : "paid") : age > 4 ? "billed" : "unbilled";
    const billTo = a.insured ? "insurance" : "patient";
    insCharge.run(a.patient_id, a.id, dos, cpt, a.modality === "telehealth" ? "95" : null, f.fee_cents, codes,
      a.clinician_id, billTo, status, biller);
    // Copay at time of service for some insured visits, and payer payments for paid charges.
    if (a.insured && i % 2 === 0) insPay.run(a.patient_id, 2500, "card", `DEMO-${1000 + i}`, dos, "Copay", biller);
    if (status === "paid") {
      const paid = a.insured ? Math.round(f.fee_cents * 0.6) : f.fee_cents;
      insPay.run(a.patient_id, paid, a.insured ? "insurance" : "check", `EOB-DEMO-${2000 + i}`, dos, null, biller);
      const copay = i % 2 === 0 ? 2500 : 0;
      const writeOff = f.fee_cents - paid - copay;
      if (a.insured && writeOff > 0) insPay.run(a.patient_id, writeOff, "adjustment", null, dos, "Contractual adjustment", biller);
    }
  });
};
