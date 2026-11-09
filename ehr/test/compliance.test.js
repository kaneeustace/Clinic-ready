"use strict";
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const ai = require("../src/ai-review");

let t, pid;
before(async () => {
  t = await start();
  pid = t.ctx.patients[0];
  // Progress notes need an active plan.
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
  t.db.prepare("INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at) VALUES (?, ?, 'active', date('now'), date('now','+90 days'), datetime('now'))")
    .run(pid, t.ctx.users.therapist);
});
after(async () => { await t.stop(); });
afterEach(() => ai.setClient(null));

function insertNote(content, extra = {}) {
  const appt = t.db.prepare("SELECT id FROM appointments WHERE patient_id = ? ORDER BY id LIMIT 1").get(pid);
  return Number(t.db.prepare(`INSERT INTO notes (patient_id, appointment_id, author_id, type, format, content, risk_level, status, service_date)
    VALUES (?, ?, ?, 'progress', 'dap', ?, ?, 'draft', '2026-11-02')`)
    .run(pid, extra.noAppt ? null : appt.id, t.ctx.users.therapist, JSON.stringify(content), extra.risk === undefined ? "low" : extra.risk).lastInsertRowid);
}

test("rule checks: CPT time mismatch, missing times, telehealth modifier, vague wording, no risk", () => {
  const ctx = {
    note_type: "progress", session_minutes: 40, risk_level: null, appointment: { modality: "telehealth" },
    charges: [{ cpt: "90837", modifier: null }], diagnoses: [{ code: "F41.1" }], treatment_plan: { active: true },
    objectives_addressed: 1, content: { data: "Client is doing well and vented about work.", interventions: ["CBT"] },
  };
  const f = ai.ruleChecks(ctx);
  const cats = f.map((x) => x.issue).join(" | ");
  assert.match(cats, /CPT 90837 requires 53\+ minutes, but the note documents 40 minutes/);
  assert.match(cats, /without a telehealth modifier/);
  assert.match(cats, /No risk assessment level/);
  assert.match(cats, /Vague phrasing/);
  assert.match(cats, /doesn't describe current symptoms/);
  const missing = ai.ruleChecks({ ...ctx, session_minutes: null, charges: [] });
  assert.ok(missing.some((x) => /start and end times are missing/.test(x.issue)));
  const good = ai.ruleChecks({ ...ctx, session_minutes: 55, risk_level: "none", appointment: { modality: "in_person" },
    content: { data: "PHQ-9 down from 18 to 12; sleep improved; practiced cognitive restructuring.", interventions: ["CBT"] } });
  assert.equal(good.length, 0);
});

test("button runs rule checks without AI configured and is audited", async () => {
  const c = await t.login("therapist");
  const id = insertNote({ data: "Went well.", assessment: "", plan: "", interventions: [] }, { risk: null });
  const view = await c.get(`/ehr/notes/${id}`);
  assert.match(view.text, /Check insurance compliance/);
  const r = await c.post(`/ehr/notes/${id}/compliance-review`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Insurance compliance check/);
  assert.match(r.text, /Rule-based checks only/);
  assert.match(r.text, /start and end times are missing/);
  const row = t.db.prepare("SELECT detail FROM audit_log WHERE action = 'compliance_review' AND entity_id = ?").get(id);
  assert.match(row.detail, /ai:off/);
  // Note content unchanged
  assert.equal(JSON.parse(t.db.prepare("SELECT content FROM notes WHERE id = ?").get(id).content).data, "Went well.");
});

test("AI findings are shown and no direct identifiers are sent", async () => {
  let sent;
  ai.setClient({ beta: { messages: { create: async (req) => {
    sent = req;
    return { stop_reason: "end_turn", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify({
      summary: "Plan linkage is weak.",
      findings: [{ severity: "high", category: "Treatment plan", issue: "Progress toward goals isn't described.", suggestion: "Describe progress on the anxiety objective.", quote: "Went well." }],
    }) }] };
  } } } });
  const c = await t.login("therapist");
  const id = insertNote({ data: "Went well.", session_start: "10:00", session_end: "10:55", interventions: ["CBT"] });
  const r = await c.post(`/ehr/notes/${id}/compliance-review`);
  assert.equal(r.status, 200);
  assert.match(r.text, /AI summary:<\/strong> Plan linkage is weak\./);
  assert.match(r.text, /Progress toward goals isn&#39;t described\./);
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.equal(sent.fallbacks, "default");
  const patient = t.db.prepare("SELECT * FROM patients WHERE id = ?").get(pid);
  const payload = JSON.stringify(sent);
  for (const ident of [patient.first_name, patient.last_name, patient.mrn, patient.dob]) assert.ok(!payload.includes(ident), `leaked ${ident}`);
});

test("AI refusal and API errors degrade to rule checks", async () => {
  const c = await t.login("therapist");
  const id = insertNote({ data: "Went well." });
  ai.setClient({ beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } });
  assert.match((await c.post(`/ehr/notes/${id}/compliance-review`)).text, /declined this request/);
  ai.setClient({ beta: { messages: { create: async () => { const e = new Error("rate"); e.status = 429; throw e; } } } });
  const r = await c.post(`/ehr/notes/${id}/compliance-review`);
  assert.equal(r.status, 200);
  assert.match(r.text, /busy \(rate limited\)/);
  assert.match(r.text, /Rule|start and end times/);
  ai.setClient({ beta: { messages: { create: async () => { const e = new Error("Your credit balance is too low to access the Anthropic API."); e.status = 400; throw e; } } } });
  assert.match((await c.post(`/ehr/notes/${id}/compliance-review`)).text, /has no API credits/);
});

test("front desk and billing cannot run compliance checks", async () => {
  const id = insertNote({ data: "x" });
  for (const role of ["frontdesk", "billing"]) {
    const r = await (await t.login(role)).post(`/ehr/notes/${id}/compliance-review`);
    assert.equal(r.status, 403, role);
  }
});
