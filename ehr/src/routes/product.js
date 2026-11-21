"use strict";
/*
 * ChartReady sales website (the software, not a clinic):
 *   GET  /software            product page: features, AHCCCS, phone check-in, pricing, security, FAQ, book a demo
 *   POST /software/demo       "Book a demo" form → sales_leads (+ email to EHR_SALES_EMAIL when email is set up)
 *   GET  /ehr/admin/leads     (admin) the leads, with status
 *
 * EHR_SITE_MODE decides what the site root (/) shows: "product" (default) = this page, "clinic" = the sample clinic
 * website, "ehr" = straight to the EHR sign-in (customer clinics).
 * Pricing is "launch pricing" from the business plan; change it in PLANS below.
 */
const crypto = require("node:crypto");
const express = require("express");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, raw, page, csrfField, fmtTimestamp } = require("../views");
const { PRODUCT, salesEmail, demoUrl } = require("../product");
const mailer = require("../mailer");

const publicRouter = express.Router();
const router = express.Router();

const PLANS = [
  { name: "Solo", price: 149, blurb: "For a small private practice.", features: ["1 location", "Up to 5 clinicians", "Everything in the EHR", "AI note compliance checks", "Phone check-in"] },
  { name: "Clinic", price: 399, featured: true, blurb: "For outpatient and IOP clinics.", features: ["Up to 20 clinicians", "Supervisor co-signs and signature deadlines", "Level of care, UR and census", "Front-desk iPad kiosk", "Onboarding help"] },
  { name: "Group", price: 799, blurb: "For multi-site organizations.", features: ["Multiple locations", "Custom rules per payer contract", "Priority support", "Data setup help"] },
];

/* What's in it, grouped the way a clinic thinks about its day. Plain sentences, no slogans. */
const SECTIONS = [
  ["Notes and plans", [
    ["Progress, intake, group, psychiatry, ASAM, safety plans", "Required fields are checked before a note can be signed, and signed notes can only be corrected by addendum."],
    ["Treatment plans tied to every note", "Problems, goals, objectives and interventions. A progress note can't be written without an active plan."],
    ["Signature deadlines you can see", "Clinicians sign within 24 hours and supervisors co-sign within 48. Each clinician gets an end-of-day email of what's still open."],
    ["A second read before you bill", "Rule checks on every note, and an optional AI review that points to the exact sentence a payer would question."],
  ]],
  ["Front desk", [
    ["Check-in on the client's own phone", "A link goes out an hour before the visit. Clients confirm their details, photograph a new insurance card and answer the PHQ-9 and GAD-7."],
    ["A lobby iPad that resets itself", "For clients who'd rather not use their phone. Group sessions show who has arrived."],
  ]],
  ["Programs", [
    ["Level of care and utilization review", "Admissions, step-downs, authorizations with days used, next review dates and a daily census for IOP, PHP and residential."],
    ["AHCCCS documentation", "For clients with an AHCCCS ID: AMPM 940 encounter fields, service plan rules, modifiers and place-of-service checks."],
    ["Hormone therapy (optional)", "Testosterone regimens, labs with hematocrit and PSA alerts, a dose log and a Schedule III stock record."],
  ]],
  ["Prescribing and billing", [
    ["Prescriptions", "Written and signed in the chart, printed for a wet signature or recorded from your e-prescribing system. Refill limits for controlled substances are enforced."],
    ["Charges and superbills", "Units come from documented minutes. Superbills carry your NPI and tax ID; your biller or clearinghouse submits the claims."],
  ]],
  ["Your data", [
    ["A standard FHIR API", "Labs, partners and data warehouses can read records with scoped access. Notes are never shared through it."],
    ["Export any time", "Client records, the audit log and encrypted backups. Month to month, and the data stays yours."],
  ]],
];

const FAQ = [
  ["Does it submit claims?", "Not yet. ChartReady checks codes, units and modifiers and produces superbills. Your billing service or clearinghouse submits the claims."],
  ["Can it e-prescribe?", "Prescriptions are written, signed and printed in ChartReady, and you can record ones sent from your e-prescribing system. Sending electronically to pharmacies, including controlled substances, is on the roadmap through a certified partner."],
  ["Is it HIPAA compliant?", "It has the safeguards HIPAA expects: role-based access, two-factor sign-in, automatic sign-out, a tamper-evident audit log and encrypted backups. We sign a Business Associate Agreement with every clinic."],
  ["Can staff use it on their phones?", "Yes. It installs to the home screen on iPhone and Android, and nothing is stored on the phone."],
  ["Can we bring our records from another EHR?", "Yes. We help import clients and key records when you start."],
  ["Is there a contract?", "No. It's month to month, and you can export everything whenever you like."],
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function productPage(req, res, { sent = false, error = null, values = {} } = {}, status = 200) {
  const demo = demoUrl();
  const shot = (name, alt) => html`<figure class="shot"><img src="/ehr/static/product/${name}.jpg?v=2" alt="${alt}" loading="lazy" decoding="async"><figcaption>${alt}</figcaption></figure>`;
  const body = html`
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="wrap nav__in">
  <a class="brand" href="/software">${PRODUCT.name}</a>
  <nav aria-label="Main"><a href="#whats-in-it">What's in it</a><a href="#pricing">Pricing</a><a href="#security">Security</a><a href="#questions">Questions</a></nav>
  <div class="nav__cta"><a href="/ehr/login">Sign in</a><a class="btn" href="#demo">Book a demo</a></div>
</div></header>
<main id="main">
  <section class="intro"><div class="wrap">
    <h1>Records for behavioral health clinics that hold up when the auditor calls.</h1>
    <p class="lede">${PRODUCT.name} keeps notes, treatment plans, check-in, level of care and billing in one place, and checks each note against payer rules before you bill. It was made for outpatient and IOP clinics in Arizona, AHCCCS included.</p>
    <p class="intro__ctas"><a class="btn btn--lg" href="#demo">Book a 20-minute demo</a>${demo ? html` <a class="link-arrow" href="${demo}" target="_blank" rel="noopener">or open the demo yourself</a>` : ""}</p>
    ${demo ? html`<p class="small muted">The demo uses made-up clients. Sign in as <code>therapist@example.com</code> with <code>Demo-Password-2026!</code></p>` : ""}
    ${shot("dashboard", "The dashboard a clinician sees each morning: notes to sign and today's schedule.")}
  </div></section>

  <section class="note"><div class="wrap note__in">
    <p class="note__label">Why it exists</p>
    <div>
      <p>We built ${PRODUCT.name} while running a behavioral health clinic in Arizona. The details came from the work: the 24-hour signature rule, AHCCCS documentation, the front desk at eight in the morning with a full lobby, and the cost of one note that doesn't match the plan.</p>
      <p>It does fewer things than the big systems, on purpose. What it does, it tries to do the way a clinic actually works.</p>
    </div>
  </div></section>

  <section id="whats-in-it" class="section"><div class="wrap">
    <h2>What's in it</h2>
    <div class="groups">${SECTIONS.map(([g, items]) => html`
      <div class="group"><h3>${g}</h3>
        <dl>${items.map(([t, d]) => html`<div><dt>${t}</dt><dd>${d}</dd></div>`)}</dl></div>`)}</div>
  </div></section>

  <section class="section section--rule"><div class="wrap split">
    <div><h2>A second read on every note</h2>
      <p>Press <em>Check insurance compliance</em> on a note and you get findings in plain language: medical necessity, link to the plan, interventions, the client's response, risk, time and coding. Each finding quotes the note and says what to change.</p>
      <p>For AHCCCS members it applies AMPM 940. It works out units from documented minutes and catches copied notes and late entries. You can also upload a PDF from another system and check that.</p></div>
    ${shot("compliance", "Compliance findings on a progress note, each one quoting the sentence it refers to.")}
  </div></section>

  <section class="section section--rule"><div class="wrap split split--rev">
    ${shot("roster", "The check-in page during a group session.")}
    <div><h2>Clients check themselves in</h2>
      <p>An hour before the visit, the client gets a link by text or email. On their phone, or on the lobby iPad, they confirm their details, photograph a new insurance card, answer the PHQ-9 and GAD-7 and sign consent. Returning clients can check in with one tap.</p>
      <p>Nothing they change goes into the chart until staff look at it, and a positive safety screen alerts staff straight away.</p></div>
  </div></section>

  <section class="section section--rule"><div class="wrap split">
    <div><h2>Level of care, the way programs run</h2>
      <p>Admit, step down and discharge, and keep authorizations next to the episode they pay for, with days used and the next review date. The census shows who is at each level today. Reviews due in the next three days show up on the dashboard.</p></div>
    ${shot("census", "The census, grouped by level of care.")}
  </div></section>

  <section id="pricing" class="section section--tint"><div class="wrap">
    <h2>Pricing</h2>
    <p class="muted">Per clinic, per month. No contract, and a Business Associate Agreement is included.</p>
    <div class="prices-wrap"><table class="prices">
      <thead><tr><th scope="col"></th>${PLANS.map((p) => html`<th scope="col">${p.name}<span>$${p.price}<small> / month</small></span></th>`)}</tr></thead>
      <tbody>
        <tr><th scope="row">Best for</th>${PLANS.map((p) => html`<td>${p.blurb.replace(/^For /, "").replace(/\.$/, "")}</td>`)}</tr>
        <tr><th scope="row">Includes</th>${PLANS.map((p) => html`<td><ul>${p.features.map((f) => html`<li>${f}</li>`)}</ul></td>`)}</tr>
      </tbody>
    </table></div>
    <p class="small muted">Arizona clinics willing to give us feedback in the first months can ask about 60 days free.</p>
  </div></section>

  <section id="security" class="section"><div class="wrap split split--text">
    <h2>Looking after protected health information</h2>
    <ul class="plain">
      <li><b>Access by role.</b> Clinicians, front desk, billing and administrators each see what their job needs. Psychotherapy notes stay with the clinician who wrote them.</li>
      <li><b>Two-factor sign-in</b> with an authenticator app, automatic sign-out and lockout after repeated failures.</li>
      <li><b>An audit log that can't be quietly edited.</b> Every view and change is recorded and chained, with alerts for unusual access.</li>
      <li><b>Encrypted backups</b>, restore checks and a full export.</li>
      <li><b>Client rights.</b> Record copies and an accounting of disclosures.</li>
      <li><b>No clinical details in texts or emails.</b> They carry a link and nothing else.</li>
    </ul>
  </div></section>

  <section id="questions" class="section section--rule"><div class="wrap faq">
    <h2>Questions clinics ask</h2>
    ${FAQ.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}
  </div></section>

  <section id="demo" class="section section--tint"><div class="wrap demo">
    <div><h2>Book a 20-minute demo</h2>
      <p>We'll walk through an ordinary day at your clinic: check-in, a progress note and its compliance check, a treatment plan, and billing. Bring the questions your last audit raised.</p></div>
    <form class="demo__form" method="post" action="/software/demo#demo">
      ${sent ? html`<div class="alert alert--success" role="status">Thank you. We'll be in touch within one business day to find a time.</div>` : ""}
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      ${sent ? "" : html`
      <div class="form-grid">
        <label>Your name <input name="name" maxlength="120" required value="${values.name || ""}" autocomplete="name"></label>
        <label>Work email <input type="email" name="email" maxlength="160" required value="${values.email || ""}" autocomplete="email"></label>
        <label>Phone <span class="hint">(optional)</span><input type="tel" name="phone" maxlength="40" value="${values.phone || ""}" autocomplete="tel"></label>
        <label>Clinic or organization <input name="organization" maxlength="160" value="${values.organization || ""}" autocomplete="organization"></label>
        <label>Your role <select name="role">${["", "Owner / CEO", "Clinical director", "Billing / revenue cycle", "Office manager", "Clinician", "Other"].map((r) => html`<option ${r === values.role ? raw("selected") : ""}>${r}</option>`)}</select></label>
        <label>Number of clinicians <select name="clinicians">${["", "1–5", "6–20", "21–50", "50+"].map((r) => html`<option ${r === values.clinicians ? raw("selected") : ""}>${r}</option>`)}</select></label>
        <label class="span-all">Anything we should know? <span class="hint">(please leave out any client information)</span><textarea name="message" rows="3" maxlength="2000">${values.message || ""}</textarea></label>
        <label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <button class="btn btn--lg" type="submit">Request a demo</button>`}
    </form>
  </div></section>
</main>
<footer class="foot"><div class="wrap foot__in">
  <span><b>${PRODUCT.name}</b>, records for behavioral health clinics</span>
  <span><a href="/ehr/login">Sign in</a>${demo ? html` · <a href="${demo}" target="_blank" rel="noopener">Demo</a>` : ""}${salesEmail() ? html` · <a href="mailto:${salesEmail()}">${salesEmail()}</a>` : ""}</span>
  <span class="muted small">© ${new Date().getFullYear()} ${PRODUCT.name}. Software for clinics; it does not provide medical care. In a crisis, call or text 988.</span>
</div></footer>`;
  res.status(status).set("Cache-Control", "no-cache").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PRODUCT.name)}: records for behavioral health clinics</title>
<meta name="description" content="ChartReady keeps notes, treatment plans, check-in, level of care and billing in one place for outpatient and IOP behavioral health clinics, and checks each note against payer rules before you bill.">
<meta name="theme-color" content="#f6f5f1">
<link rel="icon" href="/ehr/static/icons/icon-32.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/ehr/static/product.css?v=2">
</head><body>${body}</body></html>`);
}

publicRouter.get("/", (req, res) => productPage(req, res, { sent: req.query.sent === "1" }));

const attempts = new Map();
const smallForm = express.urlencoded({ extended: false, limit: "20kb" });
publicRouter.post("/demo", smallForm, async (req, res) => {
  const b = req.body || {};
  const v = {};
  for (const [k, n] of [["name", 120], ["email", 160], ["phone", 40], ["organization", 160], ["role", 60], ["clinicians", 20], ["message", 2000]]) v[k] = String(b[k] || "").trim().slice(0, n);
  if (b.website) return productPage(req, res, { sent: true }); // honeypot: pretend success
  const key = crypto.createHash("sha256").update(String(req.ip)).digest("hex");
  const now = Date.now(), a = attempts.get(key) || { n: 0, reset: now + 3600e3 };
  if (now > a.reset) { a.n = 0; a.reset = now + 3600e3; }
  a.n++; attempts.set(key, a);
  if (a.n > 5) return productPage(req, res, { error: "Thanks, we already have your request. We'll be in touch soon.", values: v }, 429);
  if (!v.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return productPage(req, res, { error: "Please add your name and a work email.", values: v }, 400);
  const id = Number(req.db.prepare(`INSERT INTO sales_leads (name, email, phone, organization, role, clinicians, message) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(v.name, v.email, v.phone || null, v.organization || null, v.role || null, v.clinicians || null, v.message || null).lastInsertRowid);
  const to = salesEmail();
  const mc = mailer.mailConfig();
  if (to && mc.enabled) {
    const lines = [["Name", v.name], ["Email", v.email], ["Phone", v.phone], ["Organization", v.organization], ["Role", v.role], ["Clinicians", v.clinicians], ["Message", v.message]].filter(([, x]) => x);
    mailer.sendMail({ to, subject: `New ${PRODUCT.name} demo request: ${v.organization || v.name}`,
      text: lines.map(([k, x]) => `${k}: ${x}`).join("\n"),
      html: `<table>${lines.map(([k, x]) => `<tr><td style="color:#5d6b7e;padding:4px 12px 4px 0">${esc(k)}</td><td>${esc(x)}</td></tr>`).join("")}</table>` }, mc)
      .catch((e) => console.error("[sales] lead email failed:", e.message));
  }
  console.log(`[sales] new demo request #${id}`);
  res.redirect(303, "/software?sent=1#demo");
});
publicRouter.get("/thanks", (req, res) => res.redirect("/software?sent=1#demo"));

/* ---------------- Admin: leads ---------------- */
const STATUSES = ["new", "contacted", "demo_scheduled", "won", "lost"];
const LABEL = { new: "New", contacted: "Contacted", demo_scheduled: "Demo scheduled", won: "Won", lost: "Lost" };
router.get("/admin/leads", requirePerm("admin"), (req, res) => {
  const rows = req.db.prepare("SELECT * FROM sales_leads ORDER BY status = 'new' DESC, created_at DESC LIMIT 500").all();
  audit(req, "view", "sales_leads", null, null, `${rows.length}`);
  res.send(page(req, { title: "Sales leads", active: "admin", body: html`
    <div class="page-head"><div><h1>Sales leads</h1><p>Demo requests from the ${PRODUCT.name} website (<a href="/software" target="_blank" rel="noopener">/software</a>).${salesEmail() ? ` New requests are also emailed to ${salesEmail()}.` : " Set EHR_SALES_EMAIL to get an email for each new request."}</p></div>
      <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
    <section class="card">${rows.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Received</th><th>Name</th><th>Organization</th><th>Contact</th><th>Size</th><th>Status</th></tr></thead>
      <tbody>${rows.map((l) => html`<tr>
        <td class="small">${fmtTimestamp(l.created_at)}</td>
        <td><strong>${l.name}</strong>${l.role ? html`<br><span class="small muted">${l.role}</span>` : ""}${l.message ? html`<br><span class="small">${l.message}</span>` : ""}</td>
        <td>${l.organization || html`<span class="muted">—</span>`}</td>
        <td class="small"><a href="mailto:${l.email}">${l.email}</a>${l.phone ? html`<br><a href="tel:${l.phone}">${l.phone}</a>` : ""}</td>
        <td>${l.clinicians || "—"}</td>
        <td><form class="inline-form" method="post" action="/ehr/admin/leads/${l.id}">${csrfField(req)}
          <select name="status" aria-label="Status for ${l.name}">${STATUSES.map((s) => html`<option value="${s}" ${s === l.status ? raw("selected") : ""}>${LABEL[s]}</option>`)}</select>
          <button class="btn btn--sm" type="submit">Save</button></form></td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No demo requests yet. Share your website: <strong>/software</strong>.</p>`}</section>` }));
});
router.post("/admin/leads/:id", requirePerm("admin"), (req, res) => {
  const st = String((req.body || {}).status || "");
  if (STATUSES.includes(st)) req.db.prepare("UPDATE sales_leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(st, Number(req.params.id));
  audit(req, "update", "sales_lead", Number(req.params.id), null, st);
  res.redirect("/ehr/admin/leads");
});

module.exports = { siteRouter: publicRouter, router, PLANS };
