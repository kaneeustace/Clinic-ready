"use strict";
// Synthetic allergies, medications and diagnoses for the demo patients (fictional data only).
const { addDays, today } = require("../views");

module.exports = function seedPatients(db, ctx) {
  const P = ctx.patients;
  const U = ctx.users;
  const t = today();
  const insAllergy = db.prepare("INSERT INTO allergies (patient_id, substance, reaction, severity) VALUES (?, ?, ?, ?)");
  const insMed = db.prepare(`INSERT INTO medications (patient_id, name, dose, route, frequency, prescriber, start_date, end_date, active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDx = db.prepare(`INSERT INTO diagnoses (patient_id, icd10_code, description, status, is_primary, onset_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  insAllergy.run(P[0], "Penicillin", "Rash", "moderate");
  insAllergy.run(P[1], "Peanuts", "Anaphylaxis", "severe");
  insAllergy.run(P[3], "Sulfa drugs", "Hives", "mild");
  insAllergy.run(P[6], "Latex", "Contact dermatitis", "mild");

  const presc = "Pat Prescriber, PMHNP-BC";
  insMed.run(P[3], "Sertraline", "100 mg", "by mouth", "once daily", presc, addDays(t, -180), null, 1, U.prescriber);
  insMed.run(P[3], "Trazodone", "50 mg", "by mouth", "at bedtime as needed", presc, addDays(t, -90), null, 1, U.prescriber);
  insMed.run(P[6], "Lamotrigine", "200 mg", "by mouth", "once daily", presc, addDays(t, -400), null, 1, U.prescriber);
  insMed.run(P[9], "Methylphenidate ER", "36 mg", "by mouth", "every morning", presc, addDays(t, -120), null, 1, U.prescriber);
  insMed.run(P[9], "Atomoxetine", "40 mg", "by mouth", "once daily", presc, addDays(t, -300), addDays(t, -125), 0, U.prescriber);
  insMed.run(P[1], "Escitalopram", "10 mg", "by mouth", "once daily", "Outside provider (primary care)", addDays(t, -240), null, 1, U.therapist);

  const dx = [
    [0, "F41.1", "Generalized anxiety disorder", "therapist"],
    [1, "F43.10", "Post-traumatic stress disorder, unspecified", "therapist"],
    [2, "F32.1", "Major depressive disorder, single episode, moderate", "therapist2"],
    [3, "F33.1", "Major depressive disorder, recurrent, moderate", "prescriber"],
    [3, "F41.1", "Generalized anxiety disorder", "prescriber", 0],
    [4, "F43.23", "Adjustment disorder with mixed anxiety and depressed mood", "therapist2"],
    [5, "F41.0", "Panic disorder [episodic paroxysmal anxiety]", "therapist"],
    [6, "F31.81", "Bipolar II disorder", "prescriber"],
    [7, "F33.0", "Major depressive disorder, recurrent, mild", "therapist2"],
    [8, "F42.2", "Mixed obsessional thoughts and acts", "therapist"],
    [9, "F90.2", "Attention-deficit hyperactivity disorder, combined type", "prescriber"],
  ];
  for (const [i, code, desc, by, primary = 1] of dx) insDx.run(P[i], code, desc, "active", primary, addDays(t, -200), U[by]);
  insDx.run(P[4], "F43.20", "Adjustment disorder, unspecified", "resolved", 0, addDays(t, -500), U.therapist2);
};
