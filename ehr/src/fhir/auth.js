"use strict";
/*
 * FHIR API sign-in (OAuth 2.0 / SMART on FHIR v1 and v2 scopes).
 *
 *   Backend services (system/ scopes):  grant_type=client_credentials, authenticated with a client secret
 *                                        (client_secret_basic / client_secret_post) or a signed JWT (private_key_jwt,
 *                                        RS384 or ES384, keys registered as a JWK Set).
 *   SMART apps (patient/ and user/ scopes, openid fhirUser, launch/patient):
 *                                        standalone launch, authorization code + PKCE (S256). A staff member signs in to
 *                                        ChartReady, picks the client if the app asked for one, and approves.
 *                                        Public apps use PKCE only; confidential apps also authenticate at the token endpoint.
 *
 *   GET  /ehr/smart/authorize      consent screen (staff session)       POST /ehr/smart/authorize   approve / deny
 *   POST /fhir/auth/token          tokens (1 hour; no refresh tokens)
 *   GET  /fhir/.well-known/smart-configuration, /fhir/.well-known/openid-configuration, /fhir/.well-known/jwks.json
 */
const crypto = require("node:crypto");
const express = require("express");
const { verifyPassword } = require("../auth");
const { can } = require("../permissions");
const { audit } = require("../audit");
const { html, raw, page, csrfField, patientName } = require("../views");
const { encryptField, decryptField } = require("../crypto-field");

const TOKEN_SECONDS = 3600;
const CODE_SECONDS = 120;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const nowSql = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString().replace("T", " ").slice(0, 19);

/** Public base URL of the FHIR API. Behind a proxy (Render) requests arrive as http, so trust the forwarded protocol. */
function baseUrl(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim() === "https" ? "https" : req.protocol;
  return `${String(process.env.EHR_PUBLIC_URL || `${proto}://${req.get("host")}`).replace(/\/+$/, "")}/fhir`;
}
const tokenUrl = (req) => `${baseUrl(req)}/auth/token`;
const authorizeUrl = (req) => `${baseUrl(req).replace(/\/fhir$/, "")}/ehr/smart/authorize`;

/* ------------------------------------------------------------------ */
/* Scopes                                                              */
/* ------------------------------------------------------------------ */

const SCOPE_RE = /^(patient|user|system)\/(\*|[A-Za-z]+)\.(read|write|\*|c?r?u?d?s?)$/;
const EXTRA_SCOPES = ["openid", "fhirUser", "launch/patient", "online_access"];
function parseScope(s) { const m = SCOPE_RE.exec(s); return m ? { ctx: m[1], type: m[2], perm: m[3] } : null; }
const canRead = (perm) => perm === "read" || perm === "*" || (/^c?r?u?d?s?$/.test(perm) && /[rs]/.test(perm));
/** Does an allowed scope cover a requested one? */
function covers(allowed, requested) {
  if (allowed === requested) return true;
  const a = parseScope(allowed), r = parseScope(requested);
  if (!a || !r || a.ctx !== r.ctx) return false;
  if (a.type !== "*" && a.type !== r.type) return false;
  return canRead(a.perm) && canRead(r.perm);
}
/** Read access a token gives for a resource type: "all" (system/user) or "patient" (patient context only) or null. */
function accessFor(token, type) {
  const scopes = String(token.scopes || "").split(/\s+/).map(parseScope).filter((s) => s && canRead(s.perm) && (s.type === "*" || s.type === type));
  if (scopes.some((s) => s.ctx === "system")) return "all";
  if (scopes.some((s) => s.ctx === "user")) return "all";
  if (scopes.some((s) => s.ctx === "patient")) return token.patient_id ? "patient" : null;
  return null;
}
/** Grantable scopes: those requested that the client is registered for. */
function grantable(requested, allowedList) {
  return requested.filter((s) => (EXTRA_SCOPES.includes(s) ? allowedList.includes(s) || allowedList.some((a) => a.startsWith("patient/") || a.startsWith("user/")) : SCOPE_RE.test(s) && allowedList.some((a) => covers(a, s))));
}

/* ------------------------------------------------------------------ */
/* Keys: id_token signing (RS256) and client assertion checks          */
/* ------------------------------------------------------------------ */

function signingKey(db) {
  let row = db.prepare("SELECT * FROM fhir_keys ORDER BY created_at DESC LIMIT 1").get();
  if (!row) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = crypto.randomBytes(8).toString("hex");
    const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
    db.prepare("INSERT INTO fhir_keys (kid, private_pem, public_jwk) VALUES (?, ?, ?)")
      .run(kid, encryptField(privateKey.export({ type: "pkcs8", format: "pem" }), "fhir_keys.private_pem"), JSON.stringify(jwk));
    row = db.prepare("SELECT * FROM fhir_keys WHERE kid = ?").get(kid);
  }
  return { kid: row.kid, privateKey: crypto.createPrivateKey(decryptField(row.private_pem, "fhir_keys.private_pem")), jwk: JSON.parse(row.public_jwk) };
}
function signJwt(db, payload) {
  const k = signingKey(db);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: k.kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), k.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}
function jwks(db) {
  signingKey(db);
  return { keys: db.prepare("SELECT public_jwk FROM fhir_keys").all().map((r) => JSON.parse(r.public_jwk)) };
}

/** Verify a private_key_jwt client assertion against the client's registered JWK Set. Returns null or an error message. */
function verifyClientAssertion(req, client, assertion) {
  const parts = String(assertion || "").split(".");
  if (parts.length !== 3) return "client_assertion is not a JWT.";
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url")); claims = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { return "client_assertion can't be decoded."; }
  if (!["RS384", "ES384"].includes(header.alg)) return "Sign the client_assertion with RS384 or ES384.";
  if (claims.iss !== client.client_id || claims.sub !== client.client_id) return "iss and sub must be the client_id.";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => String(a || "").replace(/\/$/, "") === tokenUrl(req))) return `aud must be ${tokenUrl(req)}.`;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now) return "client_assertion has expired.";
  if (claims.exp > now + 300 + 30) return "client_assertion exp must be no more than 5 minutes ahead.";
  if (!claims.jti) return "client_assertion needs a jti.";
  let set;
  try { set = JSON.parse(client.jwks || "{}"); } catch { set = {}; }
  const keys = (set.keys || []).filter((k) => (!header.kid || k.kid === header.kid) && k.kty === (header.alg === "RS384" ? "RSA" : "EC"));
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  const ok = keys.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
      return crypto.verify("sha384", data, header.alg === "ES384" ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
    } catch { return false; }
  });
  if (!ok) return "client_assertion signature doesn't match a registered key.";
  req.db.prepare("DELETE FROM fhir_jtis WHERE expires_at < datetime('now')").run();
  if (req.db.prepare("SELECT 1 FROM fhir_jtis WHERE jti = ?").get(`${client.client_id}:${claims.jti}`)) return "client_assertion jti was already used.";
  req.db.prepare("INSERT INTO fhir_jtis (jti, expires_at) VALUES (?, ?)").run(`${client.client_id}:${claims.jti}`, new Date(claims.exp * 1000).toISOString().replace("T", " ").slice(0, 19));
  return null;
}

/* ------------------------------------------------------------------ */
/* Token endpoint                                                      */
/* ------------------------------------------------------------------ */

const failures = new Map();
function tooMany(ip) { const f = failures.get(ip); return f && f.n >= 10 && f.until > Date.now(); }
function fail(ip) { const f = failures.get(ip) || { n: 0, until: 0 }; if (f.until < Date.now()) f.n = 0; f.n += 1; f.until = Date.now() + 15 * 60000; failures.set(ip, f); }
function resetFhirRateLimit() { failures.clear(); }

/** Identify and authenticate the client at the token endpoint. Returns { client } or { status, error, desc }. */
function authenticateClient(req) {
  const b = req.body || {};
  let id = b.client_id, secret = b.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
  if (basic) { const [u, ...p] = Buffer.from(basic[1], "base64").toString("utf8").split(":"); id = decodeURIComponent(u); secret = decodeURIComponent(p.join(":")); }
  let claimedFromAssertion = null;
  if (b.client_assertion) { try { claimedFromAssertion = JSON.parse(Buffer.from(String(b.client_assertion).split(".")[1] || "", "base64url")).iss; } catch { claimedFromAssertion = null; } }
  id = id || claimedFromAssertion;
  const client = id ? req.db.prepare("SELECT * FROM fhir_clients WHERE client_id = ? AND revoked_at IS NULL").get(String(id)) : null;
  if (!client) return { status: 401, error: "invalid_client", desc: "Unknown or revoked client." };
  if (b.client_assertion) {
    if (b.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return { status: 400, error: "invalid_request", desc: "client_assertion_type must be urn:ietf:params:oauth:client-assertion-type:jwt-bearer." };
    if (!client.jwks) return { status: 401, error: "invalid_client", desc: "This client has no registered public keys." };
    const err = verifyClientAssertion(req, client, b.client_assertion);
    return err ? { status: 401, error: "invalid_client", desc: err, client } : { client, method: "private_key_jwt" };
  }
  if (secret) return verifyPassword(String(secret), client.secret_hash) ? { client, method: "secret" } : { status: 401, error: "invalid_client", desc: "Wrong client secret.", client };
  if (client.public_client) return { client, method: "none" };
  return { status: 401, error: "invalid_client", desc: "Authenticate with a client secret or a signed client_assertion." };
}

function issueToken(db, client, scopes, { userId = null, patientId = null, portalAccountId = null } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM fhir_tokens WHERE expires_at < datetime('now')").run();
  db.prepare("INSERT INTO fhir_tokens (token_hash, client_ref, scopes, expires_at, user_id, patient_id, portal_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sha256(token), client.id, scopes.join(" "), nowSql(TOKEN_SECONDS), userId, patientId, portalAccountId);
  db.prepare("UPDATE fhir_clients SET last_used_at = datetime('now') WHERE id = ?").run(client.id);
  return token;
}

function tokenHandler(req, res) {
  res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
  const err = (status, error, desc) => res.status(status).json({ error, error_description: desc });
  if (tooMany(req.ip)) return err(429, "slow_down", "Too many failed attempts. Try again in 15 minutes.");
  const b = req.body || {};
  if (!["client_credentials", "authorization_code"].includes(b.grant_type)) return err(400, "unsupported_grant_type", "Use client_credentials or authorization_code.");
  const auth = authenticateClient(req);
  if (auth.error) {
    fail(req.ip);
    audit(req, "fhir_token_failed", "fhir_client", auth.client ? auth.client.id : null, null, auth.desc.slice(0, 120));
    return err(auth.status, auth.error, auth.desc);
  }
  const client = auth.client;
  const allowed = client.scopes.split(/\s+/).filter(Boolean);

  if (b.grant_type === "client_credentials") {
    if (client.kind !== "backend") return err(400, "unauthorized_client", "SMART apps use the authorization code flow.");
    const asked = b.scope ? String(b.scope).split(/\s+/).filter(Boolean) : allowed;
    const scopes = grantable(asked, allowed).filter((s) => s.startsWith("system/"));
    if (!scopes.length) return err(400, "invalid_scope", `This client may request: ${client.scopes}`);
    const token = issueToken(req.db, client, scopes);
    audit(req, "fhir_token", "fhir_client", client.id, null, `client ${client.client_id} ${auth.method}`);
    return res.json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_SECONDS, scope: scopes.join(" ") });
  }

  // authorization_code
  if (client.kind !== "smart") return err(400, "unauthorized_client", "Backend services use client_credentials.");
  if (!client.public_client && auth.method === "none") return err(401, "invalid_client", "This app must authenticate.");
  const row = b.code ? req.db.prepare("SELECT * FROM fhir_auth_codes WHERE code_hash = ?").get(sha256(String(b.code))) : null;
  if (!row || row.client_ref !== client.id || row.used_at || row.expires_at < nowSql()) { fail(req.ip); return err(400, "invalid_grant", "The code is invalid, expired or already used."); }
  req.db.prepare("UPDATE fhir_auth_codes SET used_at = datetime('now') WHERE code_hash = ?").run(row.code_hash);
  if (String(b.redirect_uri || "") !== row.redirect_uri) return err(400, "invalid_grant", "redirect_uri doesn't match the authorization request.");
  const verifier = String(b.code_verifier || "");
  if (!row.code_challenge || !verifier || b64url(crypto.createHash("sha256").update(verifier).digest()) !== row.code_challenge) return err(400, "invalid_grant", "PKCE code_verifier doesn't match.");
  const scopes = row.scopes.split(" ");
  if (row.portal_account_id) {
    // A client connected the app from the patient portal: their own record only.
    const acct = req.db.prepare("SELECT * FROM portal_accounts WHERE id = ? AND active = 1").get(row.portal_account_id);
    if (!acct || acct.patient_id !== row.patient_id) return err(400, "invalid_grant", "The portal account is no longer active.");
    const pscopes = scopes.filter((s) => s.startsWith("patient/") || ["openid", "fhirUser", "launch/patient"].includes(s));
    const token = issueToken(req.db, client, pscopes, { patientId: acct.patient_id, portalAccountId: acct.id });
    const out = { access_token: token, token_type: "Bearer", expires_in: TOKEN_SECONDS, scope: pscopes.join(" "), patient: String(acct.patient_id), need_patient_banner: false };
    if (pscopes.includes("openid")) {
      const now = Math.floor(Date.now() / 1000);
      out.id_token = signJwt(req.db, { iss: baseUrl(req), sub: `patient-${acct.patient_id}`, aud: client.client_id, iat: now, exp: now + TOKEN_SECONDS,
        ...(row.nonce ? { nonce: row.nonce } : {}), ...(pscopes.includes("fhirUser") ? { fhirUser: `${baseUrl(req)}/Patient/${acct.patient_id}` } : {}) });
    }
    audit(req, "fhir_token", "fhir_client", client.id, acct.patient_id, `client ${client.client_id} portal`);
    return res.json(out);
  }
  const user = req.db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
  if (!user || user.active !== 1) return err(400, "invalid_grant", "The approving user is no longer active.");
  const token = issueToken(req.db, client, scopes, { userId: user.id, patientId: row.patient_id });
  const out = { access_token: token, token_type: "Bearer", expires_in: TOKEN_SECONDS, scope: row.scopes, need_patient_banner: true };
  if (row.patient_id) out.patient = String(row.patient_id);
  if (scopes.includes("openid")) {
    const now = Math.floor(Date.now() / 1000);
    out.id_token = signJwt(req.db, { iss: baseUrl(req), sub: String(user.id), aud: client.client_id, iat: now, exp: now + TOKEN_SECONDS,
      ...(row.nonce ? { nonce: row.nonce } : {}), ...(scopes.includes("fhirUser") ? { fhirUser: `${baseUrl(req)}/Practitioner/${user.id}` } : {}), name: user.name });
  }
  audit(req, "fhir_token", "fhir_client", client.id, row.patient_id, `client ${client.client_id} smart user ${user.id}`);
  res.json(out);
}

/* ------------------------------------------------------------------ */
/* Bearer tokens on API requests                                       */
/* ------------------------------------------------------------------ */

function bearer(req, res, next) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
  const row = m ? req.db.prepare(`SELECT t.scopes, t.user_id, t.patient_id, t.portal_account_id, c.id, c.client_id, c.name, c.kind, c.include_part2 FROM fhir_tokens t
    JOIN fhir_clients c ON c.id = t.client_ref WHERE t.token_hash = ? AND t.expires_at > datetime('now') AND c.revoked_at IS NULL`).get(sha256(m[1])) : null;
  if (row && row.user_id) {
    const u = req.db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
    if (!u || u.active !== 1) return unauthorized(res);
    row.user = u;
  }
  if (row && row.portal_account_id && !req.db.prepare("SELECT 1 FROM portal_accounts WHERE id = ? AND active = 1 AND patient_id = ?").get(row.portal_account_id, row.patient_id)) return unauthorized(res);
  if (!row) return unauthorized(res);
  req.fhirClient = row;
  next();
}
function unauthorized(res) {
  res.set("WWW-Authenticate", 'Bearer realm="fhir", error="invalid_token"').status(401).type("application/fhir+json")
    .send(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "login", diagnostics: "Missing, expired or revoked access token." }] }));
}
/** For user/ scopes the signed-in staff member's own permissions still apply. */
function userMayRead(token, type) {
  if (!token.user) return true;
  if (["Patient", "Appointment", "Coverage", "Practitioner", "Organization"].includes(type)) return can(token.user, "patients:read");
  return can(token.user, "clinical:read");
}

/* ------------------------------------------------------------------ */
/* Discovery documents                                                 */
/* ------------------------------------------------------------------ */

function smartConfiguration(req) {
  return {
    issuer: baseUrl(req), jwks_uri: `${baseUrl(req)}/.well-known/jwks.json`,
    authorization_endpoint: authorizeUrl(req), token_endpoint: tokenUrl(req),
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["RS384", "ES384"],
    scopes_supported: ["openid", "fhirUser", "launch/patient", "patient/*.read", "patient/*.rs", "user/*.read", "user/*.rs", "system/*.read", "system/*.rs"],
    response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    capabilities: ["launch-standalone", "client-public", "client-confidential-symmetric", "client-confidential-asymmetric", "context-standalone-patient",
      "context-banner", "sso-openid-connect", "permission-patient", "permission-user", "permission-v1", "permission-v2"],
  };
}

function mountPublic(fhirRouter) {
  fhirRouter.post("/auth/token", tokenHandler);
  fhirRouter.get("/.well-known/smart-configuration", (req, res) => res.set("Cache-Control", "no-store").json(smartConfiguration(req)));
  fhirRouter.get("/.well-known/openid-configuration", (req, res) => res.set("Cache-Control", "no-store").json({
    issuer: baseUrl(req), jwks_uri: `${baseUrl(req)}/.well-known/jwks.json`, authorization_endpoint: authorizeUrl(req), token_endpoint: tokenUrl(req),
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "fhirUser"], claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "fhirUser", "name"],
  }));
  fhirRouter.get("/.well-known/jwks.json", (req, res) => res.set("Cache-Control", "no-store").json(jwks(req.db)));
}

/* ------------------------------------------------------------------ */
/* Authorize (staff session, under /ehr)                               */
/* ------------------------------------------------------------------ */

const router = express.Router();
const SCOPE_TEXT = (s) => {
  if (s === "openid" || s === "fhirUser") return "Know who you are (your name and staff profile)";
  if (s === "launch/patient") return "Work with the client you choose below";
  if (s === "online_access") return "Stay connected while you're signed in";
  const p = parseScope(s);
  if (!p) return s;
  const what = p.type === "*" ? "all record types shared through the API" : p.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() + " records";
  return p.ctx === "patient" ? `Read ${what} for the chosen client` : `Read ${what} for any client you can see`;
};

/** Validate an authorization request. Returns { client, ... } or { fatal } (show page) or { redirectError } (send back to app). */
function checkAuthorize(req, q) {
  const client = q.client_id ? req.db.prepare("SELECT * FROM fhir_clients WHERE client_id = ? AND revoked_at IS NULL AND kind = 'smart'").get(String(q.client_id)) : null;
  if (!client) return { fatal: "This app isn't registered with the clinic, or its access was revoked." };
  const uris = String(client.redirect_uris || "").split(/\s+/).filter(Boolean);
  const redirect = String(q.redirect_uri || "");
  if (!uris.includes(redirect)) return { fatal: "The app's return address doesn't match what the clinic registered." };
  const back = (error, desc) => ({ redirectError: `${redirect}${redirect.includes("?") ? "&" : "?"}${new URLSearchParams({ error, error_description: desc, ...(q.state ? { state: String(q.state) } : {}) })}` });
  if (q.response_type !== "code") return back("unsupported_response_type", "Use response_type=code.");
  if (String(q.aud || "").replace(/\/$/, "") !== baseUrl(req)) return back("invalid_request", `aud must be ${baseUrl(req)}.`);
  if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  if (!q.state) return back("invalid_request", "state is required.");
  const requested = String(q.scope || "").split(/\s+/).filter(Boolean);
  const scopes = grantable(requested, client.scopes.split(/\s+/));
  if (!scopes.some((s) => /^(patient|user)\//.test(s))) return back("invalid_scope", "Request patient/ or user/ read scopes this app is registered for.");
  if (scopes.some((s) => s.startsWith("patient/")) && !scopes.includes("launch/patient")) scopes.push("launch/patient");
  return { client, redirect, scopes, state: String(q.state), challenge: String(q.code_challenge), nonce: q.nonce ? String(q.nonce).slice(0, 200) : null };
}

function consentPage(req, res, a, error = null) {
  const needsPatient = a.scopes.includes("launch/patient");
  const patients = needsPatient ? req.db.prepare("SELECT id, first_name, last_name, preferred_name, mrn, dob FROM patients WHERE status = 'active' ORDER BY last_name, first_name LIMIT 2000").all() : [];
  // Let this page's form post (and be redirected) back to the app's own address.
  const origin = new URL(a.redirect).origin;
  res.set("Content-Security-Policy", String(res.get("Content-Security-Policy") || "").replace("form-action 'self'", `form-action 'self' ${origin}`));
  const hidden = (n, v) => html`<input type="hidden" name="${n}" value="${v || ""}">`;
  res.send(page(req, { title: `Connect ${a.client.name}`, body: html`
    <div class="card stack" style="max-width:640px;margin:2rem auto">
      <h1>Connect ${a.client.name}?</h1>
      <p><strong>${a.client.name}</strong> wants to read records from ${require("../clinic").getClinic(req.db).name} as you, ${req.user.name}. It can only read; it can't change anything.</p>
      ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
      <ul class="list">${a.scopes.filter((s, i, arr) => arr.indexOf(s) === i).map((s) => html`<li>${SCOPE_TEXT(s)}</li>`)}</ul>
      <form method="post" action="/ehr/smart/authorize" class="stack">
        ${csrfField(req)}${hidden("client_id", a.client.client_id)}${hidden("redirect_uri", a.redirect)}${hidden("scope", a.scopes.join(" "))}${hidden("state", a.state)}
        ${hidden("code_challenge", a.challenge)}${hidden("code_challenge_method", "S256")}${hidden("response_type", "code")}${hidden("aud", baseUrl(req))}${a.nonce ? hidden("nonce", a.nonce) : ""}
        ${needsPatient ? html`<label>Client <select name="patient_id" required><option value="">Choose a client…</option>${patients.map((p) => html`<option value="${p.id}">${patientName(p)} · MRN ${p.mrn}</option>`)}</select></label>` : ""}
        <p class="small muted">Psychotherapy notes are never shared. Access lasts one hour and is recorded in the audit log.</p>
        <div class="row"><button class="btn btn--primary" type="submit" name="decision" value="allow">Allow</button>
          <button class="btn" type="submit" name="decision" value="deny">Don't allow</button></div>
      </form>
    </div>` }));
}

const mayAuthorize = (u) => can(u, "patients:read");

router.get("/smart/authorize", (req, res) => {
  if (!mayAuthorize(req.user)) return res.status(403).send(page(req, { title: "Not allowed", body: html`<div class="card"><h1>Your role can't connect apps</h1></div>` }));
  const a = checkAuthorize(req, req.query);
  if (a.fatal) return res.status(400).send(page(req, { title: "Can't connect this app", body: html`<div class="card"><h1>Can't connect this app</h1><p>${a.fatal}</p></div>` }));
  if (a.redirectError) return res.redirect(a.redirectError);
  consentPage(req, res, a);
});

router.post("/smart/authorize", (req, res) => {
  if (!mayAuthorize(req.user)) return res.status(403).send("Forbidden");
  const b = req.body || {};
  const a = checkAuthorize(req, b);
  if (a.fatal) return res.status(400).send(page(req, { title: "Can't connect this app", body: html`<div class="card"><h1>Can't connect this app</h1><p>${a.fatal}</p></div>` }));
  if (a.redirectError) return res.redirect(a.redirectError);
  const sep = a.redirect.includes("?") ? "&" : "?";
  if (b.decision !== "allow") {
    audit(req, "fhir_authorize_denied", "fhir_client", a.client.id, null);
    return res.redirect(`${a.redirect}${sep}${new URLSearchParams({ error: "access_denied", state: a.state })}`);
  }
  let patientId = null;
  if (a.scopes.includes("launch/patient")) {
    patientId = /^\d+$/.test(String(b.patient_id || "")) ? Number(b.patient_id) : null;
    if (!patientId || !req.db.prepare("SELECT 1 FROM patients WHERE id = ?").get(patientId)) return consentPage(req, res, a, "Choose the client to share.");
  }
  const code = crypto.randomBytes(32).toString("base64url");
  req.db.prepare(`INSERT INTO fhir_auth_codes (code_hash, client_ref, user_id, patient_id, scopes, redirect_uri, code_challenge, nonce, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(code), a.client.id, req.user.id, patientId, a.scopes.join(" "), a.redirect, a.challenge, a.nonce, nowSql(CODE_SECONDS));
  audit(req, "fhir_authorize", "fhir_client", a.client.id, patientId, `client ${a.client.client_id}`);
  res.redirect(`${a.redirect}${sep}${new URLSearchParams({ code, state: a.state })}`);
});

module.exports = { checkAuthorize, router, mountPublic, bearer, accessFor, userMayRead, baseUrl, parseScope, covers, SCOPE_RE, EXTRA_SCOPES, resetFhirRateLimit, jwks, smartConfiguration, tokenUrl };
