"use strict";
/* Per-appointment-type calendar colors. Admins change them under Administration → Appointment colors. */
const DEFAULTS = {
  intake: "#7c3aed", therapy: "#315de7", psychiatry_eval: "#db2777", med_management: "#0891b2",
  family: "#ea580c", group: "#16a34a", consult: "#64748b",
};
const SWATCHES = ["#315de7", "#0891b2", "#0f8f86", "#16a34a", "#65a30d", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#9333ea", "#7c3aed", "#64748b"];
const HEX = /^#[0-9a-f]{6}$/;

function apptColors(db) {
  const out = { ...DEFAULTS };
  try { for (const r of db.prepare("SELECT type, color FROM appointment_type_colors").all()) if (HEX.test(r.color)) out[r.type] = r.color; } catch { /* table missing in very old DBs */ }
  return out;
}
const colorFor = (colors, type) => colors[type] || "#64748b";

module.exports = { DEFAULTS, SWATCHES, HEX, apptColors, colorFor };
