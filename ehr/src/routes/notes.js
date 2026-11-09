"use strict";
/*
 * Clinical documentation: progress (DAP/SOAP), intake, psychiatry, psychotherapy (private),
 * contact and discharge notes. Drafts are editable by their author only; signing requires
 * re-entering the password and makes the note immutable (addenda are append-only).
 */
const express = require("express");
const { requirePerm, verifyPassword } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { tx } = require("../db");
const {
  html, raw, page, chartPage, notFound, csrfField, select, badge, getPatient, patientName,
  today, fmtDate, fmtTime, fmtTimestamp, humanize,
} = require("../views");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Templates                                                          */
/* ------------------------------------------------------------------ */
const RISK_LEVELS = ["none", "low", "moderate", "high"];
const INTERVENTIONS = ["CBT", "DBT skills", "Motivational interviewing", "Psychoeducation", "EMDR", "Supportive",
  "Mindfulness", "Family systems", "Safety planning"];
const MSE = [
  ["appearance", "Appearance"], ["behavior", "Behavior"], ["speech", "Speech"], ["mood", "Mood"], ["affect", "Affect"],
  ["thought_process", "Thought process"], ["thought_content", "Thought content"], ["perception", "Perception"],
  ["cognition", "Cognition"], ["insight", "Insight"], ["judgment", "Judgment"],
];
const MAX_TEXT = 20000;
/** A group of checkboxes stored as an array of chosen option labels (+ optional "other" text). */
const checks = (key, label, options, { other = false, hint = "", required = false } = {}) => ({ kind: "checks", key, label, options, other, hint, required });

// Supportive housing (HUD terminology; verify against your Continuum of Care's requirements)
const HOUSING_STATUS = [
  { value: "", label: "Select…" },
  { value: "unsheltered", label: "Literally homeless: unsheltered (street, vehicle, place not meant for habitation)" },
  { value: "emergency_shelter", label: "Literally homeless: emergency shelter or safe haven" },
  { value: "transitional", label: "Transitional housing" },
  { value: "institution", label: "Institution (hospital, jail, treatment facility), 90 days or less" },
  { value: "fleeing_dv", label: "Fleeing or attempting to flee domestic violence" },
  { value: "imminent_risk", label: "Imminent risk of losing housing (within 14 days)" },
  { value: "doubled_up", label: "Staying with family or friends (doubled up / couch surfing)" },
  { value: "unstable_rental", label: "Renting, at risk (behind on rent, eviction notice)" },
  { value: "stable", label: "Stably housed" },
];
const CHRONIC = [
  { value: "", label: "Select…" },
  { value: "yes_continuous", label: "Yes: homeless continuously for 12+ months" },
  { value: "yes_episodes", label: "Yes: 4+ episodes in the last 3 years totaling 12+ months" },
  { value: "no", label: "No / does not meet the time requirement" },
  { value: "unknown", label: "Unknown, needs verification" },
];
const HOUSING_INCOME = ["Employment", "SSI", "SSDI", "TANF", "Unemployment", "VA benefits", "Child support", "Pension / retirement", "No income"];
const HOUSING_BENEFITS = ["Medicaid", "Medicare", "SNAP", "WIC", "Housing Choice Voucher (Section 8)", "VA health care"];
const HOUSING_DOCS = ["Photo ID", "Social Security card", "Birth certificate", "Income verification", "Disability verification (licensed professional)",
  "Homelessness verification (third party / HMIS)", "Release of information for the Continuum of Care"];
const HOUSING_BARRIERS = ["Prior eviction(s)", "Criminal history", "Poor or no credit / rental history", "Unpaid utility debt", "No income",
  "Active substance use", "Untreated mental health symptoms", "Physical disability / accessibility needs", "Pets / service animal",
  "Large household", "Sex offender registry", "Undocumented status"];
const TENANCY_SUPPORTS = ["Budgeting and paying rent", "Landlord relationships and lease compliance", "Housekeeping and unit upkeep",
  "Medication management", "Connecting to health care", "Substance use treatment", "Mental health treatment", "Benefits enrollment",
  "Employment / education", "Transportation", "Community integration", "Crisis and eviction prevention"];
const HOUSING_REFERRALS = ["Coordinated Entry (CoC) assessment", "Permanent supportive housing (PSH)", "Rapid re-housing", "Housing Choice Voucher waitlist",
  "Emergency shelter", "Transitional housing", "Recovery housing", "Landlord / tenant legal aid", "Rental or utility assistance", "SOAR (SSI/SSDI application help)"];


const ta = (key, label, required = false, hint = "") => ({ kind: "textarea", key, label, required, hint });
const tx1 = (key, label, required = false, hint = "") => ({ kind: "text", key, label, required, hint });
const SESSION = { kind: "session", key: "session" };
const INTERV = { kind: "interventions", key: "interventions" };
const RISK = { kind: "risk", key: "risk" };
const MSE_F = { kind: "mse", key: "mse" };
const sel = (key, label, options, required = false, hint = "") => ({ kind: "select", key, label, options, required, hint });
const dt = (key, label, required = false, hint = "") => ({ kind: "date", key, label, required, hint });
/**
 * A 0-4 risk rating plus narrative (used for ASAM dimensions). `labels` maps ASAM edition -> label;
 * `driver` adds a "dimensional driver of level of care" checkbox.
 */
const rated = (key, labels, { driver = false, hint = "" } = {}) =>
  ({ kind: "rated", key, labels, label: labels["3"], required: true, driver, hint });
const ASAM_RATINGS = [
  { value: "", label: "Select…" }, { value: "0", label: "0: No risk / stable" }, { value: "1", label: "1: Mild" },
  { value: "2", label: "2: Moderate" }, { value: "3", label: "3: Significant" }, { value: "4", label: "4: Severe / imminent" },
];
const ASAM_EDITIONS = [{ value: "4", label: "4th edition (2023)" }, { value: "3", label: "3rd edition (2013)" }];
/** Notes saved before the edition field existed were written against the 3rd edition. */
const asamEdition = (c) => (c && c.asam_edition === "4" ? "4" : "3");
/**
 * Level-of-care options. `editions` limits where a level is selectable. Names are generic; verify them
 * against the licensed ASAM Criteria text. "2.5_php" keeps the 3rd-edition partial hospitalization level
 * distinct from the 4th-edition 2.5 (high-intensity outpatient).
 */
const ASAM_LEVEL_OPTIONS = [
  { value: "0.5", label: "0.5 Early intervention", editions: ["3", "4"] },
  { value: "1.0", label: "1.0 Long-term remission monitoring", editions: ["4"] },
  { value: "1", label: "1 Outpatient services (3rd edition)", editions: ["3"] },
  { value: "1.5", label: "1.5 Outpatient therapy", editions: ["4"] },
  { value: "1.7", label: "1.7 Medically managed outpatient", editions: ["4"] },
  { value: "2.1", label: "2.1 Intensive outpatient (IOP)", editions: ["3", "4"] },
  { value: "2.5", label: "2.5 High-intensity outpatient", editions: ["4"] },
  { value: "2.5_php", label: "2.5 Partial hospitalization (3rd edition)", editions: ["3"] },
  { value: "2.7", label: "2.7 Medically managed intensive outpatient", editions: ["4"] },
  { value: "3.1", label: "3.1 Clinically managed low-intensity residential", editions: ["3", "4"] },
  { value: "3.3", label: "3.3 Clinically managed population-specific high-intensity residential (3rd edition)", editions: ["3"] },
  { value: "3.5", label: "3.5 Clinically managed high-intensity residential", editions: ["3", "4"] },
  { value: "3.7", label: "3.7 Medically managed residential", editions: ["3", "4"] },
  { value: "4", label: "4 Medically managed intensive inpatient", editions: ["3", "4"] },
];
const ASAM_LEVEL_HINT = "Level names are generic; verify them against your licensed copy of The ASAM Criteria.";
/** Edition-aware level-of-care select. */
const level = (key, label, required = false, hint = "") => ({ kind: "asam_level", key, label, required, hint });
/** Fields from earlier template versions: never on the form, shown on the read view when a note has them. */
const legacy = (key, label, options = null) => ({ kind: "legacy", key, label, options });
/** 3rd-edition-era single "recommended level" (notes written before indicated/adjusted levels). */
const LEGACY_ASAM_LEVELS = [
  { value: "0.5", label: "0.5 Early intervention" },
  { value: "1", label: "1 Outpatient services" },
  { value: "2.1", label: "2.1 Intensive outpatient (IOP)" },
  { value: "2.5", label: "2.5 Partial hospitalization (PHP)" },
  { value: "3.1", label: "3.1 Clinically managed low-intensity residential" },
  { value: "3.3", label: "3.3 Clinically managed population-specific high-intensity residential" },
  { value: "3.5", label: "3.5 Clinically managed high-intensity residential" },
  { value: "3.7", label: "3.7 Medically monitored intensive inpatient" },
  { value: "4", label: "4 Medically managed intensive inpatient" },
];
const ROI_DIRECTIONS = [
  { value: "", label: "Select…" }, { value: "release_to", label: "Release information TO this recipient" },
  { value: "obtain_from", label: "Obtain information FROM this source" }, { value: "exchange", label: "Exchange information both ways" },
];
const YES_NO = [{ value: "", label: "Select…" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const CONSENT_METHODS = [
  { value: "", label: "Select…" }, { value: "signed_paper", label: "Signed paper form (scanned / on file)" },
  { value: "signed_electronic", label: "Signed electronically" }, { value: "guardian", label: "Signed by parent / legal guardian" },
];

const TYPES = {
  progress: {
    label: "Progress note",
    formats: {
      dap: [SESSION, ta("data", "Data", true, "What the client said and did; observations."),
        ta("assessment", "Assessment", true, "Clinical interpretation and progress toward goals."),
        ta("plan", "Plan", true, "Next steps, homework, next session."), INTERV, RISK],
      soap: [SESSION, ta("subjective", "Subjective", true, "Client's report in their words."),
        ta("objective", "Objective", true, "Observations, measures, presentation."),
        ta("assessment", "Assessment", true), ta("plan", "Plan", true), INTERV, RISK],
    },
  },
  intake: {
    label: "Intake assessment",
    formats: {
      intake: [ta("presenting_problem", "Presenting problem", true), ta("hpi", "History of present illness", true),
        ta("psychiatric_history", "Psychiatric history"), ta("substance_use", "Substance use"),
        ta("medical_history", "Medical history"), ta("family_social_history", "Family / social history"),
        MSE_F, RISK, ta("diagnostic_impression", "Diagnostic impression", true),
        ta("recommendations", "Recommendations", true)],
    },
  },
  psychiatry: {
    label: "Psychiatry note",
    formats: {
      soap: [ta("chief_complaint", "Chief complaint", true), ta("interval_history", "Interval history", true),
        ta("medication_response", "Medication response / side effects"), MSE_F, RISK,
        ta("assessment", "Assessment", true), ta("plan_medications", "Plan: medication changes", true),
        ta("plan_labs", "Plan: labs"), ta("plan_followup", "Plan: follow-up", true)],
    },
  },
  psychotherapy: {
    label: "Psychotherapy note (private)",
    formats: { narrative: [ta("process_notes", "Process notes", true)] },
  },
  contact: {
    label: "Contact note",
    formats: {
      narrative: [tx1("contact_with", "Contact with / method", true, "e.g. Patient by phone; collateral (parent) by phone."),
        ta("narrative", "Narrative", true)],
    },
  },
  group: {
    label: "Group note",
    formats: {
      group: [tx1("group_name", "Group name", true, "e.g. DBT skills group, Anxiety group."), tx1("group_topic", "Session topic", true),
        SESSION, tx1("attendance", "Attendance", false, "e.g. 7 of 9 members present. Don't name other members."),
        ta("group_content", "Group content", true, "What was covered this session."),
        ta("participation", "Client participation and response", true, "This client's engagement, contributions and response."),
        INTERV, ta("plan", "Plan", true), RISK],
    },
  },
  safety_plan: {
    label: "Crisis safety plan",
    formats: {
      safety_plan: [
        ta("warning_signs", "1. Warning signs", true, "Thoughts, moods, situations or behaviors that signal a crisis may be developing."),
        ta("coping_strategies", "2. Things I can do on my own to cope", true, "Activities that help without contacting anyone."),
        ta("distractions", "3. People and places that help distract me"),
        ta("help_contacts", "4. People I can ask for help", true, "Names and phone numbers."),
        ta("professional_contacts", "5. Professionals and crisis lines", true, "Clinician, after-hours line, 988, nearest emergency department."),
        ta("means_safety", "6. Making my environment safer", true, "Steps to limit access to lethal means (medications, firearms, etc.)."),
        ta("reasons_for_living", "Reasons for living", false, "What matters most to the client."),
        tx1("copy_given", "Copy given to client", false, "e.g. Printed copy given; photo on phone."), RISK],
    },
  },
  asam: {
    label: "ASAM level of care assessment",
    formats: {
      asam: [
        { kind: "edition", key: "asam_edition", label: "ASAM Criteria edition" },
        ta("substance_history", "Substance use history", true, "Substances, route, frequency, amount, last use, prior treatment."),
        rated("dim1", { 4: "Dimension 1: Intoxication, Withdrawal & Addiction Medications",
          3: "Dimension 1: Acute intoxication and/or withdrawal potential" }, { driver: true }),
        rated("dim2", { 4: "Dimension 2: Biomedical Conditions", 3: "Dimension 2: Biomedical conditions and complications" }, { driver: true }),
        rated("dim3", { 4: "Dimension 3: Psychiatric & Cognitive Conditions",
          3: "Dimension 3: Emotional, behavioral or cognitive conditions" }, { driver: true }),
        rated("dim4", { 4: "Dimension 4: Substance Use-Related Risks", 3: "Dimension 4: Readiness to change" }, { driver: true }),
        rated("dim5", { 4: "Dimension 5: Recovery Environment Interactions",
          3: "Dimension 5: Relapse, continued use or continued problem potential" }, { driver: true }),
        rated("dim6", { 4: "Dimension 6: Person-Centered Considerations", 3: "Dimension 6: Recovery / living environment" }, { driver: true }),
        level("indicated_level", "Indicated level of care", true, "The level the dimensional assessment points to."),
        level("adjusted_level", "Adjusted level of care (after Person-Centered Considerations / shared decision-making)", false,
          "Leave blank if the same as the indicated level."),
        ta("level_difference_reason", "Reason indicated and adjusted levels differ", false,
          "Required to sign when the levels differ, e.g. client preference, availability, payer, safety."),
        ta("level_justification", "Justification", true, "How the dimensional ratings and drivers support the indicated level."),
        legacy("recommended_level", "Recommended level of care", LEGACY_ASAM_LEVELS),
        legacy("actual_level", "Level of care client will receive (if different)"),
        RISK],
    },
  },
  roi: {
    label: "Release of information (consent)",
    formats: {
      roi: [
        sel("direction", "Direction", ROI_DIRECTIONS, true),
        tx1("recipient", "Recipient / source", true, "Name, organization, address or fax."),
        ta("information", "Specific information covered", true, "e.g. Dates of attendance, diagnosis, treatment summary. Be as narrow as possible."),
        tx1("purpose", "Purpose", true, "e.g. Coordination of care with primary care provider."),
        dt("expires_on", "Expires on", true, "Date or event when consent ends."),
        sel("includes_sud", "Includes substance use disorder records (42 CFR Part 2)?", YES_NO, true),
        sel("consent_method", "How consent was obtained", CONSENT_METHODS, true),
        tx1("signed_by", "Signed by", true, "Client name, or guardian name and relationship."),
        dt("signed_on", "Date signed", true),
        ta("revocation", "Revocation", false, "Leave blank unless the client revokes; record date and how."),
      ],
    },
  },
  supportive_housing: {
    label: "Supportive housing assessment",
    formats: {
      supportive_housing: [
        sel("housing_status", "Current living situation", HOUSING_STATUS, true),
        tx1("housing_location", "Where the client is staying now", false, "General location only; no exact address needed for unsheltered clients."),
        ta("housing_history", "Housing history", true, "Recent housing, how housing was lost, number of episodes and length of homelessness."),
        sel("chronic_homelessness", "Meets HUD chronic homelessness time criteria?", CHRONIC, true),
        sel("disabling_condition", "Has a disabling condition (mental health, substance use, physical, developmental, HIV/AIDS)?", YES_NO, true),
        ta("disability_detail", "Disabling condition details", false, "Diagnoses and functional impact relevant to housing; needed for PSH disability verification."),
        tx1("household", "Household composition", false, "Adults, children, pets / service animal."),
        checks("income_sources", "Income sources", HOUSING_INCOME, { other: true }),
        tx1("monthly_income", "Approximate monthly household income", false, "e.g. $943"),
        checks("benefits", "Benefits", HOUSING_BENEFITS, { other: true }),
        checks("documents", "Documents on file", HOUSING_DOCS, { other: true, hint: "Tick what the client already has; the rest go in next steps." }),
        checks("barriers", "Housing barriers", HOUSING_BARRIERS, { other: true }),
        ta("preferences", "Housing preferences", false, "Area, accessibility, roommates, pets, proximity to services, transportation."),
        checks("tenancy_supports", "Tenancy supports needed to obtain and keep housing", TENANCY_SUPPORTS, { other: true, required: true }),
        ta("strengths", "Strengths and natural supports", false),
        sel("coc_consent", "Consent to share with the Continuum of Care / HMIS on file?", YES_NO, true),
        checks("referrals", "Referrals made", HOUSING_REFERRALS, { other: true }),
        ta("plan", "Housing plan and next steps", true, "Who does what by when, including documents to obtain."),
        RISK],
    },
  },
  discharge: {
    label: "Discharge summary",
    formats: {
      narrative: [ta("discharge_reason", "Reason for discharge", true), ta("treatment_summary", "Summary of treatment", true),
        ta("discharge_status", "Status at discharge", true), ta("recommendations", "Recommendations / referrals", true)],
    },
  },
};
const TYPE_KEYS = Object.keys(TYPES);

function formatsFor(type) { return Object.keys(TYPES[type].formats); }
function fieldsFor(type, format) {
  const t = TYPES[type];
  return t.formats[format] || t.formats[formatsFor(type)[0]];
}
const typeLabel = (n) => (TYPES[n.type] ? TYPES[n.type].label : humanize(n.type)) +
  (n.type === "progress" ? ` (${String(n.format).toUpperCase()})` : "");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const str = (v) => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")).trim().slice(0, MAX_TEXT);
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map(String);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z"));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const parseContent = (n) => { try { return JSON.parse(n.content || "{}") || {}; } catch { return {}; } };
const userLine = (u) => (u ? `${u.name}${u.credentials ? `, ${u.credentials}` : ""}` : "Unknown");

function deny(req, res, message) {
  audit(req, "forbidden", null, null, null, `${req.method} ${req.originalUrl}`);
  res.status(403).send(page(req, { title: "Not permitted", active: "notes",
    body: html`<div class="card"><h1>Not permitted</h1><p>${message}</p><p><a href="/ehr/notes">Back to my notes</a></p></div>` }));
}

/** Psychotherapy notes are visible to their author only (admins included in the restriction). */
function canView(user, note) {
  if (!can(user, "clinical:read")) return false;
  return note.type !== "psychotherapy" || note.author_id === user.id;
}

function loadNote(req, res) {
  const id = Number(req.params.noteId);
  if (!Number.isInteger(id) || id <= 0) { notFound(req, res, "Note"); return null; }
  const note = req.db.prepare(
    `SELECT n.*, u.name AS author_name, u.credentials AS author_credentials,
            s.name AS signer_name, s.credentials AS signer_credentials
     FROM notes n JOIN users u ON u.id = n.author_id LEFT JOIN users s ON s.id = n.signed_by WHERE n.id = ?`).get(id);
  if (!note) { notFound(req, res, "Note"); return null; }
  if (!canView(req.user, note)) {
    deny(req, res, note.type === "psychotherapy"
      ? "Psychotherapy notes are private to the clinician who wrote them."
      : "Your role doesn't have access to clinical notes.");
    return null;
  }
  const patient = getPatient(req, note.patient_id);
  if (!patient) { notFound(req, res, "Patient"); return null; }
  return { note, patient };
}

function loadPatient(req, res) {
  const patient = getPatient(req, req.params.id);
  if (!patient) { notFound(req, res, "Patient"); return null; }
  return patient;
}

function loadAppointment(req, patientId, raw) {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) return { appt: null, error: raw ? "Invalid appointment." : null };
  const appt = req.db.prepare("SELECT * FROM appointments WHERE id = ? AND patient_id = ?").get(id, patientId);
  return appt ? { appt, error: null } : { appt: null, error: "That appointment doesn't belong to this patient." };
}

/* ------------------------------------------------------------------ */
/* Golden thread: treatment plan objectives addressed by a note       */
/* ------------------------------------------------------------------ */
const PLAN_LINKED_TYPES = ["progress", "group", "psychiatry"];
const OBJ_PROGRESS = [
  { value: "progressing", label: "Progressing" }, { value: "no_change", label: "No change" },
  { value: "regressed", label: "Regressed" }, { value: "met", label: "Met" },
];
const MAX_OBJ_COMMENT = 500;
const NO_PLAN_MSG = "No active treatment plan. Payers expect a plan before ongoing therapy.";
/** Ongoing-therapy notes can't be written until the patient has an active (signed) treatment plan. */
const PLAN_REQUIRED_TYPES = ["progress", "group"];
const PLAN_REQUIRED_MSG = "A signed, active treatment plan is required before progress or group notes can be written for this patient.";
const planRequiredFor = (db, type, patientId) => PLAN_REQUIRED_TYPES.includes(type) && !activePlan(db, patientId).hasPlan;

function planRequiredPage(req, res, patient, type) {
  audit(req, "blocked", "note", null, patient.id, `${type} note: no active treatment plan`);
  return res.status(409).send(chartPage(req, patient, "notes", html`
    <section class="card card--alert" role="alert">
      <h2>Treatment plan required</h2>
      <p>${PLAN_REQUIRED_MSG}</p>
      <p class="muted">Document the intake assessment, then create the treatment plan with the client and sign it.
        Intake, crisis safety plan, contact, ASAM, psychiatry and release-of-information notes can still be written.</p>
      <div class="row">
        ${can(req.user, "clinical:write") ? html`<a class="btn btn--primary" href="/ehr/patients/${patient.id}/treatment-plan">Go to treatment plan</a>
        <a class="btn" href="/ehr/patients/${patient.id}/notes/new?type=intake">Write intake assessment</a>` : ""}
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/notes">Back to notes</a>
      </div>
    </section>`, { title: "Treatment plan required" }));
}
const OBJ_SIGN_MSG = "Select at least one treatment plan objective addressed in this session.";

/** The patient's active plan(s) and their objectives, ordered problem > goal > objective. */
function activePlan(db, patientId) {
  const plans = db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id").all(patientId);
  if (!plans.length) return { hasPlan: false, objectives: [] };
  const objectives = db.prepare(
    `SELECT o.id, o.text, o.status, o.target_date, g.goal_text, pr.title AS problem_title
     FROM treatment_plans tp
     JOIN plan_problems pr ON pr.plan_id = tp.id
     JOIN plan_goals g ON g.problem_id = pr.id
     JOIN plan_objectives o ON o.goal_id = g.id
     WHERE tp.patient_id = ? AND tp.status = 'active' AND o.status <> 'discontinued'
     ORDER BY tp.id, pr.sort, pr.id, g.sort, g.id, o.sort, o.id`).all(patientId);
  return { hasPlan: true, objectives };
}

/** Objectives linked to a note (whatever plan they belong to now), for display. */
function noteObjectives(db, noteId) {
  return db.prepare(
    `SELECT no.objective_id, no.progress, no.comment, o.text, o.status, o.target_date, g.goal_text, pr.title AS problem_title
     FROM note_objectives no
     JOIN plan_objectives o ON o.id = no.objective_id
     JOIN plan_goals g ON g.id = o.goal_id
     JOIN plan_problems pr ON pr.id = g.problem_id
     WHERE no.note_id = ? ORDER BY pr.sort, pr.id, g.sort, g.id, o.sort, o.id`).all(noteId);
}

/** Stored links as the form's value map { [objectiveId]: { progress, comment } }. */
function objectiveValues(db, noteId) {
  const out = {};
  for (const r of db.prepare("SELECT objective_id, progress, comment FROM note_objectives WHERE note_id = ?").all(noteId)) {
    out[r.objective_id] = { progress: r.progress || "", comment: r.comment || "" };
  }
  return out;
}

/**
 * Read "objective addressed" selections (obj_<id>_addressed / _progress / _comment) and validate them
 * against the patient's active plan. Returns { selected: { [id]: {progress, comment} }, error }.
 */
function readObjectives(db, body, patientId) {
  const selected = {};
  let error = null;
  const allowed = new Set(activePlan(db, patientId).objectives.map((o) => o.id));
  for (const k of Object.keys(body || {})) {
    const m = k.match(/^obj_(\d+)_addressed$/);
    if (!m) continue;
    const id = Number(m[1]);
    if (!allowed.has(id)) { error = "One or more selected objectives aren't on this patient's active treatment plan."; continue; }
    const progress = str(body[`obj_${id}_progress`]);
    if (progress && !OBJ_PROGRESS.some((o) => o.value === progress)) { error = "Choose a valid progress rating for each objective."; continue; }
    selected[id] = { progress, comment: str(body[`obj_${id}_comment`]).slice(0, MAX_OBJ_COMMENT) };
  }
  return { selected, error };
}

/** Replace a draft note's objective links. Caller ensures the note is a draft. */
function saveObjectives(db, noteId, selected) {
  db.prepare("DELETE FROM note_objectives WHERE note_id = ?").run(noteId);
  const ins = db.prepare("INSERT INTO note_objectives (note_id, objective_id, progress, comment) VALUES (?, ?, ?, ?)");
  for (const [id, v] of Object.entries(selected)) ins.run(noteId, Number(id), v.progress || null, v.comment || null);
}

/** Read submitted form fields into { content, risk_level, service_date } plus validation errors (draft-level). */
function readForm(body, type, format, prev = {}) {
  const content = {};
  const errors = {};
  let risk_level = null;
  for (const f of fieldsFor(type, format)) {
    if (f.kind === "textarea" || f.kind === "text") content[f.key] = str(body[f.key]);
    else if (f.kind === "edition") {
      const v = str(body[f.key]);
      if (v && !ASAM_EDITIONS.some((o) => o.value === v)) errors[f.key] = "Choose an ASAM Criteria edition.";
      else content[f.key] = v || "4";
    } else if (f.kind === "asam_level") {
      const v = str(body[f.key]);
      const ed = asamEdition(content);
      const opt = ASAM_LEVEL_OPTIONS.find((o) => o.value === v);
      if (v && !opt) errors[f.key] = `Choose a valid option for ${f.label}.`;
      else if (opt && !opt.editions.includes(ed)) errors[f.key] = `${opt.label} isn't a level in the ${ed === "4" ? "4th" : "3rd"} edition.`;
      else content[f.key] = v;
    } else if (f.kind === "legacy") {
      // Not on the form; carry forward whatever an older draft already had.
      if (prev[f.key] !== undefined && prev[f.key] !== "") content[f.key] = prev[f.key];
    }
    else if (f.kind === "select") {
      const v = str(body[f.key]);
      if (v && !f.options.some((o) => o.value === v)) errors[f.key] = `Choose a valid option for ${f.label}.`;
      else content[f.key] = v;
    } else if (f.kind === "date") {
      const v = str(body[f.key]);
      if (v && !isDate(v)) errors[f.key] = "Use YYYY-MM-DD.";
      else content[f.key] = v;
    } else if (f.kind === "rated") {
      const r = str(body[`${f.key}_rating`]);
      if (r && !/^[0-4]$/.test(r)) errors[`${f.key}_rating`] = "Choose a rating from 0 to 4.";
      else content[`${f.key}_rating`] = r;
      content[f.key] = str(body[f.key]);
      if (f.driver) content[`${f.key}_driver`] = str(body[`${f.key}_driver`]) ? "1" : "";
    } else if (f.kind === "session") {
      content.session_start = str(body.session_start);
      content.session_end = str(body.session_end);
      if (content.session_start && !isTime(content.session_start)) errors.session_start = "Use HH:MM.";
      if (content.session_end && !isTime(content.session_end)) errors.session_end = "Use HH:MM.";
      if (!errors.session_start && !errors.session_end && content.session_start && content.session_end &&
          content.session_end <= content.session_start) errors.session_end = "End time must be after start time.";
    } else if (f.kind === "checks") {
      const chosen = arr(body[f.key]);
      content[f.key] = f.options.filter((o) => chosen.includes(o));
      if (f.other) content[`${f.key}_other`] = str(body[`${f.key}_other`]).slice(0, 500);
    } else if (f.kind === "interventions") {
      const chosen = arr(body.interventions);
      content.interventions = INTERVENTIONS.filter((i) => chosen.includes(i));
      content.interventions_other = str(body.interventions_other).slice(0, 500);
    } else if (f.kind === "mse") {
      for (const [k] of MSE) content[`mse_${k}`] = str(body[`mse_${k}`]).slice(0, 2000);
    } else if (f.kind === "risk") {
      const r = str(body.risk_level);
      if (r && !RISK_LEVELS.includes(r)) errors.risk_level = "Choose a risk level.";
      else risk_level = r || null;
      content.risk_narrative = str(body.risk_narrative);
    }
  }
  const service_date = str(body.service_date);
  if (!service_date) errors.service_date = "Service date is required.";
  else if (!isDate(service_date)) errors.service_date = "Use YYYY-MM-DD.";
  return { content, risk_level, service_date, errors };
}

/** Requirements for signing. Returns { key: message }. */
function signErrors(note, { planObjectiveCount = 0, addressedCount = 0 } = {}) {
  const c = parseContent(note);
  const errors = {};
  const empty = (v) => !v || (Array.isArray(v) ? v.length === 0 : !String(v).trim());
  const ed = asamEdition(c);
  for (const f of fieldsFor(note.type, note.format)) {
    if (["textarea", "text", "select", "date", "asam_level"].includes(f.kind) && f.required && empty(c[f.key])) errors[f.key] = `${f.label} is required.`;
    if (f.kind === "rated") {
      const label = f.labels[ed];
      if (empty(c[`${f.key}_rating`])) errors[`${f.key}_rating`] = `${label}: rating is required.`;
      if (empty(c[f.key])) errors[f.key] = `${label}: narrative is required.`;
    }
    if (f.kind === "session") {
      if (empty(c.session_start)) errors.session_start = "Session start time is required.";
      if (empty(c.session_end)) errors.session_end = "Session end time is required.";
    }
    if (f.kind === "checks" && f.required && empty(c[f.key]) && empty(c[`${f.key}_other`])) {
      errors[f.key] = `${f.label}: select at least one.`;
    }
    if (f.kind === "interventions" && empty(c.interventions) && empty(c.interventions_other)) {
      errors.interventions = "Select at least one intervention used.";
    }
    if (f.kind === "risk") {
      if (!note.risk_level) errors.risk_level = "Risk level is required.";
      else if (["moderate", "high"].includes(note.risk_level) && empty(c.risk_narrative)) {
        errors.risk_narrative = "A risk narrative is required when risk is moderate or high.";
      }
    }
  }
  if (note.type === "asam" && !empty(c.adjusted_level) && !empty(c.indicated_level) &&
      c.adjusted_level !== c.indicated_level && empty(c.level_difference_reason)) {
    errors.level_difference_reason = "Explain why the adjusted level of care differs from the indicated level.";
  }
  // Golden thread: with an active plan that has objectives, a session note must say which it addressed.
  if (PLAN_LINKED_TYPES.includes(note.type) && planObjectiveCount > 0 && addressedCount < 1) errors.objectives = OBJ_SIGN_MSG;
  if (!note.service_date) errors.service_date = "Service date is required.";
  return errors;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */
function errorSummary(errors) {
  const list = Object.values(errors || {});
  if (!list.length) return "";
  return html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong>
    <ul class="list">${list.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}
const errText = (errors, k) => (errors && errors[k] ? html`<span class="error-text">${errors[k]}</span>` : "");
const req_ = (f) => (f.required ? html` <span class="hint">(required to sign)</span>` : "");

function roiNotice(includesSud) {
  return html`<div class="alert alert--info" role="note"><strong>Client rights for this consent.</strong>
    The client may revoke this consent at any time, in writing, except where action has already been taken on it.
    Treatment, payment and eligibility are not conditioned on signing. Release only the minimum information needed.
    ${includesSud ? html`<br><strong>42 CFR Part 2:</strong> Records of substance use disorder treatment are protected by federal
    confidentiality rules. Any disclosure must be accompanied by the required notice prohibiting further redisclosure,
    and this consent must meet Part 2 content requirements. Confirm your form with your compliance officer.` : ""}</div>`;
}

function psychotherapyNotice() {
  return html`<div class="alert alert--info" role="note"><strong>Psychotherapy notes are private.</strong>
    Under HIPAA, psychotherapy notes (process notes) are kept separate from the medical record. Only you, the author,
    can view this note; it is not shown to other clinicians or administrators and is not released with the record.
    Document diagnosis, risk, interventions and progress in a progress note instead.</div>`;
}

/**
 * Dimension label for both editions; CSS shows the one matching the edition select (the server-side
 * `hidden` attribute picks the initial one so it reads correctly without :has() support).
 */
function edLabel(f, v) {
  const ed = asamEdition(v);
  return html`<span class="asam-ed4" ${ed === "4" ? "" : raw("hidden")}>${f.labels["4"]}</span><span class="asam-ed3" ${ed === "3" ? "" : raw("hidden")}>${f.labels["3"]}</span>`;
}

/** "Treatment plan objectives addressed" fieldset for progress / group / psychiatry notes. */
function objectivesFieldset(patient, plan, selected, errors) {
  if (!plan.hasPlan) {
    return html`<div class="alert alert--info span-all" role="note">${NO_PLAN_MSG}
      <a href="/ehr/patients/${patient.id}/treatment-plan">Open the treatment plan</a></div>`;
  }
  let lastProblem = null;
  let lastGoal = null;
  return html`<fieldset class="span-all objectives-addressed"><legend>Treatment plan objectives addressed</legend>
    ${errText(errors, "objectives")}
    ${plan.objectives.length ? html`<p class="hint">Tick each objective worked on this session and rate progress. This records an observation only; objective status changes at plan review.</p>
      <ul class="list-plain obj-list">${plan.objectives.map((o) => {
        const sel = selected[o.id];
        const head = o.problem_title !== lastProblem || o.goal_text !== lastGoal
          ? html`<p class="obj-path"><strong>${o.problem_title}</strong> › ${o.goal_text}</p>` : "";
        lastProblem = o.problem_title; lastGoal = o.goal_text;
        return html`<li class="obj-item">${head}
          <label class="check"><input type="checkbox" name="obj_${o.id}_addressed" value="1" ${sel ? raw("checked") : ""}>
            <span>${o.text} <span class="muted">· ${o.target_date ? html`target ${fmtDate(o.target_date)} · ` : ""}status: ${humanize(o.status)}</span></span></label>
          <div class="obj-fields">
            <label>Progress ${select(`obj_${o.id}_progress`, [{ value: "", label: "Select…" }, ...OBJ_PROGRESS], sel ? sel.progress : "")}</label>
            <label>Comment <input type="text" name="obj_${o.id}_comment" value="${sel ? sel.comment : ""}" maxlength="${MAX_OBJ_COMMENT}"></label>
          </div></li>`;
      })}</ul>`
      : html`<p class="muted">The active treatment plan has no measurable objectives yet.
        <a href="/ehr/patients/${patient.id}/treatment-plan">Add objectives to the plan</a></p>`}
  </fieldset>`;
}

function fieldInputs(type, format, v, errors) {
  return fieldsFor(type, format).map((f) => {
    if (f.kind === "textarea") {
      return html`<label class="span-all">${f.label}${req_(f)}${f.hint ? html` <span class="hint">${f.hint}</span>` : ""}
        <textarea name="${f.key}" rows="5">${v[f.key] || ""}</textarea>${errText(errors, f.key)}</label>`;
    }
    if (f.kind === "text") {
      return html`<label class="span-all">${f.label}${req_(f)}${f.hint ? html` <span class="hint">${f.hint}</span>` : ""}
        <input type="text" name="${f.key}" value="${v[f.key] || ""}" maxlength="500">${errText(errors, f.key)}</label>`;
    }
    if (f.kind === "select") {
      return html`<label class="span-all">${f.label}${req_(f)}${f.hint ? html` <span class="hint">${f.hint}</span>` : ""}
        ${select(f.key, f.options, v[f.key])}${errText(errors, f.key)}</label>`;
    }
    if (f.kind === "date") {
      return html`<label>${f.label}${req_(f)}${f.hint ? html` <span class="hint">${f.hint}</span>` : ""}
        <input type="date" name="${f.key}" value="${v[f.key] || ""}">${errText(errors, f.key)}</label>`;
    }
    if (f.kind === "edition") {
      return html`<label class="span-all">${f.label}
        <span class="hint">Dimension names and level options follow the edition. Saved notes keep the edition they were written in.</span>
        ${select(f.key, ASAM_EDITIONS, asamEdition(v))}${errText(errors, f.key)}</label>`;
    }
    if (f.kind === "asam_level") {
      const ed = asamEdition(v);
      return html`<label class="span-all">${f.label}${req_(f)}${f.hint ? html` <span class="hint">${f.hint}</span>` : ""}
        <select name="${f.key}" id="${f.key}"><option value="">Select…</option>${ASAM_LEVEL_OPTIONS.map((o) => {
          const cls = o.editions.length === 2 ? "" : `asam-ed${o.editions[0]}`;
          return html`<option value="${o.value}" class="${cls}" ${o.value === v[f.key] ? raw("selected") : ""} ${o.editions.includes(ed) ? "" : raw("hidden")}>${o.label}</option>`;
        })}</select>
        ${f.key === "indicated_level" ? html`<span class="hint">${ASAM_LEVEL_HINT}</span>` : ""}${errText(errors, f.key)}</label>`;
    }
    if (f.kind === "legacy") {
      const val = v[f.key];
      if (val === undefined || val === null || String(val).trim() === "") return "";
      const o = f.options ? f.options.find((x) => x.value === val) : null;
      return html`<p class="span-all hint">Recorded before the template update. ${f.label}: <strong>${o ? o.label : val}</strong></p>`;
    }
    if (f.kind === "rated") {
      return html`<fieldset class="span-all"><legend>${edLabel(f, v)}</legend><div class="form-grid">
        <label>Risk rating <span class="hint">(required to sign)</span>${select(`${f.key}_rating`, ASAM_RATINGS, v[`${f.key}_rating`])}${errText(errors, `${f.key}_rating`)}</label>
        ${f.driver ? html`<label class="check"><input type="checkbox" name="${f.key}_driver" value="1" ${v[`${f.key}_driver`] ? raw("checked") : ""}> Dimensional driver of level of care</label>` : ""}
        <label class="span-all">Findings <span class="hint">(required to sign)</span><textarea name="${f.key}" rows="3">${v[f.key] || ""}</textarea>${errText(errors, f.key)}</label>
      </div></fieldset>`;
    }
    if (f.kind === "session") {
      return html`
        <label>Session start <span class="hint">(required to sign)</span><input type="time" name="session_start" value="${v.session_start || ""}">${errText(errors, "session_start")}</label>
        <label>Session end <span class="hint">(required to sign)</span><input type="time" name="session_end" value="${v.session_end || ""}">${errText(errors, "session_end")}</label>`;
    }
    if (f.kind === "checks") {
      const chosen = v[f.key] || [];
      return html`<fieldset class="span-all"><legend>${f.label}${f.required ? html` <span class="hint">(required to sign)</span>` : ""}</legend>
        ${f.hint ? html`<p class="hint">${f.hint}</p>` : ""}
        <div class="row">${f.options.map((o) => html`
          <label class="check"><input type="checkbox" name="${f.key}" value="${o}" ${chosen.includes(o) ? html`checked` : ""}> ${o}</label>`)}</div>
        ${f.other ? html`<label>Other <input type="text" name="${f.key}_other" value="${v[`${f.key}_other`] || ""}" maxlength="500"></label>` : ""}
        ${errText(errors, f.key)}</fieldset>`;
    }
    if (f.kind === "interventions") {
      const sel = v.interventions || [];
      return html`<fieldset class="span-all"><legend>Interventions used</legend>
        <div class="row">${INTERVENTIONS.map((i) => html`
          <label class="check"><input type="checkbox" name="interventions" value="${i}" ${sel.includes(i) ? html`checked` : ""}> ${i}</label>`)}</div>
        <label>Other <input type="text" name="interventions_other" value="${v.interventions_other || ""}" maxlength="500"></label>
        ${errText(errors, "interventions")}</fieldset>`;
    }
    if (f.kind === "mse") {
      return html`<fieldset class="span-all"><legend>Mental status exam</legend><div class="form-grid">
        ${MSE.map(([k, label]) => html`<label>${label}<input type="text" name="mse_${k}" value="${v[`mse_${k}`] || ""}" maxlength="2000"></label>`)}
      </div></fieldset>`;
    }
    if (f.kind === "risk") {
      return html`<fieldset class="span-all"><legend>Risk assessment</legend><div class="form-grid">
        <label>Risk level <span class="hint">(required to sign)</span>
          ${select("risk_level", [{ value: "", label: "Select…" }, ...RISK_LEVELS], v.risk_level)}${errText(errors, "risk_level")}</label>
        <label class="span-all">Risk narrative <span class="hint">Required when risk is moderate or high: ideation, plan, intent, means, protective factors, safety plan.</span>
          <textarea name="risk_narrative" rows="4">${v.risk_narrative || ""}</textarea>${errText(errors, "risk_narrative")}</label>
      </div></fieldset>`;
    }
    return "";
  });
}

function noteForm(req, res, { patient, type, format, values, errors = {}, action, appointmentId, title, status = 200, noteId, objectives = {} }) {
  const formats = formatsFor(type);
  const formatSwitch = !noteId && formats.length > 1 ? html`
    <p class="row"><span class="muted">Format:</span>${formats.map((f) => f === format
      ? html`<span class="pill">${f.toUpperCase()}</span>`
      : html`<a class="btn btn--sm btn--ghost" href="/ehr/patients/${patient.id}/notes/new?type=${type}&format=${f}${appointmentId ? `&appointment_id=${appointmentId}` : ""}">Switch to ${f.toUpperCase()}</a>`)}
      <span class="hint">Switching formats clears unsaved text.</span></p>` : "";
  const body = html`
    <div class="page-head"><h2>${title}</h2>
      ${noteId ? html`<a class="btn btn--sm" href="/ehr/notes/${noteId}">Cancel</a>` : html`<a class="btn btn--sm" href="/ehr/patients/${patient.id}/notes">Cancel</a>`}</div>
    ${type === "psychotherapy" ? psychotherapyNotice() : ""}
    ${type === "roi" ? roiNotice(values.includes_sud === "yes") : ""}
    ${errorSummary(errors)}
    ${formatSwitch}
    <form method="post" action="${action}" class="card" data-dirty-check>
      ${csrfField(req)}
      <input type="hidden" name="type" value="${type}">
      <input type="hidden" name="format" value="${format}">
      ${appointmentId ? html`<input type="hidden" name="appointment_id" value="${appointmentId}">` : ""}
      <div class="form-grid">
        <label>Service date<input type="date" name="service_date" value="${values.service_date || ""}" required>${errText(errors, "service_date")}</label>
        ${fieldInputs(type, format, values, errors)}
        ${PLAN_LINKED_TYPES.includes(type) ? objectivesFieldset(patient, activePlan(req.db, patient.id), objectives, errors) : ""}
      </div>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Save draft</button>
        <span class="hint">Drafts can be edited until you sign. Signing happens on the note's review page.</span>
      </div>
    </form>`;
  res.status(status).send(chartPage(req, patient, "notes", body, { title: `${TYPES[type].label} · ${patientName(patient)}` }));
}

function section(label, text) {
  const empty = text === undefined || text === null || String(text).trim() === "";
  return html`<div class="note-section"><h3>${label}</h3>${empty ? html`<p class="muted">Not documented</p>` : html`<p>${text}</p>`}</div>`;
}

function noteBody(note) {
  const c = parseContent(note);
  return fieldsFor(note.type, note.format).map((f) => {
    if (f.key === "level_difference_reason" && !String(c[f.key] || "").trim()) return "";
    if (f.kind === "textarea" || f.kind === "text") return section(f.label, c[f.key]);
    if (f.kind === "select") {
      const o = f.options.find((x) => x.value === c[f.key] && x.value !== "");
      return section(f.label, o ? o.label : "");
    }
    if (f.kind === "date") return section(f.label, c[f.key] ? fmtDate(c[f.key]) : "");
    if (f.kind === "edition") {
      return section(f.label, c.asam_edition ? (ASAM_EDITIONS.find((o) => o.value === c.asam_edition) || {}).label
        : "3rd edition (recorded before edition selection)");
    }
    if (f.kind === "asam_level") {
      const o = ASAM_LEVEL_OPTIONS.find((x) => x.value === c[f.key]);
      // Hide empty new-format level fields on notes written with the old single "recommended level".
      if (!o && c.recommended_level && !c.indicated_level) return "";
      if (f.key === "adjusted_level" && !o) return section(f.label, c.indicated_level ? "Same as indicated level" : "");
      return section(f.label, o ? o.label : "");
    }
    if (f.kind === "legacy") {
      const val = c[f.key];
      if (val === undefined || val === null || String(val).trim() === "") return "";
      const o = f.options ? f.options.find((x) => x.value === val) : null;
      return section(f.label, o ? o.label : val);
    }
    if (f.kind === "rated") {
      const o = ASAM_RATINGS.find((x) => x.value === c[`${f.key}_rating`] && x.value !== "");
      return html`<div class="note-section"><h3>${f.labels[asamEdition(c)]}${c[`${f.key}_driver`] ? html` <span class="pill">Dimensional driver</span>` : ""}</h3>
        <p>Rating: ${o ? html`<strong>${o.label}</strong>` : html`<span class="muted">Not rated</span>`}</p>
        ${c[f.key] ? html`<p>${c[f.key]}</p>` : ""}</div>`;
    }
    if (f.kind === "session") {
      return section("Session time", c.session_start || c.session_end
        ? `${fmtTime(`0000-00-00T${c.session_start || ""}`) || "?"} to ${fmtTime(`0000-00-00T${c.session_end || ""}`) || "?"}` : "");
    }
    if (f.kind === "checks") {
      const list = [...(c[f.key] || []), ...(c[`${f.key}_other`] ? [c[`${f.key}_other`]] : [])];
      return section(f.label, list.join(", "));
    }
    if (f.kind === "interventions") {
      const list = [...(c.interventions || []), ...(c.interventions_other ? [c.interventions_other] : [])];
      return section("Interventions used", list.join(", "));
    }
    if (f.kind === "mse") {
      const rows = MSE.filter(([k]) => c[`mse_${k}`]);
      return html`<div class="note-section"><h3>Mental status exam</h3>${rows.length
        ? html`<dl class="facts">${rows.map(([k, label]) => html`<dt>${label}</dt><dd>${c[`mse_${k}`]}</dd>`)}</dl>`
        : html`<p class="muted">Not documented</p>`}</div>`;
    }
    if (f.kind === "risk") {
      return html`<div class="note-section"><h3>Risk assessment</h3>
        <p>Risk level: ${note.risk_level ? badge(note.risk_level) : html`<span class="muted">Not documented</span>`}</p>
        ${c.risk_narrative ? html`<p>${c.risk_narrative}</p>` : ""}</div>`;
    }
    return "";
  });
}

function signatureLine(note) {
  if (note.status !== "signed") return html`<p class="signature">Draft. Not signed.</p>`;
  return html`<p class="signature">Electronically signed by ${userLine({ name: note.signer_name, credentials: note.signer_credentials })} on ${fmtTimestamp(note.signed_at)}</p>`;
}

function renderNote(req, res, { note, patient }, { signErrs = {}, addendumError = "", addendumText = "", status = 200 } = {}) {
  const addenda = req.db.prepare(
    `SELECT a.*, u.name, u.credentials FROM note_addenda a JOIN users u ON u.id = a.author_id
     WHERE a.note_id = ? ORDER BY a.created_at, a.id`).all(note.id);
  const appt = note.appointment_id ? req.db.prepare("SELECT start_at, type FROM appointments WHERE id = ?").get(note.appointment_id) : null;
  const isAuthor = note.author_id === req.user.id;
  const isDraft = note.status === "draft";
  const canWrite = can(req.user, "clinical:write");
  const linked = PLAN_LINKED_TYPES.includes(note.type);
  const addressed = linked ? noteObjectives(req.db, note.id) : [];
  const noPlanWarning = linked && isDraft && !activePlan(req.db, patient.id).hasPlan
    ? html`<div class="alert alert--info no-print" role="note">${NO_PLAN_MSG}
        <a href="/ehr/patients/${patient.id}/treatment-plan">Open the treatment plan</a></div>` : "";
  const objectivesSection = linked ? html`<div class="note-section"><h3>Treatment plan objectives addressed</h3>
    ${addressed.length ? html`<ul class="list-plain obj-list">${addressed.map((o) => html`<li class="obj-item">
        <p class="obj-path"><strong>${o.problem_title}</strong> › ${o.goal_text}</p>
        <p>${o.text}${o.progress ? html` · <strong>${(OBJ_PROGRESS.find((x) => x.value === o.progress) || {}).label}</strong>` : ""}</p>
        ${o.comment ? html`<p class="muted">${o.comment}</p>` : ""}</li>`)}</ul>`
      : html`<p class="muted">None recorded</p>`}</div>` : "";

  const actions = html`
    <div class="row no-print">
      <button class="btn btn--sm" type="button" data-print>Print</button>
      ${isAuthor && isDraft ? html`
        <a class="btn btn--sm" href="/ehr/notes/${note.id}/edit">Edit draft</a>
        <form class="inline-form" method="post" action="/ehr/notes/${note.id}/delete" data-confirm="Delete this draft? This cannot be undone.">
          ${csrfField(req)}<button class="btn btn--sm btn--danger" type="submit">Delete draft</button></form>` : ""}
      <a class="btn btn--sm btn--ghost" href="/ehr/patients/${patient.id}/notes">All notes</a>
    </div>`;

  const signForm = isAuthor && isDraft ? html`
    <section class="card no-print" aria-labelledby="sign-h">
      <h2 id="sign-h">Sign note</h2>
      ${errorSummary(signErrs)}
      <form method="post" action="/ehr/notes/${note.id}/sign" class="stack" data-confirm="Sign this note? Signed notes cannot be changed; corrections require an addendum.">
        ${csrfField(req)}
        <p class="muted">By entering your password you attest that this note is accurate and complete. Once signed it cannot be edited.</p>
        <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
        <div><button class="btn btn--primary" type="submit">Sign note</button></div>
      </form>
    </section>` : "";

  const addendaSection = html`
    ${addenda.length || !isDraft ? html`<section class="card" aria-labelledby="add-h"><h2 id="add-h">Addenda</h2>
      ${addenda.length ? html`<ul class="list-plain">${addenda.map((a) => html`
        <li><p class="prewrap">${a.content}</p>
          <p class="signature">Addendum by ${userLine(a)} on ${fmtTimestamp(a.created_at)}</p></li>`)}</ul>`
        : html`<p class="muted">No addenda.</p>`}
      ${!isDraft && canWrite ? html`
        <form method="post" action="/ehr/notes/${note.id}/addenda" class="stack no-print">
          ${csrfField(req)}
          <label>Add an addendum <span class="hint">Addenda are permanent and are added below the signed note.</span>
            <textarea name="content" rows="4" required>${addendumText}</textarea>${addendumError ? html`<span class="error-text">${addendumError}</span>` : ""}</label>
          <div><button class="btn" type="submit">Add addendum</button></div>
        </form>` : ""}
    </section>` : ""}`;

  const body = html`
    <div class="page-head"><h2>${typeLabel(note)} ${badge(note.status)}</h2>${actions}</div>
    ${note.type === "psychotherapy" ? psychotherapyNotice() : ""}
    ${note.type === "roi" ? roiNotice(parseContent(note).includes_sud === "yes") : ""}
    ${noPlanWarning}
    <article class="card">
      <dl class="facts">
        <dt>Patient</dt><dd>${patientName(patient)} (MRN ${patient.mrn})</dd>
        <dt>Service date</dt><dd>${fmtDate(note.service_date)}</dd>
        ${appt ? html`<dt>Appointment</dt><dd>${fmtDate(appt.start_at)} ${fmtTime(appt.start_at)} · ${humanize(appt.type)}</dd>` : ""}
        <dt>Author</dt><dd>${userLine({ name: note.author_name, credentials: note.author_credentials })}</dd>
      </dl>
      <hr>
      ${noteBody(note)}
      ${objectivesSection}
      ${signatureLine(note)}
    </article>
    ${signForm}
    ${addendaSection}`;
  res.status(status).send(chartPage(req, patient, "notes", body, { title: `${typeLabel(note)} · ${patientName(patient)}` }));
}

/* ------------------------------------------------------------------ */
/* Patient notes list                                                 */
/* ------------------------------------------------------------------ */
router.get("/patients/:id/notes", requirePerm("clinical:read"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const notes = req.db.prepare(
    `SELECT n.id, n.type, n.format, n.status, n.service_date, n.created_at, n.risk_level, n.author_id, u.name AS author_name, u.credentials AS author_credentials,
            (SELECT COUNT(*) FROM note_addenda a WHERE a.note_id = n.id) AS addenda
     FROM notes n JOIN users u ON u.id = n.author_id
     WHERE n.patient_id = ? AND (n.type <> 'psychotherapy' OR n.author_id = ?)
     ORDER BY COALESCE(n.service_date, substr(n.created_at,1,10)) DESC, n.id DESC`).all(patient.id, req.user.id);
  audit(req, "view", "note", null, patient.id, "notes list");
  const writer = can(req.user, "clinical:write");
  const body = html`
    <div class="page-head"><h2>Notes</h2></div>
    ${writer ? html`<section class="card no-print" aria-labelledby="new-h">
      <h3 id="new-h">New note</h3>
      ${!activePlan(req.db, patient.id).hasPlan ? html`<p class="alert alert--warn">${PLAN_REQUIRED_MSG} <a href="/ehr/patients/${patient.id}/treatment-plan">Go to treatment plan</a></p>` : ""}
      <div class="row">${TYPE_KEYS.filter((k) => !planRequiredFor(req.db, k, patient.id)).map((k) => html`<a class="btn btn--sm" href="/ehr/patients/${patient.id}/notes/new?type=${k}">${TYPES[k].label}</a>`)}</div>
    </section>` : ""}
    <section class="card">
      ${notes.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Type</th><th>Author</th><th>Status</th><th>Risk</th></tr></thead>
        <tbody>${notes.map((n) => html`<tr>
          <td><a href="/ehr/notes/${n.id}">${fmtDate(n.service_date || n.created_at)}</a></td>
          <td>${typeLabel(n)}${n.addenda ? html` <span class="pill">${n.addenda} addend${n.addenda === 1 ? "um" : "a"}</span>` : ""}</td>
          <td>${userLine({ name: n.author_name, credentials: n.author_credentials })}</td>
          <td>${badge(n.status)}</td>
          <td>${n.risk_level ? badge(n.risk_level) : ""}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">No notes yet.</p>`}
    </section>`;
  res.send(chartPage(req, patient, "notes", body, { title: `Notes · ${patientName(patient)}` }));
});

/* ------------------------------------------------------------------ */
/* New / create                                                       */
/* ------------------------------------------------------------------ */
const APPT_DEFAULT_TYPE = { intake: "intake", psychiatry_eval: "intake", med_management: "psychiatry", group: "group" };

router.get("/patients/:id/notes/new", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { appt, error } = loadAppointment(req, patient.id, req.query.appointment_id);
  if (error) { req.flash("error", error); return res.redirect(`/ehr/patients/${patient.id}/notes`); }
  let type = String(req.query.type || "");
  const explicit = Boolean(TYPES[type]);
  if (!explicit) type = (appt && APPT_DEFAULT_TYPE[appt.type]) || "progress";
  // No type chosen and no plan yet: start with the intake assessment the plan will be built from.
  if (!explicit && planRequiredFor(req.db, type, patient.id)) {
    type = "intake";
    req.flash("info", "No active treatment plan yet, so this starts an intake assessment. Progress notes open once the plan is signed.");
  }
  if (planRequiredFor(req.db, type, patient.id)) return planRequiredPage(req, res, patient, type);
  let format = String(req.query.format || "");
  if (!formatsFor(type).includes(format)) format = formatsFor(type)[0];
  const values = { service_date: today() };
  if (type === "safety_plan") values.professional_contacts =
    "Primary clinician: \nClinic: (555) 010-0123\n988 Suicide & Crisis Lifeline: call or text 988\nEmergency: 911 or nearest emergency department: ";
  if (type === "roi") values.signed_on = today();
  if (type === "asam") values.asam_edition = "4";
  if (appt) {
    values.service_date = appt.start_at.slice(0, 10);
    if (type === "progress" || type === "group") { values.session_start = appt.start_at.slice(11, 16); values.session_end = appt.end_at.slice(11, 16); }
  }
  noteForm(req, res, { patient, type, format, values, action: `/ehr/patients/${patient.id}/notes`,
    appointmentId: appt ? appt.id : null, title: `New ${TYPES[type].label.replace(/^\w/, (c) => c.toLowerCase()).replace(/^aSAM/, "ASAM")}` });
});

router.post("/patients/:id/notes", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const type = str(req.body.type);
  if (!TYPES[type]) return res.status(400).send(page(req, { title: "Invalid note", body: html`<div class="card"><h1>Unknown note type</h1></div>` }));
  if (planRequiredFor(req.db, type, patient.id)) return planRequiredPage(req, res, patient, type);
  let format = str(req.body.format);
  if (!formatsFor(type).includes(format)) format = formatsFor(type)[0];
  const { appt, error } = loadAppointment(req, patient.id, str(req.body.appointment_id));
  const form = readForm(req.body, type, format);
  if (error) form.errors.appointment_id = error;
  const objs = PLAN_LINKED_TYPES.includes(type) ? readObjectives(req.db, req.body, patient.id) : { selected: {}, error: null };
  if (objs.error) form.errors.objectives = objs.error;
  if (Object.keys(form.errors).length) {
    return noteForm(req, res, { patient, type, format, values: { ...form.content, risk_level: form.risk_level, service_date: form.service_date },
      errors: form.errors, action: `/ehr/patients/${patient.id}/notes`, appointmentId: appt ? appt.id : null,
      title: `New ${TYPES[type].label.replace(/^\w/, (c) => c.toLowerCase()).replace(/^aSAM/, "ASAM")}`, status: 400, objectives: objs.selected });
  }
  const id = tx(req.db, () => {
    const noteId = Number(req.db.prepare(
      `INSERT INTO notes (patient_id, appointment_id, author_id, type, format, content, risk_level, status, service_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`).run(patient.id, appt ? appt.id : null, req.user.id, type, format,
      JSON.stringify(form.content), form.risk_level, form.service_date).lastInsertRowid);
    saveObjectives(req.db, noteId, objs.selected);
    return noteId;
  });
  audit(req, "create", "note", id, patient.id, type);
  req.flash("success", "Draft saved. Review and sign when complete.");
  res.redirect(`/ehr/notes/${id}`);
});

/* ------------------------------------------------------------------ */
/* My notes                                                           */
/* ------------------------------------------------------------------ */
router.get("/notes", requirePerm("clinical:write"), (req, res) => {
  const cols = `n.id, n.type, n.format, n.status, n.service_date, n.updated_at, n.signed_at, n.patient_id,
                p.first_name, p.last_name, p.preferred_name, p.mrn`;
  const drafts = req.db.prepare(
    `SELECT ${cols} FROM notes n JOIN patients p ON p.id = n.patient_id
     WHERE n.author_id = ? AND n.status = 'draft' ORDER BY n.service_date, n.id`).all(req.user.id);
  const signed = req.db.prepare(
    `SELECT ${cols} FROM notes n JOIN patients p ON p.id = n.patient_id
     WHERE n.author_id = ? AND n.status = 'signed' ORDER BY n.signed_at DESC, n.id DESC LIMIT 25`).all(req.user.id);
  audit(req, "view", "note", null, null, "my notes list");
  const table = (rows, signedCol) => html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Service date</th><th>Patient</th><th>Type</th><th>Status</th><th>${signedCol ? "Signed" : "Last saved"}</th></tr></thead>
    <tbody>${rows.map((n) => html`<tr>
      <td><a href="/ehr/notes/${n.id}">${fmtDate(n.service_date)}</a></td>
      <td><a href="/ehr/patients/${n.patient_id}/notes">${patientName(n)}</a> <span class="muted">${n.mrn}</span></td>
      <td>${typeLabel(n)}</td><td>${badge(n.status)}</td>
      <td>${fmtTimestamp(signedCol ? n.signed_at : n.updated_at)}</td></tr>`)}</tbody></table></div>`;
  res.send(page(req, { title: "My notes", active: "notes", body: html`
    <div class="page-head"><h1>My notes</h1></div>
    <section class="card"><div class="card__head"><h2>Unsigned drafts (${drafts.length})</h2></div>
      ${drafts.length ? table(drafts, false) : html`<p class="muted">No unsigned notes. Nice work.</p>`}</section>
    <section class="card"><div class="card__head"><h2>Recently signed</h2></div>
      ${signed.length ? table(signed, true) : html`<p class="muted">No signed notes yet.</p>`}</section>` }));
});

/* ------------------------------------------------------------------ */
/* View / edit / sign / addenda / delete                              */
/* ------------------------------------------------------------------ */
router.get("/notes/:noteId", requirePerm("clinical:read"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded) return;
  audit(req, "view", "note", loaded.note.id, loaded.patient.id);
  renderNote(req, res, loaded);
});

function editGuard(req, res, note) {
  if (note.author_id !== req.user.id) { deny(req, res, "Only the note's author can edit it."); return false; }
  if (note.status !== "draft") { deny(req, res, "Signed notes can't be edited. Add an addendum instead."); return false; }
  return true;
}

router.get("/notes/:noteId/edit", requirePerm("clinical:write"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded || !editGuard(req, res, loaded.note)) return;
  const { note, patient } = loaded;
  audit(req, "view", "note", note.id, patient.id, "edit form");
  noteForm(req, res, { patient, type: note.type, format: note.format,
    values: { ...parseContent(note), risk_level: note.risk_level, service_date: note.service_date },
    action: `/ehr/notes/${note.id}/edit`, title: `Edit ${typeLabel(note).toLowerCase()}`, noteId: note.id,
    objectives: objectiveValues(req.db, note.id) });
});

router.post("/notes/:noteId/edit", requirePerm("clinical:write"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded || !editGuard(req, res, loaded.note)) return;
  const { note, patient } = loaded;
  const form = readForm(req.body, note.type, note.format, parseContent(note));
  const objs = PLAN_LINKED_TYPES.includes(note.type) ? readObjectives(req.db, req.body, patient.id) : { selected: {}, error: null };
  if (objs.error) form.errors.objectives = objs.error;
  if (Object.keys(form.errors).length) {
    return noteForm(req, res, { patient, type: note.type, format: note.format,
      values: { ...form.content, risk_level: form.risk_level, service_date: form.service_date }, errors: form.errors,
      action: `/ehr/notes/${note.id}/edit`, title: `Edit ${typeLabel(note).toLowerCase()}`, noteId: note.id, status: 400,
      objectives: objs.selected });
  }
  const changed = tx(req.db, () => {
    const r = req.db.prepare(
      `UPDATE notes SET content = ?, risk_level = ?, service_date = ?, updated_at = datetime('now')
       WHERE id = ? AND author_id = ? AND status = 'draft'`).run(JSON.stringify(form.content), form.risk_level, form.service_date, note.id, req.user.id);
    if (r.changes !== 1) return false;
    if (PLAN_LINKED_TYPES.includes(note.type)) saveObjectives(req.db, note.id, objs.selected);
    return true;
  });
  if (!changed) return deny(req, res, "Signed notes can't be edited. Add an addendum instead.");
  audit(req, "update", "note", note.id, patient.id);
  req.flash("success", "Draft saved.");
  res.redirect(`/ehr/notes/${note.id}`);
});

router.post("/notes/:noteId/sign", requirePerm("clinical:write"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded) return;
  const { note, patient } = loaded;
  if (note.author_id !== req.user.id) return deny(req, res, "Only the note's author can sign it.");
  if (note.status !== "draft") return deny(req, res, "This note is already signed.");
  if (planRequiredFor(req.db, note.type, patient.id)) return renderNote(req, res, loaded, { signErrs: { plan: PLAN_REQUIRED_MSG }, status: 409 });
  let thread = {};
  if (PLAN_LINKED_TYPES.includes(note.type)) {
    const ids = activePlan(req.db, patient.id).objectives.map((o) => o.id);
    const linkedIds = new Set(req.db.prepare("SELECT objective_id FROM note_objectives WHERE note_id = ?").all(note.id).map((r) => r.objective_id));
    thread = { planObjectiveCount: ids.length, addressedCount: ids.filter((i) => linkedIds.has(i)).length };
  }
  const errors = signErrors(note, thread);
  const pw = typeof req.body.password === "string" ? req.body.password : "";
  const stored = req.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!pw || !stored || !verifyPassword(pw, stored.password_hash)) {
    errors.password = "Password is incorrect. Re-enter your password to sign.";
    audit(req, "sign_failed", "note", note.id, patient.id, "password");
  }
  if (Object.keys(errors).length) {
    if (!errors.password) audit(req, "sign_failed", "note", note.id, patient.id, "incomplete");
    return renderNote(req, res, loaded, { signErrs: errors, status: 400 });
  }
  const r = req.db.prepare(
    `UPDATE notes SET status = 'signed', signed_at = datetime('now'), signed_by = ?, updated_at = datetime('now')
     WHERE id = ? AND author_id = ? AND status = 'draft'`).run(req.user.id, note.id, req.user.id);
  if (r.changes !== 1) return deny(req, res, "This note is already signed.");
  audit(req, "sign", "note", note.id, patient.id);
  req.flash("success", "Note signed.");
  res.redirect(`/ehr/notes/${note.id}`);
});

router.post("/notes/:noteId/addenda", requirePerm("clinical:write"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded) return;
  const { note, patient } = loaded;
  if (note.status !== "signed") return deny(req, res, "Addenda can only be added to signed notes. Edit the draft instead.");
  const content = str(req.body.content);
  if (!content) return renderNote(req, res, loaded, { addendumError: "Addendum text is required.", status: 400 });
  const id = tx(req.db, () => {
    const addId = Number(req.db.prepare("INSERT INTO note_addenda (note_id, author_id, content) VALUES (?, ?, ?)")
      .run(note.id, req.user.id, content).lastInsertRowid);
    audit(req, "addendum", "note", note.id, patient.id, `addendum ${addId}`);
    return addId;
  });
  void id;
  req.flash("success", "Addendum added.");
  res.redirect(`/ehr/notes/${note.id}`);
});

router.post("/notes/:noteId/delete", requirePerm("clinical:write"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded) return;
  const { note, patient } = loaded;
  if (note.author_id !== req.user.id) return deny(req, res, "Only the note's author can delete it.");
  if (note.status !== "draft") return deny(req, res, "Signed notes can't be deleted.");
  const r = req.db.prepare("DELETE FROM notes WHERE id = ? AND author_id = ? AND status = 'draft'").run(note.id, req.user.id);
  if (r.changes !== 1) return deny(req, res, "Signed notes can't be deleted.");
  audit(req, "delete", "note", note.id, patient.id);
  req.flash("success", "Draft deleted.");
  res.redirect(`/ehr/patients/${patient.id}/notes`);
});

module.exports = { router, TYPES, PLAN_REQUIRED_TYPES, activePlan, signErrors };
