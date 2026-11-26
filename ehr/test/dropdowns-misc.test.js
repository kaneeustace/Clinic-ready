"use strict";
// Dropdowns on the schedule (cancel reason), hormone-therapy stock, disclosures and the portal message topic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today, addDays } = require("../src/views");
const mailer = require("../src/mailer");
const portal = require("../src/routes/portal");

let t, pid;
const PW = "Portal-Pass-2026!";
const sent = [];
before(async () => {
  t = await start();
  pid = t.ctx.patients[3];
  mailer.setTestTransport((m) => { sent.push(m); });
});
after(async () => { mailer.setTestTransport(null); await t.stop(); });

/* ---------------- Schedule: cancellation reason ---------------- */

function apptForm(overrides = {}) {
  return { patient_id: t.ctx.patients[0], clinician_id: t.ctx.users.therapist, date: addDays(today(), 70), time: "10:00", duration: "50",
    type: "therapy", modality: "in_person", location: "Office 2", telehealth_url: "", notes: "", repeat_weeks: "1", ...overrides };
}

test("schedule: cancellation reason is a dropdown; listed and typed-in (Other) reasons are saved", async () => {
  const c = await t.login("frontdesk");
  const a1 = Number((await c.post("/ehr/schedule", apptForm({ time: "09:00" }))).location.split("/").pop());
  const a2 = Number((await c.post("/ehr/schedule", apptForm({ time: "13:00" }))).location.split("/").pop());
  const detail = await c.get(`/ehr/appointments/${a1}`);
  assert.match(detail.text, /<select id="reason" name="reason"/);
  assert.match(detail.text, /Client illness/);
  assert.match(detail.text, /name="reason_other"/);
  const st = (id) => t.db.prepare("SELECT status, notes FROM appointments WHERE id = ?").get(id);

  // Still required when cancelling
  await c.post(`/ehr/appointments/${a1}/status`, { status: "cancelled", reason: "" });
  assert.equal(st(a1).status, "scheduled");
  await c.post(`/ehr/appointments/${a1}/status`, { status: "cancelled", reason: "__other", reason_other: "" });
  assert.equal(st(a1).status, "scheduled");

  let r = await c.post(`/ehr/appointments/${a1}/status`, { status: "cancelled", reason: "Transportation" });
  assert.equal(r.status, 302);
  assert.equal(st(a1).status, "cancelled");
  assert.match(st(a1).notes, /Cancelled .*\] Transportation$/);

  r = await c.post(`/ehr/appointments/${a2}/status`, { status: "late_cancel", reason: "__other", reason_other: "Pet emergency" });
  assert.equal(st(a2).status, "late_cancel");
  assert.match(st(a2).notes, /Late cancel .*\] Pet emergency$/);
});

/* ---------------- Hormone therapy stock ---------------- */

test("trt stock: product dropdown fills the strength; waste and correction reasons are dropdowns", async () => {
  t.db.prepare("UPDATE clinic_settings SET trt_enabled = 1 WHERE id = 1").run();
  const c = await t.login("therapist");
  const inv = await c.get("/ehr/trt/inventory");
  assert.equal(inv.status, 200);
  assert.match(inv.text, /<select id="product" name="product" required/);
  assert.match(inv.text, /Testosterone cypionate 100 mg\/mL \(10 mL vial\)/);
  assert.match(inv.text, /<select id="waste_reason" name="reason" required/);
  assert.match(inv.text, /Partial dose left over/);

  // Listed product, strength left blank -> the product's strength
  const product = "Testosterone cypionate 100 mg/mL (10 mL vial)";
  let r = await c.post("/ehr/trt/inventory/lots", { product, lot_number: "DD100", expiration: addDays(today(), 300), concentration_mg_ml: "", quantity_ml: "10", received_on: today() });
  assert.equal(r.status, 302);
  const lot = t.db.prepare("SELECT * FROM trt_lots WHERE lot_number = 'DD100'").get();
  assert.equal(lot.product, product);
  assert.equal(lot.concentration_mg_ml, 100);

  // Other product, typed in; strength then required
  r = await c.post("/ehr/trt/inventory/lots", { product: "__other", product_other: "Compounded testosterone 150 mg/mL", lot_number: "CX1", expiration: addDays(today(), 300), concentration_mg_ml: "", quantity_ml: "5", received_on: today() });
  assert.equal(r.status, 400);
  r = await c.post("/ehr/trt/inventory/lots", { product: "__other", product_other: "Compounded testosterone 150 mg/mL", lot_number: "CX1", expiration: addDays(today(), 300), concentration_mg_ml: "150", quantity_ml: "5", received_on: today() });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT product FROM trt_lots WHERE lot_number = 'CX1'").get().product, "Compounded testosterone 150 mg/mL");

  // Waste: reason required, listed reason saved
  r = await c.post("/ehr/trt/inventory/waste", { lot_id: String(lot.id), quantity_ml: "1", witness_id: String(t.ctx.users.prescriber), reason: "" });
  assert.equal(r.status, 400);
  assert.match(r.text, /Say why it was wasted/);
  r = await c.post("/ehr/trt/inventory/waste", { lot_id: String(lot.id), quantity_ml: "1", witness_id: String(t.ctx.users.prescriber), reason: "Damaged / dropped / broken vial" });
  assert.equal(r.status, 302);
  const w = t.db.prepare("SELECT * FROM trt_ledger WHERE lot_id = ? AND event = 'wasted'").get(lot.id);
  assert.equal(w.reason, "Damaged / dropped / broken vial");

  // Count correction (administrator), Other reason
  const admin = await t.login("admin");
  assert.match((await admin.get("/ehr/trt/inventory")).text, /<select id="adjust_reason" name="reason" required/);
  r = await admin.post("/ehr/trt/inventory/adjust", { lot_id: String(lot.id), quantity_ml: "-0.5", reason: "" });
  assert.equal(r.status, 400);
  r = await admin.post("/ehr/trt/inventory/adjust", { lot_id: String(lot.id), quantity_ml: "-0.5", reason: "__other", reason_other: "Vial cracked in fridge" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT reason FROM trt_ledger WHERE lot_id = ? AND event = 'adjustment'").get(lot.id).reason, "Vial cracked in fridge");
});

/* ---------------- Disclosures ---------------- */

test("disclosure purpose is a dropdown (Other typed in), still required", async () => {
  const c = await t.login("therapist");
  const p = t.ctx.patients[1];
  const pageRes = await c.get(`/ehr/patients/${p}/disclosures`);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /<select id="purpose" name="purpose" required/);
  assert.match(pageRes.text, /Treatment \/ coordination of care/);
  const base = { disclosed_on: addDays(today(), -1), recipient: "County Health Dept", description: "Diagnosis and dates of service", basis: "public_health", method: "fax" };
  const count = () => t.db.prepare("SELECT COUNT(*) AS n FROM disclosures WHERE patient_id = ?").get(p).n;
  const n0 = count();
  let r = await c.post(`/ehr/patients/${p}/disclosures`, { ...base, purpose: "" });
  assert.equal(count(), n0, "purpose required");
  r = await c.post(`/ehr/patients/${p}/disclosures`, { ...base, purpose: "Public health" });
  assert.ok([200, 302].includes(r.status));
  assert.equal(t.db.prepare("SELECT purpose FROM disclosures WHERE patient_id = ? ORDER BY id DESC").get(p).purpose, "Public health");
  r = await c.post(`/ehr/patients/${p}/disclosures`, { ...base, purpose: "__other", purpose_other: "Grant reporting" });
  assert.equal(t.db.prepare("SELECT purpose FROM disclosures WHERE patient_id = ? ORDER BY id DESC").get(p).purpose, "Grant reporting");
});

/* ---------------- Portal message topic ---------------- */

/** A browser for the portal: keeps the portal_sid cookie and the last CSRF token (as in portal.test.js). */
function browser() {
  let cookie = "", csrf = "";
  async function request(method, path, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) if (v !== undefined) params.append(k, String(v));
      if (csrf && !params.has("_csrf")) params.append("_csrf", csrf);
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = params.toString();
    }
    const res = await fetch(t.base + path, { method, headers, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); if (pair.startsWith("portal_sid=")) cookie = pair.endsWith("=") ? "" : pair; }
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, text, location: res.headers.get("location") };
  }
  return { get: (p) => request("GET", p), post: (p, b = {}) => request("POST", p, b) };
}

test("portal: new message needs a topic; ?topic= pre-selects it; blank subject uses the topic; medication goes to prescribers", async () => {
  // Invite and sign up
  const fd = await t.login("frontdesk");
  const inv = await fd.post(`/ehr/patients/${pid}/portal/invite`);
  const inviteUrl = inv.text.match(/value="(http[^"]+\/portal\/invite\/[A-Za-z0-9_-]+)"/)[1];
  const b = browser();
  const path = new URL(inviteUrl).pathname;
  await b.get(path);
  const dob = t.db.prepare("SELECT dob FROM patients WHERE id = ?").get(pid).dob;
  portal.resetPortalRateLimit();
  let r = await b.post(path, { dob, email: "dropdown-client@example.com", password: PW, confirm: PW, agree: "1" });
  assert.equal(r.status, 302);
  await b.get("/portal");

  let form = await b.get("/portal/messages/new");
  assert.match(form.text, /<select id="topic" name="topic" required/);
  assert.match(form.text, /Medication or refill question/);
  form = await b.get("/portal/messages/new?topic=medication");
  assert.match(form.text, /<option value="medication" selected>/);

  const count = () => t.db.prepare("SELECT COUNT(*) AS n FROM portal_messages WHERE patient_id = ?").get(pid).n;
  const n0 = count();
  r = await b.post("/portal/messages", { topic: "", subject: "", body: "Hello" });
  assert.equal(count(), n0, "topic required");
  r = await b.post("/portal/messages", { topic: "bogus", subject: "", body: "Hello" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/portal/messages/new");
  assert.equal(count(), n0, "invalid topic rejected");

  // Medication question: the client's prescriber hears about it (PHI-free), plus the primary clinician.
  t.db.prepare("UPDATE users SET can_prescribe = 1, digest_email = 1 WHERE id = ?").run(t.ctx.users.prescriber);
  t.db.prepare(`INSERT INTO prescriptions (patient_id, prescriber_id, drug, sig, quantity, quantity_unit, delivery, written_on)
    VALUES (?, ?, 'Sertraline 50 mg', 'Take 1 daily', 30, 'tablet', 'print', ?)`).run(pid, t.ctx.users.prescriber, today());
  const prescriberEmail = t.db.prepare("SELECT email FROM users WHERE id = ?").get(t.ctx.users.prescriber).email;
  sent.length = 0;
  r = await b.post("/portal/messages", { topic: "medication", subject: "", body: "I need a refill of my sertraline." });
  assert.equal(r.status, 302);
  const id = Number(r.location.split("/").pop());
  assert.equal(t.db.prepare("SELECT subject FROM portal_messages WHERE id = ?").get(id).subject, "Medication or refill question");
  assert.ok(sent.some((m) => m.to === prescriberEmail), "prescriber notified");
  for (const m of sent) assert.doesNotMatch(m.text + m.html + m.subject, /sertraline|refill|Medication/i, "no PHI in staff email");

  // Typed subject keeps the topic in front; the staff inbox shows it.
  r = await b.post("/portal/messages", { topic: "billing", subject: "Copay amount", body: "What is my copay?" });
  const id2 = Number(r.location.split("/").pop());
  assert.equal(t.db.prepare("SELECT subject FROM portal_messages WHERE id = ?").get(id2).subject, "Billing or insurance: Copay amount");
  const inbox = await fd.get("/ehr/messages?who=all");
  assert.match(inbox.text, /Billing or insurance: Copay amount/);
  assert.match(inbox.text, /Medication or refill question/);
});
