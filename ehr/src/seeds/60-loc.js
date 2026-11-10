"use strict";
// Synthetic level-of-care episodes and authorizations for the demo (fictional data only).
const { addDays, today } = require("../views");

module.exports = function seedLoc(db, ctx) {
  const P = ctx.patients;
  const U = ctx.users;
  const t = today();
  const ep = db.prepare(`INSERT INTO loc_episodes (patient_id, level, asam_level, program, start_date, end_date, reason, end_reason, created_by, ended_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const au = db.prepare(`INSERT INTO loc_authorizations (patient_id, episode_id, level, payer, auth_number, status, unit_type, units_approved,
    start_date, end_date, next_review_date, reviewer, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const id = (r) => Number(r.lastInsertRowid);
  if (P.length < 4) return;

  // P0: PHP, stepped down to IOP.
  ep.run(P[0], "php", "2.5", "Adult PHP", addDays(t, -34), addDays(t, -20), "Daily structure needed after relapse; stable housing.", "step_down", U.therapist, U.therapist);
  const e0 = id(ep.run(P[0], "iop", "2.1", "Evening IOP", addDays(t, -20), null, "Completed PHP goals; needs 9+ hours/week of support while returning to work.", null, U.therapist, null));
  au.run(P[0], e0, "iop", "Sample Health Plan", "IOP-55021", "approved", "sessions", 12, addDays(t, -20), addDays(t, 10), addDays(t, 2), "J. Reviewer", U.admin);
  // P1: outpatient.
  ep.run(P[1], "op", "1", null, addDays(t, -90), null, "Weekly therapy for anxiety; low risk.", null, U.therapist, null);
  // P2: residential with a review due tomorrow.
  const e2 = id(ep.run(P[2], "residential", "3.5", "Men's residential", addDays(t, -9), null, "Unable to maintain abstinence at IOP; Dimension 5 high risk.", null, U.therapist2 || U.therapist, null));
  au.run(P[2], e2, "residential", "Example Mutual", "RES-88310", "approved", "days", 14, addDays(t, -9), addDays(t, 4), addDays(t, 1), null, U.admin);
  // P3: detox, authorization still pending.
  const e3 = id(ep.run(P[3], "detox", "3.7-WM", null, addDays(t, -1), null, "Alcohol withdrawal; CIWA 14 at intake.", null, U.prescriber || U.therapist, null));
  au.run(P[3], e3, "detox", "Example Mutual", null, "pending", "days", null, addDays(t, -1), null, t, null, U.admin);
};
