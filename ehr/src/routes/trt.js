"use strict";
/*
 * Hormone therapy: testosterone replacement (TRT). Off by default; an administrator turns it on in Clinic settings.
 *
 *   GET  /trt                                  enrolled clients: next dose, labs due, safety flags
 *   GET  /trt/inventory                        Schedule III stock: lots on hand, running record, receive/waste/adjust
 *   POST /trt/inventory/lots                   receive a lot
 *   POST /trt/inventory/waste                  waste from a lot (needs a second staff member as witness)
 *   POST /trt/inventory/adjust                 count correction (administrator, reason required)
 *   POST /trt/inventory/lots/:lid/close        close an empty lot
 *   GET  /trt/inventory.csv                    the running record as CSV (for audits and the biennial inventory)
 *   GET  /trt/settings, POST                   alert thresholds and lab schedule (administrator)
 *   GET  /patients/:id/trt                     chart tab: regimen, alerts, labs, doses, visit checks
 *   POST /patients/:id/trt/program             start or update the regimen
 *   POST /patients/:id/trt/labs                add lab results
 *   POST /patients/:id/trt/doses               record a dose given in clinic or dispensed for home
 *   POST /patients/:id/trt/doses/:did/void     void a dose entered in error (stock goes back on the lot)
 *   POST /patients/:id/trt/visits              vitals and symptom check
 *
 * Default thresholds follow the Endocrine Society guideline (Bhasin et al., JCEM 2018): testosterone in the mid-normal
 * range, hematocrit above 54% = consider holding therapy, PSA rise > 1.4 ng/mL in 12 months or PSA > 4 ng/mL = urology
 * evaluation, labs 3-6 months after starting then at least yearly. The clinic's medical director confirms or changes
 * them on the settings page. This module records and flags; it never makes a dosing decision.
 *
 * Testosterone is a Schedule III controlled substance. The stock record is append-only and every dose moves stock;
 * the clinic is responsible for meeting DEA and state board recordkeeping rules (21 CFR 1304).
 * Who: view = clinical:read; record = clinical:write; settings and count corrections = admin. Everything is audited.
 */
const express = require("express");
const { forbidden } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, raw, page, chartPage, notFound, csrfField, select, getPatient, patientName, today, addDays, fmtDate, humanize } = require("../views");

const router = express.Router();

const MEDICATIONS = [
  { value: "cypionate", label: "Testosterone cypionate injection", route: "im", mgml: 200, jcode: "J1071" },
  { value: "enanthate", label: "Testosterone enanthate injection", route: "im", mgml: 200, jcode: "J3121" },
  { value: "enanthate_sc", label: "Testosterone enanthate (subcutaneous auto-injector)", route: "subq", mgml: null, jcode: "" },
  { value: "undecanoate_inj", label: "Testosterone undecanoate injection", route: "im", mgml: 250, jcode: "J3145" },
  { value: "gel", label: "Testosterone gel / topical", route: "topical", mgml: null, jcode: "" },
  { value: "pellets", label: "Testosterone pellets", route: "pellet", mgml: null, jcode: "S0189" },
  { value: "nasal", label: "Testosterone nasal gel", route: "nasal", mgml: null, jcode: "" },
  { value: "oral", label: "Oral testosterone undecanoate", route: "oral", mgml: null, jcode: "" },
  { value: "other", label: "Other", route: "", mgml: null, jcode: "" },
];
const MED = Object.fromEntries(MEDICATIONS.map((m) => [m.value, m]));
const ROUTES = [{ value: "", label: "Select…" }, { value: "im", label: "Intramuscular (IM)" }, { value: "subq", label: "Subcutaneous (SubQ)" },
  { value: "topical", label: "Topical" }, { value: "pellet", label: "Pellet implant" }, { value: "nasal", label: "Nasal" }, { value: "oral", label: "Oral" }];
const STATUSES = ["evaluating", "active", "paused", "stopped"];
const STATUS_TONE = { evaluating: "info", active: "ok", paused: "warn", stopped: "neutral" };
const SITES = ["", "Left glute", "Right glute", "Left deltoid", "Right deltoid", "Left thigh", "Right thigh", "Left abdomen", "Right abdomen", "Other"];
const TIMINGS = [{ value: "", label: "Not recorded" }, { value: "baseline", label: "Baseline (before starting)" }, { value: "trough", label: "Trough (just before a dose)" },
  { value: "mid", label: "Mid-cycle" }, { value: "peak", label: "Peak" }];
const LABS = [
  { key: "total_t", label: "Total testosterone", unit: "ng/dL", max: 5000 },
  { key: "free_t", label: "Free testosterone", unit: "pg/mL", max: 1000 },
  { key: "estradiol", label: "Estradiol", unit: "pg/mL", max: 1000 },
  { key: "hematocrit", label: "Hematocrit", unit: "%", max: 80 },
  { key: "hemoglobin", label: "Hemoglobin", unit: "g/dL", max: 30 },
  { key: "psa", label: "PSA", unit: "ng/mL", max: 200 },
  { key: "lh", label: "LH", unit: "mIU/mL", max: 200 },
  { key: "fsh", label: "FSH", unit: "mIU/mL", max: 200 },
];
const SYMPTOMS = [{ key: "energy", label: "Energy" }, { key: "libido", label: "Libido" }, { key: "mood", label: "Mood" }, { key: "sleep", label: "Sleep" }];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const str = (v, n = 500) => String(v ?? "").trim().slice(0, n);
const medLabel = (v) => (MED[v] ? MED[v].label : humanize(v || ""));
const routeLabel = (v) => (ROUTES.find((r) => r.value === v) || { label: v || "" }).label;
const fmtNum = (n, d = 1) => (n == null ? "" : String(Math.round(n * 10 ** d) / 10 ** d));
const ml = (n) => `${fmtNum(n, 2)} mL`;

/** Parse an optional number; returns { n } or { error }. */
function numField(raw, { min = 0, max = 1e6, int = false, label = "This" } = {}) {
  const s = String(raw ?? "").trim();
  if (s === "") return { n: null };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: `${label} must be a number.` };
  const n = Number(s);
  if (int && !Number.isInteger(n)) return { error: `${label} must be a whole number.` };
  if (n < min || n > max) return { error: `${label} must be between ${min} and ${max}.` };
  return { n };
}

/* ------------------------------------------------------------------ */
/* Feature switch, settings, lookups                                   */
/* ------------------------------------------------------------------ */

function trtEnabled(db) {
  try { const r = db.prepare("SELECT trt_enabled FROM clinic_settings WHERE id = 1").get(); return !!(r && r.trt_enabled); } catch { return false; }
}
function setTrtEnabled(db, on) {
  db.prepare("INSERT OR IGNORE INTO clinic_settings (id, name) VALUES (1, ?)").run(require("../clinic").defaultName());
  db.prepare("UPDATE clinic_settings SET trt_enabled = ? WHERE id = 1").run(on ? 1 : 0);
}
function settings(db) {
  db.prepare("INSERT OR IGNORE INTO trt_settings (id) VALUES (1)").run();
  return db.prepare("SELECT * FROM trt_settings WHERE id = 1").get();
}

const canView = (u) => can(u, "clinical:read");
const canWrite = (u) => can(u, "clinical:write");
const gate = (fn) => (req, res, next) => (fn(req.user) ? next() : forbidden(req, res));

/** 404 with a pointer to Clinic settings when the clinic hasn't turned the module on. */
function requireEnabled(req, res, next) {
  if (trtEnabled(req.db)) return next();
  res.status(404).send(page(req, { title: "Hormone therapy is off", body: html`<div class="card stack"><h1>Hormone therapy is turned off</h1>
    <p>This clinic hasn't turned on testosterone replacement (TRT) tools.${can(req.user, "admin") ? html` Turn them on in <a href="/ehr/admin/clinic#programs">Clinic settings → Programs</a>.` : " Ask an administrator to turn them on in Clinic settings."}</p>
    <p><a href="/ehr">Back to dashboard</a></p></div>` }));
}

const staff = (db) => db.prepare("SELECT id, name, credentials FROM users WHERE active = 1 AND role IN ('admin', 'clinician') ORDER BY name").all();
const staffLabel = (u) => `${u.name}${u.credentials ? `, ${u.credentials}` : ""}`;
const program = (db, pid) => db.prepare(`SELECT p.*, u.name AS prescriber_name, u.credentials AS prescriber_cred FROM trt_programs p
  LEFT JOIN users u ON u.id = p.prescriber_id WHERE p.patient_id = ?`).get(pid) || null;
const labsFor = (db, pid) => db.prepare("SELECT l.*, u.name AS entered_name FROM trt_labs l LEFT JOIN users u ON u.id = l.entered_by WHERE l.patient_id = ? ORDER BY drawn_on DESC, id DESC").all(pid);
const lastDose = (db, pid) => db.prepare("SELECT * FROM trt_doses WHERE patient_id = ? AND voided_at IS NULL ORDER BY given_on DESC, id DESC LIMIT 1").get(pid) || null;
const onHand = (db, lotId) => db.prepare("SELECT COALESCE(SUM(quantity_ml), 0) AS q FROM trt_ledger WHERE lot_id = ?").get(lotId).q;

function lots(db, { open = true } = {}) {
  return db.prepare(`SELECT l.*, COALESCE((SELECT SUM(quantity_ml) FROM trt_ledger g WHERE g.lot_id = l.id), 0) AS on_hand,
      COALESCE((SELECT SUM(quantity_ml) FROM trt_ledger g WHERE g.lot_id = l.id AND g.event = 'received'), 0) AS received
    FROM trt_lots l ${open ? "WHERE l.closed_at IS NULL" : ""} ORDER BY l.closed_at IS NOT NULL, l.expiration, l.id`).all();
}

/* ------------------------------------------------------------------ */
/* Clinical logic: when are things due, what needs attention           */
/* ------------------------------------------------------------------ */

/** When the next dose is due: last dose + interval (or the days supply dispensed). */
function nextDoseDue(prog, last) {
  if (!prog || prog.status !== "active" || !last) return null;
  const days = last.kind === "dispensed" ? (last.days_supply || prog.frequency_days) : prog.frequency_days;
  return days ? addDays(last.given_on, days) : null;
}

/** When labs are next due: first check N days after starting, then every M days after the latest draw. */
function nextLabsDue(prog, labs, s) {
  if (!prog || prog.status !== "active" || !prog.start_date) return null;
  const after = labs.filter((l) => l.drawn_on >= prog.start_date && l.timing !== "baseline");
  if (!after.length) return addDays(prog.start_date, s.first_labs_days);
  return addDays(after[0].drawn_on, s.labs_every_days);
}

/** Safety and monitoring flags for one client. labs are newest first. Each flag: { tone: bad|warn|info, text }. */
function flagsFor(prog, labs, s, t = today()) {
  const out = [];
  if (!prog) return out;
  const latest = (key) => labs.find((l) => l[key] != null) || null;
  const hct = latest("hematocrit");
  if (hct && hct.hematocrit > s.hct_max) out.push({ tone: "bad", key: "hct", text: `Hematocrit ${fmtNum(hct.hematocrit)}% on ${fmtDate(hct.drawn_on)} is above ${fmtNum(s.hct_max)}%: review before the next dose` });
  const psa = latest("psa");
  if (psa && psa.psa > s.psa_max) out.push({ tone: "bad", key: "psa", text: `PSA ${fmtNum(psa.psa, 2)} ng/mL on ${fmtDate(psa.drawn_on)} is above ${fmtNum(s.psa_max, 1)}: consider urology evaluation` });
  if (psa) {
    const earlier = labs.filter((l) => l.psa != null && l.id !== psa.id && l.drawn_on < psa.drawn_on && l.drawn_on >= addDays(psa.drawn_on, -365));
    const base = earlier.length ? earlier[earlier.length - 1] : null; // oldest within the 12 months before
    if (base && psa.psa - base.psa > s.psa_rise) out.push({ tone: "bad", key: "psa_rise", text: `PSA rose ${fmtNum(psa.psa - base.psa, 2)} ng/mL since ${fmtDate(base.drawn_on)} (more than ${fmtNum(s.psa_rise, 1)} in 12 months): consider urology evaluation` });
  }
  if (prog.status === "active") {
    const tt = latest("total_t");
    if (tt && prog.start_date && tt.drawn_on >= prog.start_date && tt.timing !== "baseline") {
      if (tt.total_t < s.t_low) out.push({ tone: "warn", key: "t_low", text: `Total testosterone ${fmtNum(tt.total_t, 0)} ng/dL is below the ${fmtNum(s.t_low, 0)}–${fmtNum(s.t_high, 0)} target` });
      else if (tt.total_t > s.t_high) out.push({ tone: "warn", key: "t_high", text: `Total testosterone ${fmtNum(tt.total_t, 0)} ng/dL is above the ${fmtNum(s.t_low, 0)}–${fmtNum(s.t_high, 0)} target` });
    }
    if (prog.start_date && !labs.some((l) => l.drawn_on <= prog.start_date || l.timing === "baseline")) out.push({ tone: "warn", key: "baseline", text: "No baseline labs before starting therapy" });
    const due = nextLabsDue(prog, labs, s);
    if (due && due < t) out.push({ tone: "bad", key: "labs_overdue", text: `Labs overdue since ${fmtDate(due)}` });
    else if (due && due <= addDays(t, 14)) out.push({ tone: "warn", key: "labs_due", text: `Labs due ${fmtDate(due)}` });
  }
  return out;
}

/** Chart banner pill (views.chartPage). */
function bannerPill(db, user, patient) {
  if (!canView(user) || !trtEnabled(db)) return "";
  const prog = program(db, patient.id);
  if (!prog || prog.status === "stopped") return "";
  const flags = flagsFor(prog, labsFor(db, patient.id), settings(db));
  const bad = flags.filter((f) => f.tone === "bad");
  const href = `/ehr/patients/${patient.id}/trt`;
  if (bad.length) return html`<a class="pill pill--bad" href="${href}" title="${bad.map((f) => f.text).join("; ")}">TRT: ${bad.length} alert${bad.length === 1 ? "" : "s"}</a>`;
  const next = nextDoseDue(prog, lastDose(db, patient.id));
  return html`<a class="pill pill--trt" href="${href}">TRT: ${humanize(prog.status)}${next ? ` · next dose ${fmtDate(next)}` : ""}</a>`;
}

/** Active testosterone prescriptions on the TRT tab, with a shortcut to write one. */
function rxSummary(db, user, patient) {
  const rows = db.prepare("SELECT id, drug, strength, sig, refills, written_on FROM prescriptions WHERE patient_id = ? AND status = 'active' AND lower(drug) LIKE '%testosterone%' ORDER BY written_on DESC").all(patient.id);
  const writer = require("./rx").canWriteRx(db, user);
  const base = `/ehr/patients/${patient.id}/prescriptions`;
  return html`<div class="trt-rx">
    <p class="small"><strong>Prescriptions:</strong> ${rows.length ? rows.map((r) => html`${r.drug} ${r.strength || ""} (${fmtDate(r.written_on)}, ${r.refills} refill${r.refills === 1 ? "" : "s"}) `) : html`<span class="muted">no active testosterone prescription</span>`}
      · <a href="${base}">All prescriptions</a>${writer ? html` · <a href="${base}?template=cypionate#write">Write a testosterone prescription</a>` : ""}</p></div>`;
}

/* ------------------------------------------------------------------ */
/* Form helpers                                                        */
/* ------------------------------------------------------------------ */

const errText = (e, k) => (e && e[k] ? html`<span class="error-text">${e[k]}</span>` : "");
function errorSummary(e) {
  const list = Object.values(e || {});
  return list.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong><ul class="list">${list.map((x) => html`<li>${x}</li>`)}</ul></div>` : "";
}
const opt = (list, blank = "Select…") => [{ value: "", label: blank }, ...list];

function readProgram(b, db) {
  const v = { status: str(b.status, 20), medication: str(b.medication, 40), route: str(b.route, 20), ancillary: str(b.ancillary, 500),
    start_date: str(b.start_date, 10), goals: str(b.goals, 1000), stop_reason: str(b.stop_reason, 500), prescriber_id: str(b.prescriber_id, 10),
    dose_mg: str(b.dose_mg, 12), frequency_days: str(b.frequency_days, 4) };
  const e = {};
  if (!STATUSES.includes(v.status)) e.status = "Choose a status.";
  if (!MED[v.medication]) e.medication = "Choose the medication.";
  if (v.route && !ROUTES.some((r) => r.value === v.route)) e.route = "Choose a route.";
  const dose = numField(v.dose_mg, { min: 0.1, max: 2000, label: "Dose" });
  if (dose.error) e.dose_mg = dose.error;
  const freq = numField(v.frequency_days, { min: 1, max: 365, int: true, label: "Every (days)" });
  if (freq.error) e.frequency_days = freq.error;
  if (v.start_date && !isDate(v.start_date)) e.start_date = "Enter a valid start date.";
  if (v.status === "active" && !v.start_date) e.start_date = "Active therapy needs a start date.";
  if (v.status === "active" && dose.n == null && !["gel", "nasal", "oral", "other"].includes(v.medication)) e.dose_mg = "Enter the dose in mg.";
  if (v.status === "active" && freq.n == null) e.frequency_days = "Enter how often (in days).";
  if (v.status === "stopped" && !v.stop_reason) e.stop_reason = "Say why therapy stopped.";
  let prescriber = null;
  if (v.prescriber_id) {
    prescriber = db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('admin', 'clinician')").get(Number(v.prescriber_id));
    if (!prescriber) e.prescriber_id = "Choose a prescriber from the list.";
  }
  return { v, e, vals: { dose_mg: dose.n, frequency_days: freq.n, prescriber_id: prescriber ? prescriber.id : null } };
}

function readLabs(b) {
  const v = { drawn_on: str(b.drawn_on, 10), timing: str(b.timing, 20), notes: str(b.notes, 1000) };
  const e = {};
  const vals = {};
  if (!isDate(v.drawn_on)) e.drawn_on = "Enter the date the labs were drawn.";
  else if (v.drawn_on > today()) e.drawn_on = "The draw date can't be in the future.";
  if (v.timing && !TIMINGS.some((x) => x.value === v.timing)) e.timing = "Choose when the sample was drawn.";
  for (const l of LABS) {
    v[l.key] = str(b[l.key], 12);
    const r = numField(v[l.key], { min: 0, max: l.max, label: l.label });
    if (r.error) e[l.key] = r.error; else vals[l.key] = r.n;
  }
  if (!e.drawn_on && LABS.every((l) => vals[l.key] == null) && !Object.keys(e).length) e.total_t = "Enter at least one result.";
  return { v, e, vals };
}

function readVisit(b) {
  const v = { visit_date: str(b.visit_date, 10), side_effects: str(b.side_effects, 1000) };
  const e = {};
  const vals = {};
  if (!isDate(v.visit_date)) e.visit_date = "Enter the visit date.";
  else if (v.visit_date > today()) e.visit_date = "The visit date can't be in the future.";
  const spec = { bp_sys: [50, 260, "Systolic BP"], bp_dia: [30, 160, "Diastolic BP"], heart_rate: [20, 250, "Heart rate"], weight_lb: [50, 900, "Weight"],
    ...Object.fromEntries(SYMPTOMS.map((s) => [s.key, [0, 10, s.label]])) };
  for (const [k, [min, max, label]] of Object.entries(spec)) {
    v[k] = str(b[k], 8);
    const r = numField(v[k], { min, max, int: k !== "weight_lb", label });
    if (r.error) e[k] = r.error; else vals[k] = r.n;
  }
  if ((vals.bp_sys == null) !== (vals.bp_dia == null) && !e.bp_sys && !e.bp_dia) e.bp_sys = "Enter both blood pressure numbers.";
  if (!Object.keys(e).length && Object.values(vals).every((x) => x == null) && !v.side_effects) e.visit_date = "Enter at least one vital sign or symptom score.";
  return { v, e, vals };
}

/* ------------------------------------------------------------------ */
/* Chart tab                                                           */
/* ------------------------------------------------------------------ */

function loadPatient(req, res) {
  const p = getPatient(req, req.params.id);
  if (!p) notFound(req, res, "Patient");
  return p;
}

function trtTab(req, res, patient, { form = null, v = {}, e = {} } = {}, status = 200) {
  const db = req.db;
  const u = req.user;
  const base = `/ehr/patients/${patient.id}`;
  const s = settings(db);
  const prog = program(db, patient.id);
  const labs = labsFor(db, patient.id);
  const doses = db.prepare(`SELECT d.*, u.name AS given_name, l.lot_number, l.expiration FROM trt_doses d LEFT JOIN users u ON u.id = d.given_by
    LEFT JOIN trt_lots l ON l.id = d.lot_id WHERE d.patient_id = ? ORDER BY d.given_on DESC, d.id DESC LIMIT 60`).all(patient.id);
  const visits = db.prepare("SELECT v.*, u.name AS entered_name FROM trt_visits v LEFT JOIN users u ON u.id = v.entered_by WHERE v.patient_id = ? ORDER BY visit_date DESC, id DESC LIMIT 30").all(patient.id);
  audit(req, "view", "trt", null, patient.id);
  const t = today();
  const flags = flagsFor(prog, labs, s, t);
  const last = doses.find((d) => !d.voided_at) || null;
  const nextDose = nextDoseDue(prog, last);
  const labsDue = nextLabsDue(prog, labs, s);
  const people = canWrite(u) ? staff(db) : [];
  const openLots = canWrite(u) ? lots(db).filter((l) => l.on_hand > 0) : [];
  const fe = (name) => (form === name ? e : {});
  const fv = (name, dflt) => (form === name ? v : dflt);

  const pv = fv("program", prog ? { ...prog, dose_mg: fmtNum(prog.dose_mg, 2), prescriber_id: prog.prescriber_id || "" }
    : { status: "evaluating", medication: "cypionate", route: "im", frequency_days: "7", start_date: "", prescriber_id: can(u, "clinical:write") && u.role === "clinician" ? u.id : "" });
  const programForm = canWrite(u) ? html`
    <details class="loc-action" ${form === "program" || !prog ? raw("open") : ""}>
      <summary class="btn btn--${prog ? "sm" : "primary btn--sm"}">${prog ? "Update regimen" : "Start a TRT program"}</summary>
      <form method="post" action="${base}/trt/program" class="stack" novalidate>
        ${csrfField(req)}${errorSummary(fe("program"))}
        <div class="form-grid">
          <label>Status ${select("status", STATUSES.map((x) => ({ value: x, label: humanize(x) })), pv.status)}${errText(fe("program"), "status")}</label>
          <label>Medication ${select("medication", opt(MEDICATIONS.map((m) => ({ value: m.value, label: m.label }))), pv.medication)}${errText(fe("program"), "medication")}</label>
          <label>Route ${select("route", ROUTES, pv.route)}${errText(fe("program"), "route")}</label>
          <label>Dose (mg)<input type="number" step="any" min="0" name="dose_mg" value="${pv.dose_mg ?? ""}" inputmode="decimal">${errText(fe("program"), "dose_mg")}</label>
          <label>Every (days)<input type="number" min="1" max="365" name="frequency_days" value="${pv.frequency_days ?? ""}" inputmode="numeric"><span class="hint">7 = weekly, 14 = every 2 weeks</span>${errText(fe("program"), "frequency_days")}</label>
          <label>Start date<input type="date" name="start_date" value="${pv.start_date || ""}">${errText(fe("program"), "start_date")}</label>
          <label>Prescriber ${select("prescriber_id", opt(people.map((p) => ({ value: p.id, label: staffLabel(p) })), "Not set"), pv.prescriber_id)}${errText(fe("program"), "prescriber_id")}</label>
          <label class="span-all">Other medications for this program <span class="hint">(optional, e.g. an aromatase inhibitor or hCG, with dose)</span><input type="text" name="ancillary" maxlength="500" value="${pv.ancillary || ""}"></label>
          <label class="span-all">Goals / indication <span class="hint">(symptoms, confirmed low testosterone on two morning draws, shared decision)</span><textarea name="goals" rows="2" maxlength="1000">${pv.goals || ""}</textarea></label>
          <label class="span-all">If stopped or paused, why<input type="text" name="stop_reason" maxlength="500" value="${pv.stop_reason || ""}">${errText(fe("program"), "stop_reason")}</label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">${prog ? "Save regimen" : "Start program"}</button></div>
      </form>
    </details>` : "";

  const programCard = html`
    <section class="card loc-current" aria-labelledby="trt-reg">
      <div class="card__head"><h2 id="trt-reg">Testosterone therapy</h2>${prog ? html`<span class="badge badge--${STATUS_TONE[prog.status]}">${humanize(prog.status)}</span>` : ""}</div>
      ${prog ? html`
        <div class="loc-now">
          <div class="loc-now__level">${medLabel(prog.medication)}${prog.dose_mg != null ? html` · ${fmtNum(prog.dose_mg, 2)} mg` : ""}${prog.frequency_days ? html` every ${prog.frequency_days === 7 ? "week" : `${prog.frequency_days} days`}` : ""}</div>
          <div class="muted">${prog.route ? `${routeLabel(prog.route)} · ` : ""}${prog.start_date ? `started ${fmtDate(prog.start_date)}` : "not started"}${prog.prescriber_name ? ` · prescriber ${prog.prescriber_name}${prog.prescriber_cred ? `, ${prog.prescriber_cred}` : ""}` : ""}</div>
          ${prog.ancillary ? html`<p class="small"><span class="muted">Also:</span> ${prog.ancillary}</p>` : ""}
          ${prog.goals ? html`<p class="loc-now__why">${prog.goals}</p>` : ""}
          ${prog.stop_reason && prog.status !== "active" ? html`<p class="small"><span class="muted">${humanize(prog.status)}:</span> ${prog.stop_reason}</p>` : ""}
        </div>
        <dl class="trt-due">
          <div><dt>Last dose</dt><dd>${last ? html`${fmtDate(last.given_on)} <span class="muted small">(${last.kind === "dispensed" ? "dispensed" : "in clinic"})</span>` : html`<span class="muted">None recorded</span>`}</dd></div>
          <div><dt>Next dose due</dt><dd>${nextDose ? html`<span class="${nextDose < t ? "text-bad" : ""}">${fmtDate(nextDose)}</span>` : html`<span class="muted">—</span>`}</dd></div>
          <div><dt>Labs due</dt><dd>${labsDue ? html`<span class="${labsDue < t ? "text-bad" : ""}">${fmtDate(labsDue)}</span>` : html`<span class="muted">—</span>`}</dd></div>
        </dl>` : html`<p class="muted">No testosterone therapy recorded for this client.</p>`}
      ${flags.length ? html`<ul class="trt-flags" aria-label="Alerts">${flags.map((f) => html`<li class="alert alert--${f.tone === "bad" ? "error" : f.tone === "warn" ? "warn" : "info"}">${f.text}</li>`)}</ul>` : ""}
      ${prog && flags.some((f) => f.tone === "bad") ? html`<p class="hint">Alert levels are set by your medical director on the <a href="/ehr/trt/settings">hormone therapy settings</a> page. They are reminders, not orders.</p>` : ""}
      ${rxSummary(db, u, patient)}
      ${programForm}
    </section>`;

  const lv = fv("labs", { drawn_on: t, timing: "" });
  const labsCard = html`
    <section class="card" id="labs" aria-labelledby="trt-labs">
      <div class="card__head"><h2 id="trt-labs">Labs</h2><span class="muted small">${labs.length} draw${labs.length === 1 ? "" : "s"}</span></div>
      ${labs.length ? html`<div class="table-wrap"><table class="table trt-labs">
        <thead><tr><th>Drawn</th>${LABS.map((l) => html`<th class="num">${l.label}<br><span class="small muted">${l.unit}</span></th>`)}</tr></thead>
        <tbody>${labs.map((r) => html`<tr>
          <td>${fmtDate(r.drawn_on)}${r.timing ? html`<br><span class="small muted">${humanize(r.timing)}</span>` : ""}${r.notes ? html`<br><span class="small muted" title="${r.notes}">has notes</span>` : ""}</td>
          ${LABS.map((l) => {
            const val = r[l.key];
            const hot = (l.key === "hematocrit" && val > s.hct_max) || (l.key === "psa" && val > s.psa_max);
            return html`<td class="num ${hot ? "text-bad" : ""}">${val == null ? html`<span class="muted">—</span>` : fmtNum(val, l.key === "psa" ? 2 : 1)}${hot ? html` <span class="visually-hidden">(above alert level)</span>` : ""}</td>`;
          })}
        </tr>`)}</tbody></table></div>` : html`<p class="muted">No labs recorded yet.</p>`}
      ${canWrite(u) ? html`
        <details class="loc-action" ${form === "labs" ? raw("open") : ""}>
          <summary class="btn btn--sm">Add lab results</summary>
          <form method="post" action="${base}/trt/labs" class="stack" novalidate>
            ${csrfField(req)}${errorSummary(fe("labs"))}
            <div class="form-grid">
              <label>Date drawn<input type="date" name="drawn_on" value="${lv.drawn_on || ""}" max="${t}">${errText(fe("labs"), "drawn_on")}</label>
              <label>Timing ${select("timing", TIMINGS, lv.timing)}${errText(fe("labs"), "timing")}</label>
              ${LABS.map((l) => html`<label>${l.label} <span class="hint">${l.unit}</span><input type="number" step="any" min="0" name="${l.key}" value="${lv[l.key] || ""}" inputmode="decimal">${errText(fe("labs"), l.key)}</label>`)}
              <label class="span-all">Notes <span class="hint">(lab name, fasting, reference ranges)</span><textarea name="notes" rows="2" maxlength="1000">${lv.notes || ""}</textarea></label>
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Save labs</button></div>
          </form>
        </details>` : ""}
    </section>`;

  const dvDefault = { given_on: t, kind: "administered", medication: prog ? prog.medication : "cypionate", dose_mg: prog && prog.dose_mg != null ? fmtNum(prog.dose_mg, 2) : "", days_supply: prog && prog.frequency_days ? String(prog.frequency_days * 4) : "" };
  const dv = fv("dose", dvDefault);
  const jcode = prog && MED[prog.medication] ? MED[prog.medication].jcode : "";
  const dosesCard = html`
    <section class="card" id="doses" aria-labelledby="trt-doses">
      <div class="card__head"><h2 id="trt-doses">Doses</h2><span class="muted small">Given in clinic or dispensed for home</span></div>
      ${doses.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Type</th><th>Medication</th><th class="num">Dose</th><th>Lot</th><th>Site</th><th>By</th><th></th></tr></thead>
        <tbody>${doses.map((d) => html`<tr class="${d.voided_at ? "is-voided" : ""}">
          <td>${fmtDate(d.given_on)}</td>
          <td>${d.kind === "dispensed" ? html`Dispensed${d.days_supply ? html`<br><span class="small muted">${d.days_supply}-day supply</span>` : ""}` : "In clinic"}</td>
          <td>${medLabel(d.medication)}</td>
          <td class="num">${d.dose_mg != null ? `${fmtNum(d.dose_mg, 2)} mg` : ""}${d.volume_ml != null ? html`<br><span class="small muted">${ml(d.volume_ml)}</span>` : ""}</td>
          <td class="small">${d.lot_number ? html`${d.lot_number}<br><span class="muted">exp ${fmtDate(d.expiration)}</span>` : html`<span class="muted">—</span>`}</td>
          <td>${d.site || html`<span class="muted">—</span>`}</td>
          <td class="small">${d.given_name || ""}</td>
          <td>${d.voided_at ? html`<span class="badge badge--neutral" title="${d.void_reason || ""}">Voided</span>` : canWrite(u) ? html`
            <details class="loc-edit"><summary class="small">Void</summary>
              <form method="post" action="${base}/trt/doses/${d.id}/void" class="stack" novalidate>${csrfField(req)}
                <label>Reason <input type="text" name="void_reason" maxlength="300" required placeholder="e.g. entered on the wrong client"></label>
                ${form === `void-${d.id}` ? errorSummary(e) : ""}
                <button class="btn btn--sm" type="submit">Void dose</button>
                ${d.lot_id ? html`<p class="hint">${ml(d.volume_ml)} goes back on lot ${d.lot_number}.</p>` : ""}
              </form></details>` : ""}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">No doses recorded.</p>`}
      ${canWrite(u) ? html`
        <details class="loc-action" ${form === "dose" ? raw("open") : ""}>
          <summary class="btn btn--primary btn--sm">Record a dose</summary>
          <form method="post" action="${base}/trt/doses" class="stack" novalidate>
            ${csrfField(req)}${errorSummary(fe("dose"))}
            <div class="form-grid">
              <label>Date<input type="date" name="given_on" value="${dv.given_on || ""}" max="${t}">${errText(fe("dose"), "given_on")}</label>
              <label>Type ${select("kind", [{ value: "administered", label: "Given in clinic" }, { value: "dispensed", label: "Dispensed for home use" }], dv.kind)}${errText(fe("dose"), "kind")}</label>
              <label>Medication ${select("medication", MEDICATIONS.map((m) => ({ value: m.value, label: m.label })), dv.medication)}${errText(fe("dose"), "medication")}</label>
              <label>From stock (lot) ${select("lot_id", opt(openLots.map((l) => ({ value: l.id, label: `${l.product} · lot ${l.lot_number} · exp ${fmtDate(l.expiration)} · ${ml(l.on_hand)} left` })), "Not from clinic stock"), dv.lot_id)}${errText(fe("dose"), "lot_id")}</label>
              <label>Dose (mg)<input type="number" step="any" min="0" name="dose_mg" value="${dv.dose_mg ?? ""}" inputmode="decimal">${errText(fe("dose"), "dose_mg")}</label>
              <label>Volume (mL) <span class="hint">(blank = worked out from the lot's strength)</span><input type="number" step="any" min="0" name="volume_ml" value="${dv.volume_ml ?? ""}" inputmode="decimal">${errText(fe("dose"), "volume_ml")}</label>
              <label>Injection site ${select("site", SITES.map((x) => ({ value: x, label: x || "Not applicable" })), dv.site)}</label>
              <label>Days supply <span class="hint">(dispensed only)</span><input type="number" min="1" max="180" name="days_supply" value="${dv.days_supply ?? ""}" inputmode="numeric">${errText(fe("dose"), "days_supply")}</label>
              <label class="span-all">Notes<input type="text" name="notes" maxlength="500" value="${dv.notes || ""}"></label>
            </div>
            ${last && last.site ? html`<p class="hint">Last site: ${last.site}. Rotate sites.</p>` : ""}
            <div class="form-actions"><button class="btn btn--primary" type="submit">Save dose</button></div>
            ${jcode ? html`<p class="hint">Billing: injection given in clinic is usually 96372 plus ${jcode} (units per your payer). Confirm codes with your biller.</p>` : ""}
          </form>
        </details>` : ""}
    </section>`;

  const vv = fv("visit", { visit_date: t });
  const visitsCard = html`
    <section class="card" id="visits" aria-labelledby="trt-visits">
      <div class="card__head"><h2 id="trt-visits">Vitals &amp; symptom check</h2><span class="muted small">0 = worst, 10 = best</span></div>
      ${visits.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>BP</th><th class="num">HR</th><th class="num">Weight</th>${SYMPTOMS.map((x) => html`<th class="num">${x.label}</th>`)}<th>Side effects</th></tr></thead>
        <tbody>${visits.map((r) => html`<tr>
          <td>${fmtDate(r.visit_date)}</td>
          <td class="${r.bp_sys >= 140 || r.bp_dia >= 90 ? "text-bad" : ""}">${r.bp_sys != null ? `${r.bp_sys}/${r.bp_dia}` : html`<span class="muted">—</span>`}</td>
          <td class="num">${r.heart_rate ?? ""}</td><td class="num">${r.weight_lb != null ? `${fmtNum(r.weight_lb)} lb` : ""}</td>
          ${SYMPTOMS.map((x) => html`<td class="num">${r[x.key] ?? ""}</td>`)}
          <td class="small">${r.side_effects || ""}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">No visit checks recorded.</p>`}
      ${canWrite(u) ? html`
        <details class="loc-action" ${form === "visit" ? raw("open") : ""}>
          <summary class="btn btn--sm">Add a visit check</summary>
          <form method="post" action="${base}/trt/visits" class="stack" novalidate>
            ${csrfField(req)}${errorSummary(fe("visit"))}
            <div class="form-grid">
              <label>Date<input type="date" name="visit_date" value="${vv.visit_date || ""}" max="${t}">${errText(fe("visit"), "visit_date")}</label>
              <label>BP systolic<input type="number" name="bp_sys" min="50" max="260" value="${vv.bp_sys || ""}" inputmode="numeric">${errText(fe("visit"), "bp_sys")}</label>
              <label>BP diastolic<input type="number" name="bp_dia" min="30" max="160" value="${vv.bp_dia || ""}" inputmode="numeric">${errText(fe("visit"), "bp_dia")}</label>
              <label>Heart rate<input type="number" name="heart_rate" min="20" max="250" value="${vv.heart_rate || ""}" inputmode="numeric">${errText(fe("visit"), "heart_rate")}</label>
              <label>Weight (lb)<input type="number" step="any" name="weight_lb" min="50" max="900" value="${vv.weight_lb || ""}" inputmode="decimal">${errText(fe("visit"), "weight_lb")}</label>
              ${SYMPTOMS.map((x) => html`<label>${x.label} (0–10)<input type="number" name="${x.key}" min="0" max="10" value="${vv[x.key] || ""}" inputmode="numeric">${errText(fe("visit"), x.key)}</label>`)}
              <label class="span-all">Side effects <span class="hint">(acne, swelling, breast tenderness, sleep apnea symptoms, mood change)</span><textarea name="side_effects" rows="2" maxlength="1000">${vv.side_effects || ""}</textarea></label>
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Save visit check</button></div>
          </form>
        </details>` : ""}
    </section>`;

  res.status(status).send(chartPage(req, patient, "trt", html`${programCard}${dosesCard}${labsCard}${visitsCard}`, { title: `Hormone therapy · ${patientName(patient)}` }));
}

const chart = [requireEnabled];

router.get("/patients/:id/trt", chart, gate(canView), (req, res) => {
  const p = loadPatient(req, res);
  if (p) trtTab(req, res, p);
});

router.post("/patients/:id/trt/program", chart, gate(canWrite), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const db = req.db;
  const { v, e, vals } = readProgram(req.body || {}, db);
  if (Object.keys(e).length) return trtTab(req, res, p, { form: "program", v, e }, 400);
  const prev = program(db, p.id);
  const row = [v.status, v.medication, vals.dose_mg, v.route || (MED[v.medication].route || null), vals.frequency_days, v.ancillary || null, vals.prescriber_id,
    v.start_date || null, v.goals || null, v.status === "active" ? null : v.stop_reason || null];
  if (prev) {
    db.prepare(`UPDATE trt_programs SET status = ?, medication = ?, dose_mg = ?, route = ?, frequency_days = ?, ancillary = ?, prescriber_id = ?,
      start_date = ?, goals = ?, stop_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(...row, prev.id);
    const changed = [];
    if (prev.status !== v.status) changed.push(`status ${prev.status} -> ${v.status}`);
    if (prev.dose_mg !== vals.dose_mg || prev.frequency_days !== vals.frequency_days || prev.medication !== v.medication) changed.push("regimen changed");
    audit(req, "update", "trt_program", prev.id, p.id, changed.join("; ") || "details");
    req.flash("success", "Regimen saved.");
  } else {
    const r = db.prepare(`INSERT INTO trt_programs (status, medication, dose_mg, route, frequency_days, ancillary, prescriber_id, start_date, goals, stop_reason, patient_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...row, p.id, req.user.id);
    audit(req, "create", "trt_program", Number(r.lastInsertRowid), p.id, `status ${v.status}`);
    req.flash("success", "TRT program started.");
  }
  res.redirect(`/ehr/patients/${p.id}/trt`);
});

router.post("/patients/:id/trt/labs", chart, gate(canWrite), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const { v, e, vals } = readLabs(req.body || {});
  if (Object.keys(e).length) return trtTab(req, res, p, { form: "labs", v, e }, 400);
  const r = req.db.prepare(`INSERT INTO trt_labs (patient_id, drawn_on, timing, ${LABS.map((l) => l.key).join(", ")}, notes, entered_by)
    VALUES (?, ?, ?, ${LABS.map(() => "?").join(", ")}, ?, ?)`).run(p.id, v.drawn_on, v.timing || null, ...LABS.map((l) => vals[l.key]), v.notes || null, req.user.id);
  audit(req, "create", "trt_lab", Number(r.lastInsertRowid), p.id);
  const flags = flagsFor(program(req.db, p.id), labsFor(req.db, p.id), settings(req.db)).filter((f) => f.tone === "bad" && ["hct", "psa", "psa_rise"].includes(f.key));
  req.flash(flags.length ? "error" : "success", flags.length ? `Labs saved. Check: ${flags.map((f) => f.text).join("; ")}.` : "Labs saved.");
  res.redirect(`/ehr/patients/${p.id}/trt#labs`);
});

router.post("/patients/:id/trt/doses", chart, gate(canWrite), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const db = req.db;
  const b = req.body || {};
  const v = { given_on: str(b.given_on, 10), kind: str(b.kind, 20), medication: str(b.medication, 40), lot_id: str(b.lot_id, 10), dose_mg: str(b.dose_mg, 12),
    volume_ml: str(b.volume_ml, 12), site: str(b.site, 40), days_supply: str(b.days_supply, 4), notes: str(b.notes, 500) };
  const e = {};
  if (!isDate(v.given_on)) e.given_on = "Enter the date.";
  else if (v.given_on > today()) e.given_on = "The date can't be in the future.";
  if (!["administered", "dispensed"].includes(v.kind)) e.kind = "Choose given in clinic or dispensed.";
  if (!MED[v.medication]) e.medication = "Choose the medication.";
  if (v.site && !SITES.includes(v.site)) v.site = "Other";
  const dose = numField(v.dose_mg, { min: 0.1, max: 5000, label: "Dose" });
  if (dose.error) e.dose_mg = dose.error;
  const vol = numField(v.volume_ml, { min: 0.01, max: 100, label: "Volume" });
  if (vol.error) e.volume_ml = vol.error;
  const supply = numField(v.days_supply, { min: 1, max: 180, int: true, label: "Days supply" });
  if (supply.error) e.days_supply = supply.error;
  if (v.kind === "dispensed" && supply.n == null && !e.days_supply) e.days_supply = "Enter the days supply dispensed.";
  if (dose.n == null && !e.dose_mg) e.dose_mg = "Enter the dose in mg.";
  let lot = null, volume = vol.n;
  if (v.lot_id) {
    lot = db.prepare("SELECT * FROM trt_lots WHERE id = ?").get(Number(v.lot_id));
    if (!lot || lot.closed_at) e.lot_id = "That lot isn't open.";
    else if (!e.given_on && lot.expiration < v.given_on) e.lot_id = `Lot ${lot.lot_number} expired ${fmtDate(lot.expiration)}. Waste it from inventory and use another lot.`;
    else {
      if (volume == null && dose.n != null) volume = Math.round((dose.n / lot.concentration_mg_ml) * 100) / 100;
      const have = onHand(db, lot.id);
      if (volume != null && volume > have + 1e-9) e.volume_ml = `Only ${ml(have)} left on lot ${lot.lot_number}.`;
      if (dose.n != null && vol.n != null && Math.abs(dose.n - vol.n * lot.concentration_mg_ml) > 0.05 * dose.n + 0.5) e.volume_ml = `${ml(vol.n)} of ${fmtNum(lot.concentration_mg_ml, 0)} mg/mL is ${fmtNum(vol.n * lot.concentration_mg_ml, 1)} mg, not ${fmtNum(dose.n, 1)} mg.`;
    }
  }
  if (Object.keys(e).length) return trtTab(req, res, p, { form: "dose", v, e }, 400);
  const run = db.prepare(`INSERT INTO trt_doses (patient_id, given_on, kind, medication, lot_id, dose_mg, volume_ml, days_supply, site, notes, given_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  let doseId;
  try {
    doseId = Number(run.run(p.id, v.given_on, v.kind, v.medication, lot ? lot.id : null, dose.n, volume, v.kind === "dispensed" ? supply.n : null, v.site || null, v.notes || null, req.user.id).lastInsertRowid);
    if (lot) db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, patient_id, dose_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(lot.id, v.kind, -volume, v.given_on, p.id, doseId, req.user.id);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  audit(req, "create", "trt_dose", doseId, p.id, `${v.kind}${lot ? ` lot#${lot.id}` : ""}`);
  req.flash("success", v.kind === "dispensed" ? "Dispensed supply recorded." : "Dose recorded.");
  res.redirect(`/ehr/patients/${p.id}/trt#doses`);
});

router.post("/patients/:id/trt/doses/:did/void", chart, gate(canWrite), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const db = req.db;
  const d = db.prepare("SELECT * FROM trt_doses WHERE id = ? AND patient_id = ?").get(Number(req.params.did), p.id);
  if (!d) return notFound(req, res, "Dose");
  if (d.voided_at) { req.flash("info", "That dose was already voided."); return res.redirect(`/ehr/patients/${p.id}/trt#doses`); }
  const reason = str((req.body || {}).void_reason, 300);
  if (!reason) return trtTab(req, res, p, { form: `void-${d.id}`, e: { void_reason: "Say why this dose is being voided." } }, 400);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE trt_doses SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ?").run(req.user.id, reason, d.id);
    if (d.lot_id && d.volume_ml) db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, patient_id, dose_id, reason, user_id) VALUES (?, 'void', ?, ?, ?, ?, ?, ?)")
      .run(d.lot_id, d.volume_ml, today(), p.id, d.id, reason, req.user.id);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  audit(req, "void", "trt_dose", d.id, p.id);
  req.flash("success", "Dose voided.");
  res.redirect(`/ehr/patients/${p.id}/trt#doses`);
});

router.post("/patients/:id/trt/visits", chart, gate(canWrite), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const { v, e, vals } = readVisit(req.body || {});
  if (Object.keys(e).length) return trtTab(req, res, p, { form: "visit", v, e }, 400);
  const keys = ["bp_sys", "bp_dia", "heart_rate", "weight_lb", ...SYMPTOMS.map((s) => s.key)];
  const r = req.db.prepare(`INSERT INTO trt_visits (patient_id, visit_date, ${keys.join(", ")}, side_effects, entered_by) VALUES (?, ?, ${keys.map(() => "?").join(", ")}, ?, ?)`)
    .run(p.id, v.visit_date, ...keys.map((k) => vals[k]), v.side_effects || null, req.user.id);
  audit(req, "create", "trt_visit", Number(r.lastInsertRowid), p.id);
  req.flash("success", "Visit check saved.");
  res.redirect(`/ehr/patients/${p.id}/trt#visits`);
});

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function trtTabs(active) {
  const tabs = [["", "Clients"], ["/inventory", "Controlled-substance stock"], ["/settings", "Alert settings"]];
  return html`<nav class="tabs" aria-label="Hormone therapy sections">${tabs.map(([path, label]) => html`<a href="/ehr/trt${path}" ${path === active ? raw('aria-current="page"') : ""}>${label}</a>`)}</nav>`;
}

/** Rows for the overview (and the dashboard): every non-stopped program with its due dates and flags. */
function overviewRows(db, t = today()) {
  const s = settings(db);
  const progs = db.prepare(`SELECT p.*, pt.first_name, pt.last_name, pt.preferred_name, pt.mrn FROM trt_programs p JOIN patients pt ON pt.id = p.patient_id
    WHERE p.status <> 'stopped' ORDER BY pt.last_name, pt.first_name`).all();
  return progs.map((pr) => {
    const labs = labsFor(db, pr.patient_id);
    const last = lastDose(db, pr.patient_id);
    const flags = flagsFor(pr, labs, s, t);
    const next = nextDoseDue(pr, last);
    const rank = flags.filter((f) => f.tone === "bad").length * 10 + flags.filter((f) => f.tone === "warn").length + (next && next < t ? 5 : 0);
    return { pr, last, next, labsDue: nextLabsDue(pr, labs, s), flags, rank };
  }).sort((a, b) => b.rank - a.rank);
}

router.get("/trt", requireEnabled, gate(canView), (req, res) => {
  const db = req.db;
  const t = today();
  const rows = overviewRows(db, t);
  const stock = lots(db);
  const lowOrExpiring = stock.filter((l) => l.expiration <= addDays(t, 30) || l.on_hand <= 2);
  audit(req, "view", "trt", null, null, "overview");
  const count = (fn) => rows.filter(fn).length;
  res.send(page(req, { title: "Hormone therapy", active: "trt", body: html`
    <div class="page-head"><div><h1>Hormone therapy</h1><p>Clients on testosterone replacement: who is due for a dose or labs, and who needs review.</p></div></div>
    ${trtTabs("")}
    <div class="tiles">
      <div class="tile"><span class="tile__num">${count((r) => r.pr.status === "active")}</span><span class="tile__label">On therapy</span></div>
      <div class="tile"><span class="tile__num">${count((r) => r.flags.some((f) => f.tone === "bad" && !f.key.startsWith("labs")))}</span><span class="tile__label">Lab alerts</span></div>
      <div class="tile"><span class="tile__num">${count((r) => r.flags.some((f) => f.key === "labs_overdue"))}</span><span class="tile__label">Labs overdue</span></div>
      <div class="tile"><span class="tile__num">${count((r) => r.next && r.next <= t)}</span><span class="tile__label">Dose due today or late</span></div>
    </div>
    ${lowOrExpiring.length ? html`<div class="alert alert--warn" role="note">${lowOrExpiring.length} lot${lowOrExpiring.length === 1 ? " is" : "s are"} low or expiring within 30 days. <a href="/ehr/trt/inventory">Check stock</a></div>` : ""}
    <section class="card">
      ${rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Client</th><th>Regimen</th><th>Last dose</th><th>Next dose</th><th>Labs due</th><th>Alerts</th></tr></thead>
        <tbody>${rows.map(({ pr, last, next, labsDue, flags }) => html`<tr>
          <td><a href="/ehr/patients/${pr.patient_id}/trt">${patientName(pr)}</a><br><span class="small muted">MRN ${pr.mrn}</span></td>
          <td>${medLabel(pr.medication)}${pr.dose_mg != null ? html`<br><span class="small muted">${fmtNum(pr.dose_mg, 2)} mg${pr.frequency_days ? ` every ${pr.frequency_days} d` : ""}</span>` : ""}${pr.status !== "active" ? html`<br><span class="badge badge--${STATUS_TONE[pr.status]}">${humanize(pr.status)}</span>` : ""}</td>
          <td>${last ? fmtDate(last.given_on) : html`<span class="muted">—</span>`}</td>
          <td>${next ? html`<span class="${next < t ? "text-bad" : ""}">${fmtDate(next)}</span>` : html`<span class="muted">—</span>`}</td>
          <td>${labsDue ? html`<span class="${labsDue < t ? "text-bad" : ""}">${fmtDate(labsDue)}</span>` : html`<span class="muted">—</span>`}</td>
          <td>${flags.length ? flags.map((f) => html`<span class="badge badge--${f.tone === "bad" ? "bad" : f.tone === "warn" ? "warn" : "info"}" title="${f.text}">${f.text.split(":")[0]}</span> `) : html`<span class="badge badge--ok">OK</span>`}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">No clients on hormone therapy yet. Open a client's chart and choose the <strong>Hormone therapy</strong> tab to start a program.</p>`}
    </section>` }));
});

/* ------------------------------------------------------------------ */
/* Controlled-substance stock                                          */
/* ------------------------------------------------------------------ */

const EVENT_LABEL = { received: "Received", administered: "Given in clinic", dispensed: "Dispensed", wasted: "Wasted", adjustment: "Count correction", void: "Dose voided (returned)" };

function ledgerRows(db, lotId = null, limit = 200) {
  return db.prepare(`SELECT g.*, l.product, l.lot_number, u.name AS user_name, w.name AS witness_name, pt.mrn
    FROM trt_ledger g JOIN trt_lots l ON l.id = g.lot_id LEFT JOIN users u ON u.id = g.user_id LEFT JOIN users w ON w.id = g.witness_id
    LEFT JOIN patients pt ON pt.id = g.patient_id ${lotId ? "WHERE g.lot_id = ?" : ""} ORDER BY g.id DESC LIMIT ${Number(limit)}`).all(...(lotId ? [lotId] : []));
}

function inventoryPage(req, res, { form = null, v = {}, e = {} } = {}, status = 200) {
  const db = req.db;
  const u = req.user;
  const t = today();
  const all = lots(db, { open: false });
  const open = all.filter((l) => !l.closed_at);
  const ledger = ledgerRows(db);
  const people = staff(db).filter((p) => p.id !== u.id);
  const fe = (n) => (form === n ? e : {});
  const fv = (n, d) => (form === n ? v : d);
  const rv = fv("receive", { received_on: t, product: "Testosterone cypionate 200 mg/mL", concentration_mg_ml: "200" });
  const wv = fv("waste", {});
  const av = fv("adjust", {});
  const lotOptions = (sel) => select("lot_id", opt(open.map((l) => ({ value: l.id, label: `${l.product} · lot ${l.lot_number} · ${ml(l.on_hand)} on hand` }))), sel);
  audit(req, "view", "trt_inventory", null, null);
  res.status(status).send(page(req, { title: "Controlled-substance stock", active: "trt", body: html`
    <div class="page-head"><div><h1>Hormone therapy</h1><p>Testosterone is Schedule III. Every lot received, dose given, supply dispensed and amount wasted is kept here and can't be edited or deleted.</p></div>
      <a class="btn btn--sm" href="/ehr/trt/inventory.csv">Download record (CSV)</a></div>
    ${trtTabs("/inventory")}
    ${form ? errorSummary(e) : ""}
    <section class="card" aria-labelledby="inv-lots">
      <div class="card__head"><h2 id="inv-lots">Lots</h2><span class="muted small">${open.length} open</span></div>
      ${all.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th>Lot</th><th>Expires</th><th class="num">Strength</th><th class="num">Received</th><th class="num">On hand</th><th>Status</th></tr></thead>
        <tbody>${all.map((l) => {
          const expired = l.expiration < t;
          const soon = !expired && l.expiration <= addDays(t, 30);
          return html`<tr class="${l.closed_at ? "is-voided" : ""}">
            <td>${l.product}${l.ndc ? html`<br><span class="small muted">NDC ${l.ndc}</span>` : ""}</td>
            <td>${l.lot_number}<br><span class="small muted">rec'd ${fmtDate(l.received_on)}${l.supplier ? ` · ${l.supplier}` : ""}${l.invoice ? ` · inv ${l.invoice}` : ""}</span></td>
            <td class="${expired ? "text-bad" : ""}">${fmtDate(l.expiration)}${expired ? html` <span class="badge badge--bad">Expired</span>` : soon ? html` <span class="badge badge--warn">Soon</span>` : ""}</td>
            <td class="num">${fmtNum(l.concentration_mg_ml, 0)} mg/mL</td>
            <td class="num">${ml(l.received)}</td>
            <td class="num"><strong>${ml(l.on_hand)}</strong></td>
            <td>${l.closed_at ? html`<span class="badge badge--neutral">Closed</span>` : canWrite(u) && l.on_hand <= 0.0001 ? html`
              <form method="post" action="/ehr/trt/inventory/lots/${l.id}/close">${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit">Close lot</button></form>` : html`<span class="badge badge--ok">Open</span>`}</td>
          </tr>`;
        })}</tbody></table></div>` : html`<p class="muted">No stock recorded. Receive your first lot below.</p>`}
    </section>
    ${canWrite(u) ? html`<div class="grid grid--2">
      <form class="card stack" method="post" action="/ehr/trt/inventory/lots" novalidate>
        ${csrfField(req)}<h2>Receive a lot</h2>
        <div class="form-grid">
          <label class="span-all">Product<input type="text" name="product" maxlength="120" value="${rv.product || ""}" required>${errText(fe("receive"), "product")}</label>
          <label>NDC <span class="hint">(optional)</span><input type="text" name="ndc" maxlength="20" value="${rv.ndc || ""}"></label>
          <label>Lot number<input type="text" name="lot_number" maxlength="60" value="${rv.lot_number || ""}" required>${errText(fe("receive"), "lot_number")}</label>
          <label>Expiration<input type="date" name="expiration" value="${rv.expiration || ""}" required>${errText(fe("receive"), "expiration")}</label>
          <label>Strength (mg/mL)<input type="number" step="any" min="0" name="concentration_mg_ml" value="${rv.concentration_mg_ml || ""}" required>${errText(fe("receive"), "concentration_mg_ml")}</label>
          <label>Amount received (mL)<input type="number" step="any" min="0" name="quantity_ml" value="${rv.quantity_ml || ""}" required><span class="hint">e.g. 10 vials × 1 mL = 10</span>${errText(fe("receive"), "quantity_ml")}</label>
          <label>Date received<input type="date" name="received_on" value="${rv.received_on || ""}" max="${t}">${errText(fe("receive"), "received_on")}</label>
          <label>Supplier<input type="text" name="supplier" maxlength="120" value="${rv.supplier || ""}"></label>
          <label>Invoice / DEA 222 # <span class="hint">(optional)</span><input type="text" name="invoice" maxlength="60" value="${rv.invoice || ""}"></label>
        </div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Add to stock</button></div>
      </form>
      <div class="stack">
        <form class="card stack" method="post" action="/ehr/trt/inventory/waste" novalidate>
          ${csrfField(req)}<h2>Waste</h2>
          <p class="hint">Expired, damaged or leftover drug. A second staff member must witness.</p>
          <div class="form-grid">
            <label class="span-all">Lot ${lotOptions(wv.lot_id)}${errText(fe("waste"), "lot_id")}</label>
            <label>Amount (mL)<input type="number" step="any" min="0" name="quantity_ml" value="${wv.quantity_ml || ""}">${errText(fe("waste"), "quantity_ml")}</label>
            <label>Witness ${select("witness_id", opt(people.map((p) => ({ value: p.id, label: staffLabel(p) }))), wv.witness_id)}${errText(fe("waste"), "witness_id")}</label>
            <label class="span-all">Reason<input type="text" name="reason" maxlength="300" value="${wv.reason || ""}" placeholder="e.g. expired; vial dropped">${errText(fe("waste"), "reason")}</label>
          </div>
          <div class="form-actions"><button class="btn" type="submit">Record waste</button></div>
        </form>
        ${can(u, "admin") ? html`
        <form class="card stack" method="post" action="/ehr/trt/inventory/adjust" novalidate>
          ${csrfField(req)}<h2>Count correction</h2>
          <p class="hint">Only when a physical count doesn't match. Use a minus sign to remove stock. Investigate and report losses as your DEA registration requires.</p>
          <div class="form-grid">
            <label class="span-all">Lot ${lotOptions(av.lot_id)}${errText(fe("adjust"), "lot_id")}</label>
            <label>Change (mL)<input type="number" step="any" name="quantity_ml" value="${av.quantity_ml || ""}">${errText(fe("adjust"), "quantity_ml")}</label>
            <label class="span-all">Reason<input type="text" name="reason" maxlength="300" value="${av.reason || ""}">${errText(fe("adjust"), "reason")}</label>
          </div>
          <div class="form-actions"><button class="btn" type="submit">Record correction</button></div>
        </form>` : ""}
      </div>
    </div>` : ""}
    <section class="card" aria-labelledby="inv-log">
      <div class="card__head"><h2 id="inv-log">Running record</h2><span class="muted small">Newest first · last ${ledger.length}</span></div>
      ${ledger.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Event</th><th>Lot</th><th class="num">mL</th><th>Client</th><th>By</th><th>Witness</th><th>Reason</th></tr></thead>
        <tbody>${ledger.map((g) => html`<tr>
          <td>${fmtDate(g.occurred_on)}</td><td>${EVENT_LABEL[g.event] || humanize(g.event)}</td>
          <td class="small">${g.lot_number}</td>
          <td class="num ${g.quantity_ml < 0 ? "" : "text-ok"}">${g.quantity_ml > 0 ? "+" : ""}${fmtNum(g.quantity_ml, 2)}</td>
          <td>${g.patient_id ? html`<a href="/ehr/patients/${g.patient_id}/trt">MRN ${g.mrn}</a>` : html`<span class="muted">—</span>`}</td>
          <td class="small">${g.user_name || ""}</td><td class="small">${g.witness_name || ""}</td><td class="small">${g.reason || ""}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing recorded yet.</p>`}
      <p class="hint">Keep this record (and your DEA 222 forms / invoices) for at least two years, and take a physical inventory at least every two years. Check your state's rules too.</p>
    </section>` }));
}

router.get("/trt/inventory", requireEnabled, gate(canView), (req, res) => inventoryPage(req, res));

router.post("/trt/inventory/lots", requireEnabled, gate(canWrite), (req, res) => {
  const b = req.body || {};
  const v = {};
  for (const k of ["product", "ndc", "lot_number", "expiration", "concentration_mg_ml", "quantity_ml", "received_on", "supplier", "invoice"]) v[k] = str(b[k], 120);
  const e = {};
  if (!v.product) e.product = "Enter the product.";
  if (!v.lot_number) e.lot_number = "Enter the lot number.";
  if (!isDate(v.expiration)) e.expiration = "Enter the expiration date.";
  if (!isDate(v.received_on)) e.received_on = "Enter the date received.";
  else if (v.received_on > today()) e.received_on = "The date received can't be in the future.";
  const conc = numField(v.concentration_mg_ml, { min: 1, max: 1000, label: "Strength" });
  if (conc.error || conc.n == null) e.concentration_mg_ml = conc.error || "Enter the strength in mg/mL.";
  const qty = numField(v.quantity_ml, { min: 0.1, max: 10000, label: "Amount" });
  if (qty.error || qty.n == null) e.quantity_ml = qty.error || "Enter the amount received in mL.";
  if (!e.lot_number && req.db.prepare("SELECT 1 FROM trt_lots WHERE lot_number = ? AND product = ? AND closed_at IS NULL").get(v.lot_number, v.product)) e.lot_number = "That lot is already open. Use a count correction to add to it.";
  if (Object.keys(e).length) return inventoryPage(req, res, { form: "receive", v, e }, 400);
  const db = req.db;
  db.exec("BEGIN");
  let lotId;
  try {
    lotId = Number(db.prepare(`INSERT INTO trt_lots (product, ndc, lot_number, expiration, concentration_mg_ml, supplier, invoice, received_on, received_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.product, v.ndc || null, v.lot_number, v.expiration, conc.n, v.supplier || null, v.invoice || null, v.received_on, req.user.id).lastInsertRowid);
    db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, user_id) VALUES (?, 'received', ?, ?, ?)").run(lotId, qty.n, v.received_on, req.user.id);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  audit(req, "create", "trt_lot", lotId, null, `received ${qty.n} mL`);
  req.flash("success", `Lot ${v.lot_number} added: ${ml(qty.n)}.`);
  res.redirect("/ehr/trt/inventory");
});

router.post("/trt/inventory/waste", requireEnabled, gate(canWrite), (req, res) => {
  const db = req.db;
  const b = req.body || {};
  const v = { lot_id: str(b.lot_id, 10), quantity_ml: str(b.quantity_ml, 12), witness_id: str(b.witness_id, 10), reason: str(b.reason, 300) };
  const e = {};
  const lot = v.lot_id ? db.prepare("SELECT * FROM trt_lots WHERE id = ? AND closed_at IS NULL").get(Number(v.lot_id)) : null;
  if (!lot) e.lot_id = "Choose an open lot.";
  const qty = numField(v.quantity_ml, { min: 0.01, max: 10000, label: "Amount" });
  if (qty.error || qty.n == null) e.quantity_ml = qty.error || "Enter the amount wasted.";
  else if (lot && qty.n > onHand(db, lot.id) + 1e-9) e.quantity_ml = `Only ${ml(onHand(db, lot.id))} on hand.`;
  const w = v.witness_id ? db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('admin', 'clinician')").get(Number(v.witness_id)) : null;
  if (!w) e.witness_id = "Choose a witness.";
  else if (w.id === req.user.id) e.witness_id = "The witness must be someone else.";
  if (!v.reason) e.reason = "Say why it was wasted.";
  if (Object.keys(e).length) return inventoryPage(req, res, { form: "waste", v, e }, 400);
  const r = db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, witness_id, reason, user_id) VALUES (?, 'wasted', ?, ?, ?, ?, ?)")
    .run(lot.id, -qty.n, today(), w.id, v.reason, req.user.id);
  audit(req, "create", "trt_ledger", Number(r.lastInsertRowid), null, `wasted ${qty.n} mL lot#${lot.id}`);
  req.flash("success", `Recorded ${ml(qty.n)} wasted from lot ${lot.lot_number}.`);
  res.redirect("/ehr/trt/inventory");
});

router.post("/trt/inventory/adjust", requireEnabled, gate((u) => can(u, "admin")), (req, res) => {
  const db = req.db;
  const b = req.body || {};
  const v = { lot_id: str(b.lot_id, 10), quantity_ml: str(b.quantity_ml, 12), reason: str(b.reason, 300) };
  const e = {};
  const lot = v.lot_id ? db.prepare("SELECT * FROM trt_lots WHERE id = ? AND closed_at IS NULL").get(Number(v.lot_id)) : null;
  if (!lot) e.lot_id = "Choose an open lot.";
  const qty = numField(v.quantity_ml, { min: -10000, max: 10000, label: "Change" });
  if (qty.error || !qty.n) e.quantity_ml = qty.error || "Enter the change in mL (use a minus sign to remove).";
  else if (lot && onHand(db, lot.id) + qty.n < -1e-9) e.quantity_ml = "That would make the amount on hand negative.";
  if (!v.reason) e.reason = "Say why the count is being corrected.";
  if (Object.keys(e).length) return inventoryPage(req, res, { form: "adjust", v, e }, 400);
  const r = db.prepare("INSERT INTO trt_ledger (lot_id, event, quantity_ml, occurred_on, reason, user_id) VALUES (?, 'adjustment', ?, ?, ?, ?)")
    .run(lot.id, qty.n, today(), v.reason, req.user.id);
  audit(req, "create", "trt_ledger", Number(r.lastInsertRowid), null, `adjustment ${qty.n} mL lot#${lot.id}`);
  req.flash("success", "Count correction recorded.");
  res.redirect("/ehr/trt/inventory");
});

router.post("/trt/inventory/lots/:lid/close", requireEnabled, gate(canWrite), (req, res) => {
  const db = req.db;
  const lot = db.prepare("SELECT * FROM trt_lots WHERE id = ? AND closed_at IS NULL").get(Number(req.params.lid));
  if (!lot) return notFound(req, res, "Lot");
  if (onHand(db, lot.id) > 0.0001) { req.flash("error", `Lot ${lot.lot_number} still has stock. Use it, or record it as wasted, before closing.`); return res.redirect("/ehr/trt/inventory"); }
  db.prepare("UPDATE trt_lots SET closed_at = datetime('now') WHERE id = ?").run(lot.id);
  audit(req, "update", "trt_lot", lot.id, null, "closed");
  req.flash("success", `Lot ${lot.lot_number} closed.`);
  res.redirect("/ehr/trt/inventory");
});

router.get("/trt/inventory.csv", requireEnabled, gate(canView), (req, res) => {
  const rows = ledgerRows(req.db, null, 100000).reverse();
  const q = (x) => { const s = String(x ?? ""); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
  const lines = [["date", "event", "product", "lot", "quantity_ml", "client_mrn", "recorded_by", "witness", "reason", "recorded_at"].join(",")];
  for (const g of rows) lines.push([g.occurred_on, g.event, g.product, g.lot_number, fmtNum(g.quantity_ml, 2), g.mrn, g.user_name, g.witness_name, g.reason, g.created_at].map(q).join(","));
  audit(req, "export", "trt_inventory", null, null, `${rows.length} rows`);
  res.set("content-type", "text/csv; charset=utf-8").set("content-disposition", `attachment; filename="controlled-substance-record-${today()}.csv"`).send(lines.join("\n") + "\n");
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTING_FIELDS = [
  { key: "hct_max", label: "Hematocrit alert above (%)", min: 40, max: 70, hint: "Guideline: consider holding therapy above 54%." },
  { key: "psa_max", label: "PSA alert above (ng/mL)", min: 0.5, max: 20, hint: "Guideline: urology evaluation for a confirmed PSA above 4." },
  { key: "psa_rise", label: "PSA rise alert within 12 months (ng/mL)", min: 0.1, max: 10, hint: "Guideline: a rise of more than 1.4." },
  { key: "t_low", label: "Target total testosterone, low (ng/dL)", min: 100, max: 1500, hint: "Guideline aims for the mid-normal range." },
  { key: "t_high", label: "Target total testosterone, high (ng/dL)", min: 200, max: 2000, hint: "" },
  { key: "first_labs_days", label: "First labs after starting (days)", min: 14, max: 365, int: true, hint: "Guideline: 3–6 months (90–180 days)." },
  { key: "labs_every_days", label: "Then labs every (days)", min: 30, max: 400, int: true, hint: "Guideline minimum is yearly (365); many clinics check every 6 months." },
];

function settingsPage(req, res, { v = null, e = {} } = {}, status = 200) {
  const s = settings(req.db);
  v = v || s;
  const admin = can(req.user, "admin");
  res.status(status).send(page(req, { title: "Hormone therapy settings", active: "trt", body: html`
    <div class="page-head"><div><h1>Hormone therapy</h1><p>When the app raises an alert, and when labs come due. Your medical director should confirm these.</p></div></div>
    ${trtTabs("/settings")}
    <form class="card stack" method="post" action="/ehr/trt/settings" novalidate>
      ${csrfField(req)}${errorSummary(e)}
      <fieldset ${admin ? "" : raw("disabled")}><legend class="visually-hidden">Thresholds</legend>
      <div class="form-grid">${SETTING_FIELDS.map((f) => html`
        <label>${f.label}<input type="number" step="any" name="${f.key}" value="${v[f.key] ?? ""}" min="${f.min}" max="${f.max}">${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}${errText(e, f.key)}</label>`)}
      </div></fieldset>
      ${admin ? html`<div class="form-actions"><button class="btn btn--primary" type="submit">Save settings</button></div>` : html`<p class="hint">Only an administrator can change these.</p>`}
      <p class="small muted">Defaults follow the Endocrine Society clinical practice guideline <em>Testosterone Therapy in Men with Hypogonadism</em> (Bhasin et al., J Clin Endocrinol Metab 2018). Alerts are reminders for the prescriber, not treatment decisions.</p>
    </form>` }));
}

router.get("/trt/settings", requireEnabled, gate(canView), (req, res) => settingsPage(req, res));

router.post("/trt/settings", requireEnabled, gate((u) => can(u, "admin")), (req, res) => {
  const b = req.body || {};
  const v = {}, e = {}, vals = {};
  for (const f of SETTING_FIELDS) {
    v[f.key] = str(b[f.key], 12);
    const r = numField(v[f.key], { min: f.min, max: f.max, int: f.int, label: f.label });
    if (r.error || r.n == null) e[f.key] = r.error || `${f.label} is required.`; else vals[f.key] = r.n;
  }
  if (!e.t_low && !e.t_high && vals.t_low >= vals.t_high) e.t_high = "The high end of the target must be above the low end.";
  if (Object.keys(e).length) return settingsPage(req, res, { v, e }, 400);
  settings(req.db);
  req.db.prepare(`UPDATE trt_settings SET ${SETTING_FIELDS.map((f) => `${f.key} = ?`).join(", ")}, updated_by = ?, updated_at = datetime('now') WHERE id = 1`)
    .run(...SETTING_FIELDS.map((f) => vals[f.key]), req.user.id);
  audit(req, "update", "trt_settings", 1, null);
  req.flash("success", "Hormone therapy settings saved.");
  res.redirect("/ehr/trt/settings");
});

module.exports = { router, trtEnabled, setTrtEnabled, settings, flagsFor, nextDoseDue, nextLabsDue, bannerPill, overviewRows, MEDICATIONS };
