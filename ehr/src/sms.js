"use strict";
/*
 * Outbound text messages through Twilio's HTTPS API (no extra dependencies; works where SMTP ports are blocked).
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   from the Twilio console
 *   TWILIO_FROM                              your Twilio number in +1XXXXXXXXXX form (or a Messaging Service SID, MG...)
 *
 * Texts sent by the EHR contain the clinic name and a link only, never clinical details. Sign Twilio's BAA before
 * using it with real clients, and follow your clinic's texting-consent policy.
 */
let testTransport = null;
function setTestTransport(fn) { testTransport = fn; }

function smsConfig(env = process.env) {
  if (testTransport) return { enabled: true, provider: "test" };
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN, from = env.TWILIO_FROM;
  if (!sid || !token || !from) return { enabled: false, reason: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are not set." };
  return { enabled: true, provider: "twilio", sid, token, from };
}

/** US-style numbers to E.164 (+1XXXXXXXXXX); returns null when it can't be a valid number. */
function toE164(phone) {
  const raw = String(phone || "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(raw.replace(/[\s().-]/g, ""))) return raw.replace(/[\s().-]/g, "");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return null;
}

async function sendSms({ to, body }, cfg = smsConfig()) {
  if (!cfg.enabled) throw new Error(`Texting is not set up: ${cfg.reason}`);
  const num = toE164(to);
  if (!num) throw new Error("That phone number can't receive texts.");
  if (cfg.provider === "test") return testTransport({ to: num, body });
  const params = new URLSearchParams({ To: num, Body: body });
  if (/^MG[0-9a-f]{32}$/i.test(cfg.from)) params.set("MessagingServiceSid", cfg.from); else params.set("From", cfg.from);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) {
    let msg = `Twilio error ${r.status}`;
    try { const j = await r.json(); if (j.message) msg += `: ${j.message}`; } catch { /* not JSON */ }
    throw new Error(msg.slice(0, 200));
  }
}

module.exports = { smsConfig, sendSms, toE164, setTestTransport };
