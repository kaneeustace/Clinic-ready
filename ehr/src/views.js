"use strict";
/*
 * Server-side HTML helpers.
 *
 *   html`<p>${userInput}</p>`   -> auto-escapes interpolated values
 *   raw(trustedString)          -> opt out of escaping (only for markup you built)
 *   page(req, { title, active, body })          -> full EHR page with sidebar
 *   chartPage(req, patient, tab, body, {title}) -> page wrapped in the patient chart header + tabs
 *
 * Interpolating arrays joins them; null/undefined/false render as ''.
 */
const { can } = require("./permissions");

class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const raw = (s) => new SafeHtml(String(s));
function render(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/* ---------------- formatting ---------------- */
const TZ = process.env.EHR_TZ || "America/New_York";

/** Clinic-local today as 'YYYY-MM-DD'. */
function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}
/** Clinic-local now as 'YYYY-MM-DDTHH:MM'. */
function nowLocal() {
  const d = new Date();
  const date = d.toLocaleDateString("en-CA", { timeZone: TZ });
  const time = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}T${time}`;
}
/** Add days to 'YYYY-MM-DD'. */
function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(ymd) {
  if (!ymd) return "";
  const d = new Date(String(ymd).slice(0, 10) + "T12:00:00Z");
  if (isNaN(d)) return String(ymd);
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
/** For clinic-local 'YYYY-MM-DDTHH:MM' strings. */
function fmtTime(local) {
  if (!local) return "";
  const [h, m] = String(local).slice(11, 16).split(":").map(Number);
  if (isNaN(h)) return "";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function fmtDateTime(local) {
  if (!local) return "";
  return `${fmtDate(local)} ${fmtTime(local)}`;
}
/** For UTC 'YYYY-MM-DD HH:MM:SS' timestamps from SQLite datetime('now'). */
function fmtTimestamp(utc) {
  if (!utc) return "";
  const d = new Date(String(utc).replace(" ", "T") + "Z");
  if (isNaN(d)) return String(utc);
  return d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function age(dob) {
  if (!dob) return "";
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today().split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
function money(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
/** '125', '125.5', '$1,250.00' -> cents (integer) or null if invalid. */
function parseMoney(s) {
  const clean = String(s ?? "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}
const humanize = (s) => String(s || "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const BADGE_TONE = {
  active: "good", signed: "good", completed: "good", paid: "good", met: "good", checked_in: "info", scheduled: "info",
  draft: "warn", new: "warn", unbilled: "warn", in_progress: "info", contacted: "info", billed: "info",
  no_show: "bad", cancelled: "muted", late_cancel: "bad", denied: "bad", void: "muted", inactive: "muted",
  discharged: "muted", closed: "muted", resolved: "muted", high: "bad", moderate: "warn", low: "info", none: "muted",
};
function badge(status, label) {
  return html`<span class="badge badge--${BADGE_TONE[status] || "muted"}">${label || humanize(status)}</span>`;
}

function csrfField(req) {
  return req.session ? html`<input type="hidden" name="_csrf" value="${req.session.csrf_token}">` : "";
}
function patientName(p) {
  if (!p) return "";
  return `${p.last_name}, ${p.first_name}${p.preferred_name ? ` (${p.preferred_name})` : ""}`;
}

/* ---------------- layout ---------------- */
const NAV = [
  { key: "dashboard", href: "/ehr", label: "Dashboard", perm: null, icon: "M3 12l9-8 9 8M5 10v10h14V10" },
  { key: "patients", href: "/ehr/patients", label: "Patients", perm: "patients:read", icon: "M16 11a4 4 0 1 0-8 0M4 21c0-4 4-6 8-6s8 2 8 6" },
  { key: "schedule", href: "/ehr/schedule", label: "Schedule", perm: "schedule:read", icon: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4" },
  { key: "notes", href: "/ehr/notes", label: "My notes", perm: "clinical:write", icon: "M6 3h9l4 4v14H6zM9 12h7M9 16h7" },
  { key: "requests", href: "/ehr/requests", label: "Requests", perm: "requests:manage", icon: "M4 6h16v12H4zM4 7l8 6 8-6" },
  { key: "billing", href: "/ehr/billing", label: "Billing", perm: "billing:read", icon: "M3 7h18v10H3zM3 11h18" },
  { key: "admin", href: "/ehr/admin", label: "Admin", perm: "admin", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" },
];

function icon(d) {
  return raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`);
}

function flashes(req) {
  const list = req.takeFlash ? req.takeFlash() : [];
  return list.map((f) => html`<div class="alert alert--${f.type}" role="${f.type === "error" ? "alert" : "status"}">${f.message}</div>`);
}

function page(req, { title, active = "", body, bare = false }) {
  const user = req.user;
  const shell = bare || !user
    ? html`<main id="main" class="bare">${body}</main>`
    : html`
      <div class="app">
        <aside class="sidebar" aria-label="EHR navigation">
          <a class="sidebar__brand" href="/ehr"><span class="logo-dot" aria-hidden="true"></span> Clinic Ready <strong>EHR</strong></a>
          <nav><ul>
            ${NAV.filter((n) => !n.perm || can(user, n.perm)).map((n) => html`
              <li><a href="${n.href}" ${n.key === active ? raw('aria-current="page"') : ""}>${icon(n.icon)}<span>${n.label}</span></a></li>`)}
          </ul></nav>
          <form class="sidebar__search" method="get" action="/ehr/patients" role="search">
            <label class="visually-hidden" for="global-q">Search patients</label>
            <input id="global-q" type="search" name="q" placeholder="Search patients…">
          </form>
        </aside>
        <div class="app__main">
          <header class="topbar">
            <div class="topbar__demo">Demo environment. Use synthetic data only.</div>
            <div class="topbar__user">
              <span>${user.name}${user.credentials ? `, ${user.credentials}` : ""} · <span class="muted">${humanize(user.role)}</span></span>
              <form method="post" action="/ehr/logout">${csrfField(req)}<button class="btn btn--ghost btn--sm" type="submit">Sign out</button></form>
            </div>
          </header>
          <main id="main" class="content">
            ${flashes(req)}
            ${body}
          </main>
        </div>
      </div>`;
  return "<!doctype html>" + html`
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title ? `${title} · ` : ""}Clinic Ready EHR</title>
  <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/ehr/static/ehr.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${shell}
  <script src="/ehr/static/ehr.js" defer></script>
</body>
</html>`.s;
}

/* ---------------- patient chart ---------------- */
const CHART_TABS = [
  { key: "overview", label: "Overview", path: "", perm: "patients:read" },
  { key: "appointments", label: "Appointments", path: "/appointments", perm: "schedule:read" },
  { key: "notes", label: "Notes", path: "/notes", perm: "clinical:read" },
  { key: "plan", label: "Treatment plan", path: "/treatment-plan", perm: "clinical:read" },
  { key: "measures", label: "Measures", path: "/measures", perm: "clinical:read" },
  { key: "billing", label: "Billing", path: "/billing", perm: "billing:read" },
];

/** Load a patient by id or return null. */
function getPatient(req, id) {
  return req.db.prepare("SELECT * FROM patients WHERE id = ?").get(Number(id)) || null;
}

function chartPage(req, patient, tab, body, { title } = {}) {
  const allergies = req.db.prepare("SELECT substance FROM allergies WHERE patient_id = ? AND active = 1").all(patient.id);
  const clinician = patient.primary_clinician_id
    ? req.db.prepare("SELECT name, credentials FROM users WHERE id = ?").get(patient.primary_clinician_id) : null;
  const flagged = can(req.user, "clinical:read") && req.db.prepare(
    `SELECT 1 FROM assessments WHERE patient_id = ? AND flagged = 1 AND administered_on >= date('now','-30 days') LIMIT 1`).get(patient.id);
  const base = `/ehr/patients/${patient.id}`;
  const header = html`
    <section class="chart-head" aria-label="Patient summary">
      <div>
        <h1 class="chart-head__name">${patientName(patient)}</h1>
        <p class="chart-head__meta">
          <span>MRN ${patient.mrn}</span>
          <span>DOB ${fmtDate(patient.dob)} (${age(patient.dob)} y)</span>
          ${patient.pronouns ? html`<span>${patient.pronouns}</span>` : ""}
          ${clinician ? html`<span>Clinician: ${clinician.name}${clinician.credentials ? `, ${clinician.credentials}` : ""}</span>` : ""}
          ${badge(patient.status)}
        </p>
      </div>
      <div class="chart-head__alerts">
        ${allergies.length
          ? html`<span class="pill pill--bad" title="Allergies">Allergies: ${allergies.map((a) => a.substance).join(", ")}</span>`
          : html`<span class="pill">No known allergies</span>`}
        ${flagged ? html`<span class="pill pill--bad">Safety flag: recent PHQ-9 item 9 &gt; 0</span>` : ""}
      </div>
    </section>
    <nav class="tabs" aria-label="Chart sections">
      ${CHART_TABS.filter((t) => can(req.user, t.perm)).map((t) => html`
        <a href="${base + t.path}" ${t.key === tab ? raw('aria-current="page"') : ""}>${t.label}</a>`)}
    </nav>`;
  return page(req, { title: title || patientName(patient), active: "patients", body: html`${header}<div class="chart-body">${body}</div>` });
}

function notFound(req, res, what = "Page") {
  res.status(404).send(page(req, { title: "Not found", body: html`<div class="card"><h1>${what} not found</h1><p><a href="/ehr">Back to dashboard</a></p></div>` }));
}

/** Render a <select> with options [{value,label}] or [string]. */
function select(name, options, selected, attrs = "") {
  return html`<select name="${name}" id="${name}" ${raw(attrs)}>${options.map((o) => {
    const v = typeof o === "object" ? o.value : o;
    const l = typeof o === "object" ? o.label : humanize(o);
    return html`<option value="${v}" ${String(v) === String(selected ?? "") ? raw("selected") : ""}>${l}</option>`;
  })}</select>`;
}

module.exports = {
  html, raw, esc, SafeHtml, page, chartPage, notFound, csrfField, select, badge, icon, getPatient, patientName,
  today, nowLocal, addDays, fmtDate, fmtTime, fmtDateTime, fmtTimestamp, age, money, parseMoney, humanize, TZ,
};
