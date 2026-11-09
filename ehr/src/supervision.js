"use strict";
/*
 * Signature deadlines and clinical supervision.
 *   - Every clinician signs their own note within SIGN_HOURS (default 24) of the end of the session.
 *   - Notes by clinicians who aren't independently licensed (BHT, BHPP, associate-level LMSW/LAC/LAMFT/LASAC, or anyone
 *     an admin marks "requires co-signature") also need their supervisor's co-signature within COSIGN_HOURS
 *     (default 48) of the clinician's signature.
 * Hours are configurable with EHR_SIGN_HOURS / EHR_COSIGN_HOURS. Verify the license list against your staff roster.
 */
const { TZ } = require("./views");

const SIGN_HOURS = () => Number(process.env.EHR_SIGN_HOURS || 24);
const COSIGN_HOURS = () => Number(process.env.EHR_COSIGN_HOURS || 48);

/** Independently licensed (may practice and sign without co-signature, and may supervise). */
const INDEPENDENT_RE = /\b(LCSW|LPC|LMFT|LISAC|PSYD|PHD|MD|DO|NP|PMHNP|PMHNP-BC|DNP|PA-C|APRN|LP)\b/i;
/** Note types that never need a co-signature. */
const NO_COSIGN_TYPES = ["psychotherapy", "roi"];

function requiresCosign(user) {
  if (!user) return false;
  if (user.requires_cosign === 1) return true;
  if (user.requires_cosign === 0) return false;
  if (!["clinician"].includes(user.role)) return false;
  return !INDEPENDENT_RE.test(String(user.credentials || ""));
}
const canSupervise = (user) => !!user && ["clinician", "admin"].includes(user.role) && user.active !== 0 &&
  (user.role === "admin" || INDEPENDENT_RE.test(String(user.credentials || "")));

/** May `user` co-sign a note written by `author`? Assigned supervisor, or (when none is assigned) any independent clinician. */
function mayCosign(user, author) {
  if (!user || !author || user.id === author.id || !canSupervise(user)) return false;
  return author.supervisor_id ? author.supervisor_id === user.id || user.role === "admin" : true;
}

/* ---------- time helpers ---------- */
/** Offset (ms) of the clinic time zone from UTC at a given instant. */
function tzOffset(ms) {
  const d = new Date(ms);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - ms;
}
/** Clinic-local 'YYYY-MM-DD' + 'HH:MM' -> epoch ms. */
function localToMs(ymd, hm = "23:59") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, mi] = (/^\d\d:\d\d$/.test(hm || "") ? hm : "23:59").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - tzOffset(guess);
}
const utcToMs = (s) => (s ? Date.parse(String(s).replace(" ", "T") + "Z") : null);
const msToUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** When did the service end? Uses the note's session end, else its appointment's end, else end of the service day. */
function serviceEndMs(note, appt) {
  let content = {};
  try { content = JSON.parse(note.content || "{}") || {}; } catch { content = {}; }
  const day = note.service_date || (appt && appt.end_at && appt.end_at.slice(0, 10));
  if (content.session_end && day) return localToMs(day, content.session_end);
  if (appt && appt.end_at) return localToMs(appt.end_at.slice(0, 10), appt.end_at.slice(11, 16));
  return day ? localToMs(day, "23:59") : null;
}

module.exports = { SIGN_HOURS, COSIGN_HOURS, INDEPENDENT_RE, NO_COSIGN_TYPES, requiresCosign, canSupervise, mayCosign,
  localToMs, utcToMs, msToUtc, serviceEndMs };
