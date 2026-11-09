"use strict";
/*
 * Clinical module: treatment plans and measurement-based care (PHQ-9, GAD-7).
 *
 * Treatment plans
 *   GET  /patients/:id/treatment-plan[?plan=ID]   current active plan (or latest draft) + history
 *   GET  /patients/:id/treatment-plan/new          new draft form
 *   POST /patients/:id/treatment-plan              create draft (optionally carry forward open goals)
 *   GET  /treatment-plans/:planId/edit             edit plan fields (draft only)
 *   POST /treatment-plans/:planId/edit
 *   POST /treatment-plans/:planId/goals            add goal (draft only)
 *   POST /treatment-plans/:planId/goals/:goalId    update goal (draft: all fields; active: status only)
 *   POST /treatment-plans/:planId/goals/:goalId/delete   (draft only)
 *   POST /treatment-plans/:planId/activate         sign + activate; supersedes the previous active plan
 *   POST /treatment-plans/:planId/complete         active -> completed
 *
 * Measures
 *   GET  /patients/:id/measures                    scores, change from baseline, chart, history
 *   GET  /patients/:id/measures/new?instrument=PHQ9|GAD7
 *   POST /patients/:id/measures
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { tx } = require("../db");
const {
  html, raw, chartPage, notFound, csrfField, select, badge, getPatient,
  today, addDays, fmtDate, fmtTimestamp, fmtDateTime, humanize,
} = require("../views");

const router = express.Router();
const READ = requirePerm("clinical:read");
const WRITE = requirePerm("clinical:write");

/* ================================================================== */
/* Instruments                                                        */
/* ================================================================== */

const RESPONSE_OPTIONS = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
];
const YES_NO = [{ value: 0, label: "No" }, { value: 1, label: "Yes" }];
const FREQ5 = [
  { value: 0, label: "Never" }, { value: 1, label: "Less than monthly" }, { value: 2, label: "Monthly" },
  { value: 3, label: "Weekly" }, { value: 4, label: "Daily or almost daily" },
];
const AUDIT_INJURY = [{ value: 0, label: "No" }, { value: 2, label: "Yes, but not in the last year" }, { value: 4, label: "Yes, during the last year" }];
const PCL_OPTIONS = [
  { value: 0, label: "Not at all" }, { value: 1, label: "A little bit" }, { value: 2, label: "Moderately" },
  { value: 3, label: "Quite a bit" }, { value: 4, label: "Extremely" },
];
const ASRS_OPTIONS = [
  { value: 0, label: "Never" }, { value: 1, label: "Rarely" }, { value: 2, label: "Sometimes" },
  { value: 3, label: "Often" }, { value: 4, label: "Very often" },
];

const sum = (r) => r.reduce((a, b) => a + b, 0);

/*
 * Instrument definitions. Each has:
 *   items: strings, or { text, options, section } (options default to def.options)
 *   score(responses) -> { total, severity, flagged }   (default: sum + bands, never flagged)
 *   bands: [min, max, label] for summed scales; trend: false hides the trend chart for screeners
 * Wording follows the published instruments; verify against the official versions your clinic licenses.
 */
const INSTRUMENTS = {
  PHQ9: {
    key: "PHQ9", name: "PHQ-9", title: "Patient Health Questionnaire (PHQ-9)", construct: "Depression",
    stem: "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
    options: RESPONSE_OPTIONS,
    items: [
      "Little interest or pleasure in doing things",
      "Feeling down, depressed, or hopeless",
      "Trouble falling or staying asleep, or sleeping too much",
      "Feeling tired or having little energy",
      "Poor appetite or overeating",
      "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
      "Trouble concentrating on things, such as reading the newspaper or watching television",
      "Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
      "Thoughts that you would be better off dead or of hurting yourself in some way",
    ],
    max: 27,
    bands: [[0, 4, "minimal"], [5, 9, "mild"], [10, 14, "moderate"], [15, 19, "moderately severe"], [20, 27, "severe"]],
    remission: { below: 5, label: "PHQ-9 < 5 = remission" },
    flagItem: 9,
    score(r) { const total = sum(r); return { total, severity: band(this, total), flagged: r[8] > 0 ? 1 : 0 }; },
  },
  GAD7: {
    key: "GAD7", name: "GAD-7", title: "Generalized Anxiety Disorder scale (GAD-7)", construct: "Anxiety",
    stem: "Over the last 2 weeks, how often have you been bothered by the following problems?",
    options: RESPONSE_OPTIONS,
    items: [
      "Feeling nervous, anxious, or on edge",
      "Not being able to stop or control worrying",
      "Worrying too much about different things",
      "Trouble relaxing",
      "Being so restless that it is hard to sit still",
      "Becoming easily annoyed or irritable",
      "Feeling afraid as if something awful might happen",
    ],
    max: 21,
    bands: [[0, 4, "minimal"], [5, 9, "mild"], [10, 14, "moderate"], [15, 21, "severe"]],
    remission: { below: 5, label: "GAD-7 < 5 = remission" },
  },
  CSSRS: {
    key: "CSSRS", name: "C-SSRS", title: "Columbia Suicide Severity Rating Scale (screener)", construct: "Suicide risk",
    stem: "Ask questions 1 and 2. If the answer to question 2 is Yes, ask questions 3, 4 and 5; if No, answer No to 3–5 and go to question 6. Questions 1–5 refer to the past month.",
    options: YES_NO,
    items: [
      "Have you wished you were dead or wished you could go to sleep and not wake up?",
      "Have you actually had any thoughts of killing yourself?",
      "Have you been thinking about how you might do this?",
      "Have you had these thoughts and had some intention of acting on them?",
      "Have you started to work out or worked out the details of how to kill yourself? Do you intend to carry out this plan?",
      "Have you ever done anything, started to do anything, or prepared to do anything to end your life? (Examples: collected pills, obtained a gun, gave away valuables, wrote a will or suicide note, took out pills but didn't swallow any, held a gun but changed your mind or it was grabbed from your hand, went to the roof but didn't jump; or actually took pills, tried to shoot yourself, cut yourself, tried to hang yourself, etc.)",
      { text: "If Yes to question 6: was this within the past 3 months?", options: [{ value: 0, label: "No / not applicable" }, { value: 1, label: "Yes" }] },
    ],
    max: 6, trend: false, liveTotal: false,
    totalLabel: "Yes answers (1–6)",
    bands: [[0, 0, "no risk identified"], [1, 6, "see risk level"]],
    score(r) {
      const [q1, q2, q3, q4, q5, q6, q6recent] = r;
      let severity = "no risk identified";
      if (q1 || q2) severity = "low risk";
      if (q3 || (q6 && !q6recent)) severity = "moderate risk";
      if (q4 || q5 || (q6 && q6recent)) severity = "high risk";
      return { total: sum(r.slice(0, 6)), severity, flagged: ["moderate risk", "high risk"].includes(severity) ? 1 : 0 };
    },
    validate(r) {
      if (r[1] === 0 && (r[2] || r[3] || r[4])) return "If question 2 is No, questions 3, 4 and 5 must be No.";
      if (r[5] === 0 && r[6]) return "Question 7 only applies when question 6 is Yes.";
      return null;
    },
  },
  AUDIT: {
    key: "AUDIT", name: "AUDIT", title: "Alcohol Use Disorders Identification Test (AUDIT)", construct: "Alcohol use",
    stem: "Questions are about the past year. One drink = one standard drink.",
    options: FREQ5,
    items: [
      { text: "How often do you have a drink containing alcohol?", options: [{ value: 0, label: "Never" }, { value: 1, label: "Monthly or less" }, { value: 2, label: "2–4 times a month" }, { value: 3, label: "2–3 times a week" }, { value: 4, label: "4 or more times a week" }] },
      { text: "How many drinks containing alcohol do you have on a typical day when you are drinking?", options: [{ value: 0, label: "1 or 2" }, { value: 1, label: "3 or 4" }, { value: 2, label: "5 or 6" }, { value: 3, label: "7 to 9" }, { value: 4, label: "10 or more" }] },
      "How often do you have six or more drinks on one occasion?",
      "How often during the last year have you found that you were not able to stop drinking once you had started?",
      "How often during the last year have you failed to do what was normally expected from you because of drinking?",
      "How often during the last year have you needed a first drink in the morning to get yourself going after a heavy drinking session?",
      "How often during the last year have you had a feeling of guilt or remorse after drinking?",
      "How often during the last year have you been unable to remember what happened the night before because you had been drinking?",
      { text: "Have you or someone else been injured as a result of your drinking?", options: AUDIT_INJURY },
      { text: "Has a relative or friend or a doctor or another health worker been concerned about your drinking or suggested you cut down?", options: AUDIT_INJURY },
    ],
    max: 40,
    bands: [[0, 7, "low risk"], [8, 15, "hazardous"], [16, 19, "harmful"], [20, 40, "possible dependence"]],
  },
  DAST10: {
    key: "DAST10", name: "DAST-10", title: "Drug Abuse Screening Test (DAST-10)", construct: "Drug use",
    stem: "These questions refer to the past 12 months. \"Drug use\" means prescription or over-the-counter drugs used in excess of directions, or any non-medical use of drugs. It does not include alcohol or tobacco.",
    options: YES_NO,
    items: [
      "Have you used drugs other than those required for medical reasons?",
      "Do you abuse more than one drug at a time?",
      { text: "Are you always able to stop using drugs when you want to?", options: [{ value: 1, label: "No" }, { value: 0, label: "Yes" }] },
      "Have you had \"blackouts\" or \"flashbacks\" as a result of drug use?",
      "Do you ever feel bad or guilty about your drug use?",
      "Does your spouse (or parents) ever complain about your involvement with drugs?",
      "Have you neglected your family because of your use of drugs?",
      "Have you engaged in illegal activities in order to obtain drugs?",
      "Have you ever experienced withdrawal symptoms (felt sick) when you stopped taking drugs?",
      "Have you had medical problems as a result of your drug use (e.g., memory loss, hepatitis, convulsions, bleeding)?",
    ],
    max: 10, liveTotal: true,
    bands: [[0, 0, "no problems reported"], [1, 2, "low"], [3, 5, "moderate"], [6, 8, "substantial"], [9, 10, "severe"]],
  },
  PCL5: {
    key: "PCL5", name: "PCL-5", title: "PTSD Checklist for DSM-5 (PCL-5)", construct: "PTSD",
    stem: "Keeping your worst stressful experience in mind, how much were you bothered by each problem in the past month?",
    options: PCL_OPTIONS,
    items: [
      "Repeated, disturbing, and unwanted memories of the stressful experience?",
      "Repeated, disturbing dreams of the stressful experience?",
      "Suddenly feeling or acting as if the stressful experience were actually happening again (as if you were actually back there reliving it)?",
      "Feeling very upset when something reminded you of the stressful experience?",
      "Having strong physical reactions when something reminded you of the stressful experience (for example, heart pounding, trouble breathing, sweating)?",
      "Avoiding memories, thoughts, or feelings related to the stressful experience?",
      "Avoiding external reminders of the stressful experience (for example, people, places, conversations, activities, objects, or situations)?",
      "Trouble remembering important parts of the stressful experience?",
      "Having strong negative beliefs about yourself, other people, or the world (for example, having thoughts such as: I am bad, there is something seriously wrong with me, no one can be trusted, the world is completely dangerous)?",
      "Blaming yourself or someone else for the stressful experience or what happened after it?",
      "Having strong negative feelings such as fear, horror, anger, guilt, or shame?",
      "Loss of interest in activities that you used to enjoy?",
      "Feeling distant or cut off from other people?",
      "Trouble experiencing positive feelings (for example, being unable to feel happiness or have loving feelings for people close to you)?",
      "Irritable behavior, angry outbursts, or acting aggressively?",
      "Taking too many risks or doing things that could cause you harm?",
      "Being \"superalert\" or watchful or on guard?",
      "Feeling jumpy or easily startled?",
      "Having difficulty concentrating?",
      "Trouble falling or staying asleep?",
    ],
    max: 80,
    bands: [[0, 32, "below threshold"], [33, 80, "probable PTSD"]],
    note: "A score of 31–33 or higher suggests probable PTSD; confirm with a clinical interview. A change of 10–20 points is clinically meaningful.",
  },
  MDQ: {
    key: "MDQ", name: "MDQ", title: "Mood Disorder Questionnaire (MDQ)", construct: "Bipolar spectrum",
    stem: "1. Has there ever been a period of time when you were not your usual self and…",
    options: YES_NO,
    items: [
      "…you felt so good or so hyper that other people thought you were not your normal self or you were so hyper that you got into trouble?",
      "…you were so irritable that you shouted at people or started fights or arguments?",
      "…you felt much more self-confident than usual?",
      "…you got much less sleep than usual and found you didn't really miss it?",
      "…you were much more talkative or spoke much faster than usual?",
      "…thoughts raced through your head or you couldn't slow your mind down?",
      "…you were so easily distracted by things around you that you had trouble concentrating or staying on track?",
      "…you had much more energy than usual?",
      "…you were much more active or did many more things than usual?",
      "…you were much more social or outgoing than usual, for example, you telephoned friends in the middle of the night?",
      "…you were much more interested in sex than usual?",
      "…you did things that were unusual for you or that other people might have thought were excessive, foolish, or risky?",
      "…spending money got you or your family into trouble?",
      { section: "Questions 2 and 3", text: "2. If you answered Yes to more than one of the above, have several of these ever happened during the same period of time?" },
      { text: "3. How much of a problem did any of these cause you — like being unable to work; having family, money or legal troubles; getting into arguments or fights?",
        options: [{ value: 0, label: "No problem" }, { value: 1, label: "Minor problem" }, { value: 2, label: "Moderate problem" }, { value: 3, label: "Serious problem" }] },
    ],
    max: 13, trend: false, liveTotal: false,
    totalLabel: "Yes answers (question 1)",
    bands: [[0, 13, "screen"]],
    note: "Positive screen requires all three: 7 or more Yes answers to question 1, Yes to question 2, and a moderate or serious problem on question 3.",
    score(r) {
      const total = sum(r.slice(0, 13));
      const positive = total >= 7 && r[13] === 1 && r[14] >= 2;
      return { total, severity: positive ? "positive screen" : "negative screen", flagged: 0 };
    },
  },
  ASRS: {
    key: "ASRS", name: "ASRS v1.1", title: "Adult ADHD Self-Report Scale (ASRS v1.1) screener", construct: "Adult ADHD",
    stem: "How often have you had each of these over the past 6 months?",
    options: ASRS_OPTIONS,
    items: [
      "How often do you have trouble wrapping up the final details of a project, once the challenging parts have been done?",
      "How often do you have difficulty getting things in order when you have to do a task that requires organization?",
      "How often do you have problems remembering appointments or obligations?",
      "When you have a task that requires a lot of thought, how often do you avoid or delay getting started?",
      "How often do you fidget or squirm with your hands or feet when you have to sit down for a long time?",
      "How often do you feel overly active and compelled to do things, like you were driven by a motor?",
    ],
    max: 6, trend: false, liveTotal: false,
    totalLabel: "Items in the shaded (positive) range",
    bands: [[0, 6, "screen"]],
    note: "Items 1–3 count when answered Sometimes or more; items 4–6 when answered Often or more. Four or more = symptoms highly consistent with adult ADHD; further evaluation is warranted.",
    score(r) {
      const total = r.filter((v, i) => v >= (i < 3 ? 2 : 3)).length;
      return { total, severity: total >= 4 ? "positive screen" : "negative screen", flagged: 0 };
    },
  },
};

function band(def, total) {
  const b = def.bands.find(([lo, hi]) => total >= lo && total <= hi);
  return b ? b[2] : "unknown";
}
const itemText = (it) => (typeof it === "string" ? it : it.text);
const itemOptions = (def, it) => (typeof it === "object" && it.options) || def.options;

/**
 * Score a completed questionnaire.
 * @param {string} instrument key of INSTRUMENTS
 * @param {number[]} responses one value per item, in item order, each one of that item's option values
 * @returns {{ total: number, severity: string, flagged: 0|1 }}
 * Throws on an unknown instrument, wrong item count, invalid value or inconsistent answers.
 */
function scoreInstrument(instrument, responses) {
  const def = INSTRUMENTS[instrument];
  if (!def) throw new Error(`Unknown instrument: ${instrument}`);
  if (!Array.isArray(responses) || responses.length !== def.items.length) {
    throw new Error(`${def.name} requires ${def.items.length} responses`);
  }
  responses.forEach((r, i) => {
    if (!itemOptions(def, def.items[i]).some((o) => o.value === r)) throw new Error(`Invalid response for item ${i + 1}`);
  });
  const inconsistent = def.validate ? def.validate(responses) : null;
  if (inconsistent) throw new Error(inconsistent);
  if (def.score) return def.score(responses);
  const total = sum(responses);
  return { total, severity: band(def, total), flagged: 0 };
}

function severityFor(instrument, total) {
  return band(INSTRUMENTS[instrument], total);
}

const SEVERITY_TONE = {
  minimal: "good", mild: "info", moderate: "warn", "moderately severe": "bad", severe: "bad",
  "no risk identified": "good", "low risk": "info", "moderate risk": "warn", "high risk": "bad",
  hazardous: "warn", harmful: "bad", "possible dependence": "bad",
  "no problems reported": "good", low: "info", substantial: "bad",
  "below threshold": "good", "probable PTSD": "bad",
  "negative screen": "good", "positive screen": "warn",
};
const BAND_FILL = Object.fromEntries(Object.entries(SEVERITY_TONE).map(([k, t]) => [k, `var(--${t}-bg)`]));
const sevBadge = (sev) => html`<span class="badge badge--${SEVERITY_TONE[sev] || "muted"}">${humanize(sev)}</span>`;

const CRISIS_MESSAGES = {
  PHQ9: "URGENT: PHQ-9 item 9 (thoughts of being better off dead or of self-harm) was endorsed. ",
  CSSRS: "URGENT: the C-SSRS screen shows moderate or high suicide risk. ",
};
const CRISIS_TAIL =
  "Complete a same-day suicide risk assessment and collaborative safety plan before the patient leaves or the session ends, and document both. " +
  "Crisis resources: 988 Suicide & Crisis Lifeline (call or text 988, or chat at 988lifeline.org). If there is imminent danger, call 911.";
const CRISIS_MESSAGE = CRISIS_MESSAGES.PHQ9 + CRISIS_TAIL;

/* ================================================================== */
/* Helpers                                                            */
/* ================================================================== */

const GOAL_STATUSES = ["not_started", "in_progress", "met", "revised", "discontinued"];

function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const str = (v, max = 5000) => String(v ?? "").trim().slice(0, max);
const intId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

function loadPlan(req) {
  const id = intId(req.params.planId);
  if (id === null) return null;
  const plan = req.db.prepare("SELECT * FROM treatment_plans WHERE id = ?").get(id);
  if (!plan) return null;
  const patient = getPatient(req, plan.patient_id);
  return patient ? { plan, patient } : null;
}

function loadGoal(req, plan) {
  const id = intId(req.params.goalId);
  if (id === null) return null;
  return req.db.prepare("SELECT * FROM treatment_goals WHERE id = ? AND plan_id = ?").get(id, plan.id) || null;
}

function conflict(req, res, patient, message) {
  res.status(409).send(chartPage(req, patient, "plan", html`
    <div class="card"><h1>Can't change this plan</h1><p>${message}</p>
    <p><a href="/ehr/patients/${patient.id}/treatment-plan">Back to treatment plan</a></p></div>`, { title: "Treatment plan" }));
}

function errorList(errors) {
  if (!errors || !errors.length) return "";
  return html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong>
    <ul class="list">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

function touchPlan(db, planId) {
  db.prepare("UPDATE treatment_plans SET updated_at = datetime('now') WHERE id = ?").run(planId);
}

/* ================================================================== */
/* Treatment plans                                                    */
/* ================================================================== */

function planFieldsForm({ values = {} }) {
  return html`
    <div class="form-grid">
      <label>Start date <input type="date" name="start_date" value="${values.start_date || ""}"></label>
      <label>Review date <input type="date" name="review_date" value="${values.review_date || ""}">
        <span class="hint">Required before the plan can be activated. Commonly every 90 days.</span></label>
      <label class="span-all">Summary / presenting concerns
        <textarea name="summary">${values.summary || ""}</textarea></label>
      <label class="span-all">Strengths
        <textarea name="strengths">${values.strengths || ""}</textarea></label>
      <label class="span-all">Barriers
        <textarea name="barriers">${values.barriers || ""}</textarea></label>
    </div>`;
}

function validatePlanFields(body) {
  const v = {
    start_date: str(body.start_date, 10),
    review_date: str(body.review_date, 10),
    summary: str(body.summary),
    strengths: str(body.strengths),
    barriers: str(body.barriers),
  };
  const errors = [];
  if (v.start_date && !isDate(v.start_date)) errors.push("Start date must be a valid date.");
  if (v.review_date && !isDate(v.review_date)) errors.push("Review date must be a valid date.");
  if (isDate(v.start_date) && isDate(v.review_date) && v.review_date < v.start_date) errors.push("Review date can't be before the start date.");
  return { v, errors };
}

function goalFields(values = {}, idp = "new") {
  return html`
    <div class="form-grid">
      <label for="problem-${idp}">Problem <input id="problem-${idp}" name="problem" value="${values.problem || ""}" required maxlength="500"></label>
      <label for="target-${idp}">Target date <input id="target-${idp}" type="date" name="target_date" value="${values.target_date || ""}"></label>
      <label for="status-${idp}">Status ${select("status", GOAL_STATUSES, values.status || "in_progress", `id="status-${idp}"`)}</label>
      <label class="span-all" for="goal-${idp}">Goal <input id="goal-${idp}" name="goal" value="${values.goal || ""}" required maxlength="1000"></label>
      <label class="span-all" for="obj-${idp}">Measurable objectives
        <textarea id="obj-${idp}" name="objectives">${values.objectives || ""}</textarea>
        <span class="hint">e.g. "PHQ-9 below 10 for two consecutive administrations".</span></label>
      <label class="span-all" for="int-${idp}">Interventions
        <textarea id="int-${idp}" name="interventions">${values.interventions || ""}</textarea></label>
    </div>`;
}

function validateGoal(body) {
  const v = {
    problem: str(body.problem, 500),
    goal: str(body.goal, 1000),
    objectives: str(body.objectives),
    interventions: str(body.interventions),
    target_date: str(body.target_date, 10),
    status: str(body.status, 20) || "in_progress",
  };
  const errors = [];
  if (!v.problem) errors.push("Problem is required.");
  if (!v.goal) errors.push("Goal is required.");
  if (v.target_date && !isDate(v.target_date)) errors.push("Target date must be a valid date.");
  if (!GOAL_STATUSES.includes(v.status)) errors.push("Choose a valid goal status.");
  return { v, errors };
}

/** Render the plan tab. opts: { plan, errors, addValues, editGoal: {id, values} } */
function renderPlanTab(req, patient, opts = {}) {
  const db = req.db;
  const plans = db.prepare(
    `SELECT tp.*, u.name AS author_name, u.credentials AS author_credentials
     FROM treatment_plans tp JOIN users u ON u.id = tp.author_id
     WHERE tp.patient_id = ? ORDER BY tp.created_at DESC, tp.id DESC`).all(patient.id);
  const active = plans.find((p) => p.status === "active") || null;
  const draft = plans.find((p) => p.status === "draft") || null;
  const plan = opts.plan ? plans.find((p) => p.id === opts.plan.id) : (active || draft);
  const writable = can(req.user, "clinical:write");
  const base = `/ehr/patients/${patient.id}`;
  const t = today();

  if (!plan) {
    return html`
      <div class="page-head"><h1>Treatment plan</h1>
        ${writable ? html`<a class="btn btn--primary" href="${base}/treatment-plan/new">New treatment plan</a>` : ""}</div>
      <div class="card"><p class="muted">No treatment plan on file.</p></div>`;
  }

  const goals = db.prepare("SELECT * FROM treatment_goals WHERE plan_id = ? ORDER BY sort, id").all(plan.id);
  const isDraft = plan.status === "draft";
  const isActive = plan.status === "active";
  const overdue = isActive && plan.review_date && plan.review_date < t;
  const history = plans.filter((p) => p.id !== plan.id);
  const pAction = `/ehr/treatment-plans/${plan.id}`;

  const goalItem = (g, i) => {
    const editing = opts.editGoal && opts.editGoal.id === g.id;
    const vals = editing ? opts.editGoal.values : g;
    return html`
      <li>
        <div class="row">
          <h3 style="margin:0">Goal ${i + 1}: ${g.problem}</h3>
          ${badge(g.status)}
          ${g.target_date ? html`<span class="muted small">Target ${fmtDate(g.target_date)}</span>` : ""}
        </div>
        <dl class="facts" style="margin-top:.5rem">
          <dt>Goal</dt><dd class="prewrap">${g.goal}</dd>
          <dt>Objectives</dt><dd class="prewrap">${g.objectives || html`<span class="muted">None recorded</span>`}</dd>
          <dt>Interventions</dt><dd class="prewrap">${g.interventions || html`<span class="muted">None recorded</span>`}</dd>
        </dl>
        ${writable && isDraft ? html`
          <details ${editing ? raw("open") : ""} style="margin-top:.5rem">
            <summary>Edit goal ${i + 1}</summary>
            <form method="post" action="${pAction}/goals/${g.id}" class="stack" style="margin-top:.75rem">
              ${csrfField(req)}
              ${goalFields(vals, g.id)}
              <div class="form-actions"><button class="btn btn--primary btn--sm" type="submit">Save goal</button></div>
            </form>
            <form method="post" action="${pAction}/goals/${g.id}/delete" class="inline-form" data-confirm="Delete this goal?">
              ${csrfField(req)}<button class="btn btn--danger btn--sm" type="submit">Delete goal</button>
            </form>
          </details>` : ""}
        ${writable && isActive ? html`
          <form method="post" action="${pAction}/goals/${g.id}" class="row" style="margin-top:.5rem">
            ${csrfField(req)}
            <label for="gs-${g.id}" class="visually-hidden">Status for goal ${i + 1}</label>
            <span style="max-width:220px">${select("status", GOAL_STATUSES, g.status, `id="gs-${g.id}"`)}</span>
            <button class="btn btn--sm" type="submit">Update status</button>
          </form>` : ""}
      </li>`;
  };

  return html`
    <div class="page-head">
      <h1>Treatment plan ${badge(plan.status)}</h1>
      <div class="row">
        ${writable && isDraft ? html`
          <a class="btn" href="${pAction}/edit">Edit plan details</a>
          <form method="post" action="${pAction}/activate" class="inline-form"
            data-confirm="Sign and activate this plan?${active && active.id !== plan.id ? " The current active plan will be marked superseded." : ""}">
            ${csrfField(req)}<button class="btn btn--primary" type="submit">Sign &amp; activate</button>
          </form>` : ""}
        ${writable && isActive ? html`
          <form method="post" action="${pAction}/complete" class="inline-form" data-confirm="Mark this plan completed?">
            ${csrfField(req)}<button class="btn" type="submit">Mark completed</button>
          </form>` : ""}
        ${writable && !draft ? html`<a class="btn ${isActive ? "" : "btn--primary"}" href="${base}/treatment-plan/new">${active ? "Revise plan" : "New plan"}</a>` : ""}
      </div>
    </div>
    ${errorList(opts.errors)}
    ${draft && plan.id !== draft.id ? html`<div class="alert alert--info" role="status">A draft revision of this plan is in progress. <a href="${base}/treatment-plan?plan=${draft.id}">Open draft</a></div>` : ""}
    ${active && plan.id !== active.id && plan.status !== "draft" ? html`<div class="alert alert--info" role="status">You are viewing a previous plan. <a href="${base}/treatment-plan">View the current plan</a></div>` : ""}
    ${overdue ? html`<div class="alert alert--warn" role="alert"><strong>Review overdue.</strong> This plan's review date (${fmtDate(plan.review_date)}) has passed. Review it with the patient and revise.</div>` : ""}

    <section class="card" aria-labelledby="plan-details">
      <h2 id="plan-details">Plan details</h2>
      <dl class="facts">
        <dt>Status</dt><dd>${badge(plan.status)}</dd>
        <dt>Start date</dt><dd>${plan.start_date ? fmtDate(plan.start_date) : html`<span class="muted">Not set</span>`}</dd>
        <dt>Review date</dt><dd>${plan.review_date ? fmtDate(plan.review_date) : html`<span class="muted">Not set</span>`}
          ${overdue ? html` <span class="pill pill--bad">Overdue</span>` : ""}</dd>
        <dt>Author</dt><dd>${plan.author_name}${plan.author_credentials ? `, ${plan.author_credentials}` : ""}</dd>
        ${plan.signed_at ? html`<dt>Signed</dt><dd>${fmtTimestamp(plan.signed_at)}</dd>` : ""}
      </dl>
      <div class="note-section" style="margin-top:1rem"><h3>Summary</h3><p>${plan.summary || html`<span class="muted">None recorded</span>`}</p></div>
      <div class="note-section"><h3>Strengths</h3><p>${plan.strengths || html`<span class="muted">None recorded</span>`}</p></div>
      <div class="note-section"><h3>Barriers</h3><p>${plan.barriers || html`<span class="muted">None recorded</span>`}</p></div>
    </section>

    <section class="card" aria-labelledby="plan-goals">
      <h2 id="plan-goals">Goals (${goals.length})</h2>
      ${goals.length ? html`<ul class="list-plain">${goals.map(goalItem)}</ul>` : html`<p class="muted">No goals yet. Add at least one goal before activating.</p>`}
    </section>

    ${writable && isDraft ? html`
      <section class="card" aria-labelledby="add-goal">
        <h2 id="add-goal">Add a goal</h2>
        <form method="post" action="${pAction}/goals" class="stack">
          ${csrfField(req)}
          ${goalFields(opts.addValues || {}, "new")}
          <div class="form-actions"><button class="btn btn--primary" type="submit">Add goal</button></div>
        </form>
      </section>` : ""}

    <section class="card" aria-labelledby="plan-history">
      <h2 id="plan-history">Plan history</h2>
      ${history.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Created</th><th>Status</th><th>Start</th><th>Review</th><th>Signed</th><th>Author</th><th></th></tr></thead>
          <tbody>${history.map((p) => html`<tr>
            <td>${fmtTimestamp(p.created_at)}</td><td>${badge(p.status)}</td><td>${fmtDate(p.start_date)}</td>
            <td>${fmtDate(p.review_date)}</td><td>${fmtTimestamp(p.signed_at)}</td><td>${p.author_name}</td>
            <td><a href="${base}/treatment-plan?plan=${p.id}">View</a></td></tr>`)}</tbody>
        </table></div>` : html`<p class="muted">No previous plans.</p>`}
    </section>`;
}

router.get("/patients/:id/treatment-plan", READ, (req, res) => {
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  let plan = null;
  if (req.query.plan !== undefined) {
    const pid = intId(req.query.plan);
    plan = pid === null ? null : req.db.prepare("SELECT * FROM treatment_plans WHERE id = ? AND patient_id = ?").get(pid, patient.id);
    if (!plan) return notFound(req, res, "Treatment plan");
  }
  const body = renderPlanTab(req, patient, { plan });
  const shown = plan || req.db.prepare(
    `SELECT id FROM treatment_plans WHERE patient_id = ? AND status IN ('active','draft')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`).get(patient.id);
  audit(req, "view", "treatment_plan", shown ? shown.id : null, patient.id);
  res.send(chartPage(req, patient, "plan", body, { title: "Treatment plan" }));
});

function newPlanPage(req, patient, { values, errors, active }) {
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><h1>New treatment plan</h1></div>
    ${errorList(errors)}
    <form method="post" action="/ehr/patients/${patient.id}/treatment-plan" class="card stack" data-dirty-check>
      ${csrfField(req)}
      ${planFieldsForm({ values })}
      ${active ? html`<label class="check"><input type="checkbox" name="copy_goals" value="1" ${values.copy_goals ? raw("checked") : ""}>
        Carry forward open goals (not met or discontinued) from the current active plan</label>` : ""}
      <p class="hint">The plan is saved as a draft. Add goals, then sign and activate it.</p>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Create draft</button>
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/treatment-plan">Cancel</a>
      </div>
    </form>`, { title: "New treatment plan" });
}

const activePlanFor = (db, patientId) =>
  db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(patientId) || null;
const draftPlanFor = (db, patientId) =>
  db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(patientId) || null;

router.get("/patients/:id/treatment-plan/new", WRITE, (req, res) => {
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const draft = draftPlanFor(req.db, patient.id);
  if (draft) {
    req.flash("info", "This patient already has a draft plan. Continue editing it below.");
    return res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${draft.id}`);
  }
  const active = activePlanFor(req.db, patient.id);
  const t = today();
  const values = active
    ? { start_date: t, review_date: addDays(t, 90), summary: active.summary, strengths: active.strengths, barriers: active.barriers, copy_goals: true }
    : { start_date: t, review_date: addDays(t, 90) };
  res.send(newPlanPage(req, patient, { values, errors: [], active }));
});

router.post("/patients/:id/treatment-plan", WRITE, (req, res) => {
  const db = req.db;
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const existingDraft = draftPlanFor(db, patient.id);
  if (existingDraft) {
    req.flash("info", "This patient already has a draft plan. Continue editing it below.");
    return res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${existingDraft.id}`);
  }
  const active = activePlanFor(db, patient.id);
  const { v, errors } = validatePlanFields(req.body);
  const copy = !!active && req.body.copy_goals === "1";
  if (errors.length) {
    return res.status(400).send(newPlanPage(req, patient, { values: { ...v, copy_goals: copy }, errors, active }));
  }
  const planId = tx(db, () => {
    const id = Number(db.prepare(
      `INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, summary, strengths, barriers)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`).run(patient.id, req.user.id, v.start_date || null, v.review_date || null,
      v.summary || null, v.strengths || null, v.barriers || null).lastInsertRowid);
    if (copy) {
      db.prepare(
        `INSERT INTO treatment_goals (plan_id, problem, goal, objectives, interventions, target_date, status, sort)
         SELECT ?, problem, goal, objectives, interventions, target_date, status, sort FROM treatment_goals
         WHERE plan_id = ? AND status NOT IN ('met','discontinued') ORDER BY sort, id`).run(id, active.id);
    }
    return id;
  });
  audit(req, "create", "treatment_plan", planId, patient.id, copy ? "draft created; open goals carried forward" : "draft created");
  req.flash("success", "Draft treatment plan created.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${planId}`);
});

function editPlanPage(req, patient, plan, { values, errors }) {
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><h1>Edit treatment plan</h1></div>
    ${errorList(errors)}
    <form method="post" action="/ehr/treatment-plans/${plan.id}/edit" class="card stack" data-dirty-check>
      ${csrfField(req)}
      ${planFieldsForm({ values })}
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Save plan</button>
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/treatment-plan?plan=${plan.id}">Cancel</a>
      </div>
    </form>`, { title: "Edit treatment plan" });
}

router.get("/treatment-plans/:planId/edit", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "draft") return conflict(req, res, patient, "Only draft plans can be edited. Start a revision to make changes.");
  audit(req, "view", "treatment_plan", plan.id, patient.id, "edit form");
  res.send(editPlanPage(req, patient, plan, { values: plan, errors: [] }));
});

router.post("/treatment-plans/:planId/edit", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "draft") return conflict(req, res, patient, "Only draft plans can be edited. Start a revision to make changes.");
  const { v, errors } = validatePlanFields(req.body);
  if (errors.length) return res.status(400).send(editPlanPage(req, patient, plan, { values: v, errors }));
  req.db.prepare(
    `UPDATE treatment_plans SET start_date = ?, review_date = ?, summary = ?, strengths = ?, barriers = ?, updated_at = datetime('now')
     WHERE id = ?`).run(v.start_date || null, v.review_date || null, v.summary || null, v.strengths || null, v.barriers || null, plan.id);
  audit(req, "update", "treatment_plan", plan.id, patient.id, "plan fields updated");
  req.flash("success", "Plan details saved.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${plan.id}`);
});

router.post("/treatment-plans/:planId/goals", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "draft") return conflict(req, res, patient, "Goals can only be added to a draft plan.");
  const { v, errors } = validateGoal(req.body);
  if (errors.length) {
    return res.status(400).send(chartPage(req, patient, "plan", renderPlanTab(req, patient, { plan, errors, addValues: v }), { title: "Treatment plan" }));
  }
  const db = req.db;
  const goalId = tx(db, () => {
    const sort = db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM treatment_goals WHERE plan_id = ?").get(plan.id).n;
    const id = Number(db.prepare(
      `INSERT INTO treatment_goals (plan_id, problem, goal, objectives, interventions, target_date, status, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, v.problem, v.goal, v.objectives || null, v.interventions || null,
      v.target_date || null, v.status, sort).lastInsertRowid);
    touchPlan(db, plan.id);
    return id;
  });
  audit(req, "update", "treatment_plan", plan.id, patient.id, `goal ${goalId} added`);
  req.flash("success", "Goal added.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${plan.id}`);
});

router.post("/treatment-plans/:planId/goals/:goalId", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const goal = loadGoal(req, plan);
  if (!goal) return notFound(req, res, "Goal");
  const back = `/ehr/patients/${patient.id}/treatment-plan?plan=${plan.id}`;
  const db = req.db;

  if (plan.status === "active") {
    const status = str(req.body.status, 20);
    if (!GOAL_STATUSES.includes(status)) {
      return res.status(400).send(chartPage(req, patient, "plan",
        renderPlanTab(req, patient, { plan, errors: ["Choose a valid goal status."] }), { title: "Treatment plan" }));
    }
    db.prepare("UPDATE treatment_goals SET status = ? WHERE id = ?").run(status, goal.id);
    touchPlan(db, plan.id);
    audit(req, "update", "treatment_plan", plan.id, patient.id, `goal ${goal.id} status ${status}`);
    req.flash("success", "Goal status updated.");
    return res.redirect(back);
  }
  if (plan.status !== "draft") return conflict(req, res, patient, "Goals on a completed or superseded plan can't be changed.");

  const { v, errors } = validateGoal(req.body);
  if (errors.length) {
    return res.status(400).send(chartPage(req, patient, "plan",
      renderPlanTab(req, patient, { plan, errors, editGoal: { id: goal.id, values: v } }), { title: "Treatment plan" }));
  }
  db.prepare(
    `UPDATE treatment_goals SET problem = ?, goal = ?, objectives = ?, interventions = ?, target_date = ?, status = ? WHERE id = ?`)
    .run(v.problem, v.goal, v.objectives || null, v.interventions || null, v.target_date || null, v.status, goal.id);
  touchPlan(db, plan.id);
  audit(req, "update", "treatment_plan", plan.id, patient.id, `goal ${goal.id} updated`);
  req.flash("success", "Goal saved.");
  res.redirect(back);
});

router.post("/treatment-plans/:planId/goals/:goalId/delete", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const goal = loadGoal(req, plan);
  if (!goal) return notFound(req, res, "Goal");
  if (plan.status !== "draft") return conflict(req, res, patient, "Goals can only be deleted from a draft plan. Mark the goal discontinued instead.");
  req.db.prepare("DELETE FROM treatment_goals WHERE id = ?").run(goal.id);
  touchPlan(req.db, plan.id);
  audit(req, "update", "treatment_plan", plan.id, patient.id, `goal ${goal.id} deleted`);
  req.flash("success", "Goal deleted.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${plan.id}`);
});

router.post("/treatment-plans/:planId/activate", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "draft") return conflict(req, res, patient, "Only a draft plan can be activated.");
  const db = req.db;
  const errors = [];
  const nGoals = db.prepare("SELECT COUNT(*) AS n FROM treatment_goals WHERE plan_id = ?").get(plan.id).n;
  if (nGoals < 1) errors.push("Add at least one goal before activating.");
  if (!plan.review_date) errors.push("Set a review date before activating.");
  if (errors.length) {
    return res.status(400).send(chartPage(req, patient, "plan", renderPlanTab(req, patient, { plan, errors }), { title: "Treatment plan" }));
  }
  const superseded = tx(db, () => {
    const prev = db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active' AND id <> ?").all(patient.id, plan.id);
    db.prepare(`UPDATE treatment_plans SET status = 'superseded', updated_at = datetime('now')
      WHERE patient_id = ? AND status = 'active' AND id <> ?`).run(patient.id, plan.id);
    db.prepare(`UPDATE treatment_plans SET status = 'active', signed_at = datetime('now'), start_date = COALESCE(start_date, ?),
      updated_at = datetime('now') WHERE id = ?`).run(today(), plan.id);
    return prev.map((p) => p.id);
  });
  audit(req, "activate", "treatment_plan", plan.id, patient.id, "signed and activated");
  superseded.forEach((id) => audit(req, "supersede", "treatment_plan", id, patient.id, `superseded by plan ${plan.id}`));
  req.flash("success", superseded.length ? "Plan signed and activated. The previous plan was marked superseded." : "Plan signed and activated.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan`);
});

router.post("/treatment-plans/:planId/complete", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "active") return conflict(req, res, patient, "Only an active plan can be marked completed.");
  req.db.prepare("UPDATE treatment_plans SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(plan.id);
  audit(req, "complete", "treatment_plan", plan.id, patient.id, "plan completed");
  req.flash("success", "Plan marked completed.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${plan.id}`);
});

/* ================================================================== */
/* Measures                                                           */
/* ================================================================== */

const fmtNum = (n) => (Math.round(n * 10) / 10).toString();

/** Inline SVG line chart of scores over time. rows: [{administered_on, total_score}] ascending. */
function scoreChart(def, rows, idBase) {
  const W = 640, H = 220, L = 40, R = 16, T = 12, B = 34;
  const iw = W - L - R, ih = H - T - B;
  const y = (v) => T + ih - (v / def.max) * ih;
  const dayNum = (s) => Date.parse(s + "T12:00:00Z") / 86400e3;
  const d0 = dayNum(rows[0].administered_on);
  const d1 = dayNum(rows[rows.length - 1].administered_on);
  const span = d1 - d0;
  const x = (s) => (span > 0 ? L + ((dayNum(s) - d0) / span) * iw : L + iw / 2);

  const parts = [];
  // Severity band backgrounds + y-axis labels at band boundaries.
  def.bands.forEach(([lo, hi, label]) => {
    const top = y(Math.min(hi + 1, def.max));
    const bottom = y(lo);
    parts.push(`<rect class="band" x="${L}" y="${fmtNum(top)}" width="${iw}" height="${fmtNum(bottom - top)}" style="fill:${BAND_FILL[label]}"><title>${label}: ${lo}–${hi}</title></rect>`);
    parts.push(`<text x="${L - 6}" y="${fmtNum(bottom + 4)}" text-anchor="end">${lo}</text>`);
  });
  parts.push(`<text x="${L - 6}" y="${fmtNum(y(def.max) + 4)}" text-anchor="end">${def.max}</text>`);
  parts.push(`<line x1="${L}" y1="${T + ih}" x2="${L + iw}" y2="${T + ih}" stroke="currentColor" stroke-opacity=".3"/>`);
  parts.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${T + ih}" stroke="currentColor" stroke-opacity=".3"/>`);
  parts.push(`<text x="12" y="${fmtNum(T + ih / 2)}" text-anchor="middle" transform="rotate(-90 12 ${fmtNum(T + ih / 2)})">Score</text>`);

  // X-axis date labels: all points if few, else first / middle / last.
  const idx = rows.length <= 6 ? rows.map((_, i) => i) : [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  idx.forEach((i) => {
    const r = rows[i];
    const label = fmtDate(r.administered_on).replace(/, \d{4}$/, "");
    const anchor = span === 0 ? "middle" : i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle";
    parts.push(`<text x="${fmtNum(x(r.administered_on))}" y="${H - 12}" text-anchor="${anchor}">${label.replace(/[<&>]/g, "")}</text>`);
  });

  const pts = rows.map((r) => [x(r.administered_on), y(Number(r.total_score))]);
  if (pts.length > 1) parts.push(`<polyline class="line" points="${pts.map(([a, b]) => `${fmtNum(a)},${fmtNum(b)}`).join(" ")}"/>`);
  rows.forEach((r, i) => {
    parts.push(`<circle class="dot" cx="${fmtNum(pts[i][0])}" cy="${fmtNum(pts[i][1])}" r="4"><title>${r.administered_on}: ${Number(r.total_score)}</title></circle>`);
  });

  const first = rows[0], last = rows[rows.length - 1];
  const titleId = `${idBase}-title`, descId = `${idBase}-desc`;
  const desc = rows.length === 1
    ? `One ${def.name} score: ${Number(first.total_score)} on ${first.administered_on}.`
    : `${rows.length} ${def.name} scores from ${first.administered_on} to ${last.administered_on}, from ${Number(first.total_score)} to ${Number(last.total_score)} (scale 0 to ${def.max}).`;
  return raw(`<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${titleId} ${descId}">` +
    `<title id="${titleId}">${def.name} scores over time</title><desc id="${descId}">${desc}</desc>${parts.join("")}</svg>`);
}

function instrumentSection(req, patient, def, rows) {
  const writable = can(req.user, "clinical:write");
  const newHref = `/ehr/patients/${patient.id}/measures/new?instrument=${def.key}`;
  const head = html`
    <div class="card__head">
      <h2 id="m-${def.key}">${def.name} <span class="muted small">${def.construct}</span></h2>
      ${writable ? html`<a class="btn btn--sm btn--primary" href="${newHref}">Administer ${def.name}</a>` : ""}
    </div>`;
  if (!rows.length) {
    return html`<section class="card" aria-labelledby="m-${def.key}">${head}<p class="muted">No ${def.name} scores recorded.</p></section>`;
  }
  if (def.trend === false) return screenerSection(def, rows, head);
  const asc = rows.slice().sort((a, b) => (a.administered_on < b.administered_on ? -1 : a.administered_on > b.administered_on ? 1 : a.id - b.id));
  const baseline = asc[0];
  const latest = asc[asc.length - 1];
  const change = latest.total_score - baseline.total_score;
  const pct = baseline.total_score > 0 ? Math.round((-change / baseline.total_score) * 100) : null;
  const hasFollowUp = asc.length > 1;
  const response = hasFollowUp && baseline.total_score > 0 && latest.total_score <= baseline.total_score / 2;
  const remission = def.remission && latest.total_score < def.remission.below;

  return html`
    <section class="card" aria-labelledby="m-${def.key}">
      ${head}
      <div class="tiles">
        <div class="tile"><span class="tile__num">${latest.total_score}</span>
          <span class="tile__label">Latest (${fmtDate(latest.administered_on)}) ${sevBadge(latest.severity)}</span></div>
        <div class="tile"><span class="tile__num">${baseline.total_score}</span>
          <span class="tile__label">Baseline (${fmtDate(baseline.administered_on)})</span></div>
        <div class="tile"><span class="tile__num">${hasFollowUp ? (change > 0 ? `+${change}` : String(change)) : "—"}</span>
          <span class="tile__label">Change from baseline${hasFollowUp && pct !== null ? ` (${pct >= 0 ? `${pct}% reduction` : `${-pct}% increase`})` : ""}</span></div>
      </div>
      <p class="row">
        ${response ? html`<span class="badge badge--good">Response</span>` : html`<span class="badge badge--muted">No response yet</span>`}
        <span class="hint">≥50% reduction from baseline = response</span>
        ${def.remission ? html`${remission ? html`<span class="badge badge--good">Remission</span>` : html`<span class="badge badge--muted">Not in remission</span>`}
        <span class="hint">${def.remission.label}</span>` : ""}
      </p>
      <figure style="margin:0 0 1rem">
        ${scoreChart(def, asc, `chart-${def.key}`)}
        <figcaption class="hint">Shaded bands show severity: ${def.bands.map(([lo, hi, l]) => `${l} ${lo}–${hi}`).join(", ")}.${def.note ? ` ${def.note}` : ""}</figcaption>
      </figure>
      <details>
        <summary>Chart data table</summary>
        <table class="table">
          <caption class="visually-hidden">${def.name} scores by date</caption>
          <thead><tr><th scope="col">Date</th><th scope="col" class="num">Score</th></tr></thead>
          <tbody>${asc.map((r) => html`<tr><td>${r.administered_on}</td><td class="num">${r.total_score}</td></tr>`)}</tbody>
        </table>
      </details>
      <h3 style="margin-top:1rem">History</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th class="num">Score</th><th>Severity</th>${def.flagItem ? html`<th>Item ${def.flagItem}</th>` : ""}<th>Visit</th><th>Entered by</th></tr></thead>
        <tbody>${rows.map((r) => {
          const resp = safeParse(r.responses);
          return html`<tr>
            <td>${fmtDate(r.administered_on)}</td>
            <td class="num">${r.total_score}</td>
            <td>${sevBadge(r.severity)}</td>
            ${def.flagItem ? html`<td>${r.flagged ? html`<span class="badge badge--bad">Flagged (${resp[def.flagItem - 1]})</span>` : "0"}</td>` : ""}
            <td>${r.appt_start ? fmtDateTime(r.appt_start) : html`<span class="muted">—</span>`}</td>
            <td>${r.entered_by_name || ""}</td>
          </tr>`;
        })}</tbody>
      </table></div>
    </section>`;
}

/** Results card for yes/no screeners (no trend chart): latest result plus history. */
function screenerSection(def, rows, head) {
  const latest = rows[0];
  return html`
    <section class="card" aria-labelledby="m-${def.key}">
      ${head}
      <p class="row"><strong>Latest (${fmtDate(latest.administered_on)}):</strong> ${sevBadge(latest.severity)}
        <span class="muted">${def.totalLabel || "Score"}: ${latest.total_score} / ${def.max}</span>
        ${latest.flagged ? html`<span class="badge badge--bad">Safety flag</span>` : ""}</p>
      ${def.note ? html`<p class="hint">${def.note}</p>` : ""}
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Result</th><th class="num">${def.totalLabel || "Score"}</th><th>Visit</th><th>Entered by</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr>
          <td>${fmtDate(r.administered_on)}</td>
          <td>${sevBadge(r.severity)} ${r.flagged ? html`<span class="badge badge--bad">Flag</span>` : ""}</td>
          <td class="num">${r.total_score}</td>
          <td>${r.appt_start ? fmtDateTime(r.appt_start) : html`<span class="muted">—</span>`}</td>
          <td>${r.entered_by_name || ""}</td>
        </tr>`)}</tbody>
      </table></div>
    </section>`;
}

function safeParse(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

router.get("/patients/:id/measures", READ, (req, res) => {
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const rows = req.db.prepare(
    `SELECT a.*, u.name AS entered_by_name, ap.start_at AS appt_start
     FROM assessments a LEFT JOIN users u ON u.id = a.entered_by LEFT JOIN appointments ap ON ap.id = a.appointment_id
     WHERE a.patient_id = ? ORDER BY a.administered_on DESC, a.id DESC`).all(patient.id);
  const recentFlag = rows.find((r) => r.flagged && r.administered_on >= today(-30));
  const writable = can(req.user, "clinical:write");
  const used = Object.values(INSTRUMENTS).filter((def) => rows.some((r) => r.instrument === def.key));
  audit(req, "view", "assessment", null, patient.id, "measures");
  res.send(chartPage(req, patient, "measures", html`
    <div class="page-head"><h1>Measures</h1></div>
    ${recentFlag ? html`
      <section class="card card--alert" role="alert">
        <h2>Safety follow-up needed</h2>
        <p>${recentFlag.instrument === "CSSRS" ? `The C-SSRS screen showed ${recentFlag.severity}` : "PHQ-9 item 9 (thoughts of being better off dead or of self-harm) was endorsed"} on ${fmtDate(recentFlag.administered_on)}.
          Make sure a same-day suicide risk assessment and safety plan are documented.</p>
        <p class="small">Crisis resources: 988 Suicide &amp; Crisis Lifeline (call or text 988). Call 911 for imminent danger.</p>
      </section>` : ""}
    ${writable ? html`<section class="card" aria-labelledby="m-new">
      <div class="card__head"><h2 id="m-new">Administer a screening</h2></div>
      <div class="row">${Object.values(INSTRUMENTS).map((d) => html`
        <a class="btn btn--sm" href="/ehr/patients/${patient.id}/measures/new?instrument=${d.key}">${d.name} <span class="muted">${d.construct}</span></a>`)}</div>
    </section>` : ""}
    ${used.length ? used.map((def) => instrumentSection(req, patient, def, rows.filter((r) => r.instrument === def.key)))
      : html`<div class="card"><p class="muted">No screenings recorded yet.</p></div>`}
  `, { title: "Measures" }));
});

function measureForm(req, patient, def, { values = {}, errors = [] } = {}) {
  const appts = req.db.prepare(
    `SELECT id, start_at, type FROM appointments WHERE patient_id = ? AND substr(start_at,1,10) <= ?
     ORDER BY start_at DESC LIMIT 20`).all(patient.id, today(1));
  const missing = new Set(values.missing || []);
  return chartPage(req, patient, "measures", html`
    <div class="page-head"><h1>${def.title}</h1>
      <a class="btn btn--sm" href="/ehr/patients/${patient.id}/measures">Back to measures</a>
    </div>
    ${errorList(errors)}
    <form method="post" action="/ehr/patients/${patient.id}/measures" class="stack" ${def.liveTotal === false ? "" : raw("data-score")} data-dirty-check>
      ${csrfField(req)}
      <input type="hidden" name="instrument" value="${def.key}">
      <div class="card form-grid">
        <label>Date administered <input type="date" name="administered_on" value="${values.administered_on || today()}" max="${today()}" required></label>
        <label>Visit (optional)
          ${select("appointment_id", [{ value: "", label: "Not linked to a visit" },
            ...appts.map((a) => ({ value: a.id, label: `${fmtDateTime(a.start_at)} · ${humanize(a.type)}` }))], values.appointment_id || "")}
        </label>
      </div>
      <p><strong>${def.stem}</strong></p>
      ${def.items.map((item, i) => {
        const n = i + 1;
        const cur = values.responses ? values.responses[i] : undefined;
        return html`
          ${typeof item === "object" && item.section ? html`<h3>${item.section}</h3>` : ""}
          <fieldset ${missing.has(n) ? raw('aria-invalid="true" aria-describedby="err-q' + n + '"') : ""}>
            <legend>${/^\d+\./.test(itemText(item)) ? "" : `${n}. `}${itemText(item)}</legend>
            ${missing.has(n) ? html`<p class="error-text" id="err-q${n}">Choose an answer for item ${n}.</p>` : ""}
            <div class="row">${itemOptions(def, item).map((o) => html`
              <label class="check"><input type="radio" name="q${n}" value="${o.value}" required ${cur === o.value ? raw("checked") : ""}>
                ${o.label} (${o.value})</label>`)}</div>
          </fieldset>`;
      })}
      ${def.liveTotal === false
        ? (def.note ? html`<div class="card card--muted"><span class="hint">${def.note}</span></div>` : "")
        : html`<div class="card card--muted row">
        <span>Total score: <strong data-score-total>0</strong> / ${def.max}</span>
        <span class="hint">Severity: ${def.bands.map(([lo, hi, l]) => `${lo}–${hi} ${l}`).join(" · ")}${def.note ? ` · ${def.note}` : ""}</span>
      </div>`}
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Save ${def.name}</button>
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/measures">Cancel</a>
      </div>
    </form>`, { title: def.name });
}

router.get("/patients/:id/measures/new", WRITE, (req, res) => {
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const key = req.query.instrument === undefined ? "PHQ9" : String(req.query.instrument);
  const def = INSTRUMENTS[key];
  if (!def) {
    return res.status(400).send(chartPage(req, patient, "measures", html`
      <div class="card"><h1>Unknown instrument</h1><p>Choose a questionnaire:</p>
        <div class="row">${Object.values(INSTRUMENTS).map((d) => html`<a class="btn" href="/ehr/patients/${patient.id}/measures/new?instrument=${d.key}">${d.name}</a>`)}</div>
      </div>`, { title: "Measures" }));
  }
  res.send(measureForm(req, patient, def));
});

router.post("/patients/:id/measures", WRITE, (req, res) => {
  const db = req.db;
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const def = INSTRUMENTS[String(req.body.instrument || "")];
  if (!def) {
    return res.status(400).send(chartPage(req, patient, "measures",
      html`<div class="card"><h1>Unknown instrument</h1><p><a href="/ehr/patients/${patient.id}/measures">Back to measures</a></p></div>`, { title: "Measures" }));
  }
  const errors = [];
  const responses = [];
  const missing = [];
  def.items.forEach((item, i) => {
    const rv = req.body[`q${i + 1}`];
    const v = typeof rv === "string" && /^\d$/.test(rv) ? Number(rv) : NaN;
    if (itemOptions(def, item).some((o) => o.value === v)) responses.push(v);
    else { responses.push(undefined); missing.push(i + 1); }
  });
  if (missing.length) errors.push(`Answer every item (missing or invalid: item${missing.length > 1 ? "s" : ""} ${missing.join(", ")}).`);
  else if (def.validate) { const msg = def.validate(responses); if (msg) errors.push(msg); }

  const administered_on = str(req.body.administered_on, 10) || today();
  if (!isDate(administered_on)) errors.push("Date administered must be a valid date.");
  else if (administered_on > today()) errors.push("Date administered can't be in the future.");

  let appointmentId = null;
  const apptRaw = str(req.body.appointment_id, 20);
  if (apptRaw) {
    const aid = intId(apptRaw);
    const appt = aid === null ? null : db.prepare("SELECT id FROM appointments WHERE id = ? AND patient_id = ?").get(aid, patient.id);
    if (!appt) errors.push("Choose a visit that belongs to this patient.");
    else appointmentId = appt.id;
  }

  if (errors.length) {
    return res.status(400).send(measureForm(req, patient, def, {
      values: { administered_on, appointment_id: apptRaw, responses, missing }, errors,
    }));
  }
  const { total, severity, flagged } = scoreInstrument(def.key, responses);
  const id = Number(db.prepare(
    `INSERT INTO assessments (patient_id, appointment_id, instrument, responses, total_score, severity, flagged, administered_on, entered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(patient.id, appointmentId, def.key, JSON.stringify(responses), total, severity,
    flagged, administered_on, req.user.id).lastInsertRowid);
  audit(req, "create", "assessment", id, patient.id, `${def.key} recorded${flagged ? "; safety flag" : ""}`);
  if (flagged) req.flash("error", (CRISIS_MESSAGES[def.key] || "") + CRISIS_TAIL);
  req.flash("success", def.trend === false ? `${def.name} saved: ${severity}.` : `${def.name} saved: score ${total} (${severity}).`);
  res.redirect(`/ehr/patients/${patient.id}/measures`);
});

module.exports = { router, scoreInstrument, INSTRUMENTS };
