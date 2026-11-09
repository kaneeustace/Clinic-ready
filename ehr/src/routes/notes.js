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
  html, page, chartPage, notFound, csrfField, select, badge, getPatient, patientName,
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

const ta = (key, label, required = false, hint = "") => ({ kind: "textarea", key, label, required, hint });
const tx1 = (key, label, required = false, hint = "") => ({ kind: "text", key, label, required, hint });
const SESSION = { kind: "session", key: "session" };
const INTERV = { kind: "interventions", key: "interventions" };
const RISK = { kind: "risk", key: "risk" };
const MSE_F = { kind: "mse", key: "mse" };

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

/** Read submitted form fields into { content, risk_level, service_date } plus validation errors (draft-level). */
function readForm(body, type, format) {
  const content = {};
  const errors = {};
  let risk_level = null;
  for (const f of fieldsFor(type, format)) {
    if (f.kind === "textarea" || f.kind === "text") content[f.key] = str(body[f.key]);
    else if (f.kind === "session") {
      content.session_start = str(body.session_start);
      content.session_end = str(body.session_end);
      if (content.session_start && !isTime(content.session_start)) errors.session_start = "Use HH:MM.";
      if (content.session_end && !isTime(content.session_end)) errors.session_end = "Use HH:MM.";
      if (!errors.session_start && !errors.session_end && content.session_start && content.session_end &&
          content.session_end <= content.session_start) errors.session_end = "End time must be after start time.";
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
function signErrors(note) {
  const c = parseContent(note);
  const errors = {};
  const empty = (v) => !v || (Array.isArray(v) ? v.length === 0 : !String(v).trim());
  for (const f of fieldsFor(note.type, note.format)) {
    if ((f.kind === "textarea" || f.kind === "text") && f.required && empty(c[f.key])) errors[f.key] = `${f.label} is required.`;
    if (f.kind === "session") {
      if (empty(c.session_start)) errors.session_start = "Session start time is required.";
      if (empty(c.session_end)) errors.session_end = "Session end time is required.";
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

function psychotherapyNotice() {
  return html`<div class="alert alert--info" role="note"><strong>Psychotherapy notes are private.</strong>
    Under HIPAA, psychotherapy notes (process notes) are kept separate from the medical record. Only you, the author,
    can view this note; it is not shown to other clinicians or administrators and is not released with the record.
    Document diagnosis, risk, interventions and progress in a progress note instead.</div>`;
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
    if (f.kind === "session") {
      return html`
        <label>Session start <span class="hint">(required to sign)</span><input type="time" name="session_start" value="${v.session_start || ""}">${errText(errors, "session_start")}</label>
        <label>Session end <span class="hint">(required to sign)</span><input type="time" name="session_end" value="${v.session_end || ""}">${errText(errors, "session_end")}</label>`;
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

function noteForm(req, res, { patient, type, format, values, errors = {}, action, appointmentId, title, status = 200, noteId }) {
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
    if (f.kind === "textarea" || f.kind === "text") return section(f.label, c[f.key]);
    if (f.kind === "session") {
      return section("Session time", c.session_start || c.session_end
        ? `${fmtTime(`0000-00-00T${c.session_start || ""}`) || "?"} to ${fmtTime(`0000-00-00T${c.session_end || ""}`) || "?"}` : "");
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
    <article class="card">
      <dl class="facts">
        <dt>Patient</dt><dd>${patientName(patient)} (MRN ${patient.mrn})</dd>
        <dt>Service date</dt><dd>${fmtDate(note.service_date)}</dd>
        ${appt ? html`<dt>Appointment</dt><dd>${fmtDate(appt.start_at)} ${fmtTime(appt.start_at)} · ${humanize(appt.type)}</dd>` : ""}
        <dt>Author</dt><dd>${userLine({ name: note.author_name, credentials: note.author_credentials })}</dd>
      </dl>
      <hr>
      ${noteBody(note)}
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
      <div class="row">${TYPE_KEYS.map((k) => html`<a class="btn btn--sm" href="/ehr/patients/${patient.id}/notes/new?type=${k}">${TYPES[k].label}</a>`)}</div>
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
const APPT_DEFAULT_TYPE = { intake: "intake", psychiatry_eval: "intake", med_management: "psychiatry" };

router.get("/patients/:id/notes/new", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { appt, error } = loadAppointment(req, patient.id, req.query.appointment_id);
  if (error) { req.flash("error", error); return res.redirect(`/ehr/patients/${patient.id}/notes`); }
  let type = String(req.query.type || "");
  if (!TYPES[type]) type = (appt && APPT_DEFAULT_TYPE[appt.type]) || "progress";
  let format = String(req.query.format || "");
  if (!formatsFor(type).includes(format)) format = formatsFor(type)[0];
  const values = { service_date: today() };
  if (appt) {
    values.service_date = appt.start_at.slice(0, 10);
    if (type === "progress") { values.session_start = appt.start_at.slice(11, 16); values.session_end = appt.end_at.slice(11, 16); }
  }
  noteForm(req, res, { patient, type, format, values, action: `/ehr/patients/${patient.id}/notes`,
    appointmentId: appt ? appt.id : null, title: `New ${TYPES[type].label.toLowerCase()}` });
});

router.post("/patients/:id/notes", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const type = str(req.body.type);
  if (!TYPES[type]) return res.status(400).send(page(req, { title: "Invalid note", body: html`<div class="card"><h1>Unknown note type</h1></div>` }));
  let format = str(req.body.format);
  if (!formatsFor(type).includes(format)) format = formatsFor(type)[0];
  const { appt, error } = loadAppointment(req, patient.id, str(req.body.appointment_id));
  const form = readForm(req.body, type, format);
  if (error) form.errors.appointment_id = error;
  if (Object.keys(form.errors).length) {
    return noteForm(req, res, { patient, type, format, values: { ...form.content, risk_level: form.risk_level, service_date: form.service_date },
      errors: form.errors, action: `/ehr/patients/${patient.id}/notes`, appointmentId: appt ? appt.id : null,
      title: `New ${TYPES[type].label.toLowerCase()}`, status: 400 });
  }
  const id = Number(req.db.prepare(
    `INSERT INTO notes (patient_id, appointment_id, author_id, type, format, content, risk_level, status, service_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`).run(patient.id, appt ? appt.id : null, req.user.id, type, format,
    JSON.stringify(form.content), form.risk_level, form.service_date).lastInsertRowid);
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
    action: `/ehr/notes/${note.id}/edit`, title: `Edit ${typeLabel(note).toLowerCase()}`, noteId: note.id });
});

router.post("/notes/:noteId/edit", requirePerm("clinical:write"), (req, res) => {
  const loaded = loadNote(req, res);
  if (!loaded || !editGuard(req, res, loaded.note)) return;
  const { note, patient } = loaded;
  const form = readForm(req.body, note.type, note.format);
  if (Object.keys(form.errors).length) {
    return noteForm(req, res, { patient, type: note.type, format: note.format,
      values: { ...form.content, risk_level: form.risk_level, service_date: form.service_date }, errors: form.errors,
      action: `/ehr/notes/${note.id}/edit`, title: `Edit ${typeLabel(note).toLowerCase()}`, noteId: note.id, status: 400 });
  }
  const r = req.db.prepare(
    `UPDATE notes SET content = ?, risk_level = ?, service_date = ?, updated_at = datetime('now')
     WHERE id = ? AND author_id = ? AND status = 'draft'`).run(JSON.stringify(form.content), form.risk_level, form.service_date, note.id, req.user.id);
  if (r.changes !== 1) return deny(req, res, "Signed notes can't be edited. Add an addendum instead.");
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
  const errors = signErrors(note);
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

module.exports = { router, TYPES };
