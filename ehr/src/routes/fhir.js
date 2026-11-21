"use strict";
/*
 * FHIR R4 API, read-only, JSON (application/fhir+json), mounted at /fhir (see app.js). Built to US Core 6.1, SMART App
 * Launch (v1 and v2 scopes) and Bulk Data Access, the standards ONC's (g)(10) API criterion tests.
 *
 *   GET  /fhir/metadata                              CapabilityStatement (public)
 *   GET  /fhir/.well-known/smart-configuration       SMART discovery (public); also openid-configuration and jwks.json
 *   POST /fhir/auth/token                            OAuth 2.0 token endpoint            (fhir/auth.js)
 *   GET  /ehr/smart/authorize                        SMART consent screen (staff sign-in) (fhir/auth.js)
 *   GET  /fhir/:type/:id                             read
 *   GET  /fhir/:type?patient=...                     search (Bundle searchset, paged with _count / _offset)
 *   GET  /fhir/Patient/:id/$everything               one client's record
 *   GET  /fhir/$export, /fhir/Patient/$export, /fhir/Group/all/$export     bulk export (fhir/bulk.js)
 *
 * Resources and privacy rules live in fhir/resources.js. Every request is audited with the API client and patient.
 * Administration -> API access (FHIR) registers backend services and SMART apps (below).
 */
const express = require("express");
const crypto = require("node:crypto");
const { hashPassword, requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, page, csrfField, fmtTimestamp } = require("../views");
const R = require("../fhir/resources");
const A = require("../fhir/auth");
const bulk = require("../fhir/bulk");

const fhirRouter = express.Router();
const router = express.Router(); // admin pages + SMART consent, mounted under /ehr
router.use(A.router);

const FHIR_JSON = "application/fhir+json; charset=utf-8";
const send = (res, body, status = 200) => res.status(status).type(FHIR_JSON).send(JSON.stringify(body));
function outcome(res, status, code, diagnostics) {
  send(res, { resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] }, status);
}

/* ------------------------------------------------------------------ */
/* Public: capability statement and discovery                          */
/* ------------------------------------------------------------------ */

fhirRouter.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
A.mountPublic(fhirRouter);

const PROFILES = {
  Patient: ["us-core-patient"], Practitioner: ["us-core-practitioner"], Organization: ["us-core-organization"], Encounter: ["us-core-encounter"],
  Condition: ["us-core-condition-problems-health-concerns"], AllergyIntolerance: ["us-core-allergyintolerance"], MedicationRequest: ["us-core-medicationrequest"],
  Observation: ["us-core-observation-lab", "us-core-blood-pressure", "us-core-heart-rate", "us-core-body-weight", "us-core-observation-screening-assessment"],
  Coverage: ["us-core-coverage"], DocumentReference: ["us-core-documentreference"], Goal: ["us-core-goal"], CarePlan: ["us-core-careplan"],
};
const SEARCH_PARAMS = {
  Patient: [["_id", "token"], ["identifier", "token"], ["name", "string"], ["family", "string"], ["given", "string"], ["birthdate", "date"], ["gender", "token"]],
  Practitioner: [["_id", "token"], ["identifier", "token"], ["name", "string"]],
  Organization: [["_id", "token"]], Group: [["_id", "token"]],
  Observation: [["patient", "reference"], ["category", "token"], ["code", "token"], ["date", "date"], ["status", "token"]],
  Condition: [["patient", "reference"], ["category", "token"], ["clinical-status", "token"], ["code", "token"]],
  AllergyIntolerance: [["patient", "reference"], ["clinical-status", "token"]],
  MedicationRequest: [["patient", "reference"], ["intent", "token"], ["status", "token"], ["authoredon", "date"]],
  Encounter: [["patient", "reference"], ["_id", "token"], ["date", "date"], ["status", "token"]],
  DocumentReference: [["patient", "reference"], ["_id", "token"], ["category", "token"], ["type", "token"], ["date", "date"], ["status", "token"]],
  Goal: [["patient", "reference"], ["lifecycle-status", "token"]],
  CarePlan: [["patient", "reference"], ["category", "token"], ["status", "token"]],
};

fhirRouter.get("/metadata", (req, res) => {
  const base = A.baseUrl(req);
  const c = require("../clinic").getClinic(req.db);
  send(res, {
    resourceType: "CapabilityStatement", status: "active", date: new Date().toISOString().slice(0, 10), kind: "instance", fhirVersion: "4.0.1",
    format: ["application/fhir+json", "json"], publisher: c.name,
    software: { name: require("../product").PRODUCT.name }, implementation: { description: `${c.name} FHIR API (read-only)`, url: base },
    instantiates: ["http://hl7.org/fhir/us/core/CapabilityStatement/us-core-server"],
    implementationGuide: ["http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core|6.1.0", "http://hl7.org/fhir/smart-app-launch/ImplementationGuide/hl7.fhir.uv.smart-app-launch", "http://hl7.org/fhir/uv/bulkdata/ImplementationGuide/hl7.fhir.uv.bulkdata"],
    rest: [{
      mode: "server",
      security: {
        cors: false,
        service: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "SMART-on-FHIR" }], text: "OAuth 2.0 / SMART on FHIR" }],
        extension: [{ url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris", extension: [
          { url: "authorize", valueUri: A.smartConfiguration(req).authorization_endpoint }, { url: "token", valueUri: A.tokenUrl(req) }] }],
      },
      resource: R.TYPES.map((type) => clean({
        type, supportedProfile: (PROFILES[type] || []).map((p) => R.US_CORE + p),
        interaction: [{ code: "read" }, { code: "search-type" }],
        searchParam: (SEARCH_PARAMS[type] || [["patient", "reference"], ["_id", "token"]]).map(([name, t]) => ({ name, type: t })),
        operation: type === "Patient" ? [{ name: "everything", definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything" }, { name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/patient-export" }]
          : type === "Group" ? [{ name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/group-export" }] : undefined,
      })),
      operation: [{ name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export" }],
    }],
  });
});
const clean = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------------ */
/* Authenticated API                                                   */
/* ------------------------------------------------------------------ */

fhirRouter.use(A.bearer);
bulk.mount(fhirRouter);

/** May this token read this type? Returns "all", "patient" or null (and sends 403). */
function access(req, res, type) {
  if (!R.TYPES.includes(type)) { outcome(res, 404, "not-supported", `Resource type ${type} is not supported. See /fhir/metadata.`); return null; }
  const a = A.accessFor(req.fhirClient, type);
  if (!a) { outcome(res, 403, "forbidden", `The access token's scopes don't include ${type}.`); return null; }
  if (!A.userMayRead(req.fhirClient, type)) { outcome(res, 403, "forbidden", `The signed-in user's role can't read ${type}.`); return null; }
  return a;
}
const opts = (req) => ({ part2: !!req.fhirClient.include_part2 });
const logAccess = (req, action, type, id, patientId, n) =>
  audit({ db: req.db, user: req.fhirClient.user || null, ip: req.ip }, action, `fhir_${type}`, /^\d+$/.test(String(id || "")) ? id : null, patientId || null,
    `client ${req.fhirClient.client_id}${n != null ? ` results=${n}` : ""}`);

function bundle(req, entries, total, offset, count) {
  const base = A.baseUrl(req);
  const self = new URL(base + req.path.replace(/^\/?/, "/"));
  for (const [k, v] of Object.entries(req.query)) for (const x of Array.isArray(v) ? v : [v]) self.searchParams.append(k, String(x));
  const link = [{ relation: "self", url: self.toString() }];
  if (offset + count < total) { const next = new URL(self); next.searchParams.set("_offset", String(offset + count)); next.searchParams.set("_count", String(count)); link.push({ relation: "next", url: next.toString() }); }
  return { resourceType: "Bundle", type: "searchset", total, link, entry: entries.map((r) => ({ fullUrl: `${base}/${r.resourceType}/${r.id}`, resource: r, search: { mode: "match" } })) };
}
const patientIdOf = (v) => { const m = /^(?:.*\/)?Patient\/(\d+)$|^(\d+)$/.exec(String(v || "")); return m ? Number(m[1] || m[2]) : null; };

// System-level bulk export: GET /fhir/$export
fhirRouter.get("/:op", (req, res, next) => (req.params.op === "$export" ? bulk.kickoff(req, res, "system") : next()));
// Group export: GET /fhir/Group/all/$export
fhirRouter.get("/Group/:id/:op", (req, res, next) => {
  if (req.params.op !== "$export") return next();
  if (req.params.id !== "all") return outcome(res, 404, "not-found", "Group not found. Use Group/all.");
  bulk.kickoff(req, res, "group");
});

fhirRouter.get("/Patient/:id/:op", (req, res, next) => {
  if (req.params.op !== "$everything") return next();
  const a = access(req, res, "Patient");
  if (!a) return;
  const pid = patientIdOf(req.params.id);
  if (!pid || (a === "patient" && pid !== req.fhirClient.patient_id)) return outcome(res, 404, "not-found", "Patient not found.");
  const found = R.readOne(req.db, "Patient", String(pid));
  if (!found) return outcome(res, 404, "not-found", "Patient not found.");
  const resources = [found.resource];
  for (const type of R.COMPARTMENT) if (A.accessFor(req.fhirClient, type) && A.userMayRead(req.fhirClient, type)) resources.push(...R.loadForPatient(req.db, type, pid, opts(req)));
  if (A.accessFor(req.fhirClient, "Practitioner")) resources.push(...R.referencedSupport(req.db, resources));
  if (A.accessFor(req.fhirClient, "Organization")) resources.push(R.organizationResource(require("../clinic").getClinic(req.db)));
  logAccess(req, "fhir_everything", "Patient", pid, pid, resources.length);
  send(res, { resourceType: "Bundle", type: "searchset", total: resources.length, entry: resources.map((r) => ({ fullUrl: `${A.baseUrl(req)}/${r.resourceType}/${r.id}`, resource: r })) });
});

fhirRouter.get("/:type/:id", (req, res) => {
  const { type, id } = req.params;
  if (type === "Patient" && id === "$export") return bulk.kickoff(req, res, "patient");
  const a = access(req, res, type);
  if (!a) return;
  if (a === "patient" && type === "Group") return outcome(res, 403, "forbidden", "Not available with patient scopes.");
  const found = R.readOne(req.db, type, id, opts(req));
  // In patient context, anything outside the chosen client's record reads as not found.
  if (!found || (a === "patient" && found.patientId && found.patientId !== req.fhirClient.patient_id)) return outcome(res, 404, "not-found", `${type}/${id} not found.`);
  logAccess(req, "fhir_read", type, id, found.patientId);
  send(res, found.resource);
});

fhirRouter.get("/:type", (req, res) => {
  const { type } = req.params;
  const a = access(req, res, type);
  if (!a) return;
  const db = req.db;
  const q = req.query;
  const unknown = Object.keys(q).filter((k) => !R.SUPPORTED_PARAMS.has(k) && !(k === "authoredon"));
  if (unknown.length) return outcome(res, 400, "not-supported", `Unsupported search parameter: ${unknown.join(", ")}`);
  const count = Math.min(Math.max(parseInt(q._count, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q._offset, 10) || 0, 0);
  const restrictTo = a === "patient" ? req.fhirClient.patient_id : null;
  let list;
  let pid = null;
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  if (type === "Patient") {
    const where = [], args = [];
    const like = (s) => `${String(s).replace(/[%_\\]/g, "\\$&")}%`;
    if (q._id) { where.push("id = ?"); args.push(Number(first(q._id)) || -1); }
    if (q.identifier) {
      const v = String(first(q.identifier));
      const [sys, val] = v.includes("|") ? v.split("|") : [null, v];
      if (sys === R.SYS.ahcccs) { where.push("ahcccs_id = ?"); args.push(val); } else if (!sys || sys === R.SYS.mrn) { where.push("mrn = ?"); args.push(val); } else where.push("0");
    }
    if (q.family) { where.push("last_name LIKE ? ESCAPE '\\'"); args.push(like(first(q.family))); }
    if (q.given) { where.push("(first_name LIKE ? ESCAPE '\\' OR preferred_name LIKE ? ESCAPE '\\')"); args.push(like(first(q.given)), like(first(q.given))); }
    if (q.name) { const n = `%${String(first(q.name)).replace(/[%_\\]/g, "\\$&")}%`; where.push("(first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR preferred_name LIKE ? ESCAPE '\\')"); args.push(n, n, n); }
    if (q.birthdate) {
      const d = /^(eq)?(\d{4}-\d{2}-\d{2})$/.exec(String(first(q.birthdate)));
      if (!d) return outcome(res, 400, "invalid", "birthdate must be YYYY-MM-DD.");
      where.push("dob = ?"); args.push(d[2]);
    }
    if (restrictTo) { where.push("id = ?"); args.push(restrictTo); }
    list = db.prepare(`SELECT * FROM patients ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_name, first_name, id`).all(...args).map(R.patientResource);
  } else if (type === "Practitioner") {
    const args = [];
    let sql = "SELECT id, name, credentials, npi, active FROM users WHERE role IN ('clinician', 'admin')";
    if (q._id) { sql += " AND id = ?"; args.push(Number(first(q._id)) || -1); }
    if (q.identifier) { sql += " AND npi = ?"; args.push(String(first(q.identifier)).split("|").pop()); }
    if (q.name) { sql += " AND name LIKE ?"; args.push(`%${String(first(q.name))}%`); }
    list = db.prepare(`${sql} ORDER BY name`).all(...args).map(R.practitionerResource);
  } else if (type === "Organization" || type === "Group") {
    if (a === "patient" && type === "Group") return outcome(res, 403, "forbidden", "Not available with patient scopes.");
    const only = type === "Organization" ? "clinic" : "all";
    list = !q._id || first(q._id) === only ? [R.readOne(db, type, only).resource] : [];
  } else {
    if (q.patient || q.subject) {
      pid = patientIdOf(first(q.patient || q.subject));
      if (!pid || !db.prepare("SELECT 1 FROM patients WHERE id = ?").get(pid)) return outcome(res, 404, "not-found", "Patient not found.");
      if (restrictTo && pid !== restrictTo) return send(res, bundle(req, [], 0, 0, count));
    } else if (restrictTo) {
      pid = restrictTo;
    } else if (!q._id) return outcome(res, 400, "required", `Search ${type} by patient (e.g. ${type}?patient=123).`);
    if (q._id) {
      const found = R.readOne(db, type, String(first(q._id)), opts(req));
      list = found && (!pid || found.patientId === pid) ? [found.resource] : [];
    } else list = R.loadForPatient(db, type, pid, opts(req));
    const qq = { ...q };
    if (qq.authoredon) { qq.date = qq.authoredon; delete qq.authoredon; }
    const f = R.applyFilters(type, list, qq);
    if (f.error) return outcome(res, 400, "invalid", f.error);
    list = f.list;
  }
  if (type === "Patient" && q.gender) list = R.applyFilters(type, list, { gender: q.gender }).list;
  logAccess(req, "fhir_search", type, null, pid || restrictTo, list.length);
  send(res, bundle(req, list.slice(offset, offset + count), list.length, offset, count));
});

fhirRouter.use((req, res) => outcome(res, 405, "not-supported", "This FHIR API is read-only. See /fhir/metadata."));

/* ------------------------------------------------------------------ */
/* Administration -> API access (FHIR)                                 */
/* ------------------------------------------------------------------ */

const adminOnly = requirePerm("admin");
const BACKEND_PRESETS = [
  ["system/*.read", "Everything the API offers"],
  ["system/Patient.read system/Appointment.read system/Coverage.read system/Practitioner.read system/Organization.read", "Demographics, appointments and insurance"],
  ["system/Patient.read system/Observation.read", "Clients and results (labs, vitals, screening scores)"],
  ["system/Patient.read system/MedicationRequest.read system/MedicationStatement.read system/AllergyIntolerance.read", "Clients, medications and allergies"],
];
const SMART_PRESETS = [
  ["launch/patient openid fhirUser patient/*.read patient/*.rs", "One client at a time (the staff member picks the client)"],
  ["launch/patient openid fhirUser patient/*.read patient/*.rs user/*.read user/*.rs", "One client at a time, or any client the staff member can see"],
];

function validJwks(text) {
  try {
    const set = JSON.parse(text);
    if (!Array.isArray(set.keys) || !set.keys.length) return null;
    for (const k of set.keys) {
      if (k.d || k.p || k.q) return null; // private key material must never be pasted here
      crypto.createPublicKey({ key: k, format: "jwk" });
    }
    return JSON.stringify({ keys: set.keys });
  } catch { return null; }
}

function apiPage(req, res, { created = null, error = null } = {}, status = 200) {
  const clients = req.db.prepare("SELECT c.*, u.name AS creator FROM fhir_clients c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.revoked_at IS NOT NULL, c.id DESC").all();
  const base = A.baseUrl(req);
  const opt = (list) => list.map(([v, l]) => html`<option value="${v}">${l}</option>`);
  res.status(status).send(page(req, { title: "API access (FHIR)", active: "admin", body: html`
    <div class="page-head"><div><h1>API access (FHIR)</h1><p>Let other systems and apps read records in the standard FHIR R4 format (US Core). Read-only.</p></div>
      <a class="btn btn--sm" href="/ehr/admin">Back to administration</a></div>
    ${created ? html`<div class="alert alert--success" role="status"><strong>${created.name} is registered.</strong>
      <dl class="kv"><dt>Client ID</dt><dd><code>${created.client_id}</code></dd>${created.secret ? html`<dt>Client secret (copy it now: it won't be shown again)</dt><dd><code>${created.secret}</code></dd>` : ""}</dl></div>` : ""}
    ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
    <section class="card stack">
      <h2>Addresses to give developers</h2>
      <dl class="kv">
        <dt>FHIR base URL</dt><dd><code>${base}</code></dd>
        <dt>Capability statement</dt><dd><a href="${base}/metadata"><code>${base}/metadata</code></a></dd>
        <dt>SMART configuration</dt><dd><code>${base}/.well-known/smart-configuration</code></dd>
        <dt>Token endpoint</dt><dd><code>${base}/auth/token</code></dd>
        <dt>Bulk export</dt><dd><code>${base}/Group/all/$export</code></dd>
      </dl>
      <p class="small muted">Only connect parties covered by a business associate agreement, or another HIPAA-permitted purpose. Psychotherapy notes are never shared. Every request is in the audit log.</p>
    </section>
    <div class="grid grid--2">
      <form class="card stack" method="post" action="/ehr/admin/api/clients">
        ${csrfField(req)}<input type="hidden" name="kind" value="backend"><h2>Backend service</h2>
        <p class="muted small">A system with no user signing in: a data warehouse, an HIE, a lab, a payer. Uses system/ scopes and bulk export.</p>
        <label>Name<input type="text" name="name" maxlength="80" required placeholder="e.g. Example HIE"></label>
        <label>Access <select name="scopes">${opt(BACKEND_PRESETS)}</select></label>
        <label>Public key set (JWKS) <span class="hint">Optional. Paste their public keys (RS384 or ES384) to use signed sign-in instead of a secret.</span><textarea name="jwks" rows="3" placeholder='{"keys":[...]}'></textarea></label>
        <label class="check"><input type="checkbox" name="include_part2" value="1"> Include substance use disorder records (42 CFR Part 2). Only with the client's written consent or another Part 2 exception.</label>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Register backend service</button></div>
      </form>
      <form class="card stack" method="post" action="/ehr/admin/api/clients">
        ${csrfField(req)}<input type="hidden" name="kind" value="smart"><h2>SMART app</h2>
        <p class="muted small">An app a staff member opens and signs in to with their ChartReady account (SMART on FHIR standalone launch).</p>
        <label>App name<input type="text" name="name" maxlength="80" required placeholder="e.g. Outcomes dashboard"></label>
        <label>Redirect URIs <span class="hint">One per line, exactly as the app sends them. Must be https (http only for localhost).</span><textarea name="redirect_uris" rows="2" required></textarea></label>
        <label>Access <select name="scopes">${opt(SMART_PRESETS)}</select></label>
        <label>App type <select name="public_client"><option value="0">Confidential (has a server; gets a secret)</option><option value="1">Public (runs only in a browser or on a phone; uses PKCE)</option></select></label>
        <label>Public key set (JWKS) <span class="hint">Optional, for confidential apps that sign in with a key instead of a secret.</span><textarea name="jwks" rows="2" placeholder='{"keys":[...]}'></textarea></label>
        <label class="check"><input type="checkbox" name="include_part2" value="1"> Include substance use disorder records (42 CFR Part 2).</label>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Register app</button></div>
      </form>
    </div>
    <section class="card">
      <h2>Registered</h2>
      ${clients.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Client ID</th><th>Type</th><th>Access</th><th>Last used</th><th></th></tr></thead>
        <tbody>${clients.map((c) => html`<tr class="${c.revoked_at ? "is-voided" : ""}">
          <td>${c.name}<br><span class="small muted">by ${c.creator || "—"} · ${fmtTimestamp(c.created_at)}</span></td>
          <td><code>${c.client_id}</code></td>
          <td class="small">${c.kind === "smart" ? `SMART app${c.public_client ? " (public)" : ""}` : "Backend service"}${c.jwks ? html`<br>signed sign-in` : ""}</td>
          <td class="small">${c.scopes.split(" ").join(", ")}${c.include_part2 ? html`<br><span class="badge badge--warn">Includes Part 2</span>` : ""}${c.redirect_uris ? html`<br><span class="muted">${c.redirect_uris.split(/\s+/).join(", ")}</span>` : ""}</td>
          <td class="small">${c.last_used_at ? fmtTimestamp(c.last_used_at) : "Never"}</td>
          <td>${c.revoked_at ? html`<span class="badge badge--neutral">Revoked</span>` : html`
            <form method="post" action="/ehr/admin/api/clients/${c.id}/revoke" data-confirm="Revoke this client? It stops working immediately.">${csrfField(req)}<button class="btn btn--sm btn--danger" type="submit">Revoke</button></form>`}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing registered yet.</p>`}
    </section>` }));
}

router.get("/admin/api", adminOnly, (req, res) => apiPage(req, res));

router.post("/admin/api/clients", adminOnly, (req, res) => {
  const b = req.body || {};
  const kind = b.kind === "smart" ? "smart" : "backend";
  const name = String(b.name || "").trim().slice(0, 80);
  const presets = (kind === "smart" ? SMART_PRESETS : BACKEND_PRESETS).map(([v]) => v);
  // Older form posts (and tests) may send a custom scope list; keep only valid scopes for this kind.
  const scopes = String(b.scopes || presets[0]).trim().split(/\s+/)
    .filter((s) => (kind === "smart" ? /^(patient|user)\//.test(s) || A.EXTRA_SCOPES.includes(s) : s.startsWith("system/")) && (A.SCOPE_RE.test(s) || A.EXTRA_SCOPES.includes(s)));
  if (!name) return apiPage(req, res, { error: "Give it a name." }, 400);
  if (!scopes.length) return apiPage(req, res, { error: "Choose what it can access." }, 400);
  let jwks = null;
  if (String(b.jwks || "").trim()) {
    jwks = validJwks(String(b.jwks).trim());
    if (!jwks) return apiPage(req, res, { error: "The public key set isn't a valid JWKS of public keys." }, 400);
  }
  const isPublic = kind === "smart" && b.public_client === "1" ? 1 : 0;
  let redirects = null;
  if (kind === "smart") {
    const list = String(b.redirect_uris || "").split(/\s+/).filter(Boolean);
    const bad = list.filter((u) => { try { const x = new URL(u); return !(x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname))) || x.hash; } catch { return true; } });
    if (!list.length || bad.length) return apiPage(req, res, { error: "Enter at least one https redirect URI (http is allowed only for localhost), without a #fragment." }, 400);
    redirects = list.join("\n");
  }
  const clientId = `cr_${crypto.randomBytes(9).toString("base64url")}`;
  const secret = crypto.randomBytes(30).toString("base64url");
  const part2 = b.include_part2 === "1" ? 1 : 0;
  const id = Number(req.db.prepare("INSERT INTO fhir_clients (name, client_id, secret_hash, scopes, include_part2, created_by, kind, redirect_uris, public_client, jwks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(name, clientId, hashPassword(secret), scopes.join(" "), part2, req.user.id, kind, redirects, isPublic, jwks).lastInsertRowid);
  audit(req, "create", "fhir_client", id, null, `${clientId} ${kind}${part2 ? " part2" : ""}`);
  apiPage(req, res, { created: { name, client_id: clientId, secret: isPublic ? null : secret } });
});

router.post("/admin/api/clients/:id/revoke", adminOnly, (req, res) => {
  const c = req.db.prepare("SELECT * FROM fhir_clients WHERE id = ? AND revoked_at IS NULL").get(Number(req.params.id) || -1);
  if (c) {
    req.db.prepare("UPDATE fhir_clients SET revoked_at = datetime('now') WHERE id = ?").run(c.id);
    req.db.prepare("DELETE FROM fhir_tokens WHERE client_ref = ?").run(c.id);
    audit(req, "revoke", "fhir_client", c.id, null, c.client_id);
    req.flash("success", `${c.name} revoked.`);
  }
  res.redirect("/ehr/admin/api");
});

module.exports = { router, fhirRouter, resetFhirRateLimit: A.resetFhirRateLimit, localDateTime: R.localDateTime, patientResource: R.patientResource };
