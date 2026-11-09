"use strict";
/*
 * Clinical demo data (SYNTHETIC ONLY): screening score series and v2 treatment plans
 * (problem → goal → objective → intervention, signatures, reviews, versions).
 * Runs after 30-notes.js, so seeded progress notes can be linked to plan objectives (golden thread).
 */
const { scoreInstrument, INSTRUMENTS } = require("../routes/clinical");
const { snapshotDiagnoses } = require("../routes/plans");
const { today, addDays } = require("../views");

/** Spread `total` over the instrument's items (each 0-3). item9 fixes PHQ-9 item 9. */
function responsesFor(instrument, total, item9 = 0) {
  if (instrument !== "PHQ9" && instrument !== "GAD7") return spread(instrument, total);
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

/** Generic: step each item up through its own option values until the total is reached. */
function spread(instrument, total) {
  const def = INSTRUMENTS[instrument];
  const opts = def.items.map((it) => ((typeof it === "object" && it.options) || def.options).map((o) => o.value).sort((a, b) => a - b));
  const r = opts.map((o) => o[0]);
  let left = total - r.reduce((a, b) => a + b, 0);
  for (let pass = 0; pass < 5 && left > 0; pass++) {
    opts.forEach((o, i) => {
      const next = o.find((v) => v > r[i]);
      if (left > 0 && next !== undefined && next - r[i] <= left) { left -= next - r[i]; r[i] = next; }
    });
  }
  return r;
}

module.exports = function seedClinical(db, ctx) {
  const t = today();
  const [jordan, morgan, , riley, , quinn, , , rowan] = ctx.patients;
  const U = ctx.users;
  const ts = (daysAgo, time = "15:00:00") => `${addDays(t, -daysAgo)} ${time}`;

  /* ---------------- screening series ---------------- */
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
  series(jordan, "PHQ9", [18, 16, 13, 11, 8, 6], { by: U.therapist });
  series(jordan, "GAD7", [14, 12, 10, 8, 7], { by: U.therapist });
  series(morgan, "PHQ9", [12, 13, 11, 12], { daysApart: 7, item9Last: 1, by: U.therapist });
  series(morgan, "PCL5", [54, 51, 49], { daysApart: 28, by: U.therapist });
  series(riley, "GAD7", [16, 12, 9, 6, 4], { daysApart: 21, by: U.prescriber });
  series(riley, "PHQ9", [9, 7, 5, 4], { daysApart: 28, by: U.prescriber });
  series(quinn, "AUDIT", [24, 19, 15], { daysApart: 10, by: U.therapist });

  // Quinn's co-occurring alcohol use disorder (added here so the SUD plan can link to it).
  db.prepare(`INSERT INTO diagnoses (patient_id, icd10_code, description, status, is_primary, onset_date, created_by)
    VALUES (?, 'F10.20', 'Alcohol use disorder, moderate', 'active', 0, ?, ?)`).run(quinn, addDays(t, -40), U.therapist);

  /* ---------------- plan builder ---------------- */
  const HEADER = ["plan_type", "summary", "strengths", "barriers", "client_vision", "needs", "abilities", "preferences", "natural_supports",
    "family_involvement", "service_summary", "modality_rationale", "estimated_duration", "expected_outcome", "discharge_criteria",
    "aftercare_referrals", "review_interval_days", "level_of_care", "loc_indicated", "loc_adjusted", "loc_reason", "continued_stay",
    "mat_plan", "drug_testing_plan", "relapse_prevention", "recovery_supports"];
  const insPlan = db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, version, supersedes_id, diagnoses, start_date,
    review_date, signed_at, activated_at, ended_at, end_reason, created_at, ${HEADER.join(", ")})
    VALUES (${new Array(13 + HEADER.length).fill("?").join(", ")})`);
  const insP = db.prepare(`INSERT INTO plan_problems (plan_id, sort, title, behavioral_definition, icd10_code, asam_dimension, is_driver,
    stage_of_change, priority, barriers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insG = db.prepare("INSERT INTO plan_goals (problem_id, sort, client_words, goal_text) VALUES (?, ?, ?, ?)");
  const insO = db.prepare(`INSERT INTO plan_objectives (goal_id, sort, text, measure_type, instrument, baseline_value, target_value, direction,
    unit, measurement_method, target_date, linked_strength, status, current_value, current_value_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insI = db.prepare(`INSERT INTO plan_interventions (objective_id, sort, kind, modality, description, frequency, duration,
    responsible_user_id, responsible_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insSig = db.prepare(`INSERT INTO plan_signatures (plan_id, role, signer_user_id, signer_name, method, declined, declined_reason,
    copy_offered, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const userName = (id) => db.prepare("SELECT name FROM users WHERE id = ?").get(id).name;
  const ptName = (id) => { const p = db.prepare("SELECT first_name, last_name FROM patients WHERE id = ?").get(id); return `${p.first_name} ${p.last_name}`; };

  /**
   * p: { patient, author, status, version, supersedes, activatedAgo, endedAgo, endReason, reviewDate, header, problems, sigs }
   * Objective arrays: [text, type, instrument, baseline, target, unit, method, targetInDays, status, interventions[], {current, strength}]
   * Intervention arrays: [kind, modality, description, frequency, duration, userId | null, text | null]
   */
  function plan(p) {
    const h = { review_interval_days: 90, plan_type: "mental_health", ...p.header };
    const draft = p.status === "draft";
    const id = Number(insPlan.run(p.patient, p.author, p.status, p.version || 1, p.supersedes || null, snapshotDiagnoses(db, p.patient),
      draft ? null : addDays(t, -p.activatedAgo), draft ? null : p.reviewDate || addDays(t, -p.activatedAgo + h.review_interval_days),
      draft ? null : ts(p.activatedAgo), draft ? null : ts(p.activatedAgo), p.endedAgo !== undefined ? addDays(t, -p.endedAgo) : null,
      p.endReason || null, ts((p.activatedAgo || 0) + 3, "10:00:00"), ...HEADER.map((k) => (h[k] === undefined ? null : h[k]))).lastInsertRowid);
    const objectiveIds = [];
    p.problems.forEach((pr, pi) => {
      const pid = Number(insP.run(id, pi, pr.title, pr.def || null, pr.icd || null, pr.asam || null, pr.driver ? 1 : 0, pr.stage || null,
        pr.priority || null, pr.barriers || null).lastInsertRowid);
      pr.goals.forEach((g, gi) => {
        const gid = Number(insG.run(pid, gi, g.words || null, g.text).lastInsertRowid);
        g.objectives.forEach(([text, type, inst, base, target, unit, method, targetIn, status, ints, extra = {}], oi) => {
          const dir = type === "attainment" ? "achieve" : target < base ? "decrease" : "increase";
          const oid = Number(insO.run(gid, oi, text, type, inst || null, base, target, dir, unit || null, method || null, addDays(t, targetIn),
            extra.strength || null, status, extra.current === undefined ? null : extra.current,
            extra.current === undefined ? null : addDays(t, -(extra.currentAgo || 30))).lastInsertRowid);
          objectiveIds.push(oid);
          ints.forEach((iv, ii) => insI.run(oid, ii, ...iv));
        });
      });
    });
    if (!draft) {
      const signedAt = ts(p.activatedAgo, "14:30:00");
      insSig.run(id, "clinician", p.author, userName(p.author), "password", 0, null, 0, signedAt);
      for (const s of p.sigs || [{ role: "client", method: "in_person" }]) {
        if (s.role === "supervisor") insSig.run(id, "supervisor", s.user, userName(s.user), "password", 0, null, 0, ts(p.activatedAgo, "16:45:00"));
        else insSig.run(id, s.role, null, s.name || ptName(p.patient), s.declined ? null : s.method, s.declined ? 1 : 0, s.reason || null, 1, signedAt);
      }
    }
    return { id, objectiveIds };
  }
  const insReview = db.prepare(`INSERT INTO plan_reviews (plan_id, review_date, reviewer_id, participants, client_perspective, summary,
    diagnosis_changes, level_of_care_appropriate, outcome, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insItem = db.prepare("INSERT INTO plan_review_items (review_id, objective_id, status, current_value, rationale, action) VALUES (?, ?, ?, ?, ?, ?)");

  const weeklyTherapy = (who, modality, desc, weeks = "16 weeks") => ["professional", modality, desc, "Weekly, 53 min", weeks, who, null];
  const self = (modality, desc, freq, dur = "Ongoing") => ["self_directed", modality, desc, freq, dur, null, "Client"];

  /* ---------------- Jordan: GAD + depressive symptoms; v1 superseded, v2 active, review due in 5 days ---------------- */
  const jordanHeader = {
    summary: "Synthetic example. Worry and low mood following a job change; sleep disruption.",
    client_vision: "I want to stop dreading Mondays and get back to running with my club on weekends.",
    strengths: "Motivated for treatment; supportive partner; long history of running.",
    needs: "Skills to manage worry; a steadier routine.", abilities: "Organized; follows through on homework.",
    preferences: "Evening telehealth sessions; prefers practical skills over open-ended talk.",
    barriers: "Variable work schedule.", natural_supports: "Partner; running club.",
    family_involvement: "Partner joins one session per month at the client's request.",
    service_summary: "Individual psychotherapy (90837) weekly for 16 weeks, then every other week; PHQ-9/GAD-7 every 2 weeks.",
    modality_rationale: "CBT has strong evidence for GAD and depressive symptoms; client prefers a structured, skills-based approach.",
    estimated_duration: "16-20 sessions over about 6 months", expected_outcome: "Remission of anxiety and depressive symptoms; return to usual activities.",
    discharge_criteria: "GAD-7 and PHQ-9 below 5 on two consecutive administrations; client reports return to usual routine.",
    aftercare_referrals: "Booster sessions as needed; primary care follow-up.",
  };
  const jv1 = plan({
    patient: jordan, author: U.therapist, status: "superseded", activatedAgo: 175, endedAgo: 85, endReason: "superseded",
    header: { ...jordanHeader, discharge_criteria: null },
    problems: [{ title: "Worry", icd: "F41.1", goals: [{ text: "Manage worry so it doesn't control the workday.", objectives: [
      ["GAD-7 below 10.", "instrument", "GAD7", 15, 9, "points", "GAD-7 every 2 weeks", -85, "revised", [weeklyTherapy(U.therapist, "CBT", "Worry exposure and cognitive restructuring.")]],
    ] }] }],
  });
  const jv2 = plan({
    patient: jordan, author: U.therapist, status: "active", version: 2, supersedes: jv1.id, activatedAgo: 85, header: jordanHeader,
    problems: [
      { title: "Excessive worry", icd: "F41.1", priority: "high",
        def: "Worries about work most days for 6+ months; 2-3 hours a day lost to worry; muscle tension and trouble concentrating.",
        goals: [{ words: "I want my head to be quiet enough to enjoy my evenings.", text: "Reduce worry to a manageable level and regain evening downtime.", objectives: [
          ["Reduce anxiety symptoms from moderate to minimal (GAD-7 ≤ 5).", "instrument", "GAD7", 14, 5, "points", "GAD-7 every 2 weeks in session", 60, "progressing",
            [weeklyTherapy(U.therapist, "CBT", "Cognitive restructuring of catastrophic predictions; worry exposure to reduce avoidance."),
              self("Worry time", "Practice a 20-minute scheduled worry period and postpone worry outside it.", "Daily")]],
          ["Use worry-postponement on at least 5 days per week, logged on the worry app.", "frequency", null, 0, 5, "days per week", "Self-monitoring log reviewed weekly", 45, "progressing",
            [self("Self-monitoring", "Log worry episodes and postponement in the phone app.", "Daily")], { current: 4, currentAgo: 14, strength: "Organized; follows through on homework" }],
        ] }] },
      { title: "Depressed mood", icd: "F41.1", priority: "medium",
        def: "Low mood and loss of interest since the job change; stopped running; PHQ-9 18 at intake.",
        goals: [{ words: "I want to feel like myself again and get back to running.", text: "Return to valued activities and restore mood.", objectives: [
          ["Reduce depressive symptoms to the mild range or lower (PHQ-9 ≤ 9).", "instrument", "PHQ9", 18, 9, "points", "PHQ-9 every 2 weeks", 30, "progressing",
            [weeklyTherapy(U.therapist, "Behavioral activation", "Activity scheduling and monitoring to rebuild routine and positive reinforcement.")]],
          ["Run with the club at least 2 times per week.", "frequency", null, 0, 2, "runs per week", "Client report, activity log", 45, "met",
            [self("Behavioral activation", "Schedule club runs in the calendar each Sunday.", "Twice weekly"),
              ["natural_support", "Peer support", "Running-club partner checks in before Saturday runs.", "Weekly", "Ongoing", null, "Running-club partner"]], { current: 2, currentAgo: 10 }],
        ] }] },
      { title: "Sleep disruption", icd: "F41.1", priority: "low",
        def: "Falls asleep after 1 a.m. 4 nights a week; wakes unrested.",
        goals: [{ words: "Sleep through the night.", text: "Restore a consistent, restful sleep pattern.", objectives: [
          ["Sleep 6.5+ hours on at least 5 nights per week per sleep log.", "frequency", null, 2, 5, "nights per week", "Sleep diary reviewed every session", 20, "met",
            [weeklyTherapy(U.therapist, "Sleep hygiene / CBT-I", "Stimulus control and a fixed wake time.", "6 weeks")], { current: 5, currentAgo: 14 }],
        ] }] },
    ],
  });

  /* ---------------- Morgan: PTSD + low mood; review overdue; v1 revised at review ---------------- */
  const morganHeader = {
    summary: "Synthetic example. Persistent low mood and trauma symptoms with recent stressors.",
    client_vision: "I want to be able to go to the grocery store without panicking and be present with my kids.",
    strengths: "Engaged in sessions; strong friendships.", needs: "Trauma-focused therapy; caregiving relief.",
    abilities: "Reflective; writes well.", preferences: "In-person sessions; female clinician.",
    barriers: "Limited time due to caregiving responsibilities.", natural_supports: "Two close friends; sister nearby.",
    family_involvement: "Client prefers family not be involved at this time.",
    service_summary: "Individual psychotherapy weekly (90837) for 12 weeks of CPT; safety plan review each session.",
    modality_rationale: "Cognitive processing therapy is first-line for PTSD; client agreed to written accounts.",
    estimated_duration: "12-16 sessions", expected_outcome: "Clinically meaningful PCL-5 reduction (≥ 10 points); improved mood.",
    discharge_criteria: "PCL-5 below 33 and PHQ-9 below 10 for 4 weeks.", aftercare_referrals: "Support group referral at discharge.",
  };
  const mv1 = plan({
    patient: morgan, author: U.therapist, status: "superseded", activatedAgo: 200, endedAgo: 110, endReason: "superseded", header: morganHeader,
    problems: [{ title: "Low mood", icd: "F43.10", goals: [{ words: "Feel less heavy.", text: "Reduce depressive symptoms.", objectives: [
      ["PHQ-9 below 10.", "instrument", "PHQ9", 14, 9, "points", "PHQ-9 monthly", -110, "revised", [weeklyTherapy(U.therapist, "Supportive therapy", "Supportive counseling.")]],
    ] }] }],
  });
  const mr = Number(insReview.run(mv1.id, addDays(t, -110), U.therapist, "Client; Taylor Therapist, LCSW", "\"Talking helps, but the nightmares are the same.\"",
    "Synthetic example. Mood partially improved; trauma symptoms unchanged with supportive therapy. Revising to trauma-focused CPT.",
    "PTSD confirmed as primary (F43.10).", 1, "revise", ts(110, "17:00:00")).lastInsertRowid);
  insItem.run(mr, mv1.objectiveIds[0], "partially_met", 12, "PHQ-9 14 → 12; trauma symptoms driving mood.", "modify");
  const mv2 = plan({
    patient: morgan, author: U.therapist, status: "active", version: 2, supersedes: mv1.id, activatedAgo: 110, reviewDate: addDays(t, -20), header: morganHeader,
    problems: [
      { title: "Trauma symptoms", icd: "F43.10", priority: "high",
        def: "Nightmares 4 nights/week, avoids crowded stores, startles easily; symptoms since an assault 2 years ago.",
        goals: [{ words: "I want to go to the store without panicking.", text: "Reduce trauma symptoms and resume avoided daily activities.", objectives: [
          ["Reduce PTSD symptoms by at least 10 points on the PCL-5 (from 54 to 44 or lower).", "instrument", "PCL5", 54, 44, "points", "PCL-5 monthly", 30, "progressing",
            [weeklyTherapy(U.therapist, "Cognitive processing therapy (CPT)", "CPT protocol: impact statement, stuck points, worksheets.", "12 sessions")]],
          ["Shop at the grocery store for 20+ minutes at least once a week.", "frequency", null, 0, 1, "trips per week", "Client report, exposure log", 45, "progressing",
            [self("Exposure", "Graded in-vivo exposure from the hierarchy built in session.", "2-3 times weekly")], { current: 0.5, currentAgo: 20 }],
        ] }] },
      { title: "Low mood", icd: "F43.10", priority: "medium",
        def: "Low mood most days; withdrawn from friends; PHQ-9 12.",
        goals: [{ words: "Be present with my kids.", text: "Improve mood and reconnect with family and friends.", objectives: [
          ["Reduce depressive symptoms to the mild range (PHQ-9 ≤ 7).", "instrument", "PHQ9", 12, 7, "points", "PHQ-9 every 2 weeks", 30, "progressing",
            [weeklyTherapy(U.therapist, "Behavioral activation", "Schedule one valued activity with the kids each weekend.")]],
        ] }] },
      { title: "Safety", priority: "high", def: "Intermittent passive suicidal ideation when overwhelmed; no plan or intent.",
        goals: [{ words: "Keep myself safe when things get bad.", text: "Maintain safety and use the coping plan when distressed.", objectives: [
          ["Review the safety plan each session and name 2+ coping strategies used since the last visit.", "attainment", null, null, null, null, "Clinician review each session", 30, "progressing",
            [weeklyTherapy(U.therapist, "Safety planning", "Collaborative safety plan review; means-safety counseling."),
              ["natural_support", "Peer support", "Sister is a named contact on the safety plan.", "As needed", "Ongoing", null, "Sister"]]],
        ] }] },
    ],
  });

  /* ---------------- Riley: MDD + GAD in remission; reviewed 30 days ago (continue) ---------------- */
  const rv = plan({
    patient: riley, author: U.prescriber, status: "active", activatedAgo: 120, reviewDate: addDays(t, 60),
    header: {
      summary: "Synthetic example. Recurrent depression and generalized anxiety, improving with medication and CBT skills.",
      client_vision: "Keep feeling steady and get back to volunteering at the library.",
      strengths: "Consistent with appointments; good insight into early warning signs.", needs: "Medication monitoring; relapse prevention.",
      preferences: "Monthly medication visits; text reminders.", natural_supports: "Spouse; volunteer group.",
      family_involvement: "Spouse attends occasionally.", service_summary: "Medication management (99214) monthly; brief CBT skills review at visits.",
      modality_rationale: "Sertraline response so far; CBT skills to consolidate gains.", estimated_duration: "6 months, then reassess",
      expected_outcome: "Sustained remission.", discharge_criteria: "Remission (PHQ-9 and GAD-7 below 5) sustained for 6 months; transfer to primary care.",
    },
    problems: [
      { title: "Depressive episode", icd: "F33.1", priority: "high", def: "Recurrent episodes; low energy and anhedonia at intake.",
        goals: [{ words: "Feel steady.", text: "Achieve and sustain remission of depression.", objectives: [
          ["Reach remission (PHQ-9 below 5) and stay there for 2 consecutive visits.", "instrument", "PHQ9", 9, 4, "points", "PHQ-9 monthly", 60, "met",
            [["professional", "Medication management", "Sertraline titration and side-effect monitoring.", "Monthly, 25 min", "6 months", U.prescriber, null]]],
        ] }] },
      { title: "Worry and tension", icd: "F41.1", priority: "medium", def: "Worry most days with muscle tension; GAD-7 16 at intake.",
        goals: [{ words: "Stop the constant what-ifs.", text: "Reduce anxiety to the minimal range.", objectives: [
          ["Reduce anxiety to minimal (GAD-7 ≤ 5).", "instrument", "GAD7", 16, 5, "points", "GAD-7 monthly", 60, "progressing",
            [["professional", "CBT", "Brief CBT skills review: worry postponement, relaxation.", "Monthly, 10 min", "6 months", U.prescriber, null],
              self("Relaxation", "Progressive muscle relaxation recording.", "Daily")]],
        ] }] },
    ],
  });
  const rr = Number(insReview.run(rv.id, addDays(t, -30), U.prescriber, "Client; spouse; Pat Prescriber, PMHNP-BC", "\"I feel like me again most days.\"",
    "Synthetic example. PHQ-9 and GAD-7 both improved substantially; continue the plan unchanged.", "None", 1, "continue", ts(30, "11:00:00")).lastInsertRowid);
  insItem.run(rr, rv.objectiveIds[0], "met", 5, "PHQ-9 9 → 5.", "continue");
  insItem.run(rr, rv.objectiveIds[1], "progressing", 6, "GAD-7 16 → 6.", "continue");

  /* ---------------- Quinn: co-occurring panic + alcohol use; SUD plan with ASAM dimensions ---------------- */
  plan({
    patient: quinn, author: U.therapist, status: "active", activatedAgo: 20,
    sigs: [{ role: "client", method: "verbal" }, { role: "supervisor", user: U.therapist2 }],
    header: {
      plan_type: "co_occurring", review_interval_days: 30,
      summary: "Synthetic example. Panic attacks and increasing alcohol use to manage anxiety; AUDIT 24 at intake.",
      client_vision: "I want to stop needing a drink to calm down, and stop the attacks that keep me home.",
      strengths: "Honest about use; employed; motivated by relationship.", needs: "Panic treatment; alcohol use reduction; sober supports.",
      abilities: "Good problem-solver at work.", preferences: "Telehealth; no 12-step groups (prefers SMART Recovery).",
      barriers: "Drinking is social at work; panic limits travel to in-person groups.", natural_supports: "Partner (supportive of cutting down).",
      family_involvement: "Partner joins a session monthly.",
      service_summary: "Individual psychotherapy weekly (90837); SMART Recovery online meetings twice weekly; PCP referral for medication evaluation.",
      modality_rationale: "Integrated CBT for panic with motivational interviewing and relapse prevention for alcohol use.",
      estimated_duration: "12-16 weeks, reassess level of care at each 30-day review", expected_outcome: "Fewer panic attacks; alcohol use within low-risk limits or abstinence.",
      discharge_criteria: "No panic attacks for 4 weeks; AUDIT below 8; 60 days within drinking goal.", aftercare_referrals: "SMART Recovery; PCP follow-up.",
      level_of_care: "Outpatient", loc_indicated: "2.1", loc_adjusted: "1.5",
      loc_reason: "Client declined intensive outpatient because of work hours; agreed to weekly therapy plus twice-weekly mutual-help meetings, with step-up to 2.1 if use escalates.",
      continued_stay: "Dimension 4 risk remains moderate; client is engaged and reducing use.",
      mat_plan: "Discussed naltrexone; referral to PCP for evaluation. Client undecided.",
      drug_testing_plan: "Not indicated at this level; self-report with breathalyzer app.",
      relapse_prevention: "Triggers: Friday work happy hour, panic symptoms. Coping: leave after one soda, paced breathing, call partner. Lapse response: tell partner, log it, discuss next session without shame.",
      recovery_supports: "SMART Recovery online; partner; running app challenge.",
    },
    problems: [
      { title: "Alcohol use", icd: "F10.20", asam: 4, driver: true, stage: "preparation", priority: "high",
        def: "Drinks 5 days/week, 4-6 drinks per occasion, to calm anxiety; two missed workdays last month.",
        goals: [{ words: "I want to be in control of my drinking.", text: "Reduce alcohol use to the client's goal and build sober coping.", objectives: [
          ["Reduce hazardous drinking to low risk (AUDIT below 8).", "instrument", "AUDIT", 24, 7, "points", "AUDIT monthly", 75, "progressing",
            [weeklyTherapy(U.therapist, "Motivational interviewing", "Explore ambivalence; decisional balance; change plan.", "12 weeks")]],
          ["Reduce drinking days from 5 to 1 or fewer per week.", "frequency", null, 5, 1, "drinking days per week", "Daily drinking log reviewed weekly", 60, "progressing",
            [weeklyTherapy(U.therapist, "Relapse prevention", "Identify triggers; coping plan for Friday happy hour.", "12 weeks"),
              self("Self-monitoring", "Log drinks daily in the app.", "Daily")], { current: 3, currentAgo: 7 }],
        ] }] },
      { title: "Recovery environment", asam: 5, stage: "action", priority: "medium",
        def: "Social drinking culture at work; few sober activities.",
        goals: [{ words: "Have things to do that don't involve drinking.", text: "Build a recovery-supportive social network.", objectives: [
          ["Attend 2 SMART Recovery online meetings per week.", "frequency", null, 0, 2, "meetings per week", "Client report", 60, "progressing",
            [["natural_support", "Peer support", "SMART Recovery online meetings.", "Twice weekly", "Ongoing", null, "SMART Recovery facilitator"]], { current: 1, currentAgo: 7 }],
        ] }] },
      { title: "Panic attacks", icd: "F41.0", asam: 3, priority: "high",
        def: "3-4 panic attacks a week; avoids driving on highways.",
        goals: [{ words: "Drive to my sister's without an attack.", text: "Reduce panic attacks and resume avoided travel.", objectives: [
          ["Reduce panic attacks from 4 to 1 or fewer per week.", "frequency", null, 4, 1, "attacks per week", "Panic diary", 60, "progressing",
            [weeklyTherapy(U.therapist, "CBT", "Panic psychoeducation, interoceptive exposure, cognitive restructuring.", "12 weeks")], { current: 3, currentAgo: 7 }],
        ] }] },
    ],
  });

  /* ---------------- Rowan: draft plan in progress (chain incomplete, not signed) ---------------- */
  plan({
    patient: rowan, author: U.therapist, status: "draft",
    header: {
      summary: "Synthetic example. Checking compulsions and intrusive doubts interfering with work.",
      client_vision: "Leave the house in the morning without going back to check the stove.",
      strengths: "Highly conscientious; motivated.",
    },
    problems: [{ title: "Checking compulsions", icd: "F42.2", priority: "high",
      def: "Checks locks and stove 20+ times each morning; late to work 3 times a week.",
      goals: [{ words: "Get out the door on time.", text: "Reduce compulsions so the client can leave home on time.", objectives: [
        ["Reduce morning checking from 20 to 5 or fewer checks per day.", "frequency", null, 20, 5, "checks per day", "Self-monitoring log", 90, "not_started", []],
      ] }] }],
  });

  /* ---------------- Golden thread demo: link seeded signed notes to active-plan objectives ---------------- */
  const notes = db.prepare(`SELECT n.id, n.patient_id FROM notes n WHERE n.status = 'signed' AND n.type IN ('progress','psychiatry','group')`).all();
  const firstObjectives = db.prepare(
    `SELECT o.id FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id
     JOIN treatment_plans tp ON tp.id = p.plan_id WHERE tp.patient_id = ? AND tp.status = 'active' ORDER BY p.sort, g.sort, o.sort LIMIT 2`);
  const link = db.prepare("INSERT OR IGNORE INTO note_objectives (note_id, objective_id, progress, comment) VALUES (?, ?, 'progressing', ?)");
  for (const n of notes) {
    for (const o of firstObjectives.all(n.patient_id)) link.run(n.id, o.id, "Worked on this objective in session. (Synthetic demo text.)");
  }
  void jv2; void mv2;
};
