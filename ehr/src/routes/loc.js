"use strict";
/*
 * Level of care (LOC): where each client is in the continuum (detox, residential, PHP, IOP, OP, ...),
 * how they moved between levels, and the payer authorizations / utilization reviews (UR) that pay for it.
 *
 *   GET  /patients/:id/level-of-care                         chart tab: current level, history, authorizations
 *   POST /patients/:id/level-of-care                         admit to a level, or change level (step up / step down)
 *   POST /patients/:id/level-of-care/:eid/edit               correct an episode
 *   POST /patients/:id/level-of-care/:eid/discharge          end the current level (discharge from care)
 *   POST /patients/:id/authorizations                        add an authorization / UR record
 *   POST /patients/:id/authorizations/:aid/edit              update status, units, dates, next review
 *   GET  /census                                             census by level, admissions/discharges, UR due
 *
 * One open episode (end_date IS NULL) per patient is the current level of care. Changing level closes the open
 * episode the day the new one starts, so history has no gaps or overlaps.
 * Who: view = clinical:read or billing:read; episodes = clinical:write; authorizations = clinical:write or billing:write.
 * Every view and change is audited (no PHI in the audit detail).
 */
const express = require("express");
const { forbidden } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, raw, page, chartPage, notFound, csrfField, select, getPatient, patientName, today, addDays, fmtDate, humanize } = require("../views");

const router = express.Router();

/* Levels of care. ASAM numbers are shown alongside where they map. */
const LEVELS = [
  { value: "inpatient", label: "Inpatient / hospital", short: "Inpatient", asam: "4" },
  { value: "detox", label: "Withdrawal management (detox)", short: "Detox", asam: "3.7" },
  { value: "residential", label: "Residential", short: "Residential", asam: "3.5" },
  { value: "php", label: "Partial hospitalization (PHP)", short: "PHP", asam: "2.5" },
  { value: "iop", label: "Intensive outpatient (IOP)", short: "IOP", asam: "2.1" },
  { value: "op", label: "Outpatient (OP)", short: "OP", asam: "1" },
  { value: "housing", label: "Supportive / sober living", short: "Sober living", asam: "" },
  { value: "early", label: "Early intervention", short: "Early intervention", asam: "0.5" },
  { value: "aftercare", label: "Aftercare / alumni", short: "Aftercare", asam: "" },
];
const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.value, l]));
const ASAM_LEVELS = ["", "0.5", "1", "1.0", "1.5", "1.7", "2.1", "2.5", "2.7", "3.1", "3.3", "3.5", "3.7", "4", "4-WM", "3.7-WM", "3.2-WM", "2-WM", "1-WM"];
const CHANGE_REASONS = [
  { value: "", label: "Select…" },
  { value: "step_down", label: "Step down (clinically appropriate)" },
  { value: "step_up", label: "Step up (needs more support)" },
  { value: "payer", label: "Payer authorization / denial" },
  { value: "client_choice", label: "Client choice" },
  { value: "transfer", label: "Transfer to another program" },
  { value: "other", label: "Other" },
];
const DISCHARGE_REASONS = [
  { value: "", label: "Select…" },
  { value: "completed", label: "Completed treatment" },
  { value: "ama", label: "Left against clinical advice (AMA)" },
  { value: "administrative", label: "Administrative discharge" },
  { value: "transfer", label: "Transferred to another provider" },
  { value: "lost_contact", label: "Lost contact" },
  { value: "other", label: "Other" },
];
const AUTH_STATUSES = ["requested", "pending", "approved", "denied", "expired", "closed"];
const AUTH_TONE = { requested: "info", pending: "warn", approved: "ok", denied: "bad", expired: "bad", closed: "neutral" };
const UNIT_TYPES = [{ value: "days", label: "Days" }, { value: "sessions", label: "Sessions" }, { value: "units", label: "Units" }];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const str = (v, n = 2000) => String(v ?? "").trim().slice(0, n);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const levelLabel = (v) => (LEVEL[v] ? LEVEL[v].label : humanize(v || ""));
const reasonLabel = (list, v) => (list.find((o) => o.value === v) || { label: v || "" }).label;

const canView = (u) => can(u, "clinical:read") || can(u, "billing:read");
const canEpisodes = (u) => can(u, "clinical:write");
const canAuth = (u) => can(u, "clinical:write") || can(u, "billing:write");
const gate = (fn) => (req, res, next) => (fn(req.user) ? next() : forbidden(req, res));

function currentEpisode(db, patientId) {
  return db.prepare("SELECT * FROM loc_episodes WHERE patient_id = ? AND end_date IS NULL ORDER BY start_date DESC, id DESC LIMIT 1").get(patientId) || null;
}

/** Units used: days elapsed for day-based auths; completed appointments for session-based; manual otherwise. */
function unitsUsed(db, a, asOf = today()) {
  if (a.units_used != null && a.unit_type === "units") return a.units_used;
  if (!a.start_date) return a.units_used;
  const end = a.end_date && a.end_date < asOf ? a.end_date : asOf;
  if (end < a.start_date) return 0;
  if (a.unit_type === "days") return a.units_used != null ? a.units_used : daysBetween(a.start_date, end) + 1;
  if (a.unit_type === "sessions") {
    if (a.units_used != null) return a.units_used;
    return db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ? AND status = 'completed'
      AND substr(start_at,1,10) BETWEEN ? AND ?`).get(a.patient_id, a.start_date, end).n;
  }
  return a.units_used;
}

/** Alert state of an authorization: review overdue/due soon, expiring, running out of units. */
function authAlerts(db, a, t = today()) {
  const out = [];
  if (!["approved", "pending", "requested"].includes(a.status)) return out;
  if (a.next_review_date) {
    if (a.next_review_date < t) out.push({ tone: "bad", text: `Review overdue (was due ${fmtDate(a.next_review_date)})` });
    else if (a.next_review_date <= addDays(t, 3)) out.push({ tone: "warn", text: `Review due ${fmtDate(a.next_review_date)}` });
  }
  if (a.status === "approved" && a.end_date) {
    if (a.end_date < t) out.push({ tone: "bad", text: `Authorization ended ${fmtDate(a.end_date)}` });
    else if (a.end_date <= addDays(t, 3)) out.push({ tone: "warn", text: `Authorization ends ${fmtDate(a.end_date)}` });
  }
  if (a.status === "approved" && a.units_approved != null) {
    const used = unitsUsed(db, a, t);
    if (used != null && used >= a.units_approved) out.push({ tone: "bad", text: `All ${a.units_approved} ${a.unit_type} used` });
    else if (used != null && a.units_approved - used <= 2) out.push({ tone: "warn", text: `${a.units_approved - used} ${a.unit_type} left` });
  }
  return out;
}

/** Latest signed ASAM note's level (adjusted if given, else indicated), for comparison with the current level. */
function latestAsam(db, patientId) {
  const n = db.prepare(`SELECT id, content, service_date FROM notes WHERE patient_id = ? AND type = 'asam' AND status = 'signed'
    ORDER BY COALESCE(service_date, substr(signed_at,1,10)) DESC, id DESC LIMIT 1`).get(patientId);
  if (!n) return null;
  let c = {};
  try { c = JSON.parse(n.content || "{}"); } catch { c = {}; }
  const lvl = c.adjusted_level || c.indicated_level || c.recommended_level;
  return lvl ? { id: n.id, level: String(lvl).replace("_php", ""), date: n.service_date } : null;
}

/** Chart banner pill: current level of care (used by views.chartPage). */
function bannerPill(db, user, patient) {
  if (!canView(user)) return "";
  const ep = currentEpisode(db, patient.id);
  if (!ep) return "";
  const lv = LEVEL[ep.level];
  const days = daysBetween(ep.start_date, today()) + 1;
  return html`<a class="pill pill--loc" href="/ehr/patients/${patient.id}/level-of-care" title="Current level of care">LOC: ${lv ? lv.short : humanize(ep.level)}${ep.asam_level ? ` (ASAM ${ep.asam_level})` : ""} · day ${days}</a>`;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function readEpisode(b, { requireReason = false } = {}) {
  const v = { level: str(b.level, 40), asam_level: str(b.asam_level, 10), program: str(b.program, 120), start_date: str(b.start_date, 10),
    end_date: str(b.end_date, 10), reason: str(b.reason, 1000), change_reason: str(b.change_reason, 40) };
  const e = {};
  if (!LEVEL[v.level]) e.level = "Choose a level of care.";
  if (v.asam_level && !ASAM_LEVELS.includes(v.asam_level)) e.asam_level = "Choose an ASAM level from the list.";
  if (!isDate(v.start_date)) e.start_date = "Enter the start date.";
  if (v.end_date && !isDate(v.end_date)) e.end_date = "Enter a valid end date.";
  else if (v.end_date && isDate(v.start_date) && v.end_date < v.start_date) e.end_date = "End date can't be before the start date.";
  if (requireReason && !CHANGE_REASONS.some((o) => o.value && o.value === v.change_reason)) e.change_reason = "Say why the level is changing.";
  return { v, e };
}

function readAuth(b) {
  const v = {};
  for (const k of ["level", "payer", "auth_number", "status", "unit_type", "units_approved", "units_used", "start_date", "end_date", "next_review_date", "reviewer", "notes"]) v[k] = str(b[k], k === "notes" ? 2000 : 120);
  const e = {};
  if (!LEVEL[v.level]) e.level = "Choose the level of care this authorization covers.";
  if (!AUTH_STATUSES.includes(v.status)) e.status = "Choose a status.";
  if (!UNIT_TYPES.some((u) => u.value === v.unit_type)) e.unit_type = "Choose days, sessions or units.";
  for (const k of ["units_approved", "units_used"]) if (v[k] && !/^\d{1,4}$/.test(v[k])) e[k] = "Enter a whole number.";
  for (const k of ["start_date", "end_date", "next_review_date"]) if (v[k] && !isDate(v[k])) e[k] = "Enter a valid date.";
  if (!e.start_date && !e.end_date && v.start_date && v.end_date && v.end_date < v.start_date) e.end_date = "End date can't be before the start date.";
  if (v.status === "approved" && !v.start_date) e.start_date = "Approved authorizations need a start date.";
  return { v, e };
}
const nn = (s) => (s === "" ? null : s);
const num = (s) => (s === "" ? null : Number(s));

/* ------------------------------------------------------------------ */
/* Chart tab                                                           */
/* ------------------------------------------------------------------ */

const levelOptions = (sel) => [{ value: "", label: "Select…" }, ...LEVELS.map((l) => ({ value: l.value, label: `${l.label}${l.asam ? ` · ASAM ${l.asam}` : ""}` }))];
const asamOptions = ASAM_LEVELS.map((a) => ({ value: a, label: a ? `ASAM ${a}` : "Not specified" }));
const errText = (e, k) => (e && e[k] ? html`<span class="error-text">${e[k]}</span>` : "");
function errorSummary(e) {
  const list = Object.values(e || {});
  return list.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong><ul class="list">${list.map((x) => html`<li>${x}</li>`)}</ul></div>` : "";
}

function episodeFields(v, e, { withEnd = false } = {}) {
  return html`
    <label>Level of care ${select("level", levelOptions(), v.level)}${errText(e, "level")}</label>
    <label>ASAM level <span class="hint">(optional)</span>${select("asam_level", asamOptions, v.asam_level)}${errText(e, "asam_level")}</label>
    <label>Program / track <span class="hint">(optional)</span><input type="text" name="program" maxlength="120" value="${v.program || ""}" placeholder="e.g. Women's IOP, evening group"></label>
    <label>Start date<input type="date" name="start_date" value="${v.start_date || ""}" required>${errText(e, "start_date")}</label>
    ${withEnd ? html`<label>End date <span class="hint">(blank = current)</span><input type="date" name="end_date" value="${v.end_date || ""}">${errText(e, "end_date")}</label>` : ""}
    <label class="span-all">Clinical justification <span class="hint">Why this level fits now (ASAM dimensions, risk, response to treatment).</span>
      <textarea name="reason" rows="3" maxlength="1000">${v.reason || ""}</textarea></label>`;
}

function authFields(v, e, prefix) {
  const id = (k) => `${prefix}${k}`;
  return html`
    <label>Level ${select("level", levelOptions(), v.level, `id="${id("level")}"`)}${errText(e, "level")}</label>
    <label>Status ${select("status", AUTH_STATUSES.map((s) => ({ value: s, label: humanize(s) })), v.status, `id="${id("status")}"`)}${errText(e, "status")}</label>
    <label>Payer<input type="text" name="payer" maxlength="120" value="${v.payer || ""}"></label>
    <label>Authorization #<input type="text" name="auth_number" maxlength="120" value="${v.auth_number || ""}" autocomplete="off"></label>
    <label>Counted in ${select("unit_type", UNIT_TYPES, v.unit_type || "days", `id="${id("unit_type")}"`)}${errText(e, "unit_type")}</label>
    <label>Approved<input type="number" min="0" max="9999" name="units_approved" value="${v.units_approved ?? ""}">${errText(e, "units_approved")}</label>
    <label>Used <span class="hint">(blank = count automatically)</span><input type="number" min="0" max="9999" name="units_used" value="${v.units_used ?? ""}">${errText(e, "units_used")}</label>
    <label>Start date<input type="date" name="start_date" value="${v.start_date || ""}">${errText(e, "start_date")}</label>
    <label>End date<input type="date" name="end_date" value="${v.end_date || ""}">${errText(e, "end_date")}</label>
    <label>Next review<input type="date" name="next_review_date" value="${v.next_review_date || ""}">${errText(e, "next_review_date")}</label>
    <label>Payer reviewer / contact<input type="text" name="reviewer" maxlength="120" value="${v.reviewer || ""}"></label>
    <label class="span-all">Notes<textarea name="notes" rows="2" maxlength="2000">${v.notes || ""}</textarea></label>`;
}

function locTab(req, res, patient, { form = null, v = {}, e = {} } = {}, status = 200) {
  const db = req.db;
  const u = req.user;
  const base = `/ehr/patients/${patient.id}`;
  const cur = currentEpisode(db, patient.id);
  const episodes = db.prepare(`SELECT ep.*, u1.name AS created_name, u2.name AS ended_name FROM loc_episodes ep
    LEFT JOIN users u1 ON u1.id = ep.created_by LEFT JOIN users u2 ON u2.id = ep.ended_by
    WHERE ep.patient_id = ? ORDER BY ep.start_date DESC, ep.id DESC`).all(patient.id);
  const auths = db.prepare("SELECT * FROM loc_authorizations WHERE patient_id = ? ORDER BY COALESCE(start_date, created_at) DESC, id DESC").all(patient.id);
  const asam = can(u, "clinical:read") ? latestAsam(db, patient.id) : null;
  audit(req, "view", "level_of_care", null, patient.id);
  const t = today();
  const insurer = db.prepare("SELECT payer_name FROM insurance_policies WHERE patient_id = ? AND active = 1 ORDER BY priority = 'primary' DESC LIMIT 1").get(patient.id);

  const curCard = html`
    <section class="card loc-current" aria-labelledby="loc-cur">
      <div class="card__head"><h2 id="loc-cur">Current level of care</h2></div>
      ${cur ? html`
        <div class="loc-now">
          <div class="loc-now__level">${levelLabel(cur.level)}</div>
          <div class="muted">${cur.asam_level ? html`ASAM ${cur.asam_level} · ` : ""}${cur.program ? html`${cur.program} · ` : ""}since ${fmtDate(cur.start_date)} · day ${daysBetween(cur.start_date, t) + 1}</div>
          ${cur.reason ? html`<p class="loc-now__why">${cur.reason}</p>` : ""}
        </div>` : html`<p class="muted">Not currently admitted to a level of care.</p>`}
      ${asam && cur && cur.asam_level && asam.level !== cur.asam_level ? html`
        <div class="alert alert--warn" role="note">The latest signed ASAM assessment (${fmtDate(asam.date)}) recommends <strong>ASAM ${asam.level}</strong>, but the client is at ASAM ${cur.asam_level}.
          Document why, or change the level. <a href="/ehr/notes/${asam.id}">Open the ASAM note</a></div>` : ""}
      ${asam && !cur ? html`<p class="hint">Latest signed ASAM assessment (${fmtDate(asam.date)}) recommends ASAM ${asam.level}.</p>` : ""}
      ${canEpisodes(u) ? html`
        <details class="loc-action" ${form === "episode" ? raw("open") : ""}>
          <summary class="btn btn--primary btn--sm">${cur ? "Change level of care" : "Admit to a level of care"}</summary>
          <form method="post" action="${base}/level-of-care" class="stack" novalidate>
            ${csrfField(req)}${form === "episode" ? errorSummary(e) : ""}
            ${cur ? html`<p class="hint">This ends ${levelLabel(cur.level)} the day the new level starts.</p>` : ""}
            <div class="form-grid">
              ${episodeFields(form === "episode" ? v : { start_date: t, asam_level: "" }, form === "episode" ? e : {})}
              ${cur ? html`<label>Reason for the change ${select("change_reason", CHANGE_REASONS, form === "episode" ? v.change_reason : "")}${errText(form === "episode" ? e : {}, "change_reason")}</label>` : ""}
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">${cur ? "Change level" : "Admit"}</button></div>
          </form>
        </details>
        ${cur ? html`
        <details class="loc-action" ${form === "discharge" ? raw("open") : ""}>
          <summary class="btn btn--sm">Discharge from ${LEVEL[cur.level] ? LEVEL[cur.level].short : "this level"}</summary>
          <form method="post" action="${base}/level-of-care/${cur.id}/discharge" class="stack" novalidate>
            ${csrfField(req)}${form === "discharge" ? errorSummary(e) : ""}
            <div class="form-grid">
              <label>Discharge date<input type="date" name="end_date" value="${form === "discharge" ? v.end_date || "" : t}">${errText(form === "discharge" ? e : {}, "end_date")}</label>
              <label>Reason ${select("end_reason", DISCHARGE_REASONS, form === "discharge" ? v.end_reason : "")}${errText(form === "discharge" ? e : {}, "end_reason")}</label>
              <label class="span-all">Discharge note <span class="hint">(optional; write the full discharge summary as a note)</span><textarea name="end_note" rows="2" maxlength="1000">${form === "discharge" ? v.end_note || "" : ""}</textarea></label>
            </div>
            <div class="form-actions"><button class="btn" type="submit">Discharge</button></div>
          </form>
        </details>` : ""}` : ""}
    </section>`;

  const history = html`
    <section class="card" aria-labelledby="loc-hist">
      <div class="card__head"><h2 id="loc-hist">Level of care history</h2><span class="muted small">${episodes.length} episode${episodes.length === 1 ? "" : "s"}</span></div>
      ${episodes.length ? html`<ol class="loc-timeline">${episodes.map((ep) => html`
        <li class="${ep.end_date ? "" : "is-current"}">
          <div class="loc-timeline__head"><strong>${levelLabel(ep.level)}</strong>${ep.asam_level ? html` <span class="pill">ASAM ${ep.asam_level}</span>` : ""}${ep.end_date ? "" : html` <span class="badge badge--ok">Current</span>`}</div>
          <div class="muted small">${fmtDate(ep.start_date)} – ${ep.end_date ? fmtDate(ep.end_date) : "present"} · ${daysBetween(ep.start_date, ep.end_date || t) + (ep.end_date ? 0 : 1)} days${ep.program ? ` · ${ep.program}` : ""}${ep.created_name ? ` · entered by ${ep.created_name}` : ""}</div>
          ${ep.reason ? html`<p>${ep.reason}</p>` : ""}
          ${ep.end_reason ? html`<p class="small"><span class="muted">Ended:</span> ${reasonLabel([...CHANGE_REASONS, ...DISCHARGE_REASONS], ep.end_reason)}${ep.end_note ? ` · ${ep.end_note}` : ""}</p>` : ""}
          ${canEpisodes(u) ? html`<details class="loc-edit"><summary class="small">Correct this entry</summary>
            <form method="post" action="${base}/level-of-care/${ep.id}/edit" class="stack" novalidate>${csrfField(req)}
              <div class="form-grid">${episodeFields(form === `edit-${ep.id}` ? v : ep, form === `edit-${ep.id}` ? e : {}, { withEnd: true })}</div>
              ${form === `edit-${ep.id}` ? errorSummary(e) : ""}
              <div class="form-actions"><button class="btn btn--sm" type="submit">Save correction</button></div></form></details>` : ""}
        </li>`)}</ol>` : html`<p class="muted">No levels of care recorded yet.</p>`}
    </section>`;

  const authCard = html`
    <section class="card" id="authorizations" aria-labelledby="loc-auth">
      <div class="card__head"><h2 id="loc-auth">Authorizations &amp; utilization review</h2></div>
      ${auths.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Level</th><th>Payer / auth #</th><th>Status</th><th>Dates</th><th class="num">Used / approved</th><th>Next review</th></tr></thead>
        <tbody>${auths.map((a) => {
          const used = unitsUsed(db, a, t);
          const alerts = authAlerts(db, a, t);
          return html`<tr>
            <td>${LEVEL[a.level] ? LEVEL[a.level].short : humanize(a.level)}</td>
            <td>${a.payer || html`<span class="muted">—</span>`}${a.auth_number ? html`<br><span class="small muted">#${a.auth_number}</span>` : ""}</td>
            <td><span class="badge badge--${AUTH_TONE[a.status]}">${humanize(a.status)}</span>${alerts.map((x) => html`<br><span class="badge badge--${x.tone}">${x.text}</span>`)}</td>
            <td class="small">${a.start_date ? fmtDate(a.start_date) : "—"} – ${a.end_date ? fmtDate(a.end_date) : "open"}</td>
            <td class="num">${used ?? "—"} / ${a.units_approved ?? "—"} ${a.unit_type}</td>
            <td>${a.next_review_date ? fmtDate(a.next_review_date) : html`<span class="muted">—</span>`}${a.reviewer ? html`<br><span class="small muted">${a.reviewer}</span>` : ""}</td>
          </tr>
          ${canAuth(u) ? html`<tr class="loc-auth-edit"><td colspan="6"><details ${form === `auth-${a.id}` ? raw("open") : ""}><summary class="small">Update this authorization${a.notes ? " · has notes" : ""}</summary>
            <form method="post" action="${base}/authorizations/${a.id}/edit" class="stack" novalidate>${csrfField(req)}
              ${form === `auth-${a.id}` ? errorSummary(e) : ""}
              <div class="form-grid">${authFields(form === `auth-${a.id}` ? v : a, form === `auth-${a.id}` ? e : {}, `a${a.id}-`)}</div>
              <div class="form-actions"><button class="btn btn--sm btn--primary" type="submit">Save</button></div></form></details></td></tr>` : ""}`;
        })}</tbody></table></div>` : html`<p class="muted">No authorizations recorded.</p>`}
      ${canAuth(u) ? html`
        <details class="loc-action" ${form === "auth" ? raw("open") : ""}>
          <summary class="btn btn--sm">Add authorization</summary>
          <form method="post" action="${base}/authorizations" class="stack" novalidate>
            ${csrfField(req)}${form === "auth" ? errorSummary(e) : ""}
            <div class="form-grid">${authFields(form === "auth" ? v : { level: cur ? cur.level : "", status: "pending", unit_type: cur && ["op", "iop", "aftercare", "early"].includes(cur.level) ? "sessions" : "days",
              start_date: cur ? cur.start_date : "", payer: insurer ? insurer.payer_name : "" }, form === "auth" ? e : {}, "new-")}</div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add authorization</button></div>
          </form>
        </details>` : ""}
    </section>`;

  res.status(status).send(chartPage(req, patient, "loc", html`${curCard}${authCard}${history}`, { title: `Level of care · ${patientName(patient)}` }));
}

function loadPatient(req, res) {
  const p = getPatient(req, req.params.id);
  if (!p) notFound(req, res, "Patient");
  return p;
}

router.get("/patients/:id/level-of-care", gate(canView), (req, res) => {
  const p = loadPatient(req, res);
  if (p) locTab(req, res, p);
});

router.post("/patients/:id/level-of-care", gate(canEpisodes), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const db = req.db;
  const cur = currentEpisode(db, p.id);
  const { v, e } = readEpisode(req.body || {}, { requireReason: !!cur });
  if (cur && !e.start_date && v.start_date < cur.start_date) e.start_date = `The new level can't start before the current one (${fmtDate(cur.start_date)}).`;
  if (cur && !e.level && v.level === cur.level && (v.asam_level || "") === (cur.asam_level || "") && (v.program || "") === (cur.program || "")) e.level = "That's the current level. Choose a different level, ASAM level or program.";
  if (Object.keys(e).length) return locTab(req, res, p, { form: "episode", v, e }, 400);
  db.exec("BEGIN");
  try {
    if (cur) {
      db.prepare("UPDATE loc_episodes SET end_date = ?, end_reason = ?, ended_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(v.start_date, v.change_reason, req.user.id, cur.id);
    }
    const r = db.prepare(`INSERT INTO loc_episodes (patient_id, level, asam_level, program, start_date, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, v.level, nn(v.asam_level), nn(v.program), v.start_date, nn(v.reason), req.user.id);
    db.exec("COMMIT");
    audit(req, cur ? "update" : "create", "level_of_care", Number(r.lastInsertRowid), p.id, cur ? `${cur.level} -> ${v.level} (${v.change_reason})` : `admit ${v.level}`);
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  req.flash("success", cur ? `Level of care changed to ${levelLabel(v.level)}.` : `Admitted to ${levelLabel(v.level)}.`);
  res.redirect(`/ehr/patients/${p.id}/level-of-care`);
});

function loadEpisode(req, res, p) {
  const ep = req.db.prepare("SELECT * FROM loc_episodes WHERE id = ? AND patient_id = ?").get(Number(req.params.eid), p.id);
  if (!ep) notFound(req, res, "Level of care entry");
  return ep;
}

router.post("/patients/:id/level-of-care/:eid/edit", gate(canEpisodes), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const ep = loadEpisode(req, res, p);
  if (!ep) return;
  const { v, e } = readEpisode(req.body || {});
  if (!v.end_date && !e.end_date) {
    const other = req.db.prepare("SELECT 1 FROM loc_episodes WHERE patient_id = ? AND end_date IS NULL AND id <> ?").get(p.id, ep.id);
    if (other) e.end_date = "Another level is current, so this one needs an end date.";
  }
  if (Object.keys(e).length) return locTab(req, res, p, { form: `edit-${ep.id}`, v, e }, 400);
  req.db.prepare(`UPDATE loc_episodes SET level = ?, asam_level = ?, program = ?, start_date = ?, end_date = ?, reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(v.level, nn(v.asam_level), nn(v.program), v.start_date, nn(v.end_date), nn(v.reason), ep.id);
  audit(req, "update", "level_of_care", ep.id, p.id, "corrected");
  req.flash("success", "Level of care entry corrected.");
  res.redirect(`/ehr/patients/${p.id}/level-of-care`);
});

router.post("/patients/:id/level-of-care/:eid/discharge", gate(canEpisodes), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const ep = loadEpisode(req, res, p);
  if (!ep) return;
  const b = req.body || {};
  const v = { end_date: str(b.end_date, 10), end_reason: str(b.end_reason, 40), end_note: str(b.end_note, 1000) };
  const e = {};
  if (ep.end_date) e.end_date = "This level has already ended.";
  else if (!isDate(v.end_date)) e.end_date = "Enter the discharge date.";
  else if (v.end_date < ep.start_date) e.end_date = "Discharge can't be before the level started.";
  if (!DISCHARGE_REASONS.some((o) => o.value && o.value === v.end_reason)) e.end_reason = "Choose a discharge reason.";
  if (Object.keys(e).length) return locTab(req, res, p, { form: "discharge", v, e }, 400);
  req.db.prepare("UPDATE loc_episodes SET end_date = ?, end_reason = ?, end_note = ?, ended_by = ?, updated_at = datetime('now') WHERE id = ?")
    .run(v.end_date, v.end_reason, nn(v.end_note), req.user.id, ep.id);
  audit(req, "update", "level_of_care", ep.id, p.id, `discharge ${v.end_reason}`);
  req.flash("success", `Discharged from ${levelLabel(ep.level)}.`);
  res.redirect(`/ehr/patients/${p.id}/level-of-care`);
});

router.post("/patients/:id/authorizations", gate(canAuth), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const { v, e } = readAuth(req.body || {});
  if (Object.keys(e).length) return locTab(req, res, p, { form: "auth", v, e }, 400);
  const cur = currentEpisode(req.db, p.id);
  const r = req.db.prepare(`INSERT INTO loc_authorizations (patient_id, episode_id, level, payer, auth_number, status, unit_type, units_approved, units_used,
    start_date, end_date, next_review_date, reviewer, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, cur && cur.level === v.level ? cur.id : null, v.level, nn(v.payer), nn(v.auth_number), v.status, v.unit_type, num(v.units_approved), num(v.units_used),
      nn(v.start_date), nn(v.end_date), nn(v.next_review_date), nn(v.reviewer), nn(v.notes), req.user.id);
  audit(req, "create", "loc_authorization", Number(r.lastInsertRowid), p.id, v.status);
  req.flash("success", "Authorization added.");
  res.redirect(`/ehr/patients/${p.id}/level-of-care#authorizations`);
});

router.post("/patients/:id/authorizations/:aid/edit", gate(canAuth), (req, res) => {
  const p = loadPatient(req, res);
  if (!p) return;
  const a = req.db.prepare("SELECT * FROM loc_authorizations WHERE id = ? AND patient_id = ?").get(Number(req.params.aid), p.id);
  if (!a) return notFound(req, res, "Authorization");
  const { v, e } = readAuth(req.body || {});
  if (Object.keys(e).length) return locTab(req, res, p, { form: `auth-${a.id}`, v, e }, 400);
  req.db.prepare(`UPDATE loc_authorizations SET level = ?, payer = ?, auth_number = ?, status = ?, unit_type = ?, units_approved = ?, units_used = ?,
    start_date = ?, end_date = ?, next_review_date = ?, reviewer = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(v.level, nn(v.payer), nn(v.auth_number), v.status, v.unit_type, num(v.units_approved), num(v.units_used), nn(v.start_date), nn(v.end_date),
      nn(v.next_review_date), nn(v.reviewer), nn(v.notes), a.id);
  audit(req, "update", "loc_authorization", a.id, p.id, a.status === v.status ? "updated" : `${a.status} -> ${v.status}`);
  req.flash("success", "Authorization updated.");
  res.redirect(`/ehr/patients/${p.id}/level-of-care#authorizations`);
});

/* ------------------------------------------------------------------ */
/* Census                                                              */
/* ------------------------------------------------------------------ */

/** Utilization reviews due within `days` (or overdue) and authorizations about to lapse, for the census and dashboard. */
function urDue(db, { days = 3, clinicianId = null } = {}) {
  const t = today();
  return db.prepare(`SELECT a.*, p.first_name, p.last_name, p.preferred_name FROM loc_authorizations a JOIN patients p ON p.id = a.patient_id
    WHERE a.status IN ('approved','pending','requested')
      AND ((a.next_review_date IS NOT NULL AND a.next_review_date <= ?) OR (a.status = 'approved' AND a.end_date IS NOT NULL AND a.end_date <= ?))
      ${clinicianId ? "AND p.primary_clinician_id = ?" : ""}
    ORDER BY COALESCE(a.next_review_date, a.end_date), p.last_name LIMIT 50`).all(addDays(t, days), addDays(t, days), ...(clinicianId ? [clinicianId] : []));
}

router.get("/census", gate(canView), (req, res) => {
  const db = req.db;
  const d = isDate(String(req.query.date || "")) ? String(req.query.date) : today();
  const levelFilter = LEVEL[req.query.level] ? req.query.level : "";
  const rows = db.prepare(`SELECT ep.*, p.first_name, p.last_name, p.preferred_name, p.mrn, u.name AS clinician
    FROM loc_episodes ep JOIN patients p ON p.id = ep.patient_id LEFT JOIN users u ON u.id = p.primary_clinician_id
    WHERE ep.start_date <= ? AND (ep.end_date IS NULL OR ep.end_date > ?) ${levelFilter ? "AND ep.level = ?" : ""}
    ORDER BY ep.level, p.last_name, p.first_name`).all(d, d, ...(levelFilter ? [levelFilter] : []));
  const counts = Object.fromEntries(LEVELS.map((l) => [l.value, 0]));
  for (const r of db.prepare(`SELECT level, COUNT(*) AS n FROM loc_episodes WHERE start_date <= ? AND (end_date IS NULL OR end_date > ?) GROUP BY level`).all(d, d)) counts[r.level] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const admits = db.prepare(`SELECT ep.*, p.first_name, p.last_name, p.preferred_name FROM loc_episodes ep JOIN patients p ON p.id = ep.patient_id
    WHERE ep.start_date = ? ORDER BY p.last_name`).all(d);
  const ends = db.prepare(`SELECT ep.*, p.first_name, p.last_name, p.preferred_name FROM loc_episodes ep JOIN patients p ON p.id = ep.patient_id
    WHERE ep.end_date = ? ORDER BY p.last_name`).all(d);
  const authFor = db.prepare(`SELECT * FROM loc_authorizations WHERE patient_id = ? AND level = ? AND status IN ('approved','pending','requested')
    ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`);
  const due = urDue(db, { days: 3 });
  audit(req, "view", "census", null, null, `${d}${levelFilter ? ` ${levelFilter}` : ""}`);
  const t = today();

  res.send(page(req, {
    title: "Census",
    active: "census",
    body: html`
      <div class="page-head"><div><h1>Census</h1><p>${total} client${total === 1 ? "" : "s"} in care on ${fmtDate(d)}</p></div>
        <form method="get" action="/ehr/census" class="row no-print">
          <label class="visually-hidden" for="census-date">Date</label><input id="census-date" type="date" name="date" value="${d}">
          ${levelFilter ? html`<input type="hidden" name="level" value="${levelFilter}">` : ""}
          <button class="btn btn--sm" type="submit">Go</button>
          ${d !== t ? html`<a class="btn btn--sm btn--ghost" href="/ehr/census">Today</a>` : ""}
        </form></div>
      <div class="tiles loc-tiles">
        ${LEVELS.filter((l) => counts[l.value] || ["detox", "residential", "php", "iop", "op"].includes(l.value)).map((l) => html`
          <a class="tile${levelFilter === l.value ? " tile--active" : ""}" href="/ehr/census?date=${d}${levelFilter === l.value ? "" : `&level=${l.value}`}">
            <span class="tile__num">${counts[l.value]}</span><span class="tile__label">${l.short}${l.asam ? ` · ASAM ${l.asam}` : ""}</span></a>`)}
      </div>
      ${due.length ? html`
        <section class="card card--alert" aria-labelledby="ur-due">
          <h2 id="ur-due">Utilization reviews &amp; authorizations needing action</h2>
          <ul class="list-plain">${due.map((a) => html`<li class="row">
            <a href="/ehr/patients/${a.patient_id}/level-of-care#authorizations">${patientName(a)}</a>
            <span class="muted small">${LEVEL[a.level] ? LEVEL[a.level].short : a.level}${a.payer ? ` · ${a.payer}` : ""}</span>
            ${authAlerts(db, a, t).map((x) => html`<span class="badge badge--${x.tone}">${x.text}</span>`)}</li>`)}</ul>
        </section>` : ""}
      <section class="card" aria-labelledby="census-h">
        <div class="card__head"><h2 id="census-h">${levelFilter ? levelLabel(levelFilter) : "All levels"}</h2>${levelFilter ? html`<a class="btn btn--sm btn--ghost" href="/ehr/census?date=${d}">Show all</a>` : ""}</div>
        ${rows.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Client</th><th>Level</th><th class="num">Day</th><th>Clinician</th><th>Authorization</th></tr></thead>
          <tbody>${rows.map((r) => {
            const a = authFor.get(r.patient_id, r.level);
            const used = a ? unitsUsed(db, a, d) : null;
            return html`<tr>
              <td><a href="/ehr/patients/${r.patient_id}/level-of-care">${patientName(r)}</a><br><span class="small muted">${r.mrn}</span></td>
              <td>${LEVEL[r.level] ? LEVEL[r.level].short : r.level}${r.asam_level ? html` <span class="pill">ASAM ${r.asam_level}</span>` : ""}${r.program ? html`<br><span class="small muted">${r.program}</span>` : ""}</td>
              <td class="num">${daysBetween(r.start_date, d) + 1}</td>
              <td>${r.clinician || html`<span class="muted">Unassigned</span>`}</td>
              <td>${a ? html`<span class="badge badge--${AUTH_TONE[a.status]}">${humanize(a.status)}</span> <span class="small">${used ?? "—"}/${a.units_approved ?? "—"} ${a.unit_type}${a.next_review_date ? ` · review ${fmtDate(a.next_review_date)}` : ""}</span>`
                : html`<span class="badge badge--warn">No authorization</span>`}</td></tr>`;
          })}</tbody></table></div>` : html`<p class="muted">No clients ${levelFilter ? "at this level" : "in care"} on this date.</p>`}
      </section>
      <div class="grid-2">
        <section class="card"><h2>Admissions &amp; level changes</h2>
          ${admits.length ? html`<ul class="list-plain">${admits.map((r) => html`<li><a href="/ehr/patients/${r.patient_id}/level-of-care">${patientName(r)}</a> <span class="muted small">→ ${levelLabel(r.level)}</span></li>`)}</ul>` : html`<p class="muted">None on this date.</p>`}</section>
        <section class="card"><h2>Discharges &amp; transitions out</h2>
          ${ends.length ? html`<ul class="list-plain">${ends.map((r) => html`<li><a href="/ehr/patients/${r.patient_id}/level-of-care">${patientName(r)}</a> <span class="muted small">${levelLabel(r.level)} · ${reasonLabel([...CHANGE_REASONS, ...DISCHARGE_REASONS], r.end_reason)}</span></li>`)}</ul>` : html`<p class="muted">None on this date.</p>`}</section>
      </div>`,
  }));
});

module.exports = { router, LEVELS, currentEpisode, bannerPill, urDue, authAlerts, unitsUsed, canView };
