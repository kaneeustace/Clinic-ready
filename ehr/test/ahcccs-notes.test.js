"use strict";
/* AHCCCS (Arizona Medicaid) note requirements: docs/ahcccs-spec.md sections A and B plus note-side compliance checks. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { isAhcccs } = require("../src/payers");
const ai = require("../src/ai-review");
const { today, addDays } = require("../src/views");

const PW = "Test-Password-123!";
let t, mercy, idOnly, commercial;
let seq = 0;

before(async () => {
  t = await start();
  [mercy, idOnly, commercial] = [t.ctx.patients[1], t.ctx.patients[2], t.ctx.patients[3]];
  for (const pid of [mercy, idOnly, commercial]) {
    t.db.prepare("UPDATE insurance_policies SET active = 0 WHERE patient_id = ?").run(pid);
    t.db.prepare("UPDATE patients SET ahcccs_id = NULL, dob = '1990-05-05' WHERE id = ?").run(pid);
    t.db.prepare("UPDATE treatment_plans SET status = 'completed' WHERE patient_id = ? AND status = 'active'").run(pid);
    t.db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at)
      VALUES (?, ?, 'active', date('now'), date('now', '+90 days'), datetime('now'))`).run(pid, t.ctx.users.therapist);
    t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description, status, is_primary) VALUES (?, 'F41.1', 'Generalized anxiety disorder', 'active', 1)").run(pid);
  }
  t.db.prepare("INSERT INTO insurance_policies (patient_id, payer_name, member_id, active) VALUES (?, 'Mercy Care', 'A11111111', 1)").run(mercy);
  t.db.prepare("UPDATE patients SET ahcccs_id = 'A22222222' WHERE id = ?").run(idOnly);
  t.db.prepare("INSERT INTO insurance_policies (patient_id, payer_name, member_id, active) VALUES (?, 'Example Mutual', 'X1', 1)").run(commercial);
});
after(async () => { await t.stop(); });

const noteIdFrom = (res) => Number((res.location || "").match(/\/ehr\/notes\/(\d+)$/)[1]);
const content = (id) => JSON.parse(t.db.prepare("SELECT content FROM notes WHERE id = ?").get(id).content);
const status = (id) => t.db.prepare("SELECT status FROM notes WHERE id = ?").get(id).status;
const unique = () => `Session ${++seq}: ${["anxiety", "sleep", "worry", "panic", "avoidance", "school", "work", "family", "grief", "anger"][seq % 10]} topic ${seq * 7919}`;

/** A progress note with every always-required field; `ahcccs` adds the AHCCCS encounter fields. */
function progress(extra = {}, { ahcccs = false } = {}) {
  const u = unique();
  return {
    type: "progress", format: "dap", service_date: today(), session_start: "09:00", session_end: "09:50",
    data: `${u}. Client reported PHQ-9 symptoms and difficulty sleeping, rumination about ${u}.`,
    assessment: `Anxiety symptoms moderate; ${u} remains a stressor.`, plan: `Practice worry postponement before ${u}.`,
    interventions: ["CBT"], risk_level: "low",
    ...(ahcccs ? {
      service_type: "individual", dx_addressed: "F41.1", dx_status: "continuing", pos: "11", telehealth_modality: "in_person",
      participants: "Member (self)", preferred_language: "English", interpreter: "not_needed",
      session_problem: "Worry interfering with sleep, as listed in the service plan.", brief_mse: "Casually dressed, anxious mood, congruent affect.",
      screener_results: "GAD-7 12 (moderate)", member_response: `Member practiced the skill in session and identified ${u} as a trigger.`,
    } : {}),
    ...extra,
  };
}

async function create(c, pid, body) {
  const r = await c.post(`/ehr/patients/${pid}/notes`, body);
  assert.equal(r.status, 302, r.text.slice(0, 500));
  return noteIdFrom(r);
}

test("AHCCCS detection: Mercy Care policy, AHCCCS ID, and commercial", () => {
  assert.equal(isAhcccs(t.db, mercy), true);
  assert.equal(isAhcccs(t.db, idOnly), true);
  assert.equal(isAhcccs(t.db, commercial), false);
});

test("encounter fields render for everyone; screener results prefill from assessments", async () => {
  t.db.prepare("INSERT INTO assessments (patient_id, instrument, responses, total_score, severity, administered_on) VALUES (?, 'PHQ9', '[]', 14, 'moderate', ?)")
    .run(commercial, today());
  const c = await t.login("therapist");
  const r = await c.get(`/ehr/patients/${commercial}/notes/new?type=progress`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Encounter details \(AHCCCS\)/);
  assert.match(r.text, /name="service_type"/);
  assert.match(r.text, /PHQ9 14 \(moderate\)/);
  assert.match(r.text, /F41\.1 Generalized anxiety disorder/);
  const m = await c.get(`/ehr/patients/${mercy}/notes/new?type=progress`);
  assert.match(m.text, /AHCCCS member/);
  // AHCCCS members: actual times, not the schedule.
  const appt = t.db.prepare("INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status) VALUES (?, ?, ?, ?, 'therapy', 'in_person', 'completed')")
    .run(mercy, t.ctx.users.therapist, `${today()}T08:00`, `${today()}T08:50`).lastInsertRowid;
  const pre = await c.get(`/ehr/patients/${mercy}/notes/new?type=progress&appointment_id=${appt}`);
  assert.match(pre.text, /name="session_start" value=""/);
  for (const type of ["group", "psychiatry", "contact"]) {
    const g = await c.get(`/ehr/patients/${commercial}/notes/new?type=${type}`);
    assert.match(g.text, /name="member_response"/, type);
  }
});

test("AHCCCS-required fields block signing for an AHCCCS member but not a commercial member", async () => {
  const c = await t.login("therapist");
  for (const pid of [mercy, idOnly]) {
    const id = await create(c, pid, progress());
    const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
    assert.equal(s.status, 400);
    assert.match(s.text, /Service type is required \(AHCCCS, AMPM 940\)/);
    assert.match(s.text, /Diagnosis addressed is required/);
    assert.match(s.text, /Member&#39;s individualized response is required/);
    assert.match(s.text, /Participants present is required/);
    assert.equal(status(id), "draft");
  }
  const ok = await create(c, commercial, progress());
  assert.equal((await c.post(`/ehr/notes/${ok}/sign`, { password: PW })).status, 302);
  // A complete AHCCCS note signs; the signature line shows credential, date and time.
  const full = await create(c, mercy, progress({}, { ahcccs: true }));
  assert.equal((await c.post(`/ehr/notes/${full}/sign`, { password: PW })).status, 302);
  const v = await c.get(`/ehr/notes/${full}`);
  assert.match(v.text, /Electronically signed by Taylor Therapist, LCSW on \w{3} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M/);
  assert.match(v.text, /Encounter details/);
  assert.match(v.text, /Continuing from current assessment/);
});

test("telehealth: audio-only needs a reason and more than 10 minutes; sessions over 60 minutes need justification", async () => {
  const c = await t.login("therapist");
  const id = await create(c, mercy, progress({ telehealth_modality: "audio_only", pos: "12", session_start: "09:00", session_end: "09:10" }, { ahcccs: true }));
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Why video wasn&#39;t available \(audio-only\) is required/);
  assert.match(s.text, /Member&#39;s location during telehealth is required/);
  assert.match(s.text, /Telehealth informed consent on file\? is required/);
  assert.match(s.text, /must run over 10 minutes/);
  const long = await create(c, mercy, progress({ session_start: "09:00", session_end: "10:30" }, { ahcccs: true }));
  const s2 = await c.post(`/ehr/notes/${long}/sign`, { password: PW });
  assert.equal(s2.status, 400);
  assert.match(s2.text, /Justification for a session over 60 minutes is required/);
  const fixed = await create(c, mercy, progress({ telehealth_modality: "audio_only", pos: "12", session_start: "09:00", session_end: "09:30",
    audio_only_reason: "Member's phone has no camera.", member_location: "Home", telehealth_consent: "yes" }, { ahcccs: true }));
  assert.equal((await c.post(`/ehr/notes/${fixed}/sign`, { password: PW })).status, 302);
});

test("late entry over 48 hours: reason required for AHCCCS, recorded and displayed", async () => {
  const c = await t.login("therapist");
  const old = addDays(today(), -5);
  const id = await create(c, mercy, progress({ service_date: old }, { ahcccs: true }));
  const form = await c.get(`/ehr/notes/${id}`);
  assert.match(form.text, /name="late_entry_reason"/);
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /Enter a late entry reason/);
  assert.equal((await c.post(`/ehr/notes/${id}/sign`, { password: PW, late_entry_reason: "Clinician was out sick." })).status, 302);
  const cn = content(id);
  assert.equal(cn.late_entry, true);
  assert.equal(cn.late_entry_reason, "Clinician was out sick.");
  assert.match(cn.late_entry_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  const v = await c.get(`/ehr/notes/${id}`);
  assert.match(v.text, /Late entry<\/span>/);
  assert.match(v.text, /Clinician was out sick\./);
  // Commercial: flagged as a late entry but the reason isn't required.
  const cid = await create(c, commercial, progress({ service_date: old }));
  assert.equal((await c.post(`/ehr/notes/${cid}/sign`, { password: PW })).status, 302);
  assert.equal(content(cid).late_entry, true);
  // A note signed on time is not a late entry.
  const fresh = await create(c, commercial, progress());
  assert.equal((await c.post(`/ehr/notes/${fresh}/sign`, { password: PW })).status, 302);
  assert.equal(content(fresh).late_entry, undefined);
});

test("cloned notes: blocked for AHCCCS (MD435), warning for others", async () => {
  const c = await t.login("therapist");
  const body = progress({}, { ahcccs: true });
  const first = await create(c, mercy, body);
  assert.equal((await c.post(`/ehr/notes/${first}/sign`, { password: PW })).status, 302);
  // Same narrative, different date and times.
  const copy = await create(c, mercy, { ...body, service_date: today(), session_start: "13:00", session_end: "13:50",
    data: body.data.replace(/\.$/, " 11/03/2026.") });
  const s = await c.post(`/ehr/notes/${copy}/sign`, { password: PW });
  assert.equal(s.status, 400);
  assert.match(s.text, /AMPM 940; denial edit MD435/);
  assert.equal(status(copy), "draft");
  // A different author's identical note isn't flagged.
  const other = await t.login("therapist2");
  const theirs = await create(other, mercy, body);
  assert.equal((await other.post(`/ehr/notes/${theirs}/sign`, { password: PW })).status, 302);

  const cbody = progress();
  const c1 = await create(c, commercial, cbody);
  assert.equal((await c.post(`/ehr/notes/${c1}/sign`, { password: PW })).status, 302);
  const c2 = await create(c, commercial, cbody);
  const s2 = await c.post(`/ehr/notes/${c2}/sign`, { password: PW });
  assert.equal(s2.status, 302);
  const after = await c.get(`/ehr/notes/${c2}`);
  assert.match(after.text, /Possible cloned note: This note&#39;s narrative is identical/);
});

function intake(extra = {}, { ahcccs = false } = {}) {
  const u = unique();
  return {
    type: "intake", format: "intake", service_date: today(), presenting_problem: `Anxiety ${u}`, hpi: `Worsening worry for 6 months ${u}`,
    diagnostic_impression: "F41.1", recommendations: "Weekly CBT", risk_level: "low",
    ...(ahcccs ? {
      strengths_needs: "Supportive sister; needs stable work.", trauma_history: "Denies.", family_history: "Mother: depression.",
      developmental_history: "Milestones on time.", criminal_justice: "None; no pending litigation.", legal_status: "Own decision-maker; has capacity.",
      sdoh_housing: "Stable apartment.", sdoh_education: "Some college.", sdoh_employment: "Part-time retail.", sdoh_social_cultural: "Active in church.",
      resources: "AHCCCS, SNAP.", language_communication: "English; no barriers.", smi_special_assistance: "not_smi",
      services_to_be_provided: "Individual counseling (H0004) weekly.", further_evaluation: "None needed.", loc_tool: "none",
      shared_pcp: "yes", shared_pcp_date: today(),
    } : {}),
    ...extra,
  };
}

test("intake: AHCCCS assessment domains required for AHCCCS members only", async () => {
  const c = await t.login("therapist");
  const id = await create(c, mercy, intake());
  const s = await c.post(`/ehr/notes/${id}/sign`, { password: PW });
  assert.equal(s.status, 400);
  for (const label of ["Trauma history", "Developmental history", "Criminal justice history / pending litigation", "Legal status",
    "Social determinants: housing", "SMI special-assistance need", "Level-of-care tool", "Assessment shared with PCP / Health Home\\?"]) {
    assert.match(s.text, new RegExp(`${label} is required`), label);
  }
  const ok = await create(c, commercial, intake());
  assert.equal((await c.post(`/ehr/notes/${ok}/sign`, { password: PW })).status, 302);
  // CALOCUS for a 6-17 year old AHCCCS member.
  t.db.prepare("UPDATE patients SET dob = ? WHERE id = ?").run(addDays(today(), -365 * 12), idOnly);
  const teen = await create(c, idOnly, intake({}, { ahcccs: true }));
  const st = await c.post(`/ehr/notes/${teen}/sign`, { password: PW });
  assert.equal(st.status, 400);
  assert.match(st.text, /CALOCUS/);
  await c.post(`/ehr/notes/${teen}/edit`, intake({ loc_tool: "calocus", calocus_score: "18", calocus_level: "Level 2" }, { ahcccs: true }));
  assert.equal((await c.post(`/ehr/notes/${teen}/sign`, { password: PW })).status, 302);
  t.db.prepare("UPDATE patients SET dob = '1990-05-05' WHERE id = ?").run(idOnly);
});

test("BHT intake goes to the supervisor for co-signature within 48 hours", async () => {
  t.db.prepare("UPDATE users SET credentials = 'BHT' WHERE id = ?").run(t.ctx.users.therapist2);
  try {
    const bht = await t.login("therapist2");
    const id = await create(bht, mercy, intake({}, { ahcccs: true }));
    assert.equal((await bht.post(`/ehr/notes/${id}/sign`, { password: PW })).status, 302);
    const v = await bht.get(`/ehr/notes/${id}`);
    assert.match(v.text, /Awaiting supervisor co-signature/);
    assert.match(v.text, /data-deadline=/);
    assert.doesNotMatch(v.text, /Co-sign note/); // the signer can't co-sign
    // The prefix can't be forged through a normal addendum.
    assert.equal((await bht.post(`/ehr/notes/${id}/addenda`, { content: "Co-signed by licensed BHP: me" })).status, 400);

    // Overdue co-sign is flagged by the compliance check.
    t.db.prepare("UPDATE notes SET signed_at = datetime('now', '-4 days'), cosign_due_at = datetime('now', '-2 days') WHERE id = ?").run(id);
    const lic = await t.login("therapist");
    const r = await lic.post(`/ehr/notes/${id}/compliance-review`);
    assert.match(r.text, /Supervisor co-signature is overdue/);
    assert.match(r.text, /Overdue by/);

    assert.equal((await lic.post(`/ehr/notes/${id}/cosign`, { password: "wrong" })).status, 400);
    assert.equal((await lic.post(`/ehr/notes/${id}/cosign`, { password: PW, comment: "Agree with F41.1." })).status, 302);
    const after = await lic.get(`/ehr/notes/${id}`);
    assert.match(after.text, /Co-signed by supervisor Taylor Therapist, LCSW on/);
    assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'cosign' AND entity_id = ?").get(id));
    assert.equal((await lic.post(`/ehr/notes/${id}/cosign`, { password: PW })).status, 403);
    // Licensed signers don't need a co-sign.
    const own = await create(lic, mercy, intake({}, { ahcccs: true }));
    await lic.post(`/ehr/notes/${own}/sign`, { password: PW });
    assert.doesNotMatch((await lic.get(`/ehr/notes/${own}`)).text, /Awaiting supervisor co-signature/);
  } finally {
    t.db.prepare("UPDATE users SET credentials = 'LPC' WHERE id = ?").run(t.ctx.users.therapist2);
  }
});

const base = (over = {}) => ({
  ahcccs: true, note_type: "progress", service_date: "2026-11-02", session_minutes: 50, risk_level: "low",
  diagnoses: [{ code: "F41.1" }], treatment_plan: { active: true, dated: "2026-06-01", guardian_signed: false }, objectives_addressed: 1,
  latest_assessment_date: "2026-05-01", patient_age: 30, ahcccs_missing: [], charges: [],
  content: { data: "PHQ-9 12; sleep improved.", interventions: ["CBT"], service_type: "individual", telehealth_modality: "in_person", pos: "11", dx_addressed: "F41.1" },
  ...over,
});
const issues = (ctx) => ai.ruleChecks(ctx).map((f) => f.issue).join(" | ");

test("compliance rules: assessment/plan age (MD466) and minor guardian signature (MD454)", () => {
  assert.equal(ai.ruleChecks(base()).length, 0, issues(base()));
  assert.match(issues(base({ latest_assessment_date: "2025-10-01" })), /assessment .* more than 1 year old .*edit MD466/);
  assert.match(issues(base({ latest_assessment_date: null })), /No signed assessment .*edit MD466/);
  assert.match(issues(base({ treatment_plan: { active: true, dated: "2025-09-01" } })), /service plan .* more than 1 year old .*edit MD466/);
  assert.match(issues(base({ patient_age: 15 })), /under 18 .*guardian signature .*edit MD454/);
  assert.doesNotMatch(issues(base({ patient_age: 15, treatment_plan: { active: true, dated: "2026-06-01", guardian_signed: true } })), /MD454/);
  // Non-AHCCCS members don't get AHCCCS findings.
  assert.doesNotMatch(issues(base({ ahcccs: false, latest_assessment_date: null })), /MD466/);
});

test("compliance rules: units vs minutes, HQ, GT/FQ vs 95, POS 02, diagnosis, audio-only, late entry, long session", () => {
  const ch = (o) => ({ cpt: "H0004", modifier: "HO", units: 3, pos: "11", minutes: null, diagnosis_codes: "F41.1", ...o });
  assert.equal(ai.ruleChecks(base({ charges: [ch()] })).length, 0, issues(base({ charges: [ch()] })));
  assert.match(issues(base({ charges: [ch({ units: 4 })] })), /4 unit\(s\), but 50 documented minutes support 3 .*MD418/);
  assert.match(issues(base({ session_minutes: 6, charges: [ch({ units: 1 })] })), /under the 8-minute minimum/);
  assert.match(issues(base({ charges: [ch({ cpt: "T1016", units: 2, minutes: 20 })] })), /T1016 billed for 2 unit\(s\), but 20 documented minutes support 1/);
  assert.match(issues(base({ note_type: "group", charges: [ch({ cpt: "90853", units: 1 })] })), /without the HQ modifier/);
  assert.match(issues(base({ charges: [ch({ modifier: "HO 95" })] })), /modifier 95; AHCCCS uses GT .* or FQ/);
  const av = base({ content: { ...base().content, telehealth_modality: "audio_video", pos: "12" }, charges: [ch({ pos: "12" })] });
  assert.match(issues(av), /Audio-video telehealth billed as H0004 without modifier GT/);
  assert.doesNotMatch(issues({ ...av, charges: [ch({ pos: "12", modifier: "HO GT" })] }), /modifier GT/);
  const ao = base({ session_minutes: 9, content: { ...base().content, telehealth_modality: "audio_only", pos: "12" }, charges: [ch({ pos: "12", modifier: "GT", units: 1 })] });
  const aoi = issues(ao);
  assert.match(aoi, /without modifier FQ/);
  assert.match(aoi, /without the reason video/);
  assert.match(aoi, /must run over 10 minutes/);
  assert.match(issues(base({ charges: [ch({ pos: "02" })] })), /place of service 02; AHCCCS uses the member&#39;s location|place of service 02; AHCCCS uses the member's location/);
  assert.match(issues(base({ charges: [ch({ diagnosis_codes: "F32.1" })] })), /isn't the diagnosis addressed in the note/);
  assert.match(issues(base({ session_minutes: null })), /Actual start and stop times are missing/);
  assert.match(issues(base({ session_minutes: 75, charges: [] })), /75 minutes without a justification/);
  assert.match(issues(base({ content: { ...base().content, late_entry: true, late_entry_reason: "" } })), /late entry .*without a reason \(AMPM 940/);
  assert.match(issues(base({ cloned_from: { service_date: "2026-10-26", similarity: 0.95 } })), /95% identical .*edit MD435/);
  assert.match(issues(base({ ahcccs_missing: ["Service type is required."] })), /Missing AHCCCS documentation elements/);
});

test("compliance review route: AHCCCS context from the chart and charges; AHCCCS prompt sent to AI", async () => {
  const c = await t.login("therapist");
  const id = await create(c, mercy, progress({ telehealth_modality: "audio_video", pos: "12", member_location: "Home", telehealth_consent: "yes" }, { ahcccs: true }));
  t.db.prepare(`INSERT INTO charges (patient_id, note_id, date_of_service, cpt_code, modifier, units, fee_cents, diagnosis_codes, pos, minutes)
    VALUES (?, ?, ?, 'H0004', '95', 4, 1000, 'F41.1', '02', 50)`).run(mercy, id, today());
  const note = { ...t.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) };
  const ctx = ai.buildContext(t.db, note);
  assert.equal(ctx.ahcccs, true);
  assert.equal(ctx.patient_age >= 18, true);
  assert.equal(ctx.charges[0].pos, "02");
  const txt = ai.ruleChecks(ctx).map((f) => f.issue).join(" | ");
  assert.match(txt, /modifier 95/);
  assert.match(txt, /place of service 02/);
  assert.match(txt, /support 3 .*MD418/);
  assert.ok(ctx.latest_assessment_date, "intakes signed earlier in this file count as the assessment");
  assert.doesNotMatch(txt, /No signed assessment/);
  let sent;
  ai.setClient({ beta: { messages: { create: async (req) => {
    sent = req;
    return { stop_reason: "end_turn", model: "x", content: [{ type: "text", text: JSON.stringify({ summary: "ok", findings: [] }) }] };
  } } } });
  try {
    const r = await c.post(`/ehr/notes/${id}/compliance-review`);
    assert.equal(r.status, 200);
    assert.match(r.text, /never 95\/93/);
    assert.match(sent.system, /enrolled in AHCCCS/);
    assert.deepEqual(sent.output_config.format.schema, ai.FINDINGS_SCHEMA);
  } finally { ai.setClient(null); }
  // Commercial members: no AHCCCS paragraph.
  const cid = await create(c, commercial, progress());
  ai.setClient({ beta: { messages: { create: async (req) => { sent = req; return { stop_reason: "end_turn", model: "x", content: [{ type: "text", text: "{\"summary\":\"ok\",\"findings\":[]}" }] }; } } } });
  try {
    await c.post(`/ehr/notes/${cid}/compliance-review`);
    assert.doesNotMatch(sent.system, /AHCCCS/);
  } finally { ai.setClient(null); }
});
