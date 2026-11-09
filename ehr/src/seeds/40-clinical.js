"use strict";
/*
 * Clinical demo data (SYNTHETIC ONLY): treatment plans and PHQ-9 / GAD-7 series.
 */
const { scoreInstrument, INSTRUMENTS } = require("../routes/clinical");
const { today, addDays } = require("../views");

/** Spread `total` over the instrument's items (each 0-3). item9 fixes PHQ-9 item 9. */
function responsesFor(instrument, total, item9 = 0) {
  const n = INSTRUMENTS[instrument].items.length;
  const r = new Array(n).fill(0);
  let left = total;
  if (instrument === "PHQ9") { r[8] = item9; left -= item9; }
  for (let pass = 0; pass < 3 && left > 0; pass++) {
    for (let i = 0; i < n && left > 0; i++) {
      if (instrument === "PHQ9" && i === 8) continue;
      if (r[i] < 3) { r[i]++; left--; }
    }
  }
  return r;
}

module.exports = function seedClinical(db, ctx) {
  const t = today();
  const [jordan, morgan, , riley] = ctx.patients;
  const U = ctx.users;

  const insAssess = db.prepare(`INSERT INTO assessments (patient_id, instrument, responses, total_score, severity, flagged, administered_on, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  function series(patientId, instrument, totals, { daysApart = 14, item9Last = 0, by }) {
    totals.forEach((total, i) => {
      const daysAgo = (totals.length - 1 - i) * daysApart + 2;
      const responses = responsesFor(instrument, total, i === totals.length - 1 ? item9Last : 0);
      const s = scoreInstrument(instrument, responses);
      insAssess.run(patientId, instrument, JSON.stringify(responses), s.total, s.severity, s.flagged, addDays(t, -daysAgo), by);
    });
  }

  const insPlan = db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, summary, strengths, barriers, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insGoal = db.prepare(`INSERT INTO treatment_goals (plan_id, problem, goal, objectives, interventions, target_date, status, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  function plan(patientId, author, status, startAgo, reviewIn, fields, goals) {
    const id = Number(insPlan.run(patientId, author, status, addDays(t, -startAgo), addDays(t, reviewIn), fields.summary,
      fields.strengths, fields.barriers, status === "draft" ? null : `${addDays(t, -startAgo)} 15:00:00`).lastInsertRowid);
    goals.forEach((g, i) => insGoal.run(id, g[0], g[1], g[2], g[3], addDays(t, g[4]), g[5], i));
    return id;
  }

  // Jordan: improving depression and anxiety, active plan.
  plan(jordan, U.therapist, "active", 70, 20, {
    summary: "Synthetic example. Depressed mood and worry following a job change; sleep disruption.",
    strengths: "Motivated for treatment; supportive partner; enjoys running.",
    barriers: "Variable work schedule.",
  }, [
    ["Depressed mood", "Reduce depressive symptoms and return to usual activities.", "PHQ-9 below 10 for two consecutive administrations.\nSchedule 3 pleasant activities per week.", "CBT, behavioral activation, weekly sessions.", 20, "in_progress"],
    ["Worry", "Improve ability to manage worry.", "GAD-7 below 10.\nUse worry-time practice 5 days per week.", "CBT for anxiety, relaxation training.", 20, "in_progress"],
    ["Sleep", "Restore a consistent sleep pattern.", "6.5+ hours of sleep on 5 nights per week per sleep log.", "Sleep hygiene education, stimulus control.", -5, "met"],
  ]);
  series(jordan, "PHQ9", [18, 16, 13, 11, 8, 6], { by: U.therapist });
  series(jordan, "GAD7", [14, 12, 10, 8, 7], { by: U.therapist });

  // Morgan: older plan superseded, current plan past its review date, recent safety flag.
  plan(morgan, U.therapist, "superseded", 200, -110, {
    summary: "Synthetic example. Initial plan.", strengths: "Insightful.", barriers: "Transportation.",
  }, [["Low mood", "Reduce depressive symptoms.", "PHQ-9 below 10.", "Supportive therapy.", -110, "revised"]]);
  plan(morgan, U.therapist, "active", 110, -20, {
    summary: "Synthetic example. Persistent low mood with recent stressors.",
    strengths: "Engaged in sessions; strong friendships.",
    barriers: "Limited time due to caregiving responsibilities.",
  }, [
    ["Low mood", "Reduce depressive symptoms.", "PHQ-9 below 10 for 4 weeks.", "CBT, behavioral activation.", 30, "in_progress"],
    ["Safety", "Maintain safety and use coping plan when distressed.", "Reviews safety plan each session; uses 2+ coping strategies.", "Safety planning, means-safety counseling.", 30, "in_progress"],
  ]);
  series(morgan, "PHQ9", [12, 13, 11, 12], { daysApart: 7, item9Last: 1, by: U.therapist });

  // Riley: anxiety in remission, draft plan in progress.
  plan(riley, U.prescriber, "draft", 0, 90, {
    summary: "Synthetic example. Generalized anxiety, improving with treatment.", strengths: "Consistent with appointments.", barriers: null,
  }, [["Anxiety", "Maintain gains in anxiety management.", "GAD-7 below 5 at each visit.", "Medication management, CBT skills review.", 90, "in_progress"]]);
  series(riley, "GAD7", [16, 12, 9, 6, 4], { daysApart: 21, by: U.prescriber });
  series(riley, "PHQ9", [9, 7, 5, 4], { daysApart: 28, by: U.prescriber });
};
