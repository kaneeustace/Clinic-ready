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

const FEATURES = [
  ["Notes that pass audits", "Progress, intake, group, psychiatry, ASAM, safety plan and more, with required fields, late-entry and cloned-note checks, and signature deadlines."],
  ["AI insurance-compliance check", "One tap reviews a note the way a payer auditor would and tells you exactly what to fix. Upload a PDF from another system and it checks that too."],
  ["Treatment plans that connect", "Problems, goals, objectives and interventions, linked to every progress note. Notes can't be written until there's an active plan."],
  ["AHCCCS built in", "AMPM 940 encounter fields, service-plan rules, education modifiers, place-of-service and telehealth checks for clients with an AHCCCS ID."],
  ["Workboard and co-signs", "To do, in progress, done. 24-hour signature and 48-hour supervisor co-sign countdowns, plus an end-of-day email of what's outstanding."],
  ["Hormone therapy (TRT)", "Optional module for men's health: testosterone regimen, labs with hematocrit and PSA alerts, doses and injection sites, and a Schedule III stock record with witnessed waste."],
  ["Level of care and UR", "Admissions, step-downs, authorizations, days used, next review and a live census, the way IOP and residential programs work."],
  ["Client check-in on their phone", "Automatic texted or emailed links, a front-desk iPad kiosk, PHQ-9/GAD-7, insurance card photos and a signed consent. Group rosters show who's here."],
  ["Billing that's ready to bill", "Charges with units from documented minutes, AHCCCS modifier and POS checks, superbills with your NPI and tax ID."],
];

const FAQ = [
  ["Does it submit claims?", "Not directly yet. ChartReady checks codes, units and modifiers and produces superbills; your billing service or clearinghouse submits the claims."],
  ["Does it do e-prescribing?", "No. Medications are tracked on the chart; prescribing happens in your e-prescribing tool."],
  ["Is it HIPAA compliant?", "ChartReady is built with HIPAA safeguards: role-based access, two-factor sign-in, automatic sign-out, a tamper-evident audit log, encrypted backups and data export. We sign a Business Associate Agreement with every clinic, and host on infrastructure covered by a BAA."],
  ["Can my staff use it on their phones?", "Yes. It installs to the home screen like an app on iPhone and Android, and nothing is stored on the phone."],
  ["Can we bring our data from another EHR?", "Yes. We help you import clients and key records during onboarding."],
  ["Is there a contract?", "Month to month. Your data is yours, and you can export it at any time."],
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function productPage(req, res, { sent = false, error = null, values = {} } = {}, status = 200) {
  const demo = demoUrl();
  const shot = (name, alt, cls = "") => html`<img class="shot ${cls}" src="/ehr/static/product/${name}.jpg" alt="${alt}" loading="lazy" decoding="async">`;
  const body = html`
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="wrap nav__in">
  <a class="brand" href="/software"><span class="mark" aria-hidden="true"></span>${PRODUCT.name}</a>
  <nav aria-label="Main"><a href="#features">Features</a><a href="#ahcccs">AHCCCS</a><a href="#checkin">Check-in</a><a href="#pricing">Pricing</a><a href="#security">Security</a></nav>
  <div class="nav__cta"><a class="link" href="/ehr/login">Sign in</a><a class="btn btn--primary" href="#demo">Book a demo</a></div>
</div></header>
<main id="main">
  <section class="hero"><div class="wrap hero__in">
    <div class="hero__copy">
      <p class="eyebrow">${PRODUCT.tagline} for outpatient &amp; IOP clinics</p>
      <h1>The EHR that keeps your notes audit-ready.</h1>
      <p class="lede">Notes, treatment plans, check-in, level of care and billing in one place, with AI that checks every note for insurance compliance before you bill. Built for Arizona clinics, AHCCCS included.</p>
      <div class="hero__ctas"><a class="btn btn--primary btn--lg" href="#demo">Book a demo</a>${demo ? html`<a class="btn btn--ghost btn--lg" href="${demo}" target="_blank" rel="noopener">Try the live demo</a>` : ""}</div>
      ${demo ? html`<p class="small muted">Live demo uses fictional clients. Password for every demo account: <code>Demo-Password-2026!</code> · try <code>therapist@example.com</code></p>` : ""}
    </div>
    <div class="hero__art">${shot("dashboard", "ChartReady dashboard with the workboard and signature countdowns", "shot--desk")}${shot("checkin-phone", "Client checking in on a phone", "shot--phone")}</div>
  </div></section>

  <section class="pains"><div class="wrap pains__in">
    <div><b>Recoupments hurt.</b><p>One audit can claw back months of revenue over missing times, vague notes or a plan that's out of date.</p></div>
    <div><b>Notes slip.</b><p>Unsigned drafts and missing co-signatures pile up until billing stalls.</p></div>
    <div><b>Front desks juggle.</b><p>Paper intake, insurance cards and screeners eat the first 15 minutes of every visit.</p></div>
  </div></section>

  <section id="features" class="section"><div class="wrap">
    <p class="eyebrow">Everything a behavioral health clinic runs on</p>
    <h2>Documentation, compliance and the front desk, together</h2>
    <div class="features">${FEATURES.map(([t, d]) => html`<article class="feature"><h3>${t}</h3><p>${d}</p></article>`)}</div>
  </div></section>

  <section class="section section--alt"><div class="wrap split">
    <div><p class="eyebrow">Catch it before the payer does</p><h2>An auditor's eye on every note</h2>
      <p>Tap <strong>Check insurance compliance</strong> and get plain-language findings: medical necessity, plan linkage, interventions, response, risk, time and coding. Each one quotes the note and tells the clinician how to fix it. Rule-based checks run on every note, and AI review adds depth when you turn it on.</p>
      <ul class="ticks"><li>AHCCCS AMPM 940 rules for AHCCCS members</li><li>Units calculated from documented minutes</li><li>Cloned-note and late-entry detection</li><li>Scan PDFs from other systems</li></ul></div>
    ${shot("compliance", "Insurance compliance findings on a progress note")}
  </div></section>

  <section id="ahcccs" class="section"><div class="wrap split split--rev">
    ${shot("chart", "Patient chart with AHCCCS ID, diagnoses and level of care")}
    <div><p class="eyebrow">Arizona Medicaid</p><h2>AHCCCS, without the binder</h2>
      <p>When a client has an AHCCCS ID, ChartReady switches on the AHCCCS documentation set: encounter details, assessment domains, service plan requirements, the one-year rules behind edit MD466, guardian signatures, telehealth modifiers and member-location place of service. Everyone else gets your standard forms.</p></div>
  </div></section>

  <section id="checkin" class="section section--alt"><div class="wrap split">
    <div><p class="eyebrow">Client check-in</p><h2>Clients check themselves in</h2>
      <p>An hour before each visit, clients get a link by text or email. They confirm contact details, photograph a new insurance card, answer the PHQ-9 and GAD-7, and sign consent, on their own phone or the lobby iPad. Returning clients check in with one tap. A positive safety screen alerts staff immediately.</p>
      <ul class="ticks"><li>Group rosters: "5 of 8 here"</li><li>Front-desk iPad kiosk that resets itself</li><li>Changes wait for staff review</li></ul></div>
    ${shot("roster", "Check-ins page with a group session roster")}
  </div></section>

  <section class="section"><div class="wrap split split--rev">
    ${shot("census", "Census by level of care with utilization reviews due")}
    <div><p class="eyebrow">IOP, PHP and residential</p><h2>Level of care and UR, built in</h2>
      <p>Admit, step down, discharge, and track authorizations with days used and next review dates. The census shows who's at each level today, and the dashboard flags reviews due in the next three days.</p></div>
  </div></section>

  <section id="pricing" class="section section--alt"><div class="wrap">
    <p class="eyebrow">Launch pricing</p><h2>Simple monthly pricing</h2>
    <div class="plans">${PLANS.map((p) => html`<article class="plan${p.featured ? " plan--featured" : ""}">
      ${p.featured ? html`<span class="plan__tag">Most popular</span>` : ""}
      <h3>${p.name}</h3><p class="plan__price"><b>$${p.price}</b> / month</p><p class="muted">${p.blurb}</p>
      <ul class="ticks">${p.features.map((f) => html`<li>${f}</li>`)}</ul>
      <a class="btn ${p.featured ? "btn--primary" : "btn--ghost"}" href="#demo">Book a demo</a></article>`)}</div>
    <p class="small muted center">Month to month. A Business Associate Agreement is included. Arizona design partners: ask about 60 days free.</p>
  </div></section>

  <section id="security" class="section"><div class="wrap">
    <p class="eyebrow">Security &amp; HIPAA</p><h2>Built for protected health information</h2>
    <div class="features features--sec">
      <article class="feature"><h3>Access control</h3><p>Roles for clinicians, front desk, billing and admins. Psychotherapy notes stay with their author.</p></article>
      <article class="feature"><h3>Two-factor sign-in</h3><p>Authenticator-app codes, automatic sign-out and account lockout.</p></article>
      <article class="feature"><h3>Tamper-evident audit log</h3><p>Every view and change is recorded in a hash-chained log with security alerts.</p></article>
      <article class="feature"><h3>Encrypted backups</h3><p>Automatic encrypted backups, restore drills and a full data export.</p></article>
      <article class="feature"><h3>Right of access</h3><p>Client record copies and an accounting of disclosures, built in.</p></article>
      <article class="feature"><h3>BAA with every clinic</h3><p>Texts and emails carry links only, never clinical details.</p></article>
    </div>
  </div></section>

  <section class="section section--alt"><div class="wrap faq">
    <h2>Questions clinics ask</h2>
    ${FAQ.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}
  </div></section>

  <section id="demo" class="section"><div class="wrap demo">
    <div><p class="eyebrow">See it with your own workflows</p><h2>Book a 20-minute demo</h2>
      <p>We'll walk through a day at your clinic: check-in, a progress note with the compliance check, a treatment plan, and billing.${demo ? html` Or open the <a href="${demo}" target="_blank" rel="noopener">live demo</a> yourself.` : ""}</p></div>
    <form class="card demo__form" method="post" action="/software/demo#demo">
      ${sent ? html`<div class="alert alert--success" role="status">Thanks! We'll be in touch within one business day to set up your demo.</div>` : ""}
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      ${sent ? "" : html`
      <div class="form-grid">
        <label>Your name <input name="name" maxlength="120" required value="${values.name || ""}" autocomplete="name"></label>
        <label>Work email <input type="email" name="email" maxlength="160" required value="${values.email || ""}" autocomplete="email"></label>
        <label>Phone <span class="hint">(optional)</span><input type="tel" name="phone" maxlength="40" value="${values.phone || ""}" autocomplete="tel"></label>
        <label>Clinic or organization <input name="organization" maxlength="160" value="${values.organization || ""}" autocomplete="organization"></label>
        <label>Your role <select name="role">${["", "Owner / CEO", "Clinical director", "Billing / revenue cycle", "Office manager", "Clinician", "Other"].map((r) => html`<option ${r === values.role ? raw("selected") : ""}>${r}</option>`)}</select></label>
        <label>Number of clinicians <select name="clinicians">${["", "1–5", "6–20", "21–50", "50+"].map((r) => html`<option ${r === values.clinicians ? raw("selected") : ""}>${r}</option>`)}</select></label>
        <label class="span-all">Anything we should know? <span class="hint">(please don't include client information)</span><textarea name="message" rows="3" maxlength="2000">${values.message || ""}</textarea></label>
        <label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <button class="btn btn--primary btn--lg" type="submit">Request a demo</button>`}
    </form>
  </div></section>
</main>
<footer class="foot"><div class="wrap foot__in">
  <span><b>${PRODUCT.name}</b> · ${PRODUCT.tagline}</span>
  <span><a href="/ehr/login">Sign in</a>${demo ? html` · <a href="${demo}" target="_blank" rel="noopener">Live demo</a>` : ""}${salesEmail() ? html` · <a href="mailto:${salesEmail()}">${salesEmail()}</a>` : ""}</span>
  <span class="muted small">© ${new Date().getFullYear()} ${PRODUCT.name}. ChartReady is software for clinics and does not provide medical care. In crisis? Call or text 988.</span>
</div></footer>`;
  res.status(status).set("Cache-Control", "no-cache").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PRODUCT.name)} · ${esc(PRODUCT.tagline)} for outpatient &amp; IOP clinics</title>
<meta name="description" content="ChartReady is a behavioral health EHR for outpatient and IOP clinics: audit-ready notes, AI insurance-compliance checks, AHCCCS rules, phone check-in, level of care and billing.">
<meta name="theme-color" content="#111f3b">
<link rel="icon" href="/ehr/static/icons/icon-32.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/ehr/static/product.css?v=1">
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
