"use strict";
/*
 * FHIR Bulk Data Access ($export), for backend services with system/ scopes.
 *
 *   GET    /fhir/$export                     everything (system level)
 *   GET    /fhir/Patient/$export             all clients' compartments
 *   GET    /fhir/Group/all/$export           the "all clients" group
 *          (Prefer: respond-async required; _type and _since supported; output is application/fhir+ndjson)
 *   GET    /fhir/bulkstatus/:id              202 while running, then the manifest
 *   DELETE /fhir/bulkstatus/:id              cancel / delete
 *   GET    /fhir/bulkfiles/:id/:n.ndjson     one output file (same access token required)
 *
 * Output is kept for 24 hours. Privacy rules are the same as for single reads (see fhir/resources.js).
 */
const crypto = require("node:crypto");
const { audit } = require("../audit");
const R = require("./resources");
const { accessFor, baseUrl } = require("./auth");

const KEEP_HOURS = 24;
const NDJSON = "application/fhir+ndjson";

function outcome(res, status, code, diagnostics) {
  res.status(status).type("application/fhir+json").send(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] }));
}
function cleanup(db) {
  db.prepare(`DELETE FROM fhir_exports WHERE created_at < datetime('now', '-${KEEP_HOURS} hours')`).run();
  db.prepare("DELETE FROM fhir_export_files WHERE export_id NOT IN (SELECT id FROM fhir_exports)").run();
}

function kickoff(req, res, level) {
  const db = req.db;
  const token = req.fhirClient;
  if (token.kind !== "backend") return outcome(res, 403, "forbidden", "Bulk export is for backend services with system/ scopes.");
  if (!/respond-async/i.test(req.get("prefer") || "")) return outcome(res, 400, "invalid", "Send the header Prefer: respond-async.");
  const accept = req.get("accept");
  if (accept && !/application\/fhir\+json|application\/json|\*\/\*/.test(accept)) return outcome(res, 400, "invalid", "Accept must be application/fhir+json.");
  const fmt = req.query._outputFormat;
  if (fmt && !["application/fhir+ndjson", "application/ndjson", "ndjson"].includes(String(fmt))) return outcome(res, 400, "not-supported", "Only NDJSON output is supported.");
  let since = null;
  if (req.query._since) {
    since = String(req.query._since);
    if (Number.isNaN(Date.parse(since))) return outcome(res, 400, "invalid", "_since must be a FHIR instant, e.g. 2026-01-01T00:00:00Z.");
  }
  const defaults = level === "system" ? ["Patient", "Practitioner", "Organization", ...R.COMPARTMENT] : ["Patient", ...R.COMPARTMENT];
  const types = req.query._type ? String(req.query._type).split(",").map((s) => s.trim()).filter(Boolean) : defaults;
  const unknown = types.filter((t) => !R.TYPES.includes(t) || t === "Group");
  if (unknown.length) return outcome(res, 400, "not-supported", `Unsupported _type: ${unknown.join(", ")}`);
  const allowed = types.filter((t) => accessFor(token, t) === "all");
  if (!allowed.length) return outcome(res, 403, "forbidden", "The token's scopes don't cover the requested types.");

  cleanup(db);
  const id = crypto.randomBytes(16).toString("hex");
  const transactionTime = new Date().toISOString();
  const requestUrl = `${baseUrl(req)}${req.originalUrl.replace(/^\/fhir/, "")}`;
  db.prepare("INSERT INTO fhir_exports (id, client_ref, request_url, transaction_time) VALUES (?, ?, ?, ?)").run(id, token.id, requestUrl, transactionTime);
  audit(req, "fhir_export_start", "fhir_export", null, null, `client ${token.client_id} ${level} ${allowed.join(",")}`);

  // Build the files after responding; a clinic's data fits comfortably, so this runs in one pass.
  setImmediate(() => {
    try {
      const part2 = !!token.include_part2;
      const keep = (r) => !since || !r.meta || !r.meta.lastUpdated || r.meta.lastUpdated >= since;
      const insert = db.prepare("INSERT INTO fhir_export_files (export_id, n, type, count, ndjson) VALUES (?, ?, ?, ?, ?)");
      let n = 0, total = 0;
      for (const type of allowed) {
        let list;
        if (type === "Patient") list = db.prepare("SELECT * FROM patients ORDER BY id").all().map(R.patientResource);
        else if (type === "Practitioner") list = db.prepare("SELECT id, name, credentials, npi, active FROM users WHERE role IN ('clinician', 'admin') ORDER BY id").all().map(R.practitionerResource);
        else if (type === "Organization") list = [R.organizationResource(require("../clinic").getClinic(db))];
        else list = R.loadForPatient(db, type, null, { part2 });
        list = list.filter(keep);
        if (!list.length) continue;
        insert.run(id, ++n, type, list.length, list.map((r) => JSON.stringify(r)).join("\n") + "\n");
        total += list.length;
      }
      db.prepare("UPDATE fhir_exports SET status = 'done', completed_at = datetime('now') WHERE id = ?").run(id);
      audit({ db, user: null, ip: req.ip }, "fhir_export_done", "fhir_export", null, null, `client ${token.client_id} files=${n} resources=${total}`);
    } catch (err) {
      console.error("[fhir] export failed:", err);
      db.prepare("UPDATE fhir_exports SET status = 'error', error = ?, completed_at = datetime('now') WHERE id = ?").run("Export failed. It has been logged.", id);
    }
  });
  res.status(202).set("Content-Location", `${baseUrl(req)}/bulkstatus/${id}`).type("application/fhir+json")
    .send(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "Export started." }] }));
}

function mount(fhirRouter) {
  fhirRouter.get("/bulkstatus/:id", (req, res) => {
    cleanup(req.db);
    const job = req.db.prepare("SELECT * FROM fhir_exports WHERE id = ? AND client_ref = ?").get(String(req.params.id), req.fhirClient.id);
    if (!job) return outcome(res, 404, "not-found", "No such export (it may have expired).");
    if (job.status === "running") return res.status(202).set({ "X-Progress": "Building files", "Retry-After": "2" }).end();
    if (job.status === "error") return outcome(res, 500, "exception", job.error || "Export failed.");
    const files = req.db.prepare("SELECT n, type, count FROM fhir_export_files WHERE export_id = ? ORDER BY n").all(job.id);
    res.set("Expires", new Date(Date.parse(`${job.completed_at.replace(" ", "T")}Z`) + KEEP_HOURS * 3600e3).toUTCString()).json({
      transactionTime: job.transaction_time, request: job.request_url, requiresAccessToken: true,
      output: files.map((f) => ({ type: f.type, url: `${baseUrl(req)}/bulkfiles/${job.id}/${f.n}.ndjson`, count: f.count })), error: [],
    });
  });
  fhirRouter.delete("/bulkstatus/:id", (req, res) => {
    const r = req.db.prepare("DELETE FROM fhir_exports WHERE id = ? AND client_ref = ?").run(String(req.params.id), req.fhirClient.id);
    if (!r.changes) return outcome(res, 404, "not-found", "No such export.");
    req.db.prepare("DELETE FROM fhir_export_files WHERE export_id = ?").run(String(req.params.id));
    res.status(202).end();
  });
  fhirRouter.get("/bulkfiles/:id/:file", (req, res) => {
    const m = /^(\d+)\.ndjson$/.exec(req.params.file);
    const job = m && req.db.prepare("SELECT * FROM fhir_exports WHERE id = ? AND client_ref = ? AND status = 'done'").get(String(req.params.id), req.fhirClient.id);
    const f = job && req.db.prepare("SELECT * FROM fhir_export_files WHERE export_id = ? AND n = ?").get(job.id, Number(m[1]));
    if (!f) return outcome(res, 404, "not-found", "No such file.");
    audit(req, "fhir_export_download", "fhir_export", null, null, `client ${req.fhirClient.client_id} ${f.type} ${f.count}`);
    res.type(NDJSON).send(f.ndjson);
  });
}

module.exports = { kickoff, mount };
