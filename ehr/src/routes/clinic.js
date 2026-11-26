"use strict";
/*
 * Administration → Clinic settings: the practice's name, logo, address, NPI, tax ID and brand color.
 *
 *   GET  /admin/clinic               form (admin)
 *   POST /admin/clinic               save details
 *   POST /admin/clinic/logo          upload logo (image_data = PNG/JPEG/WebP data URL from ehr.js; resized in the browser)
 *   POST /admin/clinic/logo/delete   remove logo
 *   GET  /admin/lists                Clinic lists: rooms, programs and therapy groups (admin)
 *   POST /admin/lists                add / rename / move / remove a list item
 *   GET  /brand/logo                 the logo image (public: shown on the sign-in page; not PHI). Mounted in app.js.
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, raw, page, csrfField, brandMark } = require("../views");
const { COLORS, FIELDS, getClinic } = require("../clinic");
const { sniff } = require("./photos");
const O = require("../options");

const router = express.Router();
const adminOnly = requirePerm("admin");
const MAX_LOGO = 1024 * 1024;

// Common NUCC taxonomy codes for behavioral health practices. "Other" accepts any valid code.
const TAXONOMIES = [
  ["261QM0801X", "Mental Health Clinic"], ["261QR0405X", "Substance Use Disorder Rehabilitation Clinic"],
  ["324500000X", "Substance Abuse Rehabilitation Facility"], ["320800000X", "Community Based Residential Treatment (Mental Illness)"],
  ["251S00000X", "Community/Behavioral Health Agency"], ["101YM0800X", "Mental Health Counselor"],
  ["101YA0400X", "Addiction (Substance Use Disorder) Counselor"], ["1041C0700X", "Clinical Social Worker"],
  ["106H00000X", "Marriage & Family Therapist"], ["103T00000X", "Psychologist"], ["2084P0800X", "Psychiatry"],
  ["363LP0808X", "Psychiatric/Mental Health Nurse Practitioner"],
].map(([value, label]) => ({ value, label: `${value} · ${label}` }));

const LIMITS = { name: 120, tagline: 80, address1: 120, address2: 120, city: 80, state: 2, zip: 10, phone: 30, fax: 30, email: 120, website: 200, npi: 10, tax_id: 10, taxonomy: 10, color: 20 };

function validate(b) {
  const v = {};
  for (const f of FIELDS) v[f] = String(b[f] ?? "").trim().slice(0, LIMITS[f] || 200);
  v.state = v.state.toUpperCase();
  v.taxonomy = String(O.readChoice(b, "taxonomy", { list: TAXONOMIES, other: true, max: 20 }) || "").toUpperCase();
  const e = {};
  if (!v.name) e.name = "Clinic name is required.";
  if (v.state && !O.STATE_CODES.includes(v.state)) e.state = "Choose the state from the list.";
  if (v.zip && !/^\d{5}(-\d{4})?$/.test(v.zip)) e.zip = "ZIP is 5 digits (or ZIP+4).";
  if (v.npi && !npiValid(v.npi)) e.npi = "That isn't a valid 10-digit NPI (check digit doesn't match).";
  if (v.tax_id && !/^\d{2}-?\d{7}$/.test(v.tax_id)) e.tax_id = "Tax ID (EIN) is 9 digits, e.g. 86-1234567.";
  else if (v.tax_id) v.tax_id = v.tax_id.replace(/^(\d{2})-?(\d{7})$/, "$1-$2");
  if (v.taxonomy && !/^[0-9]{3}[0-9A-Z]{6}X$/i.test(v.taxonomy)) e.taxonomy = "Taxonomy codes are 10 characters ending in X, e.g. 261QM0801X.";
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) e.email = "Enter a valid email address.";
  if (v.website && !/^https?:\/\/[^\s]+$/i.test(v.website)) e.website = "Start the website with https://";
  if (!COLORS[v.color]) v.color = "blue";
  return { v, e };
}

/** NPI check digit (Luhn with the 80840 prefix). */
function npiValid(npi) {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = ("80840" + npi.slice(0, 9)).split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

const err = (e, k) => (e[k] ? html`<span class="error-text">${e[k]}</span>` : "");
const field = (v, e, k, label, { hint = "", type = "text", attrs = "" } = {}) => html`
  <label>${label}${hint ? html` <span class="hint">${hint}</span>` : ""}<input type="${type}" name="${k}" value="${v[k] || ""}" maxlength="${LIMITS[k] || 200}" ${raw(attrs)}>${err(e, k)}</label>`;

function clinicPage(req, res, { v = null, e = {}, logoError = null } = {}, status = 200) {
  const c = getClinic(req.db);
  v = v || c;
  res.status(status).send(page(req, {
    title: "Clinic settings",
    active: "admin",
    body: html`
      <div class="page-head"><div><h1>Clinic settings</h1><p>Your practice's name, logo and billing details. They appear across the app, on printouts, superbills and emails.</p></div>
        <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
      ${c.billingReady ? "" : html`<div class="alert alert--warn" role="note">Add the address, group NPI and tax ID so superbills are complete.</div>`}
      <div class="grid grid--2">
        <form class="card stack" method="post" action="/ehr/admin/clinic" novalidate>
          ${csrfField(req)}
          <h2>Practice details</h2>
          ${Object.keys(e).length ? html`<div class="alert alert--error" role="alert">Please fix the highlighted fields.</div>` : ""}
          <div class="form-grid">
            <div class="span-all">${field(v, e, "name", "Clinic name", { attrs: "required" })}</div>
            <div class="span-all">${field(v, e, "tagline", "Tagline", { hint: "(shown under the name, e.g. Behavioral Health)" })}</div>
            <div class="span-all">${field(v, e, "address1", "Street address")}</div>
            <div class="span-all">${field(v, e, "address2", "Suite / unit")}</div>
            ${field(v, e, "city", "City")}
            <label for="state">State ${O.stateChoice("state", v.state || "")}${err(e, "state")}</label>
            ${field(v, e, "zip", "ZIP", { attrs: 'inputmode="numeric"' })}
            ${field(v, e, "phone", "Phone", { type: "tel" })}
            ${field(v, e, "fax", "Fax", { type: "tel" })}
            ${field(v, e, "email", "Email", { type: "email" })}
            ${field(v, e, "website", "Website", { type: "url" })}
            ${field(v, e, "npi", "Group NPI (Type 2)", { attrs: 'inputmode="numeric"' })}
            ${field(v, e, "tax_id", "Tax ID (EIN)")}
            <label for="taxonomy">Taxonomy code <span class="hint">(optional)</span> ${O.choice({ name: "taxonomy", list: TAXONOMIES, value: v.taxonomy || "", other: true, placeholder: "Choose a taxonomy…", otherPlaceholder: "10-character code, e.g. 261QM0801X" })}${err(e, "taxonomy")}</label>
          </div>
          <fieldset><legend>Brand color</legend>
            <div class="row">${Object.entries(COLORS).map(([k, col]) => html`
              <label class="check swatch"><input type="radio" name="color" value="${k}" ${k === (v.color || "blue") ? raw("checked") : ""}>
                <span class="swatch__dot" style="background:${col.primary}"></span> ${col.label}</label>`)}</div>
          </fieldset>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Save clinic settings</button></div>
        </form>
        <section class="card stack">
          <h2>Logo</h2>
          <div class="logo-preview">${brandMark(c, "brand-logo--lg")}<div><strong>${c.name}</strong><div class="muted small">${c.tagline}</div></div></div>
          ${logoError ? html`<div class="alert alert--error" role="alert">${logoError}</div>` : ""}
          <form method="post" action="/ehr/admin/clinic/logo" class="stack" data-photo-upload data-format="png" data-max="512">
            ${csrfField(req)}
            <input type="hidden" name="image_data" value="">
            <label>Upload a logo <input type="file" accept="image/*" data-photo-file required>
              <span class="hint">A square logo looks best. It's resized to 512 px.</span></label>
            <img class="photo-preview" alt="Preview of the new logo" hidden data-photo-preview>
            <p class="hint" data-photo-status role="status"></p>
            <div class="row"><button class="btn btn--primary btn--sm" type="submit">Upload logo</button></div>
          </form>
          ${c.hasLogo ? html`<form method="post" action="/ehr/admin/clinic/logo/delete" data-confirm="Remove the logo?">${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit">Remove logo</button></form>` : ""}
        </section>
        ${programsCard(req)}
      </div>`,
  }));
}

/** Optional programs a clinic can turn on. Off by default so a behavioral health clinic doesn't see medical tools. */
function programsCard(req) {
  const on = require("./trt").trtEnabled(req.db);
  let portalNotes = true;
  try { const r = req.db.prepare("SELECT portal_notes FROM clinic_settings WHERE id = 1").get(); portalNotes = !r || r.portal_notes !== 0; } catch { portalNotes = true; }
  return html`
    <form class="card stack" id="programs" method="post" action="/ehr/admin/clinic/programs">
      ${csrfField(req)}
      <h2>Programs</h2>
      <p class="muted small">Turn on extra tools for the kinds of care your clinic provides.</p>
      <label class="check"><input type="checkbox" name="trt_enabled" value="1" ${on ? raw("checked") : ""}>
        <span><strong>Hormone therapy (testosterone replacement, TRT)</strong><br>
        <span class="hint">Adds a Hormone therapy tab to each chart (regimen, labs, doses, vitals), a client list with labs and doses due, and a Schedule III stock record.</span></span></label>
      <label class="check"><input type="checkbox" name="portal_notes" value="1" ${portalNotes ? raw("checked") : ""}>
        <span><strong>Show signed visit notes in the patient portal</strong><br>
        <span class="hint">Federal information-blocking rules generally expect clients to be able to see their notes. Psychotherapy notes are never shown.</span></span></label>
      <div class="row"><button class="btn btn--sm btn--primary" type="submit">Save programs</button>${on ? html` <a class="btn btn--sm" href="/ehr/trt">Open hormone therapy</a>` : ""}</div>
    </form>`;
}

router.post("/admin/clinic/programs", adminOnly, (req, res) => {
  const trt = require("./trt");
  const on = (req.body || {}).trt_enabled === "1";
  const was = trt.trtEnabled(req.db);
  trt.setTrtEnabled(req.db, on);
  const notes = (req.body || {}).portal_notes === "1" ? 1 : 0;
  const wasNotes = (req.db.prepare("SELECT portal_notes FROM clinic_settings WHERE id = 1").get() || {}).portal_notes;
  req.db.prepare("UPDATE clinic_settings SET portal_notes = ? WHERE id = 1").run(notes);
  if (wasNotes !== notes) audit(req, "update", "clinic_settings", 1, null, `portal notes ${notes ? "on" : "off"}`);
  if (on !== was) audit(req, "update", "clinic_settings", 1, null, `trt ${on ? "on" : "off"}`);
  req.flash("success", on ? "Hormone therapy is on. Each chart now has a Hormone therapy tab." : "Hormone therapy is off. Its records are kept and come back if you turn it on again.");
  res.redirect("/ehr/admin/clinic#programs");
});

router.get("/admin/clinic", adminOnly, (req, res) => clinicPage(req, res));

router.post("/admin/clinic", adminOnly, (req, res) => {
  const { v, e } = validate(req.body || {});
  if (Object.keys(e).length) return clinicPage(req, res, { v, e }, 400);
  const before = getClinic(req.db);
  req.db.prepare(`UPDATE clinic_settings SET ${FIELDS.map((f) => `${f} = ?`).join(", ")}, updated_by = ?, updated_at = datetime('now') WHERE id = 1`)
    .run(...FIELDS.map((f) => (v[f] === "" && f !== "name" && f !== "color" ? null : v[f])), req.user.id);
  const changed = FIELDS.filter((f) => String(before[f] ?? "") !== String(v[f] ?? ""));
  audit(req, "update", "clinic_settings", 1, null, changed.length ? `fields: ${changed.join(",")}` : "no changes");
  req.flash("success", "Clinic settings saved.");
  res.redirect("/ehr/admin/clinic");
});

router.post("/admin/clinic/logo", adminOnly, (req, res) => {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String((req.body || {}).image_data || ""));
  if (!m) return clinicPage(req, res, { logoError: "Choose an image to upload." }, 400);
  const buf = Buffer.from(m[2], "base64");
  const mime = sniff(buf);
  if (!mime) return clinicPage(req, res, { logoError: "That file isn't a PNG, JPEG or WebP image." }, 400);
  if (buf.length > MAX_LOGO) return clinicPage(req, res, { logoError: "That logo is too large (1 MB max)." }, 400);
  req.db.prepare("UPDATE clinic_settings SET logo = ?, logo_mime = ?, updated_by = ?, updated_at = datetime('now') WHERE id = 1").run(buf, mime, req.user.id);
  audit(req, "update", "clinic_settings", 1, null, "logo uploaded");
  req.flash("success", "Logo updated.");
  res.redirect("/ehr/admin/clinic");
});

router.post("/admin/clinic/logo/delete", adminOnly, (req, res) => {
  req.db.prepare("UPDATE clinic_settings SET logo = NULL, logo_mime = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = 1").run(req.user.id);
  audit(req, "update", "clinic_settings", 1, null, "logo removed");
  req.flash("success", "Logo removed.");
  res.redirect("/ehr/admin/clinic");
});

/* ---------------- Appointment colors ---------------- */
const { DEFAULTS: APPT_DEFAULTS, SWATCHES, HEX, apptColors } = require("../appt-colors");
const APPT_TYPES = Object.keys(APPT_DEFAULTS);
const typeName = (t) => t.replace(/_/g, " ").replace(/\b\w/, (c) => c.toUpperCase()).replace("eval", "evaluation").replace("med ", "medication ");

router.get("/admin/appointment-colors", adminOnly, (req, res) => {
  const colors = apptColors(req.db);
  res.send(page(req, {
    title: "Appointment colors",
    active: "admin",
    body: html`
      <div class="page-head"><div><h1>Appointment colors</h1><p>Pick a color for each appointment type. It's used on the schedule, the dashboard and appointment pages.</p></div>
        <a class="btn btn--sm" href="/ehr/schedule">Open schedule</a></div>
      <form class="card stack" method="post" action="/ehr/admin/appointment-colors">
        ${csrfField(req)}
        <ul class="list-plain color-rows">${APPT_TYPES.map((t) => html`
          <li class="color-row">
            <span class="appt appt--scheduled color-row__sample" style="--appt:${colors[t]}"><strong>9:00 AM</strong> ${typeName(t)}</span>
            <div class="color-row__pick">
              <label class="visually-hidden" for="c-${t}">${typeName(t)} color</label>
              <input type="color" id="c-${t}" name="${t}" value="${colors[t]}" data-color-input>
              <div class="swatches">${SWATCHES.map((c) => html`<button type="button" class="swatch-btn" style="background:${c}" data-swatch="${c}" data-target="c-${t}" aria-label="Use ${c} for ${typeName(t)}"></button>`)}</div>
            </div>
          </li>`)}</ul>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Save colors</button>
          <button class="btn btn--ghost" type="submit" name="reset" value="1" data-confirm="Go back to the default colors?">Reset to defaults</button></div>
      </form>`,
  }));
});

router.post("/admin/appointment-colors", adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.reset === "1") {
    req.db.prepare("DELETE FROM appointment_type_colors").run();
    audit(req, "update", "appointment_colors", null, null, "reset");
    req.flash("success", "Appointment colors reset to the defaults.");
    return res.redirect("/ehr/admin/appointment-colors");
  }
  const up = req.db.prepare(`INSERT INTO appointment_type_colors (type, color) VALUES (?, ?)
    ON CONFLICT(type) DO UPDATE SET color = excluded.color, updated_at = datetime('now')`);
  const changed = [];
  for (const t of APPT_TYPES) {
    const c = String(b[t] || "").toLowerCase();
    if (HEX.test(c)) { up.run(t, c); changed.push(t); }
  }
  audit(req, "update", "appointment_colors", null, null, changed.join(","));
  req.flash("success", "Appointment colors saved.");
  res.redirect("/ehr/admin/appointment-colors");
});

/* ---------------- Clinic lists (rooms, programs, groups) ---------------- */
const { KINDS, getList } = require("../lists");
const LIST_ACTIONS = ["add", "rename", "up", "down", "remove"];

function listRows(db, kind) {
  getList(db, kind); // seeds defaults the first time
  return db.prepare("SELECT id, label, sort FROM clinic_lists WHERE kind = ? AND active = 1 ORDER BY sort, label").all(kind);
}

router.get("/admin/lists", adminOnly, (req, res) => {
  res.send(page(req, {
    title: "Clinic lists",
    active: "admin",
    body: html`
      <div class="page-head"><div><h1>Clinic lists</h1><p>The rooms, programs and therapy groups offered in dropdowns across the EHR (schedule, level of care, group notes). Every dropdown also has an "Other" choice.</p></div>
        <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
      ${Object.entries(KINDS).map(([kind, title]) => {
        const rows = listRows(req.db, kind);
        return html`
        <section class="card stack" id="list-${kind}" aria-labelledby="h-${kind}">
          <h2 id="h-${kind}">${title}</h2>
          ${rows.length ? html`<ul class="list-plain stack">${rows.map((r, i) => html`
            <li class="row">
              <form method="post" action="/ehr/admin/lists" class="row">
                ${csrfField(req)}<input type="hidden" name="id" value="${r.id}"><input type="hidden" name="action" value="rename">
                <label class="visually-hidden" for="l-${r.id}">Name</label>
                <input type="text" id="l-${r.id}" name="label" value="${r.label}" maxlength="80" required>
                <button class="btn btn--sm" type="submit">Rename</button>
              </form>
              <form method="post" action="/ehr/admin/lists" class="row">
                ${csrfField(req)}<input type="hidden" name="id" value="${r.id}">
                <button class="btn btn--sm btn--ghost" type="submit" name="action" value="up" ${i === 0 ? raw("disabled") : ""} aria-label="Move ${r.label} up">Move up</button>
                <button class="btn btn--sm btn--ghost" type="submit" name="action" value="down" ${i === rows.length - 1 ? raw("disabled") : ""} aria-label="Move ${r.label} down">Move down</button>
                <button class="btn btn--sm btn--ghost" type="submit" name="action" value="remove" data-confirm="Remove ${r.label} from the list? Records that already use it keep it." aria-label="Remove ${r.label}">Remove</button>
              </form>
            </li>`)}</ul>` : html`<p class="muted">No items yet.</p>`}
          <form method="post" action="/ehr/admin/lists" class="row">
            ${csrfField(req)}<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="action" value="add">
            <label for="add-${kind}">Add item <input type="text" id="add-${kind}" name="label" maxlength="80" required></label>
            <button class="btn btn--primary btn--sm" type="submit">Add</button>
          </form>
        </section>`;
      })}`,
  }));
});

router.post("/admin/lists", adminOnly, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || "");
  const back = (kind) => res.redirect(`/ehr/admin/lists${kind ? `#list-${kind}` : ""}`);
  const fail = (msg, kind) => { req.flash("error", msg); back(kind); };
  if (!LIST_ACTIONS.includes(action)) return fail("Unknown action.");
  const db = req.db;
  const label = String(b.label ?? "").trim().replace(/\s+/g, " ");
  const checkLabel = (kind, exceptId = 0) => {
    if (label.length < 1 || label.length > 80) return "Names must be 1 to 80 characters.";
    const dup = db.prepare("SELECT id, active FROM clinic_lists WHERE kind = ? AND label = ? COLLATE NOCASE AND id != ?").get(kind, label, exceptId);
    if (dup && dup.active) return `"${label}" is already on the list.`;
    return dup ? { revive: dup.id } : null;
  };

  if (action === "add") {
    const kind = String(b.kind || "");
    if (!KINDS[kind]) return fail("Unknown list.");
    getList(db, kind);
    const err = checkLabel(kind);
    if (typeof err === "string") return fail(err, kind);
    const next = (db.prepare("SELECT MAX(sort) AS m FROM clinic_lists WHERE kind = ? AND active = 1").get(kind).m ?? -1) + 1;
    let id;
    if (err && err.revive) { db.prepare("UPDATE clinic_lists SET active = 1, label = ?, sort = ? WHERE id = ?").run(label, next, err.revive); id = err.revive; }
    else id = Number(db.prepare("INSERT INTO clinic_lists (kind, label, sort) VALUES (?, ?, ?)").run(kind, label, next).lastInsertRowid);
    audit(req, "update", "clinic_lists", id, null, kind);
    req.flash("success", `Added "${label}".`);
    return back(kind);
  }

  const row = /^\d+$/.test(String(b.id || "")) ? db.prepare("SELECT * FROM clinic_lists WHERE id = ? AND active = 1").get(Number(b.id)) : null;
  if (!row) return fail("That item was not found.");
  const kind = row.kind;

  if (action === "rename") {
    const err = checkLabel(kind, row.id);
    if (typeof err === "string") return fail(err, kind);
    if (err && err.revive) db.prepare("DELETE FROM clinic_lists WHERE id = ?").run(err.revive); // a removed item with this name; free the name
    db.prepare("UPDATE clinic_lists SET label = ? WHERE id = ?").run(label, row.id);
    req.flash("success", `Renamed to "${label}".`);
  } else if (action === "remove") {
    db.prepare("UPDATE clinic_lists SET active = 0 WHERE id = ?").run(row.id);
    req.flash("success", `Removed "${row.label}". Records that already use it keep it.`);
  } else {
    const rows = listRows(db, kind);
    const i = rows.findIndex((r) => r.id === row.id);
    const j = action === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < rows.length) {
      [rows[i], rows[j]] = [rows[j], rows[i]];
      const up = db.prepare("UPDATE clinic_lists SET sort = ? WHERE id = ?");
      rows.forEach((r, k) => up.run(k, r.id));
    }
  }
  audit(req, "update", "clinic_lists", row.id, null, kind);
  back(kind);
});

/** Public handlers mounted before sign-in (app.js): the logo and the home-screen app manifest. */
function logoHandler(req, res) {
  const row = req.db.prepare("SELECT logo, logo_mime FROM clinic_settings WHERE id = 1").get();
  if (!row || !row.logo) return res.status(404).end();
  res.set({ "Content-Type": row.logo_mime, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(row.logo));
}
function manifestHandler(base) {
  return (req, res) => {
    const c = getClinic(req.db);
    const m = { ...base, name: c.name, short_name: c.name.length > 14 ? c.name.split(/\s+/)[0].slice(0, 14) : c.name, theme_color: base.theme_color };
    res.type("application/manifest+json").set("Cache-Control", "no-cache").send(JSON.stringify(m));
  };
}

module.exports = { router, npiValid, logoHandler, manifestHandler };
