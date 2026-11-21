"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { start } = require("./helpers");
const fhir = require("../src/routes/fhir");

let t, pid, otherPid;
const REDIRECT = "https://app.example.com/callback";
before(async () => {
  t = await start();
  pid = t.ctx.patients[1];
  otherPid = t.ctx.patients[2];
});
after(async () => { await t.stop(); });

const b64url = (b) => Buffer.from(b).toString("base64url");
const fhirGet = async (path, token, headers = {}) => {
  const r = await fetch(t.base + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
};
const postToken = async (params, headers = {}) => {
  const r = await fetch(`${t.base}/fhir/auth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(params) });
  return { status: r.status, body: await r.json() };
};
async function register(fields) {
  const admin = await t.login("admin");
  const r = await admin.post("/ehr/admin/api/clients", fields);
  assert.equal(r.status, 200, r.text.slice(0, 400));
  const secret = r.text.match(/Client secret[^<]*<\/dt><dd><code>([^<]+)<\/code>/);
  return { id: r.text.match(/<code>(cr_[^<]+)<\/code>/)[1], secret: secret ? secret[1] : null };
}
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}
const authQuery = (clientId, challenge, extra = {}) => new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
  scope: "launch/patient openid fhirUser patient/*.read", state: "st123", aud: `${t.base}/fhir`, code_challenge: challenge, code_challenge_method: "S256", ...extra });

test("SMART discovery documents and JWKS", async () => {
  const s = (await fhirGet("/fhir/.well-known/smart-configuration")).body;
  assert.equal(s.token_endpoint, `${t.base}/fhir/auth/token`);
  assert.equal(s.authorization_endpoint, `${t.base}/ehr/smart/authorize`);
  assert.ok(s.capabilities.includes("launch-standalone"));
  assert.ok(s.code_challenge_methods_supported.includes("S256"));
  const j = (await fhirGet("/fhir/.well-known/jwks.json")).body;
  assert.equal(j.keys[0].kty, "RSA");
  assert.ok(!j.keys[0].d, "no private key material");
  const m = (await fhirGet("/fhir/metadata")).body;
  assert.ok(m.instantiates.includes("http://hl7.org/fhir/us/core/CapabilityStatement/us-core-server"));
  const sec = m.rest[0].security.extension[0].extension.map((e) => e.url);
  assert.deepEqual(sec, ["authorize", "token"]);
  assert.ok(m.rest[0].resource.find((r) => r.type === "DocumentReference").supportedProfile[0].endsWith("us-core-documentreference"));
});

test("SMART standalone launch: consent, patient context, PKCE, id_token; access limited to the chosen client", async () => {
  fhir.resetFhirRateLimit();
  const app = await register({ kind: "smart", name: "Outcomes app", redirect_uris: REDIRECT, public_client: "1", scopes: "launch/patient openid fhirUser patient/*.read patient/*.rs" });
  assert.equal(app.secret, null, "public apps get no secret");
  const { verifier, challenge } = pkce();
  const c = await t.login("therapist");

  // Wrong redirect: shown as an error page, never redirected
  let r = await c.get(`/ehr/smart/authorize?${authQuery(app.id, challenge, { redirect_uri: "https://evil.example/cb" })}`);
  assert.equal(r.status, 400);
  // Wrong aud: sent back to the app with an error
  r = await c.get(`/ehr/smart/authorize?${authQuery(app.id, challenge, { aud: "https://other.example/fhir" })}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /^https:\/\/app\.example\.com\/callback\?error=invalid_request/);

  r = await c.get(`/ehr/smart/authorize?${authQuery(app.id, challenge)}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Connect Outcomes app/);
  assert.match(r.headers.get("content-security-policy"), /form-action 'self' https:\/\/app\.example\.com/);

  // Deny
  const fields = Object.fromEntries(authQuery(app.id, challenge));
  r = await c.post("/ehr/smart/authorize", { ...fields, scope: "launch/patient openid fhirUser patient/*.read", decision: "deny" });
  assert.match(r.location, /error=access_denied&state=st123/);
  // Allow without choosing a client
  r = await c.post("/ehr/smart/authorize", { ...fields, decision: "allow" });
  assert.equal(r.status, 200);
  assert.match(r.text, /Choose the client/);
  r = await c.post("/ehr/smart/authorize", { ...fields, decision: "allow", patient_id: String(pid) });
  assert.equal(r.status, 302);
  const back = new URL(r.location);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st123");
  const code = back.searchParams.get("code");

  // Wrong verifier fails and burns the code
  let tk = await postToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: app.id, code_verifier: "nope" });
  assert.equal(tk.status, 400);
  tk = await postToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: app.id, code_verifier: verifier });
  assert.equal(tk.status, 400, "codes are single-use");

  // Fresh code, right verifier
  const p2 = pkce();
  const f2 = Object.fromEntries(authQuery(app.id, p2.challenge));
  r = await c.post("/ehr/smart/authorize", { ...f2, decision: "allow", patient_id: String(pid) });
  const code2 = new URL(r.location).searchParams.get("code");
  tk = await postToken({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: app.id, code_verifier: p2.verifier });
  assert.equal(tk.status, 200, JSON.stringify(tk.body));
  assert.equal(tk.body.patient, String(pid));
  assert.match(tk.body.scope, /patient\/\*\.read/);

  // id_token is signed with the published key
  const [h, p, sig] = tk.body.id_token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  const jwk = (await fhirGet("/fhir/.well-known/jwks.json")).body.keys.find((k) => k.kid === header.kid);
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url")));
  assert.equal(claims.aud, app.id);
  assert.equal(claims.fhirUser, `${t.base}/fhir/Practitioner/${t.ctx.users.therapist}`);

  const token = tk.body.access_token;
  assert.equal((await fhirGet(`/fhir/Patient/${pid}`, token)).status, 200);
  assert.equal((await fhirGet(`/fhir/Patient/${otherPid}`, token)).status, 404);
  const pts = (await fhirGet("/fhir/Patient", token)).body;
  assert.equal(pts.total, 1);
  const cond = (await fhirGet("/fhir/Condition", token)).body;
  assert.ok(cond.entry.every((e) => e.resource.subject.reference === `Patient/${pid}`));
  assert.equal((await fhirGet(`/fhir/Condition?patient=${otherPid}`, token)).body.total, 0);
  assert.equal((await fhirGet(`/fhir/Patient/${otherPid}/$everything`, token)).status, 404);
  assert.equal((await fhirGet("/fhir/Group/all", token)).status, 403);
  // Public SMART apps can't use client_credentials
  assert.equal((await postToken({ grant_type: "client_credentials", client_id: app.id })).status, 400);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'fhir_authorize' AND patient_id = ?").get(pid));
});

test("Backend service signs in with a private key (private_key_jwt, ES384); replay is refused", async () => {
  fhir.resetFhirRateLimit();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES384" };
  const admin = await t.login("admin");
  let bad = await admin.post("/ehr/admin/api/clients", { kind: "backend", name: "Bad keys", scopes: "system/*.read", jwks: JSON.stringify({ keys: [privateKey.export({ format: "jwk" })] }) });
  assert.equal(bad.status, 400, "private keys are refused");
  const svc = await register({ kind: "backend", name: "Warehouse", scopes: "system/*.read", jwks: JSON.stringify({ keys: [jwk] }) });
  const assertion = (jti, aud = `${t.base}/fhir/auth/token`) => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: "ES384", kid: "k1", typ: "JWT" }));
    const p = b64url(JSON.stringify({ iss: svc.id, sub: svc.id, aud, exp: now + 240, jti }));
    const s = crypto.sign("sha384", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${h}.${p}.${b64url(s)}`;
  };
  const params = (a) => ({ grant_type: "client_credentials", scope: "system/*.read", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: a });
  let r = await postToken(params(assertion("j-1", "https://wrong.example/token")));
  assert.equal(r.status, 401);
  r = await postToken(params(assertion("j-2")));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await fhirGet(`/fhir/Patient/${pid}`, r.body.access_token)).status, 200);
  r = await postToken(params(assertion("j-2")));
  assert.equal(r.status, 401);
  assert.match(r.body.error_description, /already used/);
});

test("Bulk export: kick-off, status, NDJSON files; needs Prefer and system scopes", async () => {
  fhir.resetFhirRateLimit();
  const svc = await register({ kind: "backend", name: "Bulk", scopes: "system/*.read" });
  const token = (await postToken({ grant_type: "client_credentials", client_id: svc.id, client_secret: svc.secret })).body.access_token;
  assert.equal((await fhirGet("/fhir/Group/all/$export", token)).status, 400, "Prefer: respond-async required");
  const k = await fhirGet("/fhir/Group/all/$export?_type=Patient,Condition,DocumentReference", token, { prefer: "respond-async", accept: "application/fhir+json" });
  assert.equal(k.status, 202);
  const statusUrl = k.headers.get("content-location");
  assert.match(statusUrl, /\/fhir\/bulkstatus\/[0-9a-f]+$/);
  let s;
  for (let i = 0; i < 50; i++) { s = await fhirGet(new URL(statusUrl).pathname, token); if (s.status === 200) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(s.status, 200);
  assert.equal(s.body.requiresAccessToken, true);
  const pFile = s.body.output.find((o) => o.type === "Patient");
  assert.equal(pFile.count, t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n);
  const f = await fetch(pFile.url, { headers: { authorization: `Bearer ${token}` } });
  assert.match(f.headers.get("content-type"), /application\/fhir\+ndjson/);
  const lines = (await f.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, pFile.count);
  assert.equal(lines[0].resourceType, "Patient");
  assert.equal((await fetch(pFile.url)).status, 401, "files need the token");
  // System-level export, and unsupported type
  assert.equal((await fhirGet("/fhir/$export", token, { prefer: "respond-async" })).status, 202);
  assert.equal((await fhirGet("/fhir/Patient/$export?_type=Basic", token, { prefer: "respond-async" })).status, 400);
  assert.equal((await fetch(t.base + new URL(statusUrl).pathname, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status, 202);
  assert.equal((await fhirGet(new URL(statusUrl).pathname, token)).status, 404);
});

test("US Core shapes: race/ethnicity, notes as DocumentReference (no psychotherapy), goals and care plans, search filters", async () => {
  fhir.resetFhirRateLimit();
  t.db.prepare("UPDATE patients SET race = '2106-3', ethnicity = '2135-2', language = 'es' WHERE id = ?").run(pid);
  const svc = await register({ kind: "backend", name: "US Core", scopes: "system/*.read" });
  const token = (await postToken({ grant_type: "client_credentials", client_id: svc.id, client_secret: svc.secret })).body.access_token;
  const p = (await fhirGet(`/fhir/Patient/${pid}`, token)).body;
  assert.ok(p.meta.profile[0].endsWith("us-core-patient"));
  const race = p.extension.find((e) => e.url.endsWith("us-core-race"));
  assert.equal(race.extension[0].valueCoding.code, "2106-3");
  assert.ok(p.extension.find((e) => e.url.endsWith("us-core-ethnicity")));
  assert.equal(p.communication[0].language.coding[0].code, "es");

  const notePid = t.db.prepare("SELECT patient_id FROM notes WHERE status = 'signed' AND type <> 'psychotherapy' LIMIT 1").get().patient_id;
  t.db.prepare("INSERT INTO notes (patient_id, author_id, type, format, content, status, service_date, signed_at, signed_by) VALUES (?, ?, 'psychotherapy', 'narrative', '{\"narrative\":\"private\"}', 'signed', date('now'), datetime('now'), ?)")
    .run(notePid, t.ctx.users.therapist, t.ctx.users.therapist);
  const docs = (await fhirGet(`/fhir/DocumentReference?patient=${notePid}`, token)).body;
  assert.ok(docs.total > 0);
  const d = docs.entry[0].resource;
  assert.equal(d.category[0].coding[0].code, "clinical-note");
  assert.ok(Buffer.from(d.content[0].attachment.data, "base64").toString("utf8").length > 10);
  const psy = t.db.prepare("SELECT id FROM notes WHERE type = 'psychotherapy'").all().map((n) => String(n.id));
  assert.ok(!docs.entry.some((e) => psy.includes(e.resource.id)));
  assert.equal((await fhirGet(`/fhir/DocumentReference/${psy[psy.length - 1]}`, token)).status, 404);
  assert.equal((await fhirGet(`/fhir/DocumentReference?patient=${notePid}&category=clinical-note&type=http://loinc.org|99999-9`, token)).body.total, 0);

  const planPid = (t.db.prepare("SELECT patient_id FROM treatment_plans WHERE status = 'active' AND COALESCE(plan_type, 'mental_health') = 'mental_health' LIMIT 1").get() || {}).patient_id;
  if (planPid) {
    const cp = (await fhirGet(`/fhir/CarePlan?patient=${planPid}&category=assess-plan`, token)).body;
    assert.ok(cp.total > 0);
    assert.match(cp.entry[0].resource.text.div, /^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/);
    const goals = (await fhirGet(`/fhir/Goal?patient=${planPid}`, token)).body;
    assert.ok(goals.total > 0);
    assert.equal((await fhirGet(`/fhir/Goal/${goals.entry[0].resource.id}`, token)).status, 200);
  }
  const conds = (await fhirGet(`/fhir/Condition?patient=${pid}&clinical-status=active&category=problem-list-item`, token)).body;
  assert.ok(conds.entry.every((e) => e.resource.clinicalStatus.coding[0].code === "active"));
  assert.equal((await fhirGet(`/fhir/Observation?patient=${pid}&date=foo`, token)).status, 400);
  assert.equal((await fhirGet(`/fhir/Observation?patient=${pid}&bogus=1`, token)).status, 400);
  const mr = (await fhirGet(`/fhir/MedicationRequest?patient=${pid}&intent=order,plan`, token)).body;
  assert.equal(mr.resourceType, "Bundle");
  assert.equal((await fhirGet("/fhir/Group/all", token)).body.quantity, t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n);
});
