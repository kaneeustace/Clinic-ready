"use strict";
/*
 * Demo data. SYNTHETIC ONLY: never load real patient information into a demo.
 *   npm run seed            -> seeds ./data/ehr.sqlite (refuses if users already exist)
 *   npm run seed -- --reset -> deletes the database file first
 * Module-specific seed data lives in src/seeds/*.js, each exporting `function (db, ctx)`.
 */
const fs = require("node:fs");
const path = require("node:path");
const { openDb, tx } = require("./db");
const { hashPassword } = require("./auth");
const { today, addDays } = require("./views");

const DEMO_PASSWORD = process.env.EHR_DEMO_PASSWORD || "Demo-Password-2026!";

const USERS = [
  { key: "admin", email: "admin@example.com", name: "Alex Admin", role: "admin", credentials: null },
  { key: "therapist", email: "therapist@example.com", name: "Taylor Therapist", role: "clinician", credentials: "LCSW", npi: "0000000001" },
  { key: "therapist2", email: "counselor@example.com", name: "Casey Counselor", role: "clinician", credentials: "LPC", npi: "0000000002" },
  { key: "prescriber", email: "prescriber@example.com", name: "Pat Prescriber", role: "clinician", credentials: "PMHNP-BC", npi: "0000000003" },
  { key: "frontdesk", email: "frontdesk@example.com", name: "Frankie Frontdesk", role: "frontdesk", credentials: null },
  { key: "billing", email: "billing@example.com", name: "Bailey Biller", role: "billing", credentials: null },
];

const FEES = [
  ["90791", "Psychiatric diagnostic evaluation", 22000],
  ["90792", "Psychiatric diagnostic evaluation with medical services", 28000],
  ["90832", "Psychotherapy, 30 min", 9000],
  ["90834", "Psychotherapy, 45 min", 13500],
  ["90837", "Psychotherapy, 60 min", 17500],
  ["90846", "Family psychotherapy without patient, 50 min", 14000],
  ["90847", "Family psychotherapy with patient, 50 min", 15000],
  ["90853", "Group psychotherapy", 6000],
  ["90839", "Psychotherapy for crisis, first 60 min", 20000],
  ["99213", "Office/outpatient visit, established, low complexity", 12000],
  ["99214", "Office/outpatient visit, established, moderate complexity", 17000],
  ["96127", "Brief emotional/behavioral assessment", 1500],
];

// Synthetic patients (fictional).
const PATIENTS = [
  ["Jordan", "Rivera", null, "1991-04-12", "they/them", "therapist"],
  ["Morgan", "Lee", "Mo", "1985-09-30", "she/her", "therapist"],
  ["Sam", "Okafor", null, "2008-01-22", "he/him", "therapist2"],
  ["Riley", "Nguyen", null, "1978-06-05", "she/her", "prescriber"],
  ["Devon", "Brooks", null, "1999-11-17", "he/him", "therapist2"],
  ["Quinn", "Patel", null, "1994-02-08", "she/they", "therapist"],
  ["Harper", "Johansson", null, "1969-12-01", "she/her", "prescriber"],
  ["Elliot", "Martinez", "Eli", "2002-07-19", "he/him", "therapist2"],
  ["Rowan", "Kim", null, "1988-03-27", "they/them", "therapist"],
  ["Avery", "Thompson", null, "1975-10-10", "he/him", "prescriber"],
];

function seed(db, { password = DEMO_PASSWORD } = {}) {
  const ctx = { users: {}, patients: [], password };
  tx(db, () => {
    const hash = hashPassword(password);
    const insUser = db.prepare("INSERT INTO users (email, name, role, credentials, npi, password_hash) VALUES (?, ?, ?, ?, ?, ?)");
    for (const u of USERS) {
      ctx.users[u.key] = Number(insUser.run(u.email, u.name, u.role, u.credentials, u.npi || null, hash).lastInsertRowid);
    }
    const insFee = db.prepare("INSERT OR REPLACE INTO fee_schedule (cpt_code, description, fee_cents) VALUES (?, ?, ?)");
    FEES.forEach((f) => insFee.run(...f));

    const insPt = db.prepare(`INSERT INTO patients (mrn, first_name, last_name, preferred_name, dob, pronouns, phone, email,
      address_line1, city, state, zip, preferred_contact, ok_voicemail, emergency_name, emergency_relation, emergency_phone, primary_clinician_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Your City', 'ST', '00000', 'phone', 1, ?, ?, ?, ?)`);
    const insIns = db.prepare(`INSERT INTO insurance_policies (patient_id, payer_name, member_id, group_number, subscriber_name, subscriber_relation, copay_cents)
      VALUES (?, ?, ?, ?, ?, 'self', ?)`);
    PATIENTS.forEach(([first, last, pref, dob, pronouns, clin], i) => {
      const n = i + 1;
      const id = Number(insPt.run(`CR-${String(n).padStart(6, "0")}`, first, last, pref, dob, pronouns,
        `(555) 010-${String(1000 + n)}`, `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        `${100 + n} Sample St`, "Emergency Contact", "Family", "(555) 010-9999", ctx.users[clin]).lastInsertRowid);
      ctx.patients.push(id);
      if (n % 4 !== 0) insIns.run(id, n % 2 ? "Sample Health Plan" : "Example Mutual", `MBR${100000 + n}`, `GRP${200 + n}`, `${first} ${last}`, 2500);
    });

    // Appointments across this week and last week.
    const insAppt = db.prepare(`INSERT INTO appointments (patient_id, clinician_id, start_at, end_at, type, modality, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const t = today();
    const slots = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
    let k = 0;
    for (let d = -7; d <= 7; d++) {
      const day = addDays(t, d);
      const dow = new Date(day + "T12:00:00Z").getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (let s = 0; s < 3; s++) {
        const pid = ctx.patients[k % ctx.patients.length];
        const p = PATIENTS[k % PATIENTS.length];
        const clin = ctx.users[p[5]];
        const start = slots[(k + s) % slots.length];
        const [h, m] = start.split(":").map(Number);
        const end = `${String(h + (p[5] === "prescriber" ? 0 : 0)).padStart(2, "0")}:${p[5] === "prescriber" ? "30" : "50"}`;
        const type = p[5] === "prescriber" ? "med_management" : "therapy";
        const status = d < 0 ? (k % 9 === 0 ? "no_show" : "completed") : "scheduled";
        insAppt.run(pid, clin, `${day}T${start}`, `${day}T${end}`, type, k % 3 === 0 ? "telehealth" : "in_person", status, ctx.users.frontdesk);
        k++;
        void m;
      }
    }

    // Website appointment requests.
    const insReq = db.prepare(`INSERT INTO appointment_requests (first_name, last_name, phone, email, contact_method, ok_voicemail,
      care_for, service, visit_preference, insurance, reason, referral_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insReq.run("Skyler", "Example", "(555) 010-2001", "skyler@example.com", "phone", "yes", "myself", "individual_therapy", "telehealth", "Sample Health Plan", "Looking for help with anxiety.", "search");
    insReq.run("Reese", "Sample", "(555) 010-2002", "reese@example.com", "email", "no", "my_child", "teen", "in_person", "", "", "referral");

    // Module seeds
    const dir = path.join(__dirname, "seeds");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js")).sort()) require(path.join(dir, f))(db, ctx);
    }
  });
  return ctx;
}

if (require.main === module) {
  const file = process.env.EHR_DB_PATH || path.join(__dirname, "..", "data", "ehr.sqlite");
  if (process.argv.includes("--reset")) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  const db = openDb(file);
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) {
    console.error("Database already has users. Use `npm run seed -- --reset` to start over.");
    process.exit(1);
  }
  seed(db);
  console.log(`Seeded ${file}`);
  console.log(`Demo logins (password: ${DEMO_PASSWORD}):`);
  USERS.forEach((u) => console.log(`  ${u.role.padEnd(10)} ${u.email}`));
}

module.exports = { seed, USERS, DEMO_PASSWORD };
