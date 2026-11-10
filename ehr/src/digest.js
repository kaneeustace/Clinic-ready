"use strict";
/*
 * End-of-day email: each clinician gets a summary of their outstanding notes before they leave.
 *
 *   EHR_DIGEST_TIME   local send time, HH:MM in EHR_TZ (default 16:30)
 *   EHR_DIGEST_DAYS   days to send, 0=Sun..6=Sat, e.g. "1-5" or "1,2,3,4,5,6" (default 1-5, Monday to Friday)
 *   EHR_PUBLIC_URL    link in the email (Render sets RENDER_EXTERNAL_URL automatically, used as a fallback)
 *
 * Who gets it: active staff who write notes (clinical:write) with an email address, who haven't turned it off on
 * their Account page, and who have something outstanding. Nobody is emailed "you have nothing to do".
 * Contents: counts only (sessions without a note, unsigned drafts, co-signatures owed, how many are overdue) and a
 * sign-in link. No patient names, dates of service or other PHI ever go in the email.
 * The scheduler checks every minute; it sends once per day within 4 hours after the send time (so a server that was
 * asleep at 4:30 still sends at 5:10, but never at 2 a.m.). Each send is logged in digest_log and the audit log.
 */
const { buildWorkboard } = require("./workboard");
const { can } = require("./permissions");
const { nowLocal, TZ } = require("./views");
const { audit } = require("./audit");
const mailer = require("./mailer");
const sup = require("./supervision");

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function digestConfig(env = process.env) {
  const time = TIME_RE.test(env.EHR_DIGEST_TIME || "") ? env.EHR_DIGEST_TIME : "16:30";
  const days = parseDays(env.EHR_DIGEST_DAYS || "1-5");
  const off = String(env.EHR_DIGEST || "").toLowerCase() === "off" || env.EHR_DIGEST === "0";
  return { time, days, off, url: (env.EHR_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "") };
}
function parseDays(s) {
  const out = new Set();
  for (const part of String(s).split(",")) {
    const m = /^\s*([0-6])\s*(?:-\s*([0-6]))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    for (let d = a; d <= b; d++) out.add(d);
  }
  return out.size ? out : new Set([1, 2, 3, 4, 5]);
}
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayLabel = (days) => [...days].sort().map((d) => DAY_NAMES[d]).join(", ");
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fmt12 = (hhmm) => { const h = Number(hhmm.slice(0, 2)); return `${h % 12 || 12}:${hhmm.slice(3)} ${h < 12 ? "AM" : "PM"}`; };

/** Outstanding-notes counts for one user (no PHI). */
function summarize(db, user, now = Date.now()) {
  const wb = buildWorkboard(db, user);
  const write = wb.todo.filter((i) => i.kind === "write");
  const sign = wb.progress.filter((i) => i.kind === "sign");
  const cosign = wb.progress.filter((i) => i.kind === "cosign");
  const awaiting = wb.progress.filter((i) => i.kind === "await");
  const action = [...write, ...sign, ...cosign];
  const overdue = action.filter((i) => i.dueMs && i.dueMs < now);
  const dueSoon = action.filter((i) => i.dueMs && i.dueMs >= now && i.dueMs < now + 24 * 3.6e6);
  const oldest = overdue.reduce((m, i) => Math.min(m, i.dueMs), Infinity);
  return { write: write.length, sign: sign.length, cosign: cosign.length, awaiting: awaiting.length, total: action.length,
    overdue: overdue.length, dueSoon: dueSoon.length, oldestOverdueHours: overdue.length ? Math.floor((now - oldest) / 3.6e6) : 0 };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function composeEmail(user, s, cfg = digestConfig(), clinicName = "Clinic Ready") {
  const first = String(user.name || "").split(" ")[0] || "there";
  const link = cfg.url ? `${cfg.url}/ehr` : "";
  const lines = [];
  if (s.write) lines.push(`${plural(s.write, "session needs", "sessions need")} a note written`);
  if (s.sign) lines.push(`${plural(s.sign, "draft note is", "draft notes are")} waiting for your signature`);
  if (s.cosign) lines.push(`${plural(s.cosign, "supervisee note needs", "supervisee notes need")} your co-signature`);
  const subject = `${plural(s.total, "note", "notes")} outstanding${s.overdue ? ` (${s.overdue} overdue)` : ""} · ${clinicName}`;
  const overdueLine = s.overdue
    ? `${plural(s.overdue, "item is", "items are")} past the deadline${s.oldestOverdueHours >= 1 ? ` (the oldest by ${s.oldestOverdueHours >= 48 ? `${Math.floor(s.oldestOverdueHours / 24)} days` : `${s.oldestOverdueHours} hours`})` : ""}.`
    : "";
  const soonLine = s.dueSoon ? `${plural(s.dueSoon, "item is", "items are")} due in the next 24 hours.` : "";
  const awaitLine = s.awaiting ? `For your information: ${plural(s.awaiting, "of your notes is", "of your notes are")} waiting on your supervisor's co-signature.` : "";
  const rule = `Notes are due ${sup.SIGN_HOURS()} hours after the session; supervisor co-signatures ${sup.COSIGN_HOURS()} hours after you sign.`;
  const text = [
    `Hi ${first},`, "", "Before you leave today, here is what's outstanding:", "",
    ...lines.map((l) => `  • ${l}`), "",
    ...[overdueLine, soonLine, awaitLine].filter(Boolean), overdueLine || soonLine || awaitLine ? "" : null,
    rule, "", link ? `Open your workboard: ${link}` : "Sign in to the EHR to see your workboard.", "",
    "This email has no patient information. Turn these emails off on your Account page.",
  ].filter((l) => l !== null).join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#172337">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e3e8ef">
<tr><td style="background:linear-gradient(120deg,#1b2f63,#2c4fd0 55%,#149c96);background-color:#2c4fd0;padding:22px 24px;color:#fff">
<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.8">${escHtml(clinicName)} · end of day</div>
<div style="font-size:22px;font-weight:700;margin-top:4px">${escHtml(plural(s.total, "note", "notes"))} outstanding</div></td></tr>
<tr><td style="padding:22px 24px;font-size:15px;line-height:1.55">
<p style="margin:0 0 12px">Hi ${escHtml(first)}, before you leave today:</p>
<ul style="margin:0 0 14px;padding-left:20px">${lines.map((l) => `<li style="margin-bottom:6px">${escHtml(l)}</li>`).join("")}</ul>
${s.overdue ? `<p style="margin:0 0 10px;padding:10px 12px;border-radius:10px;background:#fdecea;color:#b42318;font-weight:600">${escHtml(overdueLine)}</p>` : ""}
${s.dueSoon ? `<p style="margin:0 0 10px;padding:10px 12px;border-radius:10px;background:#fff3dc;color:#8a5a00;font-weight:600">${escHtml(soonLine)}</p>` : ""}
${s.awaiting ? `<p style="margin:0 0 10px;color:#5d6b7e">${escHtml(awaitLine)}</p>` : ""}
<p style="margin:0 0 18px;color:#5d6b7e;font-size:13px">${escHtml(rule)}</p>
${link ? `<a href="${escHtml(link)}" style="display:inline-block;background:#315de7;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px">Open my workboard</a>` : `<p style="margin:0">Sign in to the EHR to see your workboard.</p>`}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #eef2f8;color:#8a96a8;font-size:12px">This email has no patient information. You can turn these emails off on your Account page in the EHR.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

const sysReq = (db) => ({ db, user: null, ip: null });

/** Users who should get a digest. */
function recipients(db) {
  return db.prepare("SELECT * FROM users WHERE active = 1 AND email IS NOT NULL AND email <> '' AND COALESCE(digest_email, 1) = 1 ORDER BY name")
    .all().filter((u) => can(u, "clinical:write"));
}

/**
 * Send today's digests. Skips users already emailed today unless `force`. `onlyUserId` limits to one user.
 * Returns { sent, skipped, failed, results: [{ userId, status, detail }] }.
 */
async function runDigest(db, { date = nowLocal().slice(0, 10), force = false, onlyUserId = null, mailCfg = mailer.mailConfig(), cfg = digestConfig() } = {}) {
  const out = { sent: 0, skipped: 0, failed: 0, results: [] };
  if (!mailCfg.enabled) throw new Error(`Email is not set up: ${mailCfg.reason}`);
  const log = db.prepare(`INSERT INTO digest_log (user_id, run_date, status, detail) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, run_date) DO UPDATE SET status = excluded.status, detail = excluded.detail, created_at = datetime('now')`);
  for (const u of recipients(db)) {
    if (onlyUserId && u.id !== onlyUserId) continue;
    const prior = db.prepare("SELECT status FROM digest_log WHERE user_id = ? AND run_date = ?").get(u.id, date);
    if (!force && prior && prior.status === "sent") { out.skipped++; continue; }
    const s = summarize(db, u);
    if (!s.total) { log.run(u.id, date, "nothing", null); out.skipped++; out.results.push({ userId: u.id, status: "nothing" }); continue; }
    const mail = composeEmail(u, s, cfg, require("./clinic").getClinic(db).name);
    try {
      await mailer.sendMail({ to: u.email, ...mail }, mailCfg);
      log.run(u.id, date, "sent", `${s.total} outstanding, ${s.overdue} overdue`);
      audit(sysReq(db), "email_digest", "user", u.id, null, `sent: ${s.total} outstanding, ${s.overdue} overdue`);
      out.sent++; out.results.push({ userId: u.id, status: "sent" });
    } catch (e) {
      const msg = String(e.message || e).replace(/AUTH PLAIN \S+/g, "AUTH PLAIN ***").slice(0, 300);
      log.run(u.id, date, "failed", msg);
      audit(sysReq(db), "email_digest", "user", u.id, null, "failed");
      out.failed++; out.results.push({ userId: u.id, status: "failed", detail: msg });
    }
  }
  return out;
}

/** Is it time to send (scheduled day, within 4 hours after the send time, not yet run today)? */
function isDue(db, local = nowLocal(), cfg = digestConfig()) {
  if (cfg.off) return false;
  const date = local.slice(0, 10), t = minutes(local.slice(11, 16)), start = minutes(cfg.time);
  if (!cfg.days.has(weekday(date)) || t < start || t >= start + 240) return false;
  return !db.prepare("SELECT 1 FROM digest_runs WHERE run_date = ?").get(date);
}

let running = false;
async function tick(db) {
  if (running) return;
  const mailCfg = mailer.mailConfig();
  if (!mailCfg.enabled || !isDue(db)) return;
  running = true;
  const date = nowLocal().slice(0, 10);
  try {
    db.prepare("INSERT OR IGNORE INTO digest_runs (run_date) VALUES (?)").run(date);
    const r = await runDigest(db, { date, mailCfg });
    db.prepare("UPDATE digest_runs SET finished_at = datetime('now'), sent = ?, skipped = ?, failed = ? WHERE run_date = ?").run(r.sent, r.skipped, r.failed, date);
    console.log(`[digest] ${date}: sent ${r.sent}, skipped ${r.skipped}, failed ${r.failed}`);
  } catch (e) {
    console.error("[digest] run failed:", e.message);
  } finally { running = false; }
}

/** Start-up hook for server.js. */
function scheduleDigests(db) {
  const cfg = digestConfig(), mailCfg = mailer.mailConfig();
  if (cfg.off) { console.log("[digest] End-of-day note emails are turned off (EHR_DIGEST=off)."); return null; }
  if (!mailCfg.enabled) { console.warn(`[digest] End-of-day note emails are not sending: ${mailCfg.reason}`); }
  else console.log(`[digest] End-of-day note emails at ${cfg.time} (${TZ}) on ${dayLabel(cfg.days)} via ${mailCfg.provider}.`);
  const t = setInterval(() => { tick(db).catch(() => {}); }, 60e3);
  t.unref();
  return t;
}

module.exports = { digestConfig, parseDays, dayLabel, fmt12, summarize, composeEmail, recipients, runDigest, isDue, tick, scheduleDigests };
