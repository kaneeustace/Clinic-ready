"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid;
before(async () => { t = await start(); pid = t.ctx.patients[1]; });
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
    ["asam", /Dimension 6: Recovery/], ["roi", /42 CFR Part 2/]]) {
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

test("ASAM: ratings validated and required, level shown", async () => {
  const c = await t.login("therapist");
  const bad = await c.post(`/ehr/patients/${pid}/notes`, { type: "asam", format: "asam", service_date: "2026-11-02", dim1_rating: "7" });
  assert.equal(bad.status, 400);
  const fields = { type: "asam", format: "asam", substance_history: "Alcohol daily", recommended_level: "2.1", level_justification: "Dims 3 and 5 elevated", risk_level: "low" };
  for (let i = 1; i <= 6; i++) { fields[`dim${i}_rating`] = String(i % 5); fields[`dim${i}`] = `Findings ${i}`; }
  const missing = await c.post(`/ehr/patients/${pid}/notes`, { service_date: "2026-11-02", ...fields, dim4: "" });
  const mid = noteIdFrom(missing);
  const s = await c.post(`/ehr/notes/${mid}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Dimension 4: Readiness to change: narrative is required/);
  const id = await createAndSign(c, fields);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /2\.1 Intensive outpatient/);
  assert.match(v.text, /4: Severe/);
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
