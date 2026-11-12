"use strict";
const express = require("express");
const { can } = require("../permissions");
const { buildWorkboard, renderWorkboard } = require("../workboard");
const { urDue, authAlerts, LEVELS } = require("./loc");
const { apptColors, colorFor } = require("../appt-colors");
const { html, page, badge, fmtTime, fmtDate, today, addDays, nowLocal, patientName, humanize } = require("../views");

const router = express.Router();

router.get("/", (req, res) => {
  const db = req.db;
  const u = req.user;
  const t = today();
  const mineOnly = u.role === "clinician";
  const appts = can(u, "schedule:read") ? db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, us.name AS clinician_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users us ON us.id = a.clinician_id
     WHERE substr(a.start_at,1,10) = ? ${mineOnly ? "AND a.clinician_id = ?" : ""}
     ORDER BY a.start_at`).all(...(mineOnly ? [t, u.id] : [t])) : [];
  const drafts = can(u, "clinical:write")
    ? db.prepare("SELECT COUNT(*) AS n FROM notes WHERE author_id = ? AND status = 'draft'").get(u.id).n : null;
  const newRequests = can(u, "requests:manage")
    ? db.prepare("SELECT COUNT(*) AS n FROM appointment_requests WHERE status = 'new'").get().n : null;
  const unbilled = can(u, "billing:read")
    ? db.prepare("SELECT COUNT(*) AS n FROM charges WHERE status = 'unbilled'").get().n : null;
  const flags = can(u, "clinical:read") ? db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name FROM assessments a JOIN patients p ON p.id = a.patient_id
     WHERE a.flagged = 1 AND a.administered_on >= ?
     ${mineOnly ? "AND p.primary_clinician_id = ?" : ""} ORDER BY a.administered_on DESC LIMIT 10`).all(addDays(t, -14), ...(mineOnly ? [u.id] : [])) : [];

  // Treatment plans due for review in the next 7 days or overdue: own patients for clinicians, all for admins.
  const duePlans = can(u, "clinical:read") ? db.prepare(
    `SELECT tp.id, tp.patient_id, tp.review_date, tp.version, p.first_name, p.last_name, p.preferred_name
     FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id
     WHERE tp.status = 'active' AND tp.review_date IS NOT NULL AND tp.review_date <= ?
     ${mineOnly ? "AND (p.primary_clinician_id = ? OR tp.author_id = ?)" : ""}
     ORDER BY tp.review_date, p.last_name LIMIT 25`).all(addDays(t, 7), ...(mineOnly ? [u.id, u.id] : [])) : null;

  // Utilization reviews / authorizations needing action in the next 3 days (UR staff, clinicians for their own clients).
  const ur = can(u, "clinical:write") || can(u, "billing:write") ? urDue(db, { days: 3, clinicianId: mineOnly ? u.id : null }) : [];

  const colors = apptColors(db);
  const tile = (label, value, href) => value === null ? "" : html`
    <a class="tile" href="${href}"><span class="tile__num">${value}</span><span class="tile__label">${label}</span></a>`;

  res.send(page(req, {
    title: "Dashboard",
    active: "dashboard",
    body: html`
      <section class="hero">
        <div class="hero__text">
          <p class="hero__date">${fmtDate(t)}</p>
          <h1>Good ${Number(nowLocal().slice(11, 13)) < 12 ? "morning" : Number(nowLocal().slice(11, 13)) < 17 ? "afternoon" : "evening"}, ${u.name.split(" ")[0]}</h1>
          <p>${appts.length ? `${appts.length} appointment${appts.length === 1 ? "" : "s"} on ${mineOnly ? "your" : "the"} schedule today` : `No appointments on ${mineOnly ? "your" : "the"} schedule today`}</p>
        </div>
        <div class="hero__actions no-print">${can(u, "patients:write") ? html`<a class="btn btn--light" href="/ehr/patients/new">New patient</a>` : ""}${can(u, "schedule:write") ? html`<a class="btn btn--glass" href="/ehr/schedule/new">Book appointment</a>` : ""}</div>
      </section>
      ${can(u, "admin") && !require("../clinic").getClinic(db).billingReady ? html`<div class="alert alert--info" role="note"><strong>Finish your clinic setup:</strong> add your logo, group NPI, tax ID and address so they appear on superbills and printouts. <a href="/ehr/admin/clinic">Open Clinic settings</a></div>` : ""}
      <div class="tiles">
        ${tile(mineOnly ? "My appointments today" : "Appointments today", appts.length, "/ehr/schedule")}
        ${tile("My unsigned notes", drafts, "/ehr/notes")}
        ${tile("New appointment requests", newRequests, "/ehr/requests")}
        ${tile("Unbilled charges", unbilled, "/ehr/billing")}
      </div>
      ${require("./checkin").dashboardCard(db, u)}
      ${can(u, "clinical:write") ? renderWorkboard(buildWorkboard(db, u)) : ""}
      ${flags.length ? html`
        <section class="card card--alert">
          <h2>Safety follow-up</h2>
          <p class="muted">A suicide risk screen (PHQ-9 item 9 or C-SSRS) was positive in the last 14 days. Make sure a risk assessment and safety plan are documented.</p>
          <ul class="list">${flags.map((f) => html`<li><a href="/ehr/patients/${f.patient_id}/measures">${patientName(f)}</a> · ${f.instrument === "CSSRS" ? `C-SSRS ${f.severity}` : `PHQ-9 ${f.total_score}, item 9 endorsed`} on ${f.administered_on}</li>`)}</ul>
        </section>` : ""}
      ${ur.length ? html`
        <section class="card card--alert" aria-labelledby="ur-due">
          <div class="card__head"><h2 id="ur-due">Utilization reviews due</h2><a class="btn btn--sm" href="/ehr/census">Open census</a></div>
          <ul class="list-plain">${ur.map((a) => html`<li class="row"><a href="/ehr/patients/${a.patient_id}/level-of-care#authorizations">${patientName(a)}</a>
            <span class="muted small">${(LEVELS.find((l) => l.value === a.level) || { short: a.level }).short}${a.payer ? ` · ${a.payer}` : ""}</span>
            ${authAlerts(db, a, t).map((x) => html`<span class="badge badge--${x.tone}">${x.text}</span>`)}</li>`)}</ul>
        </section>` : ""}
      ${duePlans ? html`
        <section class="card" aria-labelledby="due-plans">
          <div class="card__head"><h2 id="due-plans">Treatment plans due for review</h2><span class="muted small">Next 7 days or overdue${mineOnly ? " · your patients" : ""}</span></div>
          ${duePlans.length ? html`<ul class="list-plain">${duePlans.map((d) => html`
            <li class="row"><a href="/ehr/patients/${d.patient_id}/treatment-plan">${patientName(d)}</a>
              ${d.review_date < t ? html`<span class="badge badge--bad">Overdue</span>` : html`<span class="badge badge--warn">Due soon</span>`}
              <span class="muted small">Review ${d.review_date < t ? "was due" : "due"} ${fmtDate(d.review_date)} · plan v${d.version}</span></li>`)}</ul>`
            : html`<p class="muted">No plan reviews due in the next 7 days.</p>`}
        </section>` : ""}
      ${can(u, "schedule:read") ? html`
        <section class="card">
          <div class="card__head"><h2>Today's schedule</h2><a class="btn btn--sm" href="/ehr/schedule">Open schedule</a></div>
          ${appts.length ? html`
            <table class="table">
              <thead><tr><th>Time</th><th>Patient</th><th>Type</th>${mineOnly ? "" : html`<th>Clinician</th>`}<th>Status</th></tr></thead>
              <tbody>${appts.map((a) => html`
                <tr>
                  <td>${fmtTime(a.start_at)}</td>
                  <td><a href="/ehr/patients/${a.patient_id}">${patientName(a)}</a></td>
                  <td><span class="type-dot" style="--appt:${colorFor(colors, a.type)}"></span>${humanize(a.type)}${a.modality === "telehealth" ? html` <span class="pill">Telehealth</span>` : ""}</td>
                  ${mineOnly ? "" : html`<td>${a.clinician_name}</td>`}
                  <td>${badge(a.status)}</td>
                </tr>`)}</tbody>
            </table>` : html`<p class="muted">No appointments today.</p>`}
        </section>` : ""}`,
  }));
});

module.exports = { router };
