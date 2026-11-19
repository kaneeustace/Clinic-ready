"use strict";
/*
 * FHIR R4 API, read-only, JSON (application/fhir+json). Mounted at /fhir (see app.js).
 *
 *   GET  /fhir/metadata                              CapabilityStatement (public)
 *   GET  /fhir/.well-known/smart-configuration       SMART discovery (public)
 *   POST /fhir/auth/token                            OAuth 2.0 client credentials -> 1-hour bearer token
 *   GET  /fhir/:type/:id                             read
 *   GET  /fhir/:type?patient=...&_count=&_offset=    search (Bundle searchset, paged)
 *   GET  /fhir/Patient/:id/$everything               everything the API exposes for one client
 *
 * Resources: Patient, Practitioner, Organization, Appointment, Encounter, Condition, AllergyIntolerance,
 * MedicationRequest (prescriptions), MedicationStatement (medication list), Observation (PHQ-9/GAD-7 and other
 * screening totals, hormone therapy labs and vitals, LOINC-coded), Coverage.
 *
 * Who can call it: API clients an administrator creates under Administration -> API access (FHIR). Each client gets a
 * client_id and a secret shown once, and scopes like system/*.read or system/Patient.read. This is the SMART Backend
 * Services pattern with a client secret (client_secret_basic or client_secret_post).
 *
 * Privacy: clinical notes (and psychotherapy notes) are never exposed. Substance use disorder data (F10-F19
 * diagnoses, AUDIT/DAST-10, opioid treatment medications) is left out unless the client is marked as allowed to
 * receive 42 CFR Part 2 records. Every request is written to the audit log with the client and patient.
 */
const express = require("express");
const crypto = require("node:crypto");
const { hashPassword, verifyPassword, requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, raw, page, csrfField, fmtTimestamp, TZ } = require("../views");
const { getClinic } = require("../clinic");

const fhirRouter = express.Router();
const router = express.Router(); // admin pages, mounted under /ehr

const FHIR_JSON = "application/fhir+json; charset=utf-8";
const TOKEN_SECONDS = 3600;
const TYPES = ["Patient", "Practitioner", "Organization", "Appointment", "Encounter", "Condition", "AllergyIntolerance", "MedicationRequest", "MedicationStatement", "Observation", "Coverage"];
const PATIENT_COMPARTMENT = ["Appointment", "Encounter", "Condition", "AllergyIntolerance", "MedicationRequest", "MedicationStatement", "Observation", "Coverage"];
const SYS = {
  mrn: "urn:chartready:mrn",
  ahcccs: "urn:chartready:ahcccs-id",
  npi: "http://hl7.org/fhir/sid/us-npi",
  icd10: "http://hl7.org/fhir/sid/icd-10-cm",
  loinc: "http://loinc.org",
  ucum: "http://unitsofmeasure.org",
  v2_0203: "http://terminology.hl7.org/CodeSystem/v2-0203",
  obsCat: "http://terminology.hl7.org/CodeSystem/observation-category",
  condCat: "http://terminology.hl7.org/CodeSystem/condition-category",
  condClinical: "http://terminology.hl7.org/CodeSystem/condition-clinical",
  condVer: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
  allergyClinical: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
  actCode: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  birthsex: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Public base URL. Behind a proxy (Render) the request arrives as http, so use the forwarded protocol. */
function baseUrl(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim() === "https" ? "https" : req.protocol;
  return `${String(process.env.EHR_PUBLIC_URL || `${proto}://${req.get("host")}`).replace(/\/+$/, "")}/fhir`;
}
/** SQLite datetime('now') (UTC, "YYYY-MM-DD HH:MM:SS") -> FHIR instant. */
const instant = (s) => (s ? `${String(s).replace(" ", "T").slice(0, 19)}Z` : undefined);
/** Offset of the clinic time zone at a given moment, in minutes. */
function tzOffset(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000);
}
/** Clinic-local "YYYY-MM-DDTHH:MM" -> FHIR dateTime with offset. */
function localDateTime(local) {
  if (!local) return undefined;
  const guess = new Date(`${local.slice(0, 16)}:00Z`);
  const off = tzOffset(new Date(guess.getTime() - tzOffset(guess) * 60000));
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local.slice(0, 16)}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const ref = (type, id, display) => (id ? { reference: `${type}/${id}`, ...(display ? { display } : {}) } : undefined);
const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined
const cc = (system, code, display, text) => ({ coding: system ? [{ system, code, ...(display ? { display } : {}) }] : undefined, text: text || display });

function outcome(res, status, code, diagnostics) {
  res.status(status).type(FHIR_JSON).send(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] }));
}
const send = (res, body, status = 200) => res.status(status).type(FHIR_JSON).send(JSON.stringify(body));

/* Substance use disorder data (42 CFR Part 2) */
const isSudCode = (icd) => /^F1[0-9]/i.test(String(icd || ""));
const SUD_MED = /bupren|suboxone|subutex|zubsolv|sublocade|brixadi|methadone|naltrexone|vivitrol|lofexidine|lucemyra|disulfiram|acamprosate/i;

/* ------------------------------------------------------------------ */
/* Mappers: database row -> FHIR resource                              */
/* ------------------------------------------------------------------ */

function patientResource(p) {
  const gender = { female: "female", male: "male", intersex: "other", unknown: "unknown" }[p.sex_at_birth];
  const birthsex = { female: "F", male: "M", unknown: "UNK" }[p.sex_at_birth];
  return clean({
    resourceType: "Patient", id: String(p.id), meta: { lastUpdated: instant(p.updated_at) },
    extension: birthsex ? [{ url: SYS.birthsex, valueCode: birthsex }] : undefined,
    identifier: [
      { use: "usual", type: cc(SYS.v2_0203, "MR", "Medical record number"), system: SYS.mrn, value: p.mrn },
      ...(p.ahcccs_id ? [{ use: "secondary", system: SYS.ahcccs, value: p.ahcccs_id }] : []),
    ],
    active: p.status === "active",
    name: [{ use: "official", family: p.last_name, given: [p.first_name] }, ...(p.preferred_name ? [{ use: "usual", given: [p.preferred_name], family: p.last_name }] : [])],
    telecom: [p.phone && { system: "phone", value: p.phone }, p.email && { system: "email", value: p.email }].filter(Boolean),
    gender, birthDate: p.dob,
    address: p.address_line1 || p.city ? [{ line: [p.address_line1, p.address_line2].filter(Boolean), city: p.city || undefined, state: p.state || undefined, postalCode: p.zip || undefined }] : undefined,
    contact: p.emergency_name ? [{ relationship: [{ text: p.emergency_relation || "Emergency contact" }], name: { text: p.emergency_name }, telecom: p.emergency_phone ? [{ system: "phone", value: p.emergency_phone }] : undefined }] : undefined,
    generalPractitioner: p.primary_clinician_id ? [ref("Practitioner", p.primary_clinician_id)] : undefined,
    managingOrganization: ref("Organization", "clinic"),
  });
}

function practitionerResource(u) {
  return clean({
    resourceType: "Practitioner", id: String(u.id), active: u.active === 1,
    identifier: u.npi ? [{ system: SYS.npi, value: u.npi }] : undefined,
    name: [{ text: u.name }],
    qualification: u.credentials ? [{ code: { text: u.credentials } }] : undefined,
  });
}

function organizationResource(c) {
  return clean({
    resourceType: "Organization", id: "clinic", active: true, name: c.name,
    identifier: c.npi ? [{ system: SYS.npi, value: c.npi }] : undefined,
    telecom: [c.phone && { system: "phone", value: c.phone }, c.fax && { system: "fax", value: c.fax }, c.website && { system: "url", value: c.website }].filter(Boolean),
    address: c.address1 ? [{ line: [c.address1, c.address2].filter(Boolean), city: c.city || undefined, state: c.state || undefined, postalCode: c.zip || undefined }] : undefined,
  });
}

const APPT_STATUS = { scheduled: "booked", checked_in: "arrived", completed: "fulfilled", no_show: "noshow", cancelled: "cancelled", late_cancel: "cancelled" };
function appointmentResource(a) {
  return clean({
    resourceType: "Appointment", id: String(a.id), status: APPT_STATUS[a.status] || "booked",
    serviceType: [{ text: a.type.replace(/_/g, " ") }],
    appointmentType: a.modality === "telehealth" ? { text: "Telehealth" } : { text: "In person" },
    start: localDateTime(a.start_at), end: localDateTime(a.end_at), created: instant(a.created_at),
    participant: [
      { actor: ref("Patient", a.patient_id), status: "accepted" },
      { actor: ref("Practitioner", a.clinician_id), status: "accepted" },
    ],
  });
}
function encounterResource(a) {
  return clean({
    resourceType: "Encounter", id: String(a.id), status: a.status === "completed" ? "finished" : "in-progress",
    class: a.modality === "telehealth" ? { system: SYS.actCode, code: "VR", display: "virtual" } : { system: SYS.actCode, code: "AMB", display: "ambulatory" },
    type: [{ text: a.type.replace(/_/g, " ") }],
    subject: ref("Patient", a.patient_id),
    participant: [{ individual: ref("Practitioner", a.clinician_id) }],
    period: { start: localDateTime(a.start_at), end: localDateTime(a.end_at) },
    appointment: [ref("Appointment", a.id)],
    serviceProvider: ref("Organization", "clinic"),
  });
}

function conditionResource(d) {
  return clean({
    resourceType: "Condition", id: String(d.id),
    clinicalStatus: cc(SYS.condClinical, d.status === "active" ? "active" : "resolved"),
    verificationStatus: cc(SYS.condVer, "confirmed"),
    category: [cc(SYS.condCat, "problem-list-item", "Problem List Item")],
    code: cc(SYS.icd10, d.icd10_code, d.description),
    subject: ref("Patient", d.patient_id),
    onsetDateTime: d.onset_date || undefined, recordedDate: instant(d.created_at),
    recorder: ref("Practitioner", d.created_by),
    extension: d.is_primary ? [{ url: "urn:chartready:primary-diagnosis", valueBoolean: true }] : undefined,
  });
}

function allergyResource(a) {
  return clean({
    resourceType: "AllergyIntolerance", id: String(a.id),
    clinicalStatus: cc(SYS.allergyClinical, a.active ? "active" : "inactive"),
    code: { text: a.substance }, patient: ref("Patient", a.patient_id), recordedDate: instant(a.created_at),
    reaction: a.reaction || a.severity ? [{ manifestation: [{ text: a.reaction || "Not recorded" }], severity: a.severity || undefined }] : undefined,
  });
}

const RX_STATUS = { active: "active", discontinued: "stopped", voided: "entered-in-error" };
function medicationRequestResource(r) {
  return clean({
    resourceType: "MedicationRequest", id: String(r.id), status: RX_STATUS[r.status], intent: "order",
    category: [{ text: r.schedule ? `Controlled substance, Schedule ${r.schedule}` : "Outpatient" }],
    medicationCodeableConcept: { text: [r.drug, r.strength, r.dosage_form].filter(Boolean).join(" ") },
    subject: ref("Patient", r.patient_id), authoredOn: instant(r.signed_at), requester: ref("Practitioner", r.prescriber_id),
    reasonCode: r.diagnosis ? [cc(SYS.icd10, r.diagnosis)] : undefined,
    dosageInstruction: [{ text: r.sig, route: r.route ? { text: r.route } : undefined }],
    dispenseRequest: {
      quantity: { value: r.quantity, unit: r.quantity_unit },
      numberOfRepeatsAllowed: r.refills,
      expectedSupplyDuration: r.days_supply ? { value: r.days_supply, unit: "days", system: SYS.ucum, code: "d" } : undefined,
    },
    substitution: { allowedBoolean: !r.daw },
    statusReason: r.end_reason ? { text: r.end_reason } : undefined,
  });
}

function medicationStatementResource(m) {
  return clean({
    resourceType: "MedicationStatement", id: String(m.id), status: m.active ? "active" : "stopped",
    medicationCodeableConcept: { text: [m.name, m.dose].filter(Boolean).join(" ") },
    subject: ref("Patient", m.patient_id),
    effectivePeriod: m.start_date || m.end_date ? { start: m.start_date || undefined, end: m.end_date || undefined } : undefined,
    dateAsserted: instant(m.created_at),
    dosage: m.frequency || m.route ? [{ text: [m.frequency, m.route].filter(Boolean).join(" · "), route: m.route ? { text: m.route } : undefined }] : undefined,
    note: m.prescriber ? [{ text: `Prescriber: ${m.prescriber}` }] : undefined,
  });
}

const SURVEY_CODES = {
  PHQ9: ["44261-6", "Patient Health Questionnaire 9 item (PHQ-9) total score [Reported]"],
  GAD7: ["70274-6", "Generalized anxiety disorder 7 item (GAD-7) total score [Reported.PHQ]"],
  AUDIT: ["75624-7", "Total score [AUDIT]"],
};
const SURVEY_NAMES = { PHQ9: "PHQ-9 total score", GAD7: "GAD-7 total score", CSSRS: "Columbia Suicide Severity Rating Scale screen", AUDIT: "AUDIT total score", DAST10: "DAST-10 total score", PCL5: "PCL-5 total score", MDQ: "Mood Disorder Questionnaire score", ASRS: "Adult ADHD Self-Report Scale score" };
const LAB_CODES = {
  total_t: ["2986-8", "Testosterone [Mass/volume] in Serum or Plasma", "ng/dL", "ng/dL"],
  free_t: ["2991-8", "Testosterone Free [Mass/volume] in Serum or Plasma", "pg/mL", "pg/mL"],
  estradiol: ["2243-4", "Estradiol (E2) [Mass/volume] in Serum or Plasma", "pg/mL", "pg/mL"],
  hematocrit: ["4544-3", "Hematocrit [Volume Fraction] of Blood by Automated count", "%", "%"],
  hemoglobin: ["718-7", "Hemoglobin [Mass/volume] in Blood", "g/dL", "g/dL"],
  psa: ["2857-1", "Prostate specific Ag [Mass/volume] in Serum or Plasma", "ng/mL", "ng/mL"],
  lh: ["10501-5", "Lutropin [Units/volume] in Serum or Plasma", "mIU/mL", "m[IU]/mL"],
  fsh: ["15067-2", "Follitropin [Units/volume] in Serum or Plasma", "mIU/mL", "m[IU]/mL"],
};
const obsCategory = (code, display) => [cc(SYS.obsCat, code, display)];

function surveyObservation(a) {
  const code = SURVEY_CODES[a.instrument];
  return clean({
    resourceType: "Observation", id: `a-${a.id}`, status: "final", category: obsCategory("survey", "Survey"),
    code: code ? cc(SYS.loinc, code[0], code[1], SURVEY_NAMES[a.instrument]) : { text: SURVEY_NAMES[a.instrument] || a.instrument },
    subject: ref("Patient", a.patient_id), effectiveDateTime: a.administered_on, issued: instant(a.created_at),
    performer: a.entered_by ? [ref("Practitioner", a.entered_by)] : undefined,
    valueInteger: a.total_score, interpretation: [{ text: a.severity }],
  });
}
function labObservations(l) {
  return Object.entries(LAB_CODES).filter(([k]) => l[k] != null).map(([k, [code, display, unit, ucum]]) => clean({
    resourceType: "Observation", id: `lab-${l.id}-${k.replace("_", "")}`, status: "final", category: obsCategory("laboratory", "Laboratory"),
    code: cc(SYS.loinc, code, display), subject: ref("Patient", l.patient_id), effectiveDateTime: l.drawn_on, issued: instant(l.created_at),
    valueQuantity: { value: l[k], unit, system: SYS.ucum, code: ucum },
    note: l.timing ? [{ text: `Timing: ${l.timing}` }] : undefined,
  }));
}
function vitalObservations(v) {
  const base = { resourceType: "Observation", status: "final", category: obsCategory("vital-signs", "Vital Signs"), subject: ref("Patient", v.patient_id), effectiveDateTime: v.visit_date, issued: instant(v.created_at) };
  const q = (value, unit, code) => ({ value, unit, system: SYS.ucum, code });
  const out = [];
  if (v.bp_sys != null && v.bp_dia != null) out.push(clean({ ...base, id: `vit-${v.id}-bp`, code: cc(SYS.loinc, "85354-9", "Blood pressure panel with all children optional"),
    component: [{ code: cc(SYS.loinc, "8480-6", "Systolic blood pressure"), valueQuantity: q(v.bp_sys, "mmHg", "mm[Hg]") }, { code: cc(SYS.loinc, "8462-4", "Diastolic blood pressure"), valueQuantity: q(v.bp_dia, "mmHg", "mm[Hg]") }] }));
  if (v.heart_rate != null) out.push(clean({ ...base, id: `vit-${v.id}-hr`, code: cc(SYS.loinc, "8867-4", "Heart rate"), valueQuantity: q(v.heart_rate, "beats/minute", "/min") }));
  if (v.weight_lb != null) out.push(clean({ ...base, id: `vit-${v.id}-wt`, code: cc(SYS.loinc, "29463-7", "Body weight"), valueQuantity: q(v.weight_lb, "lb", "[lb_av]") }));
  return out;
}

function coverageResource(c) {
  return clean({
    resourceType: "Coverage", id: String(c.id), status: c.active ? "active" : "cancelled",
    subscriberId: c.member_id || undefined, beneficiary: ref("Patient", c.patient_id),
    relationship: c.subscriber_relation ? { text: c.subscriber_relation } : undefined,
    payor: [{ display: c.payer_name }], order: c.priority === "primary" ? 1 : 2,
    class: c.group_number ? [{ type: cc("http://terminology.hl7.org/CodeSystem/coverage-class", "group", "Group"), value: c.group_number }] : undefined,
  });
}

/* ------------------------------------------------------------------ */
/* Data access, per resource type                                      */
/* ------------------------------------------------------------------ */

/** All resources of a type for one patient (or everyone if pid is null), respecting the Part 2 setting. */
function loadForPatient(db, type, pid, client) {
  const where = (col = "patient_id") => (pid ? `WHERE ${col} = ?` : "");
  const args = pid ? [pid] : [];
  const part2 = !!client.include_part2;
  const table = (sql) => { try { return db.prepare(sql).all(...args); } catch { return []; } }; // optional modules may lack tables in old DBs
  switch (type) {
    case "Appointment": return table(`SELECT * FROM appointments ${where()} ORDER BY start_at DESC, id DESC`).map(appointmentResource);
    case "Encounter": return table(`SELECT * FROM appointments ${pid ? "WHERE patient_id = ? AND" : "WHERE"} status IN ('completed', 'checked_in') ORDER BY start_at DESC, id DESC`).map(encounterResource);
    case "Condition": return table(`SELECT * FROM diagnoses ${where()} ORDER BY created_at DESC, id DESC`).filter((d) => part2 || !isSudCode(d.icd10_code)).map(conditionResource);
    case "AllergyIntolerance": return table(`SELECT * FROM allergies ${where()} ORDER BY id DESC`).map(allergyResource);
    case "MedicationRequest": return table(`SELECT * FROM prescriptions ${where()} ORDER BY written_on DESC, id DESC`).filter((r) => part2 || !SUD_MED.test(r.drug)).map(medicationRequestResource);
    case "MedicationStatement": return table(`SELECT * FROM medications ${where()} ORDER BY id DESC`).filter((m) => part2 || !SUD_MED.test(m.name)).map(medicationStatementResource);
    case "Coverage": return table(`SELECT * FROM insurance_policies ${where()} ORDER BY priority, id`).map(coverageResource);
    case "Observation": return [
      ...table(`SELECT * FROM assessments ${where()} ORDER BY administered_on DESC, id DESC`).filter((a) => part2 || !["AUDIT", "DAST10"].includes(a.instrument)).map(surveyObservation),
      ...table(`SELECT * FROM trt_labs ${where()} ORDER BY drawn_on DESC, id DESC`).flatMap(labObservations),
      ...table(`SELECT * FROM trt_visits ${where()} ORDER BY visit_date DESC, id DESC`).flatMap(vitalObservations),
    ].sort((a, b) => String(b.effectiveDateTime).localeCompare(String(a.effectiveDateTime)));
    default: return [];
  }
}

/** Read one resource by id. Returns { resource, patientId } or null. */
function readOne(db, type, id, client) {
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  const num = /^\d+$/.test(id) ? Number(id) : null;
  const part2 = !!client.include_part2;
  switch (type) {
    case "Patient": { const p = num && one("SELECT * FROM patients WHERE id = ?", num); return p ? { resource: patientResource(p), patientId: p.id } : null; }
    case "Practitioner": { const u = num && one("SELECT id, name, credentials, npi, active FROM users WHERE id = ? AND role IN ('clinician', 'admin')", num); return u ? { resource: practitionerResource(u) } : null; }
    case "Organization": return id === "clinic" ? { resource: organizationResource(getClinic(db)) } : null;
    case "Observation": {
      const m = /^(a|lab|vit)-(\d+)(?:-([a-z]+))?$/.exec(id);
      if (!m) return null;
      const table = { a: "assessments", lab: "trt_labs", vit: "trt_visits" }[m[1]];
      const row = one(`SELECT * FROM ${table} WHERE id = ?`, Number(m[2]));
      if (!row) return null;
      const list = m[1] === "a" ? (part2 || !["AUDIT", "DAST10"].includes(row.instrument) ? [surveyObservation(row)] : []) : m[1] === "lab" ? labObservations(row) : vitalObservations(row);
      const r = list.find((x) => x.id === id);
      return r ? { resource: r, patientId: row.patient_id } : null;
    }
    default: {
      if (!num) return null;
      const table = { Appointment: "appointments", Encounter: "appointments", Condition: "diagnoses", AllergyIntolerance: "allergies", MedicationRequest: "prescriptions", MedicationStatement: "medications", Coverage: "insurance_policies" }[type];
      const row = table && one(`SELECT * FROM ${table} WHERE id = ?`, num);
      if (!row) return null;
      const list = loadForPatient(db, type, row.patient_id, client);
      const r = list.find((x) => x.id === String(num));
      return r ? { resource: r, patientId: row.patient_id } : null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Auth: clients, tokens, scopes                                       */
/* ------------------------------------------------------------------ */

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const failures = new Map(); // ip -> { n, until }
function tooMany(ip) { const f = failures.get(ip); return f && f.n >= 10 && f.until > Date.now(); }
function fail(ip) { const f = failures.get(ip) || { n: 0, until: 0 }; if (f.until < Date.now()) f.n = 0; f.n += 1; f.until = Date.now() + 15 * 60000; failures.set(ip, f); }
function resetFhirRateLimit() { failures.clear(); }

const SCOPE_RE = /^system\/(\*|[A-Za-z]+)\.(read|rs|\*)$/;
function scopeAllows(scopes, type) {
  return String(scopes || "").split(/\s+/).some((s) => { const m = SCOPE_RE.exec(s); return m && (m[1] === "*" || m[1] === type); });
}

fhirRouter.post("/auth/token", (req, res) => {
  res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
  const err = (status, error, desc) => res.status(status).json({ error, error_description: desc });
  if (tooMany(req.ip)) return err(429, "slow_down", "Too many failed attempts. Try again in 15 minutes.");
  const b = req.body || {};
  let id = b.client_id, secret = b.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
  if (basic) { const [u, ...p] = Buffer.from(basic[1], "base64").toString("utf8").split(":"); id = decodeURIComponent(u); secret = decodeURIComponent(p.join(":")); }
  if (b.grant_type !== "client_credentials") return err(400, "unsupported_grant_type", "Use grant_type=client_credentials.");
  const client = id ? req.db.prepare("SELECT * FROM fhir_clients WHERE client_id = ? AND revoked_at IS NULL").get(String(id)) : null;
  if (!client || !secret || !verifyPassword(String(secret), client.secret_hash)) {
    fail(req.ip);
    audit(req, "fhir_token_failed", "fhir_client", client ? client.id : null, null, `client ${String(id || "").slice(0, 40)}`);
    return err(401, "invalid_client", "Unknown client or wrong secret.");
  }
  const granted = client.scopes.split(/\s+/);
  const asked = b.scope ? String(b.scope).split(/\s+/).filter(Boolean) : granted;
  const scopes = asked.filter((s) => SCOPE_RE.test(s) && granted.some((g) => g === s || (g.startsWith("system/*.") && SCOPE_RE.test(s))));
  if (!scopes.length) return err(400, "invalid_scope", `This client may request: ${client.scopes}`);
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + TOKEN_SECONDS * 1000).toISOString().replace("T", " ").slice(0, 19);
  req.db.prepare("DELETE FROM fhir_tokens WHERE expires_at < datetime('now')").run();
  req.db.prepare("INSERT INTO fhir_tokens (token_hash, client_ref, scopes, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), client.id, scopes.join(" "), expires);
  req.db.prepare("UPDATE fhir_clients SET last_used_at = datetime('now') WHERE id = ?").run(client.id);
  audit(req, "fhir_token", "fhir_client", client.id, null, `client ${client.client_id}`);
  res.json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_SECONDS, scope: scopes.join(" ") });
});

function bearer(req, res, next) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
  const row = m ? req.db.prepare(`SELECT t.scopes, c.* FROM fhir_tokens t JOIN fhir_clients c ON c.id = t.client_ref
    WHERE t.token_hash = ? AND t.expires_at > datetime('now') AND c.revoked_at IS NULL`).get(sha256(m[1])) : null;
  if (!row) {
    res.set("WWW-Authenticate", 'Bearer realm="fhir", error="invalid_token"');
    return outcome(res, 401, "login", "Missing, expired or revoked access token. Get one from /fhir/auth/token.");
  }
  req.fhirClient = row;
  next();
}

/* ------------------------------------------------------------------ */
/* Public discovery                                                    */
/* ------------------------------------------------------------------ */

fhirRouter.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

fhirRouter.get("/metadata", (req, res) => {
  const c = getClinic(req.db);
  const searchParams = { Patient: ["_id", "identifier", "family", "given", "name", "birthdate"], Practitioner: ["_id", "identifier"], Organization: ["_id"], Observation: ["patient", "category", "code"] };
  send(res, {
    resourceType: "CapabilityStatement", status: "active", date: new Date().toISOString().slice(0, 10), kind: "instance", fhirVersion: "4.0.1", format: ["application/fhir+json", "json"],
    software: { name: require("../product").PRODUCT.name }, implementation: { description: `${c.name} FHIR API (read-only)`, url: baseUrl(req) },
    rest: [{
      mode: "server",
      security: {
        service: [cc("http://terminology.hl7.org/CodeSystem/restful-security-service", "SMART-on-FHIR", "SMART-on-FHIR")],
        description: "OAuth 2.0 client credentials (SMART Backend Services with client secret). POST /fhir/auth/token, then send Authorization: Bearer <token>.",
        extension: [{ url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris", extension: [{ url: "token", valueUri: `${baseUrl(req)}/auth/token` }] }],
      },
      resource: TYPES.map((type) => ({
        type, interaction: [{ code: "read" }, { code: "search-type" }],
        searchParam: (searchParams[type] || (PATIENT_COMPARTMENT.includes(type) ? ["patient", "_id"] : ["_id"])).map((name) => ({ name, type: name === "patient" ? "reference" : name === "birthdate" ? "date" : ["identifier", "category", "code"].includes(name) ? "token" : "string" })),
        ...(type === "Patient" ? { operation: [{ name: "everything", definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything" }] } : {}),
      })),
    }],
  });
});

fhirRouter.get("/.well-known/smart-configuration", (req, res) => {
  res.json({
    token_endpoint: `${baseUrl(req)}/auth/token`, grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["system/*.read", ...TYPES.map((t) => `system/${t}.read`)], capabilities: ["client-confidential-symmetric"],
  });
});

/* ------------------------------------------------------------------ */
/* Read and search                                                     */
/* ------------------------------------------------------------------ */

fhirRouter.use(bearer);

function checkType(req, res, type) {
  if (!TYPES.includes(type)) { outcome(res, 404, "not-supported", `Resource type ${type} is not supported. See /fhir/metadata.`); return false; }
  if (!scopeAllows(req.fhirClient.scopes, type)) { outcome(res, 403, "forbidden", `Token scope doesn't include system/${type}.read.`); return false; }
  return true;
}
const logAccess = (req, action, type, id, patientId, n) =>
  audit(req, action, `fhir_${type}`, /^\d+$/.test(String(id || "")) ? id : null, patientId || null, `client ${req.fhirClient.client_id}${n != null ? ` results=${n}` : ""}`);

function bundle(req, entries, total, offset, count) {
  const self = new URL(baseUrl(req) + req.path.replace(/^\/?/, "/"));
  for (const [k, v] of Object.entries(req.query)) self.searchParams.set(k, String(v));
  const link = [{ relation: "self", url: self.toString() }];
  if (offset + count < total) { const next = new URL(self); next.searchParams.set("_offset", String(offset + count)); next.searchParams.set("_count", String(count)); link.push({ relation: "next", url: next.toString() }); }
  return { resourceType: "Bundle", type: "searchset", total, link, entry: entries.map((r) => ({ fullUrl: `${baseUrl(req)}/${r.resourceType}/${r.id}`, resource: r, search: { mode: "match" } })) };
}

const patientId = (v) => { const m = /^(?:Patient\/)?(\d+)$/.exec(String(v || "")); return m ? Number(m[1]) : null; };

fhirRouter.get("/Patient/:id/:op", (req, res, next) => {
  if (req.params.op !== "$everything") return next();
  if (!checkType(req, res, "Patient")) return;
  const pid = patientId(req.params.id);
  const p = pid && req.db.prepare("SELECT * FROM patients WHERE id = ?").get(pid);
  if (!p) return outcome(res, 404, "not-found", "Patient not found.");
  const resources = [patientResource(p)];
  for (const type of PATIENT_COMPARTMENT) if (scopeAllows(req.fhirClient.scopes, type)) resources.push(...loadForPatient(req.db, type, pid, req.fhirClient));
  const pracIds = new Set();
  for (const r of resources) for (const s of JSON.stringify(r).match(/"Practitioner\/(\d+)"/g) || []) pracIds.add(Number(s.match(/\d+/)[0]));
  if (scopeAllows(req.fhirClient.scopes, "Practitioner")) for (const id of pracIds) { const u = req.db.prepare("SELECT id, name, credentials, npi, active FROM users WHERE id = ?").get(id); if (u) resources.push(practitionerResource(u)); }
  if (scopeAllows(req.fhirClient.scopes, "Organization")) resources.push(organizationResource(getClinic(req.db)));
  logAccess(req, "fhir_everything", "Patient", pid, pid, resources.length);
  send(res, { resourceType: "Bundle", type: "searchset", total: resources.length, entry: resources.map((r) => ({ fullUrl: `${baseUrl(req)}/${r.resourceType}/${r.id}`, resource: r })) });
});

fhirRouter.get("/:type/:id", (req, res) => {
  const { type, id } = req.params;
  if (!checkType(req, res, type)) return;
  const found = readOne(req.db, type, id, req.fhirClient);
  if (!found) return outcome(res, 404, "not-found", `${type}/${id} not found.`);
  logAccess(req, "fhir_read", type, id, found.patientId);
  send(res, found.resource);
});

fhirRouter.get("/:type", (req, res) => {
  const { type } = req.params;
  if (!checkType(req, res, type)) return;
  const db = req.db;
  const q = req.query;
  const count = Math.min(Math.max(parseInt(q._count, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q._offset, 10) || 0, 0);
  let list;
  let pid = null;
  if (type === "Patient") {
    const where = [], args = [];
    if (q._id) { where.push("id = ?"); args.push(Number(q._id) || -1); }
    if (q.identifier) { const [sys, val] = String(q.identifier).includes("|") ? String(q.identifier).split("|") : [null, String(q.identifier)];
      if (sys === SYS.ahcccs) { where.push("ahcccs_id = ?"); args.push(val); } else if (!sys || sys === SYS.mrn) { where.push("mrn = ?"); args.push(val); } else { where.push("0"); } }
    if (q.family) { where.push("last_name LIKE ? ESCAPE '\\'"); args.push(`${String(q.family).replace(/[%_\\]/g, "\\$&")}%`); }
    if (q.given) { where.push("(first_name LIKE ? ESCAPE '\\' OR preferred_name LIKE ? ESCAPE '\\')"); const g = `${String(q.given).replace(/[%_\\]/g, "\\$&")}%`; args.push(g, g); }
    if (q.name) { const n = `%${String(q.name).replace(/[%_\\]/g, "\\$&")}%`; where.push("(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR preferred_name LIKE ? ESCAPE '\\')"); args.push(n, n, n); }
    if (q.birthdate) { const d = /^(eq)?(\d{4}-\d{2}-\d{2})$/.exec(String(q.birthdate)); if (!d) return outcome(res, 400, "invalid", "birthdate must be YYYY-MM-DD."); where.push("dob = ?"); args.push(d[2]); }
    list = db.prepare(`SELECT * FROM patients ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_name, first_name, id`).all(...args).map(patientResource);
  } else if (type === "Practitioner") {
    const args = [];
    let sql = "SELECT id, name, credentials, npi, active FROM users WHERE role IN ('clinician', 'admin')";
    if (q._id) { sql += " AND id = ?"; args.push(Number(q._id) || -1); }
    if (q.identifier) { sql += " AND npi = ?"; args.push(String(q.identifier).split("|").pop()); }
    list = db.prepare(`${sql} ORDER BY name`).all(...args).map(practitionerResource);
  } else if (type === "Organization") {
    list = !q._id || q._id === "clinic" ? [organizationResource(getClinic(db))] : [];
  } else {
    if (q.patient || q.subject) {
      pid = patientId(q.patient || q.subject);
      if (!pid || !db.prepare("SELECT 1 FROM patients WHERE id = ?").get(pid)) return outcome(res, 404, "not-found", "Patient not found.");
    } else if (!q._id) return outcome(res, 400, "required", `Search ${type} by patient (e.g. ${type}?patient=123).`);
    list = q._id ? [readOne(db, type, String(q._id), req.fhirClient)].filter(Boolean).map((x) => x.resource).filter((r) => !pid || JSON.stringify(r).includes(`"Patient/${pid}"`))
      : loadForPatient(db, type, pid, req.fhirClient);
    if (type === "Observation") {
      if (q.category) list = list.filter((o) => o.category.some((c) => c.coding.some((x) => x.code === String(q.category).split("|").pop())));
      if (q.code) { const codes = String(q.code).split(",").map((s) => s.split("|").pop()); list = list.filter((o) => (o.code.coding || []).some((x) => codes.includes(x.code))); }
    }
  }
  logAccess(req, "fhir_search", type, null, pid, list.length);
  send(res, bundle(req, list.slice(offset, offset + count), list.length, offset, count));
});

fhirRouter.use((req, res) => outcome(res, 405, "not-supported", "This FHIR API is read-only. See /fhir/metadata."));

/* ------------------------------------------------------------------ */
/* Administration -> API access (FHIR)                                 */
/* ------------------------------------------------------------------ */

const adminOnly = requirePerm("admin");

function apiPage(req, res, { created = null, error = null } = {}, status = 200) {
  const clients = req.db.prepare("SELECT c.*, u.name AS creator FROM fhir_clients c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.revoked_at IS NOT NULL, c.id DESC").all();
  const base = baseUrl(req);
  res.status(status).send(page(req, { title: "API access (FHIR)", active: "admin", body: html`
    <div class="page-head"><div><h1>API access (FHIR)</h1><p>Let another system (a lab, a partner app, a data warehouse, an HIE) read records in the standard FHIR R4 format. Read-only.</p></div>
      <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
    ${created ? html`<div class="alert alert--success" role="status"><strong>API client created. Copy the secret now: it won't be shown again.</strong>
      <dl class="kv"><dt>Client ID</dt><dd><code>${created.client_id}</code></dd><dt>Client secret</dt><dd><code>${created.secret}</code></dd></dl></div>` : ""}
    ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
    <section class="card stack">
      <h2>How to connect</h2>
      <ol class="list">
        <li>Create a client below and give the Client ID and secret to the other system, securely. Only share data under a business associate agreement (BAA) or other HIPAA-permitted purpose.</li>
        <li>They get a token: <code>POST ${base}/auth/token</code> with <code>grant_type=client_credentials</code> and the ID and secret (HTTP Basic or form fields). Tokens last one hour.</li>
        <li>They call the API with <code>Authorization: Bearer &lt;token&gt;</code>, e.g. <code>GET ${base}/Patient?family=Rivera</code> or <code>GET ${base}/Patient/123/$everything</code>.</li>
      </ol>
      <p class="small muted">Capability statement: <a href="${base}/metadata">${base}/metadata</a>. Notes and psychotherapy notes are never shared. Every request is in the audit log.</p>
    </section>
    <form class="card stack" method="post" action="/ehr/admin/api/clients">
      ${csrfField(req)}<h2>New API client</h2>
      <div class="form-grid">
        <label>Name<input type="text" name="name" maxlength="80" required placeholder="e.g. Example Lab, data warehouse"></label>
        <label>Access ${raw(`<select name="scopes" id="scopes">${[["system/*.read", "Everything the API offers (read)"], ["system/Patient.read system/Appointment.read system/Coverage.read system/Practitioner.read system/Organization.read", "Demographics, appointments and insurance only"], ["system/Patient.read system/Observation.read", "Patients and results (labs, vitals, screening scores)"], ["system/Patient.read system/MedicationRequest.read system/MedicationStatement.read system/AllergyIntolerance.read", "Patients, medications and allergies"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>`)}</label>
        <label class="check span-all"><input type="checkbox" name="include_part2" value="1"> Include substance use disorder records (42 CFR Part 2). Only with the client's written consent or another Part 2 exception.</label>
      </div>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Create client</button></div>
    </form>
    <section class="card">
      <h2>Clients</h2>
      ${clients.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Client ID</th><th>Access</th><th>Last used</th><th>Status</th></tr></thead>
        <tbody>${clients.map((c) => html`<tr class="${c.revoked_at ? "is-voided" : ""}">
          <td>${c.name}<br><span class="small muted">by ${c.creator || "—"} · ${fmtTimestamp(c.created_at)}</span></td>
          <td><code>${c.client_id}</code></td>
          <td class="small">${c.scopes.split(" ").join(", ")}${c.include_part2 ? html`<br><span class="badge badge--warn">Includes Part 2</span>` : ""}</td>
          <td class="small">${c.last_used_at ? fmtTimestamp(c.last_used_at) : "Never"}</td>
          <td>${c.revoked_at ? html`<span class="badge badge--neutral">Revoked</span>` : html`
            <form method="post" action="/ehr/admin/api/clients/${c.id}/revoke" data-confirm="Revoke this client? It stops working immediately.">${csrfField(req)}<button class="btn btn--sm btn--danger" type="submit">Revoke</button></form>`}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">No API clients yet.</p>`}
    </section>` }));
}

router.get("/admin/api", adminOnly, (req, res) => apiPage(req, res));

router.post("/admin/api/clients", adminOnly, (req, res) => {
  const name = String((req.body || {}).name || "").trim().slice(0, 80);
  const scopes = String((req.body || {}).scopes || "").trim().split(/\s+/).filter((s) => SCOPE_RE.test(s));
  if (!name) return apiPage(req, res, { error: "Give the client a name." }, 400);
  if (!scopes.length) return apiPage(req, res, { error: "Choose what the client can access." }, 400);
  const clientId = `cr_${crypto.randomBytes(9).toString("base64url")}`;
  const secret = crypto.randomBytes(30).toString("base64url");
  const part2 = (req.body || {}).include_part2 === "1" ? 1 : 0;
  const id = Number(req.db.prepare("INSERT INTO fhir_clients (name, client_id, secret_hash, scopes, include_part2, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, clientId, hashPassword(secret), scopes.join(" "), part2, req.user.id).lastInsertRowid);
  audit(req, "create", "fhir_client", id, null, `${clientId}${part2 ? " part2" : ""}`);
  apiPage(req, res, { created: { client_id: clientId, secret } });
});

router.post("/admin/api/clients/:id/revoke", adminOnly, (req, res) => {
  const c = req.db.prepare("SELECT * FROM fhir_clients WHERE id = ? AND revoked_at IS NULL").get(Number(req.params.id) || -1);
  if (c) {
    req.db.prepare("UPDATE fhir_clients SET revoked_at = datetime('now') WHERE id = ?").run(c.id);
    req.db.prepare("DELETE FROM fhir_tokens WHERE client_ref = ?").run(c.id);
    audit(req, "revoke", "fhir_client", c.id, null, c.client_id);
    req.flash("success", `${c.name} revoked.`);
  }
  res.redirect("/ehr/admin/api");
});

module.exports = { router, fhirRouter, resetFhirRateLimit, scopeAllows, localDateTime, patientResource };
