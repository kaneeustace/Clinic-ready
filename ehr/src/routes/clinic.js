"use strict";
/*
 * Administration → Clinic settings: the practice's name, logo, address, NPI, tax ID and brand color.
 *
 *   GET  /admin/clinic               form (admin)
 *   POST /admin/clinic               save details
 *   POST /admin/clinic/logo          upload logo (image_data = PNG/JPEG/WebP data URL from ehr.js; resized in the browser)
 *   POST /admin/clinic/logo/delete   remove logo
 *   GET  /brand/logo                 the logo image (public: shown on the sign-in page; not PHI). Mounted in app.js.
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, raw, page, csrfField, brandMark } = require("../views");
const { COLORS, FIELDS, getClinic } = require("../clinic");
const { sniff } = require("./photos");

const router = express.Router();
const adminOnly = requirePerm("admin");
const MAX_LOGO = 1024 * 1024;

const LIMITS = { name: 120, tagline: 80, address1: 120, address2: 120, city: 80, state: 2, zip: 10, phone: 30, fax: 30, email: 120, website: 200, npi: 10, tax_id: 10, taxonomy: 10, color: 20 };

function validate(b) {
  const v = {};
  for (const f of FIELDS) v[f] = String(b[f] ?? "").trim().slice(0, LIMITS[f] || 200);
  v.state = v.state.toUpperCase();
  const e = {};
  if (!v.name) e.name = "Clinic name is required.";
  if (v.state && !/^[A-Z]{2}$/.test(v.state)) e.state = "Use the 2-letter state code, e.g. AZ.";
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
            ${field(v, e, "state", "State", { attrs: 'autocapitalize="characters"' })}
            ${field(v, e, "zip", "ZIP", { attrs: 'inputmode="numeric"' })}
            ${field(v, e, "phone", "Phone", { type: "tel" })}
            ${field(v, e, "fax", "Fax", { type: "tel" })}
            ${field(v, e, "email", "Email", { type: "email" })}
            ${field(v, e, "website", "Website", { type: "url" })}
            ${field(v, e, "npi", "Group NPI (Type 2)", { attrs: 'inputmode="numeric"' })}
            ${field(v, e, "tax_id", "Tax ID (EIN)")}
            ${field(v, e, "taxonomy", "Taxonomy code", { hint: "(optional)" })}
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
      </div>`,
  }));
}

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
