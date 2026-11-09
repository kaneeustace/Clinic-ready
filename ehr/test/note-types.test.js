"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid;
before(async () => {
  t = await start(); pid = t.ctx.patients[1];
  // Keep these template tests independent of seeded treatment plans (the golden-thread sign rule
  // is covered in golden-thread.test.js).
  t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
});
after(async () => { await t.stop(); });

const noteIdFrom = (res) => Number((res.location || "").match(/\/ehr\/notes\/(\d+)$/)[1]);

async function createAndSign(c, fields) {
  const r = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...fields });
  assert.equal(r.status, 302, r.text.slice(0, 400));
  const id = noteIdFrom(r);
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 302, s.text.slice(0, 600));
  assert.equal(t.db.prepare("SELECT status FROM notes WHERE id = ?").get(id).status, "signed");
  return id;
}

test("new note types render their forms", async () => {
  const c = await t.login("therapist");
  for (const [type, marker] of [["group", /Client participation and response/], ["safety_plan", /Warning signs/],
    ["asam", /Dimension 6: Person-Centered Considerations/], ["roi", /42 CFR Part 2/]]) {
    const r = await c.get(`/ehr/patients/${pid}/notes/new?type=${type}`);
    assert.equal(r.status, 200, type);
    assert.match(r.text, marker, type);
  }
  const sp = await c.get(`/ehr/patients/${pid}/notes/new?type=safety_plan`);
  assert.match(sp.text, /988 Suicide &amp; Crisis Lifeline/);
});

test("group note: create, sign, view", async () => {
  const c = await t.login("therapist");
  const id = await createAndSign(c, {
    type: "group", format: "group", group_name: "DBT skills", group_topic: "Distress tolerance", session_start: "17:00", session_end: "18:30",
    attendance: "6 of 8", group_content: "TIPP skills", participation: "Engaged, practiced paced breathing", interventions: ["DBT skills"],
    plan: "Continue weekly", risk_level: "none",
  });
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Group note/);
  assert.match(v.text, /Distress tolerance/);
});

test("safety plan requires core steps to sign", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, { type: "safety_plan", format: "safety_plan", service_date: "2026-11-02", warning_signs: "Isolating" });
  const id = noteIdFrom(r);
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Things I can do on my own to cope is required/);
  await createAndSign(c, {
    type: "safety_plan", format: "safety_plan", warning_signs: "Isolating", coping_strategies: "Walk", help_contacts: "Sibling",
    professional_contacts: "988", means_safety: "Meds locked by partner", risk_level: "moderate", risk_narrative: "Passive SI, no plan or intent",
  });
});

function asamFields(extra = {}) {
  const fields = { type: "asam", format: "asam", asam_edition: "4", substance_history: "Alcohol daily", indicated_level: "2.1",
    level_justification: "Dims 3 and 5 elevated", risk_level: "low", ...extra };
  for (let i = 1; i <= 6; i++) { fields[`dim${i}_rating`] ??= String(i % 5); fields[`dim${i}`] ??= `Findings ${i}`; }
  return fields;
}

test("ASAM form: 4th edition default, both label sets, 4th-edition levels and verification hint", async () => {
  const c = await t.login("therapist");
  const r = await c.get(`/ehr/patients/${pid}/notes/new?type=asam`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<option value="4"\s+selected>4th edition/);
  assert.match(r.text, /Dimension 1: Intoxication, Withdrawal &amp; Addiction Medications/);
  assert.match(r.text, /Dimension 3: Psychiatric &amp; Cognitive Conditions/);
  assert.match(r.text, /Dimension 4: Readiness to change/); // 3rd-edition label present (hidden) for the switch
  assert.match(r.text, /Indicated level of care/);
  assert.match(r.text, /Adjusted level of care \(after Person-Centered Considerations/);
  assert.match(r.text, /1\.7 Medically managed outpatient/);
  assert.match(r.text, /2\.7 Medically managed intensive outpatient/);
  assert.match(r.text, /verify them against your licensed copy/);
  assert.match(r.text, /name="dim6_driver"/);
  assert.match(r.text, /Dimensional driver of level of care/);
  assert.doesNotMatch(r.text, /name="recommended_level"/);
});

test("ASAM: ratings validated, indicated level required, edition-specific levels", async () => {
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/notes`, { type: "asam", format: "asam", service_date: "2026-11-02", dim1_rating: "7" });
  assert.equal(bad.status, 400);
  // 3rd-edition-only levels are rejected on a 4th-edition note, and vice versa.
  const php = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...asamFields({ indicated_level: "2.5_php" }) });
  assert.equal(php.status, 400);
  assert.match(php.text, /isn&#39;t a level in the 4th edition/);
  const lvl17 = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...asamFields({ asam_edition: "3", indicated_level: "1.7" }) });
  assert.equal(lvl17.status, 400);
  // Missing narrative and missing indicated level block signing (4th-edition label in the message).
  const missing = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...asamFields({ dim4: "", indicated_level: "" }) });
  const mid = noteIdFrom(missing);
  const s = await c.post(`/ehr/notes/${mid}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Dimension 4: Substance Use-Related Risks: narrative is required/);
  assert.match(s.text, /Indicated level of care is required/);
});

test("ASAM: differing adjusted level requires a reason; read view shows 4th-edition labels and drivers", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...asamFields({ adjusted_level: "1.5", dim5_driver: "1" }) });
  assert.equal(r.status, 302);
  const id = noteIdFrom(r);
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Explain why the adjusted level of care differs from the indicated level/);
  const e = await c.post(`/ehr/notes/${id}/edit`, { service_date: "2026-11-02",
    ...asamFields({ adjusted_level: "1.5", dim5_driver: "1", level_difference_reason: "Client prefers outpatient; IOP waitlist." }) });
  assert.equal(e.status, 302);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /4th edition \(2023\)/);
  assert.match(v.text, /Dimension 5: Recovery Environment Interactions <span class="pill">Dimensional driver/);
  assert.doesNotMatch(v.text, /Readiness to change/);
  assert.match(v.text, /2\.1 Intensive outpatient/);
  assert.match(v.text, /1\.5 Outpatient therapy/);
  assert.match(v.text, /Client prefers outpatient; IOP waitlist\./);
  assert.match(v.text, /4: Severe/);
  // Same indicated and adjusted level: no reason needed.
  await createAndSign(c, asamFields({ adjusted_level: "2.1" }));
});

test("ASAM: 3rd-edition note signs with 3rd-edition levels", async () => {
  const c = await t.login("therapist");
  const id = await createAndSign(c, asamFields({ asam_edition: "3", indicated_level: "2.5_php" }));
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Dimension 4: Readiness to change/);
  assert.match(v.text, /2\.5 Partial hospitalization \(3rd edition\)/);
});

test("ASAM: legacy note (no edition, recommended_level) still renders with 3rd-edition labels", async () => {
  const c = await t.login("therapist");
  const content = { substance_history: "Legacy history", recommended_level: "2.5", level_justification: "Legacy justification",
    actual_level: "2.1 due to availability" };
  for (let i = 1; i <= 6; i++) { content[`dim${i}_rating`] = "2"; content[`dim${i}`] = `Legacy findings ${i}`; }
  const id = Number(t.db.prepare(
    `INSERT INTO notes (patient_id, author_id, type, format, content, risk_level, status, service_date, signed_at, signed_by)
     VALUES (?, ?, 'asam', 'asam', ?, 'low', 'signed', '2025-06-01', datetime('now'), ?)`).run(pid, c.userId, JSON.stringify(content), c.userId).lastInsertRowid);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.equal(v.status, 200);
  assert.match(v.text, /Dimension 1: Acute intoxication and\/or withdrawal potential/);
  assert.match(v.text, /Dimension 6: Recovery \/ living environment/);
  assert.doesNotMatch(v.text, /Person-Centered Considerations/);
  assert.match(v.text, /Recommended level of care/);
  assert.match(v.text, /2\.5 Partial hospitalization \(PHP\)/);
  assert.match(v.text, /2\.1 due to availability/);
  assert.match(v.text, /3rd edition \(recorded before edition selection\)/);
  assert.doesNotMatch(v.text, /Indicated level of care/);
});

test("ROI: invalid option rejected; Part 2 notice when SUD records included", async () => {
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/notes`, { type: "roi", format: "roi", service_date: "2026-11-02", direction: "sideways" });
  assert.equal(bad.status, 400);
  const id = await createAndSign(c, {
    type: "roi", format: "roi", direction: "release_to", recipient: "Dr. Example, Sample Primary Care", information: "Attendance and diagnosis",
    purpose: "Care coordination", expires_on: "2027-11-02", includes_sud: "yes", consent_method: "signed_paper",
    signed_by: "Client", signed_on: "2026-11-02",
  });
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Release information TO this recipient/);
  assert.match(v.text, /42 CFR Part 2:/);
});

test("front desk cannot open new note types", async () => {
  const c = await t.login("frontdesk");
  assert.equal((await c.get(`/ehr/patients/${pid}/notes/new?type=roi`)).status, 403);
});
