"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { scoreInstrument, INSTRUMENTS } = require("../src/routes/clinical");
const { today, addDays } = require("../src/views");

let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

/** Responses for an instrument summing to `total` (item 9 kept at `item9` for PHQ-9). */
function resp(instrument, total, item9 = 0) {
  const n = INSTRUMENTS[instrument].items.length;
  const r = new Array(n).fill(0);
  let left = total;
  if (instrument === "PHQ9") { r[8] = item9; left -= item9; }
  for (let i = 0; left > 0; i = (i + 1) % n) {
    if (instrument === "PHQ9" && i === 8) continue;
    if (r[i] < 3) { r[i]++; left--; }
  }
  return r;
}
const form = (instrument, responses, extra = {}) => {
  const body = { instrument, administered_on: today(), ...extra };
  responses.forEach((v, i) => { if (v !== undefined) body[`q${i + 1}`] = v; });
  return body;
};
function newPatient(name = "Testcase") {
  return Number(t.db.prepare(`INSERT INTO patients (mrn, first_name, last_name, dob) VALUES (?, ?, 'Synthetic', '1990-01-01')`)
    .run(`T-${Math.random().toString(36).slice(2, 10)}`, name).lastInsertRowid);
}

/* ---------------- scoring ---------------- */

test("instrument definitions have standard item counts", () => {
  assert.equal(INSTRUMENTS.PHQ9.items.length, 9);
  assert.equal(INSTRUMENTS.GAD7.items.length, 7);
});

test("PHQ-9 severity boundaries", () => {
  const cases = [[0, "minimal"], [4, "minimal"], [5, "mild"], [9, "mild"], [10, "moderate"], [14, "moderate"],
    [15, "moderately severe"], [19, "moderately severe"], [20, "severe"], [27, "severe"]];
  for (const [total, sev] of cases) {
    const s = scoreInstrument("PHQ9", resp("PHQ9", total, total === 27 ? 3 : 0));
    assert.equal(s.total, total);
    assert.equal(s.severity, sev, `PHQ-9 ${total}`);
  }
});

test("GAD-7 severity boundaries", () => {
  const cases = [[0, "minimal"], [4, "minimal"], [5, "mild"], [9, "mild"], [10, "moderate"], [14, "moderate"], [15, "severe"], [21, "severe"]];
  for (const [total, sev] of cases) {
    const s = scoreInstrument("GAD7", resp("GAD7", total));
    assert.equal(s.total, total);
    assert.equal(s.severity, sev, `GAD-7 ${total}`);
    assert.equal(s.flagged, 0);
  }
});

test("PHQ-9 item 9 > 0 flags", () => {
  assert.equal(scoreInstrument("PHQ9", resp("PHQ9", 3, 0)).flagged, 0);
  assert.equal(scoreInstrument("PHQ9", [0, 0, 0, 0, 0, 0, 0, 0, 1]).flagged, 1);
  assert.equal(scoreInstrument("PHQ9", [0, 0, 0, 0, 0, 0, 0, 0, 3]).flagged, 1);
  // Item 9 on a GAD-7 doesn't exist; item 7 high is not a flag.
  assert.equal(scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, 3]).flagged, 0);
});

test("scoreInstrument rejects bad input", () => {
  assert.throws(() => scoreInstrument("BDI", [0]));
  assert.throws(() => scoreInstrument("PHQ9", [0, 0, 0]));
  assert.throws(() => scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, 4]));
  assert.throws(() => scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, -1]));
  assert.throws(() => scoreInstrument("GAD7", [0, 0, 0, 0, 0, 0, 1.5]));
});

/* ---------------- measures routes ---------------- */

test("measures page and form render for clinician", async () => {
  const c = await t.login("therapist");
  const pid = t.ctx.patients[0];
  const page = await c.get(`/ehr/patients/${pid}/measures`);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="spark"/);
  assert.match(page.text, /<desc id=/);
  assert.match(page.text, /Chart data table/);
  const f = await c.get(`/ehr/patients/${pid}/measures/new?instrument=GAD7`);
  assert.equal(f.status, 200);
  assert.match(f.text, /data-score-total/);
  assert.match(f.text, /Over the last 2 weeks/);
  assert.equal((f.text.match(/<fieldset/g) || []).length, 7);
  assert.equal((await c.get(`/ehr/patients/${pid}/measures/new?instrument=XYZ`)).status, 400);
});

test("saving a PHQ-9 stores the score and audits", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const r = await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", 12)));
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM assessments WHERE patient_id = ?").get(pid);
  assert.equal(row.total_score, 12);
  assert.equal(row.severity, "moderate");
  assert.equal(row.flagged, 0);
  assert.equal(row.entered_by, c.userId);
  assert.deepEqual(JSON.parse(row.responses), resp("PHQ9", 12));
  const a = t.db.prepare("SELECT * FROM audit_log WHERE action = 'create' AND entity_type = 'assessment' AND entity_id = ?").get(row.id);
  assert.ok(a);
  assert.equal(a.patient_id, pid);
  const view = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(view.text, /12/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'view' AND entity_type = 'assessment' AND patient_id = ?").get(pid));
});

test("PHQ-9 item 9 endorsed: flagged and urgent alert with 988", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const r = await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", 8, 1)));
  assert.equal(r.status, 302);
  const row = t.db.prepare("SELECT * FROM assessments WHERE patient_id = ?").get(pid);
  assert.equal(row.flagged, 1);
  const next = await c.get(r.location);
  assert.match(next.text, /role="alert"[^>]*>URGENT/);
  assert.match(next.text, /988/);
  assert.match(next.text, /same-day/);
  assert.match(next.text, /Safety flag/); // chart header pill
});

test("validation: missing item, bad value, future date, foreign appointment -> 400", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const missing = resp("GAD7", 5); missing[3] = undefined;
  let r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", missing));
  assert.equal(r.status, 400);
  assert.match(r.text, /item 4/);
  const bad = resp("GAD7", 5); bad[0] = 4;
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", bad));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 5), { administered_on: addDays(today(), 2) }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 5), { administered_on: "2026-02-30" }));
  assert.equal(r.status, 400);
  const otherAppt = t.db.prepare("SELECT id FROM appointments WHERE patient_id <> ? LIMIT 1").get(pid).id;
  r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 5), { appointment_id: otherAppt }));
  assert.equal(r.status, 400);
  r = await c.post(`/ehr/patients/${pid}/measures`, form("NOPE", resp("GAD7", 5)));
  assert.equal(r.status, 400);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM assessments WHERE patient_id = ?").get(pid).n, 0);
});

test("own appointment can be linked", async () => {
  const c = await t.login("therapist");
  const pid = t.ctx.patients[2];
  const appt = t.db.prepare("SELECT id FROM appointments WHERE patient_id = ? LIMIT 1").get(pid).id;
  const r = await c.post(`/ehr/patients/${pid}/measures`, form("GAD7", resp("GAD7", 3), { appointment_id: appt }));
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT appointment_id FROM assessments WHERE patient_id = ? ORDER BY id DESC").get(pid).appointment_id, appt);
});

test("response and remission indicators", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  for (const [total, d] of [[16, -42], [10, -28], [4, -14]]) {
    const r = await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", total), { administered_on: addDays(today(), d) }));
    assert.equal(r.status, 302);
  }
  const page = await c.get(`/ehr/patients/${pid}/measures`);
  assert.match(page.text, /badge--good">Response</);
  assert.match(page.text, /badge--good">Remission</);
  assert.match(page.text, /75% reduction/);
});

/* ---------------- treatment plans ---------------- */

test("plan lifecycle: draft -> goal -> activate supersedes previous", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const base = `/ehr/patients/${pid}/treatment-plan`;
  assert.equal((await c.get(base)).status, 200);
  assert.equal((await c.get(`${base}/new`)).status, 200);

  // Plan 1
  let r = await c.post(base, { start_date: today(), review_date: addDays(today(), 90), summary: "First" });
  assert.equal(r.status, 302);
  const p1 = t.db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ?").get(pid);
  assert.equal(p1.status, "draft");

  // Activation without goals fails
  r = await c.post(`/ehr/treatment-plans/${p1.id}/activate`);
  assert.equal(r.status, 400);
  assert.match(r.text, /at least one goal/);

  // Invalid goal
  r = await c.post(`/ehr/treatment-plans/${p1.id}/goals`, { problem: "", goal: "" });
  assert.equal(r.status, 400);

  r = await c.post(`/ehr/treatment-plans/${p1.id}/goals`, { problem: "Depressed mood", goal: "Feel better", objectives: "PHQ-9 < 10", status: "in_progress" });
  assert.equal(r.status, 302);
  const g1 = t.db.prepare("SELECT * FROM treatment_goals WHERE plan_id = ?").get(p1.id);
  assert.equal(g1.problem, "Depressed mood");

  // Edit goal + plan while draft
  r = await c.post(`/ehr/treatment-plans/${p1.id}/goals/${g1.id}`, { problem: "Low mood", goal: "Feel better", status: "not_started" });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT problem FROM treatment_goals WHERE id = ?").get(g1.id).problem, "Low mood");
  r = await c.post(`/ehr/treatment-plans/${p1.id}/edit`, { start_date: today(), review_date: addDays(today(), 60), summary: "Edited" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${p1.id}/edit`, { start_date: today(), review_date: addDays(today(), -5) });
  assert.equal(r.status, 400);

  r = await c.post(`/ehr/treatment-plans/${p1.id}/activate`);
  assert.equal(r.status, 302);
  const p1a = t.db.prepare("SELECT * FROM treatment_plans WHERE id = ?").get(p1.id);
  assert.equal(p1a.status, "active");
  assert.ok(p1a.signed_at);

  // Active plan: fields locked, goal status updatable, delete refused
  assert.equal((await c.post(`/ehr/treatment-plans/${p1.id}/edit`, { summary: "x" })).status, 409);
  assert.equal((await c.post(`/ehr/treatment-plans/${p1.id}/goals`, { problem: "a", goal: "b" })).status, 409);
  assert.equal((await c.post(`/ehr/treatment-plans/${p1.id}/goals/${g1.id}/delete`)).status, 409);
  r = await c.post(`/ehr/treatment-plans/${p1.id}/goals/${g1.id}`, { status: "in_progress", problem: "Changed" });
  assert.equal(r.status, 302);
  const g1b = t.db.prepare("SELECT * FROM treatment_goals WHERE id = ?").get(g1.id);
  assert.equal(g1b.status, "in_progress");
  assert.equal(g1b.problem, "Low mood");

  const view = await c.get(base);
  assert.match(view.text, /Low mood/);

  // Plan 2: revision carrying forward goals
  r = await c.post(base, { start_date: today(), review_date: addDays(today(), 90), copy_goals: "1" });
  assert.equal(r.status, 302);
  const p2 = t.db.prepare("SELECT * FROM treatment_plans WHERE patient_id = ? AND status = 'draft'").get(pid);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM treatment_goals WHERE plan_id = ?").get(p2.id).n, 1);
  // Only one draft at a time
  r = await c.post(base, { review_date: addDays(today(), 90) });
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM treatment_plans WHERE patient_id = ? AND status = 'draft'").get(pid).n, 1);

  const g2 = t.db.prepare("SELECT id FROM treatment_goals WHERE plan_id = ?").get(p2.id);
  r = await c.post(`/ehr/treatment-plans/${p2.id}/goals/${g2.id}/delete`);
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${p2.id}/goals`, { problem: "Worry", goal: "Worry less" });
  assert.equal(r.status, 302);
  r = await c.post(`/ehr/treatment-plans/${p2.id}/activate`);
  assert.equal(r.status, 302);

  assert.equal(t.db.prepare("SELECT status FROM treatment_plans WHERE id = ?").get(p1.id).status, "superseded");
  assert.equal(t.db.prepare("SELECT status FROM treatment_plans WHERE id = ?").get(p2.id).status, "active");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM treatment_plans WHERE patient_id = ? AND status = 'active'").get(pid).n, 1);

  const hist = await c.get(base);
  assert.match(hist.text, /Plan history/);
  assert.match(hist.text, /Superseded/);
  assert.equal((await c.get(`${base}?plan=${p1.id}`)).status, 200);

  r = await c.post(`/ehr/treatment-plans/${p2.id}/complete`);
  assert.equal(r.status, 302);
  assert.equal(t.db.prepare("SELECT status FROM treatment_plans WHERE id = ?").get(p2.id).status, "completed");
  assert.equal((await c.post(`/ehr/treatment-plans/${p2.id}/complete`)).status, 409);

  // Audit trail
  const actions = t.db.prepare("SELECT action, entity_id FROM audit_log WHERE entity_type = 'treatment_plan' AND patient_id = ?").all(pid);
  const has = (a, id) => actions.some((x) => x.action === a && (id === undefined || x.entity_id === id));
  assert.ok(has("view"));
  assert.ok(has("create", p1.id));
  assert.ok(has("update", p1.id));
  assert.ok(has("activate", p1.id));
  assert.ok(has("activate", p2.id));
  assert.ok(has("supersede", p1.id));
  assert.ok(has("complete", p2.id));
});

test("activation requires a review date", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  await c.post(`/ehr/patients/${pid}/treatment-plan`, { start_date: today(), review_date: "" });
  const p = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ?").get(pid);
  await c.post(`/ehr/treatment-plans/${p.id}/goals`, { problem: "P", goal: "G" });
  const r = await c.post(`/ehr/treatment-plans/${p.id}/activate`);
  assert.equal(r.status, 400);
  assert.match(r.text, /review date/);
  assert.equal(t.db.prepare("SELECT status FROM treatment_plans WHERE id = ?").get(p.id).status, "draft");
});

test("overdue review date is highlighted", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  const id = Number(t.db.prepare(`INSERT INTO treatment_plans (patient_id, author_id, status, start_date, review_date, signed_at)
    VALUES (?, ?, 'active', ?, ?, datetime('now'))`).run(pid, c.userId, addDays(today(), -100), addDays(today(), -3)).lastInsertRowid);
  t.db.prepare("INSERT INTO treatment_goals (plan_id, problem, goal) VALUES (?, 'P', 'G')").run(id);
  const r = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.match(r.text, /Review overdue/);
});

test("escaping of user content", async () => {
  const c = await t.login("therapist");
  const pid = newPatient();
  await c.post(`/ehr/patients/${pid}/treatment-plan`, { review_date: addDays(today(), 30), summary: "<script>x</script>" });
  const r = await c.get(`/ehr/patients/${pid}/treatment-plan`);
  assert.doesNotMatch(r.text, /<script>x<\/script>/);
  assert.match(r.text, /&lt;script&gt;x/);
});

/* ---------------- permissions ---------------- */

test("frontdesk and billing are forbidden", async () => {
  const pid = t.ctx.patients[0];
  const plan = t.db.prepare("SELECT id FROM treatment_plans WHERE patient_id = ? LIMIT 1").get(pid);
  for (const role of ["frontdesk", "billing"]) {
    const c = await t.login(role);
    assert.equal((await c.get(`/ehr/patients/${pid}/treatment-plan`)).status, 403, role);
    assert.equal((await c.get(`/ehr/patients/${pid}/measures`)).status, 403, role);
    assert.equal((await c.get(`/ehr/patients/${pid}/measures/new?instrument=PHQ9`)).status, 403, role);
    assert.equal((await c.post(`/ehr/patients/${pid}/measures`, form("PHQ9", resp("PHQ9", 3)))).status, 403, role);
    assert.equal((await c.post(`/ehr/patients/${pid}/treatment-plan`, { review_date: today() })).status, 403, role);
    if (plan) assert.equal((await c.post(`/ehr/treatment-plans/${plan.id}/activate`)).status, 403, role);
  }
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'forbidden'").get());
});

test("unknown patient / plan -> 404", async () => {
  const c = await t.login("admin");
  assert.equal((await c.get("/ehr/patients/999999/treatment-plan")).status, 404);
  assert.equal((await c.get("/ehr/patients/999999/measures")).status, 404);
  assert.equal((await c.post("/ehr/treatment-plans/999999/activate")).status, 404);
  assert.equal((await c.get(`/ehr/patients/${t.ctx.patients[0]}/treatment-plan?plan=999999`)).status, 404);
});

/* ---------------- seed ---------------- */

test("seed data: active plans, improving series, recent flagged PHQ-9", () => {
  const db = t.db;
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM treatment_plans WHERE status = 'active'").get().n >= 2);
  assert.ok(db.prepare("SELECT 1 FROM assessments WHERE instrument = 'PHQ9' AND flagged = 1 AND administered_on >= date('now','-14 days')").get());
  const rows = db.prepare("SELECT * FROM assessments").all();
  for (const r of rows) {
    const s = scoreInstrument(r.instrument, JSON.parse(r.responses));
    assert.equal(s.total, r.total_score);
    assert.equal(s.severity, r.severity);
    assert.equal(s.flagged, r.flagged);
  }
});

test("dashboard safety panel shows seeded flag", async () => {
  const c = await t.login("therapist");
  const r = await c.get("/ehr");
  assert.match(r.text, /Safety follow-up/);
});
