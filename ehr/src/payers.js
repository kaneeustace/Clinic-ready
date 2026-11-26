"use strict";
/*
 * Payer profiles. AHCCCS (Arizona Medicaid) fields, rules and checks apply only when the patient has an
 * AHCCCS ID on file. Everyone else gets the standard forms.
 * AHCCCS_PLANS is used to remind staff to enter the AHCCCS ID when an AHCCCS health plan is added.
 */
const AHCCCS_PLANS = [/ahcccs/i, /mercy care/i, /banner.*(university|health plan)/i, /\bb-?uhp\b/i, /arizona complete health/i, /\bazch\b/i,
  /unitedhealthcare community plan/i, /\buhccp\b/i, /care1st/i, /health choice/i, /molina.*arizona/i, /\bdcs chp\b/i, /comprehensive health plan/i,
  /\baihp\b/i, /american indian health program/i, /\btrbha\b/i];

function profileFor(db, patientId) {
  const p = db.prepare("SELECT ahcccs_id FROM patients WHERE id = ?").get(patientId);
  return p && p.ahcccs_id && String(p.ahcccs_id).trim() ? "AHCCCS" : "STANDARD";
}
const isAhcccsPlan = (name) => AHCCCS_PLANS.some((re) => re.test(name || ""));
const isAhcccs = (db, patientId) => profileFor(db, patientId) === "AHCCCS";

/** AHCCCS 15-minute unit rule (CBHSG Core Billing Limitation #10): <8 min = 0; 8-22 = 1; 23-37 = 2; ... */
function unitsFor15(minutes) {
  if (!Number.isFinite(minutes) || minutes < 8) return 0;
  return Math.floor((minutes - 8) / 15) + 1;
}

/** Education-level modifier from credentials (AHCCCS: HM < bachelor, HN bachelor, HO master, HP doctoral). Best guess; staff can override. */
function educationModifier(user) {
  if (user && user.education_level) return user.education_level;
  // Credentials in the shared list (options.CREDENTIALS) use their edu flag; anything else uses the older regexes.
  // The highest level found wins. Required lazily (supervision -> views; avoids load-order surprises).
  const RANK = { HM: 1, HN: 2, HO: 3, HP: 4 };
  let best = null;
  for (const { token, cred } of require("./supervision").credentialTokens(user && user.credentials)) {
    let lvl = null;
    if (cred) lvl = cred.edu || null;
    else if (/\b(PHD|PSYD|EDD|MD|DO|DNP)\b/.test(token)) lvl = "HP";
    else if (/\b(LCSW|LMSW|LPC|LAC|LMFT|LAMFT|LISAC|LASAC|MSW|MA|MS|MED|PMHNP|NP)\b/.test(token)) lvl = "HO";
    else if (/\b(BA|BS|BSW|BHT)\b/.test(token)) lvl = "HN";
    if (lvl && (!best || RANK[lvl] > RANK[best])) best = lvl;
  }
  return best;
}

module.exports = { profileFor, isAhcccs, isAhcccsPlan, unitsFor15, educationModifier, AHCCCS_PLANS };
