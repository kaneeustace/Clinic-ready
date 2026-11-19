"use strict";
// Demo hormone therapy (TRT) data: turned on, one lot of stock, one client on therapy, one being evaluated. Fictional.
const { addDays, today } = require("../views");

module.exports = function seedTrt(db, ctx) {
  if (process.env.EHR_DEMO !== "1") return; // tests start with the module off
  const P = ctx.patients;
  const U = ctx.users;
  if (P.length < 10) return;
  const t = today();
  db.prepare("UPDATE clinic_settings SET trt_enabled = 1 WHERE id = 1").run();
  db.prepare("INSERT OR IGNORE INTO trt_settings (id) VALUES (1)").run();

  const lot = Number(db.prepare(`INSERT INTO trt_lots (product, ndc, lot_number, expiration, concentration_mg_ml, supplier, invoice, received_on, received_by)
    VALUES ('Testosterone cypionate 200 mg/mL (1 mL vials)', '00000-0000-00', 'DEMO-2417', ?, 200, 'Example Wholesale', 'INV-1001', ?, ?)`)
    .run(addDays(t, 300), addDays(t, -150), U.admin).lastInsertRowid);
  db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, user_id) VALUES (?, 'received', 20, ?, ?)").run(lot, addDays(t, -150), U.admin);

  // P9: on weekly cypionate for ~5 months; latest hematocrit is high, so the alert shows.
  const start = addDays(t, -140);
  db.prepare(`INSERT INTO trt_programs (patient_id, status, medication, dose_mg, route, frequency_days, prescriber_id, start_date, goals, created_by)
    VALUES (?, 'active', 'cypionate', 100, 'im', 7, ?, ?, 'Fatigue and low libido; total testosterone 238 and 251 ng/dL on two morning draws. Shared decision after discussing risks.', ?)`)
    .run(P[9], U.prescriber, start, U.prescriber);
  const lab = db.prepare("INSERT INTO trt_labs (patient_id, drawn_on, timing, total_t, free_t, estradiol, hematocrit, hemoglobin, psa, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  lab.run(P[9], addDays(start, -14), "baseline", 238, 42, 18, 45.1, 15.0, 0.9, U.prescriber);
  lab.run(P[9], addDays(start, 90), "trough", 612, 128, 31, 50.8, 16.9, 1.1, U.prescriber);
  lab.run(P[9], addDays(t, -3), "trough", 688, 141, 36, 54.6, 18.1, 1.2, U.prescriber);
  const dose = db.prepare(`INSERT INTO trt_doses (patient_id, given_on, kind, medication, lot_id, dose_mg, volume_ml, site, given_by) VALUES (?, ?, 'administered', 'cypionate', ?, 100, 0.5, ?, ?)`);
  const led = db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, patient_id, dose_id, user_id) VALUES (?, 'administered', -0.5, ?, ?, ?, ?)");
  const sites = ["Left glute", "Right glute", "Left deltoid", "Right deltoid"];
  for (let i = 4; i >= 1; i--) {
    const d = addDays(t, -7 * i + 1);
    const id = Number(dose.run(P[9], d, lot, sites[i % 4], U.prescriber).lastInsertRowid);
    led.run(lot, d, P[9], id, U.prescriber);
  }
  db.prepare(`INSERT INTO trt_visits (patient_id, visit_date, bp_sys, bp_dia, heart_rate, weight_lb, energy, libido, mood, sleep, side_effects, entered_by)
    VALUES (?, ?, 128, 82, 68, 204, 7, 6, 7, 6, 'Mild acne on shoulders', ?)`).run(P[9], addDays(t, -3), U.prescriber);

  // P4: being evaluated; baseline labs only.
  db.prepare(`INSERT INTO trt_programs (patient_id, status, medication, route, prescriber_id, goals, created_by) VALUES (?, 'evaluating', 'cypionate', 'im', ?, 'Low energy; repeat morning testosterone before deciding.', ?)`)
    .run(P[4], U.prescriber, U.prescriber);
  lab.run(P[4], addDays(t, -6), "baseline", 312, 61, 22, 44.0, 14.8, 0.5, U.prescriber);
};
