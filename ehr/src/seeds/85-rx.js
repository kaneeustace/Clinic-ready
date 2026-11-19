"use strict";
// Demo prescribing: the demo prescriber can prescribe (fictional DEA/NPI), with one testosterone prescription.
const { today } = require("../views");

module.exports = function seedRx(db, ctx) {
  if (process.env.EHR_DEMO !== "1") return;
  const U = ctx.users;
  const P = ctx.patients;
  if (!U.prescriber || P.length < 10) return;
  db.prepare("UPDATE users SET dea_number = 'BP1234563', dea_expires = '2028-06-30', license_number = 'NP-00000', license_state = 'AZ' WHERE id = ?").run(U.prescriber);
  const med = Number(db.prepare(`INSERT INTO medications (patient_id, name, dose, route, frequency, prescriber, start_date, active, notes, created_by)
    VALUES (?, 'Testosterone cypionate', '200 mg/mL', 'Intramuscular', 'Inject 0.5 mL (100 mg) into the muscle once weekly.', 'Pat Prescriber, PMHNP-BC', ?, 1, 'Added from a prescription', ?)`)
    .run(P[9], today(), U.prescriber).lastInsertRowid);
  db.prepare(`INSERT INTO prescriptions (patient_id, prescriber_id, drug, strength, dosage_form, route, sig, quantity, quantity_unit, days_supply, refills, schedule,
      diagnosis, pharmacy, delivery, pdmp_checked, written_on, medication_id)
    VALUES (?, ?, 'Testosterone cypionate', '200 mg/mL', 'Injectable solution (10 mL multi-dose vial)', 'Intramuscular', 'Inject 0.5 mL (100 mg) into the muscle once weekly.',
      10, 'mL', 140, 1, 'III', 'E29.1', 'Example Pharmacy, 200 Main St, Phoenix AZ', 'print', 1, ?, ?)`).run(P[9], U.prescriber, today(), med);
};
