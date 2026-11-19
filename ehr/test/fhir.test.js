"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { today } = require("../src/views");
const fhir = require("../src/routes/fhir");

let t, pid, creds;
before(async () => {
  t = await start();
  pid = t.ctx.patients[0];
});
after(async () => { await t.stop(); });

const get = async (path, token) => {
  const r = await fetch(t.base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, type: r.headers.get("content-type"), body: await r.json() };
};
async function token(id, secret, extra = {}) {
  const r = await fetch(`${t.base}/fhir/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, ...extra }) });
  return { status: r.status, body: await r.json() };
}
async function createClient(name, scopes = "system/*.read", part2 = false) {
  const admin = await t.login("admin");
  const r = await admin.post("/ehr/admin/api/clients", { name, scopes, ...(part2 ? { include_part2: "1" } : {}) });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return { id: r.text.match(/<code>(cr_[^<]+)<\/code>/)[1], secret: r.text.match(/Client secret<\/dt><dd><code>([^<]+)<\/code>/)[1], admin };
}

test("metadata and SMART discovery are public; everything else needs a token", async () => {
  const m = await get("/fhir/metadata");
  assert.equal(m.status, 200);
  assert.match(m.type, /application\/fhir\+json/);
  assert.equal(m.body.resourceType, "CapabilityStatement");
  assert.equal(m.body.fhirVersion, "4.0.1");
  assert.ok(m.body.rest[0].resource.some((r) => r.type === "MedicationRequest"));
  const s = await get("/fhir/.well-known/smart-configuration");
  assert.deepEqual(s.body.grant_types_supported, ["client_credentials"]);
  const p = await get(`/fhir/Patient/${pid}`);
  assert.equal(p.status, 401);
  assert.equal(p.body.resourceType, "OperationOutcome");
});

test("admin creates a client; token flow; wrong secret refused; revoke stops it", async () => {
  fhir.resetFhirRateLimit();
  const fd = await t.login("frontdesk");
  assert.equal((await fd.get("/ehr/admin/api")).status, 403);
  creds = await createClient("Example warehouse");
  assert.ok(t.db.prepare("SELECT secret_hash FROM fhir_clients WHERE client_id = ?").get(creds.id).secret_hash !== creds.secret);
  let r = await token(creds.id, "nope");
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "invalid_client");
  r = await token(creds.id, creds.secret, { grant_type: "password" });
  assert.equal(r.status, 400);
  r = await token(creds.id, creds.secret);
  assert.equal(r.status, 200);
  assert.equal(r.body.token_type, "Bearer");
  assert.equal(r.body.expires_in, 3600);
  // HTTP Basic works too
  const basic = await fetch(`${t.base}/fhir/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${creds.id}:${creds.secret}`).toString("base64")}` }, body: "grant_type=client_credentials" });
  assert.equal(basic.status, 200);
  creds.token = r.body.access_token;
  assert.equal((await get(`/fhir/Patient/${pid}`, creds.token)).status, 200);

  const other = await createClient("Temp");
  const tok = (await token(other.id, other.secret)).body.access_token;
  assert.equal((await get(`/fhir/Patient/${pid}`, tok)).status, 200);
  const rowId = t.db.prepare("SELECT id FROM fhir_clients WHERE client_id = ?").get(other.id).id;
  await other.admin.post(`/ehr/admin/api/clients/${rowId}/revoke`);
  assert.equal((await get(`/fhir/Patient/${pid}`, tok)).status, 401);
  assert.equal((await token(other.id, other.secret)).status, 401);
});

test("Patient read and search; resources by patient; read-only", async () => {
  const p = (await get(`/fhir/Patient/${pid}`, creds.token)).body;
  const row = t.db.prepare("SELECT * FROM patients WHERE id = ?").get(pid);
  assert.equal(p.resourceType, "Patient");
  assert.equal(p.birthDate, row.dob);
  assert.equal(p.name[0].family, row.last_name);
  assert.equal(p.identifier[0].value, row.mrn);
  if (row.ahcccs_id) assert.ok(p.identifier.some((i) => i.value === row.ahcccs_id));

  let s = (await get(`/fhir/Patient?family=${encodeURIComponent(row.last_name)}`, creds.token)).body;
  assert.equal(s.resourceType, "Bundle");
  assert.ok(s.entry.some((e) => e.resource.id === String(pid)));
  s = (await get(`/fhir/Patient?identifier=${encodeURIComponent(`urn:chartready:mrn|${row.mrn}`)}`, creds.token)).body;
  assert.equal(s.total, 1);
  s = (await get("/fhir/Patient?_count=2", creds.token)).body;
  assert.equal(s.entry.length, 2);
  assert.ok(s.link.some((l) => l.relation === "next"));
  assert.equal((await get("/fhir/Patient?birthdate=yesterday", creds.token)).status, 400);

  // Search needs a patient
  assert.equal((await get("/fhir/Condition", creds.token)).status, 400);
  const cond = (await get(`/fhir/Condition?patient=Patient/${pid}`, creds.token)).body;
  assert.ok(cond.total > 0);
  assert.equal(cond.entry[0].resource.code.coding[0].system, "http://hl7.org/fhir/sid/icd-10-cm");
  const one = await get(`/fhir/Condition/${cond.entry[0].resource.id}`, creds.token);
  assert.equal(one.status, 200);
  const appts = (await get(`/fhir/Appointment?patient=${pid}`, creds.token)).body;
  assert.ok(appts.total > 0);
  assert.match(appts.entry[0].resource.start, /T\d\d:\d\d:00[+-]\d\d:\d\d$/);
  for (const type of ["Encounter", "AllergyIntolerance", "MedicationStatement", "Coverage", "MedicationRequest", "Observation"]) {
    const b = await get(`/fhir/${type}?patient=${pid}`, creds.token);
    assert.equal(b.status, 200, type);
    assert.equal(b.body.resourceType, "Bundle");
  }
  assert.equal((await get("/fhir/Organization/clinic", creds.token)).body.resourceType, "Organization");
  assert.equal((await get("/fhir/Basic?patient=1", creds.token)).status, 404);
  const post = await fetch(`${t.base}/fhir/Patient`, { method: "POST", headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 405);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'fhir_read' AND entity_type = 'fhir_Patient' AND patient_id = ?").get(pid));
});

test("Observations: screening totals and TRT labs/vitals with LOINC; $everything", async () => {
  t.db.prepare("INSERT INTO trt_labs (patient_id, drawn_on, total_t, hematocrit, psa) VALUES (?, ?, 650, 49.5, 1.1)").run(pid, today());
  t.db.prepare("INSERT INTO trt_visits (patient_id, visit_date, bp_sys, bp_dia, heart_rate, weight_lb) VALUES (?, ?, 124, 80, 70, 190)").run(pid, today());
  t.db.prepare("INSERT INTO assessments (patient_id, instrument, responses, total_score, severity, administered_on) VALUES (?, 'PHQ9', '[1,1,1,1,1,1,1,1,0]', 8, 'mild', ?)").run(pid, today());
  const labs = (await get(`/fhir/Observation?patient=${pid}&category=laboratory`, creds.token)).body;
  const tt = labs.entry.map((e) => e.resource).find((o) => o.code.coding[0].code === "2986-8");
  assert.equal(tt.valueQuantity.value, 650);
  assert.equal(tt.valueQuantity.code, "ng/dL");
  const read = await get(`/fhir/Observation/${tt.id}`, creds.token);
  assert.equal(read.status, 200);
  const vit = (await get(`/fhir/Observation?patient=${pid}&code=85354-9`, creds.token)).body;
  assert.equal(vit.total, 1);
  assert.equal(vit.entry[0].resource.component[0].valueQuantity.value, 124);
  const survey = (await get(`/fhir/Observation?patient=${pid}&category=survey&code=44261-6`, creds.token)).body;
  assert.ok(survey.entry.some((e) => e.resource.valueInteger === 8));
  const all = (await get(`/fhir/Patient/${pid}/$everything`, creds.token)).body;
  const types = new Set(all.entry.map((e) => e.resource.resourceType));
  for (const x of ["Patient", "Condition", "Observation", "Organization"]) assert.ok(types.has(x), x);
  assert.ok(!JSON.stringify(all).includes("note"), "no clinical notes content");
});

test("scopes limit resource types; Part 2 data is withheld unless allowed", async () => {
  fhir.resetFhirRateLimit();
  const narrow = await createClient("Labs only", "system/Patient.read system/Observation.read");
  const tok = (await token(narrow.id, narrow.secret)).body.access_token;
  assert.equal((await get(`/fhir/Observation?patient=${pid}`, tok)).status, 200);
  assert.equal((await get(`/fhir/Condition?patient=${pid}`, tok)).status, 403);
  assert.equal((await token(narrow.id, narrow.secret, { scope: "system/Condition.read" })).status, 400);

  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description) VALUES (?, 'F10.20', 'Alcohol dependence, uncomplicated')").run(pid);
  t.db.prepare("INSERT INTO medications (patient_id, name, active) VALUES (?, 'Buprenorphine-naloxone', 1)").run(pid);
  let cond = (await get(`/fhir/Condition?patient=${pid}`, creds.token)).body;
  assert.ok(!cond.entry.some((e) => e.resource.code.coding[0].code === "F10.20"));
  assert.ok(!(await get(`/fhir/MedicationStatement?patient=${pid}`, creds.token)).body.entry.some((e) => /Buprenorphine/.test(e.resource.medicationCodeableConcept.text)));
  const p2 = await createClient("Part 2 partner", "system/*.read", true);
  const tok2 = (await token(p2.id, p2.secret)).body.access_token;
  cond = (await get(`/fhir/Condition?patient=${pid}`, tok2)).body;
  assert.ok(cond.entry.some((e) => e.resource.code.coding[0].code === "F10.20"));
});

test("clinic-local times get the right UTC offset", () => {
  assert.match(fhir.localDateTime("2026-07-01T09:00"), /^2026-07-01T09:00:00[+-]\d\d:\d\d$/);
});
