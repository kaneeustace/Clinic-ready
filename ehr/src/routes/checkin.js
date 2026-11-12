"use strict";
/*
 * Client self check-in on their own phone.
 *
 * Client (no account; mounted at /checkin in app.js):
 *   GET  /checkin                       lobby: enter last name + date of birth to find today's appointment
 *   POST /checkin                       (rate-limited per IP) → personal check-in link
 *   GET  /checkin/s/:token              current step
 *   POST /checkin/s/:token/:step        contact → insurance → card-back → phq9 → gad7 → consent → done
 *
 * Staff (/ehr):
 *   POST /appointments/:id/checkin-link            create a link for this appointment (copy / email)
 *   GET  /checkins                                  today's check-ins with what needs review
 *   GET  /checkins/:id                              review one check-in
 *   POST /checkins/:id/apply-contact                copy the client's contact changes into the chart
 *   POST /checkins/:id/reviewed                     mark reviewed
 *
 * Privacy: links are random 192-bit tokens (only a hash is stored) that expire the same day. Check-in pages show the
 * client's first name and appointment time, and contact details only masked. The client's changes are held for staff
 * review rather than written straight into the chart. Screenings are saved as assessments; a positive PHQ-9 item 9
 * shows crisis resources immediately and raises a safety flag for staff. Every step is audited.
 */
const crypto = require("node:crypto");
const express = require("express");
const { requirePerm } = require("../auth");
const { can } = require("../permissions");
const { audit, raiseAlert } = require("../audit");
const { html, raw, page, csrfField, notFound, patientName, fmtTime, fmtDate, fmtTimestamp, today, humanize, nowLocal } = require("../views");
const { INSTRUMENTS, scoreInstrument } = require("./clinical");
const { getClinic } = require("../clinic");
const { sniff } = require("./photos");
const mailer = require("../mailer");

const publicRouter = express.Router();
const router = express.Router();
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const STEPS = ["quick", "contact", "insurance", "card-back", "phq9", "gad7", "consent", "done"];
/** Returning clients who checked in within this many days get a one-tap check-in (EHR_CHECKIN_REPEAT_DAYS). */
const REPEAT_DAYS = () => Math.max(0, Math.min(365, Number(process.env.EHR_CHECKIN_REPEAT_DAYS || 30) || 30));
const SCREEN_EVERY_DAYS = 14;
const MAX_IMAGE = 5 * 1024 * 1024;

/* ---------------- helpers ---------------- */
const sysReq = (req) => ({ db: req.db, user: null, ip: req.ip });
const maskPhone = (p) => (p ? `(•••) •••-${String(p).replace(/\D/g, "").slice(-4)}` : "none on file");
const maskEmail = (e) => { if (!e) return "none on file"; const [u, d] = String(e).split("@"); return `${u.slice(0, 1)}•••@${d || ""}`; };

function newToken(db, appointmentId, patientId, { source = "link", userId = null } = {}) {
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare(`INSERT INTO checkins (appointment_id, patient_id, token_hash, token_expires_at, source, created_by)
    VALUES (?, ?, ?, datetime('now','+18 hours'), ?, ?)
    ON CONFLICT(appointment_id) DO UPDATE SET token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at, source = excluded.source`)
    .run(appointmentId, patientId, sha(token), source, userId);
  return token;
}

function byToken(req) {
  const t = String(req.params.token || "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  return req.db.prepare(`SELECT c.*, a.start_at, a.end_at, a.modality, a.status AS appt_status, a.type AS appt_type,
      p.first_name, p.preferred_name, p.last_name, p.phone, p.email, p.address_line1, p.city, p.state, p.zip, u.name AS clinician_name
    FROM checkins c JOIN appointments a ON a.id = c.appointment_id JOIN patients p ON p.id = c.patient_id JOIN users u ON u.id = a.clinician_id
    WHERE c.token_hash = ? AND c.token_expires_at > datetime('now')`).get(sha(t)) || null;
}

/** Screenings due: PHQ-9 / GAD-7 not done in the last 14 days. */
function dueScreens(db, patientId) {
  const recent = (inst) => db.prepare(`SELECT 1 FROM assessments WHERE patient_id = ? AND instrument = ? AND administered_on >= date(?, '-${SCREEN_EVERY_DAYS} days')`)
    .get(patientId, inst, today());
  return { phq9: !recent("PHQ9"), gad7: !recent("GAD7") };
}

/** Most recent completed check-in for this client (other appointments) within REPEAT_DAYS, and the latest consent. */
function recentCheckin(db, c) {
  const days = REPEAT_DAYS();
  if (!days) return { recent: null, consent: null };
  const recent = db.prepare(`SELECT id, completed_at FROM checkins WHERE patient_id = ? AND id <> ? AND completed_at >= datetime('now', ?)
    ORDER BY completed_at DESC LIMIT 1`).get(c.patient_id, c.id, `-${days} days`) || null;
  const consent = db.prepare(`SELECT consent_at, consent_name FROM checkins WHERE patient_id = ? AND id <> ? AND consent_at >= datetime('now', ?)
    ORDER BY consent_at DESC LIMIT 1`).get(c.patient_id, c.id, `-${days} days`) || null;
  return { recent, consent };
}

function nextStep(db, c, from) {
  const due = dueScreens(db, c.patient_id);
  const { consent } = recentCheckin(db, c);
  let i = STEPS.indexOf(from) + 1;
  while (i < STEPS.length) {
    const s = STEPS[i];
    if (s === "quick") { i++; continue; }
    if ((s === "contact" || s === "insurance") && c.quick) { i++; continue; }
    if (s === "consent" && consent && !c.consent_at) { i++; continue; }
    if (s === "card-back" && !c.insurance_changed) { i++; continue; }
    if (s === "phq9" && !due.phq9 && !c.phq9_id) { i++; continue; }
    if (s === "gad7" && !due.gad7 && !c.gad7_id) { i++; continue; }
    return s;
  }
  return "done";
}

/** Phone-first page in the clinic's branding (no staff navigation). */
function clientPage(req, res, { title, body, step = null, status = 200 }) {
  const c = getClinic(req.db);
  const idx = step ? ["contact", "insurance", "phq9", "consent"].indexOf(step === "card-back" ? "insurance" : step === "gad7" ? "phq9" : step) : -1;
  res.status(status).set("Cache-Control", "no-store").send(page(req, {
    title,
    bare: true,
    body: html`
      <div class="ci">
        <header class="ci__head">${require("../views").brandMark(c)}<span>${c.name}</span></header>
        ${idx >= 0 ? html`<div class="ci__progress" aria-label="Step ${idx + 1} of 4"><i style="width:${((idx + 1) / 4) * 100}%"></i></div>
          <p class="ci__step">Step ${idx + 1} of 4</p>` : ""}
        <main class="ci__card">${body}</main>
        <p class="ci__crisis">In crisis? Call or text <a href="tel:988">988</a>. In an emergency, call 911.</p>
      </div>`,
  }));
}

/* ---------------- rate limit for the lobby lookup ---------------- */
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, reset: now + 15 * 60e3 };
  if (now > a.reset) { a.n = 0; a.reset = now + 15 * 60e3; }
  a.n++;
  attempts.set(ip, a);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k);
  return a.n > 8;
}

/* ================= Client pages ================= */
const bigForm = express.urlencoded({ extended: false, limit: "12mb" });
const smallForm = express.urlencoded({ extended: false, limit: "50kb" });
publicRouter.use((req, res, next) => (req.method === "POST" && /\/(insurance|card-back)\/?$/.test(req.path) ? bigForm : smallForm)(req, res, next));

function lobbyForm(req, res, { error = null, values = {} } = {}, status = 200) {
  clientPage(req, res, { title: "Check in", status, body: html`
    <h1>Check in for your appointment</h1>
    <p class="muted">Enter your last name and date of birth to find today's appointment.</p>
    ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
    <form method="post" action="/checkin" class="stack" autocomplete="off">
      <label>Last name <input name="last_name" value="${values.last_name || ""}" required autocapitalize="words"></label>
      <label>Date of birth <input type="date" name="dob" value="${values.dob || ""}" required></label>
      <button class="btn btn--primary ci__btn" type="submit">Find my appointment</button>
    </form>` });
}

publicRouter.get("/", (req, res) => lobbyForm(req, res));

publicRouter.post("/", (req, res) => {
  const values = { last_name: String((req.body || {}).last_name || "").trim().slice(0, 80), dob: String((req.body || {}).dob || "").slice(0, 10) };
  if (limited(req.ip)) return lobbyForm(req, res, { error: "Too many tries. Please check in with the front desk.", values }, 429);
  if (!values.last_name || !/^\d{4}-\d{2}-\d{2}$/.test(values.dob)) return lobbyForm(req, res, { error: "Enter your last name and date of birth.", values }, 400);
  const day = today();
  const rows = req.db.prepare(`SELECT a.id, a.patient_id FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE lower(p.last_name) = lower(?) AND p.dob = ? AND substr(a.start_at,1,10) = ? AND a.status IN ('scheduled','checked_in')
    ORDER BY a.start_at`).all(values.last_name, values.dob, day);
  if (!rows.length) {
    audit(sysReq(req), "checkin_lookup_failed", null, null, null, "no match");
    return lobbyForm(req, res, { error: "We couldn't find an appointment today for that name and date of birth. Please check with the front desk.", values }, 404);
  }
  const a = rows[0];
  const token = newToken(req.db, a.id, a.patient_id, { source: "lobby" });
  audit(sysReq(req), "checkin_started", "appointment", a.id, a.patient_id, "lobby");
  res.redirect(303, `/checkin/s/${token}`);
});

function stepPage(req, res, c, { error = null, crisis = false } = {}, status = 200) {
  const token = req.params.token;
  const base = `/checkin/s/${token}`;
  const first = c.preferred_name || c.first_name;
  const when = html`<p class="ci__appt"><strong>${fmtTime(c.start_at)}</strong> with ${c.clinician_name}${c.appt_type === "group" ? " · Group" : ""}${c.modality === "telehealth" ? " · Telehealth" : ""}</p>`;
  const err = error ? html`<div class="alert alert--error" role="alert">${error}</div>` : "";
  const crisisBox = crisis ? html`<div class="alert alert--error" role="alert"><strong>Thank you for telling us.</strong> Your care team has been notified and will check on you.
    If you're thinking about hurting yourself right now, call or text <a href="tel:988"><strong>988</strong></a>, or call 911.</div>` : "";
  const s = c.completed_at ? "done" : c.step;
  if (s === "done") {
    return clientPage(req, res, { title: "Checked in", body: html`
      <div class="ci__done" aria-hidden="true">✓</div>
      <h1>You're checked in, ${first}.</h1>
      ${when}
      ${crisisBox}
      <p>${c.modality === "telehealth" ? "Your clinician will start your video visit shortly." : "Please have a seat. Your clinician will come get you."}</p>` });
  }
  if (s === "quick") {
    const { recent } = recentCheckin(req.db, c);
    const due = dueScreens(req.db, c.patient_id);
    return clientPage(req, res, { title: "Check in", status, body: html`
      <h1>Welcome back, ${first}</h1>${when}${err}
      <p>You checked in with us ${recent ? fmtDate(recent.completed_at.slice(0, 10)) : "recently"}, so we already have your contact information, insurance and consent.</p>
      ${due.phq9 || due.gad7 ? html`<p class="hint">You'll answer a few quick questions about how you've been feeling.</p>` : ""}
      <form method="post" action="${base}/quick" class="stack">
        <button class="btn btn--primary ci__btn" type="submit" name="action" value="checkin">${due.phq9 || due.gad7 ? "Continue" : "Check in"}</button>
        <button class="btn btn--ghost ci__btn" type="submit" name="action" value="update">My phone, address or insurance changed</button>
      </form>` });
  }
  if (s === "contact") {
    return clientPage(req, res, { title: "Check in", step: s, status, body: html`
      <h1>Hi ${first}</h1>${when}${err}
      <h2 class="ci__h2">Is your contact information still correct?</h2>
      <dl class="facts"><dt>Phone</dt><dd>${maskPhone(c.phone)}</dd><dt>Email</dt><dd>${maskEmail(c.email)}</dd><dt>Address</dt><dd>${c.address_line1 ? `${c.city || ""}${c.state ? `, ${c.state}` : ""} ${c.zip || ""}` : "none on file"}</dd></dl>
      <form method="post" action="${base}/contact" class="stack">
        <button class="btn btn--primary ci__btn" type="submit" name="same" value="1">Yes, it's correct</button>
        <details><summary>Something changed</summary>
          <div class="stack" style="margin-top:.75rem">
            <p class="hint">Fill in only what changed. Our front desk will update your record.</p>
            <label>New phone <input type="tel" name="phone" maxlength="30" autocomplete="tel"></label>
            <label>New email <input type="email" name="email" maxlength="120" autocomplete="email"></label>
            <label>New street address <input name="address_line1" maxlength="120" autocomplete="address-line1"></label>
            <div class="form-grid"><label>City <input name="city" maxlength="80" autocomplete="address-level2"></label>
              <label>State <input name="state" maxlength="2" autocomplete="address-level1"></label>
              <label>ZIP <input name="zip" maxlength="10" inputmode="numeric" autocomplete="postal-code"></label></div>
            <button class="btn btn--primary ci__btn" type="submit" name="same" value="0">Save changes</button>
          </div></details>
      </form>` });
  }
  if (s === "insurance") {
    return clientPage(req, res, { title: "Insurance", step: s, status, body: html`
      <h1>Insurance</h1>${err}
      <p>Has your insurance changed since your last visit?</p>
      <form method="post" action="${base}/insurance" class="stack"><button class="btn btn--primary ci__btn" type="submit" name="changed" value="0">No, it's the same</button></form>
      <details ${error ? raw("open") : ""}><summary>Yes, I have new insurance</summary>
        <form method="post" action="${base}/insurance" class="stack" data-photo-upload style="margin-top:.75rem">
          <input type="hidden" name="changed" value="1"><input type="hidden" name="image_data" value="">
          <label>Insurance company <input name="payer" maxlength="120" required></label>
          <label>Member ID <input name="member_id" maxlength="60" autocomplete="off"></label>
          <label>Photo of the <strong>front</strong> of your card <input type="file" accept="image/*" capture="environment" data-photo-file></label>
          <img class="photo-preview" alt="Preview of your card" hidden data-photo-preview>
          <p class="hint" data-photo-status role="status"></p>
          <button class="btn btn--primary ci__btn" type="submit">Continue</button>
        </form></details>` });
  }
  if (s === "card-back") {
    return clientPage(req, res, { title: "Insurance card", step: s, status, body: html`
      <h1>Back of your card</h1>${err}
      <form method="post" action="${base}/card-back" class="stack" data-photo-upload>
        <input type="hidden" name="image_data" value="">
        <label>Photo of the <strong>back</strong> of your card <input type="file" accept="image/*" capture="environment" data-photo-file></label>
        <img class="photo-preview" alt="Preview of your card" hidden data-photo-preview>
        <p class="hint" data-photo-status role="status"></p>
        <button class="btn btn--primary ci__btn" type="submit">Continue</button>
      </form>
      <form method="post" action="${base}/card-back"><input type="hidden" name="skip" value="1"><button class="btn btn--ghost ci__btn" type="submit">Skip</button></form>` });
  }
  if (s === "phq9" || s === "gad7") {
    const def = INSTRUMENTS[s === "phq9" ? "PHQ9" : "GAD7"];
    return clientPage(req, res, { title: def.name, step: s, status, body: html`
      <h1>How have you been feeling?</h1>${crisisBox}${err}
      <p class="muted">${def.stem}</p>
      <form method="post" action="${base}/${s}" class="stack ci__q">
        ${def.items.map((item, i) => html`<fieldset><legend>${i + 1}. ${item}</legend>
          <div class="ci__opts">${def.options.map((o) => html`<label class="ci__opt"><input type="radio" name="q${i}" value="${o.value}" required> ${o.label}</label>`)}</div></fieldset>`)}
        <button class="btn btn--primary ci__btn" type="submit">Continue</button>
      </form>` });
  }
  if (s === "consent") {
    const clinic = getClinic(req.db);
    return clientPage(req, res, { title: "Consent", step: s, status, body: html`
      <h1>Last step</h1>${crisisBox}${err}
      <form method="post" action="${base}/consent" class="stack">
        <label class="check"><input type="checkbox" name="agree" value="1" required> I have received ${clinic.name}'s Notice of Privacy Practices and consent to today's treatment.</label>
        <label>Type your full name to sign <input name="signature" maxlength="120" required autocomplete="name"></label>
        <button class="btn btn--primary ci__btn" type="submit">Check in</button>
      </form>` });
  }
  return clientPage(req, res, { title: "Check in", body: html`<p>Something went wrong. Please check in with the front desk.</p>` });
}

publicRouter.get("/s/:token", (req, res) => {
  const c = byToken(req);
  if (!c) return clientPage(req, res, { title: "Link expired", status: 404, body: html`<h1>This check-in link has expired</h1><p>Please <a href="/checkin">check in here</a> or with the front desk.</p>` });
  if (!c.started_at) {
    req.db.prepare("UPDATE checkins SET started_at = datetime('now') WHERE id = ?").run(c.id);
    audit(sysReq(req), "checkin_opened", "appointment", c.appointment_id, c.patient_id, c.source);
    const { recent } = recentCheckin(req.db, c);
    if (recent && c.step === "contact") {
      req.db.prepare("UPDATE checkins SET step = 'quick', quick = 1 WHERE id = ?").run(c.id);
      c.step = "quick"; c.quick = 1;
    }
  }
  // After a positive safety item the redirect carries ?c=1 so the client sees crisis resources.
  stepPage(req, res, c, { crisis: req.query.c === "1" && !!c.flagged });
});

publicRouter.post("/s/:token/:step", (req, res) => {
  const c = byToken(req);
  if (!c) return res.redirect(303, "/checkin");
  const step = req.params.step;
  if (c.completed_at || step !== c.step) return res.redirect(303, `/checkin/s/${req.params.token}`);
  const b = req.body || {};
  const db = req.db;
  const advance = (extraSql = "", args = [], opts = {}) => {
    const fresh = db.prepare("SELECT * FROM checkins WHERE id = ?").get(c.id);
    const nxt = nextStep(db, { ...fresh, ...opts.override }, step);
    db.prepare(`UPDATE checkins SET step = ?${extraSql} WHERE id = ?`).run(nxt, ...args, c.id);
    if (nxt === "done") return complete(opts.crisis || fresh.flagged);
    res.redirect(303, `/checkin/s/${req.params.token}${opts.crisis ? "?c=1" : ""}`);
  };
  const complete = (crisis) => {
    db.prepare("UPDATE checkins SET step = 'done', completed_at = datetime('now') WHERE id = ?").run(c.id);
    db.prepare("UPDATE appointments SET status = 'checked_in' WHERE id = ? AND status = 'scheduled'").run(c.appointment_id);
    audit(sysReq(req), "checkin_completed", "appointment", c.appointment_id, c.patient_id, `${c.source}${c.quick ? " quick" : ""}`);
    res.redirect(303, `/checkin/s/${req.params.token}${crisis ? "?c=1" : ""}`);
  };

  if (step === "quick") {
    if (b.action === "update") {
      db.prepare("UPDATE checkins SET quick = 0, step = 'contact' WHERE id = ?").run(c.id);
      return res.redirect(303, `/checkin/s/${req.params.token}`);
    }
    return advance("", [], { override: { quick: 1 } });
  }

  if (step === "contact") {
    if (b.same === "1") return advance();
    const ch = {};
    for (const k of ["phone", "email", "address_line1", "city", "state", "zip"]) { const v = String(b[k] || "").trim().slice(0, 120); if (v) ch[k] = k === "state" ? v.toUpperCase().slice(0, 2) : v; }
    if (ch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ch.email)) return stepPage(req, res, c, { error: "That email address doesn't look right." }, 400);
    if (!Object.keys(ch).length) return advance();
    audit(sysReq(req), "checkin_contact_changes", "appointment", c.appointment_id, c.patient_id, `fields: ${Object.keys(ch).join(",")}`);
    return advance(", contact_changes = ?", [JSON.stringify(ch)]);
  }
  if (step === "insurance") {
    if (b.changed !== "1") return advance(", insurance_changed = 0");
    const payer = String(b.payer || "").trim().slice(0, 120);
    if (!payer) return stepPage(req, res, c, { error: "Enter the name of your insurance company." }, 400);
    const img = saveCard(req, c, "insurance_front", b.image_data);
    if (img && img.error) return stepPage(req, res, c, { error: img.error }, 400);
    audit(sysReq(req), "checkin_insurance", "appointment", c.appointment_id, c.patient_id, img ? "changed + card front" : "changed");
    return advance(", insurance_changed = 1, insurance_payer = ?, insurance_member_id = ?", [payer, String(b.member_id || "").trim().slice(0, 60) || null], { override: { insurance_changed: 1 } });
  }
  if (step === "card-back") {
    if (b.skip !== "1") {
      const img = saveCard(req, c, "insurance_back", b.image_data);
      if (img && img.error) return stepPage(req, res, c, { error: img.error }, 400);
    }
    return advance();
  }
  if (step === "phq9" || step === "gad7") {
    const key = step === "phq9" ? "PHQ9" : "GAD7";
    const def = INSTRUMENTS[key];
    const r = def.items.map((_, i) => Number(b[`q${i}`]));
    let sc;
    try { sc = scoreInstrument(key, r); } catch { return stepPage(req, res, c, { error: "Please answer every question." }, 400); }
    const id = Number(db.prepare(`INSERT INTO assessments (patient_id, appointment_id, instrument, responses, total_score, severity, flagged, administered_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(c.patient_id, c.appointment_id, key, JSON.stringify(r), sc.total, sc.severity, sc.flagged, today()).lastInsertRowid);
    audit(sysReq(req), "checkin_screening", "assessment", id, c.patient_id, `${key} ${sc.total}${sc.flagged ? " flagged" : ""}`);
    if (sc.flagged) {
      try { raiseAlert(db, { kind: "safety_screen", severity: "high", patient_id: c.patient_id, detail: `Positive ${def.name} safety item at self check-in (appointment ${c.appointment_id})` }); } catch { /* alerting must not block check-in */ }
    }
    const col = step === "phq9" ? "phq9_id" : "gad7_id";
    return advance(`, ${col} = ?, flagged = MAX(flagged, ?)`, [id, sc.flagged ? 1 : 0], { crisis: !!sc.flagged, override: { [col]: id } });
  }
  if (step === "consent") {
    const sig = String(b.signature || "").trim().slice(0, 120);
    if (b.agree !== "1" || sig.length < 3) return stepPage(req, res, c, { error: "Check the box and type your full name to sign." }, 400);
    db.prepare("UPDATE checkins SET consent_name = ?, consent_at = datetime('now') WHERE id = ?").run(sig, c.id);
    return complete(c.flagged);
  }
  res.redirect(303, `/checkin/s/${req.params.token}`);
});

/** Save an insurance card photo (category insurance_front/back) to the patient's Pictures. */
function saveCard(req, c, category, dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  if (!m) return { error: "That photo couldn't be read. Try again." };
  const buf = Buffer.from(m[2], "base64");
  const mime = sniff(buf);
  if (!mime) return { error: "That file isn't a photo." };
  if (buf.length > MAX_IMAGE) return { error: "That photo is too large." };
  const n = req.db.prepare("SELECT COUNT(*) AS n FROM patient_images WHERE patient_id = ? AND created_at >= datetime('now','-1 day') AND uploaded_by IS NULL").get(c.patient_id).n;
  if (n >= 4) return { error: "Too many photos today. Please give your card to the front desk." };
  const id = Number(req.db.prepare(`INSERT INTO patient_images (patient_id, category, caption, mime, data, bytes, is_profile, uploaded_by)
    VALUES (?, ?, 'Uploaded by client at check-in', ?, ?, ?, 0, NULL)`).run(c.patient_id, category, mime, buf, buf.length).lastInsertRowid);
  audit(sysReq(req), "create", "patient_image", id, c.patient_id, `${category} (client check-in)`);
  return { id };
}

/* ================= Staff ================= */
function publicBase(req) {
  const env = (process.env.EHR_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  return env || `${req.protocol}://${req.get("host")}`;
}

router.post("/appointments/:id/checkin-link", requirePerm("schedule:write"), async (req, res) => {
  const a = req.db.prepare(`SELECT a.*, p.email, p.first_name, p.last_name, p.preferred_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?`).get(Number(req.params.id));
  if (!a) return notFound(req, res, "Appointment");
  const token = newToken(req.db, a.id, a.patient_id, { userId: req.user.id });
  const url = `${publicBase(req)}/checkin/s/${token}`;
  audit(req, "checkin_link_created", "appointment", a.id, a.patient_id);
  let emailed = null;
  if ((req.body || {}).send === "email") {
    const mc = mailer.mailConfig();
    if (!a.email) emailed = "This client has no email address on file.";
    else if (!mc.enabled) emailed = "Email isn't set up yet (Administration → End-of-day note emails).";
    else {
      const clinic = getClinic(req.db).name;
      try {
        await mailer.sendMail({ to: a.email, subject: `Check in for your appointment · ${clinic}`,
          text: `Hello,\n\nYou can check in for today's appointment with ${clinic} from your phone:\n${url}\n\nThe link works today only.\n\nIn crisis? Call or text 988.`,
          html: `<p>Hello,</p><p>You can check in for today's appointment with ${clinic.replace(/[<>&]/g, "")} from your phone.</p><p><a href="${url}" style="display:inline-block;background:#315de7;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Check in now</a></p><p style="color:#5d6b7e;font-size:13px">The link works today only. In crisis? Call or text 988.</p>` }, mc);
        emailed = "sent";
        audit(req, "checkin_link_emailed", "appointment", a.id, a.patient_id);
      } catch (e) { emailed = `Email failed: ${String(e.message || e).slice(0, 160)}`; }
    }
  }
  res.send(page(req, { title: "Check-in link", active: "schedule", body: html`
    <div class="page-head"><h1>Check-in link</h1><a class="btn btn--sm" href="/ehr/appointments/${a.id}">Back to appointment</a></div>
    <section class="card stack">
      <p>Send this link to <strong>${patientName(a)}</strong> by text or email. It works today only and is for this appointment.</p>
      ${emailed === "sent" ? html`<div class="alert alert--success">Emailed to the client.</div>` : emailed ? html`<div class="alert alert--warn">${emailed}</div>` : ""}
      <label>Link <input type="text" value="${url}" readonly data-select-all></label>
      <div class="row"><button class="btn btn--primary btn--sm" type="button" data-copy="${url}">Copy link</button>
        <a class="btn btn--sm" href="sms:?&body=${encodeURIComponent(`Check in for your appointment: ${url}`)}">Text it (from this phone)</a>
        ${a.email ? html`<form class="inline-form" method="post" action="/ehr/appointments/${a.id}/checkin-link">${csrfField(req)}<input type="hidden" name="send" value="email"><button class="btn btn--sm" type="submit">Email new link</button></form>` : ""}</div>
      <p class="hint">Making a new link turns off the previous one. Clients can also check in at <strong>${publicBase(req)}/checkin</strong> with their last name and date of birth.</p>
    </section>` }));
});

function checkinBadges(c) {
  const out = [];
  if (c.flagged) out.push(html`<span class="badge badge--bad">Safety screen positive</span>`);
  if (c.contact_changes && !c.contact_applied) out.push(html`<span class="badge badge--warn">Contact changes</span>`);
  if (c.insurance_changed) out.push(html`<span class="badge badge--warn">New insurance</span>`);
  if (c.phq9_total != null) out.push(html`<span class="badge badge--info">PHQ-9 ${c.phq9_total}</span>`);
  if (c.gad7_total != null) out.push(html`<span class="badge badge--info">GAD-7 ${c.gad7_total}</span>`);
  return out;
}
const checkinSelect = `SELECT c.*, a.start_at, a.modality, p.first_name, p.last_name, p.preferred_name, u.name AS clinician_name, a.clinician_id,
    (SELECT total_score FROM assessments WHERE id = c.phq9_id) AS phq9_total, (SELECT total_score FROM assessments WHERE id = c.gad7_id) AS gad7_total
  FROM checkins c JOIN appointments a ON a.id = c.appointment_id JOIN patients p ON p.id = c.patient_id JOIN users u ON u.id = a.clinician_id`;

/** Today's completed check-ins (for the dashboard and lobby list). */
function todaysCheckins(db, user) {
  const mine = user.role === "clinician";
  return db.prepare(`${checkinSelect} WHERE c.completed_at IS NOT NULL AND substr(a.start_at,1,10) = ? ${mine ? "AND a.clinician_id = ?" : ""}
    ORDER BY c.completed_at DESC`).all(today(), ...(mine ? [user.id] : []));
}

function dashboardCard(db, user) {
  if (!can(user, "schedule:read")) return "";
  const rows = todaysCheckins(db, user);
  if (!rows.length) return "";
  return html`
    <section class="card" aria-labelledby="ci-h">
      <div class="card__head"><h2 id="ci-h">Checked in today</h2><a class="btn btn--sm" href="/ehr/checkins">All check-ins</a></div>
      <ul class="list-plain">${rows.slice(0, 8).map((c) => html`<li class="row">
        <a href="/ehr/checkins/${c.id}">${patientName(c)}</a>
        <span class="muted small">${fmtTime(c.start_at)} · ${c.clinician_name} · checked in ${fmtTimestamp(c.completed_at).replace(/^.*?, \d{4},? /, "")}</span>
        ${checkinBadges(c)}${c.reviewed_at ? html`<span class="badge badge--good">Reviewed</span>` : ""}</li>`)}</ul>
    </section>`;
}

/** Check-in state of one appointment, for the roster. */
function rosterStatus(r) {
  if (r.status === "cancelled" || r.status === "late_cancel") return { key: "cancelled", label: "Cancelled", tone: "muted" };
  if (r.status === "no_show") return { key: "no_show", label: "No-show", tone: "bad" };
  if (r.completed_at || r.status === "checked_in" || r.status === "completed") return { key: "in", label: r.completed_at ? "Checked in" : "Checked in by staff", tone: "good" };
  if (r.started_at) return { key: "progress", label: "Checking in…", tone: "warn" };
  if (r.checkin_id) return { key: "link", label: "Link sent", tone: "info" };
  return { key: "waiting", label: "Not here yet", tone: "muted" };
}

router.get("/checkins", requirePerm("schedule:read"), (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : today();
  const mine = req.user.role === "clinician" && req.query.all !== "1";
  const rows = req.db.prepare(`SELECT a.id AS appt_id, a.start_at, a.end_at, a.type, a.modality, a.status, a.clinician_id, u.name AS clinician_name,
      p.id AS patient_id, p.first_name, p.last_name, p.preferred_name,
      c.id AS checkin_id, c.started_at, c.completed_at, c.flagged, c.contact_changes, c.contact_applied, c.insurance_changed, c.reviewed_at, c.quick,
      (SELECT total_score FROM assessments WHERE id = c.phq9_id) AS phq9_total, (SELECT total_score FROM assessments WHERE id = c.gad7_id) AS gad7_total
    FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = a.clinician_id LEFT JOIN checkins c ON c.appointment_id = a.id
    WHERE substr(a.start_at,1,10) = ? ${mine ? "AND a.clinician_id = ?" : ""}
    ORDER BY a.start_at, u.name, p.last_name`).all(day, ...(mine ? [req.user.id] : []));
  // Group sessions: same start time, clinician and type 'group'.
  const groups = new Map();
  const singles = [];
  for (const r of rows) {
    if (r.type === "group") {
      const k = `${r.start_at}|${r.clinician_id}`;
      if (!groups.has(k)) groups.set(k, { start_at: r.start_at, end_at: r.end_at, clinician_name: r.clinician_name, modality: r.modality, members: [] });
      groups.get(k).members.push(r);
    } else singles.push(r);
  }
  audit(req, "view", "checkins", null, null, day);
  const memberRow = (r, { single = false } = {}) => {
    const st = rosterStatus(r);
    return html`<li class="roster__row roster__row--${st.key}">
      ${single ? html`<span class="roster__time">${fmtTime(r.start_at)}</span>` : ""}
      <span class="roster__name">${r.checkin_id ? html`<a href="/ehr/checkins/${r.checkin_id}">${patientName(r)}</a>` : html`<a href="/ehr/appointments/${r.appt_id}">${patientName(r)}</a>`}</span>
      <span class="badge badge--${st.tone}">${st.label}</span>
      ${r.completed_at ? html`<span class="muted small">${fmtTimestamp(r.completed_at).replace(/^.*?\d{4},? /, "")}${r.quick ? " · one-tap" : ""}</span>` : ""}
      ${checkinBadges(r)}${r.reviewed_at ? html`<span class="badge badge--good">Reviewed</span>` : ""}
      ${single ? html`<span class="muted small roster__clin">${r.clinician_name}</span>` : ""}</li>`;
  };
  const counted = (list) => {
    const active = list.filter((r) => !["cancelled", "no_show"].includes(rosterStatus(r).key));
    return { here: active.filter((r) => rosterStatus(r).key === "in").length, total: active.length };
  };
  res.send(page(req, { title: "Check-ins", active: "schedule", body: html`
    <div class="page-head"><div><h1>Check-ins</h1><p>${fmtDate(day)}${mine ? " · your sessions" : ""} · clients check in at <strong>${publicBase(req)}/checkin</strong></p></div>
      <div class="row">${req.user.role === "clinician" ? html`<a class="btn btn--sm" href="/ehr/checkins?date=${day}${mine ? "&all=1" : ""}">${mine ? "Show everyone" : "Only mine"}</a>` : ""}<a class="btn btn--sm" href="/ehr/schedule">Schedule</a></div></div>
    ${groups.size ? html`<h2 class="section-title">Group sessions</h2>
      <div class="roster-grid">${[...groups.values()].map((g) => { const n = counted(g.members); return html`
        <section class="card roster">
          <div class="roster__head">
            <div><strong>${fmtTime(g.start_at)}–${fmtTime(g.end_at)} group</strong><div class="muted small">${g.clinician_name}${g.modality === "telehealth" ? " · Telehealth" : ""}</div></div>
            <div class="roster__count"><b>${n.here}</b> of ${n.total} here</div>
          </div>
          <div class="roster__bar" aria-hidden="true"><i style="width:${n.total ? Math.round((n.here / n.total) * 100) : 0}%"></i></div>
          <ul class="roster__list">${g.members.map(memberRow)}</ul>
        </section>`; })}</div>` : ""}
    <h2 class="section-title">${groups.size ? "Individual appointments" : "Appointments"}</h2>
    <section class="card">${singles.length ? html`<ul class="roster__list">${singles.map((r) => memberRow(r, { single: true }))}</ul>` : html`<p class="muted">No individual appointments.</p>`}</section>` }));
});

const FIELD_LABEL = { phone: "Phone", email: "Email", address_line1: "Street address", city: "City", state: "State", zip: "ZIP" };

router.get("/checkins/:id", requirePerm("schedule:read"), (req, res) => {
  const c = req.db.prepare(`${checkinSelect} WHERE c.id = ?`).get(Number(req.params.id));
  if (!c) return notFound(req, res, "Check-in");
  audit(req, "view", "checkin", c.id, c.patient_id);
  const ch = c.contact_changes ? JSON.parse(c.contact_changes) : null;
  const pt = req.db.prepare("SELECT * FROM patients WHERE id = ?").get(c.patient_id);
  const cards = req.db.prepare("SELECT id, category FROM patient_images WHERE patient_id = ? AND uploaded_by IS NULL AND category IN ('insurance_front','insurance_back') AND created_at >= ? ORDER BY id").all(c.patient_id, c.created_at.slice(0, 10));
  const canWrite = can(req.user, "patients:write");
  const prior = c.consent_at ? null : req.db.prepare("SELECT consent_name, consent_at FROM checkins WHERE patient_id = ? AND id <> ? AND consent_at IS NOT NULL ORDER BY consent_at DESC LIMIT 1").get(c.patient_id, c.id);
  res.send(page(req, { title: `Check-in · ${patientName(c)}`, active: "schedule", body: html`
    <div class="page-head"><div><h1>${patientName(c)}</h1><p>${fmtTime(c.start_at)} with ${c.clinician_name} · ${c.completed_at ? `checked in ${fmtTimestamp(c.completed_at)}` : "not finished"}</p></div>
      <div class="row"><a class="btn btn--sm" href="/ehr/patients/${c.patient_id}">Open chart</a><a class="btn btn--sm" href="/ehr/checkins">All check-ins</a></div></div>
    ${c.flagged ? html`<div class="alert alert--error" role="alert"><strong>Safety screen positive.</strong> The client endorsed thoughts of self-harm on the PHQ-9 (item 9). They were shown crisis resources. Follow up before or at the start of the session and document a risk assessment.</div>` : ""}
    <div class="grid grid--2">
      <section class="card"><h2>Contact information</h2>
        ${ch ? html`<table class="table"><thead><tr><th>Field</th><th>On file</th><th>Client says</th></tr></thead><tbody>
          ${Object.entries(ch).map(([k, v]) => html`<tr><td>${FIELD_LABEL[k] || k}</td><td>${pt[k] || html`<span class="muted">—</span>`}</td><td><strong>${v}</strong></td></tr>`)}</tbody></table>
          ${c.contact_applied ? html`<p class="badge badge--good">Applied to the chart</p>` : canWrite ? html`<form method="post" action="/ehr/checkins/${c.id}/apply-contact" style="margin-top:.75rem">${csrfField(req)}<button class="btn btn--primary btn--sm" type="submit">Update the chart</button></form>` : ""}`
          : html`<p class="muted">Client confirmed their contact information is correct.</p>`}
      </section>
      <section class="card"><h2>Insurance</h2>
        ${c.insurance_changed ? html`<p><strong>New insurance:</strong> ${c.insurance_payer}${c.insurance_member_id ? ` · Member ID ${c.insurance_member_id}` : ""}</p>
          ${cards.length ? html`<div class="row">${cards.map((img) => html`<a href="/ehr/patients/${c.patient_id}/photos/${img.id}" target="_blank" rel="noopener"><img class="ci-card-thumb" src="/ehr/patients/${c.patient_id}/photos/${img.id}" alt="${humanize(img.category)}"></a>`)}</div>` : html`<p class="muted">No card photos.</p>`}
          <p class="hint">Verify eligibility, then update the policy on the chart's Overview (Insurance).</p>`
          : c.insurance_changed === 0 ? html`<p class="muted">No change.</p>` : html`<p class="muted">Not answered.</p>`}
      </section>
      <section class="card"><h2>Screenings</h2>
        ${c.phq9_total == null && c.gad7_total == null ? html`<p class="muted">None due today.</p>` : html`<ul class="list-plain">
          ${c.phq9_total != null ? html`<li>PHQ-9: <strong>${c.phq9_total}</strong></li>` : ""}${c.gad7_total != null ? html`<li>GAD-7: <strong>${c.gad7_total}</strong></li>` : ""}</ul>
          <a class="btn btn--sm" href="/ehr/patients/${c.patient_id}/measures">See measures</a>`}
      </section>
      <section class="card"><h2>Consent</h2>
        ${c.consent_at ? html`<p>Signed by typing <strong>${c.consent_name}</strong> on ${fmtTimestamp(c.consent_at)}.</p>`
          : prior ? html`<p>On file: signed by <strong>${prior.consent_name}</strong> on ${fmtTimestamp(prior.consent_at)}${c.quick ? " (returning client, one-tap check-in)" : ""}.</p>`
          : html`<p class="muted">Not signed.</p>`}
        ${c.reviewed_at ? html`<p class="badge badge--good">Reviewed</p>` : html`<form method="post" action="/ehr/checkins/${c.id}/reviewed">${csrfField(req)}<button class="btn btn--sm" type="submit">Mark reviewed</button></form>`}
      </section>
    </div>` }));
});

router.post("/checkins/:id/apply-contact", requirePerm("patients:write"), (req, res) => {
  const c = req.db.prepare("SELECT * FROM checkins WHERE id = ?").get(Number(req.params.id));
  if (!c || !c.contact_changes) return notFound(req, res, "Check-in");
  const ch = JSON.parse(c.contact_changes);
  const cols = Object.keys(ch).filter((k) => FIELD_LABEL[k]);
  if (cols.length) {
    req.db.prepare(`UPDATE patients SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((k) => ch[k]), c.patient_id);
  }
  req.db.prepare("UPDATE checkins SET contact_applied = 1 WHERE id = ?").run(c.id);
  audit(req, "update", "patient", c.patient_id, c.patient_id, `from check-in: ${cols.join(",")}`);
  req.flash("success", "Chart updated with the client's new contact information.");
  res.redirect(`/ehr/checkins/${c.id}`);
});

router.post("/checkins/:id/reviewed", requirePerm("schedule:read"), (req, res) => {
  const c = req.db.prepare("SELECT * FROM checkins WHERE id = ?").get(Number(req.params.id));
  if (!c) return notFound(req, res, "Check-in");
  req.db.prepare("UPDATE checkins SET reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.user.id, c.id);
  audit(req, "update", "checkin", c.id, c.patient_id, "reviewed");
  res.redirect(`/ehr/checkins/${c.id}`);
});

module.exports = { router, publicRouter, dashboardCard, todaysCheckins, newToken, sha, resetRateLimit: () => attempts.clear() };
