"use strict";
/*
 * Outbound email with no extra dependencies.
 *
 *   EHR_MAIL_PROVIDER = smtp | resend        (unset = email disabled)
 *   EHR_MAIL_FROM     = "Clinic Ready <notes@yourclinic.com>"   (for Gmail SMTP: the Gmail address itself)
 *
 *   smtp:   EHR_SMTP_HOST, EHR_SMTP_PORT (465 = TLS, 587 = STARTTLS; default 587), EHR_SMTP_USER, EHR_SMTP_PASS
 *           TLS is required: a server that doesn't offer STARTTLS is refused.
 *           Gmail / Google Workspace: smtp.gmail.com, port 465 or 587, an App Password (not your normal password).
 *           Microsoft 365: smtp.office365.com, port 587.
 *   resend: RESEND_API_KEY (sends over HTTPS, for hosts that block SMTP ports).
 *
 * Emails sent by the EHR contain NO patient information (counts and a sign-in link only), because ordinary email
 * services are not covered by a BAA. Keep it that way.
 */
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

let testTransport = null;
/** Tests: capture messages instead of sending. Pass null to restore. */
function setTestTransport(fn) { testTransport = fn; }

function mailConfig(env = process.env) {
  const provider = String(env.EHR_MAIL_PROVIDER || "").toLowerCase();
  const from = env.EHR_MAIL_FROM || env.EHR_SMTP_USER || "";
  if (testTransport) return { enabled: true, provider: "test", from: from || "ehr@example.com" };
  if (!provider) return { enabled: false, reason: "EHR_MAIL_PROVIDER is not set." };
  if (!from) return { enabled: false, reason: "EHR_MAIL_FROM is not set." };
  if (provider === "smtp") {
    if (!env.EHR_SMTP_HOST || !env.EHR_SMTP_USER || !env.EHR_SMTP_PASS) return { enabled: false, reason: "EHR_SMTP_HOST, EHR_SMTP_USER and EHR_SMTP_PASS are required for SMTP." };
    const port = Number(env.EHR_SMTP_PORT || 587);
    return { enabled: true, provider, from, host: env.EHR_SMTP_HOST, port, secure: port === 465, user: env.EHR_SMTP_USER, pass: env.EHR_SMTP_PASS };
  }
  if (provider === "resend") {
    if (!env.RESEND_API_KEY) return { enabled: false, reason: "RESEND_API_KEY is required for Resend." };
    return { enabled: true, provider, from, apiKey: env.RESEND_API_KEY };
  }
  return { enabled: false, reason: `Unknown EHR_MAIL_PROVIDER "${provider}" (use smtp or resend).` };
}

const addrOf = (s) => { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); };
const headerSafe = (s) => String(s).replace(/[\r\n]+/g, " ");
const b64lines = (s) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Build a multipart/alternative MIME message (text + HTML). */
function buildMime({ from, to, subject, text, html }) {
  const boundary = `=_cr_${crypto.randomBytes(12).toString("hex")}`;
  const domain = addrOf(from).split("@")[1] || "localhost";
  return [
    `From: ${headerSafe(from)}`, `To: ${headerSafe(to)}`, `Subject: ${encWord(headerSafe(subject))}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`, "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64lines(text),
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64lines(html),
    `--${boundary}--`, "",
  ].join("\r\n");
}

/* ---------------- SMTP client ---------------- */
function smtpSession(cfg, { allowInsecure = false, timeoutMs = 20000, tlsOptions = {} } = {}) {
  return new Promise((resolve, reject) => {
    let sock = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, ...tlsOptions }) : net.connect({ host: cfg.host, port: cfg.port });
    let buf = "", waiter = null, done = false, failed = null;
    const fail = (e) => {
      if (done) return;
      done = true; failed = e;
      try { sock.destroy(); } catch {}
      const w = waiter; waiter = null;
      if (w) w.rej(e);
    };
    const onData = (d) => {
      buf += d.toString("utf8");
      if (!waiter) return; // keep buffered until someone reads
      // A reply is complete when a line has "NNN " (space, not dash) after the code.
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join("\r\n");
          const w = waiter; waiter = null;
          if (w) w.res({ code: Number(reply[reply.length - 1].slice(0, 3)), lines: reply });
          return;
        }
      }
    };
    const attach = (s) => { s.on("data", onData); s.on("error", fail); s.setTimeout(timeoutMs, () => fail(new Error("SMTP server did not respond (timeout). The host may block outgoing mail ports; try Resend."))); };
    attach(sock);
    sock.on("close", () => fail(new Error("SMTP connection closed unexpectedly")));
    const read = () => new Promise((res, rej) => {
      if (failed) return rej(failed);
      waiter = { res, rej }; onData(Buffer.alloc(0));
    });
    const cmd = async (line, expect) => {
      if (line !== null) sock.write(line + "\r\n");
      const r = await read();
      if (!expect.includes(r.code)) throw new Error(`SMTP ${line ? line.split(" ")[0] : "greeting"} failed: ${r.lines.join(" ").slice(0, 200)}`);
      return r;
    };
    resolve({
      cmd,
      startTls: () => new Promise((res, rej) => {
        sock.removeAllListeners("data");
        const plain = sock;
        plain.removeAllListeners("close");
        const up = tls.connect({ socket: plain, servername: cfg.host, ...tlsOptions }, () => res());
        up.on("error", rej);
        sock = up; attach(sock);
        sock.on("close", () => fail(new Error("SMTP connection closed unexpectedly")));
      }),
      write: (s) => sock.write(s),
      close: () => { done = true; try { sock.end(); } catch {} },
      isTls: () => sock instanceof tls.TLSSocket,
      allowInsecure,
    });
  });
}

async function sendSmtp(cfg, { to, mime }, opts = {}) {
  const s = await smtpSession(cfg, opts);
  try {
    await s.cmd(null, [220]);
    let ehlo = await s.cmd("EHLO clinic-ready", [250]);
    if (!s.isTls()) {
      if (ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
        await s.cmd("STARTTLS", [220]);
        await s.startTls();
        ehlo = await s.cmd("EHLO clinic-ready", [250]);
      } else if (!s.allowInsecure) throw new Error("SMTP server does not offer STARTTLS; refusing to send without encryption.");
    }
    if (cfg.user) await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString("base64")}`, [235]);
    await s.cmd(`MAIL FROM:<${addrOf(cfg.from)}>`, [250]);
    await s.cmd(`RCPT TO:<${addrOf(to)}>`, [250, 251]);
    await s.cmd("DATA", [354]);
    const body = mime.replace(/\r\n\./g, "\r\n..");   // dot-stuffing
    s.write(body.endsWith("\r\n") ? body : body + "\r\n");
    await s.cmd(".", [250]);
    await s.cmd("QUIT", [221]).catch(() => {});
  } finally { s.close(); }
}

async function sendResend(cfg, { to, subject, text, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg.from, to: [to], subject, text, html }),
  });
  if (!r.ok) throw new Error(`Resend API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Send one email. Throws on failure. */
async function sendMail({ to, subject, text, html }, cfg = mailConfig(), opts = {}) {
  if (!cfg.enabled) throw new Error(`Email is not set up: ${cfg.reason}`);
  if (cfg.provider === "test") return testTransport({ from: cfg.from, to, subject, text, html });
  if (cfg.provider === "resend") return sendResend(cfg, { to, subject, text, html });
  return sendSmtp(cfg, { to, mime: buildMime({ from: cfg.from, to, subject, text, html }) }, opts);
}

module.exports = { mailConfig, sendMail, buildMime, sendSmtp, setTestTransport };
