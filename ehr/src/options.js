"use strict";
/*
 * Shared dropdown lists and one dropdown helper, so the same list (states, payers, routes...) looks and validates the
 * same everywhere.
 *
 *   choice({ name, list, value, other, placeholder, id, required, attrs })   -> <select> (+ "Other" text box)
 *   readChoice(body, name, { list, other, max })                            -> the saved string, or null
 *   inList(list, value)                                                      -> is value one of the list's values?
 *
 * A list is an array of strings, or of { value, label }, or of [groupLabel, items] pairs (rendered as <optgroup>s).
 * With other: true the menu ends with "Other (type it)", and a text box named `${name}_other` sits beside it.
 * Values saved before a field became a dropdown still display: an unknown saved value selects "Other" with the
 * text filled in (or, without other, shows as an extra option so nothing is lost).
 */
const { raw, esc } = require("./views");

const OTHER = "__other";

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */

const isGrouped = (list) => Array.isArray(list[0]) && typeof list[0][0] === "string" && Array.isArray(list[0][1]);
const norm = (o) => (typeof o === "string" ? { value: o, label: o } : o);
function flat(list) { return (isGrouped(list) ? list.flatMap(([, items]) => items) : list).map(norm); }
function inList(list, value) { return value !== "" && value != null && flat(list).some((o) => String(o.value) === String(value)); }
function labelFor(list, value) { const o = flat(list).find((x) => String(x.value) === String(value)); return o ? o.label : value; }

function choice({ name, list, value = "", other = false, placeholder = "Choose…", id = name, required = false, attrs = "", otherLabel = "Other (type it)", otherPlaceholder = "" }) {
  const v = value == null ? "" : String(value);
  const known = v === "" || inList(list, v);
  const opt = (val, label, sel) => `<option value="${esc(val)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
  const items = (arr) => arr.map(norm).map((o) => opt(o.value, o.label, String(o.value) === v)).join("");
  const body = isGrouped(list) ? list.map(([g, arr]) => `<optgroup label="${esc(g)}">${items(arr)}</optgroup>`).join("") : items(list);
  const legacy = !known && !other ? opt(v, `${v} (saved earlier)`, true) : "";
  const tail = other ? opt(OTHER, otherLabel, !known) : "";
  const select = `<select id="${esc(id)}" name="${esc(name)}"${required ? " required" : ""} ${attrs}>${opt("", placeholder, v === "")}${body}${legacy}${tail}</select>`;
  const box = other ? `<input type="text" class="choice-other" name="${esc(name)}_other" id="${esc(id)}_other" value="${known ? "" : esc(v)}" maxlength="200" placeholder="${esc(otherPlaceholder || "If other, type it here")}" aria-label="Other ${esc(name.replace(/_/g, " "))}">` : "";
  return raw(other ? `<span class="choice">${select}${box}</span>` : select);
}

/** Read a dropdown answer. With a list and no "other", values outside the list are rejected (returns undefined). */
function readChoice(body, name, { list = null, other = false, max = 200 } = {}) {
  const b = body || {};
  const v = String(b[name] ?? "").trim();
  if (other && (v === OTHER || (v === "" && String(b[`${name}_other`] ?? "").trim()))) return String(b[`${name}_other`] ?? "").trim().slice(0, max) || null;
  if (v === "") return null;
  if (list && !other && !inList(list, v)) return undefined;
  return v.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Places                                                              */
/* ------------------------------------------------------------------ */

const STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["PR", "Puerto Rico"], ["GU", "Guam"], ["VI", "U.S. Virgin Islands"], ["AS", "American Samoa"], ["MP", "Northern Mariana Islands"],
].map(([value, name]) => ({ value, label: `${value} · ${name}` }));
const STATE_CODES = STATES.map((s) => s.value);
/** State dropdown. Blank defaults to the clinic's state (or AZ) only when `defaultState` is given. */
function stateChoice(name, value, { defaultState = null, id = name, required = false, attrs = "" } = {}) {
  return choice({ name, list: STATES, value: value || defaultState || "", placeholder: "State…", id, required, attrs });
}

/* ------------------------------------------------------------------ */
/* Insurance                                                           */
/* ------------------------------------------------------------------ */

// AHCCCS health plans change with contract cycles: VERIFY against current AHCCCS contracts (keep src/payers.js in step).
const PAYERS = [
  ["Arizona Medicaid (AHCCCS)", ["Mercy Care", "Banner University Health Plans", "Arizona Complete Health – Complete Care Plan", "UnitedHealthcare Community Plan",
    "Care1st", "Molina Complete Care of Arizona", "Health Choice / AzCH", "AHCCCS Fee-for-Service", "AIHP – American Indian Health Program", "DCS CHP"]],
  ["Medicare and military", ["Medicare", "Medicare Advantage", "TRICARE", "VA Community Care"]],
  ["Commercial", ["Aetna", "Blue Cross Blue Shield of Arizona", "Cigna / Evernorth", "UnitedHealthcare", "Optum Behavioral Health", "Humana", "Magellan Health", "Ambetter"]],
  ["No insurance", ["Self-pay"]],
];

/* ------------------------------------------------------------------ */
/* Medications and prescriptions                                       */
/* ------------------------------------------------------------------ */

const MED_ROUTES = ["By mouth (PO)", "Sublingual (SL)", "Buccal", "Intramuscular (IM)", "Long-acting injectable (LAI)", "Subcutaneous (SC)", "Intravenous (IV)",
  "Topical", "Transdermal patch", "Inhaled", "Nasal", "Rectal", "Pellet implant", "Not applicable (supply)"];
const MED_FREQUENCIES = ["Once daily", "Twice daily (BID)", "Three times daily (TID)", "Four times daily (QID)", "Every morning (QAM)", "At bedtime (QHS)",
  "Every other day", "As needed (PRN)", "Once weekly", "Every 2 weeks", "Every 4 weeks", "Monthly", "Every 3 months"];
const DOSAGE_FORMS = ["Tablet", "Extended-release tablet", "Orally disintegrating tablet (ODT)", "Capsule", "Extended-release capsule", "Oral solution",
  "Oral suspension", "Injectable solution (vial)", "Prefilled syringe / auto-injector", "Long-acting injectable suspension", "Topical gel (metered pump)",
  "Topical cream", "Transdermal patch", "Pellet", "Nasal spray", "Supply"];

/* ------------------------------------------------------------------ */
/* Staff credentials                                                   */
/* ------------------------------------------------------------------ */

// independent: can practice/supervise without co-sign; prescriber: prescriptive authority; edu: AHCCCS education modifier.
const CREDENTIALS = [
  { value: "LCSW", label: "LCSW · Licensed Clinical Social Worker", independent: true, edu: "HO" },
  { value: "LMSW", label: "LMSW · Licensed Master Social Worker", edu: "HO" },
  { value: "LBSW", label: "LBSW · Licensed Baccalaureate Social Worker", edu: "HN" },
  { value: "LPC", label: "LPC · Licensed Professional Counselor", independent: true, edu: "HO" },
  { value: "LAC", label: "LAC · Licensed Associate Counselor", edu: "HO" },
  { value: "LMFT", label: "LMFT · Licensed Marriage and Family Therapist", independent: true, edu: "HO" },
  { value: "LAMFT", label: "LAMFT · Licensed Associate MFT", edu: "HO" },
  { value: "LISAC", label: "LISAC · Licensed Independent Substance Abuse Counselor", independent: true, edu: "HO" },
  { value: "LASAC", label: "LASAC · Licensed Associate Substance Abuse Counselor", edu: "HO" },
  { value: "LSAT", label: "LSAT · Licensed Substance Abuse Technician", edu: "HN" },
  { value: "PhD", label: "PhD · Psychologist", independent: true, edu: "HP" },
  { value: "PsyD", label: "PsyD · Psychologist", independent: true, edu: "HP" },
  { value: "MD", label: "MD · Physician", independent: true, prescriber: true, edu: "HP" },
  { value: "DO", label: "DO · Physician", independent: true, prescriber: true, edu: "HP" },
  { value: "PMHNP-BC", label: "PMHNP-BC · Psychiatric Mental Health NP", independent: true, prescriber: true, edu: "HO" },
  { value: "FNP-C", label: "FNP-C · Family Nurse Practitioner", independent: true, prescriber: true, edu: "HO" },
  { value: "APRN", label: "APRN · Advanced Practice Registered Nurse", independent: true, prescriber: true, edu: "HO" },
  { value: "PA-C", label: "PA-C · Physician Assistant", independent: true, prescriber: true, edu: "HO" },
  { value: "RN", label: "RN · Registered Nurse", edu: "HN" },
  { value: "LPN", label: "LPN · Licensed Practical Nurse" },
  { value: "BHP", label: "BHP · Behavioral Health Professional" },
  { value: "BHT", label: "BHT · Behavioral Health Technician", edu: "HN" },
  { value: "BHPP", label: "BHPP · Behavioral Health Paraprofessional", edu: "HM" },
  { value: "CPRS", label: "CPRS · Certified Peer Recovery Specialist" },
  { value: "CADC", label: "CADC · Certified Alcohol and Drug Counselor" },
];

/* ------------------------------------------------------------------ */
/* Billing                                                             */
/* ------------------------------------------------------------------ */

const POS = [
  { value: "11", label: "11 · Office" }, { value: "02", label: "02 · Telehealth, other than member's home" }, { value: "10", label: "10 · Telehealth, in member's home" },
  { value: "12", label: "12 · Home" }, { value: "03", label: "03 · School" }, { value: "53", label: "53 · Community mental health center" },
  { value: "57", label: "57 · Non-residential substance use treatment facility" }, { value: "55", label: "55 · Residential substance use treatment facility" },
  { value: "49", label: "49 · Independent clinic" }, { value: "22", label: "22 · On-campus outpatient hospital" }, { value: "15", label: "15 · Mobile unit" },
  { value: "04", label: "04 · Homeless shelter" }, { value: "09", label: "09 · Prison / correctional facility" }, { value: "99", label: "99 · Other place of service" },
];
const MODIFIERS = [
  ["Telehealth", [{ value: "95", label: "95 · Synchronous audio-video telehealth" }, { value: "GT", label: "GT · Interactive audio-video (AHCCCS / some payers)" },
    { value: "93", label: "93 · Audio-only telehealth" }, { value: "FQ", label: "FQ · Audio-only (RHC/FQHC, some payers)" }]],
  ["Clinician education (AHCCCS)", [{ value: "HM", label: "HM · Less than bachelor's degree" }, { value: "HN", label: "HN · Bachelor's degree" },
    { value: "HO", label: "HO · Master's degree" }, { value: "HP", label: "HP · Doctoral degree" }]],
  ["Program / setting", [{ value: "HQ", label: "HQ · Group setting" }, { value: "HR", label: "HR · Family/couple with client present" },
    { value: "HS", label: "HS · Family/couple without client" }, { value: "HE", label: "HE · Mental health program" }, { value: "HF", label: "HF · Substance abuse program" },
    { value: "HA", label: "HA · Child/adolescent program" }, { value: "HK", label: "HK · Specialized high-risk population" }]],
  ["Other", [{ value: "GC", label: "GC · Service by a resident under a teaching physician" }, { value: "25", label: "25 · Significant, separate E/M service" },
    { value: "59", label: "59 · Distinct procedural service" }, { value: "XE", label: "XE · Separate encounter" }, { value: "XS", label: "XS · Separate structure" },
    { value: "XP", label: "XP · Separate practitioner" }, { value: "XU", label: "XU · Unusual non-overlapping service" }, { value: "KX", label: "KX · Requirements met / medical necessity documented" },
    { value: "AF", label: "AF · Specialty physician" }, { value: "SA", label: "SA · Nurse practitioner with physician" }]],
];
const BH_CODES = [
  ["Psychotherapy and evaluation", [["90791", "Psychiatric diagnostic evaluation"], ["90792", "Psychiatric diagnostic evaluation with medical services"],
    ["90832", "Psychotherapy, 30 minutes (16-37)"], ["90834", "Psychotherapy, 45 minutes (38-52)"], ["90837", "Psychotherapy, 60 minutes (53+)"],
    ["90839", "Psychotherapy for crisis, first 60 minutes"], ["90840", "Psychotherapy for crisis, each additional 30 minutes"],
    ["90846", "Family psychotherapy without the client"], ["90847", "Family psychotherapy with the client"], ["90853", "Group psychotherapy"],
    ["90785", "Interactive complexity add-on"], ["96127", "Brief emotional/behavioral assessment (e.g. PHQ-9)"]]],
  ["Medication management (E/M)", [["99202", "New patient office visit, straightforward"], ["99203", "New patient office visit, low complexity"],
    ["99204", "New patient office visit, moderate complexity"], ["99212", "Established patient visit, straightforward"], ["99213", "Established patient visit, low complexity"],
    ["99214", "Established patient visit, moderate complexity"], ["99215", "Established patient visit, high complexity"],
    ["90833", "Psychotherapy add-on with E/M, 30 minutes"], ["90836", "Psychotherapy add-on with E/M, 45 minutes"], ["96372", "Therapeutic injection, IM or SC"]]],
  ["HCPCS (Medicaid behavioral health)", [["H0001", "Alcohol and/or drug assessment"], ["H0004", "Behavioral health counseling, per 15 minutes"],
    ["H0005", "Alcohol and/or drug group counseling"], ["H0015", "Intensive outpatient (alcohol/drug)"], ["H0020", "Methadone administration"],
    ["H0025", "Behavioral health prevention education"], ["H0031", "Mental health assessment by non-physician"], ["H0034", "Medication training and support, per 15 minutes"],
    ["H0038", "Self-help/peer services, per 15 minutes"], ["H2011", "Crisis intervention, per 15 minutes"], ["H2014", "Skills training and development, per 15 minutes"],
    ["H2017", "Psychosocial rehabilitation, per 15 minutes"], ["H2019", "Therapeutic behavioral services, per 15 minutes"], ["S5150", "Unskilled respite care, per 15 minutes"],
    ["T1016", "Case management, per 15 minutes"], ["T1019", "Personal care services, per 15 minutes"], ["J1071", "Testosterone cypionate, 1 mg"], ["J3121", "Testosterone enanthate, 1 mg"]]],
].map(([g, items]) => [g, items.map(([value, description]) => ({ value, label: `${value} · ${description}`, description }))]);

/* ------------------------------------------------------------------ */
/* Clinical notes                                                      */
/* ------------------------------------------------------------------ */

// Mental status exam: common standard descriptors. Each MSE field is a dropdown with "Other" for anything else.
const MSE_OPTIONS = {
  appearance: ["Well-groomed", "Appropriately dressed", "Casually dressed", "Disheveled", "Poor hygiene", "Unusual / bizarre dress", "Appears stated age", "Appears older than stated age"],
  behavior: ["Calm and cooperative", "Engaged, good eye contact", "Guarded", "Withdrawn", "Restless / fidgety", "Agitated", "Hostile", "Psychomotor slowing", "Psychomotor agitation"],
  speech: ["Normal rate, rhythm and volume", "Pressured", "Rapid", "Slow", "Soft", "Loud", "Monotone", "Slurred", "Poverty of speech", "Mute"],
  mood: ["Euthymic", "Depressed", "Anxious", "Irritable", "Angry", "Euphoric", "Dysphoric", "Labile", "Hopeless"],
  affect: ["Congruent, full range", "Constricted", "Blunted", "Flat", "Labile", "Incongruent with mood", "Tearful", "Expansive"],
  thought_process: ["Linear and goal-directed", "Logical", "Circumstantial", "Tangential", "Flight of ideas", "Loose associations", "Thought blocking", "Perseverative", "Disorganized"],
  thought_content: ["Unremarkable; denies SI/HI", "Passive suicidal ideation", "Active suicidal ideation", "Homicidal ideation", "Preoccupations", "Obsessions",
    "Paranoid ideation", "Delusions", "Ruminations", "Hopelessness / worthlessness"],
  perception: ["No hallucinations reported or observed", "Auditory hallucinations", "Visual hallucinations", "Tactile hallucinations", "Illusions",
    "Appears to respond to internal stimuli", "Depersonalization / derealization"],
  cognition: ["Alert and oriented x4", "Alert and oriented x3", "Alert and oriented x2", "Alert and oriented x1", "Impaired attention / concentration",
    "Impaired memory", "Drowsy", "Confused"],
  insight: ["Good", "Fair", "Limited", "Poor", "Absent"],
  judgment: ["Good", "Fair", "Limited", "Poor", "Impaired"],
};
const CONTACT_WHO = ["Client", "Parent / guardian", "Family member", "Spouse / partner", "Primary care provider", "Psychiatric prescriber", "Other treatment provider",
  "Case manager / care coordinator", "School", "Probation / court", "Health plan", "Pharmacy", "Housing provider", "Crisis team", "Other"];
const CONTACT_HOW = ["In person", "Phone", "Video", "Text message", "Secure portal message", "Email", "Letter / fax", "Attempted, no answer", "Voicemail left"];
const DISCHARGE_REASONS = ["Treatment goals met", "Client request / chose to end services", "No-show / lost to follow-up", "Referred to a higher level of care",
  "Referred to a lower level of care", "Transferred to another provider", "Moved out of the area", "Insurance or payer change", "Incarcerated",
  "Hospitalized long-term", "Deceased", "Administrative discharge", "Other"];

/* ------------------------------------------------------------------ */
/* Treatment plans                                                     */
/* ------------------------------------------------------------------ */

const PLAN_FREQUENCIES = ["Daily", "3x per week", "2x per week", "Weekly", "Every 2 weeks", "Every 3 weeks", "Monthly", "Every 2 months", "Quarterly", "As needed", "Ongoing (client practices daily)"];
const SESSION_LENGTHS = ["16-37 minutes (90832)", "38-52 minutes (90834)", "53+ minutes (90837)", "15 minutes (per unit)", "30 minutes", "60 minutes (group, 90853)",
  "50 minutes (family, 90846/90847)", "90 minutes", "3 hours (IOP)", "Not applicable"];
const DURATIONS = ["30 days", "60 days", "90 days", "6 weeks", "8 weeks", "12 weeks", "16 weeks", "6 months", "9 months", "12 months", "Until next plan review", "Duration of the treatment plan", "Ongoing"];

/* ------------------------------------------------------------------ */
/* Schedule, records, portal                                           */
/* ------------------------------------------------------------------ */

const CANCEL_REASONS = ["Client illness", "Client schedule conflict / work", "Transportation", "Childcare", "Weather", "Forgot", "Clinician unavailable / sick",
  "Insurance or authorization issue", "Client in crisis / hospitalized", "No longer needs services", "Rescheduled", "Other"];
const DISCLOSURE_PURPOSES = ["Treatment / coordination of care", "Payment", "Health care operations", "At the client's request", "Required by law / court order",
  "Public health", "Health oversight / audit", "Abuse or neglect report", "Law enforcement", "Serious threat to health or safety (duty to warn)", "Research", "Other"];
const PORTAL_TOPICS = [
  { value: "appointment", label: "Appointment request or change" }, { value: "cancel", label: "Cancel an appointment" },
  { value: "medication", label: "Medication or refill question" }, { value: "billing", label: "Billing or insurance" },
  { value: "records", label: "Forms or records request" }, { value: "clinician", label: "Question for my clinician" },
  { value: "technical", label: "Portal or technical help" }, { value: "other", label: "Something else" },
];

/* ------------------------------------------------------------------ */
/* Hormone therapy (controlled-substance stock)                        */
/* ------------------------------------------------------------------ */

const TRT_PRODUCTS = [
  { value: "Testosterone cypionate 200 mg/mL (1 mL vial)", mgml: 200 }, { value: "Testosterone cypionate 200 mg/mL (10 mL vial)", mgml: 200 },
  { value: "Testosterone cypionate 100 mg/mL (10 mL vial)", mgml: 100 }, { value: "Testosterone enanthate 200 mg/mL (5 mL vial)", mgml: 200 },
  { value: "Testosterone undecanoate 250 mg/mL (4 mL vial)", mgml: 250 },
].map((p) => ({ ...p, label: p.value }));
const TRT_WASTE_REASONS = ["Expired", "Damaged / dropped / broken vial", "Partial dose left over (single-use vial)", "Contaminated / sterility broken",
  "Drawn up but not given (client refused or left)", "Recalled by manufacturer", "Other"];
const TRT_ADJUST_REASONS = ["Recount / counting error", "Data entry correction", "Overfill found in vial", "Spill or breakage not witnessed",
  "Suspected theft or loss (report to DEA, Form 106)", "Other"];


/* ------------------------------------------------------------------ */
/* Second wave                                                         */
/* ------------------------------------------------------------------ */

// Patients
const ALLERGY_TYPES = [{ value: "drug", label: "Drug / medication" }, { value: "food", label: "Food" }, { value: "environmental", label: "Environmental (pollen, pets…)" },
  { value: "latex", label: "Latex" }, { value: "other", label: "Other" }];
const ALLERGY_REACTIONS = ["Rash", "Hives", "Itching", "Swelling / angioedema", "Anaphylaxis", "Shortness of breath / wheezing", "Nausea / vomiting", "Diarrhea",
  "Dizziness / fainting", "Headache", "Intolerance (not allergic)", "Unknown"];
const CONTACT_RELATIONSHIPS = ["Spouse / partner", "Parent", "Child", "Sibling", "Grandparent", "Other relative", "Legal guardian", "Friend", "Roommate",
  "Case manager", "Sponsor", "Other"];
// X12 837 individual relationship codes (subscriber relationship to the patient).
const SUBSCRIBER_RELATIONSHIPS = [{ value: "self", label: "18 · Self" }, { value: "spouse", label: "01 · Spouse" }, { value: "child", label: "19 · Child" },
  { value: "life_partner", label: "53 · Life partner" }, { value: "employee", label: "20 · Employee" }, { value: "guardian", label: "G8 · Other relationship (e.g. guardian)" },
  { value: "other", label: "G8 · Other relationship" }, { value: "unknown", label: "21 · Unknown" }];
const PRONOUNS = ["she/her", "he/him", "they/them", "she/they", "he/they", "ze/zir", "Use my name", "Prefer not to say"];
const GENDER_IDENTITIES = ["Female", "Male", "Transgender female / trans woman", "Transgender male / trans man", "Non-binary", "Genderqueer / gender fluid",
  "Two-spirit", "Questioning", "Prefer not to say"];

// Prescriptions
const RX_DISCONTINUE_REASONS = ["Dose change", "Side effects", "Not effective", "Course completed", "Client request", "Switched to another medication",
  "Cost or insurance", "Drug interaction", "Pregnancy / breastfeeding", "Lab results", "Other"];
const RX_VOID_REASONS = ["Wrong client", "Wrong drug", "Wrong dose or quantity", "Duplicate entry", "Written in error / never sent", "Other"];
const DAYS_SUPPLY = ["7", "14", "28", "30", "60", "84", "90"];
const SIG_ACTIONS = ["Take", "Inject", "Apply", "Place", "Use", "Inhale", "Insert"];
const SIG_UNITS = ["tablet(s)", "capsule(s)", "mL", "mg", "pump(s)", "patch(es)", "puff(s)", "spray(s)", "unit(s)"];
const SIG_ROUTES = ["by mouth", "under the tongue", "into the muscle", "under the skin", "to the skin", "into each nostril", "by inhalation"];
const SIG_FREQUENCIES = ["once daily", "twice daily", "three times daily", "four times daily", "every morning", "at bedtime", "every other day", "once weekly",
  "every 2 weeks", "every 4 weeks", "as needed"];

// Treatment plans
const OBJECTIVE_UNITS = ["points (score)", "times per week", "times per day", "days per week", "% of days", "hours per night", "sessions attended",
  "days abstinent", "panic attacks per week", "minutes per day", "out of 10 (self-rating)"];
const MEASURE_METHODS = ["Standardized measure in session", "Client self-report", "Client log / diary", "Clinician observation", "Collateral report (family, school)",
  "Lab / drug screen", "Attendance records", "Pharmacy / refill records"];
const MEASURE_FREQUENCIES = ["Every session", "Weekly", "Every 2 weeks", "Monthly", "At each plan review"];
const RESPONSIBLE_PEOPLE = ["Client", "Parent / guardian", "Spouse / partner", "Family member", "Peer support specialist", "Sponsor", "Case manager (outside agency)",
  "Primary care provider", "Outside prescriber", "School staff"];
const REVIEW_DAYS = [{ value: "30", label: "Every 30 days" }, { value: "60", label: "Every 60 days" }, { value: "90", label: "Every 90 days" },
  { value: "180", label: "Every 6 months" }, { value: "365", label: "Every 12 months" }];
const PROGRAM_LEVELS = ["Outpatient (OP)", "Intensive outpatient (IOP)", "Partial hospitalization (PHP)", "Residential", "Inpatient", "Withdrawal management",
  "Supportive housing", "Early intervention", "Aftercare"];
const SIGNATURE_DECLINED = ["Client refused to sign", "Unable to sign due to symptoms or capacity", "Not present (telehealth / remote review)", "Guardian not available",
  "Language barrier, no interpreter available", "Will sign at next visit", "Other"];
const REVIEW_PARTICIPANTS = ["Client", "Parent / guardian", "Family member", "Prescriber", "Case manager", "Peer support specialist", "Outside provider"];

// Notes
const DISCHARGE_STATUS = ["Improved", "Stable", "Unchanged", "Worsened", "Unknown (lost to follow-up)"];
const CALOCUS_LEVELS = [{ value: "0", label: "Level 0 · Basic services" }, { value: "1", label: "Level 1 · Recovery maintenance and health management" },
  { value: "2", label: "Level 2 · Low-intensity community-based services" }, { value: "3", label: "Level 3 · High-intensity community-based services" },
  { value: "4", label: "Level 4 · Medically monitored non-residential" }, { value: "5", label: "Level 5 · Medically monitored residential" },
  { value: "6", label: "Level 6 · Medically managed residential" }];
const ROI_PURPOSES = ["Coordination of care", "Continuity of care / referral", "Family involvement in treatment", "Insurance / payment", "Legal / court",
  "School", "Employer / disability", "At the client's request", "Other"];
const COPY_GIVEN = ["Printed copy given", "Sent electronically / photo", "Client declined a copy", "Not given (will provide)"];
const LANGUAGES = ["English", "Spanish", "Navajo", "Apache", "Tohono O'odham", "Vietnamese", "Chinese (Mandarin)", "Chinese (Cantonese)", "Arabic", "Tagalog",
  "Korean", "Russian", "French", "American Sign Language (ASL)"];

// Hormone therapy
const TRT_SIDE_EFFECTS = ["None reported", "Acne / oily skin", "Swelling / edema", "Breast tenderness / gynecomastia", "Mood changes / irritability",
  "Sleep apnea symptoms / snoring", "Injection site reaction", "Hair loss", "Reduced testicular size", "Headache", "Elevated blood pressure"];
const TRT_STOP_REASONS = ["Client choice", "Hematocrit too high", "PSA high or rising", "Side effects", "Cost / insurance", "Fertility plans",
  "Symptoms resolved / not helpful", "Lost to follow-up", "Transferred care", "Other"];
const TRT_ANCILLARY = ["Anastrozole", "hCG (human chorionic gonadotropin)", "Enclomiphene", "Clomiphene", "Finasteride"];
const TRT_VOID_REASONS = ["Wrong client", "Duplicate entry", "Wrong date or dose entered", "Dose not actually given", "Other"];
const TRT_FREQ_DAYS = [{ value: "3", label: "Every 3-4 days (twice weekly)" }, { value: "7", label: "Weekly (7 days)" }, { value: "10", label: "Every 10 days" },
  { value: "14", label: "Every 2 weeks (14 days)" }, { value: "21", label: "Every 3 weeks" }, { value: "28", label: "Every 4 weeks" },
  { value: "1", label: "Daily (gel / topical)" }, { value: "90", label: "Every 3 months (pellets)" }];

// Billing
const PAYMENT_METHODS = [{ value: "card", label: "Card" }, { value: "cash", label: "Cash" }, { value: "check", label: "Check" }, { value: "ach", label: "Bank transfer (ACH)" },
  { value: "insurance_eft", label: "Insurance payment (EFT)" }, { value: "insurance_check", label: "Insurance payment (check)" }, { value: "insurance", label: "Insurance (other)" },
  { value: "adjustment", label: "Adjustment (no money received)" }];
const ADJUSTMENT_TYPES = ["Contractual adjustment", "Write-off", "Small-balance write-off", "Courtesy / hardship discount", "Bad debt", "Refund to client",
  "Refund to payer", "Correction"];
const CARC_REASONS = [{ value: "CO-4", label: "CO-4 · Procedure code inconsistent with modifier" }, { value: "CO-11", label: "CO-11 · Diagnosis inconsistent with procedure" },
  { value: "CO-16", label: "CO-16 · Missing or invalid claim information" }, { value: "CO-18", label: "CO-18 · Duplicate claim" },
  { value: "CO-22", label: "CO-22 · Covered by another payer (COB)" }, { value: "CO-27", label: "CO-27 · Coverage terminated" },
  { value: "CO-29", label: "CO-29 · Timely filing limit passed" }, { value: "CO-50", label: "CO-50 · Not medically necessary" },
  { value: "CO-96", label: "CO-96 · Non-covered charge" }, { value: "CO-97", label: "CO-97 · Included in another service (bundled)" },
  { value: "CO-109", label: "CO-109 · Not covered by this payer" }, { value: "CO-119", label: "CO-119 · Benefit maximum reached" },
  { value: "CO-167", label: "CO-167 · Diagnosis not covered" }, { value: "CO-170", label: "CO-170 · Not paid for this provider type" },
  { value: "CO-197", label: "CO-197 · Prior authorization missing" }, { value: "CO-242", label: "CO-242 · Provider not in network" },
  { value: "PR-1", label: "PR-1 · Deductible" }, { value: "PR-2", label: "PR-2 · Coinsurance" }, { value: "PR-3", label: "PR-3 · Copay" },
  { value: "OTHER", label: "Other (see note)" }];

// Records, portal, website, pictures
const RELEASED_TO = ["The client", "Personal representative / guardian", "Someone the client named (designee)", "Attorney", "Other"];
const MAIN_CONCERNS = ["Anxiety or stress", "Depression or low mood", "Trauma / PTSD", "Relationship or family", "Substance use", "ADHD / focus",
  "Grief or loss", "Medication management", "Child or teen concerns", "Something else"];
const APPT_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const APPT_TIMES = ["Mornings (8-12)", "Afternoons (12-5)", "Evenings (after 5)"];
const VISIT_PREFS = ["In person", "Video (telehealth)", "Either"];
const STAFF_MESSAGE_TEMPLATES = ["Appointment reminder", "Forms to complete", "Follow-up from your session", "Billing notice", "Prescription update", "General message"];

module.exports = {
  ALLERGY_TYPES, ALLERGY_REACTIONS, CONTACT_RELATIONSHIPS, SUBSCRIBER_RELATIONSHIPS, PRONOUNS, GENDER_IDENTITIES,
  RX_DISCONTINUE_REASONS, RX_VOID_REASONS, DAYS_SUPPLY, SIG_ACTIONS, SIG_UNITS, SIG_ROUTES, SIG_FREQUENCIES,
  OBJECTIVE_UNITS, MEASURE_METHODS, MEASURE_FREQUENCIES, RESPONSIBLE_PEOPLE, REVIEW_DAYS, PROGRAM_LEVELS, SIGNATURE_DECLINED, REVIEW_PARTICIPANTS,
  DISCHARGE_STATUS, CALOCUS_LEVELS, ROI_PURPOSES, COPY_GIVEN, LANGUAGES, TRT_SIDE_EFFECTS, TRT_STOP_REASONS, TRT_ANCILLARY, TRT_VOID_REASONS, TRT_FREQ_DAYS,
  PAYMENT_METHODS, ADJUSTMENT_TYPES, CARC_REASONS, RELEASED_TO, MAIN_CONCERNS, APPT_DAYS, APPT_TIMES, VISIT_PREFS, STAFF_MESSAGE_TEMPLATES,
  OTHER, choice, readChoice, inList, labelFor, flat,
  STATES, STATE_CODES, stateChoice, PAYERS, MED_ROUTES, MED_FREQUENCIES, DOSAGE_FORMS, CREDENTIALS, POS, MODIFIERS, BH_CODES,
  MSE_OPTIONS, CONTACT_WHO, CONTACT_HOW, DISCHARGE_REASONS, PLAN_FREQUENCIES, SESSION_LENGTHS, DURATIONS,
  CANCEL_REASONS, DISCLOSURE_PURPOSES, PORTAL_TOPICS, TRT_PRODUCTS, TRT_WASTE_REASONS, TRT_ADJUST_REASONS,
};
