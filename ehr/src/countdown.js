"use strict";
const { html } = require("./views");
/**
 * A live countdown to a UTC deadline ('YYYY-MM-DD HH:MM:SS' or ISO). Server renders the current value;
 * public/ehr.js updates every element with [data-deadline] each 30 seconds until the item is signed (page reload).
 */
function remainingText(ms) {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400e3), h = Math.floor((abs % 86400e3) / 3600e3), m = Math.floor((abs % 3600e3) / 60e3);
  const span = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return ms >= 0 ? `Due in ${span}` : `Overdue by ${span}`;
}
function tone(ms, totalHours) {
  if (ms < 0) return "bad";
  return ms < Math.min(6, totalHours / 4) * 3600e3 ? "warn" : "info";
}
function countdown(dueUtc, totalHours = 24) {
  if (!dueUtc) return "";
  const iso = String(dueUtc).includes("T") ? String(dueUtc) : String(dueUtc).replace(" ", "T") + "Z";
  const ms = Date.parse(iso) - Date.now();
  return html`<span class="countdown badge badge--${tone(ms, totalHours)}" data-deadline="${iso}" data-total-hours="${totalHours}" role="timer">${remainingText(ms)}</span>`;
}
module.exports = { countdown, remainingText };
