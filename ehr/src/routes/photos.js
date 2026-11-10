"use strict";
/*
 * Patient pictures: a profile photo for identification (shown in the chart banner), photo ID,
 * insurance card front/back and other images.
 *
 *   GET  /patients/:id/photos                 Pictures tab (gallery + upload form)
 *   POST /patients/:id/photos                 upload (image_data = data: URL made by ehr.js)
 *   GET  /patients/:id/photos/:pid            image bytes (authenticated, no-store)
 *   POST /patients/:id/photos/:pid/profile    use as the profile photo
 *   POST /patients/:id/photos/:pid/delete     delete
 *
 * Images are PHI. They live in the database (so access control, the audit log and encrypted backups cover
 * them), are served only to signed-in staff with patients:read, and every view/upload/delete is audited.
 * The browser re-encodes each picture to a JPEG of at most 1600px before upload, which also strips
 * EXIF metadata such as GPS location. The server checks the real file signature, not the stated type.
 */
const express = require("express");
const { requirePerm, forbidden } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, raw, chartPage, notFound, csrfField, getPatient, fmtTimestamp } = require("../views");

const router = express.Router();
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_PATIENT = 60;
const UPLOAD_PATH_RE = /^\/ehr\/(patients\/\d+\/photos|scan|admin\/clinic\/logo)\/?$/; // picture uploads and PDF note scans

const CATEGORIES = [
  { value: "profile", label: "Profile photo (identification)" },
  { value: "photo_id", label: "Photo ID / driver's license" },
  { value: "insurance_front", label: "Insurance card (front)" },
  { value: "insurance_back", label: "Insurance card (back)" },
  { value: "other", label: "Other" },
];
const catLabel = (v) => (CATEGORIES.find((c) => c.value === v) || CATEGORIES[4]).label;

/** Sniff the real image type from its first bytes. */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Larger body parser for the upload route only, applied after the session is known (see app.js). */
const bigForm = express.urlencoded({ extended: false, limit: "16mb" }); // each route checks its own decoded-size limit
function uploadBodyParser(req, res, next) {
  if (req.method === "POST" && req.session && UPLOAD_PATH_RE.test(req.originalUrl.split("?")[0])) return bigForm(req, res, next);
  next();
}
const isUploadPath = (req) => req.method === "POST" && UPLOAD_PATH_RE.test(req.originalUrl.split("?")[0]);

function loadPatient(req, res) {
  const p = getPatient(req, req.params.id);
  if (!p) notFound(req, res, "Patient");
  return p;
}

const canWrite = (u) => can(u, "patients:write") || can(u, "clinical:write");
const writePerm = (req, res, next) => (canWrite(req.user) ? next() : forbidden(req, res));

function photosPage(req, res, patient, { error, values = {} } = {}, status = 200) {
  const rows = req.db.prepare(
    `SELECT i.id, i.category, i.caption, i.bytes, i.is_profile, i.created_at, u.name AS uploader
     FROM patient_images i LEFT JOIN users u ON u.id = i.uploaded_by WHERE i.patient_id = ? ORDER BY i.is_profile DESC, i.created_at DESC, i.id DESC`)
    .all(patient.id);
  audit(req, "view", "patient_images", null, patient.id, `${rows.length} pictures`);
  const base = `/ehr/patients/${patient.id}/photos`;
  const w = canWrite(req.user);
  res.status(status).send(chartPage(req, patient, "photos", html`
    ${w ? html`
    <section class="card" aria-labelledby="up-h">
      <div class="card__head"><h2 id="up-h">Add a picture</h2></div>
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      <form method="post" action="${base}" class="stack" data-photo-upload>
        ${csrfField(req)}
        <input type="hidden" name="image_data" value="">
        <div class="form-grid">
          <label>Picture
            <input type="file" accept="image/*" data-photo-file required>
            <span class="hint">Take a photo or choose one. It's resized and its location data is removed before upload.</span></label>
          <label>What is it?
            <select name="category">${CATEGORIES.map((c) => html`<option value="${c.value}" ${c.value === (values.category || (rows.some((r) => r.is_profile) ? "other" : "profile")) ? raw("selected") : ""}>${c.label}</option>`)}</select></label>
          <label class="span-all">Caption <span class="hint">(optional)</span>
            <input type="text" name="caption" maxlength="200" value="${values.caption || ""}"></label>
        </div>
        <img class="photo-preview" alt="Preview of the selected picture" hidden data-photo-preview>
        <p class="hint" data-photo-status role="status"></p>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Upload picture</button></div>
        <noscript><p class="alert alert--warn">Uploading pictures needs JavaScript turned on.</p></noscript>
      </form>
    </section>` : ""}
    <section class="card" aria-labelledby="gal-h">
      <div class="card__head"><h2 id="gal-h">Pictures</h2><span class="muted small">${rows.length} on file</span></div>
      ${rows.length ? html`<ul class="photo-grid">${rows.map((r) => html`
        <li class="photo-card">
          <a href="${base}/${r.id}" target="_blank" rel="noopener"><img src="${base}/${r.id}" alt="${catLabel(r.category)}${r.caption ? `: ${r.caption}` : ""}" loading="lazy"></a>
          <div class="photo-card__body">
            <strong>${catLabel(r.category)}</strong>${r.is_profile ? html` <span class="badge badge--info">Profile photo</span>` : ""}
            ${r.caption ? html`<p>${r.caption}</p>` : ""}
            <p class="muted small">${fmtTimestamp(r.created_at)}${r.uploader ? ` · ${r.uploader}` : ""} · ${Math.max(1, Math.round(r.bytes / 1024))} KB</p>
            ${w ? html`<div class="row">
              ${r.is_profile ? "" : html`<form method="post" action="${base}/${r.id}/profile">${csrfField(req)}<button class="btn btn--sm" type="submit">Use as profile photo</button></form>`}
              <form method="post" action="${base}/${r.id}/delete" data-confirm="Delete this picture? This can't be undone.">${csrfField(req)}<button class="btn btn--sm btn--ghost" type="submit">Delete</button></form>
            </div>` : ""}
          </div>
        </li>`)}</ul>` : html`<p class="muted">No pictures yet.${w ? " Add a profile photo so staff can confirm who they're seeing." : ""}</p>`}
    </section>`, { title: `Pictures · ${patient.first_name} ${patient.last_name}` }));
}

router.get("/patients/:id/photos", requirePerm("patients:read"), (req, res) => {
  const patient = loadPatient(req, res);
  if (patient) photosPage(req, res, patient);
});

router.post("/patients/:id/photos", writePerm, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body || {};
  const values = { category: String(b.category || ""), caption: String(b.caption || "").trim().slice(0, 200) };
  const fail = (msg) => photosPage(req, res, patient, { error: msg, values }, 400);
  if (!CATEGORIES.some((c) => c.value === values.category)) return fail("Choose what kind of picture this is.");
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.image_data || ""));
  if (!m) return fail("Choose a picture to upload (JPEG, PNG or WebP).");
  const buf = Buffer.from(m[2], "base64");
  const mime = sniff(buf);
  if (!mime) return fail("That file isn't a JPEG, PNG or WebP picture.");
  if (buf.length > MAX_BYTES) return fail("That picture is too large (5 MB max).");
  const count = req.db.prepare("SELECT COUNT(*) AS n FROM patient_images WHERE patient_id = ?").get(patient.id).n;
  if (count >= MAX_PER_PATIENT) return fail(`This chart already has ${MAX_PER_PATIENT} pictures. Delete some before adding more.`);
  const makeProfile = values.category === "profile";
  req.db.exec("BEGIN");
  try {
    if (makeProfile) req.db.prepare("UPDATE patient_images SET is_profile = 0 WHERE patient_id = ?").run(patient.id);
    const r = req.db.prepare(`INSERT INTO patient_images (patient_id, category, caption, mime, data, bytes, is_profile, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(patient.id, values.category, values.caption || null, mime, buf, buf.length, makeProfile ? 1 : 0, req.user.id);
    req.db.exec("COMMIT");
    audit(req, "create", "patient_image", Number(r.lastInsertRowid), patient.id, values.category);
  } catch (e) { req.db.exec("ROLLBACK"); throw e; }
  req.flash("success", makeProfile ? "Profile photo saved." : "Picture added.");
  res.redirect(`/ehr/patients/${patient.id}/photos`);
});

function loadImage(req, res, patient, withData = false) {
  const img = req.db.prepare(`SELECT id, patient_id, category, mime, is_profile${withData ? ", data" : ""} FROM patient_images WHERE id = ? AND patient_id = ?`)
    .get(Number(req.params.pid), patient.id);
  if (!img) notFound(req, res, "Picture");
  return img;
}

router.get("/patients/:id/photos/:pid", requirePerm("patients:read"), (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const img = loadImage(req, res, patient, true);
  if (!img) return;
  // The banner thumbnail loads on every chart page; the chart view itself is already audited there.
  if (req.query.thumb !== "1") audit(req, "view", "patient_image", img.id, patient.id, img.category);
  res.set({ "Content-Type": img.mime, "Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" });
  res.send(Buffer.from(img.data));
});

router.post("/patients/:id/photos/:pid/profile", writePerm, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const img = loadImage(req, res, patient);
  if (!img) return;
  req.db.prepare("UPDATE patient_images SET is_profile = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE patient_id = ?").run(img.id, patient.id);
  audit(req, "update", "patient_image", img.id, patient.id, "set profile");
  req.flash("success", "Profile photo updated.");
  res.redirect(`/ehr/patients/${patient.id}/photos`);
});

router.post("/patients/:id/photos/:pid/delete", writePerm, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const img = loadImage(req, res, patient);
  if (!img) return;
  req.db.prepare("DELETE FROM patient_images WHERE id = ?").run(img.id);
  audit(req, "delete", "patient_image", img.id, patient.id, img.category);
  req.flash("success", "Picture deleted.");
  res.redirect(`/ehr/patients/${patient.id}/photos`);
});

module.exports = { router, uploadBodyParser, isUploadPath, sniff, CATEGORIES };
