"use strict";
/*
 * Patient rights: right of access (45 CFR 164.524) and accounting of disclosures (45 CFR 164.528).
 *
 *   GET  /patients/:id/records                  record-copy request form (date range, sections, password)
 *   POST /patients/:id/records/export           generate the designated record set copy (HTML print view or JSON download)
 *   GET  /patients/:id/disclosures              disclosure / release log + form to record a disclosure
 *   POST /patients/:id/disclosures              record a disclosure
 *   GET  /patients/:id/disclosures/accounting   printable accounting of disclosures (last 6 years)
 *
 * Permissions (decision):
 *   - Record copy (full clinical record): clinical:read (admin, clinicians). Generating it requires re-entering the
 *     user's password.
 *   - Disclosure log + accounting: clinical:read, plus billing staff (billing:write) read-only, since billing staff
 *     release information to payers and must be able to see what has gone out.
 *   - Recording a disclosure: admin or clinical:write. Front desk (patients:write only) may NOT record disclosures:
 *     validating an authorization requires reading the ROI consent (clinical content) and front desk has no
 *     clinical:read. Releases handled at the front desk are logged by a clinician or the privacy officer (admin).
 *   - Billing: read-only (no recording, no record copy).
 *
 * Content rules for the record copy:
 *   - Psychotherapy notes are ALWAYS excluded (164.524(a)(1)(i) excludes them from the right of access), regardless
 *     of who generates the copy. Draft notes and draft treatment plans are excluded (not part of the record until
 *     signed). Both exclusions are stated in the output.
 *   - If any included content is substance use disorder related (SUD / co-occurring plans, ASAM notes, ROI consents
 *     covering SUD records, F10-F19 diagnoses) the 42 CFR Part 2 notice is added.
 *   - Generating the copy is audited as 'export' (sections/format only, no PHI). It is logged as a disclosure
 *     (basis 'patient_request') only when the user marks it as released to the patient; internal prints are not
 *     disclosures.
 */
const express = require("express");
const { requirePerm, verifyPassword, forbidden } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { TYPES } = require("./notes");
const { INSTRUMENTS } = require("./clinical");
const { loadTree } = require("./plans");
const {
  html, raw, page, chartPage, notFound, csrfField, select, getPatient, patientName,
  today, fmtDate, fmtDateTime, fmtTimestamp, money, humanize,
} = require("../views");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */
const SECTIONS = [
  { key: "demographics", label: "Demographics and insurance" },
  { key: "diagnoses", label: "Diagnoses" },
  { key: "medications", label: "Medications and allergies" },
  { key: "appointments", label: "Appointments" },
  { key: "notes", label: "Signed clinical notes and addenda" },
  { key: "plans", label: "Treatment plans (active and history, signatures and reviews)" },
  { key: "assessments", label: "Assessments and scores" },
  { key: "billing", label: "Billing ledger (charges and payments)" },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);

const BASES = [
  { value: "authorization", label: "Patient authorization (signed ROI consent)" },
  { value: "patient_request", label: "Patient request / right of access" },
  { value: "required_by_law", label: "Required by law" },
  { value: "public_health", label: "Public health activity" },
  { value: "health_oversight", label: "Health oversight" },
  { value: "judicial", label: "Judicial / administrative proceeding (court order, subpoena)" },
  { value: "law_enforcement", label: "Law enforcement" },
  { value: "treatment", label: "Treatment" },
  { value: "payment", label: "Payment" },
  { value: "operations", label: "Health care operations" },
  { value: "other", label: "Other (e.g. serious threat to health or safety, abuse reporting)" },
];
const BASIS_LABEL = Object.fromEntries(BASES.map((b) => [b.value, b.label]));
/** Categories that 45 CFR 164.528(a)(1) excludes from the accounting (TPO, to the individual, per authorization). */
const NOT_ACCOUNTABLE = ["treatment", "payment", "operations", "patient_request", "authorization"];
const METHODS = ["", "fax", "mail", "portal", "secure_email", "in_person", "phone", "other"];

const PART2_NOTICE = "42 CFR Part 2 notice: this record contains substance use disorder treatment information protected by " +
  "federal confidentiality rules (42 CFR Part 2). Federal law prohibits further use or disclosure of this information except " +
  "as permitted by the patient's written consent or as otherwise allowed by 42 CFR Part 2.";
/** Notice that must accompany each disclosure of Part 2 records (42 CFR 2.32). */
const PART2_REDISCLOSURE = "42 CFR part 2 prohibits unauthorized use or disclosure of these records. This information has been " +
  "disclosed from records protected by federal confidentiality rules (42 CFR Part 2); it may not be further used or disclosed " +
  "except as expressly permitted by the written consent of the person to whom it pertains or as otherwise permitted by 42 CFR Part 2.";
const EXCLUSION_STATEMENT = "Not included: psychotherapy notes (process notes kept separately by the treating clinician, which " +
  "are excluded from the right of access under 45 CFR 164.524(a)(1)(i)), and draft or unsigned documentation that is not part " +
  "of the designated record set.";

const MAX = 2000;
const str = (v, max = MAX) => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")).trim().slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map(String);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z"));
const empty = (v) => v === undefined || v === null || String(v).trim() === "";
const parseJson = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const isSudCode = (code) => /^F1\d/i.test(String(code || "").trim());

const canViewDisclosures = (u) => can(u, "clinical:read") || can(u, "billing:write");
const canRecordDisclosure = (u) => can(u, "admin") || can(u, "clinical:write");
const requireDisclosureView = (req, res, next) => (canViewDisclosures(req.user) ? next() : forbidden(req, res));
const requireDisclosureWrite = (req, res, next) => (canRecordDisclosure(req.user) ? next() : forbidden(req, res));

function loadPatient(req, res) {
  const p = getPatient(req, req.params.id);
  if (!p) notFound(req, res, "Patient");
  return p;
}

function checkPassword(db, userId, password) {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
  return !!row && typeof password === "string" && password.length > 0 && verifyPassword(password, row.password_hash);
}

/* ------------------------------------------------------------------ */
/* Designated record set builder                                      */
/* ------------------------------------------------------------------ */

/** Render a note's content as [{label, value}] using the note type's field definitions. */
function noteSections(note) {
  const c = parseJson(note.content || "{}", {});
  const t = TYPES[note.type];
  if (!t) return Object.entries(c).filter(([, v]) => !empty(v)).map(([k, v]) => ({ label: humanize(k), value: String(v) }));
  const fields = t.formats[note.format] || t.formats[Object.keys(t.formats)[0]];
  const ed = c.asam_edition === "4" ? "4" : "3";
  const out = [];
  const push = (label, value) => { if (!empty(value)) out.push({ label, value: String(value) }); };
  for (const f of fields) {
    switch (f.kind) {
      case "textarea": case "text": push(f.label, c[f.key]); break;
      case "date": push(f.label, c[f.key] ? fmtDate(c[f.key]) : ""); break;
      case "select": {
        const o = (f.options || []).find((x) => x.value === c[f.key] && x.value !== "");
        push(f.label, o ? o.label : c[f.key]);
        break;
      }
      case "edition": push(f.label, c.asam_edition ? `${c.asam_edition === "4" ? "4th" : "3rd"} edition` : ""); break;
      case "asam_level": case "legacy": push(f.label, c[f.key]); break;
      case "rated": {
        const label = (f.labels && f.labels[ed]) || f.label;
        const parts = [];
        if (!empty(c[`${f.key}_rating`])) parts.push(`Rating: ${c[`${f.key}_rating`]}`);
        if (c[`${f.key}_driver`]) parts.push("Dimensional driver");
        if (!empty(c[f.key])) parts.push(String(c[f.key]));
        push(label, parts.join(" · "));
        break;
      }
      case "session":
        if (c.session_start || c.session_end) push("Session time", `${c.session_start || "?"} to ${c.session_end || "?"}`);
        break;
      case "interventions":
        push("Interventions used", [...(c.interventions || []), ...(c.interventions_other ? [c.interventions_other] : [])].join(", "));
        break;
      case "mse": {
        const rows = Object.keys(c).filter((k) => k.startsWith("mse_") && !empty(c[k]))
          .map((k) => `${humanize(k.slice(4))}: ${c[k]}`);
        push("Mental status exam", rows.join("\n"));
        break;
      }
      case "risk":
        push("Risk assessment", [note.risk_level ? `Risk level: ${humanize(note.risk_level)}` : "", c.risk_narrative || ""]
          .filter(Boolean).join("\n"));
        break;
      default: break;
    }
  }
  return out;
}

const PLAN_FIELDS = [
  ["summary", "Summary"], ["client_vision", "Client's vision (own words)"], ["strengths", "Strengths"], ["needs", "Needs"],
  ["abilities", "Abilities"], ["preferences", "Preferences"], ["barriers", "Barriers"], ["natural_supports", "Natural supports"],
  ["family_involvement", "Family involvement"], ["service_summary", "Services"], ["modality_rationale", "Modality rationale"],
  ["estimated_duration", "Estimated duration"], ["expected_outcome", "Expected outcome"], ["discharge_criteria", "Discharge criteria"],
  ["aftercare_referrals", "Aftercare / referrals"], ["level_of_care", "Level of care / program"], ["loc_indicated", "Level of care indicated"],
  ["loc_adjusted", "Level of care provided"], ["loc_reason", "Level of care reason"], ["continued_stay", "Continued stay"],
  ["mat_plan", "Medication for addiction treatment"], ["drug_testing_plan", "Drug testing plan"],
  ["relapse_prevention", "Relapse prevention"], ["recovery_supports", "Recovery supports"],
];

/**
 * Build the designated record set copy as a plain object (also the JSON export).
 * opts: { from, to, sections: [keys] }. Dated items are filtered to the range; current-state lists
 * (demographics, insurance, diagnoses, medications, allergies) are included in full.
 */
function buildRecord(db, patient, { from = "", to = "", sections = SECTION_KEYS } = {}) {
  const inc = new Set(sections);
  const lo = from || "0000-01-01", hi = to || "9999-12-31";
  const sud = [];
  const userName = (id) => {
    if (!id) return null;
    const u = db.prepare("SELECT name, credentials FROM users WHERE id = ?").get(id);
    return u ? `${u.name}${u.credentials ? `, ${u.credentials}` : ""}` : null;
  };
  const rec = {
    title: "Designated record set copy",
    generated_at: new Date().toISOString(),
    date_range: { from: from || null, to: to || null },
    sections_included: SECTION_KEYS.filter((k) => inc.has(k)),
    exclusions: EXCLUSION_STATEMENT,
    patient: { name: patientName(patient), mrn: patient.mrn, dob: patient.dob },
  };

  if (inc.has("demographics")) {
    const p = patient;
    rec.demographics = {
      first_name: p.first_name, last_name: p.last_name, preferred_name: p.preferred_name, dob: p.dob,
      sex_at_birth: p.sex_at_birth, gender_identity: p.gender_identity, pronouns: p.pronouns, phone: p.phone, email: p.email,
      address: [p.address_line1, p.address_line2, p.city, p.state, p.zip].filter(Boolean).join(", "),
      preferred_contact: p.preferred_contact, emergency_contact: [p.emergency_name, p.emergency_relation, p.emergency_phone].filter(Boolean).join(", "),
      status: p.status,
    };
    rec.insurance = db.prepare(
      `SELECT priority, payer_name, member_id, group_number, subscriber_name, subscriber_relation, copay_cents, active
       FROM insurance_policies WHERE patient_id = ? ORDER BY active DESC, priority, id`).all(p.id);
  }
  if (inc.has("diagnoses")) {
    rec.diagnoses = db.prepare(
      `SELECT icd10_code, description, status, is_primary, onset_date FROM diagnoses WHERE patient_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, is_primary DESC, id`).all(patient.id);
    if (rec.diagnoses.some((d) => isSudCode(d.icd10_code))) sud.push("diagnoses");
  }
  if (inc.has("medications")) {
    rec.medications = db.prepare(
      `SELECT name, dose, route, frequency, prescriber, start_date, end_date, active, notes FROM medications
       WHERE patient_id = ? ORDER BY active DESC, name COLLATE NOCASE`).all(patient.id);
    rec.allergies = db.prepare("SELECT substance, reaction, severity, active FROM allergies WHERE patient_id = ? ORDER BY active DESC, substance")
      .all(patient.id);
  }
  if (inc.has("appointments")) {
    rec.appointments = db.prepare(
      `SELECT a.start_at, a.end_at, a.type, a.modality, a.status, u.name AS clinician FROM appointments a
       JOIN users u ON u.id = a.clinician_id WHERE a.patient_id = ? AND substr(a.start_at, 1, 10) BETWEEN ? AND ?
       ORDER BY a.start_at`).all(patient.id, lo, hi);
  }
  if (inc.has("notes")) {
    // Psychotherapy notes and drafts are never part of the copy.
    const notes = db.prepare(
      `SELECT n.* FROM notes n WHERE n.patient_id = ? AND n.status = 'signed' AND n.type <> 'psychotherapy'
       AND COALESCE(n.service_date, substr(n.signed_at, 1, 10)) BETWEEN ? AND ?
       ORDER BY COALESCE(n.service_date, substr(n.signed_at, 1, 10)), n.id`).all(patient.id, lo, hi);
    const addenda = db.prepare("SELECT author_id, content, created_at FROM note_addenda WHERE note_id = ? ORDER BY id");
    rec.notes = notes.map((n) => {
      if (n.type === "asam") sud.push("asam");
      if (n.type === "roi" && parseJson(n.content, {}).includes_sud === "yes") sud.push("roi");
      return {
        type: n.type, type_label: TYPES[n.type] ? TYPES[n.type].label : humanize(n.type), format: n.format,
        service_date: n.service_date, author: userName(n.author_id), signed_by: userName(n.signed_by), signed_at: n.signed_at,
        risk_level: n.risk_level, sections: noteSections(n),
        addenda: addenda.all(n.id).map((a) => ({ author: userName(a.author_id), created_at: a.created_at, content: a.content })),
      };
    });
  }
  if (inc.has("plans")) {
    const plans = db.prepare(
      `SELECT * FROM treatment_plans WHERE patient_id = ? AND status <> 'draft'
       AND COALESCE(start_date, substr(activated_at, 1, 10), substr(signed_at, 1, 10), substr(created_at, 1, 10)) <= ?
       AND COALESCE(substr(ended_at, 1, 10), '9999-12-31') >= ?
       ORDER BY COALESCE(version, 1) DESC, id DESC`).all(patient.id, hi, lo);
    rec.treatment_plans = plans.map((pl) => {
      if (pl.plan_type === "sud" || pl.plan_type === "co_occurring") sud.push("plan");
      const tree = loadTree(db, pl);
      const fields = PLAN_FIELDS.filter(([k]) => !empty(pl[k])).map(([k, label]) => ({ label, value: String(pl[k]) }));
      return {
        version: pl.version, status: pl.status, plan_type: pl.plan_type, start_date: pl.start_date, review_date: pl.review_date,
        activated_at: pl.activated_at, ended_at: pl.ended_at, end_reason: pl.end_reason, author: userName(pl.author_id),
        diagnoses: parseJson(pl.diagnoses || "[]", []), fields,
        problems: tree.problems.map((p) => ({
          num: p.num, title: p.title, definition: p.behavioral_definition, icd10_code: p.icd10_code, status: p.status,
          goals: p.goals.map((g) => ({
            num: g.num, client_words: g.client_words, goal: g.goal_text,
            objectives: g.objectives.map((o) => ({
              num: o.num, text: o.text, status: o.status, target_date: o.target_date,
              interventions: o.interventions.map((i) => [i.modality, i.description, i.frequency].filter(Boolean).join(" · ")),
            })),
          })),
        })),
        signatures: db.prepare(
          "SELECT role, signer_name, method, declined, declined_reason, signed_at FROM plan_signatures WHERE plan_id = ? ORDER BY signed_at, id")
          .all(pl.id),
        reviews: db.prepare(
          `SELECT review_date, reviewer_id, participants, client_perspective, summary, outcome, signed_at FROM plan_reviews
           WHERE plan_id = ? AND signed_at IS NOT NULL ORDER BY review_date, id`).all(pl.id)
          .map((r) => ({ ...r, reviewer: userName(r.reviewer_id), reviewer_id: undefined })),
      };
    });
  }
  if (inc.has("assessments")) {
    rec.assessments = db.prepare(
      `SELECT instrument, administered_on, total_score, severity, flagged FROM assessments
       WHERE patient_id = ? AND administered_on BETWEEN ? AND ? ORDER BY administered_on, id`).all(patient.id, lo, hi)
      .map((a) => ({ ...a, instrument_name: INSTRUMENTS[a.instrument] ? INSTRUMENTS[a.instrument].name : a.instrument }));
  }
  if (inc.has("billing")) {
    const charges = db.prepare(
      `SELECT date_of_service, cpt_code, modifier, units, fee_cents, diagnosis_codes, bill_to, status FROM charges
       WHERE patient_id = ? AND date_of_service BETWEEN ? AND ? ORDER BY date_of_service, id`).all(patient.id, lo, hi);
    const payments = db.prepare(
      `SELECT received_on, amount_cents, method, reference FROM payments WHERE patient_id = ? AND received_on BETWEEN ? AND ?
       ORDER BY received_on, id`).all(patient.id, lo, hi);
    const charged = charges.filter((c) => c.status !== "void").reduce((s, c) => s + c.fee_cents, 0);
    const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
    rec.billing = { charges, payments, total_charges_cents: charged, total_payments_cents: paid, balance_cents: charged - paid };
    if (charges.some((c) => String(c.diagnosis_codes || "").split(",").some(isSudCode))) sud.push("billing");
  }
  rec.part2 = sud.length > 0;
  rec.part2_notice = rec.part2 ? PART2_NOTICE : null;
  return rec;
}

/* ------------------------------------------------------------------ */
/* Record copy: HTML rendering                                        */
/* ------------------------------------------------------------------ */
const kv = (rows) => html`<dl class="facts plan-facts">${rows.filter(([, v]) => !empty(v)).map(([k, v]) => html`<dt>${k}</dt><dd class="prewrap">${v}</dd>`)}</dl>`;
const none = html`<p class="muted">None recorded.</p>`;

function recordHtml(req, patient, rec) {
  const sec = (title, body) => html`<section class="print-sec"><h2>${title}</h2>${body}</section>`;
  const parts = [];
  if (rec.demographics) {
    const d = rec.demographics;
    parts.push(sec("Demographics", kv([["Name", `${d.last_name}, ${d.first_name}`], ["Preferred name", d.preferred_name],
      ["Date of birth", fmtDate(d.dob)], ["Sex assigned at birth", d.sex_at_birth], ["Gender identity", d.gender_identity],
      ["Pronouns", d.pronouns], ["Phone", d.phone], ["Email", d.email], ["Address", d.address],
      ["Preferred contact", d.preferred_contact], ["Emergency contact", d.emergency_contact], ["Status", humanize(d.status)]])));
    parts.push(sec("Insurance", rec.insurance.length ? html`<table class="table print-table"><thead><tr><th>Priority</th><th>Payer</th>
      <th>Member ID</th><th>Group</th><th>Subscriber</th><th>Status</th></tr></thead><tbody>${rec.insurance.map((i) => html`<tr>
      <td>${humanize(i.priority)}</td><td>${i.payer_name}</td><td>${i.member_id}</td><td>${i.group_number}</td>
      <td>${i.subscriber_name}${i.subscriber_relation ? ` (${i.subscriber_relation})` : ""}</td><td>${i.active ? "Active" : "Inactive"}</td></tr>`)}
      </tbody></table>` : none));
  }
  if (rec.diagnoses) {
    parts.push(sec("Diagnoses", rec.diagnoses.length ? html`<table class="table print-table"><thead><tr><th>Code</th><th>Description</th>
      <th>Status</th><th>Onset</th></tr></thead><tbody>${rec.diagnoses.map((d) => html`<tr><td>${d.icd10_code}</td>
      <td>${d.description}${d.is_primary ? " (primary)" : ""}</td><td>${humanize(d.status)}</td><td>${fmtDate(d.onset_date)}</td></tr>`)}
      </tbody></table>` : none));
  }
  if (rec.medications) {
    parts.push(sec("Medications", rec.medications.length ? html`<table class="table print-table"><thead><tr><th>Medication</th>
      <th>Dose / route / frequency</th><th>Prescriber</th><th>Dates</th><th>Status</th></tr></thead><tbody>${rec.medications.map((m) => html`<tr>
      <td>${m.name}</td><td>${[m.dose, m.route, m.frequency].filter(Boolean).join(" · ")}</td><td>${m.prescriber}</td>
      <td>${fmtDate(m.start_date)}${m.end_date ? ` to ${fmtDate(m.end_date)}` : ""}</td><td>${m.active ? "Active" : "Discontinued"}</td></tr>`)}
      </tbody></table>` : none));
    parts.push(sec("Allergies", rec.allergies.length ? html`<ul class="list">${rec.allergies.map((a) => html`<li>${a.substance}
      ${a.reaction ? ` (${a.reaction})` : ""}${a.severity ? `, ${a.severity}` : ""}${a.active ? "" : " [inactive]"}</li>`)}</ul>`
      : html`<p>No known allergies recorded.</p>`));
  }
  if (rec.appointments) {
    parts.push(sec("Appointments", rec.appointments.length ? html`<table class="table print-table"><thead><tr><th>Date / time</th>
      <th>Type</th><th>Clinician</th><th>Modality</th><th>Status</th></tr></thead><tbody>${rec.appointments.map((a) => html`<tr>
      <td>${fmtDateTime(a.start_at)}</td><td>${humanize(a.type)}</td><td>${a.clinician}</td><td>${humanize(a.modality)}</td>
      <td>${humanize(a.status)}</td></tr>`)}</tbody></table>` : none));
  }
  if (rec.notes) {
    parts.push(sec("Clinical notes (signed)", rec.notes.length ? rec.notes.map((n) => html`
      <div class="print-problem"><h3>${n.type_label} · ${fmtDate(n.service_date || n.signed_at)}</h3>
        ${kv(n.sections.map((s) => [s.label, s.value]))}
        <p class="signature">Electronically signed by ${n.signed_by || n.author || "Unknown"} on ${fmtTimestamp(n.signed_at)}</p>
        ${n.addenda.map((a) => html`<div class="note-section"><h3>Addendum · ${a.author || "Unknown"} · ${fmtTimestamp(a.created_at)}</h3><p>${a.content}</p></div>`)}
      </div>`) : none));
  }
  if (rec.treatment_plans) {
    parts.push(sec("Treatment plans", rec.treatment_plans.length ? rec.treatment_plans.map((p) => html`
      <div class="print-problem"><h3>Treatment plan version ${p.version || 1} · ${humanize(p.status)} · ${humanize(p.plan_type)}</h3>
        ${kv([["Start date", fmtDate(p.start_date)], ["Review date", fmtDate(p.review_date)], ["Ended", fmtDate(p.ended_at)],
          ["Author", p.author], ["Diagnoses", p.diagnoses.map((d) => `${d.code} ${d.description || ""}`.trim()).join("; ")],
          ...p.fields.map((f) => [f.label, f.value])])}
        ${p.problems.map((pr) => html`<div class="print-problem"><p><strong>${pr.num}. ${pr.title}</strong>${pr.icd10_code ? ` (${pr.icd10_code})` : ""} · ${humanize(pr.status)}</p>
          ${pr.definition ? html`<p class="prewrap">${pr.definition}</p>` : ""}
          ${pr.goals.map((g) => html`<p><strong>Goal ${g.num}:</strong> ${g.goal}${g.client_words ? html` <em>“${g.client_words}”</em>` : ""}</p>
            <ul class="list">${g.objectives.map((o) => html`<li>Objective ${o.num}: ${o.text} (${humanize(o.status)}${o.target_date ? `, target ${fmtDate(o.target_date)}` : ""})
              ${o.interventions.length ? html`<ul class="print-ints">${o.interventions.map((i) => html`<li>${i}</li>`)}</ul>` : ""}</li>`)}</ul>`)}
        </div>`)}
        <p><strong>Signatures</strong></p>
        ${p.signatures.length ? html`<ul class="list">${p.signatures.map((s) => html`<li>${humanize(s.role)}: ${s.signer_name}
          ${s.declined ? ` declined${s.declined_reason ? ` (${s.declined_reason})` : ""}` : ` signed ${fmtTimestamp(s.signed_at)}`}${s.method ? ` · ${humanize(s.method)}` : ""}</li>`)}</ul>` : none}
        ${p.reviews.length ? html`<p><strong>Reviews</strong></p><ul class="list">${p.reviews.map((r) => html`<li>${fmtDate(r.review_date)} · ${r.reviewer || ""} ·
          Outcome: ${humanize(r.outcome)}${r.summary ? html`<br><span class="prewrap">${r.summary}</span>` : ""}</li>`)}</ul>` : ""}
      </div>`) : none));
  }
  if (rec.assessments) {
    parts.push(sec("Assessments and scores", rec.assessments.length ? html`<table class="table print-table"><thead><tr><th>Date</th>
      <th>Instrument</th><th>Score</th><th>Severity</th></tr></thead><tbody>${rec.assessments.map((a) => html`<tr>
      <td>${fmtDate(a.administered_on)}</td><td>${a.instrument_name}</td><td>${a.total_score}</td>
      <td>${a.severity}${a.flagged ? " (flagged)" : ""}</td></tr>`)}</tbody></table>` : none));
  }
  if (rec.billing) {
    const b = rec.billing;
    parts.push(sec("Billing ledger", html`
      ${b.charges.length ? html`<table class="table print-table"><thead><tr><th>Date of service</th><th>CPT</th><th>Units</th>
        <th>Fee</th><th>Diagnoses</th><th>Status</th></tr></thead><tbody>${b.charges.map((c) => html`<tr><td>${fmtDate(c.date_of_service)}</td>
        <td>${c.cpt_code}${c.modifier ? `-${c.modifier}` : ""}</td><td>${c.units}</td><td>${money(c.fee_cents)}</td>
        <td>${c.diagnosis_codes}</td><td>${humanize(c.status)}</td></tr>`)}</tbody></table>` : html`<p class="muted">No charges.</p>`}
      ${b.payments.length ? html`<table class="table print-table"><thead><tr><th>Received</th><th>Amount</th><th>Method</th></tr></thead>
        <tbody>${b.payments.map((p) => html`<tr><td>${fmtDate(p.received_on)}</td><td>${money(p.amount_cents)}</td>
        <td>${humanize(p.method)}</td></tr>`)}</tbody></table>` : html`<p class="muted">No payments.</p>`}
      ${kv([["Total charges", money(b.total_charges_cents)], ["Total payments / adjustments", money(b.total_payments_cents)],
        ["Balance", money(b.balance_cents)]])}`));
  }
  const range = rec.date_range.from || rec.date_range.to
    ? `${rec.date_range.from ? fmtDate(rec.date_range.from) : "Beginning of record"} to ${rec.date_range.to ? fmtDate(rec.date_range.to) : "present"}`
    : "Entire record";
  return page(req, { title: "Designated record set copy", bare: true, body: html`
    <div class="print-toolbar no-print">
      <a class="btn btn--ghost btn--sm" href="/ehr/patients/${patient.id}/records">← Back to records</a>
      <button class="btn btn--primary btn--sm" type="button" data-print>Print</button>
    </div>
    <article class="print-sheet">
      <header class="print-head">
        <div><p class="print-org">${require("../clinic").getClinic(req.db).name}</p>
          <h1>Designated record set copy</h1>
          <p class="muted">Provided under the HIPAA right of access (45 CFR 164.524)</p></div>
        <dl class="facts print-patient">
          <dt>Client</dt><dd>${patientName(patient)}</dd>
          <dt>DOB</dt><dd>${fmtDate(patient.dob)}</dd>
          <dt>MRN</dt><dd>${patient.mrn}</dd>${patient.ahcccs_id ? html`<dt>AHCCCS ID</dt><dd>${patient.ahcccs_id}</dd>` : ""}
          <dt>Period</dt><dd>${range}</dd>
          <dt>Generated</dt><dd>${fmtTimestamp(rec.generated_at.replace("T", " ").slice(0, 19))}</dd>
        </dl>
      </header>
      ${rec.part2 ? html`<p class="alert alert--info part2">${PART2_NOTICE}</p>` : ""}
      <p class="alert alert--info">${EXCLUSION_STATEMENT}</p>
      ${parts}
      <footer class="print-foot muted small">Sections included: ${rec.sections_included.map((k) => SECTIONS.find((s) => s.key === k).label).join("; ")}.
        ${rec.part2 ? PART2_NOTICE : ""}</footer>
    </article>` });
}

/* ------------------------------------------------------------------ */
/* Record copy routes                                                 */
/* ------------------------------------------------------------------ */
function recordsPage(req, res, patient, { errors = [], values = {}, status = 200 } = {}) {
  const v = { format: "html", sections: SECTION_KEYS, released_method: "", ...values };
  const sel = new Set(v.sections);
  const exports = req.db.prepare(
    `SELECT a.ts, a.detail, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.patient_id = ? AND a.action = 'export' AND a.entity_type = 'record_copy' ORDER BY a.id DESC LIMIT 10`).all(patient.id);
  audit(req, "view", "record_copy", null, patient.id, "records page");
  res.status(status).send(chartPage(req, patient, "overview", html`
    <div class="page-head"><h2>Records &amp; disclosures</h2>
      <div class="row"><a class="btn btn--sm" href="/ehr/patients/${patient.id}/disclosures">Disclosure log</a>
      <a class="btn btn--sm" href="/ehr/patients/${patient.id}/disclosures/accounting">Accounting of disclosures</a></div></div>
    <section class="card" aria-labelledby="copy-h">
      <h2 id="copy-h">Generate record copy</h2>
      <p class="muted">Right of access (45 CFR 164.524): the client may inspect or receive a copy of their designated record set.
        Respond within 30 days. ${EXCLUSION_STATEMENT}</p>
      ${errors.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong>
        <ul class="list">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form method="post" action="/ehr/patients/${patient.id}/records/export" class="stack">
        ${csrfField(req)}
        <div class="form-grid">
          <label for="from">From (optional)<input type="date" id="from" name="from" value="${v.from || ""}"></label>
          <label for="to">To (optional)<input type="date" id="to" name="to" value="${v.to || ""}"></label>
        </div>
        <fieldset><legend>Include sections</legend>
          <div class="form-grid">${SECTIONS.map((s) => html`<label class="check"><input type="checkbox" name="sections" value="${s.key}"
            ${sel.has(s.key) ? raw("checked") : ""}> ${s.label}</label>`)}</div>
        </fieldset>
        <fieldset><legend>Output</legend>
          <div class="form-grid">
            <label class="check"><input type="radio" name="format" value="html" ${v.format !== "json" ? raw("checked") : ""}> Printable copy (HTML)</label>
            <label class="check"><input type="radio" name="format" value="json" ${v.format === "json" ? raw("checked") : ""}> JSON download (electronic copy)</label>
          </div>
        </fieldset>
        <fieldset><legend>Release</legend>
          <label class="check"><input type="checkbox" name="released" value="1" ${v.released ? raw("checked") : ""}> Released to the patient
            (or the patient's designee); logs a disclosure with basis "patient request"</label>
          <div class="form-grid">
            <label for="released_to">Released to<input id="released_to" name="released_to" maxlength="200" value="${v.released_to || ""}" placeholder="Patient"></label>
            <label for="released_method">Method${select("released_method", METHODS.map((m) => ({ value: m, label: m ? humanize(m) : "Select…" })), v.released_method)}</label>
          </div>
          <p class="hint">Leave unchecked for internal prints; those are audited but are not disclosures.</p>
        </fieldset>
        <label for="password">Re-enter your password to generate the copy
          <input type="password" id="password" name="password" autocomplete="current-password" required></label>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Generate record copy</button></div>
      </form>
    </section>
    <section class="card" aria-labelledby="exp-h">
      <h2 id="exp-h">Recent record copies</h2>
      ${exports.length ? html`<ul class="list-plain">${exports.map((e) => html`<li>${fmtTimestamp(e.ts)} · ${e.name || "Unknown"} <span class="muted small">${e.detail}</span></li>`)}</ul>`
        : html`<p class="muted">None generated yet.</p>`}
    </section>`, { title: `Records · ${patientName(patient)}` }));
}

router.get("/patients/:id/records", requirePerm("clinical:read"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  recordsPage(req, res, patient);
});

router.post("/patients/:id/records/export", requirePerm("clinical:read"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body || {};
  const values = {
    from: str(b.from, 10), to: str(b.to, 10), sections: arr(b.sections).filter((s) => SECTION_KEYS.includes(s)),
    format: b.format === "json" ? "json" : "html", released: b.released === "1", released_to: str(b.released_to, 200),
    released_method: METHODS.includes(str(b.released_method)) ? str(b.released_method) : "",
  };
  const errors = [];
  if (values.from && !isDate(values.from)) errors.push("From date is not a valid date.");
  if (values.to && !isDate(values.to)) errors.push("To date is not a valid date.");
  if (values.from && values.to && values.from > values.to) errors.push("From date must be on or before the To date.");
  if (!values.sections.length) errors.push("Choose at least one section.");
  if (!checkPassword(req.db, req.user.id, typeof b.password === "string" ? b.password : "")) {
    errors.push("Password is incorrect. Re-enter your password to generate a record copy.");
    audit(req, "reauth_failed", "record_copy", null, patient.id, "record copy password check failed");
  }
  if (errors.length) return recordsPage(req, res, patient, { errors, values, status: 400 });

  const rec = buildRecord(req.db, patient, values);
  let disclosureId = null;
  if (values.released) {
    disclosureId = Number(req.db.prepare(
      `INSERT INTO disclosures (patient_id, disclosed_on, recipient, purpose, description, basis, includes_part2, method, entered_by)
       VALUES (?, ?, ?, ?, ?, 'patient_request', ?, ?, ?)`).run(patient.id, today(), values.released_to || "Patient",
      "Patient right of access (45 CFR 164.524)",
      `Designated record set copy (${values.format.toUpperCase()}): ${values.sections.map((k) => SECTIONS.find((s) => s.key === k).label).join("; ")}` +
        (values.from || values.to ? `; period ${values.from || "start"} to ${values.to || "present"}` : ""),
      rec.part2 ? 1 : 0, values.released_method || null, req.user.id).lastInsertRowid);
    audit(req, "create", "disclosure", disclosureId, patient.id, "basis=patient_request; source=record_copy");
  }
  audit(req, "export", "record_copy", disclosureId, patient.id,
    `format=${values.format}; sections=${values.sections.join(",")}; range=${values.from || values.to ? "limited" : "all"}; ` +
    `released=${values.released ? "yes" : "no"}; part2=${rec.part2 ? "yes" : "no"}`);

  if (values.format === "json") {
    const fname = `record-copy-${String(patient.mrn).replace(/[^A-Za-z0-9_-]/g, "")}-${today()}.json`;
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${fname}"`);
    return res.send(JSON.stringify(rec, null, 2));
  }
  res.send(recordHtml(req, patient, rec));
});

/* ------------------------------------------------------------------ */
/* Disclosures                                                        */
/* ------------------------------------------------------------------ */
function roiNotes(db, patientId) {
  return db.prepare(
    `SELECT id, content, signed_at, service_date FROM notes WHERE patient_id = ? AND type = 'roi' AND status = 'signed' ORDER BY id DESC`)
    .all(patientId).map((n) => ({ ...n, c: parseJson(n.content, {}) }));
}

/** Why an ROI consent can't support a disclosure on `onDate`, or null when valid. */
function roiProblem(db, patientId, noteId, onDate, { part2 = false } = {}) {
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
  if (!n || n.patient_id !== patientId) return "The linked consent was not found for this patient.";
  if (n.type !== "roi") return "The linked note is not a release-of-information consent.";
  if (n.status !== "signed") return "The linked release-of-information consent is not signed.";
  const c = parseJson(n.content, {});
  if (!empty(c.revocation)) return "The linked release-of-information consent has been revoked.";
  if (!isDate(String(c.expires_on || ""))) return "The linked consent has no valid expiration date.";
  if (c.expires_on < onDate) return `The linked release-of-information consent expired on ${fmtDate(c.expires_on)}.`;
  if (isDate(String(c.signed_on || "")) && c.signed_on > onDate) return "The disclosure date is before the consent was signed.";
  if (c.direction === "obtain_from") return "The linked consent only permits obtaining information, not releasing it.";
  if (part2 && c.includes_sud !== "yes") return "The linked consent does not cover substance use disorder (42 CFR Part 2) records.";
  return null;
}

function validateDisclosure(db, patientId, body) {
  const v = {
    disclosed_on: str(body.disclosed_on, 10), recipient: str(body.recipient, 300), purpose: str(body.purpose, 500),
    description: str(body.description, 2000), basis: str(body.basis, 30), method: str(body.method, 30),
    includes_part2: body.includes_part2 === "1" ? 1 : 0, authorization_note_id: str(body.authorization_note_id, 12),
  };
  const errors = [];
  if (!isDate(v.disclosed_on)) errors.push("Enter the date of the disclosure.");
  else if (v.disclosed_on > today()) errors.push("The disclosure date can't be in the future.");
  if (!v.recipient) errors.push("Enter the recipient (name, and address if known).");
  if (!v.purpose) errors.push("Enter the purpose of the disclosure.");
  if (!v.description) errors.push("Describe the information disclosed.");
  if (!BASIS_LABEL[v.basis]) errors.push("Choose a valid basis for the disclosure.");
  if (!METHODS.includes(v.method)) errors.push("Choose a valid method.");
  let noteId = null;
  if (v.authorization_note_id) {
    if (!/^\d+$/.test(v.authorization_note_id)) errors.push("Choose a valid consent.");
    else noteId = Number(v.authorization_note_id);
  }
  if (v.basis === "authorization") {
    if (!noteId) errors.push("A disclosure based on authorization requires a linked, signed release-of-information consent.");
    else if (isDate(v.disclosed_on)) {
      const problem = roiProblem(db, patientId, noteId, v.disclosed_on, { part2: !!v.includes_part2 });
      if (problem) errors.push(problem);
    }
  } else if (noteId) {
    const n = db.prepare("SELECT patient_id, type, status FROM notes WHERE id = ?").get(noteId);
    if (!n || n.patient_id !== patientId || n.type !== "roi" || n.status !== "signed") errors.push("The linked note must be a signed release-of-information consent for this patient.");
  }
  return { v: { ...v, authorization_note_id: noteId }, errors };
}

const discRows = (db, patientId, since = "0000-01-01") => db.prepare(
  `SELECT d.*, u.name AS entered_by_name FROM disclosures d LEFT JOIN users u ON u.id = d.entered_by
   WHERE d.patient_id = ? AND d.disclosed_on >= ? ORDER BY d.disclosed_on DESC, d.id DESC`).all(patientId, since);

function disclosureTable(rows, { notice = true } = {}) {
  if (!rows.length) return html`<p class="muted">None recorded.</p>`;
  return html`<div class="table-wrap"><table class="table print-table"><thead><tr><th>Date</th><th>Recipient</th><th>Information disclosed</th>
    <th>Purpose / basis</th><th>Method</th></tr></thead><tbody>${rows.map((d) => html`<tr>
    <td>${fmtDate(d.disclosed_on)}</td><td class="prewrap">${d.recipient}</td>
    <td class="prewrap">${d.description}${d.includes_part2 ? html`<br><span class="pill pill--warn">42 CFR Part 2</span>` : ""}
      ${d.includes_part2 && notice ? html`<br><small class="part2">${PART2_REDISCLOSURE}</small>` : ""}</td>
    <td>${d.purpose}<br><span class="muted small">${BASIS_LABEL[d.basis] || humanize(d.basis)}${d.authorization_note_id ? ` · consent #${d.authorization_note_id}` : ""}</span></td>
    <td>${d.method ? humanize(d.method) : ""}</td></tr>`)}</tbody></table></div>`;
}

function disclosuresPage(req, res, patient, { errors = [], values = {}, status = 200 } = {}) {
  const db = req.db;
  const rows = discRows(db, patient.id);
  const canWrite = canRecordDisclosure(req.user);
  const rois = canWrite ? roiNotes(db, patient.id) : [];
  const v = { disclosed_on: today(), basis: "authorization", method: "", ...values };
  audit(req, "view", "disclosure", null, patient.id, "disclosure log");
  res.status(status).send(chartPage(req, patient, "overview", html`
    <div class="page-head"><h2>Disclosures</h2>
      <div class="row">
        ${can(req.user, "clinical:read") ? html`<a class="btn btn--sm" href="/ehr/patients/${patient.id}/records">Record copy</a>` : ""}
        <a class="btn btn--sm" href="/ehr/patients/${patient.id}/disclosures/accounting">Accounting of disclosures</a></div></div>
    <section class="card" aria-labelledby="log-h">
      <h2 id="log-h">Release log</h2>
      <p class="muted">Every release of this client's information outside the clinic, including those excluded from the
        accounting the client may request (45 CFR 164.528).</p>
      ${disclosureTable(rows, { notice: false })}
    </section>
    ${canWrite ? html`<section class="card" aria-labelledby="new-h">
      <h2 id="new-h">Record a disclosure</h2>
      ${errors.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong>
        <ul class="list">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form method="post" action="/ehr/patients/${patient.id}/disclosures" class="stack">
        ${csrfField(req)}
        <div class="form-grid">
          <label for="disclosed_on">Date disclosed<input type="date" id="disclosed_on" name="disclosed_on" value="${v.disclosed_on}" required></label>
          <label for="basis">Basis${select("basis", BASES, v.basis)}</label>
          <label for="recipient">Recipient<input id="recipient" name="recipient" maxlength="300" value="${v.recipient || ""}" required
            placeholder="Name / organization, address if known"></label>
          <label for="purpose">Purpose<input id="purpose" name="purpose" maxlength="500" value="${v.purpose || ""}" required></label>
          <label for="method">Method${select("method", METHODS.map((m) => ({ value: m, label: m ? humanize(m) : "Select…" })), v.method)}</label>
          <label for="authorization_note_id">Release-of-information consent${select("authorization_note_id",
            [{ value: "", label: "None" }, ...rois.map((n) => ({ value: n.id,
              label: `#${n.id} · ${n.c.recipient || "Recipient not recorded"} · expires ${n.c.expires_on ? fmtDate(n.c.expires_on) : "?"}${!empty(n.c.revocation) ? " · REVOKED" : ""}` }))],
            v.authorization_note_id)}<span class="hint">Required when the basis is authorization. Must be signed, unexpired and not revoked.</span></label>
          <label for="description" class="span-all">Information disclosed<textarea id="description" name="description" rows="3" maxlength="2000" required>${v.description || ""}</textarea></label>
          <label class="check"><input type="checkbox" name="includes_part2" value="1" ${v.includes_part2 ? raw("checked") : ""}>
            Includes substance use disorder records (42 CFR Part 2)</label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Record disclosure</button></div>
      </form>
    </section>` : ""}`, { title: `Disclosures · ${patientName(patient)}` }));
}

router.get("/patients/:id/disclosures", requireDisclosureView, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  disclosuresPage(req, res, patient);
});

router.post("/patients/:id/disclosures", requireDisclosureWrite, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { v, errors } = validateDisclosure(req.db, patient.id, req.body || {});
  if (errors.length) return disclosuresPage(req, res, patient, { errors, values: v, status: 400 });
  const id = Number(req.db.prepare(
    `INSERT INTO disclosures (patient_id, disclosed_on, recipient, purpose, description, basis, authorization_note_id, includes_part2, method, entered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(patient.id, v.disclosed_on, v.recipient, v.purpose, v.description, v.basis,
    v.authorization_note_id, v.includes_part2, v.method || null, req.user.id).lastInsertRowid);
  audit(req, "create", "disclosure", id, patient.id, `basis=${v.basis}; part2=${v.includes_part2 ? "yes" : "no"}`);
  req.flash("success", "Disclosure recorded.");
  res.redirect(`/ehr/patients/${patient.id}/disclosures`);
});

router.get("/patients/:id/disclosures/accounting", requireDisclosureView, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const t = today();
  const since = `${Number(t.slice(0, 4)) - 6}${t.slice(4)}`;
  const rows = discRows(req.db, patient.id, since);
  const accountable = rows.filter((d) => !NOT_ACCOUNTABLE.includes(d.basis));
  const excluded = rows.filter((d) => NOT_ACCOUNTABLE.includes(d.basis));
  audit(req, "view", "disclosure", null, patient.id, `accounting; entries=${accountable.length}; excluded=${excluded.length}`);
  res.send(page(req, { title: "Accounting of disclosures", bare: true, body: html`
    <div class="print-toolbar no-print">
      <a class="btn btn--ghost btn--sm" href="/ehr/patients/${patient.id}/disclosures">← Back to disclosures</a>
      <button class="btn btn--primary btn--sm" type="button" data-print>Print</button>
    </div>
    <article class="print-sheet">
      <header class="print-head">
        <div><p class="print-org">${require("../clinic").getClinic(req.db).name}</p>
          <h1>Accounting of disclosures</h1>
          <p class="muted">45 CFR 164.528 · ${fmtDate(since)} to ${fmtDate(t)}</p></div>
        <dl class="facts print-patient">
          <dt>Client</dt><dd>${patientName(patient)}</dd>
          <dt>DOB</dt><dd>${fmtDate(patient.dob)}</dd>
          <dt>MRN</dt><dd>${patient.mrn}</dd>${patient.ahcccs_id ? html`<dt>AHCCCS ID</dt><dd>${patient.ahcccs_id}</dd>` : ""}
          <dt>Prepared</dt><dd>${fmtDate(t)}</dd>
        </dl>
      </header>
      <section class="print-sec" id="accounting">
        <h2>Disclosures (${accountable.length})</h2>
        <p class="small muted">Lists disclosures of protected health information made in the six years before the request. As permitted
          by 45 CFR 164.528(a)(1), it does not list disclosures for treatment, payment or health care operations, disclosures to you
          or at your request, or disclosures made under your written authorization.</p>
        ${disclosureTable(accountable)}
      </section>
      <section class="print-sec no-print" id="full-release-log">
        <h2>Full release log (internal use, not part of the accounting)</h2>
        <p class="small muted">Releases excluded from the accounting: treatment, payment, operations, patient request and
          authorization. This section does not print.</p>
        ${disclosureTable(excluded)}
      </section>
      <footer class="print-foot muted small">Questions about this accounting may be directed to the clinic's privacy officer.</footer>
    </article>` }));
});

module.exports = { router, buildRecord, roiProblem, NOT_ACCOUNTABLE, PART2_NOTICE, PART2_REDISCLOSURE };
