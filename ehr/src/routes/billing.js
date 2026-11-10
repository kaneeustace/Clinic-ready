"use strict";
/*
 * Billing: charges, payments, fee schedule, patient ledger and superbills.
 *   billing:read  -> view (admin, billing, clinician, frontdesk)
 *   billing:write -> change (admin, billing)
 *   admin         -> edit the fee schedule
 */
const express = require("express");
const { tx } = require("../db");
const { audit } = require("../audit");
const { requirePerm } = require("../auth");
const { can } = require("../permissions");
const { isAhcccs, unitsFor15, educationModifier } = require("../payers");
const { ahcccsDocumentationErrors } = require("./plans");
const {
  html, raw, page, chartPage, notFound, csrfField, select, badge, getPatient, patientName,
  today, nowLocal, addDays, fmtDate, money, parseMoney, humanize,
} = require("../views");

const router = express.Router();
const read = requirePerm("billing:read");
const write = requirePerm("billing:write");

const STATUSES = ["unbilled", "billed", "paid", "denied", "void"];
const TRANSITIONS = {
  unbilled: ["billed", "void"],
  billed: ["paid", "denied", "void"],
  denied: ["billed", "void"],
  paid: ["void"],
  void: [],
};
const TRANSITION_LABEL = { billed: "Mark billed", paid: "Mark paid", denied: "Mark denied", void: "Void" };
const METHODS = ["card", "cash", "check", "insurance", "adjustment"];
const METHOD_LABEL = { card: "Card", cash: "Cash", check: "Check", insurance: "Insurance payment", adjustment: "Adjustment (credit)" };
const PAGE_SIZE = 50;
const CPT_RE = /^(\d{4}[0-9A-Z]|[A-Z]\d{4})$/; // CPT (90837, 0591T) or HCPCS Level II (H0004, T1016)
const HCPCS_RE = /^[A-Z]\d{4}$/;
const EM_RE = /^99\d{3}$/;                        // E/M codes: FQ (audio-only) not allowed under AHCCCS
const ICD_RE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
const MODIFIER_RE = /^[0-9A-Z]{2}$/;
const MAX_MODIFIERS = 4;

/*
 * AHCCCS (Arizona Medicaid) billing rules. See docs/ahcccs-spec.md §D. AHCCCS updates code tables quarterly:
 * treat these as configuration and re-verify against the current B2 Matrix and Telehealth Code Set.
 */
/** Codes billed per 15 minutes (units = unitsFor15(minutes); edit MD418). */
const TIMED_15 = new Set(["H0004", "H2014", "H2017", "H0038", "T1016"]);
/** Codes not confirmed as covered for AHCCCS; flagged (not blocked) when used. */
const AHCCCS_UNCONFIRMED = new Set(["90839", "90840", "90785"]);
const POS_OPTIONS = [
  { value: "11", label: "11 · Office" }, { value: "12", label: "12 · Home" }, { value: "03", label: "03 · School" },
  { value: "99", label: "99 · Other" }, { value: "02", label: "02 · Telehealth, other than member's home" },
  { value: "10", label: "10 · Telehealth, in member's home" },
];
const POS_CODES = POS_OPTIONS.map((o) => o.value);
/** Staff who can't bill under their own NPI for AHCCCS (associate-level licenses, BHT, BHPP). */
const NON_INDEPENDENT_RE = /\b(BHT|BHPP|LAC|LMSW|LAMFT|LASAC|PRSS|CPRSS)\b/i;
const isNonIndependent = (credentials) => NON_INDEPENDENT_RE.test(String(credentials || ""));
const FACILITY_NOTE = "Bill under facility NPI; rendering provider in Box 19";

/** Split a stored/entered modifier string ("GT HO", "GT,HO", "GT-HO") into a list. */
const parseModifiers = (s) => String(s || "").toUpperCase().split(/[\s,;\-]+/).map((x) => x.trim()).filter(Boolean);
const modSuffix = (m) => { const l = parseModifiers(m); return l.length ? `-${l.join("-")}` : ""; };

function noteContent(note) {
  if (!note) return {};
  try { const c = JSON.parse(note.content || "{}"); return c && typeof c === "object" ? c : {}; } catch { return {}; }
}
/** Service type of a note: 'group' | 'family_present' | 'family_absent' | 'individual' | ''. */
function noteServiceType(note) {
  if (!note) return "";
  const st = String(noteContent(note).service_type || "").toLowerCase();
  if (note.type === "group" || /group/.test(st)) return "group";
  if (/absent|without/.test(st)) return "family_absent";
  if (/family|present/.test(st)) return "family_present";
  return st ? "individual" : "";
}
/** Telehealth modality: 'audio_video' | 'audio_only' | '' (in person / unknown). */
function telehealthModality(note, appt) {
  const m = String(noteContent(note).telehealth_modality || "").toLowerCase();
  if (/audio[_ -]?only|phone|fq/.test(m)) return "audio_only";
  if (/video|gt/.test(m)) return "audio_video";
  if (!m && appt && appt.modality === "telehealth") return "audio_video";
  return "";
}
const hhmm = (t) => (/^\d{1,2}:\d{2}$/.test(String(t || "")) ? Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]) : null);
/** Documented minutes: the note's session start/end, else the appointment's scheduled length. */
function minutesFor(note, appt) {
  const c = noteContent(note);
  const a = hhmm(c.session_start), b = hhmm(c.session_end);
  if (a !== null && b !== null && b > a) return b - a;
  if (appt) {
    const mins = (new Date(appt.end_at + ":00Z") - new Date(appt.start_at + ":00Z")) / 60000;
    if (mins > 0) return mins;
  }
  return null;
}

/**
 * Suggested modifiers for an AHCCCS charge (telehealth GT/FQ, group HQ, H0004 HR/HS, education level).
 * Returns { modifiers: [...], notes: [...human hints] }. Non-AHCCCS: 95 for telehealth (previous behavior).
 */
function suggestModifiers({ ahcccs, cpt = "", note = null, appt = null, provider = null }) {
  const mods = [], notes = [];
  const tele = telehealthModality(note, appt);
  if (!ahcccs) {
    if (appt && appt.modality === "telehealth") mods.push("95");
    return { modifiers: mods, notes };
  }
  if (tele === "audio_video") { mods.push("GT"); notes.push("GT: audio-video telehealth."); }
  if (tele === "audio_only") {
    if (EM_RE.test(cpt)) notes.push("Audio-only telehealth: FQ is not allowed on E/M codes.");
    else { mods.push("FQ"); notes.push("FQ: audio-only telehealth."); }
  }
  const st = noteServiceType(note);
  if (st === "group" || cpt === "90853") { mods.push("HQ"); notes.push("HQ: group service."); }
  if (cpt === "H0004" && st === "family_present") { mods.push("HR"); notes.push("HR: family session, member present."); }
  if (cpt === "H0004" && st === "family_absent") { mods.push("HS"); notes.push("HS: family session, member absent."); }
  if (provider && (!cpt || HCPCS_RE.test(cpt))) {
    const edu = educationModifier(provider);
    if (edu) { if (HCPCS_RE.test(cpt)) mods.push(edu); notes.push(`${edu}: education level of ${provider.name || "the rendering provider"} (HCPCS codes).`); }
    else notes.push("No education level on file for the rendering provider; set it under Admin → Users for HCPCS modifiers.");
  }
  return { modifiers: [...new Set(mods)].slice(0, MAX_MODIFIERS), notes };
}

/**
 * Validate a charge's AHCCCS/time fields. Returns { errors: {field: msg}, warnings: [msg], units }.
 * `units` is the computed unit count for timed codes (else the entered units).
 */
function checkChargeRules({ ahcccs, cpt, modifiers, pos, minutes, units, note, appt, provider }) {
  const errors = {}, warnings = [];
  let outUnits = units;
  // 15-minute codes (all payers): units must match documented minutes.
  if (TIMED_15.has(cpt)) {
    if (minutes === null) errors.minutes = `${cpt} is billed per 15 minutes: enter the documented minutes.`;
    else if (minutes < 8) errors.minutes = `${cpt} needs at least 8 documented minutes for one unit (${minutes} documented).`;
    else {
      const expected = unitsFor15(minutes);
      if (units === null) outUnits = expected;
      else if (units !== expected) errors.units = `${minutes} minutes = ${expected} unit${expected === 1 ? "" : "s"} of ${cpt} (15-minute rule); ${units} entered. Units must match documented minutes (AHCCCS edit MD418).`;
    }
  }
  if (!ahcccs) return { errors, warnings, units: outUnits };

  if (!pos) errors.pos = "AHCCCS: choose the place of service (the member's location).";
  else if (pos === "02" || pos === "10") errors.pos = "AHCCCS uses member location POS (11 office, 12 home, 03 school, 99 other), not POS 02/10.";
  const has = (m) => modifiers.includes(m);
  const tele = telehealthModality(note, appt);
  if (has("95") || has("93")) errors.modifier = "AHCCCS does not accept modifier 95 or 93; use GT (audio-video) or FQ (audio-only) per the AHCCCS Telehealth Code Set.";
  else if (has("GT") && has("FQ")) errors.modifier = "Use exactly one telehealth modifier (GT or FQ).";
  else if (has("FQ") && EM_RE.test(cpt)) errors.modifier = "AHCCCS: FQ (audio-only) is not allowed on E/M codes (99xxx).";
  else if (tele === "audio_video" && note && has("FQ")) errors.modifier = "The note documents audio-video telehealth: use GT, not FQ.";
  else if (tele === "audio_only" && note && has("GT")) errors.modifier = "The note documents audio-only telehealth: use FQ, not GT.";
  else if (tele && !has("GT") && !has("FQ") && !(tele === "audio_only" && EM_RE.test(cpt))) {
    warnings.push(`Telehealth service without a telehealth modifier: AHCCCS expects ${tele === "audio_only" ? "FQ" : "GT"}.`);
  }
  if (!errors.modifier) {
    const st = noteServiceType(note);
    if ((st === "group" || cpt === "90853") && !has("HQ")) errors.modifier = "AHCCCS: group services require the HQ modifier.";
    else if (has("HR") && has("HS")) errors.modifier = "Use HR (member present) or HS (member absent), not both.";
    else if (cpt === "H0004" && st === "family_present" && !has("HR")) warnings.push("Family session with the member present: AHCCCS expects HR on H0004.");
    else if (cpt === "H0004" && st === "family_absent" && !has("HS")) warnings.push("Family session without the member: AHCCCS expects HS on H0004.");
  }
  if (HCPCS_RE.test(cpt) && provider) {
    const edu = educationModifier(provider);
    if (!edu) warnings.push("No education-level modifier (HM/HN/HO/HP) could be determined for the rendering provider; check the B2 Matrix.");
    else if (!["HM", "HN", "HO", "HP"].some(has)) warnings.push(`Education-level modifier missing: ${provider.name || "the rendering provider"} would bill ${edu}.`);
  }
  if (AHCCCS_UNCONFIRMED.has(cpt)) warnings.push(`${cpt} is not confirmed as covered by AHCCCS; verify against the B2 Matrix before billing.`);
  if (cpt === "H0038" && provider && !/\bC?PRSS\b/i.test(provider.credentials || "")) warnings.push("H0038 (peer support) requires the PRSS credential.");
  if (!note) warnings.push("Link the signed note that supports this charge; AHCCCS charges can't be billed without one.");
  return { errors, warnings, units: outUnits };
}

/** Blocking reasons an AHCCCS charge can't move to 'billed'. */
function ahcccsBillErrors(db, charge, patient) {
  const errors = [];
  const note = charge.note_id ? db.prepare("SELECT * FROM notes WHERE id = ?").get(charge.note_id) : null;
  if (!note) errors.push("AHCCCS: link the signed progress note that supports this service before billing.");
  else if (note.status !== "signed") errors.push("AHCCCS: the linked note must be signed before the charge can be billed.");
  if (!charge.pos) errors.push("AHCCCS: the place of service is missing.");
  return errors.concat(ahcccsDocumentationErrors(db, patient, charge.date_of_service));
}

/** Practice details for superbills, from Administration → Clinic settings. */
function practice(db) {
  const c = require("../clinic").getClinic(db);
  const missing = "[not set: Administration → Clinic settings]";
  return { name: c.name, address: c.address || missing, phone: c.phone || missing, npi: c.npi || missing, taxId: c.tax_id || missing, ready: c.billingReady };
}

/* ---------------- helpers ---------------- */
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const toInt = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : null);
const providerName = (r) => (r && r.provider_name ? `${r.provider_name}${r.provider_credentials ? `, ${r.provider_credentials}` : ""}` : "");

function loadPatient(req, res) {
  const id = toInt(req.params.id);
  const p = id ? getPatient(req, id) : null;
  if (!p) notFound(req, res, "Patient");
  return p;
}

function feeFor(db, cpt) {
  return db.prepare("SELECT * FROM fee_schedule WHERE cpt_code = ? AND active = 1").get(cpt) || null;
}
function activeFees(db) {
  return db.prepare("SELECT * FROM fee_schedule WHERE active = 1 ORDER BY cpt_code").all();
}
function providers(db) {
  return db.prepare("SELECT id, name, credentials, npi FROM users WHERE active = 1 AND role = 'clinician' ORDER BY name").all();
}
function patientBalance(db, patientId) {
  const c = db.prepare("SELECT COALESCE(SUM(fee_cents),0) AS n FROM charges WHERE patient_id = ? AND status != 'void'").get(patientId).n;
  const p = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM payments WHERE patient_id = ?").get(patientId).n;
  return { charges: c, payments: p, balance: c - p };
}
function insurance(db, patientId) {
  return db.prepare("SELECT * FROM insurance_policies WHERE patient_id = ? AND active = 1 ORDER BY priority = 'primary' DESC, id").all(patientId);
}
function activeDiagnoses(db, patientId) {
  return db.prepare("SELECT * FROM diagnoses WHERE patient_id = ? AND status = 'active' ORDER BY is_primary DESC, created_at, id").all(patientId);
}
/** Completed past appointments with no non-void charge. */
function unchargedAppointments(db, { patientId = null, limit = 100 } = {}) {
  return db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.mrn, u.name AS provider_name, u.credentials AS provider_credentials
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = a.clinician_id
     WHERE a.status = 'completed' AND a.start_at < ? ${patientId ? "AND a.patient_id = ?" : ""}
       AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.appointment_id = a.id AND c.status != 'void')
     ORDER BY a.start_at DESC LIMIT ?`).all(...[nowLocal(), ...(patientId ? [patientId] : []), limit]);
}

/** Notes that can be linked to a charge: the appointment's notes, else the patient's recent notes. */
function linkableNotes(db, patientId, appt) {
  return appt
    ? db.prepare(`SELECT id, type, status, service_date, signed_at, content FROM notes WHERE patient_id = ? AND appointment_id = ? ORDER BY id DESC`).all(patientId, appt.id)
    : db.prepare(`SELECT id, type, status, service_date, signed_at, content FROM notes WHERE patient_id = ? AND type NOT IN ('roi','safety_plan')
        ORDER BY COALESCE(service_date, substr(created_at, 1, 10)) DESC, id DESC LIMIT 30`).all(patientId);
}

/** Suggested CPT for an appointment, by type and duration. */
function suggestCpt(appt) {
  if (!appt) return "";
  const mins = (new Date(appt.end_at + ":00Z") - new Date(appt.start_at + ":00Z")) / 60000;
  switch (appt.type) {
    case "therapy":
      if (mins >= 53) return "90837";
      if (mins >= 38) return "90834";
      return "90832";
    case "med_management": return "99214";
    case "intake": return "90791";
    case "psychiatry_eval": return "90792";
    case "family": return "90847";
    case "group": return "90853";
    default: return "";
  }
}

function errorList(errors) {
  const list = Object.values(errors || {});
  return list.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong><ul>${list.map((e) => html`<li>${e}</li>`)}</ul></div>` : "";
}
const fieldError = (errors, k) => (errors && errors[k] ? html`<span class="error-text">${errors[k]}</span>` : "");

/** Status-change buttons for one charge. `back` is where to return afterwards. */
function statusActions(req, charge, back) {
  if (!can(req.user, "billing:write")) return "";
  const next = TRANSITIONS[charge.status] || [];
  if (!next.length) return "";
  return html`
    <form class="inline-form" method="post" action="/ehr/charges/${charge.id}/status">
      ${csrfField(req)}
      <input type="hidden" name="back" value="${back}">
      ${next.includes("void") ? html`<input type="hidden" name="confirm" value="yes">` : ""}
      ${next.map((s) => html`<button class="btn btn--sm ${s === "void" ? "btn--danger" : ""}" type="submit" name="status" value="${s}"
        ${s === "void" ? raw('data-confirm="Void this charge? Voided charges cannot be changed again."') : ""}>${TRANSITION_LABEL[s]}</button> `)}
    </form>`;
}

/* ---------------- dashboard ---------------- */
router.get("/billing", read, (req, res) => {
  const db = req.db;
  const q = req.query;
  const status = STATUSES.includes(q.status) ? q.status : "";
  const from = validDate(q.from) ? q.from : "";
  const to = validDate(q.to) ? q.to : "";
  const pageNo = Math.max(1, toInt(q.page) || 1);

  const unbilled = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fee_cents),0) AS amt FROM charges WHERE status = 'unbilled'").get();
  const billed = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fee_cents),0) AS amt FROM charges WHERE status = 'billed'").get();
  const monthStart = today().slice(0, 7) + "-01";
  const paidMonth = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amt FROM payments WHERE received_on >= ? AND received_on <= ?").get(monthStart, today());
  const queue = unchargedAppointments(db, { limit: 100 });

  const where = [];
  const params = [];
  if (status) { where.push("c.status = ?"); params.push(status); }
  if (from) { where.push("c.date_of_service >= ?"); params.push(from); }
  if (to) { where.push("c.date_of_service <= ?"); params.push(to); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM charges c ${w}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(pageNo, pages);
  const charges = db.prepare(
    `SELECT c.*, p.first_name, p.last_name, p.preferred_name, p.mrn, u.name AS provider_name, u.credentials AS provider_credentials
     FROM charges c JOIN patients p ON p.id = c.patient_id LEFT JOIN users u ON u.id = c.rendering_provider_id
     ${w} ORDER BY c.date_of_service DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (cur - 1) * PAGE_SIZE);

  const qs = (n) => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (from) u.set("from", from);
    if (to) u.set("to", to);
    if (n > 1) u.set("page", String(n));
    const s = u.toString();
    return "/ehr/billing" + (s ? "?" + s : "");
  };
  const back = qs(cur);

  audit(req, "view", "charge", null, null, "billing dashboard");
  const tile = (label, value, sub) => html`<div class="tile"><span class="tile__num">${value}</span><span class="tile__label">${label}</span>${sub ? html`<span class="tile__label small">${sub}</span>` : ""}</div>`;

  res.send(page(req, {
    title: "Billing",
    active: "billing",
    body: html`
      <div class="page-head">
        <h1>Billing</h1>
        <div class="row"><a class="btn" href="/ehr/billing/fee-schedule">Fee schedule</a></div>
      </div>
      <div class="tiles">
        ${tile("Unbilled charges", money(unbilled.amt), `${unbilled.n} charge${unbilled.n === 1 ? "" : "s"}`)}
        ${tile("Billed, outstanding", money(billed.amt), `${billed.n} charge${billed.n === 1 ? "" : "s"}`)}
        ${tile("Payments this month", money(paidMonth.amt), `${paidMonth.n} payment${paidMonth.n === 1 ? "" : "s"}`)}
        ${tile("Visits without charges", queue.length, "completed, not yet charged")}
      </div>

      <section class="card" aria-labelledby="queue-h">
        <div class="card__head"><h2 id="queue-h">Completed appointments without charges</h2></div>
        ${queue.length ? html`
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Date</th><th>Patient</th><th>Type</th><th>Provider</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${queue.map((a) => html`
              <tr>
                <td>${fmtDate(a.start_at)}</td>
                <td><a href="/ehr/patients/${a.patient_id}/billing">${patientName(a)}</a> <span class="muted small">${a.mrn}</span></td>
                <td>${humanize(a.type)}${a.modality === "telehealth" ? html` <span class="pill">Telehealth</span>` : ""}</td>
                <td>${providerName(a)}</td>
                <td>${can(req.user, "billing:write") ? html`<a class="btn btn--sm btn--primary" href="/ehr/patients/${a.patient_id}/charges/new?appointment_id=${a.id}">Create charge</a>` : ""}</td>
              </tr>`)}</tbody>
          </table></div>` : html`<p class="muted">All completed appointments have charges.</p>`}
      </section>

      <section class="card" aria-labelledby="charges-h">
        <div class="card__head"><h2 id="charges-h">Charges</h2></div>
        <form method="get" action="/ehr/billing" class="form-grid" role="search" aria-label="Filter charges">
          <label>Status ${select("status", [{ value: "", label: "All statuses" }, ...STATUSES.map((s) => ({ value: s, label: humanize(s) }))], status)}</label>
          <label>From <input type="date" name="from" value="${from}"></label>
          <label>To <input type="date" name="to" value="${to}"></label>
          <div class="row" style="align-self:end"><button class="btn btn--primary" type="submit">Filter</button> <a class="btn btn--ghost" href="/ehr/billing">Clear</a></div>
        </form>
        <p class="muted small">${total ? `Showing ${(cur - 1) * PAGE_SIZE + 1}–${Math.min(cur * PAGE_SIZE, total)} of ${total}` : "No charges match."}</p>
        ${charges.length ? html`
          <div class="table-wrap"><table class="table">
            <thead><tr><th>DOS</th><th>Patient</th><th>CPT</th><th class="num">Units</th><th class="num">Fee</th><th>Provider</th><th>Bill to</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${charges.map((c) => html`
              <tr>
                <td>${fmtDate(c.date_of_service)}</td>
                <td><a href="/ehr/patients/${c.patient_id}/billing">${patientName(c)}</a></td>
                <td>${c.cpt_code}${modSuffix(c.modifier)}</td>
                <td class="num">${c.units}</td>
                <td class="num">${money(c.fee_cents)}</td>
                <td>${providerName(c)}</td>
                <td>${humanize(c.bill_to)}</td>
                <td>${badge(c.status)}</td>
                <td>${statusActions(req, c, back)}</td>
              </tr>`)}</tbody>
          </table></div>` : ""}
        ${pages > 1 ? html`
          <nav class="row" aria-label="Pagination" style="margin-top:.75rem">
            ${cur > 1 ? html`<a class="btn btn--sm" href="${qs(cur - 1)}">Previous</a>` : ""}
            <span class="muted small">Page ${cur} of ${pages}</span>
            ${cur < pages ? html`<a class="btn btn--sm" href="${qs(cur + 1)}">Next</a>` : ""}
          </nav>` : ""}
      </section>`,
  }));
});

/* ---------------- fee schedule ---------------- */
function feeSchedulePage(req, res, { errors = {}, values = {}, status = 200 } = {}) {
  const fees = req.db.prepare("SELECT * FROM fee_schedule ORDER BY cpt_code").all();
  const isAdmin = can(req.user, "admin");
  res.status(status).send(page(req, {
    title: "Fee schedule",
    active: "billing",
    body: html`
      <div class="page-head"><h1>Fee schedule</h1><a class="btn btn--ghost" href="/ehr/billing">Back to billing</a></div>
      ${errorList(errors)}
      <section class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>CPT</th><th>Description</th><th class="num">Fee</th><th>Status</th>${isAdmin ? html`<th>Update</th>` : ""}</tr></thead>
          <tbody>${fees.map((f) => html`
            <tr>
              <td>${f.cpt_code}${TIMED_15.has(f.cpt_code) ? html` <span class="pill" title="Units = unitsFor15(minutes)">per 15 min</span>` : ""}</td>
              <td>${f.description}</td>
              <td class="num">${money(f.fee_cents)}</td>
              <td>${f.active ? badge("active") : badge("inactive")}</td>
              ${isAdmin ? html`<td>
                <form class="row" method="post" action="/ehr/billing/fee-schedule">
                  ${csrfField(req)}
                  <input type="hidden" name="cpt_code" value="${f.cpt_code}">
                  <label class="visually-hidden" for="fee-${f.cpt_code}">Fee for ${f.cpt_code}</label>
                  <input id="fee-${f.cpt_code}" name="fee" value="${(f.fee_cents / 100).toFixed(2)}" inputmode="decimal" style="width:7rem">
                  <label class="check"><input type="checkbox" name="active" value="1" ${f.active ? raw("checked") : ""}> Active</label>
                  <button class="btn btn--sm" type="submit">Save</button>
                </form></td>` : ""}
            </tr>`)}</tbody>
        </table></div>
      </section>
      ${isAdmin ? html`
        <section class="card" aria-labelledby="add-code-h">
          <h2 id="add-code-h">Add a code</h2>
          <form method="post" action="/ehr/billing/fee-schedule">
            ${csrfField(req)}
            <input type="hidden" name="active" value="1">
            <div class="form-grid">
              <label>CPT/HCPCS code <input name="cpt_code" value="${values.cpt_code || ""}" maxlength="5" required pattern="[0-9]{4}[0-9A-Za-z]|[A-Za-z][0-9]{4}"> ${fieldError(errors, "cpt_code")}</label>
              <label class="span-all">Description <input name="description" value="${values.description || ""}" maxlength="200" required> ${fieldError(errors, "description")}</label>
              <label>Fee ($) <input name="fee" value="${values.fee || ""}" inputmode="decimal" required> ${fieldError(errors, "fee")}</label>
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add code</button></div>
          </form>
        </section>` : html`<p class="muted small">Only administrators can change the fee schedule.</p>`}`,
  }));
}

router.get("/billing/fee-schedule", read, (req, res) => feeSchedulePage(req, res));

router.post("/billing/fee-schedule", requirePerm("admin"), (req, res) => {
  const db = req.db;
  const values = { cpt_code: str(req.body.cpt_code, 10).toUpperCase(), description: str(req.body.description), fee: str(req.body.fee, 20) };
  const errors = {};
  if (!CPT_RE.test(values.cpt_code)) errors.cpt_code = "Code must be a CPT code (4 digits then a digit or letter, e.g. 90837) or a HCPCS code (a letter then 4 digits, e.g. H0004).";
  const fee = parseMoney(values.fee);
  if (fee === null || fee <= 0 || fee > 10000000) errors.fee = "Enter a fee greater than $0.";
  const existing = errors.cpt_code ? null : db.prepare("SELECT * FROM fee_schedule WHERE cpt_code = ?").get(values.cpt_code);
  if (!existing && !values.description && !errors.cpt_code) errors.description = "Description is required for a new code.";
  if (Object.keys(errors).length) return feeSchedulePage(req, res, { errors, values, status: 400 });
  const active = req.body.active === "1" ? 1 : 0;
  if (existing) {
    db.prepare("UPDATE fee_schedule SET fee_cents = ?, description = ?, active = ? WHERE cpt_code = ?")
      .run(fee, values.description || existing.description, active, values.cpt_code);
    audit(req, "update", "fee_schedule", null, null, `code ${values.cpt_code}`);
    req.flash("success", `Updated ${values.cpt_code}.`);
  } else {
    db.prepare("INSERT INTO fee_schedule (cpt_code, description, fee_cents, active) VALUES (?, ?, ?, ?)").run(values.cpt_code, values.description, fee, active);
    audit(req, "create", "fee_schedule", null, null, `code ${values.cpt_code}`);
    req.flash("success", `Added ${values.cpt_code}.`);
  }
  res.redirect("/ehr/billing/fee-schedule");
});

/* ---------------- patient ledger ---------------- */
function ledgerPage(req, res, patient, { errors = {}, values = {}, status = 200 } = {}) {
  const db = req.db;
  const charges = db.prepare(
    `SELECT c.*, f.description, u.name AS provider_name, u.credentials AS provider_credentials
     FROM charges c LEFT JOIN fee_schedule f ON f.cpt_code = c.cpt_code LEFT JOIN users u ON u.id = c.rendering_provider_id
     WHERE c.patient_id = ?`).all(patient.id);
  const payments = db.prepare("SELECT * FROM payments WHERE patient_id = ?").all(patient.id);
  const rows = [
    ...charges.map((c) => ({ kind: "charge", date: c.date_of_service, seq: c.created_at, id: c.id, c })),
    ...payments.map((p) => ({ kind: "payment", date: p.received_on, seq: p.created_at, id: p.id, p })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind !== b.kind ? (a.kind === "charge" ? -1 : 1) : a.id - b.id));
  let running = 0;
  for (const r of rows) {
    if (r.kind === "charge" && r.c.status !== "void") running += r.c.fee_cents;
    if (r.kind === "payment") running -= r.p.amount_cents;
    r.balance = running;
  }
  const bal = patientBalance(db, patient.id);
  const policies = insurance(db, patient.id);
  const queue = unchargedAppointments(db, { patientId: patient.id, limit: 20 });
  const writer = can(req.user, "billing:write");
  const back = `/ehr/patients/${patient.id}/billing`;
  const v = { amount: "", method: "card", reference: "", received_on: today(), note: "", ...values };

  if (status === 200) audit(req, "view", "charge", null, patient.id, "ledger");
  res.status(status).send(chartPage(req, patient, "billing", html`
    ${errorList(errors)}
    <div class="tiles">
      <div class="tile"><span class="tile__num">${money(bal.balance)}</span><span class="tile__label">Current balance${bal.balance < 0 ? " (credit)" : ""}</span></div>
      <div class="tile"><span class="tile__num">${money(bal.charges)}</span><span class="tile__label">Total charges (excl. void)</span></div>
      <div class="tile"><span class="tile__num">${money(bal.payments)}</span><span class="tile__label">Payments and credits</span></div>
    </div>
    <div class="grid--2 grid">
      <section class="card" aria-labelledby="ins-h">
        <h2 id="ins-h">Insurance on file</h2>
        ${policies.length ? html`<ul class="list">${policies.map((p) => html`
          <li><strong>${humanize(p.priority)}:</strong> ${p.payer_name} · Member ${p.member_id || "—"}${p.group_number ? ` · Group ${p.group_number}` : ""}${p.copay_cents != null ? ` · Copay ${money(p.copay_cents)}` : ""}</li>`)}</ul>`
          : html`<p class="muted">No active insurance. Charges default to patient responsibility.</p>`}
      </section>
      <section class="card" aria-labelledby="actions-h">
        <h2 id="actions-h">Actions</h2>
        <div class="row">
          ${writer ? html`<a class="btn btn--primary" href="/ehr/patients/${patient.id}/charges/new">Add charge</a>` : ""}
          ${writer ? html`<a class="btn" href="#record-payment">Record payment</a>` : ""}
        </div>
        <form method="get" action="/ehr/patients/${patient.id}/superbill" class="form-grid" style="margin-top:1rem">
          <label>Superbill from <input type="date" name="from" value="${addDays(today(), -30)}"></label>
          <label>To <input type="date" name="to" value="${today()}"></label>
          <div style="align-self:end"><button class="btn" type="submit">Superbill</button></div>
        </form>
      </section>
    </div>

    ${queue.length ? html`
      <section class="card" aria-labelledby="pq-h">
        <h2 id="pq-h">Completed visits without charges</h2>
        <ul class="list">${queue.map((a) => html`<li>${fmtDate(a.start_at)} · ${humanize(a.type)} · ${providerName(a)}
          ${writer ? html` <a class="btn btn--sm" href="/ehr/patients/${patient.id}/charges/new?appointment_id=${a.id}">Create charge</a>` : ""}</li>`)}</ul>
      </section>` : ""}

    <section class="card" aria-labelledby="ledger-h">
      <h2 id="ledger-h">Ledger</h2>
      ${rows.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Date</th><th>Item</th><th>Detail</th><th class="num">Charge</th><th class="num">Payment</th><th class="num">Balance</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${rows.map((r) => r.kind === "charge" ? html`
            <tr ${r.c.status === "void" ? raw('class="muted"') : ""}>
              <td>${fmtDate(r.date)}</td>
              <td>${r.c.cpt_code}${modSuffix(r.c.modifier)} ${r.c.description ? html`<span class="muted small">${r.c.description}</span>` : ""}</td>
              <td class="small">${r.c.pos ? `POS ${r.c.pos} · ` : ""}${r.c.minutes != null ? `${r.c.minutes} min · ` : ""}${r.c.units > 1 ? `${r.c.units} units · ` : ""}${r.c.diagnosis_codes || ""}${r.c.provider_name ? ` · ${providerName(r.c)}` : ""} · bill ${r.c.bill_to}</td>
              <td class="num">${r.c.status === "void" ? html`<s>${money(r.c.fee_cents)}</s>` : money(r.c.fee_cents)}</td>
              <td class="num"></td>
              <td class="num">${money(r.balance)}</td>
              <td>${badge(r.c.status)}</td>
              <td>${statusActions(req, r.c, back)}</td>
            </tr>` : html`
            <tr>
              <td>${fmtDate(r.date)}</td>
              <td>${METHOD_LABEL[r.p.method] || humanize(r.p.method)}</td>
              <td class="small">${r.p.reference ? `Ref ${r.p.reference}` : ""}${r.p.note ? ` · ${r.p.note}` : ""}</td>
              <td class="num"></td>
              <td class="num">${money(r.p.amount_cents)}</td>
              <td class="num">${money(r.balance)}</td>
              <td></td><td></td>
            </tr>`)}</tbody>
          <tfoot><tr><td colspan="5">Current balance</td><td class="num">${money(bal.balance)}</td><td colspan="2"></td></tr></tfoot>
        </table></div>` : html`<p class="muted">No charges or payments yet.</p>`}
    </section>

    ${writer ? html`
      <section class="card" id="record-payment" aria-labelledby="pay-h">
        <h2 id="pay-h">Record payment</h2>
        <form method="post" action="/ehr/patients/${patient.id}/payments">
          ${csrfField(req)}
          <div class="form-grid">
            <label>Amount ($) <input name="amount" value="${v.amount}" inputmode="decimal" required> ${fieldError(errors, "amount")}</label>
            <label>Method ${select("method", METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] })), v.method)} ${fieldError(errors, "method")}</label>
            <label>Reference <input name="reference" value="${v.reference}" maxlength="60" placeholder="Check # or transaction ID"> ${fieldError(errors, "reference")}</label>
            <label>Received on <input type="date" name="received_on" value="${v.received_on}" required> ${fieldError(errors, "received_on")}</label>
            <label class="span-all">Note <input name="note" value="${v.note}" maxlength="200"><span class="hint">Billing note only. Do not enter clinical information.</span></label>
          </div>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Record payment</button></div>
        </form>
      </section>` : ""}`, { title: `Billing · ${patientName(patient)}` }));
}

router.get("/patients/:id/billing", read, (req, res) => {
  const patient = loadPatient(req, res);
  if (patient) ledgerPage(req, res, patient);
});

/* ---------------- payments ---------------- */
router.post("/patients/:id/payments", write, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const values = {
    amount: str(req.body.amount, 20), method: str(req.body.method, 20), reference: str(req.body.reference, 60),
    received_on: str(req.body.received_on, 10), note: str(req.body.note, 200),
  };
  const errors = {};
  const amount = parseMoney(values.amount);
  if (amount === null || amount <= 0) errors.amount = "Amount must be greater than $0.";
  else if (amount > 10000000) errors.amount = "Amount is too large.";
  if (!METHODS.includes(values.method)) errors.method = "Choose a payment method.";
  if (!validDate(values.received_on)) errors.received_on = "Enter a valid received date.";
  else if (values.received_on > today()) errors.received_on = "Received date cannot be in the future.";
  if (Object.keys(errors).length) return ledgerPage(req, res, patient, { errors, values, status: 400 });
  const id = Number(req.db.prepare(
    `INSERT INTO payments (patient_id, amount_cents, method, reference, received_on, note, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(patient.id, amount, values.method, values.reference || null, values.received_on, values.note || null, req.user.id).lastInsertRowid);
  audit(req, "create", "payment", id, patient.id, `method ${values.method}`);
  req.flash("success", `${values.method === "adjustment" ? "Adjustment" : "Payment"} of ${money(amount)} recorded.`);
  res.redirect(`/ehr/patients/${patient.id}/billing`);
});

/* ---------------- charges ---------------- */
function chargeForm(req, res, patient, { values = {}, errors = {}, appt = null, status = 200, warnings = [] } = {}) {
  const db = req.db;
  const fees = activeFees(db);
  const dx = activeDiagnoses(db, patient.id);
  const provs = providers(db);
  const existing = appt ? db.prepare("SELECT cpt_code, status FROM charges WHERE appointment_id = ? AND status != 'void'").all(appt.id) : [];
  const selectedDx = new Set(values.dx || []);
  const hasPolicy = insurance(db, patient.id).length > 0;
  const ahcccs = isAhcccs(db, patient.id);
  const notes = linkableNotes(db, patient.id, appt);
  const noteId = values.note_id !== undefined ? toInt(values.note_id) : ((notes.find((n) => n.status === "signed") || {}).id || null);
  const note = noteId ? notes.find((n) => n.id === noteId) || null : null;
  const cpt = values.cpt_code !== undefined ? values.cpt_code : suggestCpt(appt);
  const provId = values.rendering_provider_id !== undefined ? toInt(values.rendering_provider_id) : (appt ? appt.clinician_id : patient.primary_clinician_id);
  const provider = provId ? db.prepare("SELECT id, name, credentials, education_level FROM users WHERE id = ?").get(provId) : null;
  const sugg = suggestModifiers({ ahcccs, cpt, note, appt, provider });
  const mins = minutesFor(note, appt);
  const c = noteContent(note);
  const notePos = POS_CODES.includes(String(c.pos || c.member_location || "")) ? String(c.pos || c.member_location) : "";
  const v = {
    appointment_id: appt ? appt.id : "", date_of_service: appt ? appt.start_at.slice(0, 10) : today(),
    rendering_provider_id: provId || "", cpt_code: cpt,
    units: TIMED_15.has(cpt) && mins ? String(unitsFor15(mins) || 1) : "1", fee: "", modifier: sugg.modifiers.join(" "),
    pos: notePos || (appt && appt.modality === "in_person" ? "11" : ""), minutes: mins != null ? String(mins) : "", note_id: noteId || "",
    bill_to: hasPolicy ? "insurance" : "patient", dx_other: "", ...values,
  };
  const dxDefault = !values.dx && !values.dx_other; // first render: all active diagnoses checked
  const noteLabel = (n) => `${humanize(n.type)} · ${fmtDate(n.service_date || String(n.signed_at || "").slice(0, 10))} · ${n.status === "signed" ? "signed" : "UNSIGNED draft"}`;

  res.status(status).send(chartPage(req, patient, "billing", html`
    <div class="page-head"><h2>New charge ${ahcccs ? html`<span class="pill">AHCCCS</span>` : ""}</h2><a class="btn btn--ghost" href="/ehr/patients/${patient.id}/billing">Cancel</a></div>
    ${errorList(errors)}
    ${warnings.length ? html`<div class="alert alert--warn" role="status"><strong>Check:</strong><ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ""}
    ${appt ? html`<p class="alert alert--info">For the ${humanize(appt.type)} appointment on ${fmtDate(appt.start_at)}${appt.modality === "telehealth" ? " (telehealth)" : ""}.</p>` : ""}
    ${existing.length ? html`<p class="alert alert--warn">This appointment already has charge(s): ${existing.map((x) => `${x.cpt_code} (${x.status})`).join(", ")}.</p>` : ""}
    ${ahcccs ? html`<div class="alert alert--info" role="note"><strong>AHCCCS member.</strong> POS is the member's location (not 02/10); telehealth uses GT (audio-video) or FQ (audio-only), never 95/93; group services need HQ; per-15-minute codes need units that match documented minutes. To bill, the linked note must be signed and a Service Plan and assessment no more than 1 year old must cover the date of service.
      ${sugg.notes.length ? html`<br>Suggested modifiers: ${sugg.notes.join(" ")}` : ""}</div>` : ""}
    <form class="card" method="post" action="/ehr/patients/${patient.id}/charges">
      ${csrfField(req)}
      ${v.appointment_id ? html`<input type="hidden" name="appointment_id" value="${v.appointment_id}">` : ""}
      <div class="form-grid">
        <label>Date of service <input type="date" name="date_of_service" value="${v.date_of_service}" required> ${fieldError(errors, "date_of_service")}</label>
        <label>CPT/HCPCS code ${select("cpt_code", [{ value: "", label: "Choose a code" }, ...fees.map((f) => ({ value: f.cpt_code, label: `${f.cpt_code} · ${f.description} · ${money(f.fee_cents)}${TIMED_15.has(f.cpt_code) ? " / unit" : ""}` }))], v.cpt_code, "required")} ${fieldError(errors, "cpt_code")}</label>
        <label>Modifiers <input name="modifier" value="${v.modifier}" maxlength="20" placeholder="${ahcccs ? "e.g. GT HO" : "e.g. 95"}"><span class="hint">Up to ${MAX_MODIFIERS}, separated by spaces. ${ahcccs ? "GT audio-video · FQ audio-only · HQ group · HR/HS family · HM/HN/HO/HP education" : "95 = telehealth"}</span> ${fieldError(errors, "modifier")}</label>
        <label>Place of service ${select("pos", [{ value: "", label: ahcccs ? "Choose (member's location)" : "Not specified" }, ...POS_OPTIONS], v.pos)} ${fieldError(errors, "pos")}</label>
        <label>Minutes <input type="number" name="minutes" min="0" max="1440" value="${v.minutes}"><span class="hint">Documented face-to-face minutes. Per-15-minute codes: 8–22 = 1 unit, 23–37 = 2, 38–52 = 3, 53–67 = 4.</span> ${fieldError(errors, "minutes")}</label>
        <label>Units <input type="number" name="units" min="1" max="96" value="${v.units}"><span class="hint">Calculated from minutes for per-15-minute codes when left blank.</span> ${fieldError(errors, "units")}</label>
        <label>Fee ($) <input name="fee" value="${v.fee}" inputmode="decimal" placeholder="Fee schedule × units"><span class="hint">Leave blank to use the fee schedule.</span> ${fieldError(errors, "fee")}</label>
        <label>Rendering provider ${select("rendering_provider_id", [{ value: "", label: "Choose a provider" }, ...provs.map((p) => ({ value: p.id, label: `${p.name}${p.credentials ? `, ${p.credentials}` : ""}${p.npi ? ` · NPI ${p.npi}` : ""}` }))], v.rendering_provider_id, "required")} ${fieldError(errors, "rendering_provider_id")}</label>
        <label>Supporting note ${select("note_id", [{ value: "", label: notes.length ? "None linked" : "No notes for this visit" }, ...notes.map((n) => ({ value: n.id, label: noteLabel(n) }))], v.note_id)}${ahcccs ? html`<span class="hint">Required (and signed) before an AHCCCS charge can be billed.</span>` : ""} ${fieldError(errors, "note_id")}</label>
        <label>Bill to ${select("bill_to", [{ value: "insurance", label: "Insurance" }, { value: "patient", label: "Patient (self-pay)" }], v.bill_to)}</label>
      </div>
      <fieldset style="margin-top:1rem">
        <legend>Diagnosis codes</legend>
        ${dx.length ? dx.map((d) => html`
          <label class="check"><input type="checkbox" name="dx" value="${d.icd10_code}" ${dxDefault || selectedDx.has(d.icd10_code) ? raw("checked") : ""}>
            ${d.icd10_code} · ${d.description}${d.is_primary ? html` <span class="pill">Primary</span>` : ""}</label>`)
          : html`<p class="muted small">No active diagnoses on the problem list.</p>`}
        <label style="margin-top:.5rem">Other ICD-10 codes <input name="dx_other" value="${v.dx_other}" placeholder="e.g. F41.1, Z63.0"><span class="hint">Comma-separated. Used in addition to the codes checked above.</span> ${fieldError(errors, "dx")}</label>
      </fieldset>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Create charge</button></div>
    </form>`, { title: "New charge" }));
}

function loadAppt(db, patient, rawId) {
  if (rawId === undefined || rawId === null || rawId === "") return { appt: null };
  const id = toInt(rawId);
  const appt = id ? db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) : null;
  if (!appt || appt.patient_id !== patient.id) return { error: "That appointment does not belong to this patient." };
  return { appt };
}

router.get("/patients/:id/charges/new", write, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { appt, error } = loadAppt(req.db, patient, req.query.appointment_id);
  if (error) return chargeForm(req, res, patient, { errors: { appointment_id: error }, status: 400 });
  audit(req, "view", "charge", null, patient.id, "new charge form");
  chargeForm(req, res, patient, { appt });
});

router.post("/patients/:id/charges", write, (req, res) => {
  const db = req.db;
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body;
  const dxChecked = [].concat(b.dx || []).map((x) => str(x, 10).toUpperCase()).filter(Boolean);
  const values = {
    date_of_service: str(b.date_of_service, 10), cpt_code: str(b.cpt_code, 10).toUpperCase(), modifier: str(b.modifier, 40).toUpperCase(),
    units: str(b.units, 4), fee: str(b.fee, 20), rendering_provider_id: str(b.rendering_provider_id, 10),
    bill_to: str(b.bill_to, 10), dx: dxChecked, dx_other: str(b.dx_other, 200),
    pos: str(b.pos, 2), minutes: str(b.minutes, 5), note_id: str(b.note_id, 12),
  };
  const errors = {};
  const { appt, error: apptError } = loadAppt(db, patient, b.appointment_id);
  if (apptError) errors.appointment_id = apptError;
  if (appt) values.appointment_id = appt.id;
  const ahcccs = isAhcccs(db, patient.id);

  if (!validDate(values.date_of_service)) errors.date_of_service = "Enter a valid date of service.";
  else if (values.date_of_service > today()) errors.date_of_service = "Date of service cannot be in the future.";
  const fee = CPT_RE.test(values.cpt_code) ? feeFor(db, values.cpt_code) : null;
  if (!fee) errors.cpt_code = "Choose a CPT/HCPCS code from the active fee schedule.";
  const modifiers = [...new Set(parseModifiers(values.modifier))];
  if (modifiers.some((m) => !MODIFIER_RE.test(m))) errors.modifier = "Each modifier must be 2 letters or digits.";
  else if (modifiers.length > MAX_MODIFIERS) errors.modifier = `A charge can have at most ${MAX_MODIFIERS} modifiers.`;
  if (values.pos && !POS_CODES.includes(values.pos)) errors.pos = "Choose a place of service from the list.";
  let minutes = null;
  if (values.minutes !== "") {
    minutes = /^\d+$/.test(values.minutes) ? Number(values.minutes) : NaN;
    if (!(minutes >= 0 && minutes <= 1440)) { errors.minutes = "Minutes must be a whole number between 0 and 1440."; minutes = null; }
  }
  const timed = TIMED_15.has(values.cpt_code);
  let units = values.units === "" && timed ? null : toInt(values.units);
  if (units !== null && (!units || units < 1 || units > (timed ? 96 : 10))) errors.units = `Units must be between 1 and ${timed ? 96 : 10}.`;
  const provId = toInt(values.rendering_provider_id);
  const prov = provId ? db.prepare("SELECT id, name, credentials, education_level FROM users WHERE id = ? AND active = 1 AND role = 'clinician'").get(provId) : null;
  if (!prov) errors.rendering_provider_id = "Choose a rendering provider.";
  if (!["insurance", "patient"].includes(values.bill_to)) values.bill_to = "insurance";
  let note = null;
  if (values.note_id) {
    const nid = toInt(values.note_id);
    note = nid ? db.prepare("SELECT * FROM notes WHERE id = ? AND patient_id = ?").get(nid, patient.id) : null;
    if (!note) errors.note_id = "Choose a note that belongs to this patient.";
    else if (appt && note.appointment_id && note.appointment_id !== appt.id) errors.note_id = "That note documents a different appointment.";
  }

  // Time-based units and AHCCCS modifier / POS rules.
  const rules = checkChargeRules({ ahcccs, cpt: values.cpt_code, modifiers, pos: values.pos, minutes, units, note, appt, provider: prov });
  for (const [k, msg] of Object.entries(rules.errors)) if (!errors[k]) errors[k] = msg;
  if (!errors.units && !errors.minutes) units = rules.units;
  if (units === null && !errors.units && !errors.minutes) errors.units = "Units are required.";

  let feeCents = null;
  if (values.fee) {
    feeCents = parseMoney(values.fee);
    if (feeCents === null || feeCents < 0 || feeCents > 10000000) errors.fee = "Enter a valid fee, or leave blank to use the fee schedule.";
  } else if (fee && units) feeCents = fee.fee_cents * units;

  // Diagnosis codes: checked active diagnoses in problem-list order (primary first), then free text.
  const dxOrder = activeDiagnoses(db, patient.id).map((d) => d.icd10_code.toUpperCase());
  const checked = dxOrder.filter((c) => dxChecked.includes(c));
  const extra = values.dx_other.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const badDx = [...dxChecked.filter((c) => !dxOrder.includes(c)), ...extra.filter((c) => !ICD_RE.test(c))];
  if (badDx.length) errors.dx = `Not a valid ICD-10 code: ${badDx.join(", ")}`;
  const codes = [...new Set([...checked, ...extra])];
  if (!badDx.length && !codes.length) errors.dx = "Add at least one diagnosis code.";
  else if (codes.length > 12) errors.dx = "A charge can have at most 12 diagnosis codes.";

  if (Object.keys(errors).length) return chargeForm(req, res, patient, { values, errors, appt, warnings: rules.warnings, status: 400 });

  tx(db, () => {
    const r = db.prepare(
      `INSERT INTO charges (patient_id, appointment_id, date_of_service, cpt_code, modifier, units, fee_cents, diagnosis_codes,
        rendering_provider_id, bill_to, status, created_by, pos, minutes, note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unbilled', ?, ?, ?, ?)`)
      .run(patient.id, appt ? appt.id : null, values.date_of_service, values.cpt_code, modifiers.length ? modifiers.join(" ") : null, units, feeCents,
        codes.join(","), prov.id, values.bill_to, req.user.id, values.pos || null, minutes, note ? note.id : null);
    audit(req, "create", "charge", Number(r.lastInsertRowid), patient.id, appt ? "from appointment" : "manual");
  });
  req.flash("success", `Charge created for ${money(feeCents)}.`);
  rules.warnings.forEach((w) => req.flash("warn", w));
  res.redirect(`/ehr/patients/${patient.id}/billing`);
});

router.post("/charges/:chargeId/status", write, (req, res) => {
  const db = req.db;
  const id = toInt(req.params.chargeId);
  const charge = id ? db.prepare("SELECT * FROM charges WHERE id = ?").get(id) : null;
  if (!charge) return notFound(req, res, "Charge");
  const back = typeof req.body.back === "string" && /^\/ehr\/(billing|patients\/\d+\/billing)(\?[\w=&%.-]*)?$/.test(req.body.back)
    ? req.body.back : `/ehr/patients/${charge.patient_id}/billing`;
  const to = String(req.body.status || "");
  const bad = (msg) => res.status(400).send(page(req, {
    title: "Charge not updated", active: "billing",
    body: html`<div class="card"><h1>Charge not updated</h1>${Array.isArray(msg) ? html`<ul class="list">${msg.map((m) => html`<li>${m}</li>`)}</ul>` : html`<p>${msg}</p>`}<p><a href="${back}">Go back</a></p></div>`,
  }));
  if (charge.status === "void") return bad("Voided charges cannot be changed.");
  if (!(TRANSITIONS[charge.status] || []).includes(to)) return bad(`A ${charge.status} charge cannot be marked ${humanize(to).toLowerCase() || "that status"}.`);
  if (to === "void" && req.body.confirm !== "yes") return bad("Voiding a charge requires confirmation.");
  if (to === "billed" && isAhcccs(db, charge.patient_id)) {
    const patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(charge.patient_id);
    const errs = ahcccsBillErrors(db, charge, patient);
    if (errs.length) {
      audit(req, "bill_blocked", "charge", charge.id, charge.patient_id, `AHCCCS checks failed: ${errs.length}`);
      return bad(errs);
    }
  }
  const r = db.prepare("UPDATE charges SET status = ? WHERE id = ? AND status = ?").run(to, charge.id, charge.status);
  if (r.changes !== 1) return bad("The charge changed while you were working. Reload and try again.");
  audit(req, to === "void" ? "void" : "update", "charge", charge.id, charge.patient_id, `status ${charge.status} -> ${to}`);
  req.flash("success", `Charge ${to === "void" ? "voided" : `marked ${to}`}.`);
  res.redirect(back);
});

/* ---------------- superbill ---------------- */
router.get("/patients/:id/superbill", read, (req, res) => {
  const db = req.db;
  const PRACTICE = practice(db);
  const patient = loadPatient(req, res);
  if (!patient) return;
  let from = validDate(req.query.from) ? req.query.from : addDays(today(), -30);
  let to = validDate(req.query.to) ? req.query.to : today();
  if (from > to) [from, to] = [to, from];

  const services = db.prepare(
    `SELECT c.*, f.description, u.name AS provider_name, u.credentials AS provider_credentials, u.npi AS provider_npi
     FROM charges c LEFT JOIN fee_schedule f ON f.cpt_code = c.cpt_code LEFT JOIN users u ON u.id = c.rendering_provider_id
     WHERE c.patient_id = ? AND c.status != 'void' AND c.date_of_service BETWEEN ? AND ?
     ORDER BY c.date_of_service, c.id`).all(patient.id, from, to);
  const payments = db.prepare("SELECT * FROM payments WHERE patient_id = ? AND received_on BETWEEN ? AND ? ORDER BY received_on, id").all(patient.id, from, to);
  const policies = insurance(db, patient.id);
  const ahcccs = isAhcccs(db, patient.id);
  const dxDesc = new Map(db.prepare("SELECT icd10_code, description FROM diagnoses WHERE patient_id = ?").all(patient.id).map((d) => [d.icd10_code.toUpperCase(), d.description]));
  const allDx = [...new Set(services.flatMap((s) => String(s.diagnosis_codes || "").split(",").map((x) => x.trim()).filter(Boolean)))];
  const totalCharges = services.reduce((a, s) => a + s.fee_cents, 0);
  const totalPaid = payments.reduce((a, p) => a + p.amount_cents, 0);

  audit(req, "view", "superbill", null, patient.id, `period ${from} to ${to}`);
  const addr = [patient.address_line1, patient.address_line2].filter(Boolean).join(", ");
  const cityLine = [patient.city, [patient.state, patient.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  res.send(page(req, {
    title: "Superbill",
    active: "billing",
    body: html`
      <div class="page-head no-print">
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/billing">Back to billing</a>
        <form method="get" action="/ehr/patients/${patient.id}/superbill" class="row">
          <label>From <input type="date" name="from" value="${from}"></label>
          <label>To <input type="date" name="to" value="${to}"></label>
          <button class="btn" type="submit">Update</button>
          <button class="btn btn--primary" type="button" data-print>Print superbill</button>
        </form>
      </div>
      <article class="card superbill">
        <header class="row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1 style="margin:0">${PRACTICE.name}</h1>${PRACTICE.ready ? "" : html`<p class="alert alert--warn no-print">Add the clinic's address, NPI and tax ID under <a href="/ehr/admin/clinic">Administration → Clinic settings</a> before giving superbills to clients.</p>`}
            <p class="small" style="margin:.25rem 0 0">${PRACTICE.address}<br>Phone ${PRACTICE.phone}<br>Group NPI ${PRACTICE.npi} · Tax ID ${PRACTICE.taxId}</p>
          </div>
          <div style="text-align:right">
            <h2 style="margin:0">Superbill</h2>
            <p class="small" style="margin:.25rem 0 0">Statement of services<br>${fmtDate(from)} – ${fmtDate(to)}<br>Issued ${fmtDate(today())}</p>
          </div>
        </header>
        <hr>
        <div class="grid grid--2">
          <section>
            <h3>Patient</h3>
            <p class="small">
              <strong>${patient.first_name} ${patient.last_name}</strong><br>
              DOB ${fmtDate(patient.dob)} · MRN ${patient.mrn}${patient.gender ? ` · Gender ${patient.gender}` : ""}<br>
              ${patient.ahcccs_id ? html`AHCCCS ID ${patient.ahcccs_id}<br>` : ""}
              ${addr ? html`${addr}<br>` : ""}${cityLine ? html`${cityLine}<br>` : ""}
              ${patient.phone ? html`Phone ${patient.phone}` : ""}
            </p>
          </section>
          <section>
            <h3>Insurance</h3>
            ${policies.length ? policies.map((p) => html`<p class="small"><strong>${humanize(p.priority)}:</strong> ${p.payer_name}<br>
              Member ID ${p.member_id || "—"}${p.group_number ? ` · Group ${p.group_number}` : ""}<br>
              Subscriber ${p.subscriber_name || "—"}${p.subscriber_relation ? ` (${p.subscriber_relation})` : ""}</p>`)
              : html`<p class="small">No insurance on file (self-pay).</p>`}
          </section>
        </div>
        ${allDx.length ? html`
          <section>
            <h3>Diagnoses (ICD-10)</h3>
            <ol class="small">${allDx.map((c) => html`<li>${c}${dxDesc.get(c.toUpperCase()) ? ` · ${dxDesc.get(c.toUpperCase())}` : ""}</li>`)}</ol>
          </section>` : ""}
        <section>
          <h3>Services</h3>
          ${services.length ? html`
            <div class="table-wrap"><table class="table">
              <thead><tr><th>DOS</th><th>POS</th><th>Code</th><th>Modifiers</th><th>Description</th><th>ICD-10</th><th class="num">Minutes</th><th class="num">Units</th><th class="num">Fee</th><th>Rendering provider</th></tr></thead>
              <tbody>${services.map((s) => html`
                <tr>
                  <td>${s.date_of_service}</td>
                  <td>${s.pos || ""}</td>
                  <td>${s.cpt_code}</td>
                  <td>${parseModifiers(s.modifier).join(" ")}</td>
                  <td>${s.description || ""}</td>
                  <td>${String(s.diagnosis_codes || "").split(",").join(", ")}</td>
                  <td class="num">${s.minutes != null ? s.minutes : ""}</td>
                  <td class="num">${s.units}</td>
                  <td class="num">${money(s.fee_cents)}</td>
                  <td>${providerName(s)}${s.provider_npi ? html`<br><span class="small">NPI ${s.provider_npi}</span>` : ""}
                    ${ahcccs && isNonIndependent(s.provider_credentials) ? html`<br><span class="small"><strong>${FACILITY_NOTE}.</strong></span>` : ""}</td>
                </tr>`)}</tbody>
              <tfoot><tr><td colspan="8">Total charges</td><td class="num">${money(totalCharges)}</td><td></td></tr></tfoot>
            </table></div>` : html`<p class="muted">No services in this period.</p>`}
        </section>
        <section>
          <h3>Payments received</h3>
          ${payments.length ? html`
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead>
              <tbody>${payments.map((p) => html`<tr><td>${p.received_on}</td><td>${METHOD_LABEL[p.method] || p.method}</td><td>${p.reference || ""}</td><td class="num">${money(p.amount_cents)}</td></tr>`)}</tbody>
              <tfoot><tr><td colspan="3">Total payments</td><td class="num">${money(totalPaid)}</td></tr></tfoot>
            </table></div>` : html`<p class="muted small">No payments received in this period.</p>`}
          <p><strong>Balance for period: ${money(totalCharges - totalPaid)}</strong></p>
        </section>
        ${ahcccs ? html`<p class="small">AHCCCS: POS is the member's location. Services by associate-level, BHT or BHPP staff are billed under the facility NPI with the rendering individual named in Box 19 (loop 2300 NTE); no incident-to billing.</p>` : ""}
        <p class="small muted">Provided for the patient to submit to their insurance for possible reimbursement. Payment status with the payer is not guaranteed.</p>
        <p class="small" style="margin-top:2rem">Provider signature: ____________________________ Date: ____________</p>
      </article>`,
  }));
});

module.exports = {
  router, TIMED_15, POS_OPTIONS, suggestModifiers, checkChargeRules, ahcccsBillErrors, parseModifiers, isNonIndependent,
  telehealthModality, noteServiceType, minutesFor,
};
