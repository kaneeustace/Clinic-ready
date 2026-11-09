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
  const charges = note.appointment_id
    ? db.prepare("SELECT cpt_code, modifier, units, diagnosis_codes FROM charges WHERE appointment_id = ? AND status <> 'void'").all(note.appointment_id) : [];
  const diagnoses = db.prepare("SELECT icd10_code, description, is_primary FROM diagnoses WHERE patient_id = ? AND status = 'active' ORDER BY is_primary DESC")
    .all(note.patient_id);
  const plan = db.prepare("SELECT id, review_date, status FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(note.patient_id);
  const objectives = plan ? db.prepare(
    `SELECT o.id, o.text FROM plan_objectives o JOIN plan_goals g ON g.id = o.goal_id JOIN plan_problems p ON p.id = g.problem_id
     WHERE p.plan_id = ? AND o.status <> 'discontinued' ORDER BY p.sort, g.sort, o.sort`).all(plan.id) : [];
  const addressed = db.prepare("SELECT objective_id, progress, comment FROM note_objectives WHERE note_id = ?").all(note.id);
  return {
    note_type: note.type,
    format: note.format,
    service_date: note.service_date,
    risk_level: note.risk_level,
    session_minutes: minutesBetween(content.session_start, content.session_end),
    appointment: appt ? { type: appt.type, modality: appt.modality, scheduled_minutes: minutesBetween(appt.start_at.slice(11, 16), appt.end_at.slice(11, 16)) } : null,
    charges: charges.map((c) => ({ cpt: c.cpt_code, modifier: c.modifier, units: c.units, diagnosis_codes: c.diagnosis_codes })),
    diagnoses: diagnoses.map((d) => ({ code: d.icd10_code, description: d.description, primary: !!d.is_primary })),
    treatment_plan: plan ? { active: true, review_due: plan.review_date } : { active: false },
    plan_objectives: objectives.map((o) => ({ id: o.id, text: o.text, addressed_this_session: addressed.some((a) => a.objective_id === o.id) })),
    objectives_addressed: addressed.length,
    content,
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

  if (therapy && ctx.session_minutes == null) {
    out.push(finding("high", "Time", "Session start and end times are missing.", "Record start and end times; most payers deny time-based psychotherapy codes without them."));
  }
  for (const ch of ctx.charges) {
    const range = CPT_TIME[ch.cpt];
    if (range && ctx.session_minutes != null && (ctx.session_minutes < range[0] || ctx.session_minutes > range[1])) {
      out.push(finding("high", "Coding", `CPT ${ch.cpt} requires ${range[0]}${range[1] === Infinity ? "+" : `–${range[1]}`} minutes, but the note documents ${ctx.session_minutes} minutes.`,
        "Correct the session times or change the charge to the code that matches the documented time."));
    }
    if (ctx.appointment && ctx.appointment.modality === "telehealth" && !/95|GT/i.test(ch.modifier || "")) {
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

let clientOverride = null;
/** Tests can inject a fake client: setClient({ beta: { messages: { create: async () => response } } }). */
function setClient(c) { clientOverride = c; }

function aiConfigured() {
  if (clientOverride) return true;
  return process.env.EHR_AI_REVIEW === "1" && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function aiReview(ctx) {
  const client = clientOverride || new Anthropic({ timeout: 120_000, maxRetries: 2 });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
    system: SYSTEM_PROMPT,
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

/** Run both layers. Never throws: AI failures come back as { ai: { ok: false, error } }. */
async function reviewNote(db, note) {
  const ctx = buildContext(db, note);
  const rules = ruleChecks(ctx);
  let ai = { ok: false, skipped: true };
  if (aiConfigured()) {
    try {
      ai = await aiReview(ctx);
    } catch (err) {
      const status = err && err.status;
      ai = { ok: false, error: status === 429 ? "The AI reviewer is busy (rate limited). Try again in a minute."
        : status === 401 || status === 403 ? "The AI reviewer isn't authorized. Check the Anthropic API key in the hosting settings."
        : "The AI reviewer couldn't be reached. The rule-based checks above still apply." };
      console.error("AI note review failed:", status || "", err && err.message);
    }
  }
  return { rules, ai, ctx };
}

module.exports = { reviewNote, ruleChecks, buildContext, aiConfigured, setClient, FINDINGS_SCHEMA, CPT_TIME, MODEL };
