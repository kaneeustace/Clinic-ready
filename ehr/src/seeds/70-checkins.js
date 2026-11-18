"use strict";
// Demo only: today's group sessions and phone check-ins so the Check-ins page, rosters and dashboard have something to show.
const { today } = require("../views");

module.exports = function seedCheckins(db, ctx) {
  if (process.env.EHR_DEMO !== "1") return;
  const P = ctx.patients, U = ctx.users, d = today();
  if (P.length < 6) return;
  const ins = db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const appt = (pid, clin, start, end, type, status, modality = "in_person") =>
    Number(ins.run(pid, clin, `${d}T${start}`, `${d}T${end}`, type, modality, status, U.frontdesk).lastInsertRowid);
  const sup = require("../supervision");
  const utc = (hhmm) => new Date(sup.localToMs(d, hhmm)).toISOString().slice(0, 19).replace("T", " ");
  const ci = db.prepare(`INSERT INTO checkins (appointment_id, patient_id, source, step, started_at, completed_at, contact_changes, insurance_changed,
    insurance_payer, consent_name, consent_at, quick, link_sent_at, link_sent_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // Morning adult IOP group (Taylor): 3 of 5 here (one used the one-tap check-in), one still checking in, one not here yet.
  const iop = [P[0], P[1], P[2], P[3], P[4]].map((pid, i) => ({ pid, id: appt(pid, U.therapist, "09:00", "12:00", "group", i < 3 ? "checked_in" : "scheduled") }));
  ci.run(iop[0].id, iop[0].pid, "lobby", "done", utc("08:46"), utc("08:48"), null, 0, null, "Jordan Rivera", utc("08:48"), 0, null, null);
  ci.run(iop[1].id, iop[1].pid, "link", "done", utc("08:51"), utc("08:51"), JSON.stringify({ phone: "(602) 555-0142" }), 0, null, null, null, 1, utc("08:00"), "text");
  ci.run(iop[2].id, iop[2].pid, "lobby", "done", utc("08:53"), utc("08:56"), null, 1, "Mercy Care", "Sam Okafor", utc("08:56"), 0, null, null);
  ci.run(iop[3].id, iop[3].pid, "link", "insurance", utc("08:58"), null, null, null, null, null, null, 0, utc("08:00"), "email");

  // Evening telehealth teen group (Casey): 1 of 3 here.
  [P[5], P[6] || P[1], P[7] || P[2]].forEach((pid, i) => appt(pid, U.therapist2, "17:30", "19:00", "group", i === 0 ? "checked_in" : "scheduled", "telehealth"));
};
