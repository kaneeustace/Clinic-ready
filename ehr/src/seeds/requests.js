"use strict";
// Extra synthetic website appointment requests (various ages and statuses) for the Requests inbox demo.
module.exports = function seedRequests(db) {
  const ins = db.prepare(`INSERT INTO appointment_requests (first_name, last_name, preferred_name, dob, phone, email, contact_method,
    ok_voicemail, care_for, service, visit_preference, insurance, reason, referral_source, status, staff_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`);
  const rows = [
    ["Jordan", "Demo", null, "1994-03-12", "(555) 010-2003", "jordan.demo@example.com", "text", "yes", "myself", "psychiatry", "either",
      "Demo Health PPO", "Would like a medication evaluation.", "doctor", "contacted", "Left voicemail; will try again Thursday.", "-3 days"],
    ["Morgan", "Placeholder", "Mo", null, "(555) 010-2004", null, "phone", "no", "partner_and_me", "couples_family", "in_person",
      "", "", "friend_family", "new", null, "-5 hours"],
    ["Riley", "Testcase", null, "2009-08-30", null, "riley.parent@example.com", "email", null, "my_child", "teen_young_adult", "telehealth",
      "Sample Health Plan", "Parent requesting support for teen.", "school_employer", "scheduled", "Intake booked.", "-10 days"],
    ["Quinn", "Synthetic", null, null, "(555) 010-2006", "quinn@example.com", "email", "no", "myself", "not_sure", "either",
      "", "Asked for information only.", "search", "closed", "Not seeking services at this time.", "-21 days"],
  ];
  for (const r of rows) { const age = r.pop(); ins.run(...r, age, age); }
};
