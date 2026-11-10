"use strict";
const { getClinic, brandCss } = require("./clinic");
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
// Banner shows in development and demo deployments; hidden in production unless EHR_DEMO=1.
const SHOW_DEMO_BANNER = process.env.NODE_ENV !== "production" || process.env.EHR_DEMO === "1";

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
  discharged: "muted", closed: "muted", resolved: "muted", superseded: "muted", not_started: "muted", revised: "info", discontinued: "muted", high: "bad", moderate: "warn", low: "info", none: "muted",
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
  { group: "Workspace", key: "dashboard", href: "/ehr", label: "Dashboard", perm: null, icon: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z" },
  { group: "Workspace", key: "patients", href: "/ehr/patients", label: "Patients", perm: "patients:read", icon: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21c0-4 3.6-6 8-6s8 2 8 6" },
  { group: "Workspace", key: "schedule", href: "/ehr/schedule", label: "Schedule", perm: "schedule:read", icon: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4" },
  { group: "Workspace", key: "census", href: "/ehr/census", label: "Census", perm: "patients:read", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { group: "Workspace", key: "notes", href: "/ehr/notes", label: "My notes", perm: "clinical:write", icon: "M6 3h9l4 4v14H6zM9 12h7M9 16h5" },
  { group: "Workspace", key: "scan", href: "/ehr/scan", label: "Note scanner", perm: "clinical:write", icon: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4M4 8v13" },
  { group: "Operations", key: "requests", href: "/ehr/requests", label: "Intake requests", perm: "requests:manage", icon: "M4 6h16v12H4zM4 7l8 6 8-6" },
  { group: "Operations", key: "billing", href: "/ehr/billing", label: "Billing", perm: "billing:read", icon: "M3 6h18v12H3zM3 10h18M7 15h4" },
  { group: "Operations", key: "security", href: "/ehr/security", label: "Security", perm: "admin", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM9 12l2 2 4-4" },
  { group: "Operations", key: "backups", href: "/ehr/backups", label: "Backups", perm: "admin", icon: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" },
  { group: "Operations", key: "admin", href: "/ehr/admin", label: "Administration", perm: "admin", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" },
];

function initials(name) {
  return String(name || "?").replace(/[(),]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function icon(d) {
  return raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`);
}

function flashes(req) {
  const list = req.takeFlash ? req.takeFlash() : [];
  return list.map((f) => html`<div class="alert alert--${f.type}" role="${f.type === "error" ? "alert" : "status"}">${f.message}</div>`);
}

/** Phone tab bar: the first four workspace items plus a "More" sheet with everything else and sign out. */
function bottomNav(req, user, active) {
  const items = NAV.filter((n) => !n.perm || can(user, n.perm));
  const main = items.filter((n) => n.group === "Workspace").slice(0, 4);
  const rest = items.filter((n) => !main.includes(n));
  const short = { dashboard: "Home", notes: "Notes" };
  return html`
    <nav class="bottomnav" aria-label="Quick navigation">
      ${main.map((n) => html`<a href="${n.href}" ${n.key === active ? raw('aria-current="page"') : ""}>${icon(n.icon)}<span>${short[n.key] || n.label}</span></a>`)}
      <details class="bottomnav__more">
        <summary ${rest.some((n) => n.key === active) || active === "account" ? raw('aria-current="page"') : ""}>${icon("M4 6h16M4 12h16M4 18h16")}<span>More</span></summary>
        <div class="bottomnav__sheet">
          <a class="bottomnav__user" href="/ehr/account"><span class="avatar avatar--sm" aria-hidden="true">${initials(user.name)}</span><span><strong>${user.name}</strong><small>${user.credentials ? `${user.credentials} · ` : ""}${humanize(user.role)}</small></span></a>
          ${rest.map((n) => html`<a href="${n.href}" ${n.key === active ? raw('aria-current="page"') : ""}>${icon(n.icon)}<span>${n.label}</span></a>`)}
          <form method="post" action="/ehr/logout">${csrfField(req)}<button type="submit">${icon("M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10")}<span>Sign out</span></button></form>
        </div>
      </details>
    </nav>`;
}

/** Clinic logo, or the default mark. */
function brandMark(clinic, cls = "") {
  return clinic.logoUrl
    ? html`<img class="brand-logo ${cls}" src="${clinic.logoUrl}" alt="" aria-hidden="true">`
    : html`<span class="logo-dot ${cls}" aria-hidden="true"></span>`;
}

function page(req, { title, active = "", body, bare = false }) {
  const user = req.user;
  const clinic = getClinic(req.db);
  const shell = bare || !user
    ? html`<main id="main" class="bare">${body}</main>`
    : html`
      <div class="app">
        <aside class="sidebar" aria-label="EHR navigation">
          <a class="sidebar__brand" href="/ehr">${brandMark(clinic)}<span>${clinic.name}<small>${clinic.tagline}</small></span></a>
          <nav>
            ${["Workspace", "Operations"].map((g) => {
              const items = NAV.filter((n) => n.group === g && (!n.perm || can(user, n.perm)));
              return items.length ? html`
                <p class="sidebar__label">${g}</p>
                <ul>${items.map((n) => html`
                  <li><a href="${n.href}" ${n.key === active ? raw('aria-current="page"') : ""}>${icon(n.icon)}<span>${n.label}</span></a></li>`)}
                </ul>` : "";
            })}
          </nav>
          <div class="sidebar__foot">
            <a href="/ehr/account" class="sidebar__user" ${active === "account" ? raw('aria-current="page"') : ""}>
              <span class="avatar avatar--sm" aria-hidden="true">${initials(user.name)}</span>
              <span><strong>${user.name}</strong><small>${user.credentials ? `${user.credentials} · ` : ""}${humanize(user.role)}</small></span>
            </a>
          </div>
        </aside>
        <div class="app__main">
          <header class="topbar">
            <a class="topbar__logo" href="/ehr" aria-label="${clinic.name} home">${brandMark(clinic)}</a>
            <form class="topbar__search" method="get" action="/ehr/patients" role="search">
              <label class="visually-hidden" for="global-q">Search patients</label>
              ${icon("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3")}
              <input id="global-q" type="search" name="q" placeholder="Search patients…">
            </form>
            <div class="topbar__right">
              ${SHOW_DEMO_BANNER ? html`<span class="topbar__demo" title="Use synthetic data only">Demo</span>` : ""}
              <a class="btn btn--ghost btn--sm topbar__account" href="/ehr/account">Account</a>
              <a class="topbar__me" href="/ehr/account" aria-label="Account: ${user.name}"><span class="avatar avatar--sm" aria-hidden="true">${initials(user.name)}</span></a>
              <form class="topbar__signout" method="post" action="/ehr/logout">${csrfField(req)}<button class="btn btn--ghost btn--sm" type="submit">Sign out</button></form>
            </div>
          </header>
          <main id="main" class="content">
            ${flashes(req)}
            ${body}
          </main>
        </div>
        ${bottomNav(req, user, active)}
      </div>`;
  return "<!doctype html>" + html`
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#111f3b">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="${clinic.name.slice(0, 20)}">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <link rel="manifest" href="/ehr/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/ehr/static/icons/icon-180.png">
  <meta name="robots" content="noindex, nofollow">
  <title>${title ? `${title} · ` : ""}${clinic.name}</title>
  <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/ehr/static/ehr.css?v=13">${brandCss(clinic) ? raw(`<style>${brandCss(clinic)}</style>`) : ""}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${shell}
  <script src="/ehr/static/ehr.js?v=13" defer></script>
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
  { key: "loc", label: "Level of care", path: "/level-of-care", perm: "patients:read" },
  { key: "photos", label: "Pictures", path: "/photos", perm: "patients:read" },
];

/** Load a patient by id or return null. */
function getPatient(req, id) {
  return req.db.prepare("SELECT * FROM patients WHERE id = ?").get(Number(id)) || null;
}

/** Treatment plan alert for the chart banner: review overdue / due within 7 days / no active plan while in care. */
function planBanner(db, patient, base) {
  const t = today();
  const plan = db.prepare("SELECT review_date FROM treatment_plans WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(patient.id);
  if (plan) {
    if (plan.review_date && plan.review_date < t) return html`<a class="pill pill--bad" href="${base}/treatment-plan">Plan review overdue (${fmtDate(plan.review_date)})</a>`;
    if (plan.review_date && plan.review_date <= addDays(t, 7)) return html`<a class="pill pill--warn" href="${base}/treatment-plan">Plan review due ${fmtDate(plan.review_date)}</a>`;
    return "";
  }
  if (patient.status !== "active") return "";
  const inCare = db.prepare(
    `SELECT 1 FROM appointments WHERE patient_id = ? AND status NOT IN ('cancelled','late_cancel','no_show')
     AND type NOT IN ('intake','consult') AND substr(start_at, 1, 10) >= ? LIMIT 1`).get(patient.id, addDays(t, -60));
  return inCare ? html`<a class="pill pill--warn" href="${base}/treatment-plan">No active treatment plan</a>` : "";
}

function chartPage(req, patient, tab, body, { title } = {}) {
  const allergies = req.db.prepare("SELECT substance FROM allergies WHERE patient_id = ? AND active = 1").all(patient.id);
  const clinician = patient.primary_clinician_id
    ? req.db.prepare("SELECT name, credentials FROM users WHERE id = ?").get(patient.primary_clinician_id) : null;
  const flagged = can(req.user, "clinical:read") && req.db.prepare(
    `SELECT 1 FROM assessments WHERE patient_id = ? AND flagged = 1 AND administered_on >= ? LIMIT 1`).get(patient.id, addDays(today(), -30));
  const base = `/ehr/patients/${patient.id}`;
  // Diagnoses are clinical information (billing staff see codes on charges and superbills instead).
  const showDx = can(req.user, "clinical:read");
  const dxRows = showDx ? req.db.prepare(
    `SELECT icd10_code, description, is_primary FROM diagnoses WHERE patient_id = ? AND status = 'active'
     ORDER BY is_primary DESC, created_at, id`).all(patient.id) : [];
  const profilePhoto = req.db.prepare("SELECT id FROM patient_images WHERE patient_id = ? AND is_profile = 1 LIMIT 1").get(patient.id);
  const planPill = can(req.user, "clinical:read") ? planBanner(req.db, patient, base) : "";
  const header = html`
    <section class="chart-head" aria-label="Patient summary">
      ${profilePhoto
        ? html`<a class="avatar avatar--lg avatar--photo" href="${base}/photos" title="Pictures"><img src="${base}/photos/${profilePhoto.id}?thumb=1" alt="Profile photo of ${patientName(patient)}"></a>`
        : html`<span class="avatar avatar--lg" aria-hidden="true">${initials(`${patient.first_name} ${patient.last_name}`)}</span>`}
      <div class="chart-head__main">
        <div class="chart-head__title">
          <h1 class="chart-head__name">${patientName(patient)}</h1>
          ${badge(patient.status)}
        </div>
        <dl class="chart-head__meta">
          <div><dt>MRN</dt><dd>${patient.mrn}</dd></div>
          ${patient.ahcccs_id ? html`<div class="chart-head__ahcccs"><dt>AHCCCS ID</dt><dd>${patient.ahcccs_id}</dd></div>` : ""}
          <div><dt>DOB</dt><dd>${fmtDate(patient.dob)} · ${age(patient.dob)} y</dd></div>
          ${patient.pronouns ? html`<div><dt>Pronouns</dt><dd>${patient.pronouns}</dd></div>` : ""}
          <div><dt>Clinician</dt><dd>${clinician ? `${clinician.name}${clinician.credentials ? `, ${clinician.credentials}` : ""}` : "Unassigned"}</dd></div>
          ${patient.phone ? html`<div><dt>Phone</dt><dd>${patient.phone}</dd></div>` : ""}
        </dl>
        ${showDx ? html`<div class="chart-head__dx">
          <span class="chart-head__dx-label">Diagnoses</span>
          ${dxRows.length ? dxRows.map((d) => html`<span class="dx-chip${d.is_primary ? " dx-chip--primary" : ""}" title="${d.description}${d.is_primary ? " (primary)" : ""}"><strong>${d.icd10_code}</strong> ${d.description}</span>`)
            : html`<span class="muted small">None recorded${can(req.user, "clinical:write") ? html` · <a href="${base}#diagnoses">add on Overview</a>` : ""}</span>`}
        </div>` : ""}
        <div class="chart-head__alerts">
          ${allergies.length
            ? html`<span class="pill pill--bad">Allergies: ${allergies.map((a) => a.substance).join(", ")}</span>`
            : html`<span class="pill">NKA (no known allergies)</span>`}
          ${flagged ? html`<span class="pill pill--bad">Safety flag: positive suicide risk screen in last 30 days</span>` : ""}
          ${planPill}
          ${require("./routes/loc").bannerPill(req.db, req.user, patient)}
        </div>
      </div>
      <div class="chart-head__actions">
        ${can(req.user, "schedule:write") ? html`<a class="btn btn--sm" href="/ehr/schedule/new?patient_id=${patient.id}">Schedule</a>` : ""}
        ${can(req.user, "clinical:write") ? html`<a class="btn btn--primary btn--sm" href="${base}/notes/new">New note</a>` : ""}
      </div>
    </section>
    <nav class="tabs" aria-label="Chart sections">
      ${CHART_TABS.filter((t) => can(req.user, t.perm)).map((t) => html`
        <a href="${base + t.path}" ${t.key === tab ? raw('aria-current="page"') : ""}>${t.label}</a>`)}
    </nav>`;
  // Printed on every page (AHCCCS/AMPM 940: member name and AHCCCS ID or DOB on each page).
  const printId = html`<div class="print-id" aria-hidden="true">${patientName(patient)} · DOB ${fmtDate(patient.dob)} · MRN ${patient.mrn}${patient.ahcccs_id ? ` · AHCCCS ID ${patient.ahcccs_id}` : ""}</div>`;
  return page(req, { title: title || patientName(patient), active: "patients", body: html`${header}<div class="chart-body">${body}</div>${printId}` });
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
  brandMark, initials, html, raw, esc, SafeHtml, page, chartPage, notFound, csrfField, select, badge, icon, getPatient, patientName,
  today, nowLocal, addDays, fmtDate, fmtTime, fmtDateTime, fmtTimestamp, age, money, parseMoney, humanize, TZ,
};
