"use strict";
/*
 * Automatic check-in links: before each of today's appointments, email or text the client their personal check-in link.
 *
 *   EHR_CHECKIN_AUTO=0              turn automatic sending off (default on when email or texting is set up)
 *   EHR_CHECKIN_LEAD_MINUTES=60     how long before the appointment to send (10–720)
 *   EHR_PUBLIC_URL                  the site address used in the link (Render sets RENDER_EXTERNAL_URL automatically)
 *
 * Channel: the client's preferred contact method (text → text, email → email); otherwise email when there is an
 * address, else text. Each appointment is sent at most once. Messages contain the clinic name and a link only.
 */
const { nowLocal } = require("./views");
const { audit } = require("./audit");
const mailer = require("./mailer");
const sms = require("./sms");

function reminderConfig(env = process.env) {
  const lead = Math.max(10, Math.min(720, Number(env.EHR_CHECKIN_LEAD_MINUTES || 60) || 60));
  const base = (env.EHR_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  return { on: env.EHR_CHECKIN_AUTO !== "0", lead, base };
}

/** Add minutes to a local 'YYYY-MM-DDTHH:MM' string. */
function addMinutesLocal(local, mins) {
  const d = new Date(`${local}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16);
}

function pickChannel(p, mailOn, smsOn) {
  const hasEmail = !!(p.email && /@/.test(p.email)), hasPhone = !!(p.phone && sms.toE164(p.phone));
  if (p.preferred_contact === "text" && hasPhone && smsOn) return "text";
  if (p.preferred_contact === "email" && hasEmail && mailOn) return "email";
  if (hasEmail && mailOn) return "email";
  if (hasPhone && smsOn) return "text";
  return null;
}

function messages(clinic, url, startLocal, isGroup) {
  const h = Number(startLocal.slice(11, 13)), m = startLocal.slice(14, 16);
  const time = `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
  const what = isGroup ? "group" : "appointment";
  return {
    text: `${clinic}: check in for your ${time} ${what} from your phone: ${url} (link works today only). Reply STOP to opt out.`,
    subject: `Check in for your ${time} ${what} · ${clinic}`,
    mailText: `Hello,\n\nYou can check in for today's ${time} ${what} with ${clinic} from your phone:\n${url}\n\nThe link works today only.\n\nIn crisis? Call or text 988.`,
    mailHtml: `<p>Hello,</p><p>You can check in for today's <strong>${time}</strong> ${what} with ${clinic.replace(/[<>&]/g, "")} from your phone.</p><p><a href="${url}" style="display:inline-block;background:#315de7;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Check in now</a></p><p style="color:#5d6b7e;font-size:13px">The link works today only. In crisis? Call or text 988.</p>`,
  };
}

/** Send links for appointments starting within the lead time. Returns { sent, skipped, failed }. */
async function runReminders(db, { now = nowLocal(), cfg = reminderConfig(), mailCfg = mailer.mailConfig(), smsCfg = sms.smsConfig() } = {}) {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!cfg.on || !cfg.base || (!mailCfg.enabled && !smsCfg.enabled)) return out;
  const { newToken } = require("./routes/checkin");
  const clinic = require("./clinic").getClinic(db).name;
  const rows = db.prepare(`SELECT a.id, a.patient_id, a.start_at, a.type, p.email, p.phone, p.preferred_contact
    FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN checkins c ON c.appointment_id = a.id
    WHERE a.status = 'scheduled' AND a.start_at > ? AND a.start_at <= ? AND substr(a.start_at,1,10) = ?
      AND (c.id IS NULL OR (c.link_sent_at IS NULL AND c.completed_at IS NULL AND c.started_at IS NULL))
    ORDER BY a.start_at LIMIT 200`).all(now, addMinutesLocal(now, cfg.lead), now.slice(0, 10));
  for (const a of rows) {
    const channel = pickChannel(a, mailCfg.enabled, smsCfg.enabled);
    if (!channel) { out.skipped++; continue; }
    const token = newToken(db, a.id, a.patient_id, { source: "link" });
    const url = `${cfg.base}/checkin/s/${token}`;
    const msg = messages(clinic, url, a.start_at, a.type === "group");
    try {
      if (channel === "text") await sms.sendSms({ to: a.phone, body: msg.text }, smsCfg);
      else await mailer.sendMail({ to: a.email, subject: msg.subject, text: msg.mailText, html: msg.mailHtml }, mailCfg);
      db.prepare("UPDATE checkins SET link_sent_at = datetime('now'), link_sent_via = ? WHERE appointment_id = ?").run(channel, a.id);
      audit({ db, user: null, ip: null }, "checkin_link_sent", "appointment", a.id, a.patient_id, `automatic ${channel}`);
      out.sent++;
    } catch (e) {
      // Mark as attempted so a bad address isn't retried every minute.
      db.prepare("UPDATE checkins SET link_sent_at = datetime('now'), link_sent_via = ? WHERE appointment_id = ?").run(`failed ${channel}`, a.id);
      audit({ db, user: null, ip: null }, "checkin_link_failed", "appointment", a.id, a.patient_id, `${channel}: ${String(e.message || e).slice(0, 120)}`);
      out.failed++;
    }
  }
  return out;
}

let running = false;
function scheduleCheckinReminders(db) {
  const cfg = reminderConfig();
  const ch = [mailer.mailConfig().enabled && "email", sms.smsConfig().enabled && "text"].filter(Boolean);
  if (!cfg.on) console.log("[checkin] Automatic check-in links are off (EHR_CHECKIN_AUTO=0).");
  else if (!ch.length) console.log("[checkin] Automatic check-in links need email or texting set up.");
  else if (!cfg.base) console.warn("[checkin] Automatic check-in links need EHR_PUBLIC_URL (the site address).");
  else console.log(`[checkin] Automatic check-in links ${cfg.lead} min before appointments via ${ch.join(" and ")}.`);
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { const r = await runReminders(db); if (r.sent || r.failed) console.log(`[checkin] links sent ${r.sent}, failed ${r.failed}`); }
    catch (e) { console.error("[checkin] reminder run failed:", e.message); }
    finally { running = false; }
  }, 60e3);
  t.unref();
  return t;
}

module.exports = { reminderConfig, runReminders, scheduleCheckinReminders, pickChannel, addMinutesLocal, messages };
