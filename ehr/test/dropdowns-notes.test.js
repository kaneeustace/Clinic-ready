"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid;
before(async () => {
  t = await start(); pid = t.ctx.patients[1];
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
  t.db.prepare("INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at) VALUES (?, ?, 'active', date('now'), date('now', '+90 days'), datetime('now'))").run(pid, t.ctx.users.therapist);
});
after(async () => { await t.stop(); });

const noteIdFrom = (res) => Number((res.location || "").match(/\/ehr\/notes\/(\d+)$/)[1]);
const content = (id) => JSON.parse(t.db.prepare("SELECT content FROM notes WHERE id = ?").get(id).content);
async function create(c, fields) {
  const r = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...fields });
  assert.equal(r.status, 302, r.text.slice(0, 400));
  return noteIdFrom(r);
}
const intake = (extra = {}) => ({ type: "intake", format: "intake", presenting_problem: "Worry", hpi: "Six months of worry",
  diagnostic_impression: "GAD", recommendations: "Weekly CBT", risk_level: "low", ...extra });

test("MSE renders as dropdowns with an Other box", async () => {
  const c = await t.login("therapist");
  const r = await c.get(`/ehr/patients/${pid}/notes/new?type=intake`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<select id="mse_mood" name="mse_mood"/);
  assert.match(r.text, /<option value="Anxious">Anxious<\/option>/);
  assert.match(r.text, /<option value="" selected>Not assessed<\/option>/);
  assert.match(r.text, /name="mse_affect_other"/);
  const p = await c.get(`/ehr/patients/${pid}/notes/new?type=psychiatry`);
  assert.match(p.text, /<select id="mse_appearance" name="mse_appearance"/);
});

test("MSE saves list picks and Other text as plain strings; edit form re-selects them", async () => {
  const c = await t.login("therapist");
  const id = await create(c, intake({ mse_mood: "Anxious", mse_affect: "__other", mse_affect_other: "Bright", mse_appearance: "Well-groomed" }));
  const k = content(id);
  assert.equal(k.mse_mood, "Anxious");
  assert.equal(k.mse_affect, "Bright");
  assert.equal(k.mse_appearance, "Well-groomed");
  assert.equal(k.mse_speech, "");
  assert.ok(!("mse_affect_other" in k));
  const e = await c.get(`/ehr/notes/${id}/edit`);
  assert.equal(e.status, 200);
  assert.match(e.text, /<option value="Anxious" selected>Anxious<\/option>/);
  assert.match(e.text, /<option value="__other" selected>Other \(type it\)<\/option>/);
  assert.match(e.text, /name="mse_affect_other" id="mse_affect_other" value="Bright"/);
  // An older free-text value (posted directly) is kept and shows in the Other box.
  const old = await create(c, intake({ mse_mood: "\"Better\" per client" }));
  assert.equal(content(old).mse_mood, "\"Better\" per client");
  const e2 = await c.get(`/ehr/notes/${old}/edit`);
  assert.match(e2.text, /name="mse_mood_other" id="mse_mood_other" value="&quot;Better&quot; per client"/);
  // The read view shows the stored strings.
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /<dd>Bright<\/dd>/);
});

test("contact note: who/how dropdowns store combined text in contact_with and sign", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${pid}/notes/new?type=contact`);
  assert.match(f.text, /<select id="contact_who" name="contact_who"/);
  assert.match(f.text, /<select id="contact_how" name="contact_how"/);
  const id = await create(c, { type: "contact", format: "narrative", contact_who: "Primary care provider", contact_how: "Phone", narrative: "Coordinated meds" });
  const k = content(id);
  assert.equal(k.contact_with, "Primary care provider · Phone");
  assert.equal(k.contact_who, "Primary care provider");
  assert.equal(k.contact_how, "Phone");
  const e = await c.get(`/ehr/notes/${id}/edit`);
  assert.match(e.text, /<option value="Primary care provider" selected>/);
  assert.match(e.text, /<option value="Phone" selected>/);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Primary care provider · Phone/);

  // Who without a method can't be signed; a method outside the list is rejected.
  const half = await create(c, { type: "contact", format: "narrative", contact_who: "Client", narrative: "Brief check-in" });
  const s = await c.post(`/ehr/notes/${half}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Contact method is required/);
  const bad = await c.post(`/ehr/patients/${pid}/notes`, { type: "contact", format: "narrative", service_date: "2026-11-02", contact_who: "Client", contact_how: "Carrier pigeon", narrative: "x" });
  assert.equal(bad.status, 400);

  // Nothing chosen: required to sign.
  const none = await create(c, { type: "contact", format: "narrative", narrative: "Left a note" });
  const s2 = await c.post(`/ehr/notes/${none}/sign`, { password: PW });
  assert.equal(s2.status, 400);
  assert.match(s2.text, /Contact with \/ method is required/);

  // Typed Other contact and older combined text (contact_with only) still sign.
  const other = await create(c, { type: "contact", format: "narrative", contact_who: "__other", contact_who_other: "School counselor", contact_how: "Email", narrative: "IEP" });
  assert.equal(content(other).contact_with, "School counselor · Email");
  const legacy = await create(c, { type: "contact", format: "narrative", contact_with: "Patient by phone", narrative: "Older client" });
  assert.equal(content(legacy).contact_with, "Patient by phone");
  const le = await c.get(`/ehr/notes/${legacy}/edit`);
  assert.match(le.text, /name="contact_who_other" id="contact_who_other" value="Patient by phone"/);
  assert.equal((await c.post(`/ehr/notes/${legacy}/sign`, { password: PW })).status, 302);
});

test("discharge reason is a dropdown with Other, stored in discharge_reason", async () => {
  const c = await t.login("therapist");
  const f = await c.get(`/ehr/patients/${pid}/notes/new?type=discharge`);
  assert.match(f.text, /<select id="discharge_reason" name="discharge_reason"/);
  assert.match(f.text, /<option value="Treatment goals met">/);
  const base = { type: "discharge", format: "narrative", treatment_summary: "12 sessions of CBT", discharge_status: "Stable", recommendations: "PCP follow-up" };
  const id = await create(c, { ...base, discharge_reason: "Treatment goals met" });
  assert.equal(content(id).discharge_reason, "Treatment goals met");
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const o = await create(c, { ...base, discharge_reason: "__other", discharge_reason_other: "Moved out of state" });
  assert.equal(content(o).discharge_reason, "Moved out of state");
  const blank = await create(c, base);
  const s = await c.post(`/ehr/notes/${blank}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Reason for discharge is required/);
});
