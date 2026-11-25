"use strict";
// Demo patient portal: Jordan Rivera (fictional) has an account and a short message thread.
const { hashPassword } = require("../auth");

module.exports = function seedPortal(db, ctx) {
  if (process.env.EHR_DEMO !== "1") return;
  const P = ctx.patients;
  if (!P.length) return;
  const pid = P[0];
  db.prepare("INSERT INTO portal_accounts (patient_id, email, password_hash) VALUES (?, 'jordan.rivera@example.com', ?)").run(pid, hashPassword(ctx.password));
  const ins = db.prepare("INSERT INTO portal_messages (patient_id, thread_id, from_patient, staff_user_id, subject, body, created_at, read_at, handled_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?)");
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString().replace("T", " ").slice(0, 19);
  const first = Number(ins.run(pid, null, 1, null, "Can I move Thursday's session?", "Something came up at work. Is there anything Friday morning instead?", "-26 hours", ago(25.5), ago(25)).lastInsertRowid);
  db.prepare("UPDATE portal_messages SET thread_id = ? WHERE id = ?").run(first, first);
  ins.run(pid, first, 0, ctx.users.therapist, "Re: Can I move Thursday's session?", "Friday at 9:00 works. I've moved it, and you'll get a reminder the day before.", "-25 hours", null, null);
  ins.run(pid, first, 1, null, "Re: Can I move Thursday's session?", "Perfect, thank you!", "-2 hours", null, null);
};
