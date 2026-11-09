"use strict";
/*
 * Treatment plans v2: person-centered, measurable, versioned. See docs/treatment-plan-spec.md.
 *
 * Chart tab
 *   GET  /patients/:id/treatment-plan[?plan=ID]        active plan (or latest draft); ?plan views any version read-only
 *   GET  /patients/:id/treatment-plan/new               new draft form (blank, or copy of the active plan)
 *   POST /patients/:id/treatment-plan                   create draft (diagnoses snapshot; copy_from_active=1 -> revision)
 * Plan
 *   GET  /treatment-plans/:planId/print                 printable plan with signatures
 *   GET|POST /treatment-plans/:planId/edit              header fields (draft only)
 *   POST /treatment-plans/:planId/diagnoses             refresh the diagnoses snapshot (draft only)
 *   POST /treatment-plans/:planId/discard               delete an unsigned draft
 * Tree (draft only; level = problems | goals | objectives | interventions)
 *   GET  /treatment-plans/:planId/:level/new?parent=ID  add form
 *   POST /treatment-plans/:planId/:level                create (body.parent_id)
 *   GET  /treatment-plans/:planId/:level/:itemId/edit
 *   POST /treatment-plans/:planId/:level/:itemId        update
 *   POST /treatment-plans/:planId/:level/:itemId/delete
 *   POST /treatment-plans/:planId/:level/:itemId/move   body.dir = up | down
 * Signatures and lifecycle
 *   GET  /treatment-plans/:planId/sign                  checklist + signature forms
 *   POST /treatment-plans/:planId/signatures            body.role = clinician | client | guardian | supervisor
 *   POST /treatment-plans/:planId/signatures/clear      remove all signatures from a draft (unlocks content)
 *   POST /treatment-plans/:planId/activate              activate; supersedes the previous active plan
 *   POST /treatment-plans/:planId/revise                copy the active plan into a new draft version
 *   GET|POST /treatment-plans/:planId/end               end an active plan with a reason
 * Reviews
 *   GET|POST /treatment-plans/:planId/review            review form / sign review (continue | revise | discharge)
 *   GET  /treatment-plans/:planId/reviews/:reviewId     review record
 *
 * Signed plans are immutable: every content change goes through a new draft version.
 * Reviews are the sanctioned way to change objective status/current value on an active plan.
 */
const express = require("express");
const { requirePerm, verifyPassword } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { tx } = require("../db");
const { INSTRUMENTS, isDate, str, intId, errorList } = require("./clinical");
const {
  html, raw, page, chartPage, notFound, csrfField, select, getPatient, patientName,
  today, addDays, fmtDate, fmtTimestamp, age, humanize,
} = require("../views");

const router = express.Router();
const READ = requirePerm("clinical:read");
const WRITE = requirePerm("clinical:write");

/* ================================================================== */
/* Vocabulary                                                         */
/* ================================================================== */

const PLAN_TYPES = [
  { value: "mental_health", label: "Mental health" },
  { value: "sud", label: "Substance use disorder (SUD)" },
  { value: "co_occurring", label: "Co-occurring (mental health + SUD)" },
];
const PLAN_TYPE_LABEL = Object.fromEntries(PLAN_TYPES.map((t) => [t.value, t.label]));
const isSud = (plan) => plan.plan_type === "sud" || plan.plan_type === "co_occurring";

const OBJ_STATUSES = ["not_started", "progressing", "partially_met", "met", "not_met", "regressed", "revised", "discontinued"];
const PROBLEM_STATUSES = ["active", "resolved", "deferred", "referred"];
const PRIORITIES = ["high", "medium", "low"];
const STAGES = ["precontemplation", "contemplation", "preparation", "action", "maintenance"];
const MEASURE_TYPES = [
  { value: "instrument", label: "Standardized instrument" },
  { value: "frequency", label: "Frequency (times per period)" },
  { value: "duration", label: "Duration (time)" },
  { value: "rating", label: "Self-rating (e.g. 0-10)" },
  { value: "attainment", label: "Yes / no attainment" },
];
const MEASURE_LABEL = Object.fromEntries(MEASURE_TYPES.map((m) => [m.value, m.label]));
const DIRECTIONS = [
  { value: "decrease", label: "Decrease to target" },
  { value: "increase", label: "Increase to target" },
  { value: "achieve", label: "Achieve (yes/no)" },
];
const INTERVENTION_KINDS = [
  { value: "professional", label: "Professional service" },
  { value: "self_directed", label: "Client self-directed action" },
  { value: "natural_support", label: "Natural support" },
];
const KIND_LABEL = Object.fromEntries(INTERVENTION_KINDS.map((k) => [k.value, k.label]));
const MODALITIES = ["CBT", "Behavioral activation", "Cognitive processing therapy (CPT)", "Prolonged exposure", "Exposure and response prevention",
  "DBT skills", "ACT", "Motivational interviewing", "Relapse prevention", "Medication management", "MOUD", "Peer support",
  "Family therapy", "Group therapy", "Case management", "Psychoeducation", "Mindfulness", "Sleep hygiene / CBT-I", "Safety planning"];
// ASAM Criteria 4th edition dimension names (verify against the licensed ASAM text).
const ASAM_DIMS = {
  1: "Intoxication, Withdrawal & Addiction Medications",
  2: "Biomedical Conditions",
  3: "Psychiatric & Cognitive Conditions",
  4: "Substance Use-Related Risks",
  5: "Recovery Environment Interactions",
  6: "Person-Centered Considerations",
};
const ASAM_LEVELS = [
  ["1.0", "Long-term remission monitoring"], ["1.5", "Outpatient therapy"], ["1.7", "Medically managed outpatient"],
  ["2.1", "Intensive outpatient"], ["2.5", "High-intensity outpatient"], ["2.7", "Medically managed intensive outpatient"],
  ["3.1", "Clinically managed low-intensity residential"], ["3.5", "Clinically managed high-intensity residential"],
  ["3.7", "Medically managed residential"], ["4.0", "Medically managed inpatient"],
];
const ASAM_LEVEL_LABEL = Object.fromEntries(ASAM_LEVELS.map(([k, l]) => [k, `Level ${k}: ${l}`]));
const END_REASONS = [
  { value: "goals_met", label: "Goals met" },
  { value: "discharged", label: "Discharged" },
  { value: "transferred", label: "Transferred to another provider / level of care" },
  { value: "client_withdrew", label: "Client withdrew from treatment" },
  { value: "other", label: "Other" },
];
const SIG_ROLES = ["clinician", "client", "guardian", "supervisor"];
const CLIENT_METHODS = [
  { value: "in_person", label: "In person (wet or pad signature)" },
  { value: "electronic", label: "Electronic" },
  { value: "verbal", label: "Verbal (telehealth / phone), attested by staff" },
];
const REVIEW_ACTIONS = [
  { value: "continue", label: "Continue as written" },
  { value: "modify", label: "Modify objective" },
  { value: "change_intervention", label: "Change intervention" },
  { value: "close", label: "Close objective" },
];
const OUTCOMES = [
  { value: "continue", label: "Continue the plan", hint: "Next review date moves out by the review interval." },
  { value: "revise", label: "Revise the plan", hint: "Creates a new draft version to edit and re-sign." },
  { value: "discharge", label: "Discharge / end the plan", hint: "Ends this plan. It stays on file." },
];
// Instruments with a numeric score that can track an objective.
const TRACKABLE = Object.values(INSTRUMENTS).filter((d) => d.trend !== false && d.bands && d.max);
// "No reliable improvement" heuristic thresholds (points).
const RELIABLE_CHANGE = { PHQ9: 5, GAD7: 4 };
// Vague objective wording that is hard to measure (soft warning only).
const VAGUE = [/\bunderstand/i, /\bgain(s|ing)?\b[^.]{0,20}\binsight/i, /\binsight\b/i, /\bfeel(s|ing)? better/i,
  /\bbe(come)? (more )?complian/i, /\bcomplian(t|ce)\b/i, /\blearn(s|ing)?\b[^.]{0,20}\bcoping skills/i];

const TONE = {
  not_started: "muted", progressing: "info", partially_met: "info", met: "good", not_met: "bad", regressed: "bad",
  revised: "info", discontinued: "muted", active: "good", draft: "warn", superseded: "muted", completed: "muted",
  resolved: "good", deferred: "muted", referred: "info", high: "bad", medium: "warn", low: "info",
  continue: "good", revise: "warn", discharge: "muted",
};
const tag = (status, label) => html`<span class="badge badge--${TONE[status] || "muted"}">${label || humanize(status)}</span>`;
const checked = (b) => (b ? raw("checked") : "");
const fmtN = (v) => (v === null || v === undefined || v === "" ? "—" : String(Math.round(Number(v) * 10) / 10));
const reqSupervisor = () => process.env.EHR_PLAN_REQUIRE_SUPERVISOR === "1";
const PART2_NOTICE = "42 CFR Part 2 notice: this record contains substance use disorder treatment information protected by federal " +
  "confidentiality rules (42 CFR Part 2). Federal law prohibits further use or disclosure of this information except as " +
  "permitted by the patient's written consent or as otherwise allowed by 42 CFR Part 2.";

/* ================================================================== */
/* Data access                                                        */
/* ================================================================== */

function loadPlan(req) {
  const id = intId(req.params.planId);
  if (id === null) return null;
  const plan = req.db.prepare(
    `SELECT tp.*, u.name AS author_name, u.credentials AS author_credentials
     FROM treatment_plans tp JOIN users u ON u.id = tp.author_id WHERE tp.id = ?`).get(id);
  if (!plan) return null;
  const patient = getPatient(req, plan.patient_id);
  return patient ? { plan, patient } : null;
}
const activePlanFor = (db, patientId) =>
  db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(patientId) || null;
const draftPlanFor = (db, patientId) =>
  db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(patientId) || null;

function snapshotDiagnoses(db, patientId) {
  const rows = db.prepare(
    `SELECT icd10_code, description, is_primary FROM diagnoses WHERE patient_id = ? AND status = 'active'
     ORDER BY is_primary DESC, id`).all(patientId);
  return JSON.stringify(rows.map((d) => ({ code: d.icd10_code, description: d.description, primary: d.is_primary ? 1 : 0 })));
}
function planDx(plan) {
  try { const v = JSON.parse(plan.diagnoses || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function staffList(db) {
  return db.prepare("SELECT id, name, credentials FROM users WHERE active = 1 AND role IN ('clinician','admin') ORDER BY name").all();
}
function latestScore(db, patientId, instrument) {
  return db.prepare(
    `SELECT total_score, administered_on FROM assessments WHERE patient_id = ? AND instrument = ?
     ORDER BY administered_on DESC, id DESC LIMIT 1`).get(patientId, instrument) || null;
}
function latestScores(db, patientId) {
  const out = {};
  for (const d of TRACKABLE) { const s = latestScore(db, patientId, d.key); if (s) out[d.key] = s; }
  return out;
}
const signaturesFor = (db, planId) => db.prepare(
  `SELECT s.*, u.credentials FROM plan_signatures s LEFT JOIN users u ON u.id = s.signer_user_id
   WHERE s.plan_id = ? ORDER BY s.signed_at, s.id`).all(planId);
const hasSignatures = (db, planId) => !!db.prepare("SELECT 1 FROM plan_signatures WHERE plan_id = ? LIMIT 1").get(planId);
const touch = (db, planId) => db.prepare("UPDATE treatment_plans SET updated_at = datetime('now') WHERE id = ?").run(planId);

/** % progress = (baseline − current) / (baseline − target), clamped to 0–100; null when not computable. */
function progressPct(baseline, current, target) {
  if ([baseline, current, target].some((v) => v === null || v === undefined || v === "" || isNaN(Number(v)))) return null;
  const b = Number(baseline), c = Number(current), t = Number(target);
  if (b === t) return null;
  return Math.max(0, Math.min(100, Math.round(((b - c) / (b - t)) * 100)));
}

/** Current value for an objective: instrument objectives use the latest score; others the last reviewed value. */
function objectiveMeasure(db, patientId, o) {
  let current = o.current_value, currentOn = o.current_value_on, source = o.current_value === null ? null : "review";
  if (o.measure_type === "instrument" && o.instrument) {
    const s = latestScore(db, patientId, o.instrument);
    if (s) { current = s.total_score; currentOn = s.administered_on; source = "assessment"; }
  }
  return { current, currentOn, source, pct: o.measure_type === "attainment" ? (o.status === "met" ? 100 : null) : progressPct(o.baseline_value, current, o.target_value) };
}

/** Problems → goals → objectives → interventions with numbering, measures and golden-thread note counts. */
function loadTree(db, plan) {
  const problems = db.prepare("SELECT * FROM plan_problems WHERE plan_id = ? ORDER BY sort, id").all(plan.id);
  const goals = db.prepare(
    `SELECT g.* FROM plan_goals g JOIN plan_problems p ON p.id = g.problem_id WHERE p.plan_id = ? ORDER BY g.sort, g.id`).all(plan.id);
  const objectives = db.prepare(
    `SELECT o.* FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id
     WHERE p.plan_id = ? ORDER BY o.sort, o.id`).all(plan.id);
  const interventions = db.prepare(
    `SELECT i.*, u.name AS responsible_name, u.credentials AS responsible_credentials
     FROM plan_interventions i JOIN plan_objectives o ON o.id = i.objective_id JOIN plan_goals g ON g.id = o.goal_id
     JOIN plan_problems p ON p.id = g.problem_id LEFT JOIN users u ON u.id = i.responsible_user_id
     WHERE p.plan_id = ? ORDER BY i.sort, i.id`).all(plan.id);
  const counts = new Map(db.prepare(
    `SELECT no.objective_id AS id, COUNT(*) AS n, MAX(COALESCE(n.service_date, substr(n.signed_at, 1, 10))) AS last
     FROM note_objectives no JOIN notes n ON n.id = no.note_id
     JOIN plan_objectives o ON o.id = no.objective_id JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id
     WHERE p.plan_id = ? AND n.status = 'signed' GROUP BY no.objective_id`).all(plan.id).map((r) => [r.id, r]));

  const byParent = (rows, col) => {
    const m = new Map();
    rows.forEach((r) => { if (!m.has(r[col])) m.set(r[col], []); m.get(r[col]).push(r); });
    return m;
  };
  const gBy = byParent(goals, "problem_id"), oBy = byParent(objectives, "goal_id"), iBy = byParent(interventions, "objective_id");
  const allObjectives = [];
  problems.forEach((p, pi) => {
    p.num = String(pi + 1);
    p.goals = gBy.get(p.id) || [];
    p.goals.forEach((g, gi) => {
      g.num = `${p.num}.${gi + 1}`;
      g.objectives = oBy.get(g.id) || [];
      g.objectives.forEach((o, oi) => {
        o.num = `${g.num}.${oi + 1}`;
        o.interventions = iBy.get(o.id) || [];
        o.measure = objectiveMeasure(db, plan.patient_id, o);
        o.notes = counts.get(o.id) || { n: 0, last: null };
        allObjectives.push(o);
      });
    });
  });
  return { problems, objectives: allObjectives, interventions };
}

/** Copy a plan (header + full tree) into a new draft version. Call inside tx(). */
function copyPlan(db, src, authorId) {
  const HEADER = ["plan_type", "diagnoses", "summary", "strengths", "barriers", "client_vision", "needs", "abilities", "preferences",
    "natural_supports", "family_involvement", "service_summary", "modality_rationale", "estimated_duration", "expected_outcome",
    "discharge_criteria", "aftercare_referrals", "safety_plan_note_id", "review_interval_days", "level_of_care", "loc_indicated",
    "loc_adjusted", "loc_reason", "continued_stay", "mat_plan", "drug_testing_plan", "relapse_prevention", "recovery_supports"];
  const version = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM treatment_plans WHERE patient_id = ?").get(src.patient_id).v;
  const id = Number(db.prepare(
    `INSERT INTO treatment_plans (patient_id, author_id, status, version, supersedes_id, ${HEADER.join(", ")})
     SELECT patient_id, ?, 'draft', ?, id, ${HEADER.join(", ")} FROM treatment_plans WHERE id = ?`).run(authorId, version, src.id).lastInsertRowid);
  const tree = loadTree(db, src);
  const insP = db.prepare(`INSERT INTO plan_problems (plan_id, sort, title, behavioral_definition, icd10_code, asam_dimension, is_driver,
    stage_of_change, priority, barriers, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insG = db.prepare("INSERT INTO plan_goals (problem_id, sort, client_words, goal_text) VALUES (?, ?, ?, ?)");
  const insO = db.prepare(`INSERT INTO plan_objectives (goal_id, sort, text, measure_type, instrument, baseline_value, target_value,
    direction, unit, measurement_method, target_date, linked_strength, status, current_value, current_value_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insI = db.prepare(`INSERT INTO plan_interventions (objective_id, sort, kind, modality, description, frequency, duration,
    responsible_user_id, responsible_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  tree.problems.forEach((p, pi) => {
    const pid = Number(insP.run(id, pi, p.title, p.behavioral_definition, p.icd10_code, p.asam_dimension, p.is_driver,
      p.stage_of_change, p.priority, p.barriers, p.status).lastInsertRowid);
    p.goals.forEach((g, gi) => {
      const gid = Number(insG.run(pid, gi, g.client_words, g.goal_text).lastInsertRowid);
      g.objectives.forEach((o, oi) => {
        const oid = Number(insO.run(gid, oi, o.text, o.measure_type, o.instrument, o.baseline_value, o.target_value, o.direction,
          o.unit, o.measurement_method, o.target_date, o.linked_strength, o.status, o.current_value, o.current_value_on).lastInsertRowid);
        o.interventions.forEach((iv, ii) => insI.run(oid, ii, iv.kind, iv.modality, iv.description, iv.frequency, iv.duration,
          iv.responsible_user_id, iv.responsible_text));
      });
    });
  });
  return id;
}

/** Activation readiness: { errors: [...blocking], warnings: [...prompts], chain }. */
function activationCheck(db, plan, patient) {
  const errors = [], warnings = [];
  const chain = db.prepare(
    `SELECT COUNT(*) AS n FROM plan_interventions i JOIN plan_objectives o ON o.id = i.objective_id
     JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id WHERE p.plan_id = ?`).get(plan.id).n > 0;
  if (!chain) errors.push("Add at least one complete problem → goal → objective → intervention chain.");
  const iv = Number(plan.review_interval_days);
  if (!Number.isInteger(iv) || iv < 7 || iv > 365) errors.push("Set a review interval between 7 and 365 days.");
  const sigs = signaturesFor(db, plan.id);
  const has = (role) => sigs.find((s) => s.role === role);
  if (!has("clinician")) errors.push("Clinician signature is required.");
  if (!has("client")) errors.push("Client signature, or a documented reason the client declined or was unable to sign, is required.");
  if (reqSupervisor() && !has("supervisor")) errors.push("Supervisor co-signature is required by this clinic's settings.");
  if (age(patient.dob) < 18 && !has("guardian")) warnings.push("The client is under 18. Obtain a parent/guardian signature (or document why not).");
  const tree = loadTree(db, plan);
  tree.problems.forEach((p) => {
    if (!p.goals.length) warnings.push(`Problem ${p.num} has no goals.`);
    p.goals.forEach((g) => {
      if (!g.objectives.length) warnings.push(`Goal ${g.num} has no objectives.`);
      g.objectives.forEach((o) => { if (!o.interventions.length) warnings.push(`Objective ${o.num} has no interventions.`); });
    });
  });
  if (!plan.client_vision) warnings.push("The client's vision in their own words isn't recorded (CARF's most-cited planning gap).");
  if (!plan.service_summary) warnings.push("The services summary (type, amount, frequency, duration) is empty; payers expect it.");
  if (!plan.discharge_criteria) warnings.push("Discharge / transition criteria are empty.");
  return { errors, warnings, chain, sigs };
}

/** Plan-level alerts for the plan tab. */
function planAlerts(db, plan, tree) {
  const out = [];
  const t = today();
  if (plan.status === "active" && plan.review_date) {
    if (plan.review_date < t) out.push({ tone: "error", strong: "Plan review overdue.", text: `The review was due ${fmtDate(plan.review_date)}. Start a review with the client.` });
    else if (plan.review_date <= addDays(t, 7)) out.push({ tone: "warn", strong: "Plan review due soon.", text: `The review is due ${fmtDate(plan.review_date)}.` });
  }
  if (plan.status === "active" && plan.activated_at) {
    const act = String(plan.activated_at).slice(0, 10);
    if (act <= addDays(t, -42)) {
      for (const [inst, min] of Object.entries(RELIABLE_CHANGE)) {
        const obj = tree.objectives.find((o) => o.measure_type === "instrument" && o.instrument === inst && o.baseline_value !== null);
        let baseline = obj ? Number(obj.baseline_value) : null;
        if (baseline === null) {
          const b = db.prepare(`SELECT total_score FROM assessments WHERE patient_id = ? AND instrument = ? AND administered_on <= ?
            ORDER BY administered_on DESC, id DESC LIMIT 1`).get(plan.patient_id, inst, act);
          baseline = b ? b.total_score : null;
        }
        const latest = latestScore(db, plan.patient_id, inst);
        if (baseline === null || !latest || latest.administered_on <= act || latest.total_score < 5) continue;
        const drop = baseline - latest.total_score;
        if (drop < min) {
          out.push({ tone: "warn", strong: `No reliable improvement on ${INSTRUMENTS[inst].name}.`,
            text: `More than 6 weeks since activation and the score has changed ${drop >= 0 ? `by only ${drop}` : `by +${-drop}`} point${Math.abs(drop) === 1 ? "" : "s"} (baseline ${fmtN(baseline)}, latest ${latest.total_score} on ${fmtDate(latest.administered_on)}; reliable change is ${min}+). Consider reviewing the plan. This is a heuristic.` });
        }
      }
    }
  }
  return out;
}

/* ================================================================== */
/* Shared rendering                                                   */
/* ================================================================== */

function conflict(req, res, patient, message, planId) {
  res.status(409).send(chartPage(req, patient, "plan", html`
    <div class="card"><h1>Can't change this plan</h1><p>${message}</p>
    <p><a href="/ehr/patients/${patient.id}/treatment-plan${planId ? `?plan=${planId}` : ""}">Back to treatment plan</a></p></div>`, { title: "Treatment plan" }));
}
function warnList(warnings, title = "Check before signing") {
  if (!warnings || !warnings.length) return "";
  return html`<div class="alert alert--warn" role="status"><strong>${title}:</strong>
    <ul class="list">${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`;
}
const planUrl = (plan) => `/ehr/patients/${plan.patient_id}/treatment-plan?plan=${plan.id}`;
const muted = (s = "Not recorded") => html`<span class="muted">${s}</span>`;
const textOr = (v, s) => (v ? html`<span class="prewrap">${v}</span>` : muted(s));
const ta = (name, value, rows = 3, attrs = "") => html`<textarea name="${name}" id="${name}" rows="${rows}" class="ta-sm" ${raw(attrs)}>${value || ""}</textarea>`;
const signerLabel = (s) => `${s.signer_name}${s.credentials ? `, ${s.credentials}` : ""}`;
function endReasonLabel(r) {
  if (!r) return "";
  if (r === "superseded") return "Superseded by a newer version";
  if (r.startsWith("other:")) return `Other: ${r.slice(6).trim()}`;
  const f = END_REASONS.find((e) => e.value === r);
  return f ? f.label : r;
}

/** Header sections shared by the plan tab and the print view. */
const HEADER_GROUPS = [
  { title: "Client's voice", fields: [["client_vision", "Client's vision / overall goal (own words)", 3]] },
  { title: "Strengths, needs, abilities, preferences", fields: [
    ["strengths", "Strengths", 2], ["needs", "Needs", 2], ["abilities", "Abilities", 2], ["preferences", "Preferences", 2]] },
  { title: "Presenting concerns", fields: [["summary", "Summary of presenting concerns", 3]] },
  { title: "Barriers and supports", fields: [
    ["barriers", "Barriers", 2], ["natural_supports", "Natural supports", 2], ["family_involvement", "Family involvement (or why none)", 2]] },
  { title: "Services", fields: [
    ["service_summary", "Services: type, amount, frequency, duration", 3], ["modality_rationale", "Modality rationale", 2],
    ["estimated_duration", "Estimated duration", 0], ["expected_outcome", "Expected outcome / capacity to benefit", 2],
    ["level_of_care", "Level of care / program", 0]] },
  { title: "Discharge and transition", fields: [
    ["discharge_criteria", "Discharge / transition criteria", 3], ["aftercare_referrals", "Aftercare and referrals", 2]] },
];
const SUD_FIELDS = [
  ["loc_reason", "Reason indicated and provided levels differ", 2], ["continued_stay", "Continued-stay justification", 2],
  ["mat_plan", "MAT / MOUD plan", 2], ["drug_testing_plan", "Drug-testing plan", 2],
  ["relapse_prevention", "Relapse-prevention plan (triggers, coping, lapse response, naloxone)", 3],
  ["recovery_supports", "Recovery supports", 2],
];
const TEXT_FIELDS = [...HEADER_GROUPS.flatMap((g) => g.fields), ...SUD_FIELDS];

function dxList(plan) {
  const dx = planDx(plan);
  return dx.length ? html`<ul class="list">${dx.map((d) => html`<li><strong>${d.code}</strong> ${d.description}${d.primary ? html` <span class="pill">Primary</span>` : ""}</li>`)}</ul>`
    : muted("No active diagnoses were on the problem list when this plan was created.");
}

function measureBlock(o, { compact = false } = {}) {
  const m = o.measure;
  const inst = o.instrument && INSTRUMENTS[o.instrument];
  if (o.measure_type === "attainment") {
    return html`<div class="measure"><span class="small"><strong>Measure:</strong> yes/no attainment${o.measurement_method ? ` · ${o.measurement_method}` : ""}</span>
      <span class="small">${o.status === "met" ? html`<strong>Achieved</strong>` : "Not yet achieved"}</span></div>`;
  }
  const unit = o.unit ? ` ${o.unit}` : "";
  const curLabel = m.current === null || m.current === undefined ? "—" : fmtN(m.current);
  return html`
    <div class="measure">
      <div class="measure__nums">
        <span><small>Baseline</small><strong>${fmtN(o.baseline_value)}</strong></span>
        <span class="measure__arrow" aria-hidden="true">→</span>
        <span><small>Current</small><strong>${curLabel}</strong>${m.currentOn ? html`<small>${fmtDate(m.currentOn)}${m.source === "assessment" ? ` · ${inst ? inst.name : ""}` : " · review"}</small>` : ""}</span>
        <span class="measure__arrow" aria-hidden="true">→</span>
        <span><small>Target</small><strong>${fmtN(o.target_value)}</strong></span>
      </div>
      ${m.pct !== null ? html`
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.pct}" aria-label="Progress toward target for objective ${o.num}">
          <span style="width:${m.pct}%"></span></div>
        <span class="small"><strong>${m.pct}%</strong> of the way from baseline to target</span>` : html`<span class="small muted">Progress appears once baseline, current and target values are known.</span>`}
      ${compact ? "" : html`<span class="hint">${inst ? `${inst.name} (${inst.construct}, 0–${inst.max})` : MEASURE_LABEL[o.measure_type]}${unit ? ` ·${unit}` : ""}${o.direction ? ` · ${humanize(o.direction)}` : ""}${o.measurement_method ? ` · ${o.measurement_method}` : ""}</span>`}
    </div>`;
}

function vagueWarning(o) {
  const hit = VAGUE.some((re) => re.test(o.text || ""));
  const measured = o.measure_type !== "attainment" && o.baseline_value !== null && o.baseline_value !== undefined && o.target_value !== null && o.target_value !== undefined;
  if (hit && !measured) {
    return "This objective uses hard-to-measure wording (e.g. \"understand\", \"gain insight\", \"feel better\", \"be compliant\", \"learn coping skills\") without a numeric measure. Describe one observable behavior with a baseline and target.";
  }
  return null;
}

/** Edit / move / delete controls for a tree item (draft + unlocked only). */
function itemControls(req, plan, level, item, label) {
  const base = `/ehr/treatment-plans/${plan.id}/${level}/${item.id}`;
  return html`<span class="plan-actions no-print">
    <a class="btn btn--ghost btn--sm" href="${base}/edit" aria-label="Edit ${label}">Edit</a>
    <form method="post" action="${base}/move" class="inline-form">${csrfField(req)}<input type="hidden" name="dir" value="up">
      <button class="btn btn--ghost btn--sm" type="submit" aria-label="Move ${label} up" title="Move up">↑</button></form>
    <form method="post" action="${base}/move" class="inline-form">${csrfField(req)}<input type="hidden" name="dir" value="down">
      <button class="btn btn--ghost btn--sm" type="submit" aria-label="Move ${label} down" title="Move down">↓</button></form>
    <form method="post" action="${base}/delete" class="inline-form" data-confirm="Delete ${label}${level === "interventions" ? "" : " and everything under it"}?">${csrfField(req)}
      <button class="btn btn--ghost btn--sm btn--danger" type="submit" aria-label="Delete ${label}">Delete</button></form>
  </span>`;
}

function interventionItem(req, plan, iv, editable) {
  const who = iv.responsible_name ? `${iv.responsible_name}${iv.responsible_credentials ? `, ${iv.responsible_credentials}` : ""}` : iv.responsible_text;
  return html`<li class="plan-int">
    <div class="plan-int__main">
      <span class="pill">${KIND_LABEL[iv.kind] || humanize(iv.kind)}</span>
      ${iv.modality ? html`<strong>${iv.modality}</strong>` : ""}
      <span class="prewrap">${iv.description}</span>
    </div>
    <div class="plan-int__meta small muted">
      ${[iv.frequency, iv.duration].filter(Boolean).join(" · ") || "Frequency not set"}${who ? ` · Responsible: ${who}` : ""}
    </div>
    ${editable ? itemControls(req, plan, "interventions", iv, "this intervention") : ""}
  </li>`;
}

function objectiveBlock(req, plan, o, editable) {
  const warn = plan.status === "draft" ? vagueWarning(o) : null;
  const add = `/ehr/treatment-plans/${plan.id}/interventions/new?parent=${o.id}`;
  return html`
    <div class="plan-obj" id="obj-${o.id}">
      <div class="plan-obj__head">
        <span class="plan-num">Objective ${o.num}</span>
        ${tag(o.status)}
        ${o.target_date ? html`<span class="small muted">Target ${fmtDate(o.target_date)}</span>` : ""}
        <span class="spacer"></span>
        ${editable ? itemControls(req, plan, "objectives", o, `objective ${o.num}`) : ""}
      </div>
      <p class="plan-obj__text">${o.text}</p>
      ${measureBlock(o)}
      ${o.linked_strength ? html`<p class="small"><strong>Builds on strength:</strong> ${o.linked_strength}</p>` : ""}
      ${warn ? html`<p class="alert alert--warn small" role="status">${warn}</p>` : ""}
      <p class="small thread">${o.notes.n
        ? html`<strong>Addressed in ${o.notes.n} note${o.notes.n === 1 ? "" : "s"}</strong>, last on ${fmtDate(o.notes.last)}`
        : html`<span class="muted">Not yet addressed in a signed note</span>`}</p>
      <h4 class="plan-sub">Interventions</h4>
      ${o.interventions.length ? html`<ul class="list-plain plan-ints">${o.interventions.map((iv) => interventionItem(req, plan, iv, editable))}</ul>`
        : html`<p class="small ${plan.status === "draft" ? "error-text" : "muted"}">No interventions yet.</p>`}
      ${editable ? html`<a class="btn btn--sm no-print" href="${add}">+ Add intervention</a>` : ""}
    </div>`;
}

function problemCard(req, plan, p, editable) {
  const sud = isSud(plan);
  return html`
    <section class="card plan-problem" id="problem-${p.id}" aria-labelledby="ph-${p.id}">
      <div class="card__head">
        <div class="row">
          <h2 id="ph-${p.id}">Problem ${p.num}: ${p.title}</h2>
          ${p.status !== "active" ? tag(p.status) : ""}
          ${p.priority ? tag(p.priority, `${humanize(p.priority)} priority`) : ""}
          ${p.icd10_code ? html`<span class="pill">${p.icd10_code}</span>` : ""}
          ${sud && p.asam_dimension ? html`<span class="pill">ASAM D${p.asam_dimension}: ${ASAM_DIMS[p.asam_dimension]}</span>` : ""}
          ${sud && p.is_driver ? html`<span class="pill pill--warn">Dimensional driver</span>` : ""}
          ${sud && p.stage_of_change ? html`<span class="pill">Stage: ${humanize(p.stage_of_change)}</span>` : ""}
        </div>
        ${editable ? itemControls(req, plan, "problems", p, `problem ${p.num}`) : ""}
      </div>
      ${p.behavioral_definition ? html`<p><strong class="small muted">How it shows up:</strong> <span class="prewrap">${p.behavioral_definition}</span></p>` : ""}
      ${p.barriers ? html`<p class="small"><strong>Barriers:</strong> ${p.barriers}</p>` : ""}
      ${p.goals.length ? p.goals.map((g) => html`
        <div class="plan-goal" id="goal-${g.id}">
          <div class="plan-obj__head">
            <span class="plan-num">Goal ${g.num}</span><span class="spacer"></span>
            ${editable ? itemControls(req, plan, "goals", g, `goal ${g.num}`) : ""}
          </div>
          ${g.client_words ? html`<blockquote class="plan-quote">“${g.client_words}”</blockquote>` : (plan.status === "draft" ? html`<p class="small muted">Client's own words not recorded.</p>` : "")}
          <p class="plan-goal__text">${g.goal_text}</p>
          ${g.objectives.map((o) => objectiveBlock(req, plan, o, editable))}
          ${!g.objectives.length ? html`<p class="small ${plan.status === "draft" ? "error-text" : "muted"}">No objectives yet.</p>` : ""}
          ${editable ? html`<a class="btn btn--sm no-print" href="/ehr/treatment-plans/${plan.id}/objectives/new?parent=${g.id}">+ Add objective</a>` : ""}
        </div>`) : html`<p class="small ${plan.status === "draft" ? "error-text" : "muted"}">No goals yet.</p>`}
      ${editable ? html`<p class="no-print" style="margin-top:.75rem"><a class="btn btn--sm" href="/ehr/treatment-plans/${plan.id}/goals/new?parent=${p.id}">+ Add goal</a></p>` : ""}
    </section>`;
}

function signatureTable(sigs) {
  if (!sigs.length) return html`<p class="muted">No signatures yet.</p>`;
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Role</th><th>Signer</th><th>Method</th><th>Date</th><th>Notes</th></tr></thead>
    <tbody>${sigs.map((s) => html`<tr>
      <td>${humanize(s.role)}</td>
      <td>${signerLabel(s)}</td>
      <td>${s.declined ? html`<span class="badge badge--warn">Declined / unable</span>` : humanize(s.method || "")}</td>
      <td>${fmtTimestamp(s.signed_at)}</td>
      <td class="small">${s.declined ? `Reason: ${s.declined_reason}` : ""}${s.role === "client" ? `${s.declined ? " · " : ""}Copy offered: ${s.copy_offered ? "yes" : "no"}` : ""}</td>
    </tr>`)}</tbody></table></div>`;
}

function reviewsFor(db, planId) {
  return db.prepare(
    `SELECT r.*, u.name AS reviewer_name, u.credentials AS reviewer_credentials FROM plan_reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.plan_id = ? ORDER BY r.review_date DESC, r.id DESC`).all(planId);
}

function reviewTable(reviews) {
  if (!reviews.length) return html`<p class="muted">No reviews recorded for this version.</p>`;
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Date</th><th>Reviewer</th><th>Outcome</th><th>Level of care appropriate</th><th>Summary</th><th></th></tr></thead>
    <tbody>${reviews.map((r) => html`<tr>
      <td>${fmtDate(r.review_date)}</td><td>${r.reviewer_name}${r.reviewer_credentials ? `, ${r.reviewer_credentials}` : ""}</td>
      <td>${tag(r.outcome)}</td><td>${r.level_of_care_appropriate === null ? "—" : r.level_of_care_appropriate ? "Yes" : "No"}</td>
      <td class="small">${(r.summary || "").slice(0, 140)}${(r.summary || "").length > 140 ? "…" : ""}</td>
      <td><a href="/ehr/treatment-plans/${r.plan_id}/reviews/${r.id}">View</a></td></tr>`)}</tbody></table></div>`;
}

/* ================================================================== */
/* Plan tab                                                           */
/* ================================================================== */

function renderPlanTab(req, patient, opts = {}) {
  const db = req.db;
  const plans = db.prepare(
    `SELECT tp.*, u.name AS author_name, u.credentials AS author_credentials
     FROM treatment_plans tp JOIN users u ON u.id = tp.author_id
     WHERE tp.patient_id = ? ORDER BY tp.version DESC, tp.id DESC`).all(patient.id);
  const active = plans.find((p) => p.status === "active") || null;
  const draft = plans.find((p) => p.status === "draft") || null;
  const plan = opts.planId ? plans.find((p) => p.id === opts.planId) : (active || draft || plans[0] || null);
  const writable = can(req.user, "clinical:write");
  const base = `/ehr/patients/${patient.id}`;

  if (!plan) {
    return { plan: null, body: html`
      <div class="page-head"><h1>Treatment plan</h1>
        ${writable ? html`<a class="btn btn--primary" href="${base}/treatment-plan/new">New treatment plan</a>` : ""}</div>
      <div class="alert alert--warn" role="status"><strong>No active treatment plan.</strong> Payers expect a signed plan before ongoing therapy.</div>
      <div class="card"><p class="muted">No treatment plan on file.</p></div>` };
  }

  const tree = loadTree(db, plan);
  const isDraft = plan.status === "draft", isActive = plan.status === "active";
  const locked = isDraft && hasSignatures(db, plan.id);
  const editable = writable && isDraft && !locked;
  const sigs = signaturesFor(db, plan.id);
  const reviews = reviewsFor(db, plan.id);
  const pAct = `/ehr/treatment-plans/${plan.id}`;
  const sud = isSud(plan);
  const alerts = planAlerts(db, plan, tree);
  const check = isDraft ? activationCheck(db, plan, patient) : null;
  const safety = plan.safety_plan_note_id
    ? db.prepare("SELECT id, service_date, created_at FROM notes WHERE id = ? AND patient_id = ?").get(plan.safety_plan_note_id, patient.id) : null;

  const actions = html`
    <div class="row no-print">
      ${writable && isDraft ? html`
        ${editable ? html`<a class="btn" href="${pAct}/edit">Edit plan details</a>` : ""}
        <a class="btn btn--primary" href="${pAct}/sign">Signatures &amp; activation</a>
        ${editable ? html`<form method="post" action="${pAct}/discard" class="inline-form" data-confirm="Discard this draft? Its content will be deleted.">
          ${csrfField(req)}<button class="btn btn--ghost btn--danger" type="submit">Discard draft</button></form>` : ""}` : ""}
      ${writable && isActive ? html`
        <a class="btn btn--primary" href="${pAct}/review">Start review</a>
        ${draft ? html`<a class="btn" href="${planUrl(draft)}">Open draft revision (v${draft.version})</a>` : html`
          <form method="post" action="${pAct}/revise" class="inline-form" data-confirm="Start a new draft version copied from this plan? This plan stays active until the new version is signed.">
            ${csrfField(req)}<button class="btn" type="submit">Revise plan</button></form>`}
        <a class="btn btn--ghost" href="${pAct}/end">End plan</a>` : ""}
      ${writable && !active && !draft ? html`<a class="btn btn--primary" href="${base}/treatment-plan/new">New treatment plan</a>` : ""}
      <a class="btn btn--ghost" href="${pAct}/print">Print view</a>
    </div>`;

  const groupCard = (g) => {
    const any = g.fields.some(([k]) => plan[k]);
    if (!any && !isDraft) return "";
    return html`<section class="card"><h2>${g.title}</h2>
      ${g.fields.length === 1 && g.fields[0][0] === "client_vision"
        ? (plan.client_vision ? html`<blockquote class="plan-quote plan-quote--lg">“${plan.client_vision}”</blockquote>` : muted("Not recorded. Ask: \"What would you like your life to look like when treatment is done?\""))
        : html`<dl class="facts plan-facts">${g.fields.map(([k, label]) => html`<dt>${label}</dt><dd>${textOr(plan[k])}</dd>`)}</dl>`}
    </section>`;
  };

  const body = html`
    <div class="page-head">
      <div><h1>Treatment plan <span class="muted">v${plan.version}</span> ${tag(plan.status)}</h1>
        <p>${PLAN_TYPE_LABEL[plan.plan_type] || humanize(plan.plan_type)} · Author ${plan.author_name}${plan.author_credentials ? `, ${plan.author_credentials}` : ""}</p></div>
      ${actions}
    </div>
    ${errorList(opts.errors)}
    ${!active ? html`<div class="alert alert--warn" role="status"><strong>No active treatment plan.</strong> Payers expect a signed plan before ongoing therapy.</div>` : ""}
    ${!isDraft && !isActive
      ? html`<div class="alert alert--info" role="status">You are viewing version ${plan.version} (${humanize(plan.status)}), read-only.${active || draft ? html` <a href="${base}/treatment-plan">View the current plan</a>` : ""}</div>` : ""}
    ${isActive && draft ? html`<div class="alert alert--warn" role="status"><strong>Unsigned draft revision in progress.</strong> Version ${draft.version} isn't in effect until it's signed and activated. <a href="${planUrl(draft)}">Open draft</a></div>` : ""}
    ${isDraft ? html`<div class="alert alert--warn" role="status"><strong>Draft, not in effect.</strong>
      ${check.errors.length ? html` Before activation: ${check.errors.join(" ")}` : " Ready to activate."}
      ${locked ? html`<br>Signatures have been collected, so the content is locked. To edit, clear the signatures on the <a href="${pAct}/sign">signing page</a>.` : ""}</div>` : ""}
    ${alerts.map((a) => html`<div class="alert alert--${a.tone}" role="${a.tone === "error" ? "alert" : "status"}"><strong>${a.strong}</strong> ${a.text}</div>`)}
    ${sud ? html`<div class="alert alert--info part2" role="note">${PART2_NOTICE}</div>` : ""}

    <div class="grid grid--2">
      <section class="card" aria-labelledby="pl-overview">
        <h2 id="pl-overview">Overview</h2>
        <dl class="facts">
          <dt>Plan type</dt><dd>${PLAN_TYPE_LABEL[plan.plan_type] || humanize(plan.plan_type)}</dd>
          <dt>Status</dt><dd>${tag(plan.status)}${plan.status === "superseded" || plan.status === "completed" ? html` <span class="small muted">${fmtDate(plan.ended_at)} · ${endReasonLabel(plan.end_reason)}</span>` : ""}</dd>
          <dt>Start date</dt><dd>${plan.start_date ? fmtDate(plan.start_date) : muted(isDraft ? "Set on activation" : "Not set")}</dd>
          <dt>Activated</dt><dd>${plan.activated_at ? fmtTimestamp(plan.activated_at) : muted("Not yet")}</dd>
          <dt>Review interval</dt><dd>Every ${plan.review_interval_days} days</dd>
          <dt>Next review</dt><dd>${plan.review_date && !isDraft ? fmtDate(plan.review_date) : muted(isDraft ? "Set on activation" : "—")}
            ${isActive && plan.review_date && plan.review_date < today() ? html` <span class="pill pill--bad">Overdue</span>` : ""}</dd>
          <dt>Safety plan</dt><dd>${safety ? html`<a href="/ehr/notes/${safety.id}">Crisis safety plan (${fmtDate(safety.service_date || safety.created_at)})</a>` : muted("None linked")}</dd>
        </dl>
      </section>
      <section class="card" aria-labelledby="pl-dx">
        <div class="card__head"><h2 id="pl-dx">Diagnoses (snapshot)</h2>
          ${editable ? html`<form method="post" action="${pAct}/diagnoses" class="inline-form no-print">${csrfField(req)}
            <button class="btn btn--sm" type="submit">Refresh from problem list</button></form>` : ""}</div>
        ${dxList(plan)}
        <p class="hint">Captured from the active problem list when the plan was created; it doesn't change when the problem list does.</p>
      </section>
    </div>

    ${groupCard(HEADER_GROUPS[0])}
    <div class="grid grid--2">${HEADER_GROUPS.slice(1, 5).map(groupCard)}</div>

    ${sud ? html`<section class="card" aria-labelledby="pl-sud"><h2 id="pl-sud">Substance use treatment (ASAM)</h2>
      <dl class="facts plan-facts">
        <dt>Level of care indicated</dt><dd>${plan.loc_indicated ? ASAM_LEVEL_LABEL[plan.loc_indicated] || plan.loc_indicated : muted()}</dd>
        <dt>Level of care provided</dt><dd>${plan.loc_adjusted ? ASAM_LEVEL_LABEL[plan.loc_adjusted] || plan.loc_adjusted : muted()}</dd>
        ${SUD_FIELDS.map(([k, label]) => html`<dt>${label}</dt><dd>${textOr(plan[k])}</dd>`)}
      </dl></section>` : ""}

    <div class="page-head plan-tree-head">
      <h2>Problems, goals, objectives and interventions</h2>
      ${editable ? html`<a class="btn btn--primary btn--sm no-print" href="${pAct}/problems/new">+ Add problem</a>` : ""}
    </div>
    ${tree.problems.length ? tree.problems.map((p) => problemCard(req, plan, p, editable))
      : html`<div class="card"><p class="muted">No problems yet.${editable ? " Start by adding the client's first problem or need." : ""}</p></div>`}

    ${groupCard(HEADER_GROUPS[5])}

    <section class="card" aria-labelledby="pl-sigs">
      <div class="card__head"><h2 id="pl-sigs">Signatures</h2>
        ${writable && isDraft ? html`<a class="btn btn--sm no-print" href="${pAct}/sign">Collect signatures</a>` : ""}</div>
      ${signatureTable(sigs)}
    </section>

    <section class="card" aria-labelledby="pl-reviews">
      <div class="card__head"><h2 id="pl-reviews">Review history</h2>
        ${writable && isActive ? html`<a class="btn btn--sm no-print" href="${pAct}/review">Start review</a>` : ""}</div>
      ${reviewTable(reviews)}
    </section>

    <section class="card" aria-labelledby="pl-history">
      <h2 id="pl-history">Version history</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Version</th><th>Status</th><th>Type</th><th>Created</th><th>Activated</th><th>Ended</th><th>Author</th><th></th></tr></thead>
        <tbody>${plans.map((p) => html`<tr>
          <td>v${p.version}${p.id === plan.id ? html` <span class="pill">Viewing</span>` : ""}</td><td>${tag(p.status)}</td>
          <td>${PLAN_TYPE_LABEL[p.plan_type] || humanize(p.plan_type)}</td>
          <td>${fmtTimestamp(p.created_at)}</td><td>${p.activated_at ? fmtTimestamp(p.activated_at) : "—"}</td>
          <td>${p.ended_at ? `${fmtDate(p.ended_at)} · ${endReasonLabel(p.end_reason)}` : "—"}</td><td>${p.author_name}</td>
          <td><a href="${planUrl(p)}">View</a> · <a href="/ehr/treatment-plans/${p.id}/print">Print</a></td></tr>`)}</tbody>
      </table></div>
    </section>`;
  return { plan, body };
}

router.get("/patients/:id/treatment-plan", READ, (req, res) => {
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  let planId = null;
  if (req.query.plan !== undefined) {
    planId = intId(req.query.plan);
    const ok = planId !== null && req.db.prepare("SELECT 1 FROM treatment_plans WHERE id = ? AND patient_id = ?").get(planId, patient.id);
    if (!ok) return notFound(req, res, "Treatment plan");
  }
  const { plan, body } = renderPlanTab(req, patient, { planId });
  audit(req, "view", "treatment_plan", plan ? plan.id : null, patient.id);
  res.send(chartPage(req, patient, "plan", body, { title: "Treatment plan" }));
});

/* ================================================================== */
/* New draft                                                          */
/* ================================================================== */

function suggestType(db, patientId) {
  const codes = db.prepare("SELECT icd10_code FROM diagnoses WHERE patient_id = ? AND status = 'active'").all(patientId).map((d) => d.icd10_code);
  const sud = codes.filter((c) => /^F1\d/.test(c)).length;
  return sud ? (sud === codes.length ? "sud" : "co_occurring") : "mental_health";
}

function newPlanPage(req, patient, { values, errors = [], active }) {
  const dx = JSON.parse(snapshotDiagnoses(req.db, patient.id));
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><h1>New treatment plan</h1></div>
    ${errorList(errors)}
    <form method="post" action="/ehr/patients/${patient.id}/treatment-plan" class="card stack">
      ${csrfField(req)}
      ${active ? html`<fieldset><legend>Start from</legend>
        <label class="check"><input type="radio" name="copy_from_active" value="1" ${checked(values.copy_from_active !== "0")}>
          Copy the active plan (version ${active.version}): all problems, goals, objectives, interventions and plan details. Recommended for a revision.</label>
        <label class="check"><input type="radio" name="copy_from_active" value="0" ${checked(values.copy_from_active === "0")}> Start a blank plan</label>
      </fieldset>` : ""}
      <div class="form-grid">
        <label for="plan_type">Plan type ${select("plan_type", PLAN_TYPES, values.plan_type)}
          <span class="hint">SUD and co-occurring plans add ASAM level-of-care, MOUD, drug-testing and relapse-prevention sections.</span></label>
        <label for="review_interval_days">Review every (days)
          <input type="number" id="review_interval_days" name="review_interval_days" min="7" max="365" value="${values.review_interval_days}" required>
          <span class="hint">Default 90. Some programs require 30 (e.g. state SUD rules). Ignored when copying the active plan.</span></label>
      </div>
      <div><h3>Diagnoses to snapshot</h3>
        ${dx.length ? html`<ul class="list">${dx.map((d) => html`<li><strong>${d.code}</strong> ${d.description}${d.primary ? " (primary)" : ""}</li>`)}</ul>`
          : html`<p class="muted">This patient has no active diagnoses. Add diagnoses on the Overview tab first so the plan can be linked to them.</p>`}
      </div>
      <p class="hint">The plan is saved as a draft. Add problems, goals, objectives and interventions, collect signatures, then activate it.</p>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Create draft</button>
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/treatment-plan">Cancel</a>
      </div>
    </form>`, { title: "New treatment plan" });
}

router.get("/patients/:id/treatment-plan/new", WRITE, (req, res) => {
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const draft = draftPlanFor(req.db, patient.id);
  if (draft) {
    req.flash("info", "This patient already has a draft plan. Continue editing it below.");
    return res.redirect(planUrl(draft));
  }
  const active = activePlanFor(req.db, patient.id);
  res.send(newPlanPage(req, patient, { values: { plan_type: active ? active.plan_type : suggestType(req.db, patient.id), review_interval_days: active ? active.review_interval_days : 90 }, active }));
});

router.post("/patients/:id/treatment-plan", WRITE, (req, res) => {
  const db = req.db;
  const patient = getPatient(req, req.params.id);
  if (!patient) return notFound(req, res, "Patient");
  const existing = draftPlanFor(db, patient.id);
  if (existing) {
    req.flash("info", "This patient already has a draft plan. Continue editing it below.");
    return res.redirect(planUrl(existing));
  }
  const active = activePlanFor(db, patient.id);
  const copy = !!active && req.body.copy_from_active !== "0";
  const values = { plan_type: str(req.body.plan_type, 20) || "mental_health", review_interval_days: str(req.body.review_interval_days, 4) || "90", copy_from_active: copy ? "1" : "0" };
  const errors = [];
  if (!PLAN_TYPES.some((p) => p.value === values.plan_type)) errors.push("Choose a valid plan type.");
  const iv = /^\d+$/.test(values.review_interval_days) ? Number(values.review_interval_days) : NaN;
  if (!copy && !(iv >= 7 && iv <= 365)) errors.push("Review interval must be a whole number of days between 7 and 365.");
  if (errors.length) return res.status(400).send(newPlanPage(req, patient, { values, errors, active }));
  const planId = tx(db, () => {
    if (copy) {
      const id = copyPlan(db, active, req.user.id);
      if (values.plan_type !== active.plan_type) db.prepare("UPDATE treatment_plans SET plan_type = ? WHERE id = ?").run(values.plan_type, id);
      return id;
    }
    const version = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM treatment_plans WHERE patient_id = ?").get(patient.id).v;
    return Number(db.prepare(
      `INSERT INTO treatment_plans (patient_id, author_id, status, version, supersedes_id, plan_type, review_interval_days, diagnoses)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`).run(patient.id, req.user.id, version, active ? active.id : null, values.plan_type, iv,
      snapshotDiagnoses(db, patient.id)).lastInsertRowid);
  });
  audit(req, "create", "treatment_plan", planId, patient.id, copy ? `draft created as revision of plan ${active.id}` : "draft created");
  req.flash("success", copy ? "Draft revision created from the active plan." : "Draft treatment plan created.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${planId}`);
});

/* ================================================================== */
/* Draft guards                                                       */
/* ================================================================== */

/** Returns true if the plan may be edited; otherwise sends 409 and returns false. */
function editableOr409(req, res, found) {
  const { plan, patient } = found;
  if (plan.status !== "draft") {
    conflict(req, res, patient, "Signed plans can't be changed. Use \"Revise plan\" to start a new draft version.", plan.id);
    return false;
  }
  if (hasSignatures(req.db, plan.id)) {
    conflict(req, res, patient, "This draft has signatures, which lock its content. Clear the signatures on the signing page to edit it (they'll need to be collected again).", plan.id);
    return false;
  }
  return true;
}

/* ================================================================== */
/* Header fields                                                      */
/* ================================================================== */

function safetyNotes(db, patientId) {
  return db.prepare(`SELECT id, service_date, created_at, status FROM notes WHERE patient_id = ? AND type = 'safety_plan' ORDER BY created_at DESC`).all(patientId);
}

function headerForm(req, found, { values, errors = [] }) {
  const { plan, patient } = found;
  const notes = safetyNotes(req.db, patient.id);
  const field = ([k, label, rows]) => rows
    ? html`<label class="span-all" for="${k}">${label} ${ta(k, values[k], rows)}</label>`
    : html`<label for="${k}">${label} <input id="${k}" name="${k}" value="${values[k] || ""}" maxlength="200"></label>`;
  const lvlOpts = [{ value: "", label: "Not set" }, ...ASAM_LEVELS.map(([k]) => ({ value: k, label: ASAM_LEVEL_LABEL[k] }))];
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><h1>Edit plan details <span class="muted">v${plan.version}</span></h1>
      <a class="btn btn--ghost" href="${planUrl(plan)}">Back to plan</a></div>
    ${errorList(errors)}
    <form method="post" action="/ehr/treatment-plans/${plan.id}/edit" class="stack" data-dirty-check>
      ${csrfField(req)}
      <section class="card"><h2>Plan</h2><div class="form-grid">
        <label for="plan_type">Plan type ${select("plan_type", PLAN_TYPES, values.plan_type)}</label>
        <label for="start_date">Start date <input type="date" id="start_date" name="start_date" value="${values.start_date || ""}">
          <span class="hint">Optional. Defaults to the activation date.</span></label>
        <label for="review_interval_days">Review every (days) <input type="number" id="review_interval_days" name="review_interval_days" min="7" max="365" value="${values.review_interval_days}" required>
          <span class="hint">Next review = activation date + interval.</span></label>
        <label for="safety_plan_note_id">Crisis safety plan
          ${select("safety_plan_note_id", [{ value: "", label: notes.length ? "None linked" : "No safety plan notes on file" },
            ...notes.map((n) => ({ value: n.id, label: `Safety plan ${fmtDate(n.service_date || n.created_at)} (${n.status})` }))], values.safety_plan_note_id)}
          <span class="hint">Link one when risk is identified (CARF 2.C.4).</span></label>
      </div></section>
      ${HEADER_GROUPS.map((g) => html`<section class="card"><h2>${g.title}</h2><div class="form-grid">${g.fields.map(field)}</div>
        ${g.title === "Client's voice" ? html`<p class="hint">Write it the way the client said it, in quotation-ready words.</p>` : ""}</section>`)}
      <section class="card"><h2>Substance use treatment (ASAM) <span class="muted small">SUD and co-occurring plans only</span></h2>
        <div class="form-grid">
          <label for="loc_indicated">Level of care indicated ${select("loc_indicated", lvlOpts, values.loc_indicated)}</label>
          <label for="loc_adjusted">Level of care provided ${select("loc_adjusted", lvlOpts, values.loc_adjusted)}
            <span class="hint">If different from indicated, give the reason below.</span></label>
          ${SUD_FIELDS.map(field)}
        </div>
        <p class="hint">ASAM Criteria 4th edition levels; verify names against the licensed ASAM text.</p>
      </section>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Save plan details</button>
        <a class="btn btn--ghost" href="${planUrl(plan)}">Cancel</a>
      </div>
    </form>`, { title: "Edit treatment plan" });
}

function validateHeader(db, plan, body) {
  const v = {}, errors = [];
  for (const [k, , rows] of TEXT_FIELDS) v[k] = str(body[k], rows ? 5000 : 200) || null;
  v.plan_type = str(body.plan_type, 20);
  if (!PLAN_TYPES.some((p) => p.value === v.plan_type)) errors.push("Choose a valid plan type.");
  v.start_date = str(body.start_date, 10) || null;
  if (v.start_date && !isDate(v.start_date)) errors.push("Start date must be a valid date.");
  const iv = str(body.review_interval_days, 4);
  v.review_interval_days = /^\d+$/.test(iv) ? Number(iv) : NaN;
  if (!(v.review_interval_days >= 7 && v.review_interval_days <= 365)) { errors.push("Review interval must be a whole number of days between 7 and 365."); v.review_interval_days = iv; }
  for (const k of ["loc_indicated", "loc_adjusted"]) {
    v[k] = str(body[k], 5) || null;
    if (v[k] && !ASAM_LEVEL_LABEL[v[k]]) errors.push("Choose a valid ASAM level of care.");
  }
  if (v.loc_indicated && v.loc_adjusted && v.loc_indicated !== v.loc_adjusted && !v.loc_reason) {
    errors.push("Explain why the level of care provided differs from the level indicated.");
  }
  const sp = str(body.safety_plan_note_id, 12);
  v.safety_plan_note_id = null;
  if (sp) {
    const id = intId(sp);
    const n = id === null ? null : db.prepare("SELECT id FROM notes WHERE id = ? AND patient_id = ? AND type = 'safety_plan'").get(id, plan.patient_id);
    if (!n) errors.push("Choose a safety plan note that belongs to this patient.");
    else v.safety_plan_note_id = n.id;
  }
  return { v, errors };
}

router.get("/treatment-plans/:planId/edit", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (!editableOr409(req, res, found)) return;
  audit(req, "view", "treatment_plan", found.plan.id, found.patient.id, "edit form");
  res.send(headerForm(req, found, { values: found.plan }));
});

router.post("/treatment-plans/:planId/edit", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (!editableOr409(req, res, found)) return;
  const { plan, patient } = found;
  const { v, errors } = validateHeader(req.db, plan, req.body);
  if (errors.length) return res.status(400).send(headerForm(req, found, { values: v, errors }));
  const cols = ["plan_type", "start_date", "review_interval_days", "safety_plan_note_id", "loc_indicated", "loc_adjusted", ...TEXT_FIELDS.map(([k]) => k)];
  req.db.prepare(`UPDATE treatment_plans SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...cols.map((c) => v[c]), plan.id);
  audit(req, "update", "treatment_plan", plan.id, patient.id, "plan details updated");
  req.flash("success", "Plan details saved.");
  res.redirect(planUrl(plan));
});

router.post("/treatment-plans/:planId/diagnoses", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (!editableOr409(req, res, found)) return;
  const { plan, patient } = found;
  req.db.prepare("UPDATE treatment_plans SET diagnoses = ?, updated_at = datetime('now') WHERE id = ?").run(snapshotDiagnoses(req.db, patient.id), plan.id);
  audit(req, "update", "treatment_plan", plan.id, patient.id, "diagnoses snapshot refreshed");
  req.flash("success", "Diagnoses refreshed from the active problem list.");
  res.redirect(planUrl(plan));
});

router.post("/treatment-plans/:planId/discard", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (!editableOr409(req, res, found)) return;
  const { plan, patient } = found;
  req.db.prepare("DELETE FROM treatment_plans WHERE id = ? AND status = 'draft'").run(plan.id);
  audit(req, "delete", "treatment_plan", plan.id, patient.id, "draft discarded");
  req.flash("success", "Draft discarded.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan`);
});

/* ================================================================== */
/* Tree items                                                         */
/* ================================================================== */

/** Parse an optional number field: '' -> null, invalid -> NaN. */
function num(v) {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const LEVELS = {
  problems: {
    table: "plan_problems", parentCol: "plan_id", parentLevel: null, noun: "problem",
    cols: ["title", "behavioral_definition", "icd10_code", "asam_dimension", "is_driver", "stage_of_change", "priority", "barriers", "status"],
    ownerSql: "SELECT plan_id FROM plan_problems WHERE id = ?",
    form(ctx, v) {
      const dx = planDx(ctx.plan);
      const sud = isSud(ctx.plan);
      return html`<div class="form-grid">
        <label class="span-all" for="title">Problem / need <input id="title" name="title" value="${v.title || ""}" maxlength="200" required>
          <span class="hint">Short name, e.g. "Depressed mood", "Alcohol use", "Housing instability".</span></label>
        <label class="span-all" for="behavioral_definition">How it shows up for this client ${ta("behavioral_definition", v.behavioral_definition, 3)}
          <span class="hint">Frequency, duration and functional impact, e.g. "Low mood most days for 3 months; missed 4 work days last month."</span></label>
        <label for="icd10_code">Linked diagnosis ${select("icd10_code", [{ value: "", label: dx.length ? "None" : "No diagnoses in snapshot" },
          ...dx.map((d) => ({ value: d.code, label: `${d.code} ${d.description}` }))], v.icd10_code)}</label>
        <label for="priority">Priority ${select("priority", [{ value: "", label: "Not set" }, ...PRIORITIES], v.priority)}</label>
        <label for="status">Status ${select("status", PROBLEM_STATUSES, v.status || "active")}</label>
        ${sud ? html`
          <label for="asam_dimension">ASAM dimension ${select("asam_dimension", [{ value: "", label: "Not set" },
            ...Object.entries(ASAM_DIMS).map(([k, l]) => ({ value: k, label: `${k}. ${l}` }))], v.asam_dimension)}</label>
          <label for="stage_of_change">Stage of change ${select("stage_of_change", [{ value: "", label: "Not set" }, ...STAGES], v.stage_of_change)}</label>
          <label class="check"><input type="checkbox" name="is_driver" value="1" ${checked(Number(v.is_driver) === 1)}> Dimensional driver of the level of care</label>` : ""}
        <label class="span-all" for="barriers">Barriers for this problem ${ta("barriers", v.barriers, 2)}</label>
      </div>`;
    },
    validate(ctx, b) {
      const v = {
        title: str(b.title, 200), behavioral_definition: str(b.behavioral_definition, 2000) || null, icd10_code: str(b.icd10_code, 10) || null,
        asam_dimension: str(b.asam_dimension, 1) || null, is_driver: b.is_driver === "1" ? 1 : 0, stage_of_change: str(b.stage_of_change, 20) || null,
        priority: str(b.priority, 10) || null, barriers: str(b.barriers, 2000) || null, status: str(b.status, 10) || "active",
      };
      const errors = [], warnings = [];
      if (!v.title) errors.push("Problem title is required.");
      if (v.icd10_code && !planDx(ctx.plan).some((d) => d.code === v.icd10_code)) errors.push("Linked diagnosis must be one of the plan's diagnoses.");
      if (v.asam_dimension !== null) { if (!/^[1-6]$/.test(v.asam_dimension)) errors.push("ASAM dimension must be 1 to 6."); else v.asam_dimension = Number(v.asam_dimension); }
      if (v.stage_of_change && !STAGES.includes(v.stage_of_change)) errors.push("Choose a valid stage of change.");
      if (v.priority && !PRIORITIES.includes(v.priority)) errors.push("Choose a valid priority.");
      if (!PROBLEM_STATUSES.includes(v.status)) errors.push("Choose a valid problem status.");
      if (!isSud(ctx.plan)) { v.asam_dimension = null; v.is_driver = 0; v.stage_of_change = null; }
      if (!v.behavioral_definition && v.title) warnings.push("Describe how the problem shows up for this client (frequency, duration, functional impact).");
      return { v, errors, warnings };
    },
  },
  goals: {
    table: "plan_goals", parentCol: "problem_id", parentLevel: "problems", noun: "goal",
    cols: ["client_words", "goal_text"],
    ownerSql: "SELECT p.plan_id FROM plan_goals g JOIN plan_problems p ON p.id = g.problem_id WHERE g.id = ?",
    form(ctx, v) {
      return html`<div class="form-grid">
        <label class="span-all" for="client_words">In the client's own words ${ta("client_words", v.client_words, 2)}
          <span class="hint">Verbatim, e.g. "I want to get back to coaching my kid's soccer team."</span></label>
        <label class="span-all" for="goal_text">Long-term goal (clinical restatement) ${ta("goal_text", v.goal_text, 2, 'required maxlength="1000"')}
          <span class="hint">Phrase it positively, as something to move toward.</span></label>
      </div>`;
    },
    validate(ctx, b) {
      const v = { client_words: str(b.client_words, 1000) || null, goal_text: str(b.goal_text, 1000) };
      const errors = [], warnings = [];
      if (!v.goal_text) errors.push("Goal is required.");
      if (!v.client_words) warnings.push("Record the goal in the client's own words too (CARF 2.C.2).");
      if (/^\s*(stop|no longer|not |never|eliminate|avoid)/i.test(v.goal_text)) warnings.push("Goals work best phrased positively, as something to move toward.");
      return { v, errors, warnings };
    },
  },
  objectives: {
    table: "plan_objectives", parentCol: "goal_id", parentLevel: "goals", noun: "objective",
    cols: ["text", "measure_type", "instrument", "baseline_value", "target_value", "direction", "unit", "measurement_method", "target_date", "linked_strength", "status"],
    ownerSql: `SELECT p.plan_id FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id WHERE o.id = ?`,
    form(ctx, v) {
      const latest = ctx.latest;
      const instOpts = [{ value: "", label: "Not instrument-based" }, ...TRACKABLE.map((d) => ({
        value: d.key, label: `${d.name} (${d.construct}, 0–${d.max})${latest[d.key] ? ` · latest ${latest[d.key].total_score} on ${fmtDate(latest[d.key].administered_on)}` : ""}` }))];
      const quick = TRACKABLE.filter((d) => latest[d.key]);
      return html`
        ${ctx.isNew && quick.length ? html`<div class="card card--muted"><p class="small"><strong>Start from a measure:</strong> pre-fills the instrument and baseline from the latest score.</p>
          <div class="row">${quick.map((d) => html`<a class="btn btn--sm" href="?parent=${ctx.parentId}&amp;instrument=${d.key}">${d.name}: ${latest[d.key].total_score}</a>`)}</div></div>` : ""}
        <div class="form-grid">
        <label class="span-all" for="text">Objective (one observable behavior) ${ta("text", v.text, 2, 'required maxlength="1000"')}
          <span class="hint">SMART: specific, measurable, achievable, relevant, time-bound. e.g. "Complete 3 planned pleasant activities per week, tracked on an activity log."</span></label>
        <label for="measure_type">Measure type ${select("measure_type", MEASURE_TYPES, v.measure_type || "attainment")}</label>
        <label for="instrument">Instrument <select name="instrument" id="instrument" data-prefill-baseline="baseline_value">${instOpts.map((o) => html`
            <option value="${o.value}" ${String(o.value) === String(v.instrument || "") ? raw("selected") : ""} ${o.value && latest[o.value] ? raw(`data-latest="${Number(latest[o.value].total_score)}"`) : ""}>${o.label}</option>`)}</select>
          <span class="hint">For instrument objectives the current value updates automatically from new scores.</span></label>
        <label for="direction">Direction ${select("direction", [{ value: "", label: "Infer from baseline and target" }, ...DIRECTIONS], v.direction)}</label>
        <label for="baseline_value">Baseline <input id="baseline_value" name="baseline_value" inputmode="decimal" value="${v.baseline_value ?? ""}">
          <span class="hint">Left blank on an instrument objective, the latest score is used.</span></label>
        <label for="target_value">Target <input id="target_value" name="target_value" inputmode="decimal" value="${v.target_value ?? ""}"></label>
        <label for="unit">Unit <input id="unit" name="unit" value="${v.unit || ""}" maxlength="60" placeholder="e.g. points, times per week"></label>
        <label for="target_date">Target date <input type="date" id="target_date" name="target_date" value="${v.target_date || ""}" required></label>
        <label for="status">Status ${select("status", OBJ_STATUSES, v.status || "not_started")}</label>
        <label class="span-all" for="measurement_method">How and how often it's measured <input id="measurement_method" name="measurement_method" value="${v.measurement_method || ""}" maxlength="500" placeholder="e.g. PHQ-9 every 2 weeks in session; self-report log reviewed weekly"></label>
        <label class="span-all" for="linked_strength">Builds on strength (optional) <input id="linked_strength" name="linked_strength" value="${v.linked_strength || ""}" maxlength="500"></label>
      </div>`;
    },
    validate(ctx, b) {
      const v = {
        text: str(b.text, 1000), measure_type: str(b.measure_type, 20) || "attainment", instrument: str(b.instrument, 10) || null,
        baseline_value: num(b.baseline_value), target_value: num(b.target_value), direction: str(b.direction, 10) || null,
        unit: str(b.unit, 60) || null, measurement_method: str(b.measurement_method, 500) || null, target_date: str(b.target_date, 10) || null,
        linked_strength: str(b.linked_strength, 500) || null, status: str(b.status, 20) || "not_started",
      };
      const errors = [], warnings = [];
      if (!v.text) errors.push("Objective text is required.");
      if (!MEASURE_TYPES.some((m) => m.value === v.measure_type)) errors.push("Choose a valid measure type.");
      if (Number.isNaN(v.baseline_value)) { errors.push("Baseline must be a number."); }
      if (Number.isNaN(v.target_value)) { errors.push("Target must be a number."); }
      let def = null;
      if (v.measure_type === "instrument") {
        def = v.instrument && INSTRUMENTS[v.instrument];
        if (!def || !TRACKABLE.includes(def)) errors.push("Choose the instrument for an instrument-based objective.");
        else {
          if (v.baseline_value === null && ctx.latest[def.key]) {
            v.baseline_value = ctx.latest[def.key].total_score;
            warnings.push(`Baseline set from the latest ${def.name} score (${v.baseline_value} on ${fmtDate(ctx.latest[def.key].administered_on)}).`);
          }
          for (const k of ["baseline_value", "target_value"]) {
            if (typeof v[k] === "number" && !Number.isNaN(v[k]) && (v[k] < 0 || v[k] > def.max)) errors.push(`${k === "baseline_value" ? "Baseline" : "Target"} must be between 0 and ${def.max} for ${def.name}.`);
          }
          if (!v.unit) v.unit = "points";
        }
      } else v.instrument = null;
      if (v.measure_type !== "attainment") {
        if (v.baseline_value === null) errors.push("Baseline is required for a measured objective.");
        if (v.target_value === null) errors.push("Target is required for a measured objective.");
      }
      if (v.direction && !DIRECTIONS.some((d) => d.value === v.direction)) errors.push("Choose a valid direction.");
      const numeric = typeof v.baseline_value === "number" && typeof v.target_value === "number" && !Number.isNaN(v.baseline_value) && !Number.isNaN(v.target_value);
      if (v.measure_type === "attainment") v.direction = v.direction || "achieve";
      else if (numeric) {
        if (!v.direction || v.direction === "achieve") v.direction = v.target_value < v.baseline_value ? "decrease" : "increase";
        if (v.target_value === v.baseline_value) errors.push("Target must differ from baseline.");
        else if (v.direction === "decrease" && v.target_value > v.baseline_value) errors.push("For a decrease, the target must be lower than the baseline.");
        else if (v.direction === "increase" && v.target_value < v.baseline_value) errors.push("For an increase, the target must be higher than the baseline.");
      }
      if (!v.target_date) errors.push("Target date is required (objectives are time-bound).");
      else if (!isDate(v.target_date)) errors.push("Target date must be a valid date.");
      else if (v.target_date < today()) warnings.push("The target date is in the past.");
      if (!OBJ_STATUSES.includes(v.status)) errors.push("Choose a valid objective status.");
      if (!errors.length) { const w = vagueWarning(v); if (w) warnings.push(w); }
      if (Number.isNaN(v.baseline_value)) v.baseline_value = b.baseline_value;
      if (Number.isNaN(v.target_value)) v.target_value = b.target_value;
      return { v, errors, warnings };
    },
  },
  interventions: {
    table: "plan_interventions", parentCol: "objective_id", parentLevel: "objectives", noun: "intervention",
    cols: ["kind", "modality", "description", "frequency", "duration", "responsible_user_id", "responsible_text"],
    ownerSql: `SELECT p.plan_id FROM plan_interventions i JOIN plan_objectives o ON o.id = i.objective_id JOIN plan_goals g ON g.id = o.goal_id
      JOIN plan_problems p ON p.id = g.problem_id WHERE i.id = ?`,
    form(ctx, v) {
      return html`<div class="form-grid">
        <label for="kind">Kind ${select("kind", INTERVENTION_KINDS, v.kind || "professional")}</label>
        <label for="modality">Modality / evidence-based practice <input id="modality" name="modality" list="modalities" value="${v.modality || ""}" maxlength="100">
          <datalist id="modalities">${MODALITIES.map((m) => html`<option value="${m}"></option>`)}</datalist></label>
        <label class="span-all" for="description">Specific technique or action, and its purpose ${ta("description", v.description, 2, 'required maxlength="2000"')}
          <span class="hint">e.g. "Activity scheduling and monitoring to rebuild routine and increase positive reinforcement."</span></label>
        <label for="frequency">Frequency <input id="frequency" name="frequency" value="${v.frequency || ""}" maxlength="100" placeholder="e.g. Weekly, 53 min"></label>
        <label for="duration">Duration <input id="duration" name="duration" value="${v.duration || ""}" maxlength="100" placeholder="e.g. 12 weeks"></label>
        <label for="responsible_user_id">Responsible staff member ${select("responsible_user_id", [{ value: "", label: "Not a staff member" },
          ...ctx.staff.map((s) => ({ value: s.id, label: `${s.name}${s.credentials ? `, ${s.credentials}` : ""}` }))], v.responsible_user_id)}</label>
        <label for="responsible_text">…or responsible person (not staff) <input id="responsible_text" name="responsible_text" value="${v.responsible_text || ""}" maxlength="200" placeholder="e.g. Client; partner; peer mentor"></label>
      </div>`;
    },
    validate(ctx, b) {
      const v = {
        kind: str(b.kind, 20) || "professional", modality: str(b.modality, 100) || null, description: str(b.description, 2000),
        frequency: str(b.frequency, 100) || null, duration: str(b.duration, 100) || null,
        responsible_user_id: str(b.responsible_user_id, 12) || null, responsible_text: str(b.responsible_text, 200) || null,
      };
      const errors = [], warnings = [];
      if (!INTERVENTION_KINDS.some((k) => k.value === v.kind)) errors.push("Choose a valid intervention kind.");
      if (!v.description) errors.push("Describe the intervention.");
      if (v.responsible_user_id !== null) {
        const id = intId(v.responsible_user_id);
        if (id === null || !ctx.staff.some((s) => s.id === id)) errors.push("Responsible staff member must be an active clinician or administrator.");
        else v.responsible_user_id = id;
      }
      if (!v.responsible_user_id && !v.responsible_text) errors.push("Name who is responsible: a staff member, or the client, family member or peer.");
      if (v.kind === "professional" && !v.frequency) warnings.push("Add a frequency (e.g. weekly, 53 min); payers expect amount and frequency of services.");
      return { v, errors, warnings };
    },
  },
};

function itemCtx(req, found, extra = {}) {
  return { plan: found.plan, patient: found.patient, latest: latestScores(req.db, found.patient.id), staff: staffList(req.db), ...extra };
}

/** Describe the parent of an item for the form heading. */
function parentLabel(db, level, parentId) {
  if (level === "problems") return null;
  const L = LEVELS[level];
  const parentTable = LEVELS[L.parentLevel].table;
  const row = db.prepare(`SELECT * FROM ${parentTable} WHERE id = ?`).get(parentId);
  if (!row) return null;
  const text = row.title || row.goal_text || row.text || "";
  return `${humanize(LEVELS[L.parentLevel].noun)}: ${text.length > 120 ? text.slice(0, 120) + "…" : text}`;
}

function itemPage(req, found, level, { item, parentId, values, errors = [], warnings = [] }) {
  const L = LEVELS[level];
  const { plan, patient } = found;
  const ctx = itemCtx(req, found, { isNew: !item, parentId });
  const action = item ? `/ehr/treatment-plans/${plan.id}/${level}/${item.id}` : `/ehr/treatment-plans/${plan.id}/${level}`;
  const pLabel = parentLabel(req.db, level, item ? item[L.parentCol] : parentId);
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><div><h1>${item ? "Edit" : "Add"} ${L.noun}</h1>${pLabel ? html`<p>${pLabel}</p>` : ""}</div>
      <a class="btn btn--ghost" href="${planUrl(plan)}">Back to plan</a></div>
    ${errorList(errors)}
    ${warnList(warnings, "Suggestions")}
    <form method="post" action="${action}" class="card stack" data-dirty-check>
      ${csrfField(req)}
      ${item ? "" : html`<input type="hidden" name="parent_id" value="${parentId || ""}">`}
      ${L.form(ctx, values)}
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">${item ? "Save" : "Add"} ${L.noun}</button>
        <a class="btn btn--ghost" href="${planUrl(plan)}">Cancel</a>
      </div>
    </form>`, { title: `${item ? "Edit" : "Add"} ${L.noun}` });
}

/** Parent belongs to this plan? Returns the parent id or null. */
function checkParent(db, plan, level, raw) {
  const L = LEVELS[level];
  if (!L.parentLevel) return plan.id;
  const id = intId(raw);
  if (id === null) return null;
  const owner = db.prepare(LEVELS[L.parentLevel].ownerSql).get(id);
  return owner && owner.plan_id === plan.id ? id : null;
}
function loadItem(db, plan, level, raw) {
  const id = intId(raw);
  if (id === null) return null;
  const owner = db.prepare(LEVELS[level].ownerSql).get(id);
  if (!owner || owner.plan_id !== plan.id) return null;
  return db.prepare(`SELECT * FROM ${LEVELS[level].table} WHERE id = ?`).get(id);
}
const anchor = (level, id) => `#${{ problems: "problem", goals: "goal", objectives: "obj", interventions: "obj" }[level]}-${id}`;

for (const level of Object.keys(LEVELS)) {
  const L = LEVELS[level];
  const base = `/treatment-plans/:planId/${level}`;

  router.get(`${base}/new`, WRITE, (req, res) => {
    const found = loadPlan(req);
    if (!found) return notFound(req, res, "Treatment plan");
    if (!editableOr409(req, res, found)) return;
    const parentId = checkParent(req.db, found.plan, level, req.query.parent);
    if (parentId === null) return notFound(req, res, humanize(LEVELS[L.parentLevel].noun));
    const values = {};
    if (level === "objectives" && typeof req.query.instrument === "string" && INSTRUMENTS[req.query.instrument]) {
      const def = INSTRUMENTS[req.query.instrument];
      const s = latestScore(req.db, found.patient.id, def.key);
      Object.assign(values, { measure_type: "instrument", instrument: def.key, baseline_value: s ? s.total_score : "", direction: "decrease", unit: "points",
        target_value: def.remission ? def.remission.below - 1 : "", measurement_method: `${def.name} every 2–4 weeks` });
    }
    res.send(itemPage(req, found, level, { parentId, values }));
  });

  router.post(base, WRITE, (req, res) => {
    const found = loadPlan(req);
    if (!found) return notFound(req, res, "Treatment plan");
    if (!editableOr409(req, res, found)) return;
    const { plan, patient } = found;
    const db = req.db;
    const parentId = checkParent(db, plan, level, req.body.parent_id);
    if (parentId === null) return notFound(req, res, L.parentLevel ? humanize(LEVELS[L.parentLevel].noun) : "Treatment plan");
    const { v, errors, warnings } = L.validate(itemCtx(req, found), req.body);
    if (errors.length) return res.status(400).send(itemPage(req, found, level, { parentId, values: v, errors, warnings }));
    const id = tx(db, () => {
      const sort = db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM ${L.table} WHERE ${L.parentCol} = ?`).get(parentId).n;
      const newId = Number(db.prepare(`INSERT INTO ${L.table} (${L.parentCol}, sort, ${L.cols.join(", ")}) VALUES (?, ?, ${L.cols.map(() => "?").join(", ")})`)
        .run(parentId, sort, ...L.cols.map((c) => v[c])).lastInsertRowid);
      touch(db, plan.id);
      return newId;
    });
    audit(req, "update", "treatment_plan", plan.id, patient.id, `${L.noun} ${id} added`);
    warnings.forEach((w) => req.flash("warn", w));
    req.flash("success", `${humanize(L.noun)} added.`);
    res.redirect(planUrl(plan) + anchor(level, id));
  });

  router.get(`${base}/:itemId/edit`, WRITE, (req, res) => {
    const found = loadPlan(req);
    if (!found) return notFound(req, res, "Treatment plan");
    if (!editableOr409(req, res, found)) return;
    const item = loadItem(req.db, found.plan, level, req.params.itemId);
    if (!item) return notFound(req, res, humanize(L.noun));
    res.send(itemPage(req, found, level, { item, values: item, warnings: level === "objectives" && vagueWarning(item) ? [vagueWarning(item)] : [] }));
  });

  router.post(`${base}/:itemId`, WRITE, (req, res) => {
    const found = loadPlan(req);
    if (!found) return notFound(req, res, "Treatment plan");
    if (!editableOr409(req, res, found)) return;
    const { plan, patient } = found;
    const item = loadItem(req.db, plan, level, req.params.itemId);
    if (!item) return notFound(req, res, humanize(L.noun));
    const { v, errors, warnings } = L.validate(itemCtx(req, found), req.body);
    if (errors.length) return res.status(400).send(itemPage(req, found, level, { item, values: v, errors, warnings }));
    req.db.prepare(`UPDATE ${L.table} SET ${L.cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...L.cols.map((c) => v[c]), item.id);
    touch(req.db, plan.id);
    audit(req, "update", "treatment_plan", plan.id, patient.id, `${L.noun} ${item.id} updated`);
    warnings.forEach((w) => req.flash("warn", w));
    req.flash("success", `${humanize(L.noun)} saved.`);
    res.redirect(planUrl(plan) + anchor(level, item.id));
  });

  router.post(`${base}/:itemId/delete`, WRITE, (req, res) => {
    const found = loadPlan(req);
    if (!found) return notFound(req, res, "Treatment plan");
    if (!editableOr409(req, res, found)) return;
    const { plan, patient } = found;
    const item = loadItem(req.db, plan, level, req.params.itemId);
    if (!item) return notFound(req, res, humanize(L.noun));
    req.db.prepare(`DELETE FROM ${L.table} WHERE id = ?`).run(item.id);
    touch(req.db, plan.id);
    audit(req, "update", "treatment_plan", plan.id, patient.id, `${L.noun} ${item.id} deleted`);
    req.flash("success", `${humanize(L.noun)} deleted.`);
    res.redirect(planUrl(plan));
  });

  router.post(`${base}/:itemId/move`, WRITE, (req, res) => {
    const found = loadPlan(req);
    if (!found) return notFound(req, res, "Treatment plan");
    if (!editableOr409(req, res, found)) return;
    const { plan, patient } = found;
    const db = req.db;
    const item = loadItem(db, plan, level, req.params.itemId);
    if (!item) return notFound(req, res, humanize(L.noun));
    const dir = req.body.dir === "up" ? -1 : req.body.dir === "down" ? 1 : 0;
    if (!dir) return res.status(400).send(chartPage(req, patient, "plan", html`<div class="card"><p>Choose a direction.</p></div>`));
    tx(db, () => {
      const sibs = db.prepare(`SELECT id FROM ${L.table} WHERE ${L.parentCol} = ? ORDER BY sort, id`).all(item[L.parentCol]).map((r) => r.id);
      const i = sibs.indexOf(item.id), j = i + dir;
      if (j >= 0 && j < sibs.length) [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      const upd = db.prepare(`UPDATE ${L.table} SET sort = ? WHERE id = ?`);
      sibs.forEach((id, k) => upd.run(k, id));
      touch(db, plan.id);
    });
    audit(req, "update", "treatment_plan", plan.id, patient.id, `${L.noun} ${item.id} moved ${dir < 0 ? "up" : "down"}`);
    res.redirect(planUrl(plan) + anchor(level, item.id));
  });
}

/* ================================================================== */
/* Signatures and activation                                          */
/* ================================================================== */

function checkPassword(db, userId, password) {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
  return !!row && typeof password === "string" && password.length > 0 && verifyPassword(password, row.password_hash);
}

function signPage(req, found, { errors = [], values = {} } = {}) {
  const { plan, patient } = found;
  const db = req.db;
  const check = activationCheck(db, plan, patient);
  const has = (role) => check.sigs.find((s) => s.role === role);
  const minor = age(patient.dob) < 18;
  const isAuthor = plan.author_id === req.user.id;
  const clinicianSig = has("clinician");
  const canSupervise = ["clinician", "admin"].includes(req.user.role) && !isAuthor && !(clinicianSig && clinicianSig.signer_user_id === req.user.id);
  const act = `/ehr/treatment-plans/${plan.id}/signatures`;
  const item = (ok, text, optional) => html`<li class="checklist__item">${ok ? html`<span class="badge badge--good">Done</span>` : optional ? html`<span class="badge badge--muted">Optional</span>` : html`<span class="badge badge--bad">Needed</span>`} ${text}</li>`;
  const pw = (id) => html`<label for="${id}">Your password <input type="password" id="${id}" name="password" autocomplete="current-password" required>
    <span class="hint">Re-enter your password to sign.</span></label>`;
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><div><h1>Signatures &amp; activation <span class="muted">v${plan.version}</span></h1>
      <p>Signatures attach to this version and lock its content.</p></div>
      <a class="btn btn--ghost" href="${planUrl(plan)}">Back to plan</a></div>
    ${errorList(errors)}
    <div class="grid grid--2">
      <section class="card" aria-labelledby="chk"><h2 id="chk">Activation checklist</h2>
        <ul class="list-plain checklist">
          ${item(check.chain, "At least one problem → goal → objective → intervention chain")}
          ${item(Number(plan.review_interval_days) >= 7, `Review interval set (every ${plan.review_interval_days} days)`)}
          ${item(!!clinicianSig, "Clinician signature")}
          ${item(!!has("client"), "Client signature or documented decline")}
          ${item(!!has("supervisor"), reqSupervisor() ? "Supervisor co-signature (required by clinic settings)" : "Supervisor co-signature", !reqSupervisor())}
          ${item(!!has("guardian"), minor ? "Parent/guardian signature (client is under 18)" : "Guardian signature", true)}
        </ul>
        ${warnList(check.warnings)}
        <form method="post" action="/ehr/treatment-plans/${plan.id}/activate" class="no-print"
          data-confirm="Activate version ${plan.version}?${activePlanFor(db, patient.id) ? " The current active plan will be superseded." : ""}">
          ${csrfField(req)}
          <button class="btn btn--primary" type="submit" ${check.errors.length ? raw("disabled aria-disabled=\"true\"") : ""}>Activate plan</button>
          ${check.errors.length ? html` <span class="hint">Complete the items marked Needed first.</span>` : ""}
        </form>
      </section>
      <section class="card" aria-labelledby="sigs"><div class="card__head"><h2 id="sigs">Signatures collected</h2>
        ${check.sigs.length ? html`<form method="post" action="${act}/clear" class="inline-form" data-confirm="Remove all signatures from this draft? The content will be unlocked for editing and every signature must be collected again.">
          ${csrfField(req)}<button class="btn btn--sm btn--danger" type="submit">Clear signatures &amp; unlock</button></form>` : ""}</div>
        ${signatureTable(check.sigs)}
      </section>
    </div>

    ${!clinicianSig ? html`
    <section class="card" aria-labelledby="s-clin"><h2 id="s-clin">Clinician signature</h2>
      <form method="post" action="${act}" class="stack">${csrfField(req)}<input type="hidden" name="role" value="clinician">
        <p>Signing as <strong>${req.user.name}${req.user.credentials ? `, ${req.user.credentials}` : ""}</strong>. I developed this plan with the client and attest it reflects their goals.</p>
        <div class="form-grid form-grid--narrow">${pw("pw-clin")}</div>
        <div><button class="btn btn--primary" type="submit">Sign as clinician</button></div>
      </form></section>` : ""}

    ${!has("client") ? html`
    <section class="card" aria-labelledby="s-client"><h2 id="s-client">Client signature</h2>
      <form method="post" action="${act}" class="stack">${csrfField(req)}<input type="hidden" name="role" value="client">
        <div class="form-grid">
          <label for="client_name">Client name <input id="client_name" name="signer_name" value="${values.signer_name || `${patient.first_name} ${patient.last_name}`}" maxlength="200" required></label>
          <label>How the client signed ${select("method", CLIENT_METHODS, values.method || "in_person")}</label>
        </div>
        <label class="check"><input type="checkbox" name="declined" value="1" ${checked(values.declined)}> Client declined or was unable to sign</label>
        <label for="client_reason">Reason (required if declined or unable) <input id="client_reason" name="declined_reason" value="${values.declined_reason || ""}" maxlength="500"></label>
        <label class="check"><input type="checkbox" name="copy_offered" value="1" ${checked(values.copy_offered !== "0")}> A copy of the plan was offered to the client</label>
        <div><button class="btn btn--primary" type="submit">Record client signature</button></div>
      </form></section>` : ""}

    ${!has("guardian") ? html`
    <section class="card" aria-labelledby="s-guard"><h2 id="s-guard">Parent / guardian signature ${minor ? html`<span class="badge badge--warn">Client is under 18</span>` : html`<span class="muted small">Optional</span>`}</h2>
      <form method="post" action="${act}" class="stack">${csrfField(req)}<input type="hidden" name="role" value="guardian">
        <div class="form-grid">
          <label for="g_name">Guardian name and relationship <input id="g_name" name="signer_name" maxlength="200" placeholder="e.g. Pat Example (mother)" required></label>
          <label>Method ${raw(String(select("method", CLIENT_METHODS, "in_person")).replace('id="method"', 'id="g_method"'))}</label>
        </div>
        <label class="check"><input type="checkbox" name="declined" value="1"> Guardian declined or was unavailable</label>
        <label for="g_reason">Reason (if declined or unavailable) <input id="g_reason" name="declined_reason" maxlength="500"></label>
        <div><button class="btn" type="submit">Record guardian signature</button></div>
      </form></section>` : ""}

    ${!has("supervisor") ? html`
    <section class="card" aria-labelledby="s-sup"><h2 id="s-sup">Supervisor co-signature ${reqSupervisor() ? html`<span class="badge badge--warn">Required</span>` : html`<span class="muted small">Optional</span>`}</h2>
      ${canSupervise ? html`
        <form method="post" action="${act}" class="stack">${csrfField(req)}<input type="hidden" name="role" value="supervisor">
          <p>Co-signing as <strong>${req.user.name}${req.user.credentials ? `, ${req.user.credentials}` : ""}</strong> (supervisor).</p>
          <div class="form-grid form-grid--narrow">${pw("pw-sup")}</div>
          <div><button class="btn" type="submit">Co-sign as supervisor</button></div>
        </form>` : html`<p class="muted">A supervisor (a clinician or administrator other than the plan's author and the signing clinician) signs in with their own account, opens this page and co-signs with their password.</p>`}
    </section>` : ""}
  `, { title: "Sign treatment plan" });
}

router.get("/treatment-plans/:planId/sign", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (found.plan.status !== "draft") return conflict(req, res, found.patient, "Only a draft plan can be signed. Signed versions are locked.", found.plan.id);
  audit(req, "view", "treatment_plan", found.plan.id, found.patient.id, "signing page");
  res.send(signPage(req, found));
});

router.post("/treatment-plans/:planId/signatures", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const db = req.db;
  if (plan.status !== "draft") return conflict(req, res, patient, "Signatures can only be added to a draft plan.", plan.id);
  const role = str(req.body.role, 20);
  const errors = [];
  if (!SIG_ROLES.includes(role)) errors.push("Choose a valid signature role.");
  else if (db.prepare("SELECT 1 FROM plan_signatures WHERE plan_id = ? AND role = ?").get(plan.id, role)) errors.push(`A ${role} signature is already on this version.`);
  const row = { role, signer_user_id: null, signer_name: "", method: null, declined: 0, declined_reason: null, copy_offered: 0 };
  if (!errors.length && (role === "clinician" || role === "supervisor")) {
    if (!["clinician", "admin"].includes(req.user.role)) errors.push("Only a clinician or administrator can sign.");
    if (role === "supervisor") {
      const clin = db.prepare("SELECT signer_user_id FROM plan_signatures WHERE plan_id = ? AND role = 'clinician'").get(plan.id);
      if (req.user.id === plan.author_id) errors.push("The supervisor must be someone other than the plan's author.");
      else if (clin && clin.signer_user_id === req.user.id) errors.push("The supervisor must be someone other than the signing clinician.");
    } else {
      const sup = db.prepare("SELECT signer_user_id FROM plan_signatures WHERE plan_id = ? AND role = 'supervisor'").get(plan.id);
      if (sup && sup.signer_user_id === req.user.id) errors.push("You already co-signed as supervisor.");
    }
    if (!errors.length && !checkPassword(db, req.user.id, String(req.body.password || ""))) {
      audit(req, "sign_failed", "treatment_plan", plan.id, patient.id, `${role} signature: wrong password`);
      errors.push("Password is incorrect.");
    }
    Object.assign(row, { signer_user_id: req.user.id, signer_name: req.user.name, method: "password" });
  } else if (!errors.length) {
    row.signer_name = str(req.body.signer_name, 200);
    row.declined = req.body.declined === "1" ? 1 : 0;
    row.declined_reason = str(req.body.declined_reason, 500) || null;
    row.method = row.declined ? null : str(req.body.method, 20);
    row.copy_offered = role === "client" && req.body.copy_offered === "1" ? 1 : 0;
    if (!row.signer_name) errors.push(`Enter the ${role}'s name.`);
    if (row.declined && !row.declined_reason) errors.push("Document why the signature was declined or not possible.");
    if (!row.declined && !CLIENT_METHODS.some((m) => m.value === row.method)) errors.push("Choose how the signature was obtained.");
  }
  if (errors.length) return res.status(400).send(signPage(req, found, { errors, values: req.body }));
  db.prepare(`INSERT INTO plan_signatures (plan_id, role, signer_user_id, signer_name, method, declined, declined_reason, copy_offered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, row.role, row.signer_user_id, row.signer_name, row.method, row.declined, row.declined_reason, row.copy_offered);
  touch(db, plan.id);
  audit(req, "sign", "treatment_plan", plan.id, patient.id, `${role} signature${row.declined ? " (declined/unable)" : ""}`);
  req.flash("success", row.declined ? `${humanize(role)} decline documented.` : `${humanize(role)} signature recorded.`);
  res.redirect(`/ehr/treatment-plans/${plan.id}/sign`);
});

router.post("/treatment-plans/:planId/signatures/clear", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "draft") return conflict(req, res, patient, "Signatures on a signed plan can't be removed.", plan.id);
  const n = req.db.prepare("DELETE FROM plan_signatures WHERE plan_id = ?").run(plan.id).changes;
  audit(req, "update", "treatment_plan", plan.id, patient.id, `${n} signature(s) cleared; draft unlocked`);
  req.flash("success", "Signatures cleared. The draft can be edited again.");
  res.redirect(`/ehr/treatment-plans/${plan.id}/sign`);
});

router.post("/treatment-plans/:planId/activate", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const db = req.db;
  if (plan.status !== "draft") return conflict(req, res, patient, "Only a draft plan can be activated.", plan.id);
  const check = activationCheck(db, plan, patient);
  if (check.errors.length) return res.status(400).send(signPage(req, found, { errors: check.errors }));
  const act = today();
  const superseded = tx(db, () => {
    const prev = db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active' AND id <> ?").all(patient.id, plan.id).map((p) => p.id);
    db.prepare(`UPDATE treatment_plans SET status = 'superseded', ended_at = ?, end_reason = 'superseded', updated_at = datetime('now')
      WHERE patient_id = ? AND status = 'active' AND id <> ?`).run(act, patient.id, plan.id);
    db.prepare(`UPDATE treatment_plans SET status = 'active', activated_at = datetime('now'), signed_at = datetime('now'),
      start_date = COALESCE(start_date, ?), review_date = ?, updated_at = datetime('now') WHERE id = ? AND status = 'draft'`)
      .run(act, addDays(act, Number(plan.review_interval_days)), plan.id);
    return prev;
  });
  audit(req, "activate", "treatment_plan", plan.id, patient.id, `version ${plan.version} activated`);
  superseded.forEach((id) => audit(req, "supersede", "treatment_plan", id, patient.id, `superseded by plan ${plan.id}`));
  req.flash("success", superseded.length ? "Plan activated. The previous version was marked superseded." : "Plan activated.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan`);
});

router.post("/treatment-plans/:planId/revise", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "active") return conflict(req, res, patient, "Only the active plan can be revised.", plan.id);
  const draft = draftPlanFor(req.db, patient.id);
  if (draft) {
    req.flash("info", "A draft revision already exists. Continue editing it.");
    return res.redirect(planUrl(draft));
  }
  const id = tx(req.db, () => copyPlan(req.db, plan, req.user.id));
  audit(req, "create", "treatment_plan", id, patient.id, `draft created as revision of plan ${plan.id}`);
  req.flash("success", "Draft revision created. The current plan stays active until this version is signed and activated.");
  res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${id}`);
});

/* ================================================================== */
/* End plan                                                           */
/* ================================================================== */

function endPage(req, found, { values = {}, errors = [] } = {}) {
  const { plan, patient } = found;
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><h1>End treatment plan <span class="muted">v${plan.version}</span></h1>
      <a class="btn btn--ghost" href="${planUrl(plan)}">Back to plan</a></div>
    ${errorList(errors)}
    <form method="post" action="/ehr/treatment-plans/${plan.id}/end" class="card stack" data-confirm="End this plan? It stays on file, read-only.">
      ${csrfField(req)}
      <div class="form-grid">
        <label for="end_reason">Reason ${select("end_reason", END_REASONS, values.end_reason || "goals_met")}</label>
        <label for="end_date">End date <input type="date" id="end_date" name="end_date" value="${values.end_date || today()}" max="${today()}" required></label>
        <label class="span-all" for="other_reason">Details (required for "Other") <input id="other_reason" name="other_reason" value="${values.other_reason || ""}" maxlength="300"></label>
      </div>
      <p class="hint">To discharge with a full review of each objective, use <a href="/ehr/treatment-plans/${plan.id}/review">Start review</a> and choose "Discharge".</p>
      <div class="form-actions"><button class="btn btn--primary" type="submit">End plan</button>
        <a class="btn btn--ghost" href="${planUrl(plan)}">Cancel</a></div>
    </form>`, { title: "End treatment plan" });
}

router.get("/treatment-plans/:planId/end", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (found.plan.status !== "active") return conflict(req, res, found.patient, "Only an active plan can be ended.", found.plan.id);
  res.send(endPage(req, found));
});

router.post("/treatment-plans/:planId/end", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  if (plan.status !== "active") return conflict(req, res, patient, "Only an active plan can be ended.", plan.id);
  const values = { end_reason: str(req.body.end_reason, 20), end_date: str(req.body.end_date, 10) || today(), other_reason: str(req.body.other_reason, 300) };
  const errors = [];
  if (!END_REASONS.some((r) => r.value === values.end_reason)) errors.push("Choose a reason for ending the plan.");
  if (values.end_reason === "other" && !values.other_reason) errors.push("Describe the reason.");
  if (!isDate(values.end_date)) errors.push("End date must be a valid date.");
  else if (values.end_date > today()) errors.push("End date can't be in the future.");
  else if (plan.start_date && values.end_date < plan.start_date) errors.push("End date can't be before the plan's start date.");
  if (errors.length) return res.status(400).send(endPage(req, found, { values, errors }));
  const reason = values.end_reason === "other" ? `other: ${values.other_reason}` : values.end_reason;
  req.db.prepare("UPDATE treatment_plans SET status = 'completed', ended_at = ?, end_reason = ?, updated_at = datetime('now') WHERE id = ?")
    .run(values.end_date, reason, plan.id);
  audit(req, "complete", "treatment_plan", plan.id, patient.id, `plan ended: ${values.end_reason}`);
  req.flash("success", "Plan ended. It remains on file.");
  res.redirect(planUrl(plan));
});

/* ================================================================== */
/* Reviews                                                            */
/* ================================================================== */

function reviewPage(req, found, { values = {}, errors = [] } = {}) {
  const { plan, patient } = found;
  const tree = loadTree(req.db, plan);
  const v = (k, d = "") => (values[k] !== undefined ? values[k] : d);
  return chartPage(req, patient, "plan", html`
    <div class="page-head"><div><h1>Plan review <span class="muted">v${plan.version}</span></h1>
      <p>Next review was due ${fmtDate(plan.review_date)} · reviewing every ${plan.review_interval_days} days</p></div>
      <a class="btn btn--ghost" href="${planUrl(plan)}">Back to plan</a></div>
    ${errorList(errors)}
    <form method="post" action="/ehr/treatment-plans/${plan.id}/review" class="stack" data-dirty-check>
      ${csrfField(req)}
      <section class="card"><h2>Review</h2><div class="form-grid">
        <label for="review_date">Review date <input type="date" id="review_date" name="review_date" value="${v("review_date", today())}" max="${today()}" required></label>
        <label for="participants">Participants <input id="participants" name="participants" value="${v("participants", "Client; " + req.user.name)}" maxlength="300"></label>
        <label class="span-all" for="client_perspective">Client's perspective on progress ${ta("client_perspective", v("client_perspective"), 2)}</label>
      </div></section>
      <section class="card"><h2>Objectives</h2>
        <p class="hint">Instrument objectives are prefilled with the latest score. Status and current value on the active plan update when you sign this review.</p>
        ${tree.objectives.length ? tree.objectives.map((o) => html`
          <fieldset class="review-obj">
            <legend>Objective ${o.num}</legend>
            <p class="plan-obj__text">${o.text}</p>
            ${measureBlock(o, { compact: true })}
            <div class="form-grid">
              <label for="status_${o.id}">Status ${select(`status_${o.id}`, OBJ_STATUSES, v(`status_${o.id}`, o.status === "not_started" ? "progressing" : o.status))}</label>
              <label for="current_${o.id}">Current value${o.unit ? ` (${o.unit})` : ""}
                <input id="current_${o.id}" name="current_${o.id}" inputmode="decimal" value="${v(`current_${o.id}`, o.measure.current ?? "")}" ${o.measure_type === "attainment" ? raw('placeholder="n/a"') : ""}></label>
              <label for="action_${o.id}">Action ${select(`action_${o.id}`, REVIEW_ACTIONS, v(`action_${o.id}`, "continue"))}</label>
              <label class="span-all" for="rationale_${o.id}">Rationale <input id="rationale_${o.id}" name="rationale_${o.id}" value="${v(`rationale_${o.id}`)}" maxlength="1000"
                placeholder="Evidence for the status: scores, logs, client report"></label>
            </div>
          </fieldset>`) : html`<p class="muted">This plan has no objectives.</p>`}
      </section>
      <section class="card stack"><h2>Summary and outcome</h2><div class="form-grid">
        <label class="span-all" for="summary">Summary of progress ${ta("summary", v("summary"), 3, "required")}</label>
        <label class="span-all" for="diagnosis_changes">Diagnosis changes ${ta("diagnosis_changes", v("diagnosis_changes"), 2)}
          <span class="hint">Record "None" if unchanged. Update the problem list on the Overview tab separately.</span></label>
      </div>
      <fieldset><legend>Is the current level of care still appropriate?</legend><div class="row">
        <label class="check"><input type="radio" name="level_of_care_appropriate" value="1" ${checked(v("level_of_care_appropriate") === "1")} required> Yes</label>
        <label class="check"><input type="radio" name="level_of_care_appropriate" value="0" ${checked(v("level_of_care_appropriate") === "0")}> No</label></div></fieldset>
      <fieldset><legend>Outcome</legend><div class="stack">
        ${OUTCOMES.map((o) => html`<label class="check"><input type="radio" name="outcome" value="${o.value}" ${checked(v("outcome", "continue") === o.value)} required>
          <span><strong>${o.label}</strong> <span class="hint">${o.hint}</span></span></label>`)}
        <label for="end_reason">If discharging, reason ${select("end_reason", END_REASONS.filter((r) => r.value !== "other"), v("end_reason", "goals_met"))}</label>
      </div></fieldset>
      </section>
      <section class="card"><h2>Sign review</h2><div class="form-grid form-grid--narrow">
        <label for="password">Your password <input type="password" id="password" name="password" autocomplete="current-password" required>
          <span class="hint">Signing as ${req.user.name}${req.user.credentials ? `, ${req.user.credentials}` : ""}.</span></label></div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Sign review</button>
          <a class="btn btn--ghost" href="${planUrl(plan)}">Cancel</a></div>
      </section>
    </form>`, { title: "Plan review" });
}

router.get("/treatment-plans/:planId/review", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  if (found.plan.status !== "active") return conflict(req, res, found.patient, "Only an active plan can be reviewed.", found.plan.id);
  audit(req, "view", "treatment_plan", found.plan.id, found.patient.id, "review form");
  res.send(reviewPage(req, found));
});

router.post("/treatment-plans/:planId/review", WRITE, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const db = req.db;
  if (plan.status !== "active") return conflict(req, res, patient, "Only an active plan can be reviewed.", plan.id);
  const b = req.body;
  const tree = loadTree(db, plan);
  const errors = [];
  const r = {
    review_date: str(b.review_date, 10), participants: str(b.participants, 300) || null, client_perspective: str(b.client_perspective, 5000) || null,
    summary: str(b.summary, 5000), diagnosis_changes: str(b.diagnosis_changes, 2000) || null,
    loc: b.level_of_care_appropriate === "1" ? 1 : b.level_of_care_appropriate === "0" ? 0 : null,
    outcome: str(b.outcome, 20), end_reason: str(b.end_reason, 20) || "goals_met",
  };
  if (!isDate(r.review_date)) errors.push("Review date must be a valid date.");
  else if (r.review_date > today()) errors.push("Review date can't be in the future.");
  if (!r.summary) errors.push("Summarize progress.");
  if (r.loc === null) errors.push("Say whether the level of care is still appropriate.");
  if (!OUTCOMES.some((o) => o.value === r.outcome)) errors.push("Choose an outcome: continue, revise or discharge.");
  if (r.outcome === "discharge" && !END_REASONS.some((e) => e.value === r.end_reason && e.value !== "other")) errors.push("Choose a discharge reason.");
  const items = tree.objectives.map((o) => {
    const it = { objective_id: o.id, status: str(b[`status_${o.id}`], 20), current_value: num(b[`current_${o.id}`]),
      rationale: str(b[`rationale_${o.id}`], 1000) || null, action: str(b[`action_${o.id}`], 30) || null };
    if (!OBJ_STATUSES.includes(it.status)) errors.push(`Choose a status for objective ${o.num}.`);
    if (Number.isNaN(it.current_value)) errors.push(`Current value for objective ${o.num} must be a number.`);
    if (it.action && !REVIEW_ACTIONS.some((a) => a.value === it.action)) errors.push(`Choose a valid action for objective ${o.num}.`);
    return it;
  });
  if (!errors.length && !checkPassword(db, req.user.id, String(b.password || ""))) {
    audit(req, "sign_failed", "plan_review", null, patient.id, `review of plan ${plan.id}: wrong password`);
    errors.push("Password is incorrect.");
  }
  if (errors.length) return res.status(400).send(reviewPage(req, found, { values: b, errors }));

  const { reviewId, draftId } = tx(db, () => {
    const reviewId = Number(db.prepare(
      `INSERT INTO plan_reviews (plan_id, review_date, reviewer_id, participants, client_perspective, summary, diagnosis_changes,
       level_of_care_appropriate, outcome, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(plan.id, r.review_date, req.user.id, r.participants, r.client_perspective, r.summary, r.diagnosis_changes, r.loc, r.outcome).lastInsertRowid);
    const insItem = db.prepare("INSERT INTO plan_review_items (review_id, objective_id, status, current_value, rationale, action) VALUES (?, ?, ?, ?, ?, ?)");
    const updObj = db.prepare(`UPDATE plan_objectives SET status = ?, current_value = COALESCE(?, current_value),
      current_value_on = CASE WHEN ? IS NULL THEN current_value_on ELSE ? END WHERE id = ?`);
    items.forEach((it) => {
      insItem.run(reviewId, it.objective_id, it.status, it.current_value, it.rationale, it.action);
      updObj.run(it.status, it.current_value, it.current_value, r.review_date, it.objective_id);
    });
    let draftId = null;
    if (r.outcome === "discharge") {
      db.prepare("UPDATE treatment_plans SET status = 'completed', ended_at = ?, end_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(r.review_date, r.end_reason, plan.id);
    } else {
      db.prepare("UPDATE treatment_plans SET review_date = ?, updated_at = datetime('now') WHERE id = ?")
        .run(addDays(r.review_date, Number(plan.review_interval_days)), plan.id);
      if (r.outcome === "revise") {
        const existing = draftPlanFor(db, patient.id);
        draftId = existing ? existing.id : copyPlan(db, { ...plan }, req.user.id);
      }
    }
    return { reviewId, draftId };
  });
  audit(req, "sign", "plan_review", reviewId, patient.id, `review of plan ${plan.id}; outcome ${r.outcome}`);
  if (r.outcome === "discharge") audit(req, "complete", "treatment_plan", plan.id, patient.id, `plan ended at review: ${r.end_reason}`);
  if (draftId) audit(req, "create", "treatment_plan", draftId, patient.id, `draft revision from review ${reviewId}`);
  if (r.outcome === "revise") {
    req.flash("success", "Review signed. Edit the draft revision below, then collect signatures and activate it.");
    return res.redirect(`/ehr/patients/${patient.id}/treatment-plan?plan=${draftId}`);
  }
  req.flash("success", r.outcome === "discharge" ? "Review signed and the plan ended." : "Review signed. The next review date was moved out.");
  res.redirect(planUrl(plan));
});

router.get("/treatment-plans/:planId/reviews/:reviewId", READ, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const id = intId(req.params.reviewId);
  const r = id === null ? null : req.db.prepare(
    `SELECT r.*, u.name AS reviewer_name, u.credentials AS reviewer_credentials FROM plan_reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.id = ? AND r.plan_id = ?`).get(id, plan.id);
  if (!r) return notFound(req, res, "Review");
  const items = req.db.prepare(
    `SELECT i.*, o.text, o.unit FROM plan_review_items i JOIN plan_objectives o ON o.id = i.objective_id WHERE i.review_id = ? ORDER BY i.id`).all(r.id);
  audit(req, "view", "plan_review", r.id, patient.id);
  res.send(chartPage(req, patient, "plan", html`
    <div class="page-head"><div><h1>Plan review ${fmtDate(r.review_date)} ${tag(r.outcome)}</h1>
      <p>Treatment plan v${plan.version} · ${r.reviewer_name}${r.reviewer_credentials ? `, ${r.reviewer_credentials}` : ""}</p></div>
      <div class="row no-print"><button class="btn" type="button" data-print>Print</button><a class="btn btn--ghost" href="${planUrl(plan)}">Back to plan</a></div></div>
    ${isSud(plan) ? html`<div class="alert alert--info part2" role="note">${PART2_NOTICE}</div>` : ""}
    <section class="card"><dl class="facts">
      <dt>Participants</dt><dd>${textOr(r.participants)}</dd>
      <dt>Client's perspective</dt><dd>${textOr(r.client_perspective)}</dd>
      <dt>Summary</dt><dd>${textOr(r.summary)}</dd>
      <dt>Diagnosis changes</dt><dd>${textOr(r.diagnosis_changes, "None recorded")}</dd>
      <dt>Level of care appropriate</dt><dd>${r.level_of_care_appropriate === null ? "—" : r.level_of_care_appropriate ? "Yes" : "No"}</dd>
      <dt>Outcome</dt><dd>${OUTCOMES.find((o) => o.value === r.outcome).label}</dd>
    </dl></section>
    <section class="card"><h2>Objectives</h2>
      <div class="table-wrap"><table class="table"><thead><tr><th>Objective</th><th>Status</th><th class="num">Value</th><th>Action</th><th>Rationale</th></tr></thead>
      <tbody>${items.map((i) => html`<tr><td>${i.text}</td><td>${tag(i.status)}</td><td class="num">${fmtN(i.current_value)}${i.unit && i.current_value !== null ? ` ${i.unit}` : ""}</td>
        <td>${i.action ? (REVIEW_ACTIONS.find((a) => a.value === i.action) || {}).label : "—"}</td><td class="small">${i.rationale || ""}</td></tr>`)}</tbody></table></div>
    </section>
    <p class="signature">Electronically signed by ${r.reviewer_name}${r.reviewer_credentials ? `, ${r.reviewer_credentials}` : ""} on ${fmtTimestamp(r.signed_at)}</p>`,
  { title: "Plan review" }));
});

/* ================================================================== */
/* Print view                                                         */
/* ================================================================== */

router.get("/treatment-plans/:planId/print", READ, (req, res) => {
  const found = loadPlan(req);
  if (!found) return notFound(req, res, "Treatment plan");
  const { plan, patient } = found;
  const db = req.db;
  const tree = loadTree(db, plan);
  const sigs = signaturesFor(db, plan.id);
  const reviews = reviewsFor(db, plan.id);
  const sud = isSud(plan);
  const section = (title, fields) => {
    const rows = fields.filter(([k]) => plan[k]);
    return rows.length ? html`<section class="print-sec"><h2>${title}</h2><dl class="facts plan-facts">${rows.map(([k, l]) => html`<dt>${l}</dt><dd class="prewrap">${plan[k]}</dd>`)}</dl></section>` : "";
  };
  audit(req, "print", "treatment_plan", plan.id, patient.id);
  res.send(page(req, { title: "Treatment plan (print)", bare: true, body: html`
    <div class="print-toolbar no-print">
      <a class="btn btn--ghost btn--sm" href="${planUrl(plan)}">← Back to chart</a>
      <button class="btn btn--primary btn--sm" type="button" data-print>Print</button>
    </div>
    <article class="print-sheet">
      <header class="print-head">
        <div><p class="print-org">Clinic Ready · Behavioral Health</p>
          <h1>Treatment plan</h1>
          <p class="muted">Version ${plan.version} · ${humanize(plan.status)} · ${PLAN_TYPE_LABEL[plan.plan_type] || humanize(plan.plan_type)}</p></div>
        <dl class="facts print-patient">
          <dt>Client</dt><dd>${patientName(patient)}</dd>
          <dt>DOB</dt><dd>${fmtDate(patient.dob)}</dd>
          <dt>MRN</dt><dd>${patient.mrn}</dd>
          <dt>Start</dt><dd>${plan.start_date ? fmtDate(plan.start_date) : "On activation"}</dd>
          <dt>Next review</dt><dd>${plan.review_date && plan.status !== "draft" ? fmtDate(plan.review_date) : `Every ${plan.review_interval_days} days`}</dd>
        </dl>
      </header>
      ${plan.status === "draft" ? html`<p class="alert alert--warn">DRAFT: not signed and not in effect.</p>` : ""}
      ${plan.status === "superseded" || plan.status === "completed" ? html`<p class="alert alert--info">This version ended ${fmtDate(plan.ended_at)} (${endReasonLabel(plan.end_reason)}).</p>` : ""}
      ${sud ? html`<p class="alert alert--info part2">${PART2_NOTICE}</p>` : ""}
      ${plan.client_vision ? html`<section class="print-sec"><h2>My vision for treatment</h2><blockquote class="plan-quote plan-quote--lg">“${plan.client_vision}”</blockquote></section>` : ""}
      <section class="print-sec"><h2>Diagnoses</h2>${dxList(plan)}</section>
      ${HEADER_GROUPS.slice(1, 5).map((g) => section(g.title, g.fields))}
      ${sud ? html`<section class="print-sec"><h2>Substance use treatment (ASAM)</h2><dl class="facts plan-facts">
        <dt>Level of care indicated</dt><dd>${plan.loc_indicated ? ASAM_LEVEL_LABEL[plan.loc_indicated] : "—"}</dd>
        <dt>Level of care provided</dt><dd>${plan.loc_adjusted ? ASAM_LEVEL_LABEL[plan.loc_adjusted] : "—"}</dd>
        ${SUD_FIELDS.filter(([k]) => plan[k]).map(([k, l]) => html`<dt>${l}</dt><dd class="prewrap">${plan[k]}</dd>`)}</dl></section>` : ""}
      <section class="print-sec"><h2>Problems, goals and objectives</h2>
        ${tree.problems.map((p) => html`<div class="print-problem">
          <h3>Problem ${p.num}: ${p.title}${p.icd10_code ? ` (${p.icd10_code})` : ""}${sud && p.asam_dimension ? ` · ASAM dimension ${p.asam_dimension}: ${ASAM_DIMS[p.asam_dimension]}` : ""}</h3>
          ${p.behavioral_definition ? html`<p class="prewrap">${p.behavioral_definition}</p>` : ""}
          ${p.goals.map((g) => html`<div class="plan-goal">
            <p><strong>Goal ${g.num}:</strong> ${g.goal_text}</p>
            ${g.client_words ? html`<blockquote class="plan-quote">“${g.client_words}”</blockquote>` : ""}
            <table class="table print-table"><thead><tr><th>Objective</th><th>Measure</th><th>Target date</th><th>Status</th></tr></thead>
            <tbody>${g.objectives.map((o) => html`<tr>
              <td><strong>${o.num}</strong> ${o.text}
                ${o.interventions.length ? html`<ul class="print-ints">${o.interventions.map((iv) => html`<li>${iv.modality ? html`<strong>${iv.modality}:</strong> ` : ""}${iv.description}${iv.frequency || iv.duration ? ` (${[iv.frequency, iv.duration].filter(Boolean).join(", ")})` : ""}${iv.responsible_name || iv.responsible_text ? ` · ${iv.responsible_name || iv.responsible_text}` : ""}</li>`)}</ul>` : ""}</td>
              <td class="small">${o.measure_type === "attainment" ? "Yes/no" : html`${o.instrument && INSTRUMENTS[o.instrument] ? INSTRUMENTS[o.instrument].name + ": " : ""}${fmtN(o.baseline_value)} → ${fmtN(o.measure.current)} → ${fmtN(o.target_value)}${o.unit ? ` ${o.unit}` : ""}${o.measure.pct !== null ? html`<br>${o.measure.pct}% of the way to target` : ""}`}</td>
              <td>${fmtDate(o.target_date)}</td><td>${humanize(o.status)}</td></tr>`)}</tbody></table>
          </div>`)}
        </div>`)}
      </section>
      ${section("Discharge and transition", HEADER_GROUPS[5].fields)}
      ${reviews.length ? html`<section class="print-sec"><h2>Reviews</h2><ul class="list">${reviews.map((r) => html`<li>${fmtDate(r.review_date)}: ${OUTCOMES.find((o) => o.value === r.outcome).label} (${r.reviewer_name})</li>`)}</ul></section>` : ""}
      <section class="print-sec"><h2>Signatures</h2>
        ${sigs.length ? html`<div class="sig-grid">${sigs.map((s) => html`<div class="sig-box">
          <div class="sig-line">${s.declined ? html`<em>Declined / unable to sign</em>` : s.method === "password" ? html`<em>Electronically signed</em>` : html`<em>Signed (${humanize(s.method)})</em>`}</div>
          <strong>${signerLabel(s)}</strong><span class="small">${humanize(s.role)} · ${fmtTimestamp(s.signed_at)}</span>
          ${s.declined ? html`<span class="small">Reason: ${s.declined_reason}</span>` : ""}
          ${s.role === "client" ? html`<span class="small">Copy offered to client: ${s.copy_offered ? "Yes" : "No"}</span>` : ""}
        </div>`)}</div>` : html`<p class="muted">Not yet signed.</p>`}
        ${plan.activated_at ? html`<p class="small muted">Activated ${fmtTimestamp(plan.activated_at)}.</p>` : ""}
      </section>
      <footer class="print-foot small muted">Printed ${fmtTimestamp(new Date().toISOString().replace("T", " ").slice(0, 19))} by ${req.user.name} · Confidential health information</footer>
    </article>` }));
});

module.exports = { router, activePlanFor, loadTree, copyPlan, snapshotDiagnoses, progressPct, objectiveMeasure, activationCheck, ASAM_DIMS, ASAM_LEVELS };
