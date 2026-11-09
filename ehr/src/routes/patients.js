"use strict";
/*
 * Patients module: patient list/search, registration, demographics editing and
 * the chart Overview tab (insurance, allergies, medications, diagnoses).
 */
const express = require("express");
const { requirePerm, forbidden } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { tx, nextMrn } = require("../db");
const { isAhcccs, isAhcccsPlan } = require("../payers");
const {
  html, raw, page, chartPage, notFound, csrfField, badge, getPatient, patientName,
  today, nowLocal, fmtDate, fmtDateTime, age, money, parseMoney, humanize,
} = require("../views");

const router = express.Router();
const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ */
/* Reference data                                                     */
/* ------------------------------------------------------------------ */

// Common outpatient behavioral health ICD-10-CM codes (entry aid only; any valid-format code is accepted).
const ICD10_COMMON = [
  ["F32.0", "Major depressive disorder, single episode, mild"],
  ["F32.1", "Major depressive disorder, single episode, moderate"],
  ["F32.2", "Major depressive disorder, single episode, severe without psychotic features"],
  ["F32.9", "Major depressive disorder, single episode, unspecified"],
  ["F32.A", "Depression, unspecified"],
  ["F33.0", "Major depressive disorder, recurrent, mild"],
  ["F33.1", "Major depressive disorder, recurrent, moderate"],
  ["F33.2", "Major depressive disorder, recurrent severe without psychotic features"],
  ["F33.9", "Major depressive disorder, recurrent, unspecified"],
  ["F34.1", "Dysthymic disorder"],
  ["F31.81", "Bipolar II disorder"],
  ["F31.9", "Bipolar disorder, unspecified"],
  ["F41.0", "Panic disorder [episodic paroxysmal anxiety]"],
  ["F41.1", "Generalized anxiety disorder"],
  ["F41.9", "Anxiety disorder, unspecified"],
  ["F40.10", "Social phobia, unspecified"],
  ["F42.2", "Mixed obsessional thoughts and acts"],
  ["F43.10", "Post-traumatic stress disorder, unspecified"],
  ["F43.12", "Post-traumatic stress disorder, chronic"],
  ["F43.20", "Adjustment disorder, unspecified"],
  ["F43.21", "Adjustment disorder with depressed mood"],
  ["F43.22", "Adjustment disorder with anxiety"],
  ["F43.23", "Adjustment disorder with mixed anxiety and depressed mood"],
  ["F90.0", "Attention-deficit hyperactivity disorder, predominantly inattentive type"],
  ["F90.1", "Attention-deficit hyperactivity disorder, predominantly hyperactive type"],
  ["F90.2", "Attention-deficit hyperactivity disorder, combined type"],
  ["F90.9", "Attention-deficit hyperactivity disorder, unspecified type"],
  ["F50.00", "Anorexia nervosa, unspecified"],
  ["F50.9", "Eating disorder, unspecified"],
  ["F60.3", "Borderline personality disorder"],
  ["F10.20", "Alcohol dependence, uncomplicated"],
  ["F11.20", "Opioid dependence, uncomplicated"],
  ["F12.20", "Cannabis dependence, uncomplicated"],
  ["F51.01", "Primary insomnia"],
  ["Z63.0", "Problems in relationship with spouse or partner"],
];
const ICD10_MAP = new Map(ICD10_COMMON.map(([c, d]) => [c, d]));
const ICD10_RE = /^[A-TV-Z][0-9][0-9AB](\.[0-9A-TV-Z]{1,4})?$/i;

const STATUSES = ["active", "inactive", "discharged"];
const SEX_OPTIONS = [
  { value: "", label: "Not recorded" }, { value: "female", label: "Female" }, { value: "male", label: "Male" },
  { value: "intersex", label: "Intersex" }, { value: "unknown", label: "Unknown / declined" },
];
// Administrative gender as reported on AHCCCS member demographics / 837 claims (M/F/U).
const GENDER_OPTIONS = [
  { value: "", label: "Not recorded" }, { value: "F", label: "Female" }, { value: "M", label: "Male" }, { value: "U", label: "Unknown / not specified" },
];
const AHCCCS_ID_RE = /^[A-Z]\d{8}$/;
/*
 * Payer-name suggestions for the insurance form. AHCCCS health plans change with contract cycles:
 * VERIFY this list against the current AHCCCS contracts (and keep src/payers.js AHCCCS_PLANS in step).
 */
const PAYER_SUGGESTIONS = [
  "Mercy Care", "Banner University Health Plans", "Arizona Complete Health – Complete Care Plan",
  "UnitedHealthcare Community Plan", "Care1st", "Health Choice / AzCH", "Molina Complete Care of Arizona",
  "AHCCCS Fee-for-Service", "AIHP – American Indian Health Program", "DCS CHP",
];
const CONTACT_OPTIONS = [
  { value: "", label: "No preference" }, { value: "phone", label: "Phone call" },
  { value: "text", label: "Text message" }, { value: "email", label: "Email" },
];
const SEVERITY_TONE = { mild: "low", moderate: "moderate", severe: "high" };
const UPCOMING_STATUSES = ["scheduled", "checked_in"];

/* ------------------------------------------------------------------ */
/* Validation helpers                                                 */
/* ------------------------------------------------------------------ */

const str = (v) => (typeof v === "string" ? v.trim() : Array.isArray(v) ? String(v[v.length - 1] ?? "").trim() : "");
const orNull = (v) => (v === "" ? null : v);

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/** Loose phone check. Returns normalized string, null for blank, or false if invalid. */
function normalizePhone(s) {
  if (!s) return null;
  if (!/^[0-9()+\-.\s]+$/.test(s)) return false;
  let digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length >= 7 && digits.length <= 15) return s;
  return false;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkLen(errors, values, name, label, max) {
  if (values[name] && values[name].length > max) errors[name] = `${label} must be ${max} characters or fewer.`;
}

function clinicianOptions(db, currentId) {
  const rows = db.prepare(
    "SELECT id, name, credentials, active FROM users WHERE (role = 'clinician' AND active = 1) OR id = ? ORDER BY name").all(currentId || 0);
  return rows.map((u) => ({
    value: String(u.id),
    label: `${u.name}${u.credentials ? `, ${u.credentials}` : ""}${u.active ? "" : " (inactive)"}`,
  }));
}

const PATIENT_FIELDS = ["first_name", "last_name", "preferred_name", "dob", "sex_at_birth", "gender_identity", "pronouns",
  "phone", "email", "address_line1", "address_line2", "city", "state", "zip", "preferred_contact", "emergency_name",
  "emergency_relation", "emergency_phone", "primary_clinician_id", "status", "ahcccs_id", "gender"];

/** Validate the patient form. Returns { values (for re-render), errors, data (for DB) }. */
function validatePatient(db, body, { current = null } = {}) {
  const values = {};
  for (const f of PATIENT_FIELDS) values[f] = str(body[f]);
  values.ok_voicemail = body.ok_voicemail ? "1" : "";
  values.confirm_duplicate = body.confirm_duplicate ? "1" : "";
  const errors = {};

  if (!values.first_name) errors.first_name = "First name is required.";
  if (!values.last_name) errors.last_name = "Last name is required.";
  checkLen(errors, values, "first_name", "First name", 80);
  checkLen(errors, values, "last_name", "Last name", 80);
  for (const [f, l] of [["preferred_name", "Preferred name"], ["gender_identity", "Gender identity"], ["pronouns", "Pronouns"],
    ["address_line1", "Address"], ["address_line2", "Address line 2"], ["city", "City"], ["emergency_name", "Emergency contact name"],
    ["emergency_relation", "Relationship"]]) checkLen(errors, values, f, l, 120);

  if (!values.dob) errors.dob = "Date of birth is required.";
  else if (!isValidDate(values.dob)) errors.dob = "Enter a valid date (YYYY-MM-DD).";
  else if (values.dob > today()) errors.dob = "Date of birth can't be in the future.";
  else if (values.dob < "1900-01-01") errors.dob = "Date of birth must be after 1900.";

  values.ahcccs_id = values.ahcccs_id.replace(/\s+/g, "").toUpperCase();
  if (values.ahcccs_id && !AHCCCS_ID_RE.test(values.ahcccs_id)) errors.ahcccs_id = "AHCCCS ID is a letter followed by 8 digits, e.g. A12345678.";
  values.gender = values.gender.toUpperCase();
  if (values.gender && !GENDER_OPTIONS.some((o) => o.value === values.gender)) errors.gender = "Choose an option from the list.";
  if (values.sex_at_birth && !SEX_OPTIONS.some((o) => o.value === values.sex_at_birth)) errors.sex_at_birth = "Choose an option from the list.";

  const phone = normalizePhone(values.phone);
  if (phone === false) errors.phone = "Enter a valid phone number, e.g. (555) 010-1234.";
  else values.phone = phone || "";
  const ePhone = normalizePhone(values.emergency_phone);
  if (ePhone === false) errors.emergency_phone = "Enter a valid phone number, e.g. (555) 010-1234.";
  else values.emergency_phone = ePhone || "";

  if (values.email && (!EMAIL_RE.test(values.email) || values.email.length > 200)) errors.email = "Enter a valid email address.";
  values.state = values.state.toUpperCase();
  if (values.state && !/^[A-Z]{2}$/.test(values.state)) errors.state = "Use the 2-letter state code, e.g. NY.";
  if (values.zip && !/^\d{5}(-\d{4})?$/.test(values.zip)) errors.zip = "Enter a 5-digit ZIP code (or ZIP+4).";
  if (values.preferred_contact && !CONTACT_OPTIONS.some((o) => o.value === values.preferred_contact)) {
    errors.preferred_contact = "Choose an option from the list.";
  }
  if (values.preferred_contact === "email" && !values.email && !errors.email) errors.email = "Add an email address or choose another contact method.";
  if ((values.preferred_contact === "phone" || values.preferred_contact === "text") && !values.phone && !errors.phone) {
    errors.phone = "Add a phone number or choose another contact method.";
  }

  let clinicianId = null;
  if (values.primary_clinician_id) {
    clinicianId = Number(values.primary_clinician_id);
    const ok = Number.isInteger(clinicianId) && (
      (current && current.primary_clinician_id === clinicianId) ||
      db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'clinician' AND active = 1").get(clinicianId));
    if (!ok) errors.primary_clinician_id = "Choose an active clinician from the list.";
  }

  if (current) {
    if (!STATUSES.includes(values.status)) errors.status = "Choose a status.";
  } else {
    values.status = "active";
  }

  const data = {
    first_name: values.first_name, last_name: values.last_name, preferred_name: orNull(values.preferred_name), dob: values.dob,
    sex_at_birth: orNull(values.sex_at_birth), gender_identity: orNull(values.gender_identity), pronouns: orNull(values.pronouns),
    phone: orNull(values.phone), email: orNull(values.email), address_line1: orNull(values.address_line1),
    address_line2: orNull(values.address_line2), city: orNull(values.city), state: orNull(values.state), zip: orNull(values.zip),
    preferred_contact: orNull(values.preferred_contact), ok_voicemail: values.ok_voicemail ? 1 : 0,
    emergency_name: orNull(values.emergency_name), emergency_relation: orNull(values.emergency_relation),
    emergency_phone: orNull(values.emergency_phone), primary_clinician_id: clinicianId, status: values.status,
    ahcccs_id: orNull(values.ahcccs_id), gender: orNull(values.gender),
  };
  return { values, errors, data };
}

/* ------------------------------------------------------------------ */
/* Form rendering helpers                                             */
/* ------------------------------------------------------------------ */

function describedBy(id, hint, err) {
  const ids = [hint ? `${id}-hint` : "", err ? `${id}-err` : ""].filter(Boolean).join(" ");
  return html`${ids ? html`aria-describedby="${ids}"` : ""} ${err ? raw('aria-invalid="true"') : ""}`;
}
function fieldExtras(id, hint, err) {
  return html`${hint ? html`<span class="hint" id="${id}-hint">${hint}</span>` : ""}${err ? html`<span class="error-text" id="${id}-err">${err}</span>` : ""}`;
}
function reqMark(required) {
  return required ? html` <span aria-hidden="true">*</span><span class="visually-hidden">(required)</span>` : "";
}

/** <label> wrapping an <input>. f = { values, errors, prefix } */
function field(f, name, label, { type = "text", required = false, hint, attrs = "", cls = "" } = {}) {
  const id = `${f.prefix || ""}${name}`;
  const err = f.errors[name];
  return html`<label ${cls ? html`class="${cls}"` : ""}>${label}${reqMark(required)}
    <input id="${id}" type="${type}" name="${name}" value="${f.values[name] ?? ""}" ${required ? raw("required") : ""} ${describedBy(id, hint, err)} ${raw(attrs)}>
    ${fieldExtras(id, hint, err)}</label>`;
}
function selectField(f, name, label, options, { required = false, hint, cls = "" } = {}) {
  const id = `${f.prefix || ""}${name}`;
  const err = f.errors[name];
  const sel = String(f.values[name] ?? "");
  return html`<label ${cls ? html`class="${cls}"` : ""}>${label}${reqMark(required)}
    <select id="${id}" name="${name}" ${required ? raw("required") : ""} ${describedBy(id, hint, err)}>
      ${options.map((o) => html`<option value="${o.value}" ${String(o.value) === sel ? raw("selected") : ""}>${o.label}</option>`)}
    </select>${fieldExtras(id, hint, err)}</label>`;
}
function textareaField(f, name, label, { hint, cls = "" } = {}) {
  const id = `${f.prefix || ""}${name}`;
  const err = f.errors[name];
  return html`<label ${cls ? html`class="${cls}"` : ""}>${label}
    <textarea id="${id}" name="${name}" rows="3" ${describedBy(id, hint, err)}>${f.values[name] ?? ""}</textarea>${fieldExtras(id, hint, err)}</label>`;
}
function errorSummary(errors) {
  const list = Object.values(errors);
  if (!list.length) return "";
  return html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong>
    <ul class="list">${list.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

function patientForm(req, { values, errors, patient = null, duplicate = null }) {
  const f = { values, errors, prefix: "" };
  const isEdit = !!patient;
  const action = isEdit ? `/ehr/patients/${patient.id}/edit` : "/ehr/patients";
  const clinicians = [{ value: "", label: "Unassigned" }, ...clinicianOptions(req.db, patient && patient.primary_clinician_id)];
  return html`
    <form method="post" action="${action}" class="stack" data-dirty-check novalidate>
      ${csrfField(req)}
      ${errorSummary(errors)}
      ${duplicate ? html`
        <div class="alert alert--warn" role="alert">
          <p><strong>Possible duplicate.</strong> ${duplicate.length === 1 ? "A patient" : `${duplicate.length} patients`} with the same name and date of birth already ${duplicate.length === 1 ? "exists" : "exist"}:</p>
          <ul class="list">${duplicate.map((d) => html`<li><a href="/ehr/patients/${d.id}">${patientName(d)}</a> · MRN ${d.mrn} · ${humanize(d.status)}</li>`)}</ul>
          <label class="check"><input type="checkbox" name="confirm_duplicate" value="1"> This is a different person. Create a new chart anyway.</label>
        </div>` : ""}
      <fieldset>
        <legend>Identity</legend>
        <div class="form-grid">
          ${field(f, "first_name", "Legal first name", { required: true, attrs: 'autocomplete="off" maxlength="80"' })}
          ${field(f, "last_name", "Legal last name", { required: true, attrs: 'autocomplete="off" maxlength="80"' })}
          ${field(f, "preferred_name", "Preferred name", { attrs: 'maxlength="120"' })}
          ${field(f, "dob", "Date of birth", { type: "date", required: true, attrs: `max="${today()}" min="1900-01-01"` })}
          ${selectField(f, "sex_at_birth", "Sex assigned at birth", SEX_OPTIONS)}
          ${field(f, "gender_identity", "Gender identity", { attrs: 'maxlength="120"' })}
          ${field(f, "pronouns", "Pronouns", { hint: "e.g. she/her, he/him, they/them", attrs: 'maxlength="120"' })}
          ${selectField(f, "gender", "Gender (claims / AHCCCS demographics)", GENDER_OPTIONS)}
          ${field(f, "ahcccs_id", "AHCCCS ID", { hint: "Arizona Medicaid member ID, e.g. A12345678. Turns on AHCCCS documentation and billing rules.", attrs: 'maxlength="12" autocomplete="off"' })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Contact</legend>
        <div class="form-grid">
          ${field(f, "phone", "Phone", { type: "tel", attrs: 'autocomplete="off"' })}
          ${field(f, "email", "Email", { type: "email", attrs: 'autocomplete="off"' })}
          ${selectField(f, "preferred_contact", "Preferred contact method", CONTACT_OPTIONS)}
          <label class="check"><input type="checkbox" name="ok_voicemail" value="1" ${values.ok_voicemail ? raw("checked") : ""}> OK to leave a voicemail</label>
          ${field(f, "address_line1", "Street address", { cls: "span-all", attrs: 'maxlength="120"' })}
          ${field(f, "address_line2", "Apt, suite, unit", { attrs: 'maxlength="120"' })}
          ${field(f, "city", "City", { attrs: 'maxlength="120"' })}
          ${field(f, "state", "State", { hint: "2-letter code", attrs: 'maxlength="2"' })}
          ${field(f, "zip", "ZIP code", { attrs: 'inputmode="numeric" maxlength="10"' })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Emergency contact</legend>
        <div class="form-grid">
          ${field(f, "emergency_name", "Name", { attrs: 'maxlength="120"' })}
          ${field(f, "emergency_relation", "Relationship", { attrs: 'maxlength="120"' })}
          ${field(f, "emergency_phone", "Phone", { type: "tel" })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Care team</legend>
        <div class="form-grid">
          ${selectField(f, "primary_clinician_id", "Primary clinician", clinicians)}
          ${isEdit ? selectField(f, "status", "Chart status", STATUSES.map((s) => ({ value: s, label: humanize(s) })), { required: true }) : ""}
        </div>
      </fieldset>
      <p class="hint">Fields marked * are required.</p>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">${isEdit ? "Save changes" : "Create patient"}</button>
        <a class="btn btn--ghost" href="${isEdit ? `/ehr/patients/${patient.id}` : "/ehr/patients"}">Cancel</a>
      </div>
    </form>`;
}

/* ------------------------------------------------------------------ */
/* Shared loaders                                                     */
/* ------------------------------------------------------------------ */

function loadPatient(req, res) {
  if (!/^\d+$/.test(req.params.id)) { notFound(req, res, "Patient"); return null; }
  const p = getPatient(req, req.params.id);
  if (!p) notFound(req, res, "Patient");
  return p;
}
function anyPerm(...perms) {
  return (req, res, next) => (perms.some((p) => can(req.user, p)) ? next() : forbidden(req, res));
}
const chartUrl = (p, hash = "") => `/ehr/patients/${p.id}${hash}`;

/* ------------------------------------------------------------------ */
/* Patient list                                                       */
/* ------------------------------------------------------------------ */

function escLike(s) { return s.replace(/[\\%_]/g, (c) => "\\" + c); }
const PHONE_DIGITS_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.phone,''),'(',''),')',''),'-',''),' ',''),'.',''),'+','')";

router.get("/patients", requirePerm("patients:read"), (req, res) => {
  const db = req.db;
  const u = req.user;
  const q = str(req.query.q).slice(0, 100);
  const status = ["all", ...STATUSES].includes(str(req.query.status)) ? str(req.query.status) : "active";
  const isClinician = u.role === "clinician";
  const mine = isClinician && str(req.query.mine) === "1";
  const dir = str(req.query.dir) === "desc" ? "DESC" : "ASC";
  const pageNum = Math.max(1, parseInt(str(req.query.page), 10) || 1);

  const where = [];
  const params = [];
  if (status !== "all") { where.push("p.status = ?"); params.push(status); }
  if (mine) {
    where.push("(p.primary_clinician_id = ? OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.clinician_id = ?))");
    params.push(u.id, u.id);
  }
  for (const token of q.split(/[\s,]+/).filter(Boolean)) {
    let m;
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) { where.push("p.dob = ?"); params.push(token); continue; }
    if ((m = token.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
      where.push("p.dob = ?"); params.push(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`); continue;
    }
    const like = `%${escLike(token)}%`;
    const ors = ["p.first_name LIKE ? ESCAPE '\\'", "p.last_name LIKE ? ESCAPE '\\'", "p.preferred_name LIKE ? ESCAPE '\\'", "p.mrn LIKE ? ESCAPE '\\'"];
    const orParams = [like, like, like, like];
    const digits = token.replace(/\D/g, "");
    if (digits.length >= 3 && /^[0-9()+\-.]+$/.test(token)) { ors.push(`${PHONE_DIGITS_SQL} LIKE ?`); orParams.push(`%${digits}%`); }
    where.push(`(${ors.join(" OR ")})`);
    params.push(...orParams);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM patients p ${whereSql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(pageNum, pages);
  const now = nowLocal();
  const rows = db.prepare(
    `SELECT p.id, p.mrn, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.status,
       u.name AS clinician_name, u.credentials AS clinician_credentials,
       (SELECT MIN(a.start_at) FROM appointments a WHERE a.patient_id = p.id AND a.start_at >= ?
          AND a.status IN ('scheduled','checked_in')) AS next_appt
     FROM patients p LEFT JOIN users u ON u.id = p.primary_clinician_id
     ${whereSql}
     ORDER BY p.last_name COLLATE NOCASE ${dir}, p.first_name COLLATE NOCASE ${dir}, p.id
     LIMIT ? OFFSET ?`).all(now, ...params, PAGE_SIZE, (cur - 1) * PAGE_SIZE);

  // Record that a patient list was viewed; the search text itself may be PHI, so it is not logged.
  audit(req, "list", "patient", null, null, `results=${total}${q ? " search=1" : ""}`);

  const qs = (over) => {
    const sp = new URLSearchParams();
    const vals = { q, status: status === "active" ? "" : status, mine: mine ? "1" : "", dir: dir === "DESC" ? "desc" : "", page: "", ...over };
    for (const [k, v] of Object.entries(vals)) if (v) sp.set(k, v);
    const s = sp.toString();
    return `/ehr/patients${s ? `?${s}` : ""}`;
  };
  const statusLabel = status === "all" ? "" : `${humanize(status).toLowerCase()} `;

  res.send(page(req, {
    title: "Patients",
    active: "patients",
    body: html`
      <div class="page-head">
        <h1>Patients</h1>
        ${can(u, "patients:write") ? html`<a class="btn btn--primary" href="/ehr/patients/new">New patient</a>` : ""}
      </div>
      <section class="card" aria-labelledby="filter-h">
        <h2 id="filter-h" class="visually-hidden">Search and filter</h2>
        <form method="get" action="/ehr/patients" class="form-grid" role="search">
          <label>Search
            <input type="search" name="q" value="${q}" aria-describedby="q-hint" autocomplete="off">
            <span class="hint" id="q-hint">Name, preferred name, MRN, phone, or DOB (YYYY-MM-DD)</span>
          </label>
          <label>Status
            <select name="status">
              ${["active", "inactive", "discharged", "all"].map((s) => html`<option value="${s}" ${s === status ? raw("selected") : ""}>${s === "all" ? "All statuses" : humanize(s)}</option>`)}
            </select>
          </label>
          ${isClinician ? html`<label class="check"><input type="checkbox" name="mine" value="1" ${mine ? raw("checked") : ""}> My patients only</label>` : ""}
          ${dir === "DESC" ? html`<input type="hidden" name="dir" value="desc">` : ""}
          <div class="row"><button class="btn" type="submit">Search</button>${q || status !== "active" || mine ? html`<a class="btn btn--ghost" href="/ehr/patients">Clear</a>` : ""}</div>
        </form>
      </section>
      <section class="card" aria-labelledby="results-h">
        <div class="card__head">
          <h2 id="results-h">${total} ${statusLabel}patient${total === 1 ? "" : "s"}${mine ? " assigned to me" : ""}</h2>
          ${pages > 1 ? html`<span class="muted small">Page ${cur} of ${pages}</span>` : ""}
        </div>
        ${rows.length ? html`
          <div class="table-wrap">
            <table class="table">
              <thead><tr>
                <th scope="col">MRN</th>
                <th scope="col" aria-sort="${dir === "ASC" ? "ascending" : "descending"}">
                  <a href="${qs({ dir: dir === "ASC" ? "desc" : "" })}">Name <span aria-hidden="true">${dir === "ASC" ? "▲" : "▼"}</span><span class="visually-hidden">, sort ${dir === "ASC" ? "descending" : "ascending"}</span></a>
                </th>
                <th scope="col">DOB (age)</th>
                <th scope="col">Phone</th>
                <th scope="col">Primary clinician</th>
                <th scope="col">Status</th>
                <th scope="col">Next appointment</th>
              </tr></thead>
              <tbody>${rows.map((p) => html`
                <tr>
                  <td>${p.mrn}</td>
                  <td><a href="/ehr/patients/${p.id}">${patientName(p)}</a></td>
                  <td>${fmtDate(p.dob)} (${age(p.dob)})</td>
                  <td>${p.phone || html`<span class="muted">None</span>`}</td>
                  <td>${p.clinician_name ? `${p.clinician_name}${p.clinician_credentials ? `, ${p.clinician_credentials}` : ""}` : html`<span class="muted">Unassigned</span>`}</td>
                  <td>${badge(p.status)}</td>
                  <td>${p.next_appt ? fmtDateTime(p.next_appt) : html`<span class="muted">None scheduled</span>`}</td>
                </tr>`)}</tbody>
            </table>
          </div>
          ${pages > 1 ? html`
            <nav class="row form-actions" aria-label="Pagination">
              ${cur > 1 ? html`<a class="btn btn--sm" href="${qs({ page: String(cur - 1) })}" rel="prev">Previous</a>` : ""}
              <span class="muted small">Page ${cur} of ${pages}</span>
              ${cur < pages ? html`<a class="btn btn--sm" href="${qs({ page: String(cur + 1) })}" rel="next">Next</a>` : ""}
            </nav>` : ""}`
        : html`<p class="muted">No ${statusLabel}patients match.${status !== "all" ? html` <a href="${qs({ status: "all" })}">Search all statuses</a>.` : ""}</p>`}
      </section>`,
  }));
});

/* ------------------------------------------------------------------ */
/* Create                                                             */
/* ------------------------------------------------------------------ */

function newPatientPage(req, opts) {
  return page(req, {
    title: "New patient",
    active: "patients",
    body: html`
      <div class="page-head"><h1>New patient</h1></div>
      <section class="card">${patientForm(req, opts)}</section>`,
  });
}

router.get("/patients/new", requirePerm("patients:write"), (req, res) => {
  const values = { status: "active", ok_voicemail: "" };
  res.send(newPatientPage(req, { values, errors: {} }));
});

router.post("/patients", requirePerm("patients:write"), (req, res) => {
  const db = req.db;
  const { values, errors, data } = validatePatient(db, req.body || {});
  if (Object.keys(errors).length) return res.status(400).send(newPatientPage(req, { values, errors }));

  const dupes = db.prepare(
    `SELECT id, mrn, first_name, last_name, preferred_name, status FROM patients
     WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE AND dob = ?`).all(data.first_name, data.last_name, data.dob);
  if (dupes.length && !values.confirm_duplicate) {
    return res.status(400).send(newPatientPage(req, { values, errors: {}, duplicate: dupes }));
  }

  const id = tx(db, () => {
    const mrn = nextMrn(db);
    const cols = Object.keys(data);
    const r = db.prepare(`INSERT INTO patients (mrn, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`)
      .run(mrn, ...cols.map((c) => data[c]));
    return Number(r.lastInsertRowid);
  });
  audit(req, "create", "patient", id, id);
  req.flash("success", "Patient created.");
  res.redirect(`/ehr/patients/${id}`);
});

/* ------------------------------------------------------------------ */
/* Chart overview                                                     */
/* ------------------------------------------------------------------ */

function emptyForm(prefix, values = {}) { return { values, errors: {}, prefix }; }

/**
 * Render the overview. `state` = { form: 'insurance'|'allergy'|'medication'|'diagnosis', values, errors }
 * re-populates one of the add forms after a validation error.
 */
function renderOverview(req, res, patient, state = null, status = 200) {
  const db = req.db;
  const u = req.user;
  const pid = patient.id;
  const clinical = can(u, "clinical:read");
  const canClinWrite = can(u, "clinical:write");
  const canPtWrite = can(u, "patients:write");
  const canAllergy = canClinWrite || canPtWrite;
  const formState = (name, prefix, defaults = {}) =>
    state && state.form === name ? { values: state.values, errors: state.errors, prefix } : emptyForm(prefix, defaults);
  const isOpen = (name) => (state && state.form === name ? raw("open") : "");

  const clinician = patient.primary_clinician_id
    ? db.prepare("SELECT name, credentials FROM users WHERE id = ?").get(patient.primary_clinician_id) : null;
  const policies = db.prepare(
    `SELECT * FROM insurance_policies WHERE patient_id = ? AND active = 1
     ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, id`).all(pid);
  const allergies = db.prepare("SELECT * FROM allergies WHERE patient_id = ? AND active = 1 ORDER BY substance COLLATE NOCASE").all(pid);
  const inactiveAllergies = db.prepare("SELECT COUNT(*) AS n FROM allergies WHERE patient_id = ? AND active = 0").get(pid).n;
  const now = nowLocal();
  const upcoming = can(u, "schedule:read") ? db.prepare(
    `SELECT a.*, us.name AS clinician_name FROM appointments a JOIN users us ON us.id = a.clinician_id
     WHERE a.patient_id = ? AND a.start_at >= ? AND a.status IN (${UPCOMING_STATUSES.map(() => "?").join(",")})
     ORDER BY a.start_at LIMIT 5`).all(pid, now, ...UPCOMING_STATUSES) : null;

  let meds = [], pastMeds = [], dx = [], notes = [];
  if (clinical) {
    meds = db.prepare("SELECT * FROM medications WHERE patient_id = ? AND active = 1 ORDER BY name COLLATE NOCASE").all(pid);
    pastMeds = db.prepare("SELECT * FROM medications WHERE patient_id = ? AND active = 0 ORDER BY COALESCE(end_date,'') DESC, id DESC LIMIT 20").all(pid);
    dx = db.prepare(
      `SELECT * FROM diagnoses WHERE patient_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, is_primary DESC, COALESCE(onset_date, created_at), id`).all(pid);
    notes = db.prepare(
      `SELECT n.id, n.type, n.service_date, n.signed_at, us.name AS author_name
       FROM notes n JOIN users us ON us.id = n.author_id
       WHERE n.patient_id = ? AND n.status = 'signed' AND (n.type <> 'psychotherapy' OR n.author_id = ?)
       ORDER BY COALESCE(n.service_date, substr(n.signed_at,1,10)) DESC, n.id DESC LIMIT 5`).all(pid, u.id);
  }

  audit(req, "view", "patient", pid, pid);

  const dash = html`<span class="muted">Not recorded</span>`;
  const ahcccs = isAhcccs(db, pid);
  const addr = [patient.address_line1, patient.address_line2,
    [patient.city, [patient.state, patient.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean);

  /* --- Demographics & contact --- */
  const demographics = html`
    <section class="card" aria-labelledby="demo-h">
      <div class="card__head"><h2 id="demo-h">Demographics${ahcccs ? html` <span class="pill" title="AHCCCS (Arizona Medicaid) documentation and billing rules apply">AHCCCS</span>` : ""}</h2>
        ${canPtWrite ? html`<a class="btn btn--sm" href="/ehr/patients/${pid}/edit">Edit</a>` : ""}</div>
      <dl class="facts">
        <dt>Legal name</dt><dd>${patient.first_name} ${patient.last_name}</dd>
        <dt>Preferred name</dt><dd>${patient.preferred_name || dash}</dd>
        <dt>Date of birth</dt><dd>${fmtDate(patient.dob)} (${age(patient.dob)} years)</dd>
        <dt>Sex at birth</dt><dd>${patient.sex_at_birth ? (SEX_OPTIONS.find((o) => o.value === patient.sex_at_birth) || {}).label || patient.sex_at_birth : dash}</dd>
        <dt>Gender identity</dt><dd>${patient.gender_identity || dash}</dd>
        <dt>Pronouns</dt><dd>${patient.pronouns || dash}</dd>
        <dt>Gender (claims)</dt><dd>${patient.gender ? (GENDER_OPTIONS.find((o) => o.value === patient.gender) || {}).label || patient.gender : dash}</dd>
        ${patient.ahcccs_id ? html`<dt>AHCCCS ID</dt><dd>${patient.ahcccs_id}</dd>` : ""}
        <dt>MRN</dt><dd>${patient.mrn}</dd>
        <dt>Primary clinician</dt><dd>${clinician ? `${clinician.name}${clinician.credentials ? `, ${clinician.credentials}` : ""}` : html`<span class="muted">Unassigned</span>`}</dd>
        <dt>Status</dt><dd>${badge(patient.status)}</dd>
      </dl>
    </section>`;

  const contact = html`
    <section class="card" aria-labelledby="contact-h">
      <div class="card__head"><h2 id="contact-h">Contact</h2></div>
      <dl class="facts">
        <dt>Phone</dt><dd>${patient.phone || dash}</dd>
        <dt>Email</dt><dd>${patient.email || dash}</dd>
        <dt>Address</dt><dd>${addr.length ? addr.map((l, i) => html`${i ? html`<br>` : ""}${l}`) : dash}</dd>
        <dt>Preferred contact</dt><dd>${patient.preferred_contact ? (CONTACT_OPTIONS.find((o) => o.value === patient.preferred_contact) || {}).label : html`<span class="muted">No preference</span>`}</dd>
        <dt>Voicemail</dt><dd>${patient.ok_voicemail ? "OK to leave a voicemail" : html`<strong>Do not leave a voicemail</strong>`}</dd>
      </dl>
      <h3 class="small muted">Emergency contact</h3>
      ${patient.emergency_name || patient.emergency_phone ? html`
        <dl class="facts">
          <dt>Name</dt><dd>${patient.emergency_name || dash}</dd>
          <dt>Relationship</dt><dd>${patient.emergency_relation || dash}</dd>
          <dt>Phone</dt><dd>${patient.emergency_phone || dash}</dd>
        </dl>` : html`<p class="muted">No emergency contact on file.</p>`}
    </section>`;

  /* --- Insurance --- */
  const insF = formState("insurance", "ins-", { priority: policies.some((p) => p.priority === "primary") ? "secondary" : "primary", subscriber_relation: "self" });
  const insurance = html`
    <section class="card" id="insurance" aria-labelledby="ins-h">
      <div class="card__head"><h2 id="ins-h">Insurance</h2></div>
      ${!ahcccs && policies.some((p) => isAhcccsPlan(p.payer_name)) ? html`<div class="alert alert--warn" role="note">This looks like an AHCCCS health plan.
        ${canPtWrite ? html`<a href="/ehr/patients/${pid}/edit">Add the client's AHCCCS ID</a>` : "Add the client's AHCCCS ID"} to turn on the AHCCCS note, plan and billing fields.</div>` : ""}
      ${policies.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">Priority</th><th scope="col">Payer</th><th scope="col">Member ID</th><th scope="col">Group</th><th scope="col">Subscriber</th><th scope="col" class="num">Copay</th>${canPtWrite ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : ""}</tr></thead>
          <tbody>${policies.map((p) => html`
            <tr>
              <td>${humanize(p.priority)}</td>
              <td>${p.payer_name}</td>
              <td>${p.member_id || ""}</td>
              <td>${p.group_number || ""}</td>
              <td>${p.subscriber_name || ""}${p.subscriber_relation ? html` <span class="muted small">(${humanize(p.subscriber_relation)})</span>` : ""}</td>
              <td class="num">${p.copay_cents == null ? "" : money(p.copay_cents)}</td>
              ${canPtWrite ? html`<td>
                <form method="post" action="/ehr/patients/${pid}/insurance/${p.id}/delete" class="inline-form" data-confirm="Remove this insurance policy?">
                  ${csrfField(req)}<button class="btn btn--sm btn--danger" type="submit">Remove<span class="visually-hidden"> ${p.payer_name}</span></button>
                </form></td>` : ""}
            </tr>`)}</tbody>
        </table></div>` : html`<p class="muted">No insurance on file (self-pay).</p>`}
      ${canPtWrite ? html`
        <details ${isOpen("insurance")}>
          <summary class="btn btn--sm">Add insurance policy</summary>
          <form method="post" action="/ehr/patients/${pid}/insurance" class="stack" novalidate>
            ${csrfField(req)}
            ${errorSummary(insF.errors)}
            <div class="form-grid">
              ${selectField(insF, "priority", "Priority", [{ value: "primary", label: "Primary" }, { value: "secondary", label: "Secondary" }], { required: true })}
              ${field(insF, "payer_name", "Payer name", { required: true, hint: "Type or pick; AHCCCS health plans are listed.", attrs: 'maxlength="120" list="payer-suggestions" autocomplete="off"' })}
              <datalist id="payer-suggestions">${PAYER_SUGGESTIONS.map((n) => html`<option value="${n}"></option>`)}</datalist>
              ${field(insF, "member_id", "Member ID", { attrs: 'maxlength="60"' })}
              ${field(insF, "group_number", "Group number", { attrs: 'maxlength="60"' })}
              ${field(insF, "subscriber_name", "Subscriber name", { attrs: 'maxlength="120"' })}
              ${selectField(insF, "subscriber_relation", "Patient's relationship to subscriber", RELATIONS)}
              ${field(insF, "copay", "Copay", { hint: "e.g. 25.00", attrs: 'inputmode="decimal"' })}
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add policy</button></div>
          </form>
        </details>` : ""}
    </section>`;

  /* --- Allergies --- */
  const alF = formState("allergy", "al-");
  const allergyCard = html`
    <section class="card" id="allergies" aria-labelledby="al-h">
      <div class="card__head"><h2 id="al-h">Allergies</h2></div>
      ${allergies.length ? html`
        <ul class="list-plain">${allergies.map((a) => html`
          <li class="row">
            <span><strong>${a.substance}</strong>${a.reaction ? html` <span class="muted">· ${a.reaction}</span>` : ""}</span>
            ${a.severity ? badge(SEVERITY_TONE[a.severity], humanize(a.severity)) : ""}
            <span class="spacer"></span>
            ${canAllergy ? html`
              <form method="post" action="/ehr/patients/${pid}/allergies/${a.id}/deactivate" class="inline-form" data-confirm="Mark this allergy as inactive?">
                ${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit">Mark inactive<span class="visually-hidden">: ${a.substance}</span></button>
              </form>` : ""}
          </li>`)}</ul>` : html`<p class="muted">No known allergies.</p>`}
      ${inactiveAllergies ? html`<p class="muted small">${inactiveAllergies} inactive allerg${inactiveAllergies === 1 ? "y" : "ies"} not shown.</p>` : ""}
      ${canAllergy ? html`
        <details ${isOpen("allergy")}>
          <summary class="btn btn--sm">Add allergy</summary>
          <form method="post" action="/ehr/patients/${pid}/allergies" class="stack" novalidate>
            ${csrfField(req)}
            ${errorSummary(alF.errors)}
            <div class="form-grid">
              ${field(alF, "substance", "Substance", { required: true, hint: "Medication, food or environmental", attrs: 'maxlength="120"' })}
              ${field(alF, "reaction", "Reaction", { attrs: 'maxlength="200"' })}
              ${selectField(alF, "severity", "Severity", [{ value: "", label: "Unknown" }, { value: "mild", label: "Mild" }, { value: "moderate", label: "Moderate" }, { value: "severe", label: "Severe" }])}
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add allergy</button></div>
          </form>
        </details>` : ""}
    </section>`;

  /* --- Diagnoses --- */
  const dxF = formState("diagnosis", "dx-");
  const dxCard = clinical ? html`
    <section class="card" id="diagnoses" aria-labelledby="dx-h">
      <div class="card__head"><h2 id="dx-h">Problem list / diagnoses</h2></div>
      ${dx.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">Code</th><th scope="col">Description</th><th scope="col">Onset</th><th scope="col">Status</th>${canClinWrite ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : ""}</tr></thead>
          <tbody>${dx.map((d) => html`
            <tr>
              <td><strong>${d.icd10_code}</strong></td>
              <td>${d.description}${d.is_primary ? html` <span class="badge badge--info">Primary</span>` : ""}</td>
              <td>${d.onset_date ? fmtDate(d.onset_date) : ""}</td>
              <td>${badge(d.status)}</td>
              ${canClinWrite ? html`<td><div class="row">
                ${d.status === "active" && !d.is_primary ? html`
                  <form method="post" action="/ehr/patients/${pid}/diagnoses/${d.id}/primary" class="inline-form">
                    ${csrfField(req)}<button class="btn btn--sm" type="submit">Make primary<span class="visually-hidden">: ${d.icd10_code}</span></button>
                  </form>` : ""}
                ${d.status === "active" ? html`
                  <form method="post" action="/ehr/patients/${pid}/diagnoses/${d.id}/resolve" class="inline-form" data-confirm="Mark this diagnosis as resolved?">
                    ${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit">Resolve<span class="visually-hidden">: ${d.icd10_code}</span></button>
                  </form>` : html`
                  <form method="post" action="/ehr/patients/${pid}/diagnoses/${d.id}/reactivate" class="inline-form">
                    ${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit">Reactivate<span class="visually-hidden">: ${d.icd10_code}</span></button>
                  </form>`}
              </div></td>` : ""}
            </tr>`)}</tbody>
        </table></div>` : html`<p class="muted">No diagnoses recorded.</p>`}
      ${canClinWrite ? html`
        <details ${isOpen("diagnosis")}>
          <summary class="btn btn--sm">Add diagnosis</summary>
          <form method="post" action="/ehr/patients/${pid}/diagnoses" class="stack" novalidate>
            ${csrfField(req)}
            ${errorSummary(dxF.errors)}
            <div class="form-grid">
              ${field(dxF, "icd10_code", "ICD-10 code", { required: true, hint: "e.g. F41.1. Start typing to see common codes.", attrs: 'list="icd10-common" autocomplete="off" maxlength="8"' })}
              ${field(dxF, "description", "Description", { hint: "Left blank, filled from the common code list when possible.", attrs: 'maxlength="200"' })}
              ${field(dxF, "onset_date", "Onset date", { type: "date", attrs: `max="${today()}"` })}
              <label class="check"><input type="checkbox" name="is_primary" value="1" ${dxF.values.is_primary ? raw("checked") : ""}> Primary diagnosis</label>
            </div>
            <datalist id="icd10-common">${ICD10_COMMON.map(([c, d]) => html`<option value="${c}">${c} ${d}</option>`)}</datalist>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add diagnosis</button></div>
          </form>
        </details>` : ""}
    </section>` : "";

  /* --- Medications --- */
  const medF = formState("medication", "med-", { start_date: today() });
  const medCard = clinical ? html`
    <section class="card" id="medications" aria-labelledby="med-h">
      <div class="card__head"><h2 id="med-h">Active medications</h2></div>
      ${meds.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">Medication</th><th scope="col">Dose</th><th scope="col">Route</th><th scope="col">Frequency</th><th scope="col">Prescriber</th><th scope="col">Started</th>${canClinWrite ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : ""}</tr></thead>
          <tbody>${meds.map((m) => html`
            <tr>
              <td><strong>${m.name}</strong>${m.notes ? html`<br><span class="muted small">${m.notes}</span>` : ""}</td>
              <td>${m.dose || ""}</td><td>${m.route || ""}</td><td>${m.frequency || ""}</td><td>${m.prescriber || ""}</td>
              <td>${m.start_date ? fmtDate(m.start_date) : ""}</td>
              ${canClinWrite ? html`<td><div class="row">
                <a class="btn btn--sm" href="/ehr/patients/${pid}/medications/${m.id}/edit">Edit<span class="visually-hidden"> ${m.name}</span></a>
                <form method="post" action="/ehr/patients/${pid}/medications/${m.id}/discontinue" class="inline-form" data-confirm="Discontinue this medication as of today?">
                  ${csrfField(req)}<button class="btn btn--sm btn--danger" type="submit">Discontinue<span class="visually-hidden"> ${m.name}</span></button>
                </form></div></td>` : ""}
            </tr>`)}</tbody>
        </table></div>` : html`<p class="muted">No active medications.</p>`}
      ${pastMeds.length ? html`
        <details>
          <summary class="small">Discontinued medications (${pastMeds.length})</summary>
          <ul class="list-plain">${pastMeds.map((m) => html`<li>${m.name}${m.dose ? ` ${m.dose}` : ""} <span class="muted small">· ${m.start_date ? fmtDate(m.start_date) : "?"} to ${m.end_date ? fmtDate(m.end_date) : "?"}</span></li>`)}</ul>
        </details>` : ""}
      ${canClinWrite ? html`
        <details ${isOpen("medication")}>
          <summary class="btn btn--sm">Add medication</summary>
          <form method="post" action="/ehr/patients/${pid}/medications" class="stack" novalidate>
            ${csrfField(req)}
            ${errorSummary(medF.errors)}
            ${medFields(medF)}
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add medication</button></div>
          </form>
        </details>` : ""}
    </section>` : "";

  /* --- Appointments & notes --- */
  const apptCard = upcoming ? html`
    <section class="card" aria-labelledby="appt-h">
      <div class="card__head"><h2 id="appt-h">Upcoming appointments</h2><a class="btn btn--sm" href="/ehr/patients/${pid}/appointments">All appointments</a></div>
      ${upcoming.length ? html`
        <ul class="list-plain">${upcoming.map((a) => html`
          <li><strong>${fmtDateTime(a.start_at)}</strong> · ${humanize(a.type)} with ${a.clinician_name}
            ${a.modality === "telehealth" ? html`<span class="pill">Telehealth</span>` : ""} ${badge(a.status)}</li>`)}</ul>`
        : html`<p class="muted">No upcoming appointments.</p>`}
    </section>` : "";

  const notesCard = clinical ? html`
    <section class="card" aria-labelledby="notes-h">
      <div class="card__head"><h2 id="notes-h">Recent signed notes</h2><a class="btn btn--sm" href="/ehr/patients/${pid}/notes">All notes</a></div>
      ${notes.length ? html`
        <ul class="list-plain">${notes.map((n) => html`
          <li><a href="/ehr/notes/${n.id}"><strong>${humanize(n.type)} note</strong></a> · ${fmtDate(n.service_date || n.signed_at)} <span class="muted small">by ${n.author_name}</span></li>`)}</ul>`
        : html`<p class="muted">No signed notes yet.</p>`}
    </section>` : "";

  // Patient rights (records.js): right of access + accounting of disclosures.
  const recordsCard = clinical ? html`
    <section class="card" aria-labelledby="rec-h">
      <div class="card__head"><h2 id="rec-h">Records &amp; disclosures</h2></div>
      <ul class="list-plain">
        <li><a href="/ehr/patients/${pid}/records">Generate record copy</a> <span class="muted small">(right of access)</span></li>
        <li><a href="/ehr/patients/${pid}/disclosures">Disclosure log</a> · ${db.prepare("SELECT COUNT(*) AS n FROM disclosures WHERE patient_id = ?").get(pid).n} recorded</li>
        <li><a href="/ehr/patients/${pid}/disclosures/accounting">Accounting of disclosures</a></li>
      </ul>
    </section>` : "";

  res.status(status).send(chartPage(req, patient, "overview", html`
    ${ahcccs ? html`<p class="row" data-ahcccs><span class="pill">AHCCCS</span> <span class="small muted">Arizona Medicaid member${patient.ahcccs_id ? ` · ID ${patient.ahcccs_id}` : ""}. AHCCCS documentation, service plan and billing rules apply.</span></p>` : ""}
    <div class="grid grid--2">${demographics}${contact}</div>
    ${allergyCard}
    ${dxCard}
    ${medCard}
    ${insurance}
    <div class="grid grid--2">${apptCard}${notesCard}</div>
    ${recordsCard}`));
}

const RELATIONS = [
  { value: "self", label: "Self" }, { value: "spouse", label: "Spouse / partner" }, { value: "child", label: "Child" },
  { value: "other", label: "Other" },
];

function medFields(f, { withEnd = false } = {}) {
  return html`<div class="form-grid">
    ${field(f, "name", "Medication name", { required: true, attrs: 'maxlength="120"' })}
    ${field(f, "dose", "Dose", { hint: "e.g. 50 mg", attrs: 'maxlength="60"' })}
    ${field(f, "route", "Route", { hint: "e.g. by mouth", attrs: 'maxlength="60"' })}
    ${field(f, "frequency", "Frequency", { hint: "e.g. once daily", attrs: 'maxlength="60"' })}
    ${field(f, "prescriber", "Prescriber", { hint: "Name, or 'outside provider'", attrs: 'maxlength="120"' })}
    ${field(f, "start_date", "Start date", { type: "date" })}
    ${withEnd ? field(f, "end_date", "End date", { type: "date", hint: "Leave blank while the medication is ongoing." }) : ""}
    ${textareaField(f, "notes", "Notes", { cls: "span-all" })}
  </div>`;
}

router.get("/patients/:id", requirePerm("patients:read"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  renderOverview(req, res, patient);
});

/* ------------------------------------------------------------------ */
/* Edit demographics                                                  */
/* ------------------------------------------------------------------ */

function editPage(req, patient, opts) {
  return chartPage(req, patient, "overview", html`
    <section class="card">
      <h2>Edit patient details</h2>
      ${patientForm(req, { ...opts, patient })}
    </section>`, { title: `Edit ${patientName(patient)}` });
}

router.get("/patients/:id/edit", requirePerm("patients:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const values = {};
  for (const f of PATIENT_FIELDS) values[f] = patient[f] == null ? "" : String(patient[f]);
  values.ok_voicemail = patient.ok_voicemail ? "1" : "";
  audit(req, "view", "patient", patient.id, patient.id, "edit form");
  res.send(editPage(req, patient, { values, errors: {} }));
});

router.post("/patients/:id/edit", requirePerm("patients:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { values, errors, data } = validatePatient(req.db, req.body || {}, { current: patient });
  if (Object.keys(errors).length) return res.status(400).send(editPage(req, patient, { values, errors }));
  const cols = Object.keys(data);
  const changed = cols.filter((c) => (patient[c] ?? null) !== (data[c] ?? null));
  req.db.prepare(`UPDATE patients SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...cols.map((c) => data[c]), patient.id);
  // Field names only (no values) so the log carries no PHI.
  audit(req, "update", "patient", patient.id, patient.id, changed.length ? `fields: ${changed.join(",")}` : "no changes");
  req.flash("success", "Patient details saved.");
  res.redirect(`/ehr/patients/${patient.id}`);
});

/* ------------------------------------------------------------------ */
/* Insurance                                                          */
/* ------------------------------------------------------------------ */

router.post("/patients/:id/insurance", requirePerm("patients:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body || {};
  const values = {};
  for (const f of ["priority", "payer_name", "member_id", "group_number", "subscriber_name", "subscriber_relation", "copay"]) values[f] = str(b[f]);
  const errors = {};
  if (!["primary", "secondary"].includes(values.priority)) errors.priority = "Choose primary or secondary.";
  if (!values.payer_name) errors.payer_name = "Payer name is required.";
  checkLen(errors, values, "payer_name", "Payer name", 120);
  checkLen(errors, values, "member_id", "Member ID", 60);
  checkLen(errors, values, "group_number", "Group number", 60);
  checkLen(errors, values, "subscriber_name", "Subscriber name", 120);
  if (values.subscriber_relation && !RELATIONS.some((r) => r.value === values.subscriber_relation)) errors.subscriber_relation = "Choose a relationship from the list.";
  let copay = null;
  if (values.copay) {
    copay = parseMoney(values.copay);
    if (copay === null || copay < 0) errors.copay = "Enter the copay as a dollar amount, e.g. 25.00.";
  }
  if (Object.keys(errors).length) return renderOverview(req, res, patient, { form: "insurance", values, errors }, 400);
  const r = req.db.prepare(
    `INSERT INTO insurance_policies (patient_id, priority, payer_name, member_id, group_number, subscriber_name, subscriber_relation, copay_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(patient.id, values.priority, values.payer_name, orNull(values.member_id),
    orNull(values.group_number), orNull(values.subscriber_name), orNull(values.subscriber_relation), copay);
  audit(req, "create", "insurance_policy", Number(r.lastInsertRowid), patient.id);
  req.flash("success", "Insurance policy added.");
  res.redirect(chartUrl(patient, "#insurance"));
});

router.post("/patients/:id/insurance/:pid/delete", requirePerm("patients:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const r = req.db.prepare("DELETE FROM insurance_policies WHERE id = ? AND patient_id = ?").run(Number(req.params.pid), patient.id);
  if (!r.changes) return notFound(req, res, "Insurance policy");
  audit(req, "delete", "insurance_policy", Number(req.params.pid), patient.id);
  req.flash("success", "Insurance policy removed.");
  res.redirect(chartUrl(patient, "#insurance"));
});

/* ------------------------------------------------------------------ */
/* Allergies                                                          */
/* ------------------------------------------------------------------ */

const allergyPerm = anyPerm("clinical:write", "patients:write");

router.post("/patients/:id/allergies", allergyPerm, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body || {};
  const values = { substance: str(b.substance), reaction: str(b.reaction), severity: str(b.severity) };
  const errors = {};
  if (!values.substance) errors.substance = "Substance is required.";
  checkLen(errors, values, "substance", "Substance", 120);
  checkLen(errors, values, "reaction", "Reaction", 200);
  if (values.severity && !SEVERITY_TONE[values.severity]) errors.severity = "Choose a severity from the list.";
  if (Object.keys(errors).length) return renderOverview(req, res, patient, { form: "allergy", values, errors }, 400);
  const r = req.db.prepare("INSERT INTO allergies (patient_id, substance, reaction, severity) VALUES (?, ?, ?, ?)")
    .run(patient.id, values.substance, orNull(values.reaction), orNull(values.severity));
  audit(req, "create", "allergy", Number(r.lastInsertRowid), patient.id);
  req.flash("success", "Allergy added.");
  res.redirect(chartUrl(patient, "#allergies"));
});

router.post("/patients/:id/allergies/:aid/deactivate", allergyPerm, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const r = req.db.prepare("UPDATE allergies SET active = 0 WHERE id = ? AND patient_id = ?").run(Number(req.params.aid), patient.id);
  if (!r.changes) return notFound(req, res, "Allergy");
  audit(req, "update", "allergy", Number(req.params.aid), patient.id, "deactivated");
  req.flash("success", "Allergy marked inactive.");
  res.redirect(chartUrl(patient, "#allergies"));
});

/* ------------------------------------------------------------------ */
/* Medications                                                        */
/* ------------------------------------------------------------------ */

function validateMed(body, { withEnd = false } = {}) {
  const values = {};
  for (const f of ["name", "dose", "route", "frequency", "prescriber", "start_date", "end_date", "notes"]) values[f] = str(body[f]);
  const errors = {};
  if (!values.name) errors.name = "Medication name is required.";
  checkLen(errors, values, "name", "Medication name", 120);
  for (const [f, l] of [["dose", "Dose"], ["route", "Route"], ["frequency", "Frequency"]]) checkLen(errors, values, f, l, 60);
  checkLen(errors, values, "prescriber", "Prescriber", 120);
  checkLen(errors, values, "notes", "Notes", 1000);
  if (values.start_date && !isValidDate(values.start_date)) errors.start_date = "Enter a valid start date (YYYY-MM-DD).";
  if (withEnd && values.end_date) {
    if (!isValidDate(values.end_date)) errors.end_date = "Enter a valid end date (YYYY-MM-DD).";
    else if (values.start_date && isValidDate(values.start_date) && values.end_date < values.start_date) errors.end_date = "End date can't be before the start date.";
  }
  if (!withEnd) values.end_date = "";
  return { values, errors };
}

router.post("/patients/:id/medications", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { values, errors } = validateMed(req.body || {});
  if (Object.keys(errors).length) return renderOverview(req, res, patient, { form: "medication", values, errors }, 400);
  const r = req.db.prepare(
    `INSERT INTO medications (patient_id, name, dose, route, frequency, prescriber, start_date, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(patient.id, values.name, orNull(values.dose), orNull(values.route),
    orNull(values.frequency), orNull(values.prescriber), orNull(values.start_date), orNull(values.notes), req.user.id);
  audit(req, "create", "medication", Number(r.lastInsertRowid), patient.id);
  req.flash("success", "Medication added.");
  res.redirect(chartUrl(patient, "#medications"));
});

function loadMed(req, res, patient) {
  const m = req.db.prepare("SELECT * FROM medications WHERE id = ? AND patient_id = ?").get(Number(req.params.mid), patient.id);
  if (!m) notFound(req, res, "Medication");
  return m;
}

function medEditPage(req, patient, med, f) {
  return chartPage(req, patient, "overview", html`
    <section class="card">
      <div class="card__head"><h2>Edit medication</h2>${med.active ? badge("active") : badge("inactive", "Discontinued")}</div>
      <form method="post" action="/ehr/patients/${patient.id}/medications/${med.id}/edit" class="stack" novalidate data-dirty-check>
        ${csrfField(req)}
        ${errorSummary(f.errors)}
        ${medFields(f, { withEnd: true })}
        <div class="form-actions">
          <button class="btn btn--primary" type="submit">Save medication</button>
          <a class="btn btn--ghost" href="${chartUrl(patient, "#medications")}">Cancel</a>
        </div>
      </form>
    </section>
    ${med.active ? html`
      <section class="card card--muted">
        <h2>Discontinue</h2>
        <form method="post" action="/ehr/patients/${patient.id}/medications/${med.id}/discontinue" class="row" data-confirm="Discontinue this medication?">
          ${csrfField(req)}
          <label>Discontinue date <input type="date" name="end_date" value="${today()}" max="${today()}"></label>
          <button class="btn btn--danger" type="submit">Discontinue medication</button>
        </form>
      </section>` : ""}`, { title: `Edit medication · ${patientName(patient)}` });
}

router.get("/patients/:id/medications/:mid/edit", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const med = loadMed(req, res, patient);
  if (!med) return;
  const values = {};
  for (const f of ["name", "dose", "route", "frequency", "prescriber", "start_date", "end_date", "notes"]) values[f] = med[f] || "";
  audit(req, "view", "medication", med.id, patient.id);
  res.send(medEditPage(req, patient, med, { values, errors: {}, prefix: "med-" }));
});

router.post("/patients/:id/medications/:mid/edit", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const med = loadMed(req, res, patient);
  if (!med) return;
  const { values, errors } = validateMed(req.body || {}, { withEnd: true });
  if (Object.keys(errors).length) return res.status(400).send(medEditPage(req, patient, med, { values, errors, prefix: "med-" }));
  req.db.prepare(
    `UPDATE medications SET name = ?, dose = ?, route = ?, frequency = ?, prescriber = ?, start_date = ?, end_date = ?, notes = ?
     WHERE id = ? AND patient_id = ?`).run(values.name, orNull(values.dose), orNull(values.route), orNull(values.frequency),
    orNull(values.prescriber), orNull(values.start_date), orNull(values.end_date), orNull(values.notes), med.id, patient.id);
  audit(req, "update", "medication", med.id, patient.id);
  req.flash("success", "Medication updated.");
  res.redirect(chartUrl(patient, "#medications"));
});

router.post("/patients/:id/medications/:mid/discontinue", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const med = loadMed(req, res, patient);
  if (!med) return;
  const end = str((req.body || {}).end_date) || today();
  if (!isValidDate(end) || end > today() || (med.start_date && end < med.start_date)) {
    req.flash("error", "Discontinue date must be a valid date between the start date and today.");
    return res.redirect(`/ehr/patients/${patient.id}/medications/${med.id}/edit`);
  }
  req.db.prepare("UPDATE medications SET active = 0, end_date = ? WHERE id = ? AND patient_id = ?").run(end, med.id, patient.id);
  audit(req, "update", "medication", med.id, patient.id, "discontinued");
  req.flash("success", "Medication discontinued.");
  res.redirect(chartUrl(patient, "#medications"));
});

/* ------------------------------------------------------------------ */
/* Diagnoses                                                          */
/* ------------------------------------------------------------------ */

router.post("/patients/:id/diagnoses", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body || {};
  const values = { icd10_code: str(b.icd10_code).toUpperCase(), description: str(b.description), onset_date: str(b.onset_date), is_primary: b.is_primary ? "1" : "" };
  const errors = {};
  if (!values.icd10_code) errors.icd10_code = "ICD-10 code is required.";
  else if (!ICD10_RE.test(values.icd10_code)) errors.icd10_code = "Enter a valid ICD-10 code, e.g. F41.1.";
  if (!values.description && ICD10_MAP.has(values.icd10_code)) values.description = ICD10_MAP.get(values.icd10_code);
  if (!values.description && !errors.icd10_code) errors.description = "Description is required for codes not in the common list.";
  checkLen(errors, values, "description", "Description", 200);
  if (values.onset_date && !isValidDate(values.onset_date)) errors.onset_date = "Enter a valid onset date (YYYY-MM-DD).";
  else if (values.onset_date && values.onset_date > today()) errors.onset_date = "Onset date can't be in the future.";
  if (!errors.icd10_code && req.db.prepare("SELECT 1 FROM diagnoses WHERE patient_id = ? AND icd10_code = ? AND status = 'active'").get(patient.id, values.icd10_code)) {
    errors.icd10_code = "This diagnosis is already on the active problem list.";
  }
  if (Object.keys(errors).length) return renderOverview(req, res, patient, { form: "diagnosis", values, errors }, 400);
  const id = tx(req.db, () => {
    const hasPrimary = req.db.prepare("SELECT 1 FROM diagnoses WHERE patient_id = ? AND is_primary = 1 AND status = 'active'").get(patient.id);
    const primary = values.is_primary || !hasPrimary ? 1 : 0;
    if (primary) req.db.prepare("UPDATE diagnoses SET is_primary = 0 WHERE patient_id = ?").run(patient.id);
    return Number(req.db.prepare(
      `INSERT INTO diagnoses (patient_id, icd10_code, description, is_primary, onset_date, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(patient.id, values.icd10_code, values.description, primary, orNull(values.onset_date), req.user.id).lastInsertRowid);
  });
  audit(req, "create", "diagnosis", id, patient.id);
  req.flash("success", "Diagnosis added.");
  res.redirect(chartUrl(patient, "#diagnoses"));
});

function loadDx(req, res, patient) {
  const d = req.db.prepare("SELECT * FROM diagnoses WHERE id = ? AND patient_id = ?").get(Number(req.params.did), patient.id);
  if (!d) notFound(req, res, "Diagnosis");
  return d;
}

router.post("/patients/:id/diagnoses/:did/resolve", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const d = loadDx(req, res, patient);
  if (!d) return;
  req.db.prepare("UPDATE diagnoses SET status = 'resolved', is_primary = 0 WHERE id = ?").run(d.id);
  audit(req, "update", "diagnosis", d.id, patient.id, "resolved");
  req.flash("success", d.is_primary ? "Diagnosis resolved. Choose a new primary diagnosis if needed." : "Diagnosis resolved.");
  res.redirect(chartUrl(patient, "#diagnoses"));
});

router.post("/patients/:id/diagnoses/:did/reactivate", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const d = loadDx(req, res, patient);
  if (!d) return;
  req.db.prepare("UPDATE diagnoses SET status = 'active' WHERE id = ?").run(d.id);
  audit(req, "update", "diagnosis", d.id, patient.id, "reactivated");
  req.flash("success", "Diagnosis reactivated.");
  res.redirect(chartUrl(patient, "#diagnoses"));
});

router.post("/patients/:id/diagnoses/:did/primary", requirePerm("clinical:write"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const d = loadDx(req, res, patient);
  if (!d) return;
  if (d.status !== "active") {
    req.flash("error", "Reactivate the diagnosis before making it primary.");
    return res.redirect(chartUrl(patient, "#diagnoses"));
  }
  tx(req.db, () => {
    req.db.prepare("UPDATE diagnoses SET is_primary = 0 WHERE patient_id = ?").run(patient.id);
    req.db.prepare("UPDATE diagnoses SET is_primary = 1 WHERE id = ?").run(d.id);
  });
  audit(req, "update", "diagnosis", d.id, patient.id, "set_primary");
  req.flash("success", "Primary diagnosis updated.");
  res.redirect(chartUrl(patient, "#diagnoses"));
});

module.exports = { router, ICD10_COMMON };
