"use strict";
/*
 * Website appointment requests.
 *   publicRouter (mounted at /api, no session):  POST /api/appointment-requests
 *   router       (mounted at /ehr, login+CSRF):  GET /requests, GET/POST /requests/:id, POST /requests/:id/convert
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { tx, nextMrn } = require("../db");
const { html, page, csrfField, badge, select, notFound, humanize, fmtDate, fmtTimestamp, patientName, today } = require("../views");

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */
const STATUSES = ["new", "contacted", "scheduled", "closed"];
const FILTERS = ["open", "new", "contacted", "scheduled", "closed", "all"];

// Allowed values for choice fields (contact.html values, hyphens normalized to underscores).
const CHOICES = {
  contact_method: ["phone", "text", "email"],
  ok_voicemail: ["yes", "no"],
  care_for: ["myself", "my_child", "partner_and_me", "my_family"],
  service: ["individual_therapy", "psychiatry", "couples_family", "teen_young_adult", "group", "not_sure"],
  visit_preference: ["in_person", "telehealth", "either"],
  referral_source: ["search", "insurance_directory", "doctor", "friend_family", "school_employer", "social_media", "other"],
};

// Max stored length per column.
const MAX = {
  first_name: 100, last_name: 100, preferred_name: 100, dob: 10, phone: 40, email: 254, contact_method: 20,
  ok_voicemail: 10, care_for: 40, service: 40, visit_preference: 40, insurance: 200, reason: 1000, referral_source: 40,
};

// Form field name (contact.html) -> table column. Column names are accepted as aliases.
const FIELD_MAP = {
  first_name: "first_name", last_name: "last_name", preferred_name: "preferred_name",
  date_of_birth: "dob", dob: "dob",
  phone: "phone", email: "email", contact_method: "contact_method",
  voicemail_ok: "ok_voicemail", ok_voicemail: "ok_voicemail",
  care_for: "care_for", service: "service", visit_preference: "visit_preference",
  insurance_provider: "insurance", insurance: "insurance",
  reason: "reason", referral_source: "referral_source",
};

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/;

/** Coerce a submitted value to a trimmed string ('' for anything that isn't a string/number). */
function str(v) {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}
const truthy = (v) => v === true || ["yes", "on", "true", "1", "y", "checked"].includes(str(v).toLowerCase());

function validDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(ymd + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === ymd;
}

/** Validate a 'YYYY-MM-DD' date of birth. Returns error message or null. */
function dobError(dob) {
  if (!validDate(dob)) return "Please enter a valid date of birth.";
  if (dob > today() || dob < "1900-01-01") return "Please enter a valid date of birth.";
  return null;
}

/** Map + validate a public submission. Returns { values, fields } (fields = errors). */
function parseSubmission(body) {
  const values = {};
  for (const col of Object.keys(MAX)) values[col] = "";
  for (const [field, col] of Object.entries(FIELD_MAP)) {
    if (!(field in body)) continue;
    const v = str(body[field]);
    if (v && !values[col]) values[col] = v;
  }
  const fields = {};
  const tooLong = (col, label) => { if (values[col].length > MAX[col]) fields[col] = `${label} must be ${MAX[col]} characters or fewer.`; };

  if (!values.first_name) fields.first_name = "First name is required."; else tooLong("first_name", "First name");
  if (!values.last_name) fields.last_name = "Last name is required."; else tooLong("last_name", "Last name");
  tooLong("preferred_name", "Preferred name");
  if (!values.phone && !values.email) {
    fields.phone = "Please provide a phone number or email address.";
    fields.email = "Please provide a phone number or email address.";
  }
  if (values.phone) {
    const digits = values.phone.replace(/\D/g, "");
    if (values.phone.length > MAX.phone || digits.length < 7 || digits.length > 15 || !/^[\d\s()+.\-x#ext]+$/i.test(values.phone)) {
      fields.phone = "Please enter a valid phone number.";
    }
  }
  if (values.email && (values.email.length > MAX.email || !EMAIL_RE.test(values.email))) {
    fields.email = "Please enter a valid email address.";
  }
  if (values.dob) { const e = dobError(values.dob); if (e) fields.dob = e; }
  for (const [col, allowed] of Object.entries(CHOICES)) {
    if (!values[col]) continue;
    const norm = values[col].toLowerCase().replace(/-/g, "_");
    if (allowed.includes(norm)) values[col] = norm; else fields[col] = "Please choose a valid option.";
  }
  tooLong("insurance", "Insurance");
  tooLong("reason", "Reason");
  if (!truthy(body.consent)) fields.consent = "Please confirm you understand this form is not for emergencies and agree to be contacted.";

  // Cap lengths defensively and store empty strings as NULL.
  for (const col of Object.keys(values)) values[col] = values[col] ? values[col].slice(0, MAX[col]) : null;
  return { values, fields };
}

/* ------------------------------------------------------------------ */
/* Rate limit (in memory, per IP)                                     */
/* ------------------------------------------------------------------ */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 10000) {
    for (const [k, list] of hits) if (!list.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  return false;
}
function resetRateLimit() { hits.clear(); }

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */
const publicRouter = express.Router();

function simplePage(title, message) {
  return "<!doctype html>" + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="/assets/css/styles.css"></head>
<body><main id="main" style="max-width:40rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p>
<p><a href="/contact.html">Back to the contact page</a></p>
<p>If this is an emergency, call 911 or go to the nearest emergency room. You can also call or text 988 (Suicide &amp; Crisis Lifeline).</p></main></body></html>`.s;
}

publicRouter.post("/appointment-requests", (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  // A plain HTML form post (no JS) gets redirects/HTML; fetch/XHR callers get JSON.
  const htmlForm = req.is("application/x-www-form-urlencoded") && req.accepts(["json", "html"]) === "html"
    && !String(req.get("accept") || "").includes("application/json");

  if (rateLimited(req.ip || "unknown")) {
    if (htmlForm) return res.status(429).send(simplePage("Too many requests", "We've received several requests from your connection. Please wait a few minutes, or call us at (555) 010-0123."));
    return res.status(429).json({ error: "rate_limited" });
  }

  // Honeypot: bots fill the hidden `website` field. Pretend success, store nothing.
  if (str(body.website)) {
    if (htmlForm) return res.redirect(303, "/contact.html?submitted=1");
    return res.status(200).json({ ok: true });
  }

  const { values, fields } = parseSubmission(body);
  if (Object.keys(fields).length) {
    if (htmlForm) return res.status(400).send(simplePage("Please check your request", "Some required information was missing or invalid. Please go back, review the highlighted fields and try again."));
    return res.status(400).json({ error: "validation", fields });
  }

  const info = req.db.prepare(`INSERT INTO appointment_requests (first_name, last_name, preferred_name, dob, phone, email,
    contact_method, ok_voicemail, care_for, service, visit_preference, insurance, reason, referral_source, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    values.first_name, values.last_name, values.preferred_name, values.dob, values.phone, values.email,
    values.contact_method, values.ok_voicemail, values.care_for, values.service, values.visit_preference,
    values.insurance, values.reason, values.referral_source, req.ip || null);
  audit(req, "create", "appointment_request", Number(info.lastInsertRowid), null, "website submission");

  if (htmlForm) return res.redirect(303, "/contact.html?submitted=1");
  res.status(201).json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Staff UI                                                           */
/* ------------------------------------------------------------------ */
const router = express.Router();
router.use("/requests", requirePerm("requests:manage"));

/** '2 days ago' for a UTC SQLite timestamp. */
function timeAgo(utc) {
  const d = new Date(String(utc).replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, secs] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

const label = (v) => (v ? humanize(v) : "");
const display = (v) => (v === null || v === undefined || v === "" ? html`<span class="muted">Not provided</span>` : v);
const fullName = (r) => `${r.first_name} ${r.last_name}${r.preferred_name ? ` (${r.preferred_name})` : ""}`;

function loadRequest(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return req.db.prepare("SELECT * FROM appointment_requests WHERE id = ?").get(id) || null;
}

/** Existing patients that may be the same person. Each row carries `reasons`. */
function findDuplicates(db, r) {
  const out = new Map();
  const add = (rows, why) => rows.forEach((p) => {
    if (!out.has(p.id)) out.set(p.id, { ...p, reasons: [] });
    out.get(p.id).reasons.push(why);
  });
  const cols = "id, mrn, first_name, last_name, preferred_name, dob, phone, email, status";
  if (r.dob) {
    add(db.prepare(`SELECT ${cols} FROM patients WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?) AND dob = ?`)
      .all(r.first_name, r.last_name, r.dob), "Name and date of birth");
  }
  const digits = String(r.phone || "").replace(/\D/g, "");
  if (digits.length >= 7) {
    const last10 = digits.slice(-10);
    add(db.prepare(`SELECT ${cols} FROM patients WHERE phone IS NOT NULL AND
      substr(replace(replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), -10) = ?`)
      .all(last10), "Phone");
  }
  if (r.email) {
    add(db.prepare(`SELECT ${cols} FROM patients WHERE email IS NOT NULL AND lower(email) = lower(?)`).all(r.email), "Email");
  }
  return [...out.values()].slice(0, 25);
}

router.get("/requests", (req, res) => {
  const status = FILTERS.includes(req.query.status) ? req.query.status : "open";
  const where = status === "all" ? "" : status === "open" ? "WHERE status IN ('new','contacted')" : "WHERE status = ?";
  const rows = req.db.prepare(`SELECT id, first_name, last_name, preferred_name, service, visit_preference, status, patient_id, created_at
    FROM appointment_requests ${where} ORDER BY created_at DESC, id DESC LIMIT 500`)
    .all(...(where.includes("?") ? [status] : []));
  const counts = Object.fromEntries(req.db.prepare("SELECT status, COUNT(*) AS n FROM appointment_requests GROUP BY status").all().map((x) => [x.status, x.n]));
  audit(req, "view", "appointment_request", null, null, `list status=${status} count=${rows.length}`);

  const filterLabel = { open: "Open (new + contacted)", all: "All" };
  res.send(page(req, {
    title: "Appointment requests",
    active: "requests",
    body: html`
      <div class="page-head"><h1>Appointment requests</h1>
        <span class="muted">${counts.new || 0} new · ${counts.contacted || 0} contacted</span></div>
      <section class="card">
        <form method="get" action="/ehr/requests" class="row" aria-label="Filter requests">
          <label for="status">Status ${select("status", FILTERS.map((f) => ({ value: f, label: filterLabel[f] || humanize(f) })), status)}</label>
          <button class="btn btn--sm" type="submit">Filter</button>
        </form>
      </section>
      <section class="card">
        ${rows.length ? html`
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Received</th><th>Name</th><th>Service</th><th>Preference</th><th>Status</th></tr></thead>
            <tbody>${rows.map((r) => html`
              <tr>
                <td><span title="${fmtTimestamp(r.created_at)}">${timeAgo(r.created_at)}</span></td>
                <td><a href="/ehr/requests/${r.id}">${r.last_name}, ${r.first_name}${r.preferred_name ? ` (${r.preferred_name})` : ""}</a>
                  ${r.patient_id ? html` <span class="pill">Linked</span>` : ""}</td>
                <td>${label(r.service)}</td>
                <td>${label(r.visit_preference)}</td>
                <td>${badge(r.status)}</td>
              </tr>`)}</tbody>
          </table></div>` : html`<p class="muted">No requests match this filter.</p>`}
      </section>`,
  }));
});

function renderDetail(req, r, { error, status = 200 } = {}, res) {
  const dups = findDuplicates(req.db, r);
  const linked = r.patient_id ? req.db.prepare("SELECT id, mrn, first_name, last_name, preferred_name FROM patients WHERE id = ?").get(r.patient_id) : null;
  const handler = r.handled_by ? req.db.prepare("SELECT name FROM users WHERE id = ?").get(r.handled_by) : null;
  audit(req, "view", "appointment_request", r.id, r.patient_id || null);

  const row = (k, v) => html`<tr><th scope="row">${k}</th><td>${display(v)}</td></tr>`;
  res.status(status).send(page(req, {
    title: "Appointment request",
    active: "requests",
    body: html`
      <div class="page-head">
        <h1>${fullName(r)}</h1>
        <div class="row">${badge(r.status)} <a class="btn btn--sm" href="/ehr/requests">Back to requests</a></div>
      </div>
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      <div class="grid grid--2">
        <section class="card">
          <h2>Request</h2>
          <table class="table"><tbody>
            ${row("Received", `${fmtTimestamp(r.created_at)} (${timeAgo(r.created_at)})`)}
            ${row("First name", r.first_name)}
            ${row("Last name", r.last_name)}
            ${row("Preferred name", r.preferred_name)}
            ${row("Date of birth", r.dob ? fmtDate(r.dob) : null)}
            ${row("Phone", r.phone)}
            ${row("Email", r.email)}
            ${row("Preferred contact", label(r.contact_method))}
            ${row("OK to leave voicemail", label(r.ok_voicemail))}
            ${row("Care is for", label(r.care_for))}
            ${row("Service", label(r.service))}
            ${row("Visit preference", label(r.visit_preference))}
            ${row("Insurance", r.insurance)}
            ${row("Referral source", label(r.referral_source))}
            <tr><th scope="row">Reason</th><td>${r.reason ? html`<div class="prewrap">${r.reason}</div>` : display(null)}</td></tr>
            ${row("Last handled by", handler ? handler.name : null)}
          </tbody></table>
        </section>
        <div>
          <section class="card">
            <h2>Update</h2>
            <form method="post" action="/ehr/requests/${r.id}" class="stack">
              ${csrfField(req)}
              <label for="status">Status ${select("status", STATUSES, r.status)}</label>
              <label for="staff_notes">Staff notes <span class="hint">Scheduling and outreach notes only. Not clinical documentation.</span>
                <textarea id="staff_notes" name="staff_notes" maxlength="5000">${r.staff_notes || ""}</textarea></label>
              <div class="form-actions"><button class="btn btn--primary" type="submit">Save</button></div>
            </form>
          </section>
          <section class="card" id="convert">
            <h2>Patient record</h2>
            ${linked ? html`
              <p>Linked to <a href="/ehr/patients/${linked.id}">${patientName(linked)}</a> (MRN ${linked.mrn}).</p>` : html`
              <h3>Possible existing patients</h3>
              ${dups.length ? html`
                <div class="table-wrap"><table class="table">
                  <thead><tr><th>Patient</th><th>DOB</th><th>Matched on</th><th></th></tr></thead>
                  <tbody>${dups.map((p) => html`
                    <tr>
                      <td><a href="/ehr/patients/${p.id}">${patientName(p)}</a><br><span class="muted small">MRN ${p.mrn}</span></td>
                      <td>${fmtDate(p.dob)}</td>
                      <td>${p.reasons.join(", ")}</td>
                      <td><form method="post" action="/ehr/requests/${r.id}/convert" class="inline-form">
                        ${csrfField(req)}<input type="hidden" name="patient_id" value="${p.id}">
                        <button class="btn btn--sm" type="submit">Link to this patient</button></form></td>
                    </tr>`)}</tbody>
                </table></div>` : html`<p class="muted">No existing patients match this name and date of birth, phone, or email.</p>`}
              <h3>Create a new patient</h3>
              <form method="post" action="/ehr/requests/${r.id}/convert" class="stack">
                ${csrfField(req)}
                ${r.dob ? html`<input type="hidden" name="dob" value="${r.dob}">
                  <p class="muted">A new chart will be created with the name, date of birth and contact details from this request.</p>` : html`
                  <label for="dob">Date of birth <span class="hint">Required to create a chart. Confirm it with the person.</span>
                    <input type="date" id="dob" name="dob" required max="${today()}"></label>`}
                <div class="form-actions"><button class="btn btn--primary" type="submit">Create patient</button></div>
              </form>`}
          </section>
        </div>
      </div>`,
  }));
}

router.get("/requests/:id", (req, res) => {
  const r = loadRequest(req);
  if (!r) return notFound(req, res, "Request");
  renderDetail(req, r, {}, res);
});

router.post("/requests/:id", (req, res) => {
  const r = loadRequest(req);
  if (!r) return notFound(req, res, "Request");
  const body = req.body || {};
  const status = STATUSES.includes(body.status) ? body.status : null;
  if (!status) {
    req.flash("error", "Choose a valid status.");
    return res.redirect(`/ehr/requests/${r.id}`);
  }
  const notes = str(body.staff_notes).slice(0, 5000) || null;
  req.db.prepare(`UPDATE appointment_requests SET status = ?, staff_notes = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, notes, req.user.id, r.id);
  const changed = [];
  if (status !== r.status) changed.push(`status ${r.status}->${status}`);
  if ((notes || null) !== (r.staff_notes || null)) changed.push("staff_notes");
  audit(req, "update", "appointment_request", r.id, r.patient_id || null, changed.join("; ") || "no changes");
  req.flash("success", "Request updated.");
  res.redirect(`/ehr/requests/${r.id}`);
});

router.post("/requests/:id/convert", (req, res) => {
  const r = loadRequest(req);
  if (!r) return notFound(req, res, "Request");
  if (r.patient_id) {
    req.flash("info", "This request is already linked to a patient.");
    return res.redirect(`/ehr/patients/${r.patient_id}`);
  }
  const body = req.body || {};
  const nextStatus = r.status === "new" ? "contacted" : r.status;

  // Link to an existing patient.
  if (str(body.patient_id)) {
    const pid = Number(str(body.patient_id));
    const p = Number.isInteger(pid) && pid > 0 ? req.db.prepare("SELECT id FROM patients WHERE id = ?").get(pid) : null;
    if (!p) return renderDetail(req, r, { error: "That patient could not be found.", status: 400 }, res);
    tx(req.db, () => {
      req.db.prepare(`UPDATE appointment_requests SET patient_id = ?, status = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(p.id, nextStatus, req.user.id, r.id);
      audit(req, "update", "appointment_request", r.id, p.id, "linked to existing patient");
    });
    req.flash("success", "Request linked to the existing patient.");
    return res.redirect(`/ehr/patients/${p.id}`);
  }

  // Create a new patient.
  const dob = str(body.dob) || r.dob || "";
  if (!dob) return renderDetail(req, r, { error: "Enter the date of birth to create a patient.", status: 400 }, res);
  const err = dobError(dob);
  if (err) return renderDetail(req, r, { error: err, status: 400 }, res);

  const preferred = CHOICES.contact_method.includes(r.contact_method) ? r.contact_method : null;
  const patientId = tx(req.db, () => {
    const mrn = nextMrn(req.db);
    const info = req.db.prepare(`INSERT INTO patients (mrn, first_name, last_name, preferred_name, dob, phone, email, preferred_contact, ok_voicemail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(mrn, r.first_name, r.last_name, r.preferred_name || null, dob,
      r.phone || null, r.email || null, preferred, r.ok_voicemail === "yes" ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    req.db.prepare(`UPDATE appointment_requests SET patient_id = ?, dob = COALESCE(dob, ?), status = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(id, dob, nextStatus, req.user.id, r.id);
    audit(req, "create", "patient", id, id, `from appointment_request ${r.id}`);
    audit(req, "update", "appointment_request", r.id, id, "converted to new patient");
    return id;
  });
  req.flash("success", "Patient created from the request.");
  res.redirect(`/ehr/patients/${patientId}`);
});

module.exports = { router, publicRouter, __resetRateLimit: resetRateLimit, parseSubmission, findDuplicates };
