"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const requests = require("../src/routes/requests");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });
beforeEach(() => requests.__resetRateLimit());

const valid = (extra = {}) => ({
  first_name: "  Avery ", last_name: "Fixture", preferred_name: "", date_of_birth: "1990-05-06",
  phone: "(555) 010-3001", email: "avery.fixture@example.com", contact_method: "text", voicemail_ok: "yes",
  care_for: "myself", service: "individual-therapy", visit_preference: "in-person", insurance_provider: "Demo Plan",
  referral_source: "search", reason: "Testing the form.", consent: "yes", website: "", ...extra,
});
const latest = () => t.db.prepare("SELECT * FROM appointment_requests ORDER BY id DESC").get();
const count = () => t.db.prepare("SELECT COUNT(*) AS n FROM appointment_requests").get().n;

test("public JSON submit stores a mapped, trimmed request", async () => {
  const r = await t.client().post("/api/appointment-requests", valid({ last_name: "JsonCase" }), { json: true });
  assert.equal(r.status, 201);
  assert.deepEqual(JSON.parse(r.text), { ok: true });
  assert.doesNotMatch(r.text, /Avery|JsonCase/);
  const row = latest();
  assert.equal(row.first_name, "Avery");
  assert.equal(row.last_name, "JsonCase");
  assert.equal(row.dob, "1990-05-06");
  assert.equal(row.ok_voicemail, "yes");
  assert.equal(row.insurance, "Demo Plan");
  assert.equal(row.service, "individual_therapy");
  assert.equal(row.visit_preference, "in_person");
  assert.equal(row.preferred_name, null);
  assert.equal(row.status, "new");
  assert.ok(row.ip);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("public urlencoded HTML form post redirects 303", async () => {
  const r = await t.client().request("POST", "/api/appointment-requests", valid({ last_name: "FormCase" }),
    { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/contact.html?submitted=1");
  assert.equal(latest().last_name, "FormCase");
});

test("urlencoded fetch without HTML accept gets JSON", async () => {
  const r = await t.client().post("/api/appointment-requests", valid({ email: "" }));
  assert.equal(r.status, 201);
});

test("validation errors return 400 with field messages and store nothing", async () => {
  const before = count();
  const cases = [
    [{ first_name: "" }, "first_name"],
    [{ last_name: "x".repeat(101) }, "last_name"],
    [{ phone: "", email: "" }, "phone"],
    [{ email: "not-an-email" }, "email"],
    [{ consent: "" }, "consent"],
    [{ reason: "x".repeat(1001) }, "reason"],
    [{ service: "brain-surgery" }, "service"],
    [{ date_of_birth: "2999-01-01" }, "dob"],
  ];
  for (const [extra, field] of cases) {
    const body = valid(extra);
    if (extra.consent === "") delete body.consent;
    const r = await t.client().post("/api/appointment-requests", body, { json: true });
    requests.__resetRateLimit();
    assert.equal(r.status, 400, field);
    const j = JSON.parse(r.text);
    assert.equal(j.error, "validation");
    assert.ok(j.fields[field], `expected error for ${field}`);
    assert.doesNotMatch(r.text, /Avery/);
  }
  assert.equal(count(), before);
});

test("email only (no phone) is accepted", async () => {
  const r = await t.client().post("/api/appointment-requests", valid({ phone: "" }), { json: true });
  assert.equal(r.status, 201);
});

test("honeypot returns 200 ok and stores nothing", async () => {
  const before = count();
  const r = await t.client().post("/api/appointment-requests", valid({ website: "http://spam.example" }), { json: true });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { ok: true });
  assert.equal(count(), before);
});

test("rate limit: 6th submission in 10 minutes gets 429", async () => {
  const c = t.client();
  for (let i = 0; i < 5; i++) {
    const r = await c.post("/api/appointment-requests", valid(), { json: true });
    assert.equal(r.status, 201);
  }
  const r = await c.post("/api/appointment-requests", valid(), { json: true });
  assert.equal(r.status, 429);
  assert.deepEqual(JSON.parse(r.text), { error: "rate_limited" });
  requests.__resetRateLimit();
  assert.equal((await c.post("/api/appointment-requests", valid(), { json: true })).status, 201);
});

test("inbox requires login and the requests:manage permission", async () => {
  const anon = await t.client().get("/ehr/requests");
  assert.equal(anon.status, 302);
  assert.match(anon.location, /^\/ehr\/login/);
  for (const key of ["billing", "therapist"]) {
    const c = await t.login(key);
    assert.equal((await c.get("/ehr/requests")).status, 403, key);
    const id = latest().id;
    assert.equal((await c.get(`/ehr/requests/${id}`)).status, 403, key);
    assert.equal((await c.post(`/ehr/requests/${id}`, { status: "closed" })).status, 403, key);
  }
  for (const key of ["frontdesk", "admin"]) {
    const c = await t.login(key);
    assert.equal((await c.get("/ehr/requests")).status, 200, key);
  }
});

test("inbox filters by status, shows age, and is audited", async () => {
  const c = await t.login("frontdesk");
  const open = await c.get("/ehr/requests");
  assert.match(open.text, /Skyler/);         // core seed, status new
  assert.match(open.text, /Jordan/);         // module seed, contacted
  assert.doesNotMatch(open.text, /Quinn/);   // closed
  assert.match(open.text, /days? ago|hours? ago|just now/);
  const closed = await c.get("/ehr/requests?status=closed");
  assert.match(closed.text, /Quinn/);
  assert.doesNotMatch(closed.text, /Skyler/);
  const all = await c.get("/ehr/requests?status=all");
  assert.match(all.text, /Quinn/);
  assert.match(all.text, /Skyler/);
  const a = t.db.prepare("SELECT * FROM audit_log WHERE action='view' AND entity_type='appointment_request' AND entity_id IS NULL ORDER BY id DESC").get();
  assert.ok(a);
  assert.equal(a.user_id, c.userId);
});

test("detail view is audited, escapes content, and update changes status + notes", async () => {
  await t.client().post("/api/appointment-requests", valid({ first_name: "<script>x</script>", last_name: "Escape" }), { json: true });
  const id = latest().id;
  const c = await t.login("frontdesk");
  const d = await c.get(`/ehr/requests/${id}`);
  assert.equal(d.status, 200);
  assert.doesNotMatch(d.text, /<script>x<\/script>/);
  assert.match(d.text, /&lt;script&gt;/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='view' AND entity_type='appointment_request' AND entity_id=?").get(id));

  const u = await c.post(`/ehr/requests/${id}`, { status: "contacted", staff_notes: "Called, left message." });
  assert.equal(u.status, 302);
  assert.equal(u.location, `/ehr/requests/${id}`);
  const row = t.db.prepare("SELECT * FROM appointment_requests WHERE id=?").get(id);
  assert.equal(row.status, "contacted");
  assert.equal(row.staff_notes, "Called, left message.");
  assert.equal(row.handled_by, c.userId);
  const au = t.db.prepare("SELECT * FROM audit_log WHERE action='update' AND entity_type='appointment_request' AND entity_id=? ORDER BY id DESC").get(id);
  assert.ok(au);
  assert.doesNotMatch(au.detail, /Called/);
  const after = await c.get(`/ehr/requests/${id}`);
  assert.match(after.text, /Request updated/);

  assert.equal((await c.post(`/ehr/requests/${id}`, { status: "bogus" })).status, 302);
  assert.equal(t.db.prepare("SELECT status FROM appointment_requests WHERE id=?").get(id).status, "contacted");
  assert.equal((await c.get("/ehr/requests/999999")).status, 404);
});

test("convert creates a patient with an MRN, links the request, and audits", async () => {
  await t.client().post("/api/appointment-requests", valid({ first_name: "Convert", last_name: "Me", phone: "(555) 010-3999", email: "convert.me@example.com" }), { json: true });
  const id = latest().id;
  const c = await t.login("frontdesk");
  const r = await c.post(`/ehr/requests/${id}/convert`, {});
  assert.equal(r.status, 302);
  const m = r.location.match(/^\/ehr\/patients\/(\d+)$/);
  assert.ok(m, r.location);
  const p = t.db.prepare("SELECT * FROM patients WHERE id=?").get(Number(m[1]));
  assert.match(p.mrn, /^CR-\d{6}$/);
  assert.equal(p.first_name, "Convert");
  assert.equal(p.dob, "1990-05-06");
  assert.equal(p.preferred_contact, "text");
  assert.equal(p.ok_voicemail, 1);
  const row = t.db.prepare("SELECT * FROM appointment_requests WHERE id=?").get(id);
  assert.equal(row.patient_id, p.id);
  assert.equal(row.status, "contacted");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='create' AND entity_type='patient' AND entity_id=?").get(p.id));

  // Converting again doesn't create a second patient.
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n;
  await c.post(`/ehr/requests/${id}/convert`, {});
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n, n);

  // A later request from the same person shows the duplicate and can be linked.
  await t.client().post("/api/appointment-requests", valid({ first_name: "convert", last_name: "ME", phone: "555.010.3999", email: "" }), { json: true });
  const id2 = latest().id;
  const d = await c.get(`/ehr/requests/${id2}`);
  assert.match(d.text, new RegExp(p.mrn));
  assert.match(d.text, /Name and date of birth/);
  assert.match(d.text, /Phone/);
  const l = await c.post(`/ehr/requests/${id2}/convert`, { patient_id: p.id });
  assert.equal(l.location, `/ehr/patients/${p.id}`);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n, n);
  assert.equal(t.db.prepare("SELECT patient_id FROM appointment_requests WHERE id=?").get(id2).patient_id, p.id);
});

test("convert without a DOB asks for one", async () => {
  await t.client().post("/api/appointment-requests", valid({ date_of_birth: "", last_name: "NoDob" }), { json: true });
  const id = latest().id;
  const c = await t.login("admin");
  const page1 = await c.get(`/ehr/requests/${id}`);
  assert.match(page1.text, /name="dob"/);
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n;
  const r = await c.post(`/ehr/requests/${id}/convert`, {});
  assert.equal(r.status, 400);
  assert.match(r.text, /date of birth/i);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n, n);
  const ok = await c.post(`/ehr/requests/${id}/convert`, { dob: "1985-01-02" });
  assert.equal(ok.status, 302);
  const row = t.db.prepare("SELECT * FROM appointment_requests WHERE id=?").get(id);
  assert.ok(row.patient_id);
  assert.equal(row.dob, "1985-01-02");
});
