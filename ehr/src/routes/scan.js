"use strict";
/*
 * Note scanner: upload a PDF of a clinical note (from another system, or scanned from paper) and get the same
 * AI insurance-compliance review the "Check insurance compliance" button gives for EHR notes.
 *
 *   GET  /scan     upload form
 *   POST /scan     review the PDF (image_data = data:application/pdf;base64,... built by ehr.js)
 *
 * The PDF is sent to the AI reviewer (Anthropic, under the BAA) and then discarded: it is never written to the
 * database or disk. The audit log records size and page count only (never the file name, which can contain PHI).
 * Who: clinical:write.
 */
const express = require("express");
const { requirePerm } = require("../auth");
const { audit } = require("../audit");
const { html, raw, page, csrfField } = require("../views");
const ai = require("../ai-review");
const { reviewPanel } = require("./notes");

const router = express.Router();
const MAX_BYTES = 10 * 1024 * 1024; // keep well under the API's request limit
const MAX_PAGES = 100;
const NOTE_TYPES = ["", "progress (psychotherapy)", "intake / diagnostic assessment", "group", "psychiatry / medication management",
  "case management", "peer support", "crisis", "treatment plan", "discharge summary", "other"];

/** Rough page count from the PDF structure (good enough for a limit check). */
function pageCount(buf) {
  const s = buf.toString("latin1");
  const n = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return n || 1;
}

function scanPage(req, res, { values = {}, error = null, review = null, file = null } = {}, status = 200) {
  const on = ai.aiStatus().enabled;
  res.status(status).send(page(req, {
    title: "Note scanner",
    active: "scan",
    body: html`
      <div class="page-head"><div><h1>Note scanner</h1><p>Upload a PDF note and the AI checks it for insurance compliance: medical necessity, plan linkage, interventions, response, risk, time and coding.</p></div></div>
      ${on ? "" : html`<div class="alert alert--warn" role="note">The note scanner uses AI review, which is turned off or not working.
        An administrator can check it under <a href="/ehr/admin#ai">Administration → AI note review</a>.</div>`}
      ${review ? html`${file ? html`<p class="muted small">Results for ${file.pages} page${file.pages === 1 ? "" : "s"} · ${Math.max(1, Math.round(file.bytes / 1024))} KB · ${{ commercial: "commercial", medicare: "Medicare", medicaid: "Medicaid", ahcccs: "AHCCCS" }[values.payer] || ""} rules</p>` : ""}${reviewPanel(review)}<h2 class="small muted" style="margin-top:1.5rem">Scan another PDF</h2>` : ""}
      <section class="card">
        ${error ? html`<div class="alert alert--error" role="alert">${error}</div>` : ""}
        <form method="post" action="/ehr/scan" class="stack" data-pdf-upload>
          ${csrfField(req)}
          <input type="hidden" name="pdf_data" value="">
          <div class="form-grid">
            <label class="span-all">PDF note
              <input type="file" accept="application/pdf,.pdf" data-pdf-file required>
              <span class="hint">Up to 10 MB and 100 pages. Scanned or handwritten notes work if they're legible.</span></label>
            <label>Payer
              <select name="payer">${Object.keys(ai.PDF_PAYERS).map((k) => html`<option value="${k}" ${k === (values.payer || "commercial") ? raw("selected") : ""}>${{ commercial: "Commercial insurance", medicare: "Medicare", medicaid: "Medicaid (other state)", ahcccs: "AHCCCS (Arizona Medicaid)" }[k]}</option>`)}</select></label>
            <label>Note type <span class="hint">(optional)</span>
              <select name="note_type">${NOTE_TYPES.map((t) => html`<option value="${t}" ${t === (values.note_type || "") ? raw("selected") : ""}>${t ? t[0].toUpperCase() + t.slice(1) : "Let the AI tell"}</option>`)}</select></label>
            <label class="span-all">Anything the reviewer should know <span class="hint">(optional, e.g. billed CPT 90837, telehealth)</span>
              <input type="text" name="context" maxlength="500" value="${values.context || ""}"></label>
          </div>
          <p class="hint" data-pdf-status role="status"></p>
          <div class="form-actions">
            <button class="btn btn--primary" type="submit" ${on ? "" : raw("disabled")}>Scan PDF</button>
            <span class="hint">The PDF is checked and then discarded. It isn't saved in the EHR.</span>
          </div>
          <noscript><p class="alert alert--warn">Uploading a PDF needs JavaScript turned on.</p></noscript>
        </form>
      </section>
`,
  }));
}

router.get("/scan", requirePerm("clinical:write"), (req, res) => scanPage(req, res));

router.post("/scan", requirePerm("clinical:write"), async (req, res) => {
  const b = req.body || {};
  const values = { payer: ai.PDF_PAYERS[b.payer] ? b.payer : "commercial", note_type: NOTE_TYPES.includes(b.note_type) ? b.note_type : "",
    context: String(b.context || "").trim().slice(0, 500) };
  const fail = (msg, code = 400) => scanPage(req, res, { values, error: msg }, code);
  const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.pdf_data || ""));
  if (!m) return fail("Choose a PDF file to scan.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 5 || buf.toString("latin1", 0, 5) !== "%PDF-") return fail("That file isn't a PDF.");
  if (buf.length > MAX_BYTES) return fail("That PDF is too large (10 MB max). Split it or scan at a lower resolution.");
  const pages = pageCount(buf);
  if (pages > MAX_PAGES) return fail(`That PDF has about ${pages} pages; the scanner takes up to ${MAX_PAGES}.`);
  if (!ai.aiStatus().enabled) return fail("AI review is turned off, so PDFs can't be scanned yet.", 503);
  const result = await ai.reviewPdf({ data: buf.toString("base64"), payer: values.payer, noteType: values.note_type, context: values.context });
  audit(req, "scan_pdf", null, null, null, `${values.payer}; ${pages} pages; ${Math.round(buf.length / 1024)} KB; ${result.ok ? `${result.findings.length} findings` : "error"}`);
  scanPage(req, res, { values, review: { rules: [], ai: result }, file: { pages, bytes: buf.length } }, result.ok ? 200 : 502);
});

module.exports = { router, pageCount };
