"use strict";
/*
 * FHIR R4 resources built from ChartReady's tables, shaped to US Core 6.1 profiles where the data supports it.
 * Pure data access: no HTTP here (see routes/fhir.js, fhir/auth.js, fhir/bulk.js).
 *
 * Privacy rules applied to every read, search and export:
 *  - Psychotherapy notes, drafts and release-of-information forms are never exposed.
 *  - Substance use disorder records (42 CFR Part 2) are withheld unless the client (API app) is allowed them:
 *    F10-F19 diagnoses, AUDIT/DAST-10, opioid/alcohol treatment medications, ASAM notes, SUD treatment plans, and
 *    notes about clients with an active SUD diagnosis.
 */
const { getClinic } = require("../clinic");
const { TZ } = require("../views");

const US_CORE = "http://hl7.org/fhir/us/core/StructureDefinition/";
const SYS = {
  mrn: "urn:chartready:mrn",
  ahcccs: "urn:chartready:ahcccs-id",
  appointment: "urn:chartready:appointment",
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
  allergyVer: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
  actCode: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  nullFlavor: "http://terminology.hl7.org/CodeSystem/v3-NullFlavor",
  raceEth: "urn:oid:2.16.840.1.113883.6.238",
  bcp47: "urn:ietf:bcp:47",
  docCat: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
  carePlanCat: "http://hl7.org/fhir/us/core/CodeSystem/careplan-category",
  subscriberRel: "http://terminology.hl7.org/CodeSystem/subscriber-relationship",
  coverageClass: "http://terminology.hl7.org/CodeSystem/coverage-class",
  medReqCat: "http://terminology.hl7.org/CodeSystem/medicationrequest-category",
};

/* Resource types served, and which ones live in a patient's compartment. */
const TYPES = ["Patient", "Practitioner", "Organization", "Group", "Appointment", "Encounter", "Condition", "AllergyIntolerance", "MedicationRequest",
  "MedicationStatement", "Observation", "Coverage", "DocumentReference", "Goal", "CarePlan", "CareTeam"];
const COMPARTMENT = ["Appointment", "Encounter", "Condition", "AllergyIntolerance", "MedicationRequest", "MedicationStatement", "Observation",
  "Coverage", "DocumentReference", "Goal", "CarePlan", "CareTeam"];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** SQLite datetime('now') (UTC, "YYYY-MM-DD HH:MM:SS") -> FHIR instant. */
const instant = (s) => (s ? `${String(s).replace(" ", "T").slice(0, 19)}Z` : undefined);
function tzOffset(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000);
}
/** Clinic-local "YYYY-MM-DDTHH:MM" -> FHIR dateTime with the clinic's UTC offset. */
function localDateTime(local) {
  if (!local) return undefined;
  const guess = new Date(`${local.slice(0, 16)}:00Z`);
  const off = tzOffset(new Date(guess.getTime() - tzOffset(guess) * 60000));
  const a = Math.abs(off);
  return `${local.slice(0, 16)}:00${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const ref = (type, id, display) => (id ? { reference: `${type}/${id}`, ...(display ? { display } : {}) } : undefined);
const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined
const cc = (system, code, display, text) => ({ coding: system && code ? [{ system, code, ...(display ? { display } : {}) }] : undefined, text: text || display });
const meta = (profile, lastUpdated) => ({ ...(profile ? { profile: [US_CORE + profile] } : {}), ...(lastUpdated ? { lastUpdated: instant(lastUpdated) } : {}) });
const escXml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const narrative = (lines) => ({ status: "additional", div: `<div xmlns="http://www.w3.org/1999/xhtml">${lines.filter(Boolean).map((l) => `<p>${escXml(l)}</p>`).join("")}</div>` });
const all = (db, sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } }; // optional modules' tables may be missing
const one = (db, sql, ...args) => { try { return db.prepare(sql).get(...args) || null; } catch { return null; } };

/* Substance use disorder data (42 CFR Part 2) */
const isSudCode = (icd) => /^F1[0-9]/i.test(String(icd || ""));
const SUD_MED = /bupren|suboxone|subutex|zubsolv|sublocade|brixadi|methadone|naltrexone|vivitrol|lofexidine|lucemyra|disulfiram|acamprosate/i;
const hasSudDx = (db, pid) => !!one(db, "SELECT 1 AS x FROM diagnoses WHERE patient_id = ? AND status = 'active' AND (icd10_code LIKE 'F1%')", pid);

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

const RACE_DISPLAY = { "1002-5": "American Indian or Alaska Native", "2028-9": "Asian", "2054-5": "Black or African American", "2076-8": "Native Hawaiian or Other Pacific Islander", "2106-3": "White" };
const ETH_DISPLAY = { "2135-2": "Hispanic or Latino", "2186-5": "Not Hispanic or Latino" };
const LANG_DISPLAY = { en: "English", es: "Spanish", nv: "Navajo", vi: "Vietnamese", zh: "Chinese", ar: "Arabic", tl: "Tagalog", ase: "American Sign Language" };

function raceExtension(url, code, displays, multipleText) {
  if (!code) return undefined;
  if (code === "ASKU") return { url, extension: [{ url: "ombCategory", valueCoding: { system: SYS.nullFlavor, code: "ASKU", display: "asked but declined" } }, { url: "text", valueString: "Declined to answer" }] };
  if (code === "multiple") return { url, extension: [{ url: "text", valueString: multipleText }] };
  if (!displays[code]) return undefined;
  return { url, extension: [{ url: "ombCategory", valueCoding: { system: SYS.raceEth, code, display: displays[code] } }, { url: "text", valueString: displays[code] }] };
}

function patientResource(p) {
  const gender = { female: "female", male: "male", intersex: "other", unknown: "unknown" }[p.sex_at_birth] || ({ F: "female", M: "male", U: "unknown" }[p.gender]) || "unknown";
  const birthsex = { female: "F", male: "M", unknown: "UNK" }[p.sex_at_birth];
  const ext = [
    raceExtension(US_CORE + "us-core-race", p.race, RACE_DISPLAY, "More than one race"),
    raceExtension(US_CORE + "us-core-ethnicity", p.ethnicity, ETH_DISPLAY, ""),
    birthsex ? { url: US_CORE + "us-core-birthsex", valueCode: birthsex } : undefined,
    p.gender_identity ? { url: US_CORE + "us-core-genderIdentity", valueCodeableConcept: { text: p.gender_identity } } : undefined,
  ].filter(Boolean);
  return clean({
    resourceType: "Patient", id: String(p.id), meta: meta("us-core-patient", p.updated_at),
    extension: ext.length ? ext : undefined,
    identifier: [
      { use: "usual", type: cc(SYS.v2_0203, "MR", "Medical record number"), system: SYS.mrn, value: p.mrn },
      ...(p.ahcccs_id ? [{ use: "secondary", type: cc(SYS.v2_0203, "MA", "Patient Medicaid number"), system: SYS.ahcccs, value: p.ahcccs_id }] : []),
    ],
    active: p.status === "active",
    name: [{ use: "official", family: p.last_name, given: [p.first_name] }, ...(p.preferred_name ? [{ use: "usual", given: [p.preferred_name], family: p.last_name }] : [])],
    telecom: [p.phone && { system: "phone", value: p.phone, use: "mobile" }, p.email && { system: "email", value: p.email }].filter(Boolean),
    gender, birthDate: p.dob,
    address: p.address_line1 || p.city ? [{ use: "home", line: [p.address_line1, p.address_line2].filter(Boolean), city: p.city || undefined, state: p.state || undefined, postalCode: p.zip || undefined, country: "US" }] : undefined,
    communication: p.language && LANG_DISPLAY[p.language] ? [{ language: cc(SYS.bcp47, p.language, LANG_DISPLAY[p.language]), preferred: true }] : undefined,
    contact: p.emergency_name ? [{ relationship: [{ text: p.emergency_relation || "Emergency contact" }], name: { text: p.emergency_name }, telecom: p.emergency_phone ? [{ system: "phone", value: p.emergency_phone }] : undefined }] : undefined,
    generalPractitioner: p.primary_clinician_id ? [ref("Practitioner", p.primary_clinician_id)] : undefined,
    managingOrganization: ref("Organization", "clinic"),
  });
}

function practitionerResource(u) {
  const parts = String(u.name || "").trim().split(/\s+/);
  const family = parts.length > 1 ? parts.pop() : parts[0];
  return clean({
    resourceType: "Practitioner", id: String(u.id), meta: meta("us-core-practitioner"), active: u.active === 1,
    identifier: u.npi ? [{ system: SYS.npi, value: u.npi }] : [{ system: "urn:chartready:user", value: String(u.id) }],
    name: [{ text: u.name, family, given: parts.length ? parts : undefined, suffix: u.credentials ? [u.credentials] : undefined }],
    qualification: u.credentials ? [{ code: { text: u.credentials } }] : undefined,
  });
}

function organizationResource(c) {
  return clean({
    resourceType: "Organization", id: "clinic", meta: meta("us-core-organization", c.updated_at), active: true, name: c.name,
    identifier: c.npi ? [{ system: SYS.npi, value: c.npi }] : [{ system: "urn:chartready:organization", value: "clinic" }],
    telecom: [c.phone && { system: "phone", value: c.phone }, c.fax && { system: "fax", value: c.fax }, c.website && { system: "url", value: c.website }].filter(Boolean),
    address: c.address1 ? [{ line: [c.address1, c.address2].filter(Boolean), city: c.city || undefined, state: c.state || undefined, postalCode: c.zip || undefined, country: "US" }] : undefined,
  });
}

function groupResource(db) {
  const members = all(db, "SELECT id FROM patients ORDER BY id");
  return { resourceType: "Group", id: "all", type: "person", actual: true, name: "All clients", quantity: members.length, member: members.map((m) => ({ entity: ref("Patient", m.id) })) };
}

const APPT_STATUS = { scheduled: "booked", checked_in: "arrived", completed: "fulfilled", no_show: "noshow", cancelled: "cancelled", late_cancel: "cancelled" };
const typeText = (t) => String(t || "").replace(/_/g, " ");
function appointmentResource(a) {
  return clean({
    resourceType: "Appointment", id: String(a.id), meta: meta(null, a.updated_at), status: APPT_STATUS[a.status] || "booked",
    serviceType: [{ text: typeText(a.type) }], appointmentType: { text: a.modality === "telehealth" ? "Telehealth" : "In person" },
    start: localDateTime(a.start_at), end: localDateTime(a.end_at), created: instant(a.created_at),
    participant: [{ actor: ref("Patient", a.patient_id), status: "accepted" }, { actor: ref("Practitioner", a.clinician_id), status: "accepted" }],
  });
}
function encounterResource(a) {
  return clean({
    resourceType: "Encounter", id: String(a.id), meta: meta("us-core-encounter", a.updated_at),
    identifier: [{ system: SYS.appointment, value: String(a.id) }],
    status: a.status === "completed" ? "finished" : "in-progress",
    class: a.modality === "telehealth" ? { system: SYS.actCode, code: "VR", display: "virtual" } : { system: SYS.actCode, code: "AMB", display: "ambulatory" },
    type: [{ text: typeText(a.type) }], subject: ref("Patient", a.patient_id),
    participant: [{ individual: ref("Practitioner", a.clinician_id) }],
    period: { start: localDateTime(a.start_at), end: localDateTime(a.end_at) },
    appointment: [ref("Appointment", a.id)], serviceProvider: ref("Organization", "clinic"),
  });
}

function conditionResource(d) {
  return clean({
    resourceType: "Condition", id: String(d.id), meta: meta("us-core-condition-problems-health-concerns", d.created_at),
    clinicalStatus: cc(SYS.condClinical, d.status === "active" ? "active" : "resolved", d.status === "active" ? "Active" : "Resolved"),
    verificationStatus: cc(SYS.condVer, "confirmed", "Confirmed"),
    category: [cc(SYS.condCat, "problem-list-item", "Problem List Item")],
    code: cc(SYS.icd10, d.icd10_code, d.description, d.description),
    subject: ref("Patient", d.patient_id), onsetDateTime: d.onset_date || undefined, recordedDate: instant(d.created_at),
    recorder: ref("Practitioner", d.created_by),
  });
}

function allergyResource(a) {
  return clean({
    resourceType: "AllergyIntolerance", id: String(a.id), meta: meta("us-core-allergyintolerance", a.created_at),
    clinicalStatus: cc(SYS.allergyClinical, a.active ? "active" : "inactive", a.active ? "Active" : "Inactive"),
    verificationStatus: cc(SYS.allergyVer, "confirmed", "Confirmed"),
    code: { text: a.substance }, patient: ref("Patient", a.patient_id), recordedDate: instant(a.created_at),
    reaction: a.reaction || a.severity ? [{ manifestation: [{ text: a.reaction || "Not recorded" }], severity: a.severity || undefined }] : undefined,
  });
}

const RX_STATUS = { active: "active", discontinued: "stopped", voided: "entered-in-error" };
function medicationRequestResource(r) {
  return clean({
    resourceType: "MedicationRequest", id: String(r.id), meta: meta("us-core-medicationrequest", r.ended_at || r.signed_at),
    status: RX_STATUS[r.status], intent: "order", reportedBoolean: false,
    category: [cc(SYS.medReqCat, "community", "Community")],
    medicationCodeableConcept: { text: [r.drug, r.strength, r.dosage_form].filter(Boolean).join(" ") },
    subject: ref("Patient", r.patient_id), authoredOn: instant(r.signed_at), requester: ref("Practitioner", r.prescriber_id),
    reasonCode: r.diagnosis ? [cc(SYS.icd10, r.diagnosis)] : undefined,
    dosageInstruction: [{ text: r.sig, route: r.route ? { text: r.route } : undefined }],
    dispenseRequest: {
      quantity: { value: r.quantity, unit: r.quantity_unit }, numberOfRepeatsAllowed: r.refills,
      expectedSupplyDuration: r.days_supply ? { value: r.days_supply, unit: "days", system: SYS.ucum, code: "d" } : undefined,
    },
    substitution: { allowedBoolean: !r.daw },
    note: r.schedule ? [{ text: `Controlled substance, Schedule ${r.schedule}` }] : undefined,
    statusReason: r.end_reason ? { text: r.end_reason } : undefined,
  });
}
/** Medication list entries, also offered as MedicationRequest (intent "plan", reported) as US Core expects. */
function medListRequestResource(m) {
  return clean({
    resourceType: "MedicationRequest", id: `med-${m.id}`, meta: meta("us-core-medicationrequest", m.created_at),
    status: m.active ? "active" : "stopped", intent: "plan", reportedBoolean: true,
    medicationCodeableConcept: { text: [m.name, m.dose].filter(Boolean).join(" ") },
    subject: ref("Patient", m.patient_id), authoredOn: m.start_date || instant(m.created_at),
    requester: m.prescriber ? { display: m.prescriber } : ref("Practitioner", m.created_by),
    dosageInstruction: m.frequency || m.route ? [{ text: [m.frequency, m.route].filter(Boolean).join(" · "), route: m.route ? { text: m.route } : undefined }] : undefined,
  });
}
function medicationStatementResource(m) {
  return clean({
    resourceType: "MedicationStatement", id: String(m.id), meta: meta(null, m.created_at), status: m.active ? "active" : "stopped",
    medicationCodeableConcept: { text: [m.name, m.dose].filter(Boolean).join(" ") }, subject: ref("Patient", m.patient_id),
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
    resourceType: "Observation", id: `a-${a.id}`, meta: meta("us-core-observation-screening-assessment", a.created_at), status: "final",
    category: obsCategory("survey", "Survey"),
    code: code ? cc(SYS.loinc, code[0], code[1], SURVEY_NAMES[a.instrument]) : { text: SURVEY_NAMES[a.instrument] || a.instrument },
    subject: ref("Patient", a.patient_id), effectiveDateTime: a.administered_on, issued: instant(a.created_at),
    performer: a.entered_by ? [ref("Practitioner", a.entered_by)] : undefined,
    valueInteger: a.total_score, interpretation: [{ text: a.severity }],
  });
}
function labObservations(l) {
  return Object.entries(LAB_CODES).filter(([k]) => l[k] != null).map(([k, [code, display, unit, ucum]]) => clean({
    resourceType: "Observation", id: `lab-${l.id}-${k.replace("_", "")}`, meta: meta("us-core-observation-lab", l.created_at), status: "final",
    category: obsCategory("laboratory", "Laboratory"), code: cc(SYS.loinc, code, display), subject: ref("Patient", l.patient_id),
    effectiveDateTime: l.drawn_on, issued: instant(l.created_at), valueQuantity: { value: l[k], unit, system: SYS.ucum, code: ucum },
    note: l.timing ? [{ text: `Timing: ${l.timing}` }] : undefined,
  }));
}
function vitalObservations(v) {
  const base = { resourceType: "Observation", status: "final", category: obsCategory("vital-signs", "Vital Signs"), subject: ref("Patient", v.patient_id), effectiveDateTime: v.visit_date, issued: instant(v.created_at) };
  const q = (value, unit, code) => ({ value, unit, system: SYS.ucum, code });
  const out = [];
  if (v.bp_sys != null && v.bp_dia != null) out.push(clean({ ...base, id: `vit-${v.id}-bp`, meta: meta("us-core-blood-pressure", v.created_at), code: cc(SYS.loinc, "85354-9", "Blood pressure panel with all children optional"),
    component: [{ code: cc(SYS.loinc, "8480-6", "Systolic blood pressure"), valueQuantity: q(v.bp_sys, "mmHg", "mm[Hg]") }, { code: cc(SYS.loinc, "8462-4", "Diastolic blood pressure"), valueQuantity: q(v.bp_dia, "mmHg", "mm[Hg]") }] }));
  if (v.heart_rate != null) out.push(clean({ ...base, id: `vit-${v.id}-hr`, meta: meta("us-core-heart-rate", v.created_at), code: cc(SYS.loinc, "8867-4", "Heart rate"), valueQuantity: q(v.heart_rate, "beats/minute", "/min") }));
  if (v.weight_lb != null) out.push(clean({ ...base, id: `vit-${v.id}-wt`, meta: meta("us-core-body-weight", v.created_at), code: cc(SYS.loinc, "29463-7", "Body weight"), valueQuantity: q(v.weight_lb, "lb", "[lb_av]") }));
  return out;
}

const REL = { self: "self", spouse: "spouse", child: "child", parent: "parent", other: "other" };
function coverageResource(c) {
  const rel = REL[String(c.subscriber_relation || "").toLowerCase()];
  return clean({
    resourceType: "Coverage", id: String(c.id), meta: meta("us-core-coverage", c.created_at), status: c.active ? "active" : "cancelled",
    identifier: c.member_id ? [{ type: cc(SYS.v2_0203, "MB", "Member Number"), value: c.member_id }] : undefined,
    subscriberId: c.member_id || undefined, beneficiary: ref("Patient", c.patient_id),
    relationship: rel ? cc(SYS.subscriberRel, rel, rel[0].toUpperCase() + rel.slice(1)) : c.subscriber_relation ? { text: c.subscriber_relation } : undefined,
    payor: [{ display: c.payer_name }], order: c.priority === "primary" ? 1 : 2,
    class: c.group_number ? [{ type: cc(SYS.coverageClass, "group", "Group"), value: c.group_number }] : undefined,
  });
}

/* Clinical notes as DocumentReference (US Core clinical-note category). */
const NOTE_LOINC = {
  progress: ["11506-3", "Progress note"], group: ["11506-3", "Progress note"], contact: ["11506-3", "Progress note"], psychiatry: ["11506-3", "Progress note"],
  safety_plan: ["11506-3", "Progress note"], supportive_housing: ["11506-3", "Progress note"], crisis: ["11506-3", "Progress note"],
  intake: ["34117-2", "History and physical note"], asam: ["34117-2", "History and physical note"], discharge: ["18842-5", "Discharge summary"],
};
const NEVER_SHARED_NOTES = ["psychotherapy", "roi"];
function noteText(db, n) {
  const { noteSections } = require("../routes/records");
  const { TYPES: NOTE_TYPES } = require("../routes/notes");
  const author = one(db, "SELECT name, credentials FROM users WHERE id = ?", n.signed_by || n.author_id);
  const lines = [
    `${NOTE_TYPES[n.type] ? NOTE_TYPES[n.type].label : typeText(n.type)}${n.service_date ? ` · ${n.service_date}` : ""}`,
    ...noteSections(n).map((s) => `${s.label}: ${s.value}`),
    author ? `Signed by ${author.name}${author.credentials ? `, ${author.credentials}` : ""} at ${instant(n.signed_at)}` : "",
    ...all(db, "SELECT content, created_at FROM note_addenda WHERE note_id = ? ORDER BY id", n.id).map((a) => `Addendum (${instant(a.created_at)}): ${a.content}`),
  ].filter(Boolean);
  return lines.join("\n\n");
}
function documentReferenceResource(db, n) {
  const [code, display] = NOTE_LOINC[n.type] || ["11506-3", "Progress note"];
  const text = noteText(db, n);
  return clean({
    resourceType: "DocumentReference", id: String(n.id), meta: meta("us-core-documentreference", n.signed_at),
    identifier: [{ system: "urn:chartready:note", value: String(n.id) }],
    status: "current", docStatus: "final",
    type: cc(SYS.loinc, code, display), category: [cc(SYS.docCat, "clinical-note", "Clinical Note")],
    subject: ref("Patient", n.patient_id), date: instant(n.signed_at),
    author: [ref("Practitioner", n.author_id)], authenticator: ref("Practitioner", n.signed_by),
    content: [{ attachment: { contentType: "text/plain;charset=utf-8", data: Buffer.from(text, "utf8").toString("base64"), title: display, creation: instant(n.signed_at) },
      format: { system: "http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode", code: "urn:ihe:iti:xds:2017:mimeTypeSufficient", display: "mimeType Sufficient" } }],
    context: { encounter: n.appointment_id ? [ref("Encounter", n.appointment_id)] : undefined, period: n.service_date ? { start: n.service_date } : undefined },
  });
}

/* Treatment plans: CarePlan, and each plan goal as a Goal. */
const PLAN_STATUS = { active: "active", completed: "completed", superseded: "revoked" };
function planGoals(db, planId) {
  return all(db, `SELECT g.*, pr.title AS problem_title, pr.icd10_code FROM plan_goals g JOIN plan_problems pr ON pr.id = g.problem_id
    WHERE pr.plan_id = ? ORDER BY pr.sort, pr.id, g.sort, g.id`, planId);
}
function goalResource(g, plan) {
  return clean({
    resourceType: "Goal", id: String(g.id), meta: meta("us-core-goal", plan.updated_at),
    lifecycleStatus: plan.status === "active" ? "active" : plan.status === "completed" ? "completed" : "cancelled",
    description: { text: g.goal_text }, subject: ref("Patient", plan.patient_id),
    startDate: plan.start_date || undefined, target: plan.review_date ? [{ dueDate: plan.review_date }] : undefined,
    expressedBy: ref("Practitioner", plan.author_id),
    note: [g.problem_title && { text: `Problem: ${g.problem_title}${g.icd10_code ? ` (${g.icd10_code})` : ""}` }, g.client_words && { text: `In the client's words: ${g.client_words}` }].filter(Boolean),
  });
}
function carePlanResource(db, plan) {
  const goals = planGoals(db, plan.id);
  return clean({
    resourceType: "CarePlan", id: String(plan.id), meta: meta("us-core-careplan", plan.updated_at),
    text: narrative([`Treatment plan${plan.version ? ` version ${plan.version}` : ""} (${plan.status})`, plan.summary, ...goals.map((g) => `Goal: ${g.goal_text}`)]),
    status: PLAN_STATUS[plan.status] || "unknown", intent: "plan",
    category: [cc(SYS.carePlanCat, "assess-plan", "Assessment and Plan of Treatment")],
    title: "Treatment plan", description: plan.summary || undefined, subject: ref("Patient", plan.patient_id),
    period: { start: plan.start_date || undefined, end: plan.ended_at ? String(plan.ended_at).slice(0, 10) : undefined },
    created: instant(plan.created_at), author: ref("Practitioner", plan.author_id),
    goal: goals.map((g) => ref("Goal", g.id)),
  });
}

function careTeamResource(db, p) {
  const members = new Map();
  if (p.primary_clinician_id) members.set(p.primary_clinician_id, "Primary clinician");
  for (const r of all(db, "SELECT DISTINCT prescriber_id AS id FROM prescriptions WHERE patient_id = ? AND status = 'active'", p.id)) if (!members.has(r.id)) members.set(r.id, "Prescriber");
  if (!members.size) return null;
  return clean({
    resourceType: "CareTeam", id: `ct-${p.id}`, status: "active", name: "Care team", subject: ref("Patient", p.id),
    participant: [...members].map(([id, role]) => ({ role: [{ text: role }], member: ref("Practitioner", id) })),
    managingOrganization: [ref("Organization", "clinic")],
  });
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** All resources of a compartment type for one patient (or everyone when pid is null), with privacy rules applied. */
function loadForPatient(db, type, pid, { part2 = false } = {}) {
  const where = (col = "patient_id") => (pid ? `WHERE ${col} = ?` : "");
  const args = pid ? [pid] : [];
  switch (type) {
    case "Appointment": return all(db, `SELECT * FROM appointments ${where()} ORDER BY start_at DESC, id DESC`, ...args).map(appointmentResource);
    case "Encounter": return all(db, `SELECT * FROM appointments ${pid ? "WHERE patient_id = ? AND" : "WHERE"} status IN ('completed', 'checked_in') ORDER BY start_at DESC, id DESC`, ...args).map(encounterResource);
    case "Condition": return all(db, `SELECT * FROM diagnoses ${where()} ORDER BY created_at DESC, id DESC`, ...args).filter((d) => part2 || !isSudCode(d.icd10_code)).map(conditionResource);
    case "AllergyIntolerance": return all(db, `SELECT * FROM allergies ${where()} ORDER BY id DESC`, ...args).map(allergyResource);
    case "MedicationRequest": return [
      ...all(db, `SELECT * FROM prescriptions ${where()} ORDER BY written_on DESC, id DESC`, ...args).filter((r) => part2 || !SUD_MED.test(r.drug)).map(medicationRequestResource),
      ...all(db, `SELECT * FROM medications ${where()} ORDER BY id DESC`, ...args).filter((m) => part2 || !SUD_MED.test(m.name)).filter((m) => !/^Added from a prescription$/.test(m.notes || "")).map(medListRequestResource),
    ];
    case "MedicationStatement": return all(db, `SELECT * FROM medications ${where()} ORDER BY id DESC`, ...args).filter((m) => part2 || !SUD_MED.test(m.name)).map(medicationStatementResource);
    case "Coverage": return all(db, `SELECT * FROM insurance_policies ${where()} ORDER BY priority, id`, ...args).map(coverageResource);
    case "Observation": return [
      ...all(db, `SELECT * FROM assessments ${where()} ORDER BY administered_on DESC, id DESC`, ...args).filter((a) => part2 || !["AUDIT", "DAST10"].includes(a.instrument)).map(surveyObservation),
      ...all(db, `SELECT * FROM trt_labs ${where()} ORDER BY drawn_on DESC, id DESC`, ...args).flatMap(labObservations),
      ...all(db, `SELECT * FROM trt_visits ${where()} ORDER BY visit_date DESC, id DESC`, ...args).flatMap(vitalObservations),
    ].sort((a, b) => String(b.effectiveDateTime).localeCompare(String(a.effectiveDateTime)));
    case "DocumentReference": {
      const sudCache = new Map();
      const sud = (id) => { if (!sudCache.has(id)) sudCache.set(id, hasSudDx(db, id)); return sudCache.get(id); };
      return all(db, `SELECT * FROM notes ${pid ? "WHERE patient_id = ? AND" : "WHERE"} status = 'signed' ORDER BY COALESCE(service_date, signed_at) DESC, id DESC`, ...args)
        .filter((n) => !NEVER_SHARED_NOTES.includes(n.type))
        .filter((n) => part2 || (n.type !== "asam" && !sud(n.patient_id)))
        .map((n) => documentReferenceResource(db, n));
    }
    case "CarePlan": return plansFor(db, pid, part2).map((pl) => carePlanResource(db, pl));
    case "Goal": return plansFor(db, pid, part2).flatMap((pl) => planGoals(db, pl.id).map((g) => goalResource(g, pl)));
    case "CareTeam": return (pid ? [one(db, "SELECT * FROM patients WHERE id = ?", pid)] : all(db, "SELECT * FROM patients")).filter(Boolean).map((p) => careTeamResource(db, p)).filter(Boolean);
    default: return [];
  }
}
function plansFor(db, pid, part2) {
  return all(db, `SELECT * FROM treatment_plans ${pid ? "WHERE patient_id = ? AND" : "WHERE"} status <> 'draft' ORDER BY id DESC`, ...(pid ? [pid] : []))
    .filter((pl) => part2 || !["sud", "co_occurring"].includes(pl.plan_type));
}

/** Read one resource by id. Returns { resource, patientId } or null. */
function readOne(db, type, id, opts = {}) {
  const num = /^\d+$/.test(id) ? Number(id) : null;
  switch (type) {
    case "Patient": { const p = num && one(db, "SELECT * FROM patients WHERE id = ?", num); return p ? { resource: patientResource(p), patientId: p.id } : null; }
    case "Practitioner": { const u = num && one(db, "SELECT id, name, credentials, npi, active FROM users WHERE id = ? AND role IN ('clinician', 'admin')", num); return u ? { resource: practitionerResource(u) } : null; }
    case "Organization": return id === "clinic" ? { resource: organizationResource(getClinic(db)) } : null;
    case "Group": return id === "all" ? { resource: groupResource(db) } : null;
    case "CareTeam": {
      const m = /^ct-(\d+)$/.exec(id);
      const p = m && one(db, "SELECT * FROM patients WHERE id = ?", Number(m[1]));
      const r = p && careTeamResource(db, p);
      return r ? { resource: r, patientId: p.id } : null;
    }
    default: {
      // Find the owning patient, then reuse the compartment loader so privacy rules apply the same way.
      let pid = null;
      if (type === "Observation") {
        const m = /^(a|lab|vit)-(\d+)/.exec(id);
        const table = m && { a: "assessments", lab: "trt_labs", vit: "trt_visits" }[m[1]];
        pid = table ? (one(db, `SELECT patient_id FROM ${table} WHERE id = ?`, Number(m[2])) || {}).patient_id : null;
      } else if (type === "MedicationRequest" && /^med-\d+$/.test(id)) {
        pid = (one(db, "SELECT patient_id FROM medications WHERE id = ?", Number(id.slice(4))) || {}).patient_id;
      } else if (type === "Goal" && num) {
        pid = (one(db, "SELECT tp.patient_id FROM plan_goals g JOIN plan_problems pr ON pr.id = g.problem_id JOIN treatment_plans tp ON tp.id = pr.plan_id WHERE g.id = ?", num) || {}).patient_id;
      } else if (num) {
        const table = { Appointment: "appointments", Encounter: "appointments", Condition: "diagnoses", AllergyIntolerance: "allergies", MedicationRequest: "prescriptions",
          MedicationStatement: "medications", Coverage: "insurance_policies", DocumentReference: "notes", CarePlan: "treatment_plans" }[type];
        pid = table ? (one(db, `SELECT patient_id FROM ${table} WHERE id = ?`, num) || {}).patient_id : null;
      }
      if (!pid) return null;
      const r = loadForPatient(db, type, pid, opts).find((x) => x.id === id);
      return r ? { resource: r, patientId: pid } : null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Search parameters (applied after loading)                           */
/* ------------------------------------------------------------------ */

const codesOf = (c) => (c ? (Array.isArray(c) ? c : [c]).flatMap((x) => (x.coding || []).map((k) => ({ system: k.system, code: k.code }))) : []);
const DATE_OF = {
  Observation: (r) => r.effectiveDateTime, Encounter: (r) => r.period && r.period.start, Appointment: (r) => r.start, DocumentReference: (r) => r.date,
  Condition: (r) => r.onsetDateTime || r.recordedDate, CarePlan: (r) => r.period && r.period.start, Goal: (r) => r.target && r.target[0] && r.target[0].dueDate,
  MedicationRequest: (r) => r.authoredOn, AllergyIntolerance: (r) => r.recordedDate,
};
const TOKEN_PARAMS = {
  category: (r) => codesOf(r.category), code: (r) => codesOf(r.code), type: (r) => codesOf(r.type),
  "clinical-status": (r) => codesOf(r.clinicalStatus), status: (r) => [{ code: r.status }], intent: (r) => [{ code: r.intent }],
  "lifecycle-status": (r) => [{ code: r.lifecycleStatus }], gender: (r) => [{ code: r.gender }],
};
const SUPPORTED_PARAMS = new Set(["patient", "subject", "_id", "_count", "_offset", "date", "identifier", "family", "given", "name", "birthdate", "_format", ...Object.keys(TOKEN_PARAMS)]);

function tokenMatch(values, param) {
  return String(param).split(",").some((p) => {
    const [sys, code] = p.includes("|") ? p.split("|") : [null, p];
    return values.some((v) => (code === "" || v.code === code) && (sys === null || sys === "" || v.system === sys));
  });
}
function dateMatch(value, param) {
  if (!value) return false;
  const m = /^(eq|ne|gt|lt|ge|le|sa|eb)?(\d{4}(?:-\d{2}(?:-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)?)?)$/.exec(String(param));
  if (!m) return false;
  const op = m[1] || "eq";
  const v = m[2];
  const rv = String(value).slice(0, v.length);
  switch (op) {
    case "eq": return rv === v;
    case "ne": return rv !== v;
    case "gt": case "sa": return rv > v;
    case "lt": case "eb": return rv < v;
    case "ge": return rv >= v;
    case "le": return rv <= v;
    default: return false;
  }
}
/** Apply token and date search parameters. Returns { list } or { error }. */
function applyFilters(type, list, q) {
  for (const [k, v] of Object.entries(q)) {
    const vals = Array.isArray(v) ? v : [v];
    if (TOKEN_PARAMS[k]) list = list.filter((r) => vals.every((x) => tokenMatch(TOKEN_PARAMS[k](r), x)));
    else if (k === "date") {
      const get = DATE_OF[type];
      if (!get) return { error: `date isn't supported for ${type}.` };
      if (vals.some((x) => !/^(eq|ne|gt|lt|ge|le|sa|eb)?\d{4}/.test(String(x)))) return { error: "date must look like ge2026-01-01." };
      list = list.filter((r) => vals.every((x) => dateMatch(get(r), x)));
    }
  }
  return { list };
}

/** The Practitioner and Organization resources referenced by a set of resources. */
function referencedSupport(db, resources) {
  const ids = new Set();
  for (const r of resources) for (const s of JSON.stringify(r).match(/"Practitioner\/(\d+)"/g) || []) ids.add(Number(s.match(/\d+/)[0]));
  const out = [];
  for (const id of ids) { const u = one(db, "SELECT id, name, credentials, npi, active FROM users WHERE id = ?", id); if (u) out.push(practitionerResource(u)); }
  return out;
}

module.exports = {
  TYPES, COMPARTMENT, SYS, US_CORE, SUPPORTED_PARAMS, DATE_OF, TOKEN_PARAMS,
  patientResource, practitionerResource, organizationResource, groupResource, loadForPatient, readOne, applyFilters, referencedSupport,
  localDateTime, instant, isSudCode,
};
