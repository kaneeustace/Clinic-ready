"use strict";
/*
 * Billing: charges, payments, fee schedule, patient ledger and superbills.
 *   billing:read  -> view (admin, billing, clinician, frontdesk)
 *   billing:write -> change (admin, billing)
 *   admin         -> edit the fee schedule
 */
const express = require("express");
const { tx } = require("../db");
const { audit } = require("../audit");
const { requirePerm } = require("../auth");
const { can } = require("../permissions");
const {
  html, raw, page, chartPage, notFound, csrfField, select, badge, getPatient, patientName,
  today, nowLocal, addDays, fmtDate, money, parseMoney, humanize,
} = require("../views");

const router = express.Router();
const read = requirePerm("billing:read");
const write = requirePerm("billing:write");

const STATUSES = ["unbilled", "billed", "paid", "denied", "void"];
const TRANSITIONS = {
  unbilled: ["billed", "void"],
  billed: ["paid", "denied", "void"],
  denied: ["billed", "void"],
  paid: ["void"],
  void: [],
};
const TRANSITION_LABEL = { billed: "Mark billed", paid: "Mark paid", denied: "Mark denied", void: "Void" };
const METHODS = ["card", "cash", "check", "insurance", "adjustment"];
const METHOD_LABEL = { card: "Card", cash: "Cash", check: "Check", insurance: "Insurance payment", adjustment: "Adjustment (credit)" };
const PAGE_SIZE = 50;
const CPT_RE = /^\d{4}[0-9A-Z]$/;
const ICD_RE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
const MODIFIER_RE = /^[0-9A-Z]{2}$/;

const PRACTICE = {
  name: "Clinic Ready Behavioral Health",
  address: "123 Placeholder Ave, Suite 100, Your City, ST 00000",
  phone: "(555) 010-0000",
  npi: "[placeholder]",
  taxId: "[placeholder]",
};

/* ---------------- helpers ---------------- */
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const toInt = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : null);
const providerName = (r) => (r && r.provider_name ? `${r.provider_name}${r.provider_credentials ? `, ${r.provider_credentials}` : ""}` : "");

function loadPatient(req, res) {
  const id = toInt(req.params.id);
  const p = id ? getPatient(req, id) : null;
  if (!p) notFound(req, res, "Patient");
  return p;
}

function feeFor(db, cpt) {
  return db.prepare("SELECT * FROM fee_schedule WHERE cpt_code = ? AND active = 1").get(cpt) || null;
}
function activeFees(db) {
  return db.prepare("SELECT * FROM fee_schedule WHERE active = 1 ORDER BY cpt_code").all();
}
function providers(db) {
  return db.prepare("SELECT id, name, credentials, npi FROM users WHERE active = 1 AND role = 'clinician' ORDER BY name").all();
}
function patientBalance(db, patientId) {
  const c = db.prepare("SELECT COALESCE(SUM(fee_cents),0) AS n FROM charges WHERE patient_id = ? AND status != 'void'").get(patientId).n;
  const p = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM payments WHERE patient_id = ?").get(patientId).n;
  return { charges: c, payments: p, balance: c - p };
}
function insurance(db, patientId) {
  return db.prepare("SELECT * FROM insurance_policies WHERE patient_id = ? AND active = 1 ORDER BY priority = 'primary' DESC, id").all(patientId);
}
function activeDiagnoses(db, patientId) {
  return db.prepare("SELECT * FROM diagnoses WHERE patient_id = ? AND status = 'active' ORDER BY is_primary DESC, created_at, id").all(patientId);
}
/** Completed past appointments with no non-void charge. */
function unchargedAppointments(db, { patientId = null, limit = 100 } = {}) {
  return db.prepare(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.mrn, u.name AS provider_name, u.credentials AS provider_credentials
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = a.clinician_id
     WHERE a.status = 'completed' AND a.start_at < ? ${patientId ? "AND a.patient_id = ?" : ""}
       AND NOT EXISTS (SELECT 1 FROM charges c WHERE c.appointment_id = a.id AND c.status != 'void')
     ORDER BY a.start_at DESC LIMIT ?`).all(...[nowLocal(), ...(patientId ? [patientId] : []), limit]);
}

/** Suggested CPT for an appointment, by type and duration. */
function suggestCpt(appt) {
  if (!appt) return "";
  const mins = (new Date(appt.end_at + ":00Z") - new Date(appt.start_at + ":00Z")) / 60000;
  switch (appt.type) {
    case "therapy":
      if (mins >= 53) return "90837";
      if (mins >= 38) return "90834";
      return "90832";
    case "med_management": return "99214";
    case "intake": return "90791";
    case "psychiatry_eval": return "90792";
    case "family": return "90847";
    case "group": return "90853";
    default: return "";
  }
}

function errorList(errors) {
  const list = Object.values(errors || {});
  return list.length ? html`<div class="alert alert--error" role="alert"><strong>Please fix the following:</strong><ul>${list.map((e) => html`<li>${e}</li>`)}</ul></div>` : "";
}
const fieldError = (errors, k) => (errors && errors[k] ? html`<span class="error-text">${errors[k]}</span>` : "");

/** Status-change buttons for one charge. `back` is where to return afterwards. */
function statusActions(req, charge, back) {
  if (!can(req.user, "billing:write")) return "";
  const next = TRANSITIONS[charge.status] || [];
  if (!next.length) return "";
  return html`
    <form class="inline-form" method="post" action="/ehr/charges/${charge.id}/status">
      ${csrfField(req)}
      <input type="hidden" name="back" value="${back}">
      ${next.includes("void") ? html`<input type="hidden" name="confirm" value="yes">` : ""}
      ${next.map((s) => html`<button class="btn btn--sm ${s === "void" ? "btn--danger" : ""}" type="submit" name="status" value="${s}"
        ${s === "void" ? raw('data-confirm="Void this charge? Voided charges cannot be changed again."') : ""}>${TRANSITION_LABEL[s]}</button> `)}
    </form>`;
}

/* ---------------- dashboard ---------------- */
router.get("/billing", read, (req, res) => {
  const db = req.db;
  const q = req.query;
  const status = STATUSES.includes(q.status) ? q.status : "";
  const from = validDate(q.from) ? q.from : "";
  const to = validDate(q.to) ? q.to : "";
  const pageNo = Math.max(1, toInt(q.page) || 1);

  const unbilled = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fee_cents),0) AS amt FROM charges WHERE status = 'unbilled'").get();
  const billed = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fee_cents),0) AS amt FROM charges WHERE status = 'billed'").get();
  const monthStart = today().slice(0, 7) + "-01";
  const paidMonth = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amt FROM payments WHERE received_on >= ? AND received_on <= ?").get(monthStart, today());
  const queue = unchargedAppointments(db, { limit: 100 });

  const where = [];
  const params = [];
  if (status) { where.push("c.status = ?"); params.push(status); }
  if (from) { where.push("c.date_of_service >= ?"); params.push(from); }
  if (to) { where.push("c.date_of_service <= ?"); params.push(to); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM charges c ${w}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(pageNo, pages);
  const charges = db.prepare(
    `SELECT c.*, p.first_name, p.last_name, p.preferred_name, p.mrn, u.name AS provider_name, u.credentials AS provider_credentials
     FROM charges c JOIN patients p ON p.id = c.patient_id LEFT JOIN users u ON u.id = c.rendering_provider_id
     ${w} ORDER BY c.date_of_service DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, (cur - 1) * PAGE_SIZE);

  const qs = (n) => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (from) u.set("from", from);
    if (to) u.set("to", to);
    if (n > 1) u.set("page", String(n));
    const s = u.toString();
    return "/ehr/billing" + (s ? "?" + s : "");
  };
  const back = qs(cur);

  audit(req, "view", "charge", null, null, "billing dashboard");
  const tile = (label, value, sub) => html`<div class="tile"><span class="tile__num">${value}</span><span class="tile__label">${label}</span>${sub ? html`<span class="tile__label small">${sub}</span>` : ""}</div>`;

  res.send(page(req, {
    title: "Billing",
    active: "billing",
    body: html`
      <div class="page-head">
        <h1>Billing</h1>
        <div class="row"><a class="btn" href="/ehr/billing/fee-schedule">Fee schedule</a></div>
      </div>
      <div class="tiles">
        ${tile("Unbilled charges", money(unbilled.amt), `${unbilled.n} charge${unbilled.n === 1 ? "" : "s"}`)}
        ${tile("Billed, outstanding", money(billed.amt), `${billed.n} charge${billed.n === 1 ? "" : "s"}`)}
        ${tile("Payments this month", money(paidMonth.amt), `${paidMonth.n} payment${paidMonth.n === 1 ? "" : "s"}`)}
        ${tile("Visits without charges", queue.length, "completed, not yet charged")}
      </div>

      <section class="card" aria-labelledby="queue-h">
        <div class="card__head"><h2 id="queue-h">Completed appointments without charges</h2></div>
        ${queue.length ? html`
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Date</th><th>Patient</th><th>Type</th><th>Provider</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${queue.map((a) => html`
              <tr>
                <td>${fmtDate(a.start_at)}</td>
                <td><a href="/ehr/patients/${a.patient_id}/billing">${patientName(a)}</a> <span class="muted small">${a.mrn}</span></td>
                <td>${humanize(a.type)}${a.modality === "telehealth" ? html` <span class="pill">Telehealth</span>` : ""}</td>
                <td>${providerName(a)}</td>
                <td>${can(req.user, "billing:write") ? html`<a class="btn btn--sm btn--primary" href="/ehr/patients/${a.patient_id}/charges/new?appointment_id=${a.id}">Create charge</a>` : ""}</td>
              </tr>`)}</tbody>
          </table></div>` : html`<p class="muted">All completed appointments have charges.</p>`}
      </section>

      <section class="card" aria-labelledby="charges-h">
        <div class="card__head"><h2 id="charges-h">Charges</h2></div>
        <form method="get" action="/ehr/billing" class="form-grid" role="search" aria-label="Filter charges">
          <label>Status ${select("status", [{ value: "", label: "All statuses" }, ...STATUSES.map((s) => ({ value: s, label: humanize(s) }))], status)}</label>
          <label>From <input type="date" name="from" value="${from}"></label>
          <label>To <input type="date" name="to" value="${to}"></label>
          <div class="row" style="align-self:end"><button class="btn btn--primary" type="submit">Filter</button> <a class="btn btn--ghost" href="/ehr/billing">Clear</a></div>
        </form>
        <p class="muted small">${total ? `Showing ${(cur - 1) * PAGE_SIZE + 1}–${Math.min(cur * PAGE_SIZE, total)} of ${total}` : "No charges match."}</p>
        ${charges.length ? html`
          <div class="table-wrap"><table class="table">
            <thead><tr><th>DOS</th><th>Patient</th><th>CPT</th><th class="num">Units</th><th class="num">Fee</th><th>Provider</th><th>Bill to</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${charges.map((c) => html`
              <tr>
                <td>${fmtDate(c.date_of_service)}</td>
                <td><a href="/ehr/patients/${c.patient_id}/billing">${patientName(c)}</a></td>
                <td>${c.cpt_code}${c.modifier ? `-${c.modifier}` : ""}</td>
                <td class="num">${c.units}</td>
                <td class="num">${money(c.fee_cents)}</td>
                <td>${providerName(c)}</td>
                <td>${humanize(c.bill_to)}</td>
                <td>${badge(c.status)}</td>
                <td>${statusActions(req, c, back)}</td>
              </tr>`)}</tbody>
          </table></div>` : ""}
        ${pages > 1 ? html`
          <nav class="row" aria-label="Pagination" style="margin-top:.75rem">
            ${cur > 1 ? html`<a class="btn btn--sm" href="${qs(cur - 1)}">Previous</a>` : ""}
            <span class="muted small">Page ${cur} of ${pages}</span>
            ${cur < pages ? html`<a class="btn btn--sm" href="${qs(cur + 1)}">Next</a>` : ""}
          </nav>` : ""}
      </section>`,
  }));
});

/* ---------------- fee schedule ---------------- */
function feeSchedulePage(req, res, { errors = {}, values = {}, status = 200 } = {}) {
  const fees = req.db.prepare("SELECT * FROM fee_schedule ORDER BY cpt_code").all();
  const isAdmin = can(req.user, "admin");
  res.status(status).send(page(req, {
    title: "Fee schedule",
    active: "billing",
    body: html`
      <div class="page-head"><h1>Fee schedule</h1><a class="btn btn--ghost" href="/ehr/billing">Back to billing</a></div>
      ${errorList(errors)}
      <section class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>CPT</th><th>Description</th><th class="num">Fee</th><th>Status</th>${isAdmin ? html`<th>Update</th>` : ""}</tr></thead>
          <tbody>${fees.map((f) => html`
            <tr>
              <td>${f.cpt_code}</td>
              <td>${f.description}</td>
              <td class="num">${money(f.fee_cents)}</td>
              <td>${f.active ? badge("active") : badge("inactive")}</td>
              ${isAdmin ? html`<td>
                <form class="row" method="post" action="/ehr/billing/fee-schedule">
                  ${csrfField(req)}
                  <input type="hidden" name="cpt_code" value="${f.cpt_code}">
                  <label class="visually-hidden" for="fee-${f.cpt_code}">Fee for ${f.cpt_code}</label>
                  <input id="fee-${f.cpt_code}" name="fee" value="${(f.fee_cents / 100).toFixed(2)}" inputmode="decimal" style="width:7rem">
                  <label class="check"><input type="checkbox" name="active" value="1" ${f.active ? raw("checked") : ""}> Active</label>
                  <button class="btn btn--sm" type="submit">Save</button>
                </form></td>` : ""}
            </tr>`)}</tbody>
        </table></div>
      </section>
      ${isAdmin ? html`
        <section class="card" aria-labelledby="add-code-h">
          <h2 id="add-code-h">Add a code</h2>
          <form method="post" action="/ehr/billing/fee-schedule">
            ${csrfField(req)}
            <input type="hidden" name="active" value="1">
            <div class="form-grid">
              <label>CPT/HCPCS code <input name="cpt_code" value="${values.cpt_code || ""}" maxlength="5" required pattern="[0-9]{4}[0-9A-Za-z]"> ${fieldError(errors, "cpt_code")}</label>
              <label class="span-all">Description <input name="description" value="${values.description || ""}" maxlength="200" required> ${fieldError(errors, "description")}</label>
              <label>Fee ($) <input name="fee" value="${values.fee || ""}" inputmode="decimal" required> ${fieldError(errors, "fee")}</label>
            </div>
            <div class="form-actions"><button class="btn btn--primary" type="submit">Add code</button></div>
          </form>
        </section>` : html`<p class="muted small">Only administrators can change the fee schedule.</p>`}`,
  }));
}

router.get("/billing/fee-schedule", read, (req, res) => feeSchedulePage(req, res));

router.post("/billing/fee-schedule", requirePerm("admin"), (req, res) => {
  const db = req.db;
  const values = { cpt_code: str(req.body.cpt_code, 10).toUpperCase(), description: str(req.body.description), fee: str(req.body.fee, 20) };
  const errors = {};
  if (!CPT_RE.test(values.cpt_code)) errors.cpt_code = "CPT code must be 4 digits followed by a digit or letter (e.g. 90837).";
  const fee = parseMoney(values.fee);
  if (fee === null || fee <= 0 || fee > 10000000) errors.fee = "Enter a fee greater than $0.";
  const existing = errors.cpt_code ? null : db.prepare("SELECT * FROM fee_schedule WHERE cpt_code = ?").get(values.cpt_code);
  if (!existing && !values.description && !errors.cpt_code) errors.description = "Description is required for a new code.";
  if (Object.keys(errors).length) return feeSchedulePage(req, res, { errors, values, status: 400 });
  const active = req.body.active === "1" ? 1 : 0;
  if (existing) {
    db.prepare("UPDATE fee_schedule SET fee_cents = ?, description = ?, active = ? WHERE cpt_code = ?")
      .run(fee, values.description || existing.description, active, values.cpt_code);
    audit(req, "update", "fee_schedule", null, null, `code ${values.cpt_code}`);
    req.flash("success", `Updated ${values.cpt_code}.`);
  } else {
    db.prepare("INSERT INTO fee_schedule (cpt_code, description, fee_cents, active) VALUES (?, ?, ?, ?)").run(values.cpt_code, values.description, fee, active);
    audit(req, "create", "fee_schedule", null, null, `code ${values.cpt_code}`);
    req.flash("success", `Added ${values.cpt_code}.`);
  }
  res.redirect("/ehr/billing/fee-schedule");
});

/* ---------------- patient ledger ---------------- */
function ledgerPage(req, res, patient, { errors = {}, values = {}, status = 200 } = {}) {
  const db = req.db;
  const charges = db.prepare(
    `SELECT c.*, f.description, u.name AS provider_name, u.credentials AS provider_credentials
     FROM charges c LEFT JOIN fee_schedule f ON f.cpt_code = c.cpt_code LEFT JOIN users u ON u.id = c.rendering_provider_id
     WHERE c.patient_id = ?`).all(patient.id);
  const payments = db.prepare("SELECT * FROM payments WHERE patient_id = ?").all(patient.id);
  const rows = [
    ...charges.map((c) => ({ kind: "charge", date: c.date_of_service, seq: c.created_at, id: c.id, c })),
    ...payments.map((p) => ({ kind: "payment", date: p.received_on, seq: p.created_at, id: p.id, p })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind !== b.kind ? (a.kind === "charge" ? -1 : 1) : a.id - b.id));
  let running = 0;
  for (const r of rows) {
    if (r.kind === "charge" && r.c.status !== "void") running += r.c.fee_cents;
    if (r.kind === "payment") running -= r.p.amount_cents;
    r.balance = running;
  }
  const bal = patientBalance(db, patient.id);
  const policies = insurance(db, patient.id);
  const queue = unchargedAppointments(db, { patientId: patient.id, limit: 20 });
  const writer = can(req.user, "billing:write");
  const back = `/ehr/patients/${patient.id}/billing`;
  const v = { amount: "", method: "card", reference: "", received_on: today(), note: "", ...values };

  if (status === 200) audit(req, "view", "charge", null, patient.id, "ledger");
  res.status(status).send(chartPage(req, patient, "billing", html`
    ${errorList(errors)}
    <div class="tiles">
      <div class="tile"><span class="tile__num">${money(bal.balance)}</span><span class="tile__label">Current balance${bal.balance < 0 ? " (credit)" : ""}</span></div>
      <div class="tile"><span class="tile__num">${money(bal.charges)}</span><span class="tile__label">Total charges (excl. void)</span></div>
      <div class="tile"><span class="tile__num">${money(bal.payments)}</span><span class="tile__label">Payments and credits</span></div>
    </div>
    <div class="grid--2 grid">
      <section class="card" aria-labelledby="ins-h">
        <h2 id="ins-h">Insurance on file</h2>
        ${policies.length ? html`<ul class="list">${policies.map((p) => html`
          <li><strong>${humanize(p.priority)}:</strong> ${p.payer_name} · Member ${p.member_id || "—"}${p.group_number ? ` · Group ${p.group_number}` : ""}${p.copay_cents != null ? ` · Copay ${money(p.copay_cents)}` : ""}</li>`)}</ul>`
          : html`<p class="muted">No active insurance. Charges default to patient responsibility.</p>`}
      </section>
      <section class="card" aria-labelledby="actions-h">
        <h2 id="actions-h">Actions</h2>
        <div class="row">
          ${writer ? html`<a class="btn btn--primary" href="/ehr/patients/${patient.id}/charges/new">Add charge</a>` : ""}
          ${writer ? html`<a class="btn" href="#record-payment">Record payment</a>` : ""}
        </div>
        <form method="get" action="/ehr/patients/${patient.id}/superbill" class="form-grid" style="margin-top:1rem">
          <label>Superbill from <input type="date" name="from" value="${addDays(today(), -30)}"></label>
          <label>To <input type="date" name="to" value="${today()}"></label>
          <div style="align-self:end"><button class="btn" type="submit">Superbill</button></div>
        </form>
      </section>
    </div>

    ${queue.length ? html`
      <section class="card" aria-labelledby="pq-h">
        <h2 id="pq-h">Completed visits without charges</h2>
        <ul class="list">${queue.map((a) => html`<li>${fmtDate(a.start_at)} · ${humanize(a.type)} · ${providerName(a)}
          ${writer ? html` <a class="btn btn--sm" href="/ehr/patients/${patient.id}/charges/new?appointment_id=${a.id}">Create charge</a>` : ""}</li>`)}</ul>
      </section>` : ""}

    <section class="card" aria-labelledby="ledger-h">
      <h2 id="ledger-h">Ledger</h2>
      ${rows.length ? html`
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Date</th><th>Item</th><th>Detail</th><th class="num">Charge</th><th class="num">Payment</th><th class="num">Balance</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${rows.map((r) => r.kind === "charge" ? html`
            <tr ${r.c.status === "void" ? raw('class="muted"') : ""}>
              <td>${fmtDate(r.date)}</td>
              <td>${r.c.cpt_code}${r.c.modifier ? `-${r.c.modifier}` : ""} ${r.c.description ? html`<span class="muted small">${r.c.description}</span>` : ""}</td>
              <td class="small">${r.c.units > 1 ? `${r.c.units} units · ` : ""}${r.c.diagnosis_codes || ""}${r.c.provider_name ? ` · ${providerName(r.c)}` : ""} · bill ${r.c.bill_to}</td>
              <td class="num">${r.c.status === "void" ? html`<s>${money(r.c.fee_cents)}</s>` : money(r.c.fee_cents)}</td>
              <td class="num"></td>
              <td class="num">${money(r.balance)}</td>
              <td>${badge(r.c.status)}</td>
              <td>${statusActions(req, r.c, back)}</td>
            </tr>` : html`
            <tr>
              <td>${fmtDate(r.date)}</td>
              <td>${METHOD_LABEL[r.p.method] || humanize(r.p.method)}</td>
              <td class="small">${r.p.reference ? `Ref ${r.p.reference}` : ""}${r.p.note ? ` · ${r.p.note}` : ""}</td>
              <td class="num"></td>
              <td class="num">${money(r.p.amount_cents)}</td>
              <td class="num">${money(r.balance)}</td>
              <td></td><td></td>
            </tr>`)}</tbody>
          <tfoot><tr><td colspan="5">Current balance</td><td class="num">${money(bal.balance)}</td><td colspan="2"></td></tr></tfoot>
        </table></div>` : html`<p class="muted">No charges or payments yet.</p>`}
    </section>

    ${writer ? html`
      <section class="card" id="record-payment" aria-labelledby="pay-h">
        <h2 id="pay-h">Record payment</h2>
        <form method="post" action="/ehr/patients/${patient.id}/payments">
          ${csrfField(req)}
          <div class="form-grid">
            <label>Amount ($) <input name="amount" value="${v.amount}" inputmode="decimal" required> ${fieldError(errors, "amount")}</label>
            <label>Method ${select("method", METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] })), v.method)} ${fieldError(errors, "method")}</label>
            <label>Reference <input name="reference" value="${v.reference}" maxlength="60" placeholder="Check # or transaction ID"> ${fieldError(errors, "reference")}</label>
            <label>Received on <input type="date" name="received_on" value="${v.received_on}" required> ${fieldError(errors, "received_on")}</label>
            <label class="span-all">Note <input name="note" value="${v.note}" maxlength="200"><span class="hint">Billing note only. Do not enter clinical information.</span></label>
          </div>
          <div class="form-actions"><button class="btn btn--primary" type="submit">Record payment</button></div>
        </form>
      </section>` : ""}`, { title: `Billing · ${patientName(patient)}` }));
}

router.get("/patients/:id/billing", read, (req, res) => {
  const patient = loadPatient(req, res);
  if (patient) ledgerPage(req, res, patient);
});

/* ---------------- payments ---------------- */
router.post("/patients/:id/payments", write, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const values = {
    amount: str(req.body.amount, 20), method: str(req.body.method, 20), reference: str(req.body.reference, 60),
    received_on: str(req.body.received_on, 10), note: str(req.body.note, 200),
  };
  const errors = {};
  const amount = parseMoney(values.amount);
  if (amount === null || amount <= 0) errors.amount = "Amount must be greater than $0.";
  else if (amount > 10000000) errors.amount = "Amount is too large.";
  if (!METHODS.includes(values.method)) errors.method = "Choose a payment method.";
  if (!validDate(values.received_on)) errors.received_on = "Enter a valid received date.";
  else if (values.received_on > today()) errors.received_on = "Received date cannot be in the future.";
  if (Object.keys(errors).length) return ledgerPage(req, res, patient, { errors, values, status: 400 });
  const id = Number(req.db.prepare(
    `INSERT INTO payments (patient_id, amount_cents, method, reference, received_on, note, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(patient.id, amount, values.method, values.reference || null, values.received_on, values.note || null, req.user.id).lastInsertRowid);
  audit(req, "create", "payment", id, patient.id, `method ${values.method}`);
  req.flash("success", `${values.method === "adjustment" ? "Adjustment" : "Payment"} of ${money(amount)} recorded.`);
  res.redirect(`/ehr/patients/${patient.id}/billing`);
});

/* ---------------- charges ---------------- */
function chargeForm(req, res, patient, { values = {}, errors = {}, appt = null, status = 200 } = {}) {
  const db = req.db;
  const fees = activeFees(db);
  const dx = activeDiagnoses(db, patient.id);
  const provs = providers(db);
  const existing = appt ? db.prepare("SELECT cpt_code, status FROM charges WHERE appointment_id = ? AND status != 'void'").all(appt.id) : [];
  const selectedDx = new Set(values.dx || []);
  const hasPolicy = insurance(db, patient.id).length > 0;
  const v = {
    appointment_id: appt ? appt.id : "", date_of_service: appt ? appt.start_at.slice(0, 10) : today(),
    rendering_provider_id: appt ? appt.clinician_id : (patient.primary_clinician_id || ""),
    cpt_code: suggestCpt(appt), units: "1", fee: "", modifier: appt && appt.modality === "telehealth" ? "95" : "",
    bill_to: hasPolicy ? "insurance" : "patient", dx_other: "", ...values,
  };
  const dxDefault = !values.dx && !values.dx_other; // first render: all active diagnoses checked

  res.status(status).send(chartPage(req, patient, "billing", html`
    <div class="page-head"><h2>New charge</h2><a class="btn btn--ghost" href="/ehr/patients/${patient.id}/billing">Cancel</a></div>
    ${errorList(errors)}
    ${appt ? html`<p class="alert alert--info">For the ${humanize(appt.type)} appointment on ${fmtDate(appt.start_at)}.</p>` : ""}
    ${existing.length ? html`<p class="alert alert--warn">This appointment already has charge(s): ${existing.map((c) => `${c.cpt_code} (${c.status})`).join(", ")}.</p>` : ""}
    <form class="card" method="post" action="/ehr/patients/${patient.id}/charges">
      ${csrfField(req)}
      ${v.appointment_id ? html`<input type="hidden" name="appointment_id" value="${v.appointment_id}">` : ""}
      <div class="form-grid">
        <label>Date of service <input type="date" name="date_of_service" value="${v.date_of_service}" required> ${fieldError(errors, "date_of_service")}</label>
        <label>CPT code ${select("cpt_code", [{ value: "", label: "Choose a code" }, ...fees.map((f) => ({ value: f.cpt_code, label: `${f.cpt_code} · ${f.description} · ${money(f.fee_cents)}` }))], v.cpt_code, "required")} ${fieldError(errors, "cpt_code")}</label>
        <label>Modifier <input name="modifier" value="${v.modifier}" maxlength="2" placeholder="e.g. 95"><span class="hint">95 = telehealth</span> ${fieldError(errors, "modifier")}</label>
        <label>Units <input type="number" name="units" min="1" max="10" value="${v.units}" required> ${fieldError(errors, "units")}</label>
        <label>Fee ($) <input name="fee" value="${v.fee}" inputmode="decimal" placeholder="Fee schedule × units"><span class="hint">Leave blank to use the fee schedule.</span> ${fieldError(errors, "fee")}</label>
        <label>Rendering provider ${select("rendering_provider_id", [{ value: "", label: "Choose a provider" }, ...provs.map((p) => ({ value: p.id, label: `${p.name}${p.credentials ? `, ${p.credentials}` : ""}${p.npi ? ` · NPI ${p.npi}` : ""}` }))], v.rendering_provider_id, "required")} ${fieldError(errors, "rendering_provider_id")}</label>
        <label>Bill to ${select("bill_to", [{ value: "insurance", label: "Insurance" }, { value: "patient", label: "Patient (self-pay)" }], v.bill_to)}</label>
      </div>
      <fieldset style="margin-top:1rem">
        <legend>Diagnosis codes</legend>
        ${dx.length ? dx.map((d) => html`
          <label class="check"><input type="checkbox" name="dx" value="${d.icd10_code}" ${dxDefault || selectedDx.has(d.icd10_code) ? raw("checked") : ""}>
            ${d.icd10_code} · ${d.description}${d.is_primary ? html` <span class="pill">Primary</span>` : ""}</label>`)
          : html`<p class="muted small">No active diagnoses on the problem list.</p>`}
        <label style="margin-top:.5rem">Other ICD-10 codes <input name="dx_other" value="${v.dx_other}" placeholder="e.g. F41.1, Z63.0"><span class="hint">Comma-separated. Used in addition to the codes checked above.</span> ${fieldError(errors, "dx")}</label>
      </fieldset>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Create charge</button></div>
    </form>`, { title: "New charge" }));
}

function loadAppt(db, patient, raw) {
  if (raw === undefined || raw === null || raw === "") return { appt: null };
  const id = toInt(raw);
  const appt = id ? db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) : null;
  if (!appt || appt.patient_id !== patient.id) return { error: "That appointment does not belong to this patient." };
  return { appt };
}

router.get("/patients/:id/charges/new", write, (req, res) => {
  const patient = loadPatient(req, res);
  if (!patient) return;
  const { appt, error } = loadAppt(req.db, patient, req.query.appointment_id);
  if (error) return chargeForm(req, res, patient, { errors: { appointment_id: error }, status: 400 });
  audit(req, "view", "charge", null, patient.id, "new charge form");
  chargeForm(req, res, patient, { appt });
});

router.post("/patients/:id/charges", write, (req, res) => {
  const db = req.db;
  const patient = loadPatient(req, res);
  if (!patient) return;
  const b = req.body;
  const dxChecked = [].concat(b.dx || []).map((x) => str(x, 10).toUpperCase()).filter(Boolean);
  const values = {
    date_of_service: str(b.date_of_service, 10), cpt_code: str(b.cpt_code, 10).toUpperCase(), modifier: str(b.modifier, 2).toUpperCase(),
    units: str(b.units, 4), fee: str(b.fee, 20), rendering_provider_id: str(b.rendering_provider_id, 10),
    bill_to: str(b.bill_to, 10), dx: dxChecked, dx_other: str(b.dx_other, 200),
  };
  const errors = {};
  const { appt, error: apptError } = loadAppt(db, patient, b.appointment_id);
  if (apptError) errors.appointment_id = apptError;
  if (appt) values.appointment_id = appt.id;

  if (!validDate(values.date_of_service)) errors.date_of_service = "Enter a valid date of service.";
  else if (values.date_of_service > today()) errors.date_of_service = "Date of service cannot be in the future.";
  const fee = CPT_RE.test(values.cpt_code) ? feeFor(db, values.cpt_code) : null;
  if (!fee) errors.cpt_code = "Choose a CPT code from the active fee schedule.";
  if (values.modifier && !MODIFIER_RE.test(values.modifier)) errors.modifier = "Modifier must be 2 letters or digits.";
  const units = toInt(values.units);
  if (!units || units < 1 || units > 10) errors.units = "Units must be between 1 and 10.";
  let feeCents = null;
  if (values.fee) {
    feeCents = parseMoney(values.fee);
    if (feeCents === null || feeCents < 0 || feeCents > 10000000) errors.fee = "Enter a valid fee, or leave blank to use the fee schedule.";
  } else if (fee && units) feeCents = fee.fee_cents * units;
  const provId = toInt(values.rendering_provider_id);
  const prov = provId ? db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role = 'clinician'").get(provId) : null;
  if (!prov) errors.rendering_provider_id = "Choose a rendering provider.";
  if (!["insurance", "patient"].includes(values.bill_to)) values.bill_to = "insurance";

  // Diagnosis codes: checked active diagnoses in problem-list order (primary first), then free text.
  const dxOrder = activeDiagnoses(db, patient.id).map((d) => d.icd10_code.toUpperCase());
  const checked = dxOrder.filter((c) => dxChecked.includes(c));
  const extra = values.dx_other.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const badDx = [...dxChecked.filter((c) => !dxOrder.includes(c)), ...extra.filter((c) => !ICD_RE.test(c))];
  if (badDx.length) errors.dx = `Not a valid ICD-10 code: ${badDx.join(", ")}`;
  const codes = [...new Set([...checked, ...extra])];
  if (!badDx.length && !codes.length) errors.dx = "Add at least one diagnosis code.";
  else if (codes.length > 12) errors.dx = "A charge can have at most 12 diagnosis codes.";

  if (Object.keys(errors).length) return chargeForm(req, res, patient, { values, errors, appt, status: 400 });

  const id = tx(db, () => {
    const r = db.prepare(
      `INSERT INTO charges (patient_id, appointment_id, date_of_service, cpt_code, modifier, units, fee_cents, diagnosis_codes,
        rendering_provider_id, bill_to, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unbilled', ?)`)
      .run(patient.id, appt ? appt.id : null, values.date_of_service, values.cpt_code, values.modifier || null, units, feeCents,
        codes.join(","), prov.id, values.bill_to, req.user.id);
    const newId = Number(r.lastInsertRowid);
    audit(req, "create", "charge", newId, patient.id, appt ? "from appointment" : "manual");
    return newId;
  });
  void id;
  req.flash("success", `Charge created for ${money(feeCents)}.`);
  res.redirect(`/ehr/patients/${patient.id}/billing`);
});

router.post("/charges/:chargeId/status", write, (req, res) => {
  const db = req.db;
  const id = toInt(req.params.chargeId);
  const charge = id ? db.prepare("SELECT * FROM charges WHERE id = ?").get(id) : null;
  if (!charge) return notFound(req, res, "Charge");
  const back = typeof req.body.back === "string" && /^\/ehr\/(billing|patients\/\d+\/billing)(\?[\w=&%.-]*)?$/.test(req.body.back)
    ? req.body.back : `/ehr/patients/${charge.patient_id}/billing`;
  const to = String(req.body.status || "");
  const bad = (msg) => res.status(400).send(page(req, {
    title: "Charge not updated", active: "billing",
    body: html`<div class="card"><h1>Charge not updated</h1><p>${msg}</p><p><a href="${back}">Go back</a></p></div>`,
  }));
  if (charge.status === "void") return bad("Voided charges cannot be changed.");
  if (!(TRANSITIONS[charge.status] || []).includes(to)) return bad(`A ${charge.status} charge cannot be marked ${humanize(to).toLowerCase() || "that status"}.`);
  if (to === "void" && req.body.confirm !== "yes") return bad("Voiding a charge requires confirmation.");
  const r = db.prepare("UPDATE charges SET status = ? WHERE id = ? AND status = ?").run(to, charge.id, charge.status);
  if (r.changes !== 1) return bad("The charge changed while you were working. Reload and try again.");
  audit(req, to === "void" ? "void" : "update", "charge", charge.id, charge.patient_id, `status ${charge.status} -> ${to}`);
  req.flash("success", `Charge ${to === "void" ? "voided" : `marked ${to}`}.`);
  res.redirect(back);
});

/* ---------------- superbill ---------------- */
router.get("/patients/:id/superbill", read, (req, res) => {
  const db = req.db;
  const patient = loadPatient(req, res);
  if (!patient) return;
  let from = validDate(req.query.from) ? req.query.from : addDays(today(), -30);
  let to = validDate(req.query.to) ? req.query.to : today();
  if (from > to) [from, to] = [to, from];

  const services = db.prepare(
    `SELECT c.*, f.description, u.name AS provider_name, u.credentials AS provider_credentials, u.npi AS provider_npi
     FROM charges c LEFT JOIN fee_schedule f ON f.cpt_code = c.cpt_code LEFT JOIN users u ON u.id = c.rendering_provider_id
     WHERE c.patient_id = ? AND c.status != 'void' AND c.date_of_service BETWEEN ? AND ?
     ORDER BY c.date_of_service, c.id`).all(patient.id, from, to);
  const payments = db.prepare("SELECT * FROM payments WHERE patient_id = ? AND received_on BETWEEN ? AND ? ORDER BY received_on, id").all(patient.id, from, to);
  const policies = insurance(db, patient.id);
  const dxDesc = new Map(db.prepare("SELECT icd10_code, description FROM diagnoses WHERE patient_id = ?").all(patient.id).map((d) => [d.icd10_code.toUpperCase(), d.description]));
  const allDx = [...new Set(services.flatMap((s) => String(s.diagnosis_codes || "").split(",").map((x) => x.trim()).filter(Boolean)))];
  const totalCharges = services.reduce((a, s) => a + s.fee_cents, 0);
  const totalPaid = payments.reduce((a, p) => a + p.amount_cents, 0);

  audit(req, "view", "superbill", null, patient.id, `period ${from} to ${to}`);
  const addr = [patient.address_line1, patient.address_line2].filter(Boolean).join(", ");
  const cityLine = [patient.city, [patient.state, patient.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  res.send(page(req, {
    title: "Superbill",
    active: "billing",
    body: html`
      <div class="page-head no-print">
        <a class="btn btn--ghost" href="/ehr/patients/${patient.id}/billing">Back to billing</a>
        <form method="get" action="/ehr/patients/${patient.id}/superbill" class="row">
          <label>From <input type="date" name="from" value="${from}"></label>
          <label>To <input type="date" name="to" value="${to}"></label>
          <button class="btn" type="submit">Update</button>
          <button class="btn btn--primary" type="button" data-print>Print superbill</button>
        </form>
      </div>
      <article class="card superbill">
        <header class="row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1 style="margin:0">${PRACTICE.name}</h1>
            <p class="small" style="margin:.25rem 0 0">${PRACTICE.address}<br>Phone ${PRACTICE.phone}<br>Group NPI ${PRACTICE.npi} · Tax ID ${PRACTICE.taxId}</p>
          </div>
          <div style="text-align:right">
            <h2 style="margin:0">Superbill</h2>
            <p class="small" style="margin:.25rem 0 0">Statement of services<br>${fmtDate(from)} – ${fmtDate(to)}<br>Issued ${fmtDate(today())}</p>
          </div>
        </header>
        <hr>
        <div class="grid grid--2">
          <section>
            <h3>Patient</h3>
            <p class="small">
              <strong>${patient.first_name} ${patient.last_name}</strong><br>
              DOB ${fmtDate(patient.dob)} · MRN ${patient.mrn}<br>
              ${addr ? html`${addr}<br>` : ""}${cityLine ? html`${cityLine}<br>` : ""}
              ${patient.phone ? html`Phone ${patient.phone}` : ""}
            </p>
          </section>
          <section>
            <h3>Insurance</h3>
            ${policies.length ? policies.map((p) => html`<p class="small"><strong>${humanize(p.priority)}:</strong> ${p.payer_name}<br>
              Member ID ${p.member_id || "—"}${p.group_number ? ` · Group ${p.group_number}` : ""}<br>
              Subscriber ${p.subscriber_name || "—"}${p.subscriber_relation ? ` (${p.subscriber_relation})` : ""}</p>`)
              : html`<p class="small">No insurance on file (self-pay).</p>`}
          </section>
        </div>
        ${allDx.length ? html`
          <section>
            <h3>Diagnoses (ICD-10)</h3>
            <ol class="small">${allDx.map((c) => html`<li>${c}${dxDesc.get(c.toUpperCase()) ? ` · ${dxDesc.get(c.toUpperCase())}` : ""}</li>`)}</ol>
          </section>` : ""}
        <section>
          <h3>Services</h3>
          ${services.length ? html`
            <div class="table-wrap"><table class="table">
              <thead><tr><th>DOS</th><th>CPT</th><th>Description</th><th>ICD-10</th><th class="num">Units</th><th class="num">Fee</th><th>Rendering provider</th></tr></thead>
              <tbody>${services.map((s) => html`
                <tr>
                  <td>${s.date_of_service}</td>
                  <td>${s.cpt_code}${s.modifier ? `-${s.modifier}` : ""}</td>
                  <td>${s.description || ""}</td>
                  <td>${String(s.diagnosis_codes || "").split(",").join(", ")}</td>
                  <td class="num">${s.units}</td>
                  <td class="num">${money(s.fee_cents)}</td>
                  <td>${providerName(s)}${s.provider_npi ? html`<br><span class="small">NPI ${s.provider_npi}</span>` : ""}</td>
                </tr>`)}</tbody>
              <tfoot><tr><td colspan="5">Total charges</td><td class="num">${money(totalCharges)}</td><td></td></tr></tfoot>
            </table></div>` : html`<p class="muted">No services in this period.</p>`}
        </section>
        <section>
          <h3>Payments received</h3>
          ${payments.length ? html`
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead>
              <tbody>${payments.map((p) => html`<tr><td>${p.received_on}</td><td>${METHOD_LABEL[p.method] || p.method}</td><td>${p.reference || ""}</td><td class="num">${money(p.amount_cents)}</td></tr>`)}</tbody>
              <tfoot><tr><td colspan="3">Total payments</td><td class="num">${money(totalPaid)}</td></tr></tfoot>
            </table></div>` : html`<p class="muted small">No payments received in this period.</p>`}
          <p><strong>Balance for period: ${money(totalCharges - totalPaid)}</strong></p>
        </section>
        <p class="small muted">Provided for the patient to submit to their insurance for possible reimbursement. Payment status with the payer is not guaranteed.</p>
        <p class="small" style="margin-top:2rem">Provider signature: ____________________________ Date: ____________</p>
      </article>`,
  }));
});

module.exports = { router };
