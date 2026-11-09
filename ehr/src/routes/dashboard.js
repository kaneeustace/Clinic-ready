"use strict";
const express = require("express");
const { can } = require("../permissions");
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

  const tile = (label, value, href) => value === null ? "" : html`
    <a class="tile" href="${href}"><span class="tile__num">${value}</span><span class="tile__label">${label}</span></a>`;

  res.send(page(req, {
    title: "Dashboard",
    active: "dashboard",
    body: html`
      <div class="page-head"><div><h1>Good ${Number(nowLocal().slice(11, 13)) < 12 ? "morning" : Number(nowLocal().slice(11, 13)) < 17 ? "afternoon" : "evening"}, ${u.name.split(" ")[0]}</h1><p>${fmtDate(t)} · ${appts.length} ${mineOnly ? "of your " : ""}appointment${appts.length === 1 ? "" : "s"} on today's schedule</p></div></div><div class="row no-print" style="margin-top:-.5rem;margin-bottom:1.25rem">${can(u, "patients:write") ? html`<a class="btn btn--primary btn--sm" href="/ehr/patients/new">New patient</a>` : ""}${can(u, "schedule:write") ? html`<a class="btn btn--sm" href="/ehr/schedule/new">Book appointment</a>` : ""}</div>
      <div class="tiles">
        ${tile(mineOnly ? "My appointments today" : "Appointments today", appts.length, "/ehr/schedule")}
        ${tile("My unsigned notes", drafts, "/ehr/notes")}
        ${tile("New appointment requests", newRequests, "/ehr/requests")}
        ${tile("Unbilled charges", unbilled, "/ehr/billing")}
      </div>
      ${flags.length ? html`
        <section class="card card--alert">
          <h2>Safety follow-up</h2>
          <p class="muted">A suicide risk screen (PHQ-9 item 9 or C-SSRS) was positive in the last 14 days. Make sure a risk assessment and safety plan are documented.</p>
          <ul class="list">${flags.map((f) => html`<li><a href="/ehr/patients/${f.patient_id}/measures">${patientName(f)}</a> · ${f.instrument === "CSSRS" ? `C-SSRS ${f.severity}` : `PHQ-9 ${f.total_score}, item 9 endorsed`} on ${f.administered_on}</li>`)}</ul>
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
                  <td>${humanize(a.type)}${a.modality === "telehealth" ? html` <span class="pill">Telehealth</span>` : ""}</td>
                  ${mineOnly ? "" : html`<td>${a.clinician_name}</td>`}
                  <td>${badge(a.status)}</td>
                </tr>`)}</tbody>
            </table>` : html`<p class="muted">No appointments today.</p>`}
        </section>` : ""}`,
  }));
});

module.exports = { router };
