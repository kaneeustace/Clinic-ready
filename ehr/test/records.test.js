"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

const PW = "Test-Password-123!";
let t, pid, pid2;

const ymd = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

function insNote(patientId, type, content, { status = "signed", author = "therapist", serviceDate = ymd(-10), format } = {}) {
  const fmt = format || { progress: "dap", psychotherapy: "narrative", asam: "asam", roi: "roi" }[type] || "narrative";
  return Number(t.db.prepare(
    `INSERT INTO notes (patient_id, author_id, type, format, content, status, service_date, signed_at, signed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(patientId, t.ctx.users[author], type, fmt, JSON.stringify(content), status, serviceDate,
    status === "signed" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
    status === "signed" ? t.ctx.users[author] : null).lastInsertRowid);
}
const roi = (patientId, over = {}) => insNote(patientId, "roi", {
  direction: "release_to", recipient: "Dr. Primary Care", information: "Treatment summary", purpose: "Coordination of care",
  expires_on: ymd(180), includes_sud: "no", consent_method: "signed_paper", signed_by: "Client", signed_on: ymd(-30), revocation: "", ...over,
});

before(async () => {
  t = await start();
  // Use fresh patients so seeded data (e.g. SUD plans) doesn't drive the Part 2 assertions.
  const mk = (mrn) => Number(t.db.prepare(
    "INSERT INTO patients (mrn, first_name, last_name, dob) VALUES (?, 'Rec', 'Tester', '1990-01-01')").run(mrn).lastInsertRowid);
  pid = mk("REC-0001");
  pid2 = mk("REC-0002");
  insNote(pid, "progress", { data: "SIGNED-PROGRESS-DATA", assessment: "Improving", plan: "Continue" });
  const signedId = insNote(pid, "progress", { data: "SECOND-SIGNED", assessment: "a", plan: "p" });
  t.db.prepare("INSERT INTO note_addenda (note_id, author_id, content) VALUES (?, ?, 'ADDENDUM-TEXT')").run(signedId, t.ctx.users.therapist);
  insNote(pid, "progress", { data: "DRAFT-SECRET-DATA" }, { status: "draft" });
  insNote(pid, "psychotherapy", { process_notes: "PROCESS-NOTE-SECRET" });
  const plan = Number(t.db.prepare(
    `INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, activated_at, summary, plan_type)
     VALUES (?, ?, 'active', ?, ?, datetime('now'), 'ACTIVE-PLAN-SUMMARY', 'mental_health')`).run(pid, t.ctx.users.therapist, ymd(-20), ymd(70)).lastInsertRowid);
  t.db.prepare("INSERT INTO plan_signatures (plan_id, role, signer_name, method) VALUES (?, 'client', 'Rec Tester', 'in_person')").run(plan);
  t.db.prepare(
    `INSERT INTO treatment_plans (patient_id, author_id, status, summary) VALUES (?, ?, 'draft', 'DRAFT-PLAN-SUMMARY')`).run(pid, t.ctx.users.therapist);
  t.db.prepare(
    `INSERT INTO assessments (patient_id, instrument, responses, total_score, severity, administered_on) VALUES (?, 'PHQ9', '[]', 17, 'Moderately severe', ?)`)
    .run(pid, ymd(-5));
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description) VALUES (?, 'F33.1', 'Major depressive disorder, recurrent, moderate')").run(pid);
  // pid2: SUD content
  t.db.prepare("INSERT INTO diagnoses (patient_id, icd10_code, description) VALUES (?, 'F10.20', 'Alcohol dependence, uncomplicated')").run(pid2);
});
after(async () => { await t.stop(); });

const exportBody = (extra = {}) => ({ password: PW, format: "html", sections: ["demographics", "diagnoses", "medications", "appointments", "notes", "plans", "assessments", "billing"], ...extra });

test("record copy excludes psychotherapy notes and drafts; includes signed notes, addenda, plans and scores", async () => {
  const c = await t.login("therapist");
  const page = await c.get(`/ehr/patients/${pid}/records`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Generate record copy/);
  const r = await c.post(`/ehr/patients/${pid}/records/export`, exportBody());
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.match(r.text, /Designated record set copy/);
  assert.match(r.text, /data-print/);
  assert.match(r.text, /SIGNED-PROGRESS-DATA/);
  assert.match(r.text, /ADDENDUM-TEXT/);
  assert.match(r.text, /ACTIVE-PLAN-SUMMARY/);
  assert.match(r.text, /PHQ-9/);
  assert.match(r.text, /psychotherapy notes/i);
  assert.doesNotMatch(r.text, /PROCESS-NOTE-SECRET/);
  assert.doesNotMatch(r.text, /DRAFT-SECRET-DATA/);
  assert.doesNotMatch(r.text, /DRAFT-PLAN-SUMMARY/);
  assert.doesNotMatch(r.text, /42 CFR Part 2 notice/);
  const a = t.db.prepare("SELECT * FROM audit_log WHERE action = 'export' AND entity_type = 'record_copy' AND patient_id = ? ORDER BY id DESC").get(pid);
  assert.ok(a);
  assert.match(a.detail, /sections=demographics,diagnoses/);
  assert.doesNotMatch(a.detail, /SIGNED-PROGRESS|Tester/);
  // internal print is not a disclosure
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM disclosures WHERE patient_id = ?").get(pid).n, 0);
});

test("psychotherapy notes are excluded even for their author, and section selection is honored", async () => {
  const c = await t.login("therapist"); // author of the psychotherapy note
  const r = await c.post(`/ehr/patients/${pid}/records/export`, exportBody({ sections: ["assessments"] }));
  assert.equal(r.status, 200);
  assert.match(r.text, /PHQ-9/);
  assert.doesNotMatch(r.text, /SIGNED-PROGRESS-DATA|PROCESS-NOTE-SECRET/);
});

test("password is required to generate a copy", async () => {
  const c = await t.login("therapist");
  const none = await c.post(`/ehr/patients/${pid}/records/export`, exportBody({ password: "" }));
  assert.equal(none.status, 400);
  assert.match(none.text, /Password is incorrect/);
  assert.doesNotMatch(none.text, /SIGNED-PROGRESS-DATA/);
  const bad = await c.post(`/ehr/patients/${pid}/records/export`, exportBody({ password: "wrong-password-xx", format: "json" }));
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.headers.get("content-disposition") || "", /attachment/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'reauth_failed' AND entity_type = 'record_copy' AND patient_id = ?").get(pid));
});

test("JSON download has attachment headers and excludes psychotherapy/drafts", async () => {
  const c = await t.login("admin");
  const r = await c.post(`/ehr/patients/${pid}/records/export`, exportBody({ format: "json" }));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="record-copy-REC-0001-\d{4}-\d{2}-\d{2}\.json"$/);
  const j = JSON.parse(r.text);
  assert.equal(j.title, "Designated record set copy");
  assert.match(j.exclusions, /psychotherapy notes/i);
  assert.equal(j.part2, false);
  assert.ok(j.notes.length >= 2);
  assert.ok(j.notes.every((n) => n.type !== "psychotherapy"));
  assert.doesNotMatch(r.text, /DRAFT-SECRET-DATA|PROCESS-NOTE-SECRET|DRAFT-PLAN-SUMMARY/);
  assert.equal(j.treatment_plans.length, 1);
  assert.equal(j.treatment_plans[0].signatures.length, 1);
  assert.equal(j.assessments[0].total_score, 17);
});

test("Part 2 notice appears when SUD content is included", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid2}/records/export`, exportBody());
  assert.equal(r.status, 200);
  assert.match(r.text, /42 CFR Part 2 notice/);
  // Not when the SUD diagnosis section is excluded
  const r2 = await c.post(`/ehr/patients/${pid2}/records/export`, exportBody({ sections: ["demographics"] }));
  assert.doesNotMatch(r2.text, /42 CFR Part 2 notice/);
  // ASAM note and SUD plan also trigger it
  insNote(pid2, "asam", { substance_history: "x" });
  const r3 = await c.post(`/ehr/patients/${pid2}/records/export`, exportBody({ sections: ["notes"], format: "json" }));
  assert.equal(JSON.parse(r3.text).part2, true);
});

test("released-to-patient export is logged as a patient_request disclosure", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/records/export`, exportBody({ released: "1", released_method: "in_person" }));
  assert.equal(r.status, 200);
  const d = t.db.prepare("SELECT * FROM disclosures WHERE patient_id = ? ORDER BY id DESC").get(pid);
  assert.equal(d.basis, "patient_request");
  assert.equal(d.recipient, "Patient");
  assert.equal(d.method, "in_person");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'create' AND entity_type = 'disclosure' AND entity_id = ?").get(d.id));
});

const disc = (extra = {}) => ({ disclosed_on: ymd(-1), recipient: "County Health Dept", purpose: "Reporting", description: "Diagnosis and dates of service",
  basis: "public_health", method: "fax", ...extra });

test("authorization basis requires a valid ROI; expired, revoked, unsigned and other-patient consents are rejected", async () => {
  const c = await t.login("therapist");
  const none = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization" }));
  assert.equal(none.status, 400);
  assert.match(none.text, /requires a linked, signed release-of-information consent/);

  const expired = roi(pid, { expires_on: ymd(-3) });
  const r1 = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: expired }));
  assert.equal(r1.status, 400);
  assert.match(r1.text, /expired/);

  const revoked = roi(pid, { revocation: "Revoked in writing" });
  const r2 = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: revoked }));
  assert.equal(r2.status, 400);
  assert.match(r2.text, /revoked/);

  const draft = insNote(pid, "roi", { expires_on: ymd(100), direction: "release_to" }, { status: "draft" });
  const r3 = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: draft }));
  assert.equal(r3.status, 400);
  assert.match(r3.text, /not signed/);

  const notRoi = insNote(pid, "progress", { data: "x" });
  const r4 = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: notRoi }));
  assert.equal(r4.status, 400);
  assert.match(r4.text, /not a release-of-information consent/);

  const other = roi(pid2);
  const r5 = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: other }));
  assert.equal(r5.status, 400);

  const valid = roi(pid);
  const r6 = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: valid, includes_part2: "1" }));
  assert.equal(r6.status, 400, "consent without SUD coverage can't support a Part 2 disclosure");
  assert.match(r6.text, /does not cover substance use/);

  const ok = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "authorization", authorization_note_id: valid, recipient: "AUTH-RECIPIENT" }));
  assert.equal(ok.status, 302);
  const d = t.db.prepare("SELECT * FROM disclosures WHERE recipient = 'AUTH-RECIPIENT'").get();
  assert.equal(d.authorization_note_id, valid);
  assert.equal(d.entered_by, c.userId);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'create' AND entity_type = 'disclosure' AND entity_id = ?").get(d.id));
});

test("disclosure field validation", async () => {
  const c = await t.login("therapist");
  const r = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ disclosed_on: ymd(5), recipient: "", basis: "bogus" }));
  assert.equal(r.status, 400);
  assert.match(r.text, /can&#39;t be in the future|can't be in the future/);
  assert.match(r.text, /Enter the recipient/);
  assert.match(r.text, /valid basis/);
});

test("accounting excludes TPO / patient request / authorization; full log lists them; Part 2 notice shown", async () => {
  const c = await t.login("admin");
  for (const basis of ["treatment", "payment", "operations"]) {
    const r = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis, recipient: `TPO-${basis.toUpperCase()}` }));
    assert.equal(r.status, 302);
  }
  const law = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ basis: "judicial", recipient: "COURT-RECIPIENT", includes_part2: "1" }));
  assert.equal(law.status, 302);
  const ph = await c.post(`/ehr/patients/${pid}/disclosures`, disc({ recipient: "PUBLIC-HEALTH-RECIPIENT" }));
  assert.equal(ph.status, 302);
  // older than 6 years: not shown
  t.db.prepare("INSERT INTO disclosures (patient_id, disclosed_on, recipient, purpose, description, basis) VALUES (?, ?, 'ANCIENT-RECIPIENT', 'x', 'x', 'required_by_law')")
    .run(pid, `${new Date().getFullYear() - 7}-01-01`);

  const r = await c.get(`/ehr/patients/${pid}/disclosures/accounting`);
  assert.equal(r.status, 200);
  assert.match(r.text, /data-print/);
  const [accounting, full] = r.text.split('id="full-release-log"');
  assert.match(accounting, /COURT-RECIPIENT/);
  assert.match(accounting, /PUBLIC-HEALTH-RECIPIENT/);
  assert.match(accounting, /42 CFR part 2 prohibits unauthorized use or disclosure/);
  for (const x of ["TPO-TREATMENT", "TPO-PAYMENT", "TPO-OPERATIONS", "AUTH-RECIPIENT", "ANCIENT-RECIPIENT"]) assert.doesNotMatch(accounting, new RegExp(x));
  assert.doesNotMatch(accounting, /Patient right of access/);
  for (const x of ["TPO-TREATMENT", "TPO-PAYMENT", "TPO-OPERATIONS", "AUTH-RECIPIENT", "Patient right of access"]) assert.match(full, new RegExp(x));
  assert.doesNotMatch(full, /COURT-RECIPIENT|ANCIENT-RECIPIENT/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'disclosure' AND patient_id = ? AND detail LIKE 'accounting%'").get(pid));

  const list = await c.get(`/ehr/patients/${pid}/disclosures`);
  assert.equal(list.status, 200);
  assert.match(list.text, /TPO-TREATMENT/);
  assert.match(list.text, /Record a disclosure/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'disclosure' AND patient_id = ? AND detail = 'disclosure log'").get(pid));
});

test("permissions: frontdesk blocked; billing read-only; clinicians and admin can record", async () => {
  const fd = await t.login("frontdesk");
  assert.equal((await fd.get(`/ehr/patients/${pid}/records`)).status, 403);
  assert.equal((await fd.post(`/ehr/patients/${pid}/records/export`, exportBody())).status, 403);
  assert.equal((await fd.get(`/ehr/patients/${pid}/disclosures`)).status, 403);
  assert.equal((await fd.post(`/ehr/patients/${pid}/disclosures`, disc())).status, 403);

  const b = await t.login("billing");
  assert.equal((await b.get(`/ehr/patients/${pid}/records`)).status, 403);
  assert.equal((await b.post(`/ehr/patients/${pid}/records/export`, exportBody())).status, 403);
  const bl = await b.get(`/ehr/patients/${pid}/disclosures`);
  assert.equal(bl.status, 200);
  assert.doesNotMatch(bl.text, /Record a disclosure/);
  assert.equal((await b.get(`/ehr/patients/${pid}/disclosures/accounting`)).status, 200);
  const before = t.db.prepare("SELECT COUNT(*) AS n FROM disclosures").get().n;
  assert.equal((await b.post(`/ehr/patients/${pid}/disclosures`, disc())).status, 403);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM disclosures").get().n, before);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'forbidden' AND user_id = ?").get(b.userId));

  const pr = await t.login("prescriber");
  assert.equal((await pr.post(`/ehr/patients/${pid}/disclosures`, disc({ recipient: "PRESCRIBER-REC" }))).status, 302);
  assert.equal((await t.client().get(`/ehr/patients/${pid}/records`)).status, 302); // not logged in
});

test("overview shows Records & disclosures card to clinical users only", async () => {
  const c = await t.login("therapist");
  const r = await c.get(`/ehr/patients/${pid}`);
  assert.match(r.text, /Records &amp; disclosures/);
  assert.match(r.text, new RegExp(`/ehr/patients/${pid}/disclosures/accounting`));
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM disclosures WHERE patient_id = ?").get(pid).n;
  assert.match(r.text, new RegExp(`${n} recorded`));
  const fd = await t.login("frontdesk");
  assert.doesNotMatch((await fd.get(`/ehr/patients/${pid}`)).text, /Records &amp; disclosures/);
});
