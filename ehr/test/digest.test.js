"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { start } = require("./helpers");
const { today } = require("../src/views");
const mailer = require("../src/mailer");
const digest = require("../src/digest");

let t, pid, sent = [];
before(async () => {
  t = await start();
  mailer.setTestTransport(async (m) => { sent.push(m); });
  pid = t.ctx.patients[4];
  // A completed session today with no note for Taylor => one "write" item.
  t.db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status)
    VALUES (?, ?, ?, ?, 'therapy', 'in_person', 'completed')`).run(pid, t.ctx.users.therapist, `${today()}T00:00`, `${today()}T00:50`);
});
after(async () => { mailer.setTestTransport(null); await t.stop(); });

test("summary counts outstanding notes and the email has no patient information", () => {
  const u = t.db.prepare("SELECT * FROM users WHERE id = ?").get(t.ctx.users.therapist);
  const s = digest.summarize(t.db, u);
  assert.ok(s.write >= 1);
  assert.equal(s.total, s.write + s.sign + s.cosign);
  const mail = digest.composeEmail(u, s, { ...digest.digestConfig(), url: "https://ehr.example.org" });
  assert.match(mail.subject, /notes? outstanding/);
  assert.match(mail.text, /https:\/\/ehr\.example\.org\/ehr/);
  const names = t.db.prepare("SELECT first_name, last_name, mrn FROM patients").all();
  for (const p of names) for (const v of [p.first_name, p.last_name, p.mrn]) {
    assert.ok(!mail.text.includes(v) && !mail.html.includes(v), `email must not include ${v}`);
  }
});

test("runDigest emails staff with outstanding notes once per day; opt-out respected", async () => {
  sent = [];
  const date = today();
  const r = await digest.runDigest(t.db, { date });
  assert.ok(r.sent >= 1);
  const taylor = t.db.prepare("SELECT email FROM users WHERE id = ?").get(t.ctx.users.therapist).email;
  assert.ok(sent.some((m) => m.to === taylor));
  // Front desk and billing never get it (they don't write notes)
  for (const k of ["frontdesk", "billing"]) {
    const e = t.db.prepare("SELECT email FROM users WHERE id = ?").get(t.ctx.users[k]).email;
    assert.ok(!sent.some((m) => m.to === e), k);
  }
  assert.equal(t.db.prepare("SELECT status FROM digest_log WHERE user_id = ? AND run_date = ?").get(t.ctx.users.therapist, date).status, "sent");
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'email_digest' AND entity_id = ?").get(t.ctx.users.therapist));
  // Second run the same day: no duplicates
  sent = [];
  await digest.runDigest(t.db, { date });
  assert.ok(!sent.some((m) => m.to === taylor));

  // Opt out on the Account page
  const c = await t.login("therapist");
  assert.match((await c.get("/ehr/account")).text, /End-of-day email/);
  assert.equal((await c.post("/ehr/account/digest", {})).status, 302);
  assert.equal(t.db.prepare("SELECT digest_email FROM users WHERE id = ?").get(t.ctx.users.therapist).digest_email, 0);
  sent = [];
  await digest.runDigest(t.db, { date, force: true });
  assert.ok(!sent.some((m) => m.to === taylor));
  await c.post("/ehr/account/digest", { digest_email: "1" });
});

test("schedule: due on configured weekdays within 4 hours after the send time, once per day", () => {
  const cfg = { ...digest.digestConfig({ EHR_DIGEST_TIME: "16:30", EHR_DIGEST_DAYS: "1-5" }) };
  // 2026-11-09 is a Monday, 2026-11-14 a Saturday
  assert.equal(digest.isDue(t.db, "2026-11-09T16:29", cfg), false);
  assert.equal(digest.isDue(t.db, "2026-11-09T16:30", cfg), true);
  assert.equal(digest.isDue(t.db, "2026-11-09T20:29", cfg), true);
  assert.equal(digest.isDue(t.db, "2026-11-09T20:31", cfg), false);
  assert.equal(digest.isDue(t.db, "2026-11-14T17:00", cfg), false);
  t.db.prepare("INSERT INTO digest_runs (run_date) VALUES ('2026-11-09')").run();
  assert.equal(digest.isDue(t.db, "2026-11-09T17:00", cfg), false);
  assert.deepEqual([...digest.parseDays("0,6")], [0, 6]);
});

test("admin email page and send-now", async () => {
  const admin = await t.login("admin");
  const p = await admin.get("/ehr/admin/email");
  assert.equal(p.status, 200);
  assert.match(p.text, /End-of-day note emails/);
  sent = [];
  const r = await admin.post("/ehr/admin/email/test", {});
  assert.equal(r.status, 302);
  assert.match(sent[0].subject, /^\[Sample\]/);
  const n = await admin.post("/ehr/admin/email/send-now", {});
  assert.equal(n.status, 200);
  assert.match(n.text, /Sent \d+/);
  const clin = await t.login("therapist");
  assert.equal((await clin.get("/ehr/admin/email")).status, 403);
});

test("SMTP client speaks the protocol and refuses servers without encryption", async () => {
  const got = [];
  const server = net.createServer((sock) => {
    let inData = false, data = "";
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (d) => {
      for (const line of d.toString().split("\r\n").filter((x, i, a) => i < a.length - 1 || x)) {
        if (inData) { if (line === ".") { inData = false; got.push(data); sock.write("250 queued\r\n"); } else data += line + "\n"; continue; }
        got.push(line.split(" ")[0]);
        if (/^EHLO/.test(line)) sock.write("250-test\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH/.test(line)) sock.write("235 ok\r\n");
        else if (/^(MAIL|RCPT)/.test(line)) sock.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { enabled: true, provider: "smtp", host: "127.0.0.1", port: server.address().port, secure: false, user: "u@example.com", pass: "pw", from: "Clinic <u@example.com>" };
  const mime = mailer.buildMime({ from: cfg.from, to: "x@example.com", subject: "Hello", text: "Line\n.dot", html: "<p>Hi</p>" });
  await assert.rejects(mailer.sendSmtp(cfg, { to: "x@example.com", mime }), /STARTTLS/);
  await mailer.sendSmtp(cfg, { to: "x@example.com", mime }, { allowInsecure: true });
  assert.deepEqual(got.filter((x) => /^[A-Z]+$/.test(x)).slice(-6), ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
  assert.ok(got.some((x) => x.includes("Subject: Hello")));
  server.close();
});
