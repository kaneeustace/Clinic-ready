"use strict";
/*
 * Clinic-managed pick lists (table clinic_lists): rooms/locations, programs/tracks and therapy groups.
 * Managed by administrators under Administration → Clinic lists (routes/clinic.js). Used as dropdown options
 * (with "Other") on the schedule, level of care and group notes.
 */
const KINDS = { room: "Rooms and locations", program: "Programs and tracks", group: "Therapy groups" };
const DEFAULTS = {
  room: ["Office 1", "Office 2", "Group room"],
  program: ["Adult outpatient", "Intensive outpatient (IOP)", "Evening IOP", "Women's program", "Adolescent program", "Co-occurring / MAT"],
  group: ["Coping skills", "Relapse prevention", "DBT skills", "Anger management", "Parenting", "Process group"],
};

/** Active labels for a kind, in order. Seeds sensible defaults the first time a kind is used. */
function getList(db, kind) {
  if (!KINDS[kind]) return [];
  let rows;
  try { rows = db.prepare("SELECT label FROM clinic_lists WHERE kind = ? AND active = 1 ORDER BY sort, label").all(kind); } catch { return []; }
  if (!rows.length && !db.prepare("SELECT 1 FROM clinic_lists WHERE kind = ?").get(kind)) {
    const ins = db.prepare("INSERT OR IGNORE INTO clinic_lists (kind, label, sort) VALUES (?, ?, ?)");
    DEFAULTS[kind].forEach((l, i) => ins.run(kind, l, i));
    rows = db.prepare("SELECT label FROM clinic_lists WHERE kind = ? AND active = 1 ORDER BY sort, label").all(kind);
  }
  return rows.map((r) => r.label);
}

module.exports = { KINDS, DEFAULTS, getList };
