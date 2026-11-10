"use strict";
/*
 * Insurance / medical-necessity documentation review for clinical notes.
 *
 * Two layers, both advisory (nothing is changed automatically):
 *   1. ruleChecks(): deterministic checks that always run (time vs CPT, required elements, plan linkage).
 *   2. aiReview(): Claude reviews the note text against payer documentation expectations and returns
 *      structured findings. Runs only when EHR_AI_REVIEW=1 and Anthropic credentials are configured.
 *
 * PHI: the AI step sends note text to Anthropic. Only enable it once the practice has a BAA with Anthropic
 * that covers this use (see docs/hipaa/policies/vendor-and-baa-management.md). Names, DOB and MRN are not
 * sent as structured fields, but clinicians may have typed identifiers into the note text itself.
 */
const AnthropicSDK = require("@anthropic-ai/sdk");
const { unitsFor15 } = require("./payers");
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = process.env.EHR_AI_MODEL || "claude-opus-5-5";

/* ------------------------------------------------------------------ */
/* Context                                                            */
/* ------------------------------------------------------------------ */
const minutesBetween = (a, b) => {
  if (!/^\d\d:\d\d$/.test(a || "") || !/^\d\d:\d\d$/.test(b || "")) return null;
  const [h1, m1] = a.split(":").map(Number);
  const [h2, m2] = b.split(":").map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
};

/** Gather what an auditor would look at alongside the note (no direct identifiers). */
function buildContext(db, note) {
  const content = safeJson(note.content);
  const appt = note.appointment_id ? db.prepare("SELECT type, modality, start_at, end_at FROM appointments WHERE id = ?").get(note.appointment_id) : null;
  const charges = db.prepare(`SELECT cpt_code, modifier, units, diagnosis_codes, pos, minutes FROM charges
    WHERE (appointment_id = ? OR note_id = ?) AND status <> 'void' ORDER BY id`).all(note.appointment_id || -1, note.id);
  const diagnoses = db.prepare("SELECT icd10_code, description, is_primary FROM diagnoses WHERE patient_id = ? AND status = 'active' ORDER BY is_primary DESC")
    .all(note.patient_id);
  const plan = db.prepare("SELECT id, review_date, status, start_date, activated_at, signed_at FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(note.patient_id);
  const objectives = plan ? db.prepare(
    `SELECT o.id, o.text FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id
     WHERE p.plan_id = ? AND o.status <> 'discontinued' ORDER BY p.sort, g.sort, o.sort`).all(plan.id) : [];
  const addressed = db.prepare("SELECT objective_id, progress, comment FROM note_objectives WHERE note_id = ?").all(note.id);
  const ah = ahcccsContext(db, note, plan);
  return {
    note_type: note.type,
    format: note.format,
    service_date: note.service_date,
    risk_level: note.risk_level,
    session_minutes: minutesBetween(content.session_start, content.session_end),
    appointment: appt ? { type: appt.type, modality: appt.modality, scheduled_minutes: minutesBetween(appt.start_at.slice(11, 16), appt.end_at.slice(11, 16)) } : null,
    charges: charges.map((c) => ({ cpt: c.cpt_code, modifier: c.modifier, units: c.units, diagnosis_codes: c.diagnosis_codes, pos: c.pos, minutes: c.minutes })),
    diagnoses: diagnoses.map((d) => ({ code: d.icd10_code, description: d.description, primary: !!d.is_primary })),
    treatment_plan: plan ? { active: true, review_due: plan.review_date, ...ah.plan } : { active: false },
    plan_objectives: objectives.map((o) => ({ id: o.id, text: o.text, addressed_this_session: addressed.some((a) => a.objective_id === o.id) })),
    objectives_addressed: addressed.length,
    ...ah.fields,
    content,
  };
}

/**
 * AHCCCS context (docs/ahcccs-spec.md): member flag, age on the date of service, latest signed assessment,
 * plan date + guardian signature, missing AHCCCS note elements, cloned-note match, late entry and co-sign state.
 * No direct identifiers. notes.js is required lazily (it requires this module).
 */
function ahcccsContext(db, note, plan) {
  const notes = require("./routes/notes");
  const patient = db.prepare("SELECT id, dob FROM patients WHERE id = ?").get(note.patient_id);
  if (!patient) return { fields: { ahcccs: false }, plan: {} };
  const member = notes.memberContext(db, patient, note.service_date);
  const planInfo = plan ? {
    dated: String(plan.activated_at || plan.signed_at || plan.start_date || "").slice(0, 10) || null,
    guardian_signed: !!db.prepare("SELECT 1 FROM plan_signatures WHERE plan_id = ? AND role = 'guardian' AND declined = 0").get(plan.id),
  } : {};
  if (!member.ahcccs) return { fields: { ahcccs: false }, plan: planInfo };
  const intake = db.prepare(`SELECT MAX(service_date) AS d FROM notes WHERE patient_id = ? AND type = 'intake' AND status = 'signed'
    AND (? IS NULL OR service_date <= ?)`).get(note.patient_id, note.service_date, note.service_date);
  // AHCCCS-only requirements = sign errors with AHCCCS rules on, minus those that apply to everyone.
  const base = notes.signErrors(note, { ...member, ahcccs: false });
  const full = notes.signErrors(note, member);
  const missing = Object.entries(full).filter(([k]) => !(k in base) && !["audio_only_minutes", "session_start", "session_end"].includes(k)).map(([, v]) => v);
  const clone = notes.findClone(db, note);
  const cosign = notes.cosignStatus(db, note);
  return {
    plan: planInfo,
    fields: {
      ahcccs: true,
      patient_age: member.age,
      has_sud_diagnosis: member.hasSud,
      latest_assessment_date: intake ? intake.d : null,
      ahcccs_missing: missing,
      cloned_from: clone ? { service_date: clone.service_date, similarity: Math.round(clone.similarity * 100) / 100 } : null,
      late_entry_pending: note.status === "draft" && notes.lateInfo(note).late,
      cosign: cosign.required ? { cosigned: cosign.cosigned, overdue: cosign.overdue, general: !!cosign.general, due_at: cosign.due_at } : null,
    },
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}") || {}; } catch { return {}; }
}

/* ------------------------------------------------------------------ */
/* Rule checks (always on)                                            */
/* ------------------------------------------------------------------ */
// CMS time ranges for psychotherapy codes (time-based; verify with your payers).
const CPT_TIME = {
  "90832": [16, 37], "90834": [38, 52], "90837": [53, Infinity],
  "90833": [16, 37], "90836": [38, 52], "90838": [53, Infinity], // add-on codes with E/M
};
const VAGUE = [/\bdoing (well|fine|ok(ay)?)\b/i, /\bclient is (fine|good|ok(ay)?)\b/i, /\bwent well\b/i, /\bchecked in\b/i,
  /\bprocessed (feelings|emotions|things)\b/i, /\bprovided support\b/i, /\bsupportive therapy\b/i, /\bvented\b/i, /\bno (new )?issues\b/i];
const MEDICAL_NECESSITY = /\b(symptom|impair|function|PHQ|GAD|PCL|score|sleep|appetite|panic|depress|anxi|mood|withdraw|craving|hallucin|ideation|risk|unable|difficult|decline|relapse)/i;

function finding(severity, category, issue, suggestion) {
  return { severity, category, issue, suggestion, source: "rule" };
}

function ruleChecks(ctx) {
  const out = [];
  const c = ctx.content || {};
  const text = Object.values(c).filter((v) => typeof v === "string").join("\n");
  const therapy = ["progress", "group"].includes(ctx.note_type);

  if (therapy && ctx.session_minutes == null && !ctx.ahcccs) {
    out.push(finding("high", "Time", "Session start and end times are missing.", "Record start and end times; most payers deny time-based psychotherapy codes without them."));
  }
  for (const ch of ctx.charges) {
    const range = CPT_TIME[ch.cpt];
    if (range && ctx.session_minutes != null && (ctx.session_minutes < range[0] || ctx.session_minutes > range[1])) {
      out.push(finding("high", "Coding", `CPT ${ch.cpt} requires ${range[0]}${range[1] === Infinity ? "+" : `–${range[1]}`} minutes, but the note documents ${ctx.session_minutes} minutes.`,
        "Correct the session times or change the charge to the code that matches the documented time."));
    }
    if (!ctx.ahcccs && ctx.appointment && ctx.appointment.modality === "telehealth" && !/95|GT/i.test(ch.modifier || "")) {
      out.push(finding("medium", "Coding", `Telehealth visit billed as ${ch.cpt} without a telehealth modifier.`, "Add modifier 95 (or the payer's required modifier) and the place-of-service code."));
    }
  }
  if (ctx.session_minutes != null && ctx.session_minutes < 16 && therapy) {
    out.push(finding("high", "Time", `Documented session is ${ctx.session_minutes} minutes; psychotherapy under 16 minutes is not billable.`, "Verify the times; if correct, document as a contact note instead."));
  }
  if (["progress", "group", "psychiatry", "intake"].includes(ctx.note_type) && !ctx.risk_level) {
    out.push(finding("medium", "Risk", "No risk assessment level is documented.", "Rate risk (none/low/moderate/high) and describe ideation, intent, plan and protective factors if present."));
  }
  if (therapy && ctx.treatment_plan.active && ctx.objectives_addressed === 0) {
    out.push(finding("high", "Treatment plan", "The note isn't linked to any treatment plan objective.", "Tick the objectives addressed this session and describe progress toward them."));
  }
  if (therapy && !ctx.treatment_plan.active) {
    out.push(finding("high", "Treatment plan", "The patient has no active treatment plan.", "Payers expect a signed plan before ongoing psychotherapy."));
  }
  if (ctx.treatment_plan.review_due && ctx.service_date && ctx.treatment_plan.review_due < ctx.service_date) {
    out.push(finding("medium", "Treatment plan", `The treatment plan review was due ${ctx.treatment_plan.review_due}.`, "Complete the plan review; services after the due date may be questioned."));
  }
  if (therapy && Array.isArray(c.interventions) && c.interventions.length === 0 && !c.interventions_other) {
    out.push(finding("medium", "Interventions", "No therapeutic interventions are recorded.", "Name the specific interventions used (e.g. CBT cognitive restructuring) and the client's response."));
  }
  if (!ctx.diagnoses.length) {
    out.push(finding("high", "Diagnosis", "The patient has no active diagnosis.", "Add the diagnosis that justifies the service."));
  }
  const vague = VAGUE.filter((re) => re.test(text)).map((re) => text.match(re)[0]);
  if (vague.length) {
    out.push(finding("low", "Specificity", `Vague phrasing that auditors flag: "${[...new Set(vague)].join('", "')}".`, "Replace with observable behavior, symptoms, measures and the client's response to specific interventions."));
  }
  if (therapy && text && !MEDICAL_NECESSITY.test(text)) {
    out.push(finding("medium", "Medical necessity", "The note doesn't describe current symptoms, functional impairment or measures.", "Document the symptoms and functional problems being treated and how they changed this session."));
  }
  if (ctx.ahcccs) out.push(...ahcccsChecks(ctx));
  if (ctx.cosign && ctx.cosign.general && !ctx.cosign.cosigned) {
    out.push(finding(ctx.cosign.overdue ? "high" : "medium", "Signature",
      ctx.cosign.overdue ? "Supervisor co-signature is overdue." : "Waiting on the supervisor's co-signature.",
      "The clinician's supervisor must review and co-sign; payers may deny services documented by supervisees without it."));
  }
  return out;
}

/* AHCCCS (Arizona Medicaid) rules; docs/ahcccs-spec.md. Each issue cites the policy or claim edit. */
const AHCCCS_BILLABLE = ["progress", "group", "psychiatry", "contact"];
/** Per-15-minute HCPCS codes (B2 Matrix). H0031 (assessment) is per encounter. */
const PER_15 = new Set(["H0004", "H2014", "H2017", "H0038", "T1016"]);
const daysBetween = (a, b) => Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const modsOf = (m) => String(m || "").toUpperCase().split(/[\s,;:/]+/).filter(Boolean);

function ahcccsChecks(ctx) {
  const out = [];
  const c = ctx.content || {};
  const billable = AHCCCS_BILLABLE.includes(ctx.note_type);
  const dos = ctx.service_date;
  const mins = ctx.session_minutes;
  const plan = ctx.treatment_plan || {};

  if (billable && mins == null) {
    out.push(finding("high", "Time", "Actual start and stop times are missing (AMPM 940 4.l.viii; CBHSG core limitation #7).",
      "Record the actual start and stop times for this member; schedule-based or templated times aren't accepted."));
  }
  if (billable && dos) {
    if (!ctx.latest_assessment_date) {
      out.push(finding("high", "Other", "No signed assessment is on file for the date of service (AMPM 320-O; edit MD466).", "Complete and sign the intake assessment before billing services."));
    } else if (daysBetween(ctx.latest_assessment_date, dos) > 365) {
      out.push(finding("high", "Other", `The assessment (${ctx.latest_assessment_date}) is more than 1 year old on the date of service (AMPM 320-O; edit MD466).`,
        "Complete the annual assessment update."));
    }
    if (!plan.active) {
      out.push(finding("high", "Treatment plan", "No current service plan on the date of service (AMPM 320-O; edit MD466).", "Activate a signed service plan before billing."));
    } else if (plan.dated && daysBetween(plan.dated, dos) > 365) {
      out.push(finding("high", "Treatment plan", `The service plan (${plan.dated}) is more than 1 year old on the date of service (AMPM 320-O; edit MD466).`,
        "Review and re-sign the service plan; claims with a plan older than 1 year are denied."));
    }
  }
  if (ctx.patient_age != null && ctx.patient_age < 18 && plan.active && !plan.guardian_signed) {
    out.push(finding("high", "Treatment plan", "The member is under 18 and the service plan has no parent/guardian signature (AMPM 320-O; edit MD454).",
      "Obtain the parent or guardian signature on the service plan."));
  }
  const groupNote = ctx.note_type === "group" || c.service_type === "group";
  for (const ch of ctx.charges || []) {
    const mods = modsOf(ch.modifier);
    if (PER_15.has(ch.cpt)) {
      const minutes = ch.minutes != null ? ch.minutes : mins;
      if (minutes != null) {
        const expected = unitsFor15(minutes);
        if (expected === 0) {
          out.push(finding("high", "Coding", `${ch.cpt}: ${minutes} minutes is under the 8-minute minimum for a 15-minute unit (CBHSG core limitation #10).`, "Don't bill this service, or correct the documented times."));
        } else if (Number(ch.units) !== expected) {
          out.push(finding("high", "Coding", `${ch.cpt} billed for ${ch.units} unit(s), but ${minutes} documented minutes support ${expected} (CBHSG core limitation #10; edit MD418).`,
            `Bill ${expected} unit(s) or correct the documented times.`));
        }
      }
    }
    if (groupNote && !mods.includes("HQ")) {
      out.push(finding("high", "Coding", `Group service billed as ${ch.cpt} without the HQ modifier (AMPM 940 4.l.vi; B2 Matrix).`, "Add modifier HQ to group services."));
    }
    if (mods.includes("95") || mods.includes("93")) {
      out.push(finding("high", "Coding", `${ch.cpt} carries modifier ${mods.includes("95") ? "95" : "93"}; AHCCCS uses GT (audio-video) or FQ (audio-only), never 95/93 (AHCCCS Telehealth Code Set).`,
        "Replace with GT or FQ to match the note's telehealth modality."));
    }
    if (mods.includes("GT") && mods.includes("FQ")) {
      out.push(finding("high", "Coding", `${ch.cpt} has both GT and FQ; use exactly one telehealth modifier (AHCCCS Telehealth Code Set).`, "Keep the modifier that matches the modality documented in the note."));
    } else if (c.telehealth_modality === "audio_video" && !mods.includes("GT")) {
      out.push(finding("high", "Coding", `Audio-video telehealth billed as ${ch.cpt} without modifier GT (AMPM 940 2.m; AHCCCS Telehealth Code Set).`, "Add modifier GT."));
    } else if (c.telehealth_modality === "audio_only" && !mods.includes("FQ")) {
      out.push(finding("high", "Coding", `Audio-only telehealth billed as ${ch.cpt} without modifier FQ (AMPM 940 2.m; AHCCCS Telehealth Code Set).`, "Add modifier FQ."));
    } else if (c.telehealth_modality === "in_person" && (mods.includes("GT") || mods.includes("FQ"))) {
      out.push(finding("medium", "Coding", `${ch.cpt} has a telehealth modifier but the note documents an in-person service (AMPM 940 2.m).`, "Remove the modifier or correct the note's modality."));
    }
    if (mods.includes("FQ") && /^99\d{3}$/.test(ch.cpt)) {
      out.push(finding("high", "Coding", `FQ (audio-only) isn't allowed on E/M code ${ch.cpt} (AHCCCS Telehealth Code Set).`, "Bill audio-video (GT) or an allowed audio-only code."));
    }
    if (["02", "10"].includes(String(ch.pos || ""))) {
      out.push(finding("high", "Coding", `${ch.cpt} uses place of service ${ch.pos}; AHCCCS uses the member's location (11/12/03/99), not POS 02/10 (AHCCCS Telehealth Code Set; FFS Chapter 19).`,
        "Change POS to where the member was during the service."));
    } else if (ch.pos && c.pos && String(ch.pos) !== String(c.pos)) {
      out.push(finding("medium", "Coding", `Charge POS ${ch.pos} doesn't match the member location in the note (${c.pos}) (AMPM 940 4.l).`, "Make the charge POS match the documented member location."));
    }
    const codes = String(ch.diagnosis_codes || "").toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (c.dx_addressed && codes.length && !codes.includes(String(c.dx_addressed).toUpperCase())) {
      out.push(finding("medium", "Diagnosis", `The charge's diagnosis (${codes.join(", ")}) isn't the diagnosis addressed in the note (${c.dx_addressed}) (AMPM 940 4.l.vii).`,
        "Bill the diagnosis the session addressed, or document how the billed diagnosis was addressed."));
    }
  }
  if (c.telehealth_modality === "audio_only") {
    if (!String(c.audio_only_reason || "").trim()) {
      out.push(finding("high", "Other", "Audio-only telehealth without the reason video wasn't available (AMPM 320-I; AHCCCS Telehealth Code Set).", "Document why audio-video wasn't available."));
    }
    if (mins != null && mins <= 10) {
      out.push(finding("high", "Time", `Audio-only session of ${mins} minutes; audio-only must run over 10 minutes (AHCCCS Telehealth Code Set).`, "Don't bill this as an audio-only service."));
    }
  }
  if ((ctx.ahcccs_missing || []).length) {
    out.push(finding("high", "Other", `Missing AHCCCS documentation elements (AMPM 940 4.l / 320-O): ${ctx.ahcccs_missing.join(" ")}`, "Complete these fields; AHCCCS reviewers score each element."));
  }
  if (c.late_entry && !String(c.late_entry_reason || "").trim()) {
    out.push(finding("medium", "Other", "The note was signed as a late entry (more than 48 hours after the service) without a reason (AMPM 940 2.g, 2.i).", "Add an addendum giving the reason for the late entry."));
  }
  if (ctx.late_entry_pending) {
    out.push(finding("medium", "Other", "This draft is more than 48 hours past the service and will be a late entry (AMPM 940 2.g, 2.i).", "Sign it now and give the late entry reason."));
  }
  if (ctx.cloned_from) {
    out.push(finding("high", "Specificity", `The narrative is ${Math.round(ctx.cloned_from.similarity * 100)}% identical to this author's note of ${ctx.cloned_from.service_date} for this member (AMPM 940 2.h; edit MD435).`,
      "Rewrite the narrative to describe this session; cloned documentation is denied and can be recouped."));
  }
  if (["progress", "group"].includes(ctx.note_type) && mins != null && mins > 60 && !String(c.long_session_justification || "").trim()) {
    out.push(finding("medium", "Time", `The session ran ${mins} minutes without a justification for exceeding 60 minutes (CBHSG counseling #5).`, "Document why the longer session was clinically necessary."));
  }
  if (ctx.cosign && ctx.cosign.general) {
    // Supervisor co-signature (any note by a supervisee); see src/supervision.js.
  } else if (ctx.cosign && !ctx.cosign.cosigned && ctx.cosign.overdue) {
    out.push(finding("high", "Other", "Assessment by an unlicensed clinician hasn't been co-signed by a licensed BHP within 72 hours (AMPM 320-O; A.A.C. R9-10-1011).", "Have a licensed BHP review and co-sign the assessment."));
  } else if (ctx.cosign && ctx.cosign.cosigned && ctx.cosign.overdue) {
    out.push(finding("medium", "Other", "The licensed BHP co-signature came more than 72 hours after the assessment was signed (AMPM 320-O).", "Note the reason for the delay in an addendum."));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AI review                                                          */
/* ------------------------------------------------------------------ */
const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          category: { type: "string", enum: ["Medical necessity", "Treatment plan", "Interventions", "Response to treatment", "Progress", "Risk", "Time", "Coding", "Diagnosis", "Specificity", "Other"] },
          issue: { type: "string" },
          suggestion: { type: "string" },
          quote: { type: "string" },
        },
        required: ["severity", "category", "issue", "suggestion", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You review outpatient behavioral health documentation the way a payer auditor does (Medicare LCDs, Medicaid and commercial payer documentation standards). You receive one clinical note as JSON (its sections plus billing and treatment plan context) and report what would put the claim at risk or weaken the record.

Check for: medical necessity (current symptoms and functional impairment tied to the diagnosis); linkage to treatment plan goals/objectives and progress toward them; specific interventions and the client's response; risk assessment; time documentation that supports the billed CPT code; diagnosis support; and vague or boilerplate language. Report only problems you can point to in this note or its context, each with a concrete fix the clinician can make. Quote the relevant text in "quote" when there is one, otherwise leave it empty. Do not invent clinical facts, do not rewrite the note, and do not give legal or billing guarantees. If the note is well documented, say so in the summary and return few or no findings. Keep each issue and suggestion to one or two sentences.`;

const AHCCCS_PROMPT = `

This member is enrolled in AHCCCS (Arizona Medicaid). Also apply AHCCCS AMPM 940 and the Covered Behavioral Health Services Guide: actual start/stop times; service type (individual, family with or without the member, group with HQ); the diagnosis addressed and whether it is new or continuing; place of service as the member's location (never POS 02/10); telehealth modality with GT (audio-video) or FQ (audio-only), never 95/93, with consent and, for audio-only, why video wasn't available; participants and their roles; interpreter/language; goals linked to the service plan; interventions; the member's individualized response and progress; presenting problem, brief mental status and screener results for counseling; justification for sessions over 60 minutes; coordination of care; late entries (over 48 hours) with a reason; no cloned or boilerplate narrative (edit MD435); 15-minute units matching documented minutes; a current assessment and service plan no older than one year (edit MD466); and a guardian signature on a minor's plan (edit MD454). Cite the AMPM section or claim edit in the issue text when it applies.`;

let clientOverride = null;
/** Tests can inject a fake client: setClient({ beta: { messages: { create: async () => response } } }). */
function setClient(c) { clientOverride = c; }

/** EHR_AI_REVIEW accepts 1 / true / yes / on (any case, surrounding spaces ignored). */
const aiFlagOn = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.EHR_AI_REVIEW ?? "").trim());

function aiConfigured() {
  if (clientOverride) return true;
  return aiFlagOn() && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "").trim();
}

function makeClient(timeout = 120_000) {
  // Personal Console keys (sk-ant-usr-...) that span several workspaces must name one.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  return clientOverride || new Anthropic({ timeout, maxRetries: 2,
    ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) });
}

/** Plain-language reason an API call failed (no secrets). */
function explainError(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || "");
  return /credit balance/i.test(msg) ? "The Anthropic account has no API credits. Add credits under Settings → Billing in the Claude Console."
    : /workspace/i.test(msg) ? "The API key needs a workspace. Set ANTHROPIC_WORKSPACE_ID in the hosting settings."
    : status === 429 ? "The AI reviewer is busy (rate limited). Try again in a minute."
    : status === 401 || status === 403 ? "The AI reviewer isn't authorized. Check the Anthropic API key in the hosting settings."
    : status === 404 ? "The AI model wasn't found for this API key. Check that the key's workspace has access to the model."
    : "The AI reviewer couldn't be reached.";
}

/** Status for the admin page: what's configured, without revealing secrets. */
function aiStatus(env = process.env) {
  const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const raw = env.EHR_AI_REVIEW;
  return { flag: aiFlagOn(env), flagRaw: raw === undefined ? null : String(raw).slice(0, 20), hasKey: !!key.trim(), keyKind: key.startsWith("sk-ant-usr-") ? "personal Console key" : key.startsWith("sk-ant-api") ? "API key" : key ? "key" : "",
    workspace: !!env.ANTHROPIC_WORKSPACE_ID, enabled: aiConfigured(), model: MODEL };
}

/** Tiny round trip with no patient data, to prove the key, credits and network work. */
async function testConnection() {
  if (!aiConfigured()) return { ok: false, error: "AI review is off (needs EHR_AI_REVIEW=1 and ANTHROPIC_API_KEY)." };
  const started = Date.now();
  try {
    const r = await makeClient(30_000).beta.messages.create({
      model: MODEL, max_tokens: 16, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      messages: [{ role: "user", content: "Connection test. Reply with the single word OK." }],
    });
    const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return { ok: true, model: r.model, reply: text.slice(0, 40), ms: Date.now() - started };
  } catch (err) {
    console.error("AI connection test failed:", err && err.status, err && err.message);
    return { ok: false, error: explainError(err), status: err && err.status };
  }
}

async function aiReview(ctx) {
  const client = makeClient();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
    system: SYSTEM_PROMPT + (ctx.ahcccs ? AHCCCS_PROMPT : ""),
    messages: [{ role: "user", content: `Review this note.\n\n${JSON.stringify(ctx, null, 2)}` }],
  });
  if (response.stop_reason === "refusal") {
    return { ok: false, error: "The AI reviewer declined this request. The rule-based checks above still apply." };
  }
  if (response.stop_reason === "max_tokens") {
    return { ok: false, error: "The AI review was cut off before finishing. Try again." };
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "The AI review returned an unreadable result. Try again." }; }
  const findings = (parsed.findings || []).map((f) => ({ ...f, source: "ai" }));
  return { ok: true, summary: String(parsed.summary || ""), findings, model: response.model };
}

const PDF_PAYERS = {
  commercial: "a commercial insurance plan",
  medicare: "Medicare (apply Medicare LCD documentation requirements for outpatient psychiatric services)",
  medicaid: "a state Medicaid plan",
  ahcccs: "AHCCCS (Arizona Medicaid)",
};

/**
 * Review an uploaded PDF note (e.g. written in another system or scanned from paper). AI only: rule-based checks
 * need the EHR's structured fields. The PDF is sent to the model and not stored. Never throws.
 */
async function reviewPdf({ data, payer = "commercial", noteType = "", context = "" }) {
  if (!aiConfigured()) return { ok: false, skipped: true };
  const payerText = PDF_PAYERS[payer] || PDF_PAYERS.commercial;
  const system = SYSTEM_PROMPT.replace("You receive one clinical note as JSON (its sections plus billing and treatment plan context)",
    "You receive one clinical note as a PDF document, possibly scanned, handwritten or exported from another system")
    + `\n\nIf the PDF is not a clinical note, or it is unreadable, say so in the summary and return no findings. If it contains several notes, review each and say which note each finding is about.`
    + (payer === "ahcccs" ? AHCCCS_PROMPT.replace("This member is enrolled in AHCCCS (Arizona Medicaid). ", "") : "");
  const ask = [`Review this note for ${payerText}.`, noteType ? `The clinician says it is a ${noteType} note.` : "", context ? `Additional context from the clinician: ${context}` : ""].filter(Boolean).join(" ");
  try {
    const response = await makeClient(180_000).beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
      system,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
        { type: "text", text: ask },
      ] }],
    });
    if (response.stop_reason === "refusal") return { ok: false, error: "The AI reviewer declined this document." };
    if (response.stop_reason === "max_tokens") return { ok: false, error: "The AI review was cut off before finishing. Try a shorter PDF." };
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: "The AI review returned an unreadable result. Try again." }; }
    return { ok: true, summary: String(parsed.summary || ""), findings: (parsed.findings || []).map((f) => ({ ...f, source: "ai" })), model: response.model };
  } catch (err) {
    console.error("AI PDF review failed:", (err && err.status) || "", err && err.message);
    const msg = String((err && err.message) || "");
    return { ok: false, error: /pdf|document|page/i.test(msg) && err.status === 400 && !/credit/i.test(msg)
      ? "The PDF couldn't be read (it may be password-protected, damaged or over 100 pages)." : explainError(err) };
  }
}

/** Run both layers. Never throws: AI failures come back as { ai: { ok: false, error } }. */
async function reviewNote(db, note) {
  const ctx = buildContext(db, note);
  const rules = ruleChecks(ctx);
  let ai = { ok: false, skipped: true };
  if (aiConfigured()) {
    try {
      ai = await aiReview(ctx);
    } catch (err) {
      const e = explainError(err);
      ai = { ok: false, error: e === "The AI reviewer couldn't be reached." ? `${e} The rule-based checks above still apply.` : e };
      console.error("AI note review failed:", (err && err.status) || "", err && err.message);
    }
  }
  return { rules, ai, ctx };
}

module.exports = { reviewNote, reviewPdf, PDF_PAYERS, testConnection, aiStatus, explainError, ruleChecks, ahcccsChecks, buildContext, aiConfigured, setClient, FINDINGS_SCHEMA, CPT_TIME, MODEL, AHCCCS_PROMPT };
