"use strict";
/*
 * Prescriptions. A prescriber writes and signs (password re-entry), then the prescription is printed for a hand
 * signature, faxed, phoned in, or recorded as entered in the clinic's outside e-prescribing system.
 *
 *   GET  /patients/:id/prescriptions                 chart tab: active and past prescriptions, write form
 *                                                    (?template=key prefills a common prescription, ?renew=rid copies one)
 *   POST /patients/:id/prescriptions                 sign a new prescription
 *   GET  /prescriptions/:rid/print                   printable prescription (first print = original; reprints say COPY)
 *   POST /prescriptions/:rid/discontinue             stop it (also ends it on the medication list)
 *   POST /prescriptions/:rid/void                    entered in error / never sent
 *   GET  /prescriptions                              prescription log (mine, or everyone's for admins), controlled filter, CSV
 *   POST /admin/users/:id/prescriber                 administrator: who may prescribe, DEA number, state license
 *
 * Federal rules built in (21 CFR 1306): Schedule II has no refills; Schedule III-IV at most 5 refills and the
 * prescription expires 6 months after it was written; controlled prescriptions need the prescriber's DEA number and
 * a manual signature on paper. Electronic transmission of controlled substances needs a DEA-certified EPCS service,
 * which this app is not, so for those choose "print", "fax" (manually signed, Schedule III-V) or "external".
 * State rules may be stricter; the clinic is responsible for them.
 */
const express = require("express");
const { forbidden, verifyPassword } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, raw, page, chartPage, notFound, csrfField, select, getPatient, patientName, today, addDays, fmtDate, fmtTimestamp, humanize } = require("../views");
const { getClinic } = require("../clinic");

const router = express.Router();

const SCHEDULES = [{ value: "", label: "Not controlled" }, { value: "II", label: "Schedule II" }, { value: "III", label: "Schedule III" }, { value: "IV", label: "Schedule IV" }, { value: "V", label: "Schedule V" }];
const MAX_REFILLS = { "": 11, II: 0, III: 5, IV: 5, V: 5 };
const UNITS = ["mL", "tablets", "capsules", "grams", "pumps", "patches", "pellets", "syringes", "needles", "vials", "units", "each"];
const DELIVERY = [
  { value: "print", label: "Print and sign by hand" },
  { value: "fax", label: "Fax to the pharmacy (print, sign, fax)" },
  { value: "phone", label: "Phoned in to the pharmacy" },
  { value: "external", label: "Entered in our e-prescribing system" },
];
const DELIVERY_LABEL = Object.fromEntries(DELIVERY.map((d) => [d.value, d.label]));

/* Common prescriptions to start from. The prescriber reviews and edits every field before signing. */
const TEMPLATES = [
  { key: "cypionate", group: "Testosterone (TRT)", label: "Testosterone cypionate 200 mg/mL, 10 mL vial", drug: "Testosterone cypionate", strength: "200 mg/mL", dosage_form: "Injectable solution (10 mL multi-dose vial)", route: "Intramuscular", sig: "Inject 0.5 mL (100 mg) into the muscle once weekly.", quantity: 10, quantity_unit: "mL", days_supply: 140, refills: 1, schedule: "III", diagnosis: "E29.1" },
  { key: "enanthate", group: "Testosterone (TRT)", label: "Testosterone enanthate 200 mg/mL, 5 mL vial", drug: "Testosterone enanthate", strength: "200 mg/mL", dosage_form: "Injectable solution (5 mL multi-dose vial)", route: "Intramuscular", sig: "Inject 0.5 mL (100 mg) into the muscle once weekly.", quantity: 5, quantity_unit: "mL", days_supply: 70, refills: 1, schedule: "III", diagnosis: "E29.1" },
  { key: "gel", group: "Testosterone (TRT)", label: "Testosterone 1.62% gel, pump", drug: "Testosterone gel", strength: "1.62% (20.25 mg per pump)", dosage_form: "Topical gel, metered pump", route: "Topical", sig: "Apply 4 pumps (81 mg) to the shoulders and upper arms once daily in the morning. Wash hands after.", quantity: 150, quantity_unit: "grams", days_supply: 60, refills: 2, schedule: "III", diagnosis: "E29.1" },
  { key: "syringes", group: "Injection supplies", label: "Syringes 3 mL with 23G × 1 in needle", drug: "Syringe with needle", strength: "3 mL, 23G × 1 in", dosage_form: "Supply", route: "", sig: "Use one syringe per injection as directed.", quantity: 12, quantity_unit: "syringes", days_supply: 84, refills: 3, schedule: "", diagnosis: "" },
  { key: "drawing", group: "Injection supplies", label: "Drawing needles 18G × 1.5 in", drug: "Needle (drawing)", strength: "18G × 1.5 in", dosage_form: "Supply", route: "", sig: "Use one needle to draw up each dose.", quantity: 12, quantity_unit: "needles", days_supply: 84, refills: 3, schedule: "", diagnosis: "" },
];
const TEMPLATE = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const str = (v, n = 500) => String(v ?? "").trim().slice(0, n);
const fmtQty = (n) => String(Math.round(n * 100) / 100);
const ICD_RE = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;

/**
 * Credentials that carry prescriptive authority: MD, DO, PA/PA-C, APRN, and nurse practitioners (PMHNP, FNP, AGNP,
 * ANP, NP, CNP ...). A user with one of these can prescribe without an administrator switching it on.
 */
function prescribingCredential(credentials) {
  return String(credentials || "").toUpperCase().split(/[\s,;/()]+/).filter(Boolean)
    .some((t) => /^(MD|DO|PA|PA-C|APRN(-[A-Z]+)?|CNP|[A-Z]{0,5}NP(-[A-Z]{1,3})?)$/.test(t));
}

/** Turn prescribing on for a clinician/admin whose credentials allow it. Returns true if it changed. */
function autoEnablePrescriber(db, userId) {
  const u = db.prepare("SELECT role, credentials, can_prescribe FROM users WHERE id = ?").get(userId);
  if (!u || u.can_prescribe || !["admin", "clinician"].includes(u.role) || !prescribingCredential(u.credentials)) return false;
  db.prepare("UPDATE users SET can_prescribe = 1 WHERE id = ?").run(userId);
  return true;
}

/** DEA registration number: 2 letters + 7 digits, last digit is a checksum. */
function deaValid(dea) {
  const m = /^([ABCDEFGHJKLMPRSTUX])([A-Z9])(\d{7})$/.exec(String(dea || "").toUpperCase());
  if (!m) return false;
  const d = m[3].split("").map(Number);
  return (d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5])) % 10 === d[6];
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** Quantity in words, written next to the number on a paper prescription so it can't be altered. */
function toWords(n) {
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 100);
  const w = (x) => {
    if (x < 20) return ONES[x];
    if (x < 100) return TENS[Math.floor(x / 10)] + (x % 10 ? `-${ONES[x % 10]}` : "");
    if (x < 1000) return `${ONES[Math.floor(x / 100)]} hundred${x % 100 ? ` ${w(x % 100)}` : ""}`;
    return `${w(Math.floor(x / 1000))} thousand${x % 1000 ? ` ${w(x % 1000)}` : ""}`;
  };
  if (whole > 999999) return String(n);
  return frac ? `${w(whole)} and ${frac}/100` : w(whole);
}

/** When the prescription can no longer be filled: CIII-V 6 months after written, CII and others per state (1 year shown). */
const expiresOn = (rx) => addDays(rx.written_on, ["III", "IV", "V"].includes(rx.schedule) ? 182 : rx.schedule === "II" ? 90 : 365);

function prescriberProblems(u, schedule) {
  const out = [];
  if (!u || !u.can_prescribe) out.push("You aren't set up to prescribe. An administrator turns this on under Administration → Users.");
  if (u && !u.npi) out.push("Your profile needs an NPI before you can prescribe.");
  if (u && schedule) {
    if (!u.dea_number) out.push("Controlled substances need a DEA number on your profile.");
    else if (u.dea_expires && u.dea_expires < today()) out.push(`Your DEA registration expired ${fmtDate(u.dea_expires)}.`);
  }
  return out;
}
const prescriberRow = (db, id) => db.prepare("SELECT id, name, credentials, npi, role, active, can_prescribe, dea_number, dea_expires, license_number, license_state FROM users WHERE id = ?").get(id);
const canWriteRx = (db, user) => can(user, "clinical:write") && !!(prescriberRow(db, user.id) || {}).can_prescribe;

const gate = (fn) => (req, res, next) => (fn(req.user) ? next() : forbidden(req, res));
const errText = (e, k) => (e && e[k] ? html`<span class="error-text">${e[k]}</span>` : "");
function errorSummary(e) {
  const list = Object.values(e || {});
  return list.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong><ul class="list">${list.map((x) => html`<li>${x}</li>`)}</ul></div>` : "";
}
const scheduleBadge = (s) => (s ? html`<span class="badge badge--warn" title="Controlled substance">C-${s}</span>` : "");
const rxTitle = (r) => `${r.drug}${r.strength ? ` ${r.strength}` : ""}`;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const FIELDS = ["drug", "strength", "dosage_form", "route", "sig", "quantity", "quantity_unit", "days_supply", "refills", "schedule", "diagnosis", "pharmacy", "pharmacy_phone", "pharmacy_note", "delivery", "written_on"];

function readRx(b, db, patient, user) {
  const v = {};
  for (const k of FIELDS) v[k] = str(b[k], k === "sig" || k === "pharmacy_note" ? 1000 : 160);
  v.daw = b.daw === "1" ? 1 : 0;
  v.pdmp_checked = b.pdmp_checked === "1" ? 1 : 0;
  v.allow_duplicate = b.allow_duplicate === "1" ? 1 : 0;
  v.allergy_override = b.allergy_override === "1" ? 1 : 0;
  v.renewed_from = /^\d+$/.test(String(b.renewed_from || "")) ? Number(b.renewed_from) : null;
  v.diagnosis = v.diagnosis.toUpperCase();
  const e = {};
  if (!v.drug) e.drug = "Enter the medication or supply.";
  if (!v.sig) e.sig = "Enter the directions (sig).";
  if (!/^\d+(\.\d{1,2})?$/.test(v.quantity) || Number(v.quantity) <= 0 || Number(v.quantity) > 99999) e.quantity = "Enter the quantity as a number.";
  if (!UNITS.includes(v.quantity_unit)) e.quantity_unit = "Choose the unit.";
  if (v.days_supply && (!/^\d{1,3}$/.test(v.days_supply) || Number(v.days_supply) < 1 || Number(v.days_supply) > 365)) e.days_supply = "Days supply is 1 to 365.";
  if (!SCHEDULES.some((s) => s.value === v.schedule)) e.schedule = "Choose the schedule.";
  if (!/^\d{1,2}$/.test(v.refills || "0")) e.refills = "Refills must be a whole number.";
  else if (!e.schedule && Number(v.refills || 0) > MAX_REFILLS[v.schedule]) e.refills = v.schedule === "II" ? "Schedule II prescriptions can't have refills." : `At most ${MAX_REFILLS[v.schedule]} refills${v.schedule ? ` for Schedule ${v.schedule}` : ""}.`;
  if (v.diagnosis && !ICD_RE.test(v.diagnosis)) e.diagnosis = "Enter an ICD-10 code like E29.1.";
  if (!DELIVERY_LABEL[v.delivery]) e.delivery = "Choose how the prescription gets to the pharmacy.";
  else if (v.schedule === "II" && v.delivery === "fax") e.delivery = "Schedule II prescriptions can't be faxed (except in narrow hospice/LTC cases). Print it for the client.";
  else if (v.schedule === "II" && v.delivery === "phone") e.delivery = "Schedule II prescriptions can't be phoned in except in an emergency. Print it.";
  if (["fax", "phone"].includes(v.delivery) && !v.pharmacy) e.pharmacy = "Enter the pharmacy.";
  if (!isDate(v.written_on)) e.written_on = "Enter the date written.";
  else if (v.written_on !== today()) e.written_on = "Prescriptions are dated the day they are signed.";
  if (v.schedule && !v.pdmp_checked) e.pdmp_checked = "Confirm you checked the state prescription monitoring program (PDMP).";
  for (const p of prescriberProblems(prescriberRow(db, user.id), v.schedule)) e[`prescriber_${Object.keys(e).length}`] = p;
  if (!e.drug) {
    const dup = db.prepare("SELECT id, written_on FROM prescriptions WHERE patient_id = ? AND status = 'active' AND lower(drug) = lower(?)").get(patient.id, v.drug);
    const renewing = v.renewed_from && dup && dup.id === v.renewed_from;
    if (dup && !renewing && !v.allow_duplicate) e.allow_duplicate = `There's already an active ${v.drug} prescription from ${fmtDate(dup.written_on)}. Discontinue it, or tick "Keep both active".`;
    const words = v.drug.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
    const hit = db.prepare("SELECT substance FROM allergies WHERE patient_id = ?").all(patient.id)
      .find((a) => { const s = String(a.substance).toLowerCase(); return words.some((w) => s.includes(w)) || (s.length > 3 && v.drug.toLowerCase().includes(s)); });
    if (hit && !v.allergy_override) e.allergy_override = `Allergy on file: ${hit.substance}. Tick "Prescribe anyway" if you've reviewed it.`;
  }
  return { v, e };
}

/* ------------------------------------------------------------------ */
/* Chart tab                                                           */
/* ------------------------------------------------------------------ */

function loadPatient(req, res) {
  const p = getPatient(req, req.params.id);
  if (!p) notFound(req, res, "Patient");
  return p;
}

function rxRowsFor(db, pid) {
  return db.prepare(`SELECT r.*, u.name AS prescriber_name, u.credentials AS prescriber_cred FROM prescriptions r JOIN users u ON u.id = r.prescriber_id
    WHERE r.patient_id = ? ORDER BY r.status = 'active' DESC, r.written_on DESC, r.id DESC`).all(pid);
}

function rxTab(req, res, patient, { v = null, e = {} } = {}, status = 200) {
  const db = req.db;
  const u = req.user;
  const base = `/ehr/patients/${patient.id}`;
  const rows = rxRowsFor(db, patient.id);
  const me = prescriberRow(db, u.id);
  const writer = canWriteRx(db, u);
  const t = today();
  audit(req, "view", "prescription", null, patient.id, "list");
  const trtOn = require("./trt").trtEnabled(db);
  if (!v) {
    const tpl = TEMPLATE[String(req.query.template || "")];
    const renew = /^\d+$/.test(String(req.query.renew || "")) ? db.prepare("SELECT * FROM prescriptions WHERE id = ? AND patient_id = ?").get(Number(req.query.renew), patient.id) : null;
    const lastPharm = db.prepare("SELECT pharmacy, pharmacy_phone FROM prescriptions WHERE patient_id = ? AND pharmacy IS NOT NULL ORDER BY id DESC LIMIT 1").get(patient.id) || {};
    const src = renew || tpl || {};
    v = { quantity_unit: "tablets", refills: "0", schedule: "", delivery: "print", ...lastPharm };
    for (const k of FIELDS) if (src[k] != null && src[k] !== "") v[k] = String(src[k]);
    v.daw = renew ? renew.daw : 0;
    v.renewed_from = renew ? renew.id : null;
    v.written_on = t;
    v.open = !!(tpl || renew);
  }
  const active = rows.filter((r) => r.status === "active");
  const past = rows.filter((r) => r.status !== "active");
  const allergies = db.prepare("SELECT substance FROM allergies WHERE patient_id = ?").all(patient.id);
  const problems = writer ? prescriberProblems(me, v.schedule) : [];

  const table = (list) => html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Medication</th><th>Directions</th><th class="num">Qty</th><th>Refills</th><th>Written</th><th>Prescriber</th><th></th></tr></thead>
    <tbody>${list.map((r) => {
      const exp = expiresOn(r);
      return html`<tr class="${r.status === "voided" ? "is-voided" : ""}">
        <td><strong>${rxTitle(r)}</strong> ${scheduleBadge(r.schedule)}${r.dosage_form ? html`<br><span class="small muted">${r.dosage_form}</span>` : ""}
          ${r.status !== "active" ? html`<br><span class="badge badge--neutral" title="${r.end_reason || ""}">${humanize(r.status)}${r.ended_at ? ` ${fmtDate(r.ended_at.slice(0, 10))}` : ""}</span>` : exp < t ? html`<br><span class="badge badge--warn">Expired ${fmtDate(exp)}</span>` : ""}</td>
        <td class="small">${r.sig}</td>
        <td class="num">${fmtQty(r.quantity)} ${r.quantity_unit}${r.days_supply ? html`<br><span class="small muted">${r.days_supply} days</span>` : ""}</td>
        <td>${r.refills}</td>
        <td>${fmtDate(r.written_on)}<br><span class="small muted">${DELIVERY_LABEL[r.delivery]}</span></td>
        <td class="small">${r.prescriber_name}${r.prescriber_cred ? `, ${r.prescriber_cred}` : ""}</td>
        <td class="rx-actions">
          ${r.status !== "voided" && ["print", "fax"].includes(r.delivery) ? html`<a class="btn btn--sm" href="/ehr/prescriptions/${r.id}/print">${r.prints ? "Reprint (copy)" : "Print"}</a>` : ""}
          ${writer ? html`<a class="btn btn--sm btn--ghost" href="${base}/prescriptions?renew=${r.id}#write">Renew</a>` : ""}
          ${writer && r.status === "active" ? html`
            <details class="loc-edit"><summary class="small">Stop</summary>
              <form method="post" action="/ehr/prescriptions/${r.id}/discontinue" class="stack">${csrfField(req)}
                <label>Reason <input type="text" name="reason" maxlength="300" required placeholder="e.g. dose changed; therapy stopped"></label>
                <button class="btn btn--sm" type="submit">Discontinue</button></form>
              <form method="post" action="/ehr/prescriptions/${r.id}/void" class="stack">${csrfField(req)}
                <label>Or void (entered in error, never sent) <input type="text" name="reason" maxlength="300" required placeholder="Why"></label>
                <button class="btn btn--sm btn--ghost" type="submit">Void</button></form>
            </details>` : ""}
        </td></tr>`;
    })}</tbody></table></div>`;

  const groups = [...new Set(TEMPLATES.filter((x) => trtOn || x.group !== "Testosterone (TRT)").map((x) => x.group))];
  const form = writer ? html`
    <section class="card" id="write" aria-labelledby="rx-new">
      <div class="card__head"><h2 id="rx-new">${v.renewed_from ? "Renew prescription" : "Write a prescription"}</h2></div>
      ${groups.length ? html`<p class="small">Start from: ${groups.map((g) => html`<span class="muted">${g}:</span> ${TEMPLATES.filter((x) => x.group === g).map((x) => html`<a class="chip" href="${base}/prescriptions?template=${x.key}#write">${x.label}</a> `)}`)}</p>` : ""}
      ${problems.length ? html`<div class="alert alert--warn" role="note">${problems.map((p) => html`<div>${p}</div>`)}</div>` : ""}
      ${allergies.length ? html`<p class="pill pill--bad">Allergies: ${allergies.map((a) => a.substance).join(", ")}</p>` : ""}
      <form method="post" action="${base}/prescriptions" class="stack" novalidate>
        ${csrfField(req)}${errorSummary(e)}
        ${v.renewed_from ? html`<input type="hidden" name="renewed_from" value="${v.renewed_from}">` : ""}
        <div class="form-grid">
          <label class="span-all">Medication or supply<input type="text" name="drug" maxlength="160" value="${v.drug || ""}" required placeholder="e.g. Testosterone cypionate">${errText(e, "drug")}</label>
          <label>Strength<input type="text" name="strength" maxlength="160" value="${v.strength || ""}" placeholder="200 mg/mL"></label>
          <label>Form<input type="text" name="dosage_form" maxlength="160" value="${v.dosage_form || ""}" placeholder="Injectable solution, 10 mL vial"></label>
          <label>Route<input type="text" name="route" maxlength="160" value="${v.route || ""}" placeholder="Intramuscular"></label>
          <label>Schedule ${select("schedule", SCHEDULES, v.schedule)}${errText(e, "schedule")}</label>
          <label class="span-all">Directions (sig)<textarea name="sig" rows="2" maxlength="1000" required>${v.sig || ""}</textarea>${errText(e, "sig")}</label>
          <label>Quantity<input type="number" step="any" min="0" name="quantity" value="${v.quantity || ""}" inputmode="decimal" required>${errText(e, "quantity")}</label>
          <label>Unit ${select("quantity_unit", UNITS.map((x) => ({ value: x, label: x })), v.quantity_unit)}${errText(e, "quantity_unit")}</label>
          <label>Days supply<input type="number" min="1" max="365" name="days_supply" value="${v.days_supply || ""}" inputmode="numeric">${errText(e, "days_supply")}</label>
          <label>Refills<input type="number" min="0" max="11" name="refills" value="${v.refills || "0"}" inputmode="numeric"><span class="hint">C-II: none · C-III/IV/V: up to 5, within 6 months</span>${errText(e, "refills")}</label>
          <label>Diagnosis (ICD-10) <span class="hint">(optional)</span><input type="text" name="diagnosis" maxlength="10" value="${v.diagnosis || ""}" placeholder="E29.1">${errText(e, "diagnosis")}</label>
          <label>Date written<input type="date" name="written_on" value="${v.written_on || t}" readonly>${errText(e, "written_on")}</label>
          <label class="check span-all"><input type="checkbox" name="daw" value="1" ${v.daw ? raw("checked") : ""}> Dispense as written (no generic substitution)</label>
          <label>Pharmacy<input type="text" name="pharmacy" maxlength="160" value="${v.pharmacy || ""}" placeholder="Name and address">${errText(e, "pharmacy")}</label>
          <label>Pharmacy phone / fax<input type="tel" name="pharmacy_phone" maxlength="40" value="${v.pharmacy_phone || ""}"></label>
          <label class="span-all">Note to pharmacist <span class="hint">(optional)</span><input type="text" name="pharmacy_note" maxlength="1000" value="${v.pharmacy_note || ""}"></label>
          <label class="span-all">Send by ${select("delivery", DELIVERY, v.delivery)}${errText(e, "delivery")}
            <span class="hint">Controlled substances can't be sent electronically from here (that needs a DEA-certified EPCS service). Print and sign by hand, fax a hand-signed copy (C-III to C-V), or enter it in your e-prescribing system and record it here.</span></label>
          <label class="check span-all"><input type="checkbox" name="pdmp_checked" value="1" ${v.pdmp_checked ? raw("checked") : ""}> For controlled substances: I checked the state prescription monitoring program (PDMP) for this client today.${errText(e, "pdmp_checked")}</label>
          ${e.allow_duplicate ? html`<label class="check span-all"><input type="checkbox" name="allow_duplicate" value="1"> Keep both active</label>` : ""}
          ${e.allergy_override ? html`<label class="check span-all"><input type="checkbox" name="allergy_override" value="1"> Prescribe anyway (allergy reviewed)</label>` : ""}
          <label class="span-all">Your password <span class="hint">(signs the prescription)</span><input type="password" name="password" autocomplete="current-password" required>${errText(e, "password")}</label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Sign prescription</button></div>
      </form>
    </section>` : can(u, "clinical:write") ? html`<p class="hint">Only prescribers can write prescriptions. An administrator sets this up under Administration → Users.</p>` : "";

  res.status(status).send(chartPage(req, patient, "rx", html`
    <section class="card" aria-labelledby="rx-active">
      <div class="card__head"><h2 id="rx-active">Active prescriptions</h2><span class="muted small">${active.length}</span></div>
      ${active.length ? table(active) : html`<p class="muted">No active prescriptions.</p>`}
    </section>
    ${form}
    ${past.length ? html`<section class="card" aria-labelledby="rx-past"><div class="card__head"><h2 id="rx-past">Past prescriptions</h2></div>${table(past)}</section>` : ""}`,
  { title: `Prescriptions · ${patientName(patient)}` }));
}

router.get("/patients/:id/prescriptions", gate((u) => can(u, "clinical:read")), (req, res) => {
  const p = loadPatient(req, res);
  if (p) rxTab(req, res, p);
});

router.post("/patients/:id/prescriptions", gate((u) => can(u, "clinical:write")), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const db = req.db;
  if (!canWriteRx(db, req.user)) return forbidden(req, res);
  const { v, e } = readRx(req.body || {}, db, p, req.user);
  const pw = typeof (req.body || {}).password === "string" ? req.body.password : "";
  const stored = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!pw || !stored || !verifyPassword(pw, stored.password_hash)) {
    e.password = "Password is incorrect. Re-enter your password to sign.";
    audit(req, "sign_failed", "prescription", null, p.id, "password");
  }
  if (Object.keys(e).length) return rxTab(req, res, p, { v, e }, 400);
  const me = prescriberRow(db, req.user.id);
  const prescriberText = `${me.name}${me.credentials ? `, ${me.credentials}` : ""}`;
  let rxId;
  db.exec("BEGIN");
  try {
    const medId = Number(db.prepare(`INSERT INTO medications (patient_id, name, dose, route, frequency, prescriber, start_date, active, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(p.id, v.drug, v.strength || null, v.route || null, v.sig, prescriberText, v.written_on, "Added from a prescription", req.user.id).lastInsertRowid);
    rxId = Number(db.prepare(`INSERT INTO prescriptions (patient_id, prescriber_id, drug, strength, dosage_form, route, sig, quantity, quantity_unit, days_supply, refills, schedule,
        daw, diagnosis, pharmacy, pharmacy_phone, pharmacy_note, delivery, pdmp_checked, written_on, medication_id, renewed_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, req.user.id, v.drug, v.strength || null, v.dosage_form || null, v.route || null, v.sig,
      Number(v.quantity), v.quantity_unit, v.days_supply ? Number(v.days_supply) : null, Number(v.refills || 0), v.schedule, v.daw, v.diagnosis || null, v.pharmacy || null,
      v.pharmacy_phone || null, v.pharmacy_note || null, v.delivery, v.pdmp_checked, v.written_on, medId, v.renewed_from).lastInsertRowid);
    // Renewing replaces the old prescription.
    if (v.renewed_from) {
      const old = db.prepare("SELECT * FROM prescriptions WHERE id = ? AND patient_id = ? AND status = 'active'").get(v.renewed_from, p.id);
      if (old) endRx(db, old, "discontinued", req.user.id, `Renewed as prescription #${rxId}`);
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  audit(req, "sign", "prescription", rxId, p.id, `${v.schedule ? `C-${v.schedule} ` : ""}${v.delivery}`);
  req.flash("success", ["print", "fax"].includes(v.delivery) ? "Prescription signed. Print it and sign by hand." : "Prescription signed and recorded.");
  res.redirect(["print", "fax"].includes(v.delivery) ? `/ehr/prescriptions/${rxId}/print` : `/ehr/patients/${p.id}/prescriptions`);
});

function endRx(db, rx, status, userId, reason) {
  db.prepare("UPDATE prescriptions SET status = ?, ended_at = datetime('now'), ended_by = ?, end_reason = ? WHERE id = ?").run(status, userId, reason, rx.id);
  if (rx.medication_id) db.prepare("UPDATE medications SET active = 0, end_date = ? WHERE id = ? AND active = 1").run(today(), rx.medication_id);
}

function loadRx(req, res) {
  const rx = /^\d+$/.test(req.params.rid) ? req.db.prepare("SELECT * FROM prescriptions WHERE id = ?").get(Number(req.params.rid)) : null;
  if (!rx) notFound(req, res, "Prescription");
  return rx;
}

for (const [action, status, verb] of [["discontinue", "discontinued", "discontinued"], ["void", "voided", "voided"]]) {
  router.post(`/prescriptions/:rid/${action}`, gate((u) => can(u, "clinical:write")), (req, res) => {
    const rx = loadRx(req, res);
    if (!rx) return;
    if (!canWriteRx(req.db, req.user)) return forbidden(req, res);
    const reason = str((req.body || {}).reason, 300);
    if (rx.status !== "active") { req.flash("info", "That prescription is no longer active."); return res.redirect(`/ehr/patients/${rx.patient_id}/prescriptions`); }
    if (!reason) { req.flash("error", "Enter a reason."); return res.redirect(`/ehr/patients/${rx.patient_id}/prescriptions`); }
    endRx(req.db, rx, status, req.user.id, reason);
    audit(req, action, "prescription", rx.id, rx.patient_id);
    req.flash("success", `Prescription ${verb}. ${rx.delivery === "print" || rx.delivery === "fax" ? "If the client or pharmacy has the paper copy, let the pharmacy know." : "Cancel it with the pharmacy too."}`);
    res.redirect(`/ehr/patients/${rx.patient_id}/prescriptions`);
  });
}

/* ------------------------------------------------------------------ */
/* Printable prescription                                              */
/* ------------------------------------------------------------------ */

router.get("/prescriptions/:rid/print", gate((u) => can(u, "clinical:read")), (req, res) => {
  const rx = loadRx(req, res);
  if (!rx) return;
  const db = req.db;
  if (rx.status === "voided") return notFound(req, res, "Prescription");
  const p = db.prepare("SELECT * FROM patients WHERE id = ?").get(rx.patient_id);
  const pr = prescriberRow(db, rx.prescriber_id);
  const c = getClinic(db);
  const copy = rx.prints > 0;
  db.prepare("UPDATE prescriptions SET prints = prints + 1 WHERE id = ?").run(rx.id);
  audit(req, copy ? "reprint" : "print", "prescription", rx.id, rx.patient_id);
  const addr = [p.address_line1, p.address_line2, [p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  res.send(page(req, { title: "Prescription", bare: true, body: html`
    <div class="print-toolbar no-print"><a class="btn btn--sm btn--ghost" href="/ehr/patients/${p.id}/prescriptions">Back to chart</a>
      <button class="btn btn--primary btn--sm" type="button" data-print>Print</button></div>
    <article class="rx-paper${copy ? " rx-paper--copy" : ""}">
      ${copy ? html`<div class="rx-copy" aria-label="Copy">COPY · NOT VALID FOR DISPENSING</div>` : ""}
      <header class="rx-head">
        <div><strong class="rx-clinic">${c.name}</strong>${c.addressLines.map((l) => html`<div>${l}</div>`)}${c.phone ? html`<div>Phone ${c.phone}${c.fax ? ` · Fax ${c.fax}` : ""}</div>` : ""}</div>
        <div class="rx-prescriber"><strong>${pr.name}${pr.credentials ? `, ${pr.credentials}` : ""}</strong>
          <div>NPI ${pr.npi || "—"}</div>
          ${rx.schedule ? html`<div>DEA ${pr.dea_number || "—"}</div>` : ""}
          ${pr.license_number ? html`<div>License ${pr.license_state ? `${pr.license_state} ` : ""}${pr.license_number}</div>` : ""}</div>
      </header>
      <section class="rx-patient">
        <div><span class="rx-k">Patient</span> <strong>${p.first_name} ${p.last_name}</strong></div>
        <div><span class="rx-k">DOB</span> ${fmtDate(p.dob)}</div>
        <div class="rx-wide"><span class="rx-k">Address</span> ${addr || "—"}</div>
        <div><span class="rx-k">Date</span> ${fmtDate(rx.written_on)}</div>
      </section>
      <section class="rx-body">
        <div class="rx-symbol" aria-hidden="true">℞</div>
        <div>
          <p class="rx-drug">${rxTitle(rx)} ${rx.schedule ? html`<span class="rx-sched">C-${rx.schedule}</span>` : ""}</p>
          ${rx.dosage_form || rx.route ? html`<p>${[rx.dosage_form, rx.route].filter(Boolean).join(" · ")}</p>` : ""}
          <p><span class="rx-k">Sig:</span> ${rx.sig}</p>
          <p><span class="rx-k">Dispense:</span> <strong>${fmtQty(rx.quantity)} (${toWords(rx.quantity)}) ${rx.quantity_unit}</strong>${rx.days_supply ? ` · ${rx.days_supply}-day supply` : ""}</p>
          <p><span class="rx-k">Refills:</span> <strong>${rx.refills} (${toWords(rx.refills)})</strong>${rx.schedule && rx.refills ? ` · not valid after ${fmtDate(expiresOn(rx))}` : ""}</p>
          ${rx.diagnosis ? html`<p><span class="rx-k">Diagnosis:</span> ${rx.diagnosis}</p>` : ""}
          <p>${rx.daw ? html`<strong>Dispense as written</strong>` : "Substitution permitted"}</p>
          ${rx.pharmacy_note ? html`<p><span class="rx-k">Note:</span> ${rx.pharmacy_note}</p>` : ""}
          ${rx.pharmacy ? html`<p class="small"><span class="rx-k">Pharmacy:</span> ${rx.pharmacy}${rx.pharmacy_phone ? ` · ${rx.pharmacy_phone}` : ""}</p>` : ""}
        </div>
      </section>
      <footer class="rx-sign">
        <div class="rx-line"></div>
        <div>${pr.name}${pr.credentials ? `, ${pr.credentials}` : ""} · signature (by hand)</div>
        <p class="small muted">Prescription #${rx.id} · signed in ${c.name}'s record ${fmtTimestamp(rx.signed_at)}${rx.schedule ? " · Controlled substance: not valid without the prescriber's handwritten signature" : ""}</p>
      </footer>
    </article>` }));
});

/* ------------------------------------------------------------------ */
/* Prescription log                                                    */
/* ------------------------------------------------------------------ */

router.get("/prescriptions", gate((u) => can(u, "clinical:read")), (req, res) => {
  const db = req.db;
  const admin = can(req.user, "admin");
  const mine = !admin || req.query.who !== "all";
  const controlled = req.query.controlled === "1";
  const from = isDate(String(req.query.from || "")) ? req.query.from : addDays(today(), -90);
  const rows = db.prepare(`SELECT r.*, u.name AS prescriber_name, pt.first_name, pt.last_name, pt.preferred_name, pt.mrn FROM prescriptions r
    JOIN users u ON u.id = r.prescriber_id JOIN patients pt ON pt.id = r.patient_id
    WHERE r.written_on >= ? ${mine ? "AND r.prescriber_id = ?" : ""} ${controlled ? "AND r.schedule <> ''" : ""}
    ORDER BY r.written_on DESC, r.id DESC LIMIT 2000`).all(...[from, ...(mine ? [req.user.id] : [])]);
  audit(req, req.query.format === "csv" ? "export" : "view", "prescription", null, null, `log ${rows.length}`);
  if (req.query.format === "csv") {
    const q = (x) => { const s = String(x ?? ""); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
    const lines = [["written_on", "rx_id", "client_mrn", "drug", "strength", "schedule", "quantity", "unit", "refills", "prescriber", "delivery", "status"].join(",")];
    for (const r of rows) lines.push([r.written_on, r.id, r.mrn, r.drug, r.strength, r.schedule, fmtQty(r.quantity), r.quantity_unit, r.refills, r.prescriber_name, r.delivery, r.status].map(q).join(","));
    return res.set("content-type", "text/csv; charset=utf-8").set("content-disposition", `attachment; filename="prescriptions-${today()}.csv"`).send(lines.join("\n") + "\n");
  }
  const qs = (o) => new URLSearchParams({ from, ...(controlled ? { controlled: "1" } : {}), ...(admin && !mine ? { who: "all" } : {}), ...o }).toString();
  res.send(page(req, { title: "Prescriptions", active: "rx", body: html`
    <div class="page-head"><div><h1>Prescriptions</h1><p>${mine ? "Prescriptions you've written" : "Every prescription written at this clinic"} since ${fmtDate(from)}.</p></div>
      <a class="btn btn--sm" href="/ehr/prescriptions?${qs({ format: "csv" })}">Download CSV</a></div>
    <form method="get" action="/ehr/prescriptions" class="row card">
      <label>Since <input type="date" name="from" value="${from}"></label>
      <label class="check"><input type="checkbox" name="controlled" value="1" ${controlled ? raw("checked") : ""}> Controlled only</label>
      ${admin ? html`<label class="check"><input type="checkbox" name="who" value="all" ${!mine ? raw("checked") : ""}> All prescribers</label>` : ""}
      <button class="btn btn--sm" type="submit">Show</button>
    </form>
    <section class="card">${rows.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Written</th><th>Client</th><th>Medication</th><th class="num">Qty</th><th>Refills</th><th>Prescriber</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class="${r.status === "voided" ? "is-voided" : ""}">
        <td>${fmtDate(r.written_on)}</td>
        <td><a href="/ehr/patients/${r.patient_id}/prescriptions">${patientName(r)}</a><br><span class="small muted">MRN ${r.mrn}</span></td>
        <td>${rxTitle(r)} ${scheduleBadge(r.schedule)}</td>
        <td class="num">${fmtQty(r.quantity)} ${r.quantity_unit}</td><td>${r.refills}</td>
        <td class="small">${r.prescriber_name}</td><td>${humanize(r.status)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No prescriptions in this period.</p>`}</section>` }));
});

/* ------------------------------------------------------------------ */
/* Administration: prescriber setup (card on the user edit page)       */
/* ------------------------------------------------------------------ */

function prescriberCard(req, user) {
  const u = prescriberRow(req.db, user.id) || {};
  return html`
    <form class="card stack" id="prescribing" method="post" action="/ehr/admin/users/${user.id}/prescriber">
      ${csrfField(req)}
      <h2>Prescribing</h2>
      <label class="check"><input type="checkbox" name="can_prescribe" value="1" ${u.can_prescribe ? raw("checked") : ""}> Can write prescriptions</label>
      <p class="hint">Turned on automatically for prescribing credentials (PMHNP and other nurse practitioners, MD, DO, PA, APRN). Untick to stop someone prescribing.</p>
      <div class="form-grid">
        <label>DEA number <span class="hint">(for controlled substances)</span><input name="dea_number" value="${u.dea_number || ""}" maxlength="9" autocapitalize="characters" autocomplete="off"></label>
        <label>DEA expires<input type="date" name="dea_expires" value="${u.dea_expires || ""}"></label>
        <label>State license #<input name="license_number" value="${u.license_number || ""}" maxlength="40"></label>
        <label>License state<input name="license_state" value="${u.license_state || ""}" maxlength="2" autocapitalize="characters"></label>
      </div>
      ${u.can_prescribe && !u.npi ? html`<p class="hint">Add an NPI in the profile above; prescribing needs one.</p>` : ""}
      <div class="form-actions"><button class="btn btn--sm btn--primary" type="submit">Save prescribing</button></div>
    </form>`;
}

router.post("/admin/users/:id/prescriber", gate((u) => can(u, "admin")), (req, res) => {
  const db = req.db;
  const user = /^\d+$/.test(req.params.id) ? prescriberRow(db, Number(req.params.id)) : null;
  if (!user) return notFound(req, res, "User");
  const b = req.body || {};
  const v = { can_prescribe: b.can_prescribe === "1" ? 1 : 0, dea_number: str(b.dea_number, 9).toUpperCase(), dea_expires: str(b.dea_expires, 10),
    license_number: str(b.license_number, 40), license_state: str(b.license_state, 2).toUpperCase() };
  const errs = [];
  if (v.dea_number && !deaValid(v.dea_number)) errs.push("That DEA number isn't valid (2 letters and 7 digits, with a matching check digit).");
  if (v.dea_expires && !isDate(v.dea_expires)) errs.push("Enter a valid DEA expiration date.");
  if (v.license_state && !/^[A-Z]{2}$/.test(v.license_state)) errs.push("License state is a 2-letter code.");
  if (v.can_prescribe && !["admin", "clinician"].includes(user.role)) errs.push("Only clinicians and administrators can prescribe.");
  if (errs.length) { req.flash("error", errs.join(" ")); return res.redirect(`/ehr/admin/users/${user.id}/edit#prescribing`); }
  db.prepare("UPDATE users SET can_prescribe = ?, dea_number = ?, dea_expires = ?, license_number = ?, license_state = ? WHERE id = ?")
    .run(v.can_prescribe, v.dea_number || null, v.dea_expires || null, v.license_number || null, v.license_state || null, user.id);
  audit(req, "update", "user", user.id, null, `prescribing ${v.can_prescribe ? "on" : "off"}${v.dea_number ? " dea set" : ""}`);
  req.flash("success", `Saved prescribing for ${user.name}.`);
  res.redirect(`/ehr/admin/users/${user.id}/edit#prescribing`);
});

module.exports = { router, prescriberCard, prescribingCredential, autoEnablePrescriber, deaValid, toWords, expiresOn, TEMPLATES, canWriteRx };
