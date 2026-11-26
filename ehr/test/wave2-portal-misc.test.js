"use strict";
// Wave 2 dropdowns: portal appointment preferences, staff message templates, records "Released to", picture kinds,
// note-scanner quick picks, and the website form's insurance and main-concern menus.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start } = require("./helpers");
const portal = require("../src/routes/portal");
const requests = require("../src/routes/requests");
const ai = require("../src/ai-review");
const { buildContext } = require("../src/routes/scan");
const O = require("../src/options");

let t, pid, b, lastReq = null;
const PW = "Portal-Pass-2026!";
const STAFF_PW = "Test-Password-123!";

/** A browser for the portal: keeps the portal_sid cookie and the last CSRF token (as in portal.test.js). */
function browser() {
  let cookie = "", csrf = "";
  async function request(method, p, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) v.forEach((x) => params.append(k, x)); else if (v !== undefined) params.append(k, String(v));
      }
      if (csrf && !params.has("_csrf")) params.append("_csrf", csrf);
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = params.toString();
    }
    const res = await fetch(t.base + p, { method, headers, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); if (pair.startsWith("portal_sid=")) cookie = pair.endsWith("=") ? "" : pair; }
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, text, location: res.headers.get("location") };
  }
  return { get: (p) => request("GET", p), post: (p, body = {}) => request("POST", p, body) };
}

before(async () => {
  t = await start();
  pid = t.ctx.patients[3];
  ai.setClient({ beta: { messages: { create: async (body) => {
    lastReq = body;
    return { stop_reason: "end_turn", model: "claude-test", content: [{ type: "text", text: JSON.stringify({ summary: "Looks fine.", findings: [] }) }] };
  } } } });
  // Portal account for pid
  const fd = await t.login("frontdesk");
  const inv = await fd.post(`/ehr/patients/${pid}/portal/invite`);
  const inviteUrl = inv.text.match(/value="(http[^"]+\/portal\/invite\/[A-Za-z0-9_-]+)"/)[1];
  b = browser();
  const p = new URL(inviteUrl).pathname;
  await b.get(p);
  const dob = t.db.prepare("SELECT dob FROM patients WHERE id = ?").get(pid).dob;
  portal.resetPortalRateLimit();
  const r = await b.post(p, { dob, email: "wave2-client@example.com", password: PW, confirm: PW, agree: "1" });
  assert.equal(r.status, 302);
  await b.get("/portal");
});
after(async () => { ai.setClient(null); await t.stop(); });

/* ---------------- 1. Portal appointment preferences ---------------- */

test("portal: new message shows appointment day/time/visit fields; chosen ones are appended to the body", async () => {
  const form = await b.get("/portal/messages/new");
  assert.match(form.text, /If you(&#39;|')re asking about an appointment/);
  for (const d of O.APPT_DAYS) assert.match(form.text, new RegExp(`name="appt_days" value="${d}"`));
  assert.match(form.text, /name="appt_times" value="Mornings \(8-12\)"/);
  assert.match(form.text, /<select id="visit_pref" name="visit_pref"/);
  assert.match(form.text, /Video \(telehealth\)/);
  assert.match((await b.get("/portal/messages/new?topic=appointment")).text, /<option value="appointment" selected>/);

  let r = await b.post("/portal/messages", { topic: "appointment", subject: "", body: "Can I come in next week?",
    appt_days: ["Monday", "Wednesday", "Funday"], appt_times: "Mornings (8-12)", visit_pref: "Video (telehealth)" });
  assert.equal(r.status, 302);
  let msg = t.db.prepare("SELECT subject, body FROM portal_messages WHERE id = ?").get(Number(r.location.split("/").pop()));
  assert.equal(msg.subject, "Appointment request or change");
  assert.equal(msg.body, "Can I come in next week?\n\nDays: Monday, Wednesday · Times: Mornings (8-12) · Visit: Video (telehealth)");

  // Nothing chosen: body unchanged. Bad visit type ignored.
  r = await b.post("/portal/messages", { topic: "clinician", subject: "", body: "Just a question.", visit_pref: "Teleport" });
  msg = t.db.prepare("SELECT body FROM portal_messages WHERE id = ?").get(Number(r.location.split("/").pop()));
  assert.equal(msg.body, "Just a question.");
});

/* ---------------- 2. Staff template ---------------- */

test("staff: new message template fills a blank subject; a typed subject wins; neither is an error", async () => {
  const th = await t.login("therapist");
  const tab = await th.get(`/ehr/patients/${pid}/portal`);
  assert.match(tab.text, /<select id="template" name="template"/);
  assert.match(tab.text, /Forms to complete/);
  const last = () => t.db.prepare("SELECT subject, body FROM portal_messages WHERE patient_id = ? AND from_patient = 0 ORDER BY id DESC").get(pid);

  let r = await th.post(`/ehr/patients/${pid}/portal/messages`, { template: "Forms to complete", subject: "", body: "Please fill these in." });
  assert.equal(r.status, 302);
  assert.equal(last().subject, "Forms to complete");
  await th.post(`/ehr/patients/${pid}/portal/messages`, { template: "Billing notice", subject: "Your statement", body: "See attached." });
  assert.equal(last().subject, "Your statement");
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM portal_messages WHERE patient_id = ?").get(pid).n;
  await th.post(`/ehr/patients/${pid}/portal/messages`, { template: "Not a template", subject: "", body: "Hi" });
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM portal_messages WHERE patient_id = ?").get(pid).n, n, "no subject, no message");
});

/* ---------------- 3. Records: Released to ---------------- */

test("records: Released to is a dropdown with Other; listed and typed values go into the disclosure", async () => {
  const c = await t.login("therapist");
  const p = t.ctx.patients[1];
  const pageRes = await c.get(`/ehr/patients/${p}/records`);
  assert.match(pageRes.text, /<select id="released_to" name="released_to"/);
  assert.match(pageRes.text, /Personal representative \/ guardian/);
  assert.match(pageRes.text, /name="released_to_other"/);
  const base = { password: STAFF_PW, format: "html", sections: ["demographics"], released: "1", released_method: "" };
  const recipient = () => t.db.prepare("SELECT recipient FROM disclosures WHERE patient_id = ? ORDER BY id DESC").get(p).recipient;
  let r = await c.post(`/ehr/patients/${p}/records/export`, { ...base, released_to: "Attorney" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(recipient(), "Attorney");
  await c.post(`/ehr/patients/${p}/records/export`, { ...base, released_to: "__other", released_to_other: "Sister (Jane Roe)" });
  assert.equal(recipient(), "Sister (Jane Roe)");
  await c.post(`/ehr/patients/${p}/records/export`, { ...base, released_to: "" });
  assert.equal(recipient(), "Patient");
});

/* ---------------- 4. Picture kinds ---------------- */

test("photos: new picture kinds are offered, saved (as 'other' + caption) and shown with their label", async () => {
  const c = await t.login("therapist");
  const p = t.ctx.patients[2];
  const pageRes = await c.get(`/ehr/patients/${p}/photos`);
  for (const l of ["Wound / injection site", "Consent or signed document", "Pharmacy or lab label", "Insurance card (front)"]) assert.ok(pageRes.text.includes(l), l);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]).toString("base64");
  const img = `data:image/jpeg;base64,${JPEG}`;
  let r = await c.post(`/ehr/patients/${p}/photos`, { category: "wound", caption: "Left deltoid", image_data: img });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  await c.post(`/ehr/patients/${p}/photos`, { category: "rx_label", caption: "", image_data: img });
  await c.post(`/ehr/patients/${p}/photos`, { category: "insurance_back", caption: "", image_data: img });
  const rows = t.db.prepare("SELECT category, caption FROM patient_images WHERE patient_id = ? ORDER BY id").all(p);
  assert.deepEqual(rows.map((x) => [x.category, x.caption]), [["other", "Wound / injection site: Left deltoid"], ["other", "Pharmacy or lab label"], ["insurance_back", null]]);
  const gallery = await c.get(`/ehr/patients/${p}/photos`);
  assert.match(gallery.text, /<strong>Wound \/ injection site<\/strong>/);
  assert.match(gallery.text, /<p>Left deltoid<\/p>/);
  assert.match(gallery.text, /<strong>Pharmacy or lab label<\/strong>/);
  assert.match(gallery.text, /<strong>Insurance card \(back\)<\/strong>/);
  r = await c.post(`/ehr/patients/${p}/photos`, { category: "selfie", image_data: img });
  assert.equal(r.status, 400);
});

/* ---------------- 5. Scanner quick picks ---------------- */

test("scan: quick-pick checkboxes are prepended to the context sent for review", async () => {
  const c = await t.login("therapist");
  const form = await c.get("/ehr/scan");
  for (const x of ["Telehealth", "Group session", "Family session", "Crisis", "CPT 90791", "CPT 90832", "CPT 90834", "CPT 90837"]) {
    assert.match(form.text, new RegExp(`name="context_pick" value="${x}"`), x);
  }
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF\n");
  const r = await c.post("/ehr/scan", { pdf_data: `data:application/pdf;base64,${PDF.toString("base64")}`, payer: "commercial",
    context_pick: ["Telehealth", "CPT 90837", "bogus"], context: "Client in car" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(lastReq.messages[0].content[1].text, /Telehealth; CPT 90837; Client in car/);
  assert.doesNotMatch(lastReq.messages[0].content[1].text, /bogus/);
  assert.match(r.text, /value="Telehealth" checked/);
  assert.equal(buildContext([], " typed "), "typed");
  assert.equal(buildContext("Crisis", ""), "Crisis");
});

/* ---------------- 6. Website form ---------------- */

beforeEach(() => requests.__resetRateLimit());
const valid = (extra = {}) => ({
  first_name: "Riley", last_name: "Wave", date_of_birth: "1991-02-03", phone: "(555) 010-4002", email: "riley.wave@example.com",
  contact_method: "phone", voicemail_ok: "yes", care_for: "myself", service: "individual-therapy", visit_preference: "telehealth",
  insurance_provider: "Mercy Care", referral_source: "search", reason: "Hoping to start soon.", consent: "yes", website: "", ...extra,
});
const latest = () => t.db.prepare("SELECT * FROM appointment_requests ORDER BY id DESC").get();

test("contact.html: insurance is a payer dropdown with Not sure / Other; main concern dropdown", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "..", "contact.html"), "utf8");
  assert.match(page, /<select id="insurance" name="insurance_provider"/);
  assert.match(page, /name="insurance_other"/);
  assert.match(page, /<select id="main-concern" name="main_concern"/);
  for (const [, items] of O.PAYERS) for (const i of items) assert.ok(page.includes(`<option value="${i}">`), i);
  for (const v of ["Not sure", "Other", ...O.MAIN_CONCERNS]) assert.ok(page.includes(`<option value="${v}">`), v);
});

test("website request: insurance (listed / Other typed) and main concern are stored and shown to staff", async () => {
  let r = await t.client().post("/api/appointment-requests", valid({ main_concern: "Trauma / PTSD" }), { json: true });
  assert.equal(r.status, 201, r.text);
  let row = latest();
  assert.equal(row.insurance, "Mercy Care");
  assert.equal(row.reason, "Hoping to start soon.\n\nMain concern: Trauma / PTSD");

  r = await t.client().post("/api/appointment-requests", valid({ insurance_provider: "Other", insurance_other: "Small Town Health Co-op", reason: "", main_concern: "ADHD / focus" }), { json: true });
  assert.equal(r.status, 201);
  row = latest();
  assert.equal(row.insurance, "Small Town Health Co-op");
  assert.equal(row.reason, "Main concern: ADHD / focus");

  r = await t.client().post("/api/appointment-requests", valid({ insurance_provider: "Other", insurance_other: "" }), { json: true });
  assert.equal(latest().insurance, "Other");
  r = await t.client().post("/api/appointment-requests", valid({ insurance_provider: "Not sure" }), { json: true });
  assert.equal(latest().insurance, "Not sure");

  r = await t.client().post("/api/appointment-requests", valid({ main_concern: "Aliens" }), { json: true });
  assert.equal(r.status, 400);
  assert.ok(JSON.parse(r.text).fields.main_concern);

  const fd = await t.login("frontdesk");
  const withConcern = t.db.prepare("SELECT id FROM appointment_requests WHERE reason LIKE '%Trauma / PTSD'").get().id;
  const view = await fd.get(`/ehr/requests/${withConcern}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /Main concern<\/th><td>Trauma \/ PTSD/);
  assert.match(view.text, /Insurance<\/th><td>Mercy Care/);
  assert.match(view.text, /<div class="prewrap">Hoping to start soon.<\/div>/);
});
