"use strict";
/*
 * Scheduling: week/day calendar, appointment create/edit/reschedule, status changes,
 * and the patient chart "Appointments" tab.
 */
const express = require("express");
const { tx } = require("../db");
const { requirePerm } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const {
  html, raw, page, chartPage, notFound, csrfField, select, badge, getPatient, patientName,
  today, addDays, fmtDate, fmtTime, fmtDateTime, fmtTimestamp, humanize,
} = require("../views");

const router = express.Router();

const { apptColors, colorFor } = require("../appt-colors");
const TYPES = ["intake", "therapy", "psychiatry_eval", "med_management", "family", "group", "consult"];
const MODALITIES = ["in_person", "telehealth"];
const STATUSES = ["scheduled", "checked_in", "completed", "no_show", "cancelled", "late_cancel"];
const CANCEL_STATUSES = ["cancelled", "late_cancel"];
const PAST_ONLY_STATUSES = ["completed", "no_show"];
const EDITABLE_STATUSES = ["scheduled", "checked_in"];
const DURATIONS = [30, 45, 50, 60, 90];
const MAX_REPEAT = 12;
const STATUS_LABELS = {
  scheduled: "Scheduled", checked_in: "Checked in", completed: "Completed", no_show: "No-show",
  cancelled: "Cancelled", late_cancel: "Late cancel",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/** Add minutes to a clinic-local 'YYYY-MM-DDTHH:MM' string (pure calendar math, no time zones). */
function addMinutes(local, mins) {
  const d = new Date(local + ":00Z");
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16);
}
function minutesBetween(a, b) {
  return Math.round((new Date(b + ":00Z") - new Date(a + ":00Z")) / 60000);
}
/** Monday of the week containing ymd. */
function mondayOf(ymd) {
  const dow = new Date(ymd + "T12:00:00Z").getUTCDay(); // 0 = Sun
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}
function weekdayLabel(ymd) {
  return new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
}
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
function safeReturn(v, fallback) {
  return typeof v === "string" && v.startsWith("/ehr/") && !v.startsWith("//") && !/[\r\n\\]/.test(v) ? v : fallback;
}

function activeClinicians(db) {
  return db.prepare("SELECT id, name, credentials FROM users WHERE role = 'clinician' AND active = 1 ORDER BY name").all();
}
function activePatients(db) {
  return db.prepare(
    "SELECT id, first_name, last_name, preferred_name, mrn FROM patients WHERE status = 'active' ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE").all();
}
const clinicianLabel = (u) => `${u.name}${u.credentials ? `, ${u.credentials}` : ""}`;

function loadAppt(db, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.mrn, u.name AS clinician_name, u.credentials AS clinician_credentials,
            cb.name AS created_by_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = a.clinician_id
     LEFT JOIN users cb ON cb.id = a.created_by WHERE a.id = ?`).get(Number(id)) || null;
}

/** Non-cancelled appointments for the clinician that overlap [start, end), excluding excludeId. */
function findConflicts(db, clinicianId, start, end, excludeId = null) {
  return db.prepare(
    `SELECT id, start_at, end_at FROM appointments
     WHERE clinician_id = ? AND status NOT IN ('cancelled','late_cancel')
       AND start_at < ? AND end_at > ? AND id != ? ORDER BY start_at`).all(clinicianId, end, start, excludeId == null ? -1 : excludeId);
}
function conflictText(c) {
  return `${fmtDate(c.start_at)} ${fmtTime(c.start_at)}–${fmtTime(c.end_at)}`;
}

/* ------------------------------------------------------------------ */
/* Form parsing + rendering                                           */
/* ------------------------------------------------------------------ */
function str(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}

/**
 * Validate the appointment form. Returns { v, errors, start, end }.
 * `existing` (edit) keeps the patient fixed and allows its current (possibly non-standard) duration.
 */
function parseForm(db, body, existing = null) {
  const v = {
    patient_id: existing ? String(existing.patient_id) : str(body.patient_id, 20),
    clinician_id: str(body.clinician_id, 20),
    date: str(body.date, 10),
    time: str(body.time, 5),
    duration: str(body.duration, 4),
    type: str(body.type, 40),
    modality: str(body.modality, 40) || "in_person",
    location: str(body.location, 200),
    telehealth_url: str(body.telehealth_url, 500),
    notes: str(body.notes, 2000),
    repeat_weeks: str(body.repeat_weeks, 3) || "1",
  };
  const errors = {};

  if (!existing) {
    const p = /^\d+$/.test(v.patient_id) ? db.prepare("SELECT id, status FROM patients WHERE id = ?").get(Number(v.patient_id)) : null;
    if (!p) errors.patient_id = "Choose a patient.";
    else if (p.status !== "active") errors.patient_id = "This patient is not active.";
  }
  const clin = /^\d+$/.test(v.clinician_id)
    ? db.prepare("SELECT id FROM users WHERE id = ? AND role = 'clinician' AND active = 1").get(Number(v.clinician_id)) : null;
  if (!clin) errors.clinician_id = "Choose an active clinician.";
  if (!validDate(v.date)) errors.date = "Enter a valid date.";
  if (!TIME_RE.test(v.time)) errors.time = "Enter a valid start time.";
  const dur = Number(v.duration);
  const existingDur = existing ? minutesBetween(existing.start_at, existing.end_at) : null;
  if (!DURATIONS.includes(dur) && dur !== existingDur) errors.duration = "Choose a duration.";
  if (!TYPES.includes(v.type)) errors.type = "Choose an appointment type.";
  if (!MODALITIES.includes(v.modality)) errors.modality = "Choose in person or telehealth.";
  if (v.telehealth_url) {
    let ok = false;
    try { ok = /^https:\/\//i.test(v.telehealth_url) && new URL(v.telehealth_url).protocol === "https:"; } catch { ok = false; }
    if (!ok) errors.telehealth_url = "Telehealth link must be a valid https:// URL.";
  }
  if (!existing) {
    const n = Number(v.repeat_weeks);
    if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) errors.repeat_weeks = `Repeat must be between 1 and ${MAX_REPEAT} weeks.`;
  }

  let start = null;
  let end = null;
  if (!errors.date && !errors.time && !errors.duration) {
    start = `${v.date}T${v.time}`;
    end = addMinutes(start, dur);
    if (!(end > start)) errors.time = "End time must be after start time.";
    else if (end.slice(0, 10) !== v.date) errors.duration = "Appointment must end on the same day it starts.";
  }
  return { v, errors, start, end };
}

function fieldError(errors, k) {
  return errors[k] ? html`<span class="error-text" id="${k}-error">${errors[k]}</span>` : "";
}
function described(errors, k) {
  return errors[k] ? raw(`aria-invalid="true" aria-describedby="${k}-error"`) : "";
}

function apptForm(req, { v, errors = {}, conflicts = [], action, existing = null, cancelHref }) {
  const db = req.db;
  const errList = Object.values(errors);
  const clinicians = activeClinicians(db);
  const patients = existing ? [] : activePatients(db);
  const durOpts = [...DURATIONS];
  if (v.duration && /^\d+$/.test(v.duration) && !durOpts.includes(Number(v.duration))) durOpts.push(Number(v.duration));
  durOpts.sort((a, b) => a - b);

  return html`
    ${errList.length || conflicts.length ? html`
      <div class="alert alert--error" role="alert">
        <strong>Please fix the following:</strong>
        <ul class="list">
          ${errList.map((e) => html`<li>${e}</li>`)}
          ${conflicts.map((c) => html`<li>Scheduling conflict: this clinician already has an appointment ${conflictText(c)} (<a href="/ehr/appointments/${c.id}">view</a>).</li>`)}
        </ul>
      </div>` : ""}
    <form method="post" action="${action}" class="card" data-dirty-check novalidate>
      ${csrfField(req)}
      <div class="form-grid">
        ${existing ? html`
          <div class="span-all"><span class="muted small">Patient</span><br><strong>${patientName(existing)}</strong> <span class="muted">MRN ${existing.mrn}</span></div>`
        : html`
          <label for="patient_id">Patient
            <select name="patient_id" id="patient_id" required ${described(errors, "patient_id")}>
              <option value="">Select a patient…</option>
              ${patients.map((p) => html`<option value="${p.id}" ${String(p.id) === v.patient_id ? raw("selected") : ""}>${patientName(p)} · ${p.mrn}</option>`)}
            </select>
            ${fieldError(errors, "patient_id")}
          </label>`}
        <label for="clinician_id">Clinician
          <select name="clinician_id" id="clinician_id" required ${described(errors, "clinician_id")}>
            <option value="">Select a clinician…</option>
            ${clinicians.map((u) => html`<option value="${u.id}" ${String(u.id) === v.clinician_id ? raw("selected") : ""}>${clinicianLabel(u)}</option>`)}
          </select>
          ${fieldError(errors, "clinician_id")}
        </label>
        <label for="date">Date
          <input type="date" name="date" id="date" value="${v.date}" required ${described(errors, "date")}>
          ${fieldError(errors, "date")}
        </label>
        <label for="time">Start time
          <input type="time" name="time" id="time" value="${v.time}" step="300" required ${described(errors, "time")}>
          ${fieldError(errors, "time")}
        </label>
        <label for="duration">Duration
          ${select("duration", durOpts.map((d) => ({ value: d, label: `${d} minutes` })), v.duration, errors.duration ? 'aria-invalid="true" aria-describedby="duration-error"' : "")}
          ${fieldError(errors, "duration")}
        </label>
        <label for="type">Type
          ${select("type", [{ value: "", label: "Select a type…" }, ...TYPES], v.type, errors.type ? 'aria-invalid="true" aria-describedby="type-error"' : "")}
          ${fieldError(errors, "type")}
        </label>
        <label for="modality">Modality
          ${select("modality", MODALITIES, v.modality)}
          ${fieldError(errors, "modality")}
        </label>
        <label for="location">Location <span class="hint">e.g. Office 2</span>
          <input type="text" name="location" id="location" value="${v.location}" maxlength="200">
        </label>
        <label for="telehealth_url">Telehealth link <span class="hint">https:// only</span>
          <input type="url" name="telehealth_url" id="telehealth_url" value="${v.telehealth_url}" maxlength="500" placeholder="https://" ${described(errors, "telehealth_url")}>
          ${fieldError(errors, "telehealth_url")}
        </label>
        ${existing ? "" : html`
          <label for="repeat_weeks">Repeat
            ${select("repeat_weeks", [{ value: 1, label: "Does not repeat" },
              ...Array.from({ length: MAX_REPEAT - 1 }, (_, i) => ({ value: i + 2, label: `Weekly for ${i + 2} weeks` }))], v.repeat_weeks,
              errors.repeat_weeks ? 'aria-invalid="true" aria-describedby="repeat_weeks-error"' : "")}
            <span class="hint">Weeks with a conflict are skipped and reported.</span>
            ${fieldError(errors, "repeat_weeks")}
          </label>`}
        <label for="notes" class="span-all">Scheduling notes <span class="hint">Logistics only. Do not put clinical information here.</span>
          <textarea name="notes" id="notes" maxlength="2000">${v.notes}</textarea>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">${existing ? "Save changes" : "Schedule appointment"}</button>
        <a class="btn btn--ghost" href="${cancelHref}">Cancel</a>
      </div>
    </form>`;
}

/* ------------------------------------------------------------------ */
/* Schedule: week + day views                                          */
/* ------------------------------------------------------------------ */
function statusActions(req, a, returnTo) {
  if (!can(req.user, "schedule:write")) return "";
  const t = today();
  const started = a.start_at.slice(0, 10) <= t;
  const btn = (status, label, extra = "") => html`
    <form method="post" action="/ehr/appointments/${a.id}/status" class="inline-form">
      ${csrfField(req)}
      <input type="hidden" name="status" value="${status}">
      <input type="hidden" name="return_to" value="${returnTo}">
      <button class="btn btn--sm ${extra}" type="submit">${label}</button>
    </form>`;
  const out = [];
  if (a.status === "scheduled") out.push(btn("checked_in", "Check in"));
  if (a.status === "scheduled" && can(req.user, "schedule:write") && String(a.start_at).slice(0, 10) === today()) {
    out.push(html`<form method="post" action="/ehr/appointments/${a.id}/checkin-link" class="inline-form">${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit" title="Send the client a link to check in on their phone">Phone check-in link</button></form>`);
  }
  if ((a.status === "scheduled" || a.status === "checked_in") && started) {
    out.push(btn("completed", "Complete"));
    out.push(btn("no_show", "No-show", "btn--danger"));
  }
  return html`<div class="row">${out}</div>`;
}

router.get("/schedule", requirePerm("schedule:read"), (req, res) => {
  const db = req.db;
  const u = req.user;
  const t = today();
  const date = validDate(req.query.date) ? req.query.date : t;
  const view = req.query.view === "day" ? "day" : "week";
  const clinicians = activeClinicians(db);
  let clinician = req.query.clinician;
  if (clinician === undefined || clinician === "") clinician = u.role === "clinician" ? String(u.id) : "all";
  if (clinician !== "all" && !/^\d+$/.test(String(clinician))) clinician = "all";
  const clinicianId = clinician === "all" ? null : Number(clinician);
  const filterUser = clinicianId ? db.prepare("SELECT id, name, credentials FROM users WHERE id = ?").get(clinicianId) : null;
  // Include an inactive/non-clinician filter target in the dropdown so the selection is visible.
  const clinOpts = [...clinicians];
  if (filterUser && !clinOpts.some((c) => c.id === filterUser.id)) clinOpts.push(filterUser);

  const from = view === "day" ? date : mondayOf(date);
  const days = view === "day" ? [date] : Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const to = addDays(days[days.length - 1], 1);
  const appts = db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, us.name AS clinician_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users us ON us.id = a.clinician_id
     WHERE a.start_at >= ? AND a.start_at < ? ${clinicianId ? "AND a.clinician_id = ?" : ""}
     ORDER BY a.start_at, us.name`).all(...(clinicianId ? [from, to, clinicianId] : [from, to]));
  audit(req, "view", "schedule", null, null, `${view} ${from} clinician=${clinician}`);

  const step = view === "day" ? 1 : 7;
  const link = (d, extra = {}) => `/ehr/schedule${qs({ date: d, clinician, view: view === "day" ? "day" : null, ...extra })}`;
  const selfUrl = link(date);
  const rangeLabel = view === "day"
    ? `${weekdayLabel(date)}, ${fmtDate(date)}`
    : `${fmtDate(days[0])} – ${fmtDate(days[6])}`;
  const showClin = !clinicianId;

  const toolbar = html`
    <div class="card">
      <div class="row">
        <a class="btn btn--sm" href="${link(addDays(date, -step))}" aria-label="Previous ${view}">&larr; Prev</a>
        <a class="btn btn--sm" href="${link(t)}">Today</a>
        <a class="btn btn--sm" href="${link(addDays(date, step))}" aria-label="Next ${view}">Next &rarr;</a>
        <strong>${rangeLabel}</strong>
        <span class="muted small">${appts.length} appointment${appts.length === 1 ? "" : "s"}</span>
      </div>
      <form method="get" action="/ehr/schedule" class="row" style="margin-top:.75rem">
        <label for="clinician">Clinician
          ${select("clinician", [{ value: "all", label: "All clinicians" }, ...clinOpts.map((c) => ({ value: c.id, label: clinicianLabel(c) }))], clinician)}
        </label>
        <label for="date-filter">Date
          <input type="date" name="date" id="date-filter" value="${date}">
        </label>
        <label for="view">View
          ${select("view", [{ value: "week", label: "Week" }, { value: "day", label: "Day" }], view)}
        </label>
        <button class="btn btn--sm" type="submit">Show</button>
      </form>
    </div>`;

  const colors = apptColors(req.db);
  const legend = html`<div class="appt-legend" aria-label="Appointment colors">${TYPES.map((ty) => html`<span><span class="type-dot" style="--appt:${colorFor(colors, ty)}"></span>${humanize(ty)}</span>`)}
    ${can(u, "admin") ? html`<a class="small" href="/ehr/admin/appointment-colors">Change colors</a>` : ""}</div>`;
  let content;
  if (view === "week") {
    content = html`
      <div class="cal">
        ${days.map((d) => {
          const list = appts.filter((a) => a.start_at.slice(0, 10) === d);
          return html`
            <section class="cal__day ${d === t ? "cal__day--today" : ""}" aria-label="${weekdayLabel(d)} ${fmtDate(d)}">
              <h3><a href="${link(d, { view: "day" })}">${weekdayLabel(d)} ${fmtDate(d).replace(/, \d{4}$/, "")}</a></h3>
              ${list.length ? list.map((a) => html`
                <a class="appt appt--${a.status}" style="--appt:${colorFor(colors, a.type)}" href="/ehr/appointments/${a.id}">
                  <strong>${fmtTime(a.start_at)}</strong> ${patientName(a)}<br>
                  <span class="small">${humanize(a.type)}${a.modality === "telehealth" ? " · Telehealth" : ""}${showClin ? ` · ${a.clinician_name}` : ""}${a.status !== "scheduled" ? ` · ${STATUS_LABELS[a.status]}` : ""}</span>
                </a>`) : html`<p class="muted small">No appointments</p>`}
              ${can(u, "schedule:write") ? html`<a class="small" href="/ehr/schedule/new${qs({ date: d, clinician_id: clinicianId })}">+ Add</a>` : ""}
            </section>`;
        })}
      </div>`;
  } else {
    content = html`
      <section class="card">
        ${appts.length ? html`
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Time</th><th>Patient</th>${showClin ? html`<th>Clinician</th>` : ""}<th>Type</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${appts.map((a) => html`
              <tr>
                <td><a href="/ehr/appointments/${a.id}">${fmtTime(a.start_at)}–${fmtTime(a.end_at)}</a></td>
                <td><a href="/ehr/patients/${a.patient_id}/appointments">${patientName(a)}</a></td>
                ${showClin ? html`<td>${a.clinician_name}</td>` : ""}
                <td><span class="type-dot" style="--appt:${colorFor(colors, a.type)}"></span>${humanize(a.type)}${a.modality === "telehealth" ? html` <span class="pill">Telehealth</span>` : ""}</td>
                <td>${badge(a.status, STATUS_LABELS[a.status])}</td>
                <td>${statusActions(req, a, selfUrl)}</td>
              </tr>`)}</tbody>
          </table></div>` : html`<p class="muted">No appointments on this day.</p>`}
      </section>`;
  }

  res.send(page(req, {
    title: "Schedule",
    active: "schedule",
    body: html`
      <div class="page-head">
        <h1>Schedule</h1>
        <div class="row">
          <a class="btn btn--sm" href="${link(date, { view: view === "day" ? "week" : "day" })}">${view === "day" ? "Week view" : "Day view"}</a>
          <a class="btn btn--sm" href="/ehr/checkins">Check-ins</a>
          ${can(u, "schedule:write") ? html`<a class="btn btn--primary" href="/ehr/schedule/new${qs({ date, clinician_id: clinicianId })}">New appointment</a>` : ""}
        </div>
      </div>
      ${toolbar}
      ${legend}
      ${content}`,
  }));
});

/* ------------------------------------------------------------------ */
/* Create                                                             */
/* ------------------------------------------------------------------ */
function newPage(req, res, { v, errors, conflicts, status = 200 }) {
  const back = v.patient_id && /^\d+$/.test(v.patient_id) ? `/ehr/patients/${v.patient_id}/appointments` : "/ehr/schedule";
  res.status(status).send(page(req, {
    title: "New appointment",
    active: "schedule",
    body: html`
      <div class="page-head"><h1>New appointment</h1></div>
      ${apptForm(req, { v, errors, conflicts, action: "/ehr/schedule", cancelHref: back })}`,
  }));
}

router.get("/schedule/new", requirePerm("schedule:write"), (req, res) => {
  const u = req.user;
  const q = req.query;
  let patientId = typeof q.patient_id === "string" && /^\d+$/.test(q.patient_id) ? q.patient_id : "";
  let clinicianId = typeof q.clinician_id === "string" && /^\d+$/.test(q.clinician_id) ? q.clinician_id : "";
  if (patientId) {
    const p = getPatient(req, patientId);
    if (!p) patientId = "";
    else if (!clinicianId && p.primary_clinician_id) clinicianId = String(p.primary_clinician_id);
  }
  if (!clinicianId && u.role === "clinician") clinicianId = String(u.id);
  const v = {
    patient_id: patientId,
    clinician_id: clinicianId,
    date: validDate(q.date) ? q.date : today(),
    time: typeof q.time === "string" && TIME_RE.test(q.time) ? q.time : "09:00",
    duration: "50",
    type: typeof q.type === "string" && TYPES.includes(q.type) ? q.type : "therapy",
    modality: "in_person",
    location: "",
    telehealth_url: "",
    notes: "",
    repeat_weeks: "1",
  };
  newPage(req, res, { v, errors: {} });
});

router.post("/schedule", requirePerm("schedule:write"), (req, res) => {
  const db = req.db;
  const { v, errors, start, end } = parseForm(db, req.body);
  if (Object.keys(errors).length) return newPage(req, res, { v, errors, status: 400 });

  const weeks = Number(v.repeat_weeks);
  const clinicianId = Number(v.clinician_id);
  const patientId = Number(v.patient_id);
  const occurrences = Array.from({ length: weeks }, (_, i) => {
    const s = `${addDays(v.date, i * 7)}T${v.time}`;
    return { start: s, end: `${s.slice(0, 10)}T${end.slice(11)}` };
  });
  void start;

  if (weeks === 1) {
    const conflicts = findConflicts(db, clinicianId, occurrences[0].start, occurrences[0].end);
    if (conflicts.length) return newPage(req, res, { v, errors: {}, conflicts, status: 409 });
  }

  const ins = db.prepare(
    `INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, location, telehealth_url, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = tx(db, () => {
    const created = [];
    const skipped = [];
    for (const o of occurrences) {
      const c = findConflicts(db, clinicianId, o.start, o.end);
      if (c.length) { skipped.push(o); continue; }
      const id = Number(ins.run(patientId, clinicianId, o.start, o.end, v.type, v.modality, v.location || null,
        v.telehealth_url || null, v.notes || null, req.user.id).lastInsertRowid);
      created.push(id);
      audit(req, "create", "appointment", id, patientId, weeks > 1 ? `series ${created.length}/${weeks}` : null);
    }
    return { created, skipped };
  });

  if (!result.created.length) {
    // Every week in the series conflicted: nothing was saved.
    const conflicts = occurrences.flatMap((o) => findConflicts(db, clinicianId, o.start, o.end));
    return newPage(req, res, { v, errors: {}, conflicts, status: 409 });
  }
  if (weeks > 1) {
    req.flash("success", `Scheduled ${result.created.length} of ${weeks} weekly appointments.`);
    if (result.skipped.length) {
      req.flash("error", `Skipped because of scheduling conflicts: ${result.skipped.map((o) => `${fmtDate(o.start)} ${fmtTime(o.start)}`).join("; ")}.`);
    }
  } else {
    req.flash("success", "Appointment scheduled.");
  }
  res.redirect(`/ehr/appointments/${result.created[0]}`);
});

/* ------------------------------------------------------------------ */
/* Detail                                                             */
/* ------------------------------------------------------------------ */
function statusForm(req, a) {
  if (!can(req.user, "schedule:write")) return "";
  const pastOk = a.start_at.slice(0, 10) <= today();
  const opts = STATUSES.filter((s) => s !== a.status && (pastOk || !PAST_ONLY_STATUSES.includes(s)))
    .map((s) => ({ value: s, label: STATUS_LABELS[s] }));
  return html`
    <section class="card">
      <h2>Update status</h2>
      <form method="post" action="/ehr/appointments/${a.id}/status" class="stack">
        ${csrfField(req)}
        <div class="form-grid">
          <label for="status">New status
            ${select("status", opts, "")}
          </label>
          <label for="reason" class="span-all">Cancellation reason <span class="hint">Required when cancelling. Saved in the scheduling notes.</span>
            <textarea name="reason" id="reason" maxlength="500"></textarea>
          </label>
        </div>
        ${pastOk ? "" : html`<p class="hint">Completed and no-show can be recorded on or after the appointment date.</p>`}
        <div class="form-actions"><button class="btn" type="submit">Update status</button></div>
      </form>
    </section>`;
}

router.get("/appointments/:id", requirePerm("schedule:read"), (req, res) => {
  const a = loadAppt(req.db, req.params.id);
  if (!a) return notFound(req, res, "Appointment");
  audit(req, "view", "appointment", a.id, a.patient_id);
  const u = req.user;
  const notes = can(u, "clinical:read")
    ? req.db.prepare("SELECT id, type, status, service_date FROM notes WHERE appointment_id = ? AND (type <> 'psychotherapy' OR author_id = ?) ORDER BY id").all(a.id, req.user.id) : [];
  const editable = EDITABLE_STATUSES.includes(a.status);

  res.send(page(req, {
    title: "Appointment",
    active: "schedule",
    body: html`
      <div class="page-head">
        <h1>${humanize(a.type)} · ${fmtDateTime(a.start_at)}</h1>
        <div class="row">
          <a class="btn btn--sm btn--ghost" href="/ehr/schedule${qs({ date: a.start_at.slice(0, 10), clinician: a.clinician_id, view: "day" })}">Back to schedule</a>
          ${can(u, "schedule:write") && editable ? html`<a class="btn btn--sm" href="/ehr/appointments/${a.id}/edit">Edit / reschedule</a>` : ""}
          ${can(u, "clinical:write") ? html`<a class="btn btn--sm btn--primary" href="/ehr/patients/${a.patient_id}/notes/new${qs({ appointment_id: a.id })}">Write note</a>` : ""}
        </div>
      </div>
      <div class="grid grid--2">
        <section class="card">
          <div class="card__head"><h2>Details</h2>${badge(a.status, STATUS_LABELS[a.status])}</div>
          <dl class="facts">
            <dt>Patient</dt><dd><a href="/ehr/patients/${a.patient_id}">${patientName(a)}</a> <span class="muted">MRN ${a.mrn}</span></dd>
            <dt>Clinician</dt><dd>${a.clinician_name}${a.clinician_credentials ? `, ${a.clinician_credentials}` : ""}</dd>
            <dt>Date</dt><dd>${weekdayLabel(a.start_at.slice(0, 10))}, ${fmtDate(a.start_at)}</dd>
            <dt>Time</dt><dd>${fmtTime(a.start_at)}–${fmtTime(a.end_at)} (${minutesBetween(a.start_at, a.end_at)} min)</dd>
            <dt>Type</dt><dd><span class="type-dot" style="--appt:${colorFor(apptColors(req.db), a.type)}"></span>${humanize(a.type)}</dd>
            <dt>Modality</dt><dd>${humanize(a.modality)}</dd>
            <dt>Location</dt><dd>${a.location || html`<span class="muted">Not set</span>`}</dd>
            ${a.telehealth_url ? html`<dt>Telehealth link</dt><dd><a href="${a.telehealth_url}" target="_blank" rel="noopener noreferrer">Join video visit</a></dd>` : ""}
            <dt>Created</dt><dd>${fmtTimestamp(a.created_at)}${a.created_by_name ? ` by ${a.created_by_name}` : ""}</dd>
          </dl>
          ${a.notes ? html`<h3 style="margin-top:1rem">Scheduling notes</h3><p class="prewrap">${a.notes}</p>` : ""}
          ${notes.length ? html`
            <h3 style="margin-top:1rem">Notes for this visit</h3>
            <ul class="list">${notes.map((n) => html`<li><a href="/ehr/notes/${n.id}">${humanize(n.type)} note</a> ${badge(n.status)}</li>`)}</ul>` : ""}
        </section>
        <div>
          ${statusForm(req, a)}
        </div>
      </div>`,
  }));
});

/* ------------------------------------------------------------------ */
/* Edit / reschedule                                                  */
/* ------------------------------------------------------------------ */
function editPage(req, res, a, { v, errors, conflicts, status = 200 }) {
  res.status(status).send(page(req, {
    title: "Edit appointment",
    active: "schedule",
    body: html`
      <div class="page-head"><h1>Edit appointment</h1></div>
      ${apptForm(req, { v, errors, conflicts, action: `/ehr/appointments/${a.id}/edit`, existing: a, cancelHref: `/ehr/appointments/${a.id}` })}`,
  }));
}

function loadEditable(req, res) {
  const a = loadAppt(req.db, req.params.id);
  if (!a) { notFound(req, res, "Appointment"); return null; }
  if (!EDITABLE_STATUSES.includes(a.status)) {
    req.flash("error", `A ${STATUS_LABELS[a.status].toLowerCase()} appointment can't be edited. Change its status first or schedule a new one.`);
    res.redirect(`/ehr/appointments/${a.id}`);
    return null;
  }
  return a;
}

router.get("/appointments/:id/edit", requirePerm("schedule:write"), (req, res) => {
  const a = loadEditable(req, res);
  if (!a) return;
  audit(req, "view", "appointment", a.id, a.patient_id, "edit form");
  const v = {
    patient_id: String(a.patient_id), clinician_id: String(a.clinician_id), date: a.start_at.slice(0, 10), time: a.start_at.slice(11, 16),
    duration: String(minutesBetween(a.start_at, a.end_at)), type: a.type, modality: a.modality, location: a.location || "",
    telehealth_url: a.telehealth_url || "", notes: a.notes || "",
  };
  editPage(req, res, a, { v, errors: {} });
});

router.post("/appointments/:id/edit", requirePerm("schedule:write"), (req, res) => {
  const db = req.db;
  const a = loadEditable(req, res);
  if (!a) return;
  const { v, errors, start, end } = parseForm(db, req.body, a);
  if (Object.keys(errors).length) return editPage(req, res, a, { v, errors, status: 400 });
  const conflicts = findConflicts(db, Number(v.clinician_id), start, end, a.id);
  if (conflicts.length) return editPage(req, res, a, { v, errors: {}, conflicts, status: 409 });

  const changed = [];
  if (start !== a.start_at || end !== a.end_at) changed.push("time");
  if (Number(v.clinician_id) !== a.clinician_id) changed.push("clinician");
  for (const k of ["type", "modality", "location", "telehealth_url", "notes"]) if ((v[k] || null) !== (a[k] || null)) changed.push(k);
  db.prepare(
    `UPDATE appointments SET clinician_id = ?, start_at = ?, end_at = ?, type = ?, modality = ?, location = ?, telehealth_url = ?, notes = ?,
       updated_at = datetime('now') WHERE id = ?`).run(Number(v.clinician_id), start, end, v.type, v.modality, v.location || null,
    v.telehealth_url || null, v.notes || null, a.id);
  audit(req, changed.includes("time") ? "reschedule" : "update", "appointment", a.id, a.patient_id,
    changed.length ? `changed: ${changed.join(",")}` : "no changes");
  req.flash("success", changed.includes("time") ? "Appointment rescheduled." : "Appointment updated.");
  res.redirect(`/ehr/appointments/${a.id}`);
});

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */
router.post("/appointments/:id/status", requirePerm("schedule:write"), (req, res) => {
  const db = req.db;
  const a = loadAppt(db, req.params.id);
  if (!a) return notFound(req, res, "Appointment");
  const back = safeReturn(req.body.return_to, `/ehr/appointments/${a.id}`);
  const status = String(req.body.status || "");
  const reason = str(req.body.reason, 500);
  const fail = (msg) => { req.flash("error", msg); return res.redirect(back); };

  if (!STATUSES.includes(status)) return fail("Choose a valid status.");
  if (status === a.status) return fail(`Appointment is already ${STATUS_LABELS[status].toLowerCase()}.`);
  if (PAST_ONLY_STATUSES.includes(status) && a.start_at.slice(0, 10) > today()) {
    return fail(`${STATUS_LABELS[status]} can only be recorded on or after the appointment date.`);
  }
  if (CANCEL_STATUSES.includes(status) && !reason) {
    return fail("A cancellation reason is required.");
  }
  // Reactivating a cancelled visit must not double-book the clinician.
  if (CANCEL_STATUSES.includes(a.status) && !CANCEL_STATUSES.includes(status)) {
    const c = findConflicts(db, a.clinician_id, a.start_at, a.end_at, a.id);
    if (c.length) return fail(`Can't restore this appointment: the clinician now has a conflicting appointment ${conflictText(c[0])}.`);
  }

  let notes = a.notes;
  if (CANCEL_STATUSES.includes(status)) {
    const line = `[${STATUS_LABELS[status]} ${today()} by ${req.user.name}] ${reason}`;
    notes = notes ? `${notes}\n${line}` : line;
  }
  db.prepare("UPDATE appointments SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(status, notes, a.id);
  audit(req, "status", "appointment", a.id, a.patient_id, `${a.status} -> ${status}`);
  req.flash("success", `Appointment marked ${STATUS_LABELS[status].toLowerCase()}.`);
  res.redirect(back);
});

/* ------------------------------------------------------------------ */
/* Patient chart tab                                                  */
/* ------------------------------------------------------------------ */
router.get("/patients/:id/appointments", requirePerm("schedule:read"), (req, res) => {
  const p = /^\d+$/.test(req.params.id) ? getPatient(req, req.params.id) : null;
  if (!p) return notFound(req, res, "Patient");
  audit(req, "view", "appointment", null, p.id, "chart appointments tab");
  const rows = req.db.prepare(
    `SELECT a.*, u.name AS clinician_name FROM appointments a JOIN users u ON u.id = a.clinician_id
     WHERE a.patient_id = ? ORDER BY a.start_at`).all(p.id);
  const t = today();
  const upcoming = rows.filter((a) => a.start_at.slice(0, 10) >= t && EDITABLE_STATUSES.includes(a.status));
  const past = rows.filter((a) => !upcoming.includes(a)).reverse();
  const counts = past.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {});

  const colors = apptColors(req.db);
  const table = (list, empty) => list.length ? html`
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Clinician</th><th>Status</th></tr></thead>
      <tbody>${list.map((a) => html`
        <tr>
          <td><a href="/ehr/appointments/${a.id}">${weekdayLabel(a.start_at.slice(0, 10))}, ${fmtDate(a.start_at)}</a></td>
          <td>${fmtTime(a.start_at)}–${fmtTime(a.end_at)}</td>
          <td><span class="type-dot" style="--appt:${colorFor(colors, a.type)}"></span>${humanize(a.type)}${a.modality === "telehealth" ? html` <span class="pill">Telehealth</span>` : ""}</td>
          <td>${a.clinician_name}</td>
          <td>${badge(a.status, STATUS_LABELS[a.status])}</td>
        </tr>`)}</tbody>
    </table></div>` : html`<p class="muted">${empty}</p>`;

  res.send(chartPage(req, p, "appointments", html`
    <section class="card">
      <div class="card__head">
        <h2>Upcoming appointments</h2>
        ${can(req.user, "schedule:write") && p.status === "active"
          ? html`<a class="btn btn--primary btn--sm" href="/ehr/schedule/new${qs({ patient_id: p.id })}">Schedule appointment</a>` : ""}
      </div>
      ${table(upcoming, "No upcoming appointments.")}
    </section>
    <section class="card">
      <div class="card__head">
        <h2>Past and cancelled appointments</h2>
        <span class="muted small">${["completed", "no_show", "cancelled", "late_cancel"].filter((s) => counts[s]).map((s) => `${STATUS_LABELS[s]}: ${counts[s]}`).join(" · ")}</span>
      </div>
      ${table(past, "No past appointments.")}
    </section>`, { title: `${patientName(p)} · Appointments` }));
});

module.exports = { router, findConflicts, addMinutes };
