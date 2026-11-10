"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const ai = require("../src/ai-review");
const { pageCount } = require("../src/routes/scan");

let t, lastReq = null;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const dataUrl = (buf, mime = "application/pdf") => `data:${mime};base64,${buf.toString("base64")}`;

before(async () => {
  t = await start();
  ai.setClient({ beta: { messages: { create: async (body) => {
    lastReq = body;
    return { stop_reason: "end_turn", model: "claude-test", content: [{ type: "text", text: JSON.stringify({
      summary: "Missing session times and the response to interventions.",
      findings: [{ severity: "high", category: "Time", issue: "No start/stop times for a 90837 claim.", suggestion: "Document actual start and stop times.", quote: "" }],
    }) }] };
  } } } });
});
after(async () => { ai.setClient(null); await t.stop(); });

test("upload a PDF: sent to the AI as a document, findings shown, nothing stored", async () => {
  const c = await t.login("therapist");
  const form = await c.get("/ehr/scan");
  assert.equal(form.status, 200);
  assert.match(form.text, /Note scanner/);
  const before = t.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n;
  const r = await c.post("/ehr/scan", { pdf_data: dataUrl(PDF), payer: "ahcccs", note_type: "group", context: "Billed 90853" });
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.match(r.text, /Missing session times/);
  assert.match(r.text, /No start\/stop times/);
  assert.match(r.text, /1 page/);
  const doc = lastReq.messages[0].content[0];
  assert.equal(doc.type, "document");
  assert.equal(doc.source.media_type, "application/pdf");
  assert.equal(Buffer.from(doc.source.data, "base64").toString("latin1", 0, 5), "%PDF-");
  assert.match(lastReq.messages[0].content[1].text, /AHCCCS/);
  assert.match(lastReq.messages[0].content[1].text, /Billed 90853/);
  assert.match(lastReq.system, /AMPM 940/);
  assert.match(lastReq.system, /PDF document/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, before);
  const a = t.db.prepare("SELECT detail FROM audit_log WHERE action = 'scan_pdf' ORDER BY id DESC LIMIT 1").get();
  assert.match(a.detail, /ahcccs; 1 pages/);
});

test("large PDFs go through the upload limit; non-PDFs and oversize files are refused", async () => {
  const c = await t.login("therapist");
  const big = Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024, 32)]);
  assert.equal((await c.post("/ehr/scan", { pdf_data: dataUrl(big), payer: "commercial" })).status, 200);
  const notPdf = await c.post("/ehr/scan", { pdf_data: dataUrl(Buffer.from("<html>hi</html>")), payer: "commercial" });
  assert.equal(notPdf.status, 400);
  assert.match(notPdf.text, /isn&#39;t a PDF|isn't a PDF/);
  const huge = Buffer.concat([PDF, Buffer.alloc(10.5 * 1024 * 1024, 32)]);
  const r = await c.post("/ehr/scan", { pdf_data: dataUrl(huge), payer: "commercial" });
  assert.equal(r.status, 400);
  assert.match(r.text, /too large/);
  assert.equal((await c.post("/ehr/scan", { payer: "commercial" })).status, 400);
});

test("only clinical staff can scan; AI errors are explained", async () => {
  const fd = await t.login("frontdesk");
  assert.equal((await fd.get("/ehr/scan")).status, 403);
  ai.setClient({ beta: { messages: { create: async () => { const e = new Error("Your credit balance is too low"); e.status = 400; throw e; } } } });
  const c = await t.login("therapist");
  const r = await c.post("/ehr/scan", { pdf_data: dataUrl(PDF), payer: "commercial" });
  assert.equal(r.status, 502);
  assert.match(r.text, /no API credits/);
  assert.equal(pageCount(Buffer.from("/Type /Pages /Type /Page /Type /Page")), 2);
});
