"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { start } = require("./helpers");
const totp = require("../src/totp");
const { mfa } = require("../src/auth");
const { decryptField } = require("../src/crypto-field");

const PW = "Test-Password-123!";
let t;
before(async () => { t = await start(); });
after(async () => { await t.stop(); });

const user = (key) => t.db.prepare("SELECT * FROM users WHERE id = ?").get(t.ctx.users[key]);
const auditCount = (action, userId) => t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND user_id = ?").get(action, userId).n;
const emailOf = (key) => user(key).email;

/** Password step only; returns the client (with a pending session) and the redirect. */
async function passwordStep(key) {
  const c = t.client();
  const r = await c.post("/ehr/login", { email: emailOf(key), password: PW });
  if (r.location && r.location.startsWith("/ehr/login/mfa")) await c.get(r.location); // load CSRF token
  return { c, r };
}

/* ------------------------------------------------------------------ */
/* TOTP / base32 / QR units                                           */
/* ------------------------------------------------------------------ */
test("TOTP matches RFC 6238 SHA-1 test vectors", () => {
  const key = Buffer.from("12345678901234567890", "ascii");
  const vectors = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [secs, code] of vectors) {
    assert.equal(totp.generate(key, { time: secs * 1000, digits: 8 }), code, `T=${secs}`);
    assert.equal(totp.generate(key, { time: secs * 1000 }), code.slice(-6)); // 6-digit = last 6 digits
  }
  // Same key via base32 (RFC 4648 encoding of the ASCII key).
  assert.equal(totp.base32Encode(key), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(totp.generate("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { time: 59000, digits: 8 }), "94287082");
});

test("base32 round trip, RFC 4648 vectors, secret format and otpauth URI", () => {
  assert.equal(totp.base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(totp.base32Decode("MZXW6YTBOI").toString(), "foobar");
  const s = totp.generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Decode(s).length, 20);
  assert.equal(totp.groupSecret("ABCDEFGHIJ"), "ABCD EFGH IJ");
  const uri = totp.otpauthUri(s, "a.b+c@example.com");
  assert.equal(uri, `otpauth://totp/Clinic%20Ready%20EHR:a.b%2Bc%40example.com?secret=${s}&issuer=Clinic%20Ready%20EHR&algorithm=SHA1&digits=6&period=30`);
});

test("verify: ±1 step window and replay protection", () => {
  const s = totp.generateSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30000);
  for (const d of [-1, 0, 1]) assert.equal(totp.verify(s, totp.generate(s, { step: step + d }), { time: now }), step + d);
  assert.equal(totp.verify(s, totp.generate(s, { step: step - 2 }), { time: now }), null);
  assert.equal(totp.verify(s, totp.generate(s, { step: step + 2 }), { time: now }), null);
  const code = totp.generate(s, { time: now });
  assert.equal(totp.verify(s, code, { time: now, afterStep: step }), null, "same code can't be reused");
  assert.equal(totp.verify(s, totp.generate(s, { step: step + 1 }), { time: now, afterStep: step }), step + 1);
  assert.equal(totp.verify(s, "12345", { time: now }), null);
  assert.equal(totp.verify(s, "abcdef", { time: now }), null);
});

test("QR: Reed-Solomon and matrices match reference output", () => {
  // ISO/IEC 18004 worked example: "01234567" 1-M data codewords -> 10 EC codewords.
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(totp.rsRemainder(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);

  // Reference matrices produced by an independent encoder (segno 1.6.6, byte mode, ECC M, fixed mask).
  const toHex = (m) => m.map((row) => BigInt("0b" + row.map((b) => (b ? "1" : "0")).join("")).toString(16));
  const v1 = ["1fcd7f", "105941", "17575d", "175f5d", "174b5d", "104541", "1fd57f", "1f00", "1055ce", "1f3d78", "194246",
    "3088f", "364bb", "1990", "1fc9ae", "104bed", "174863", "174e18", "174d5b", "1045ac", "1fd372"];
  assert.deepEqual(toHex(totp.qrMatrix("Clinic Ready", { mask: 5 })), v1);
  const v9 = ["1fd74f13f0247f", "105ca58e65ae41", "174328c90e825d", "1754341ba12d5d", "1748841f10645d", "104c7351a0c441",
    "1fd5555555557f", "1c9371502500", "16ede2dfd6bc4b", "c886f07d1b639", "b5318be630dc6", "9aa30e836aa72", "1ef26034efc615",
    "1e8320cda2eb95", "13544943823587", "172c893b7494c8", "3d91838d4ea05", "123fbd9e9898e4", "97992581acf00", "1e99eb4ca7992f",
    "1d70d87ee37ad", "9b2b39ee31cb9", "1548316fe7bc48", "119b9278186b93", "1ff3a1f4ecff7", "510bd910bc31f", "115dcd75a3bd5b",
    "1b1b5c7161291b", "9ffeebfd8e5f9", "88b4bd68e09ec", "f66c18f0b7980", "1a0bb0424ad3ee", "1fe3db55427afd", "12bae86082a6bb",
    "16c84b3da6c486", "138803e1a5a401", "87fbc92e345a8", "13270e78127300", "7e85f526c69c3", "10acac00d83ff8", "1671de173ca033",
    "38701e594ba6f", "1bf399133ef308", "c3ff64ae25b1f", "26d65df2877f7", "1431f1e18d11", "1fd0f4f5360d54", "1050dc11605b10",
    "17431b5ffb87f6", "1752900e0ac0ad", "17562045dc56e0", "1048c1fc5a5d9a", "1fd49f8c3acbea"];
  const uri = "otpauth://totp/Clinic%20Ready%20EHR:therapist%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Clinic%20Ready%20EHR&algorithm=SHA1&digits=6&period=30";
  assert.deepEqual(toHex(totp.qrMatrix(uri, { mask: 3 })), v9);

  // Version selection and SVG output.
  assert.equal(totp.qrMatrix("x".repeat(14)).length, 21); // 1-M holds 14 bytes
  assert.equal(totp.qrMatrix("x".repeat(15)).length, 25);
  assert.equal(totp.qrMatrix("x".repeat(213)).length, 57); // 10-M holds 213 bytes
  assert.throws(() => totp.qrMatrix("x".repeat(214)));
  const svg = totp.qrSvg(uri);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 61 61"/);
  assert.ok(!svg.includes("example.com"), "SVG contains no readable text");
});

/* ------------------------------------------------------------------ */
/* Enrollment from My account                                         */
/* ------------------------------------------------------------------ */
test("enrollment on /ehr/account: QR + key, confirm with password and code, recovery codes shown once", async () => {
  const c = await t.login("therapist");
  const id = t.ctx.users.therapist;
  let r = await c.get("/ehr/account");
  assert.match(r.text, /Set up two-factor sign-in/);

  r = await c.post("/ehr/account/mfa/start");
  assert.equal(r.status, 302);
  assert.equal(r.location, "/ehr/account/mfa/setup");
  r = await c.get("/ehr/account/mfa/setup");
  assert.equal(r.status, 200);
  assert.match(r.text, /<svg [^>]*role="img"/);
  assert.match(r.text, /otpauth:\/\/totp\/Clinic%20Ready%20EHR:therapist%40example\.com\?secret=/);
  const secret = r.text.match(/class="mfa-key"[^>]*>([A-Z2-7 ]+)</)[1].replace(/ /g, "");
  assert.equal(secret, mfa.secretOf(user("therapist")));
  assert.equal(user("therapist").mfa_enabled, 0);

  r = await c.post("/ehr/account/mfa/confirm", { code: totp.generate(secret), password: "wrong-password" });
  assert.equal(r.status, 400);
  r = await c.post("/ehr/account/mfa/confirm", { code: "000000", password: PW });
  assert.equal(r.status, 400);
  assert.equal(user("therapist").mfa_enabled, 0);

  mfa.forgetStep(t.db, id);
  r = await c.post("/ehr/account/mfa/confirm", { code: totp.generate(secret), password: PW });
  assert.equal(r.status, 200);
  const codes = [...r.text.matchAll(/<li>([a-z2-9]{5}-[a-z2-9]{5})<\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  const u = user("therapist");
  assert.equal(u.mfa_enabled, 1);
  assert.ok(u.mfa_enrolled_at);
  const stored = mfa.readState(u).codes;
  assert.equal(stored.length, 10);
  assert.ok(!u.mfa_recovery.includes(codes[0]), "only hashes are stored");
  assert.equal(stored[0], crypto.createHash("sha256").update(codes[0].replace("-", "")).digest("hex"));
  assert.equal(auditCount("mfa_enrolled", id), 1);

  r = await c.get("/ehr/account");
  assert.match(r.text, /10 unused recovery codes left/);
  assert.doesNotMatch(r.text, new RegExp(codes[0]), "codes are not shown again");
});

/* ------------------------------------------------------------------ */
/* Sign-in with a second factor                                       */
/* ------------------------------------------------------------------ */
test("login requires the code; pending session can't reach the EHR; success rotates the session", async () => {
  const secret = t.enableMfa("therapist2");
  const id = t.ctx.users.therapist2;
  const c = t.client();
  let r = await c.post("/ehr/login", { email: emailOf("therapist2"), password: PW, next: "/ehr/patients" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/ehr/login/mfa?next=%2Fehr%2Fpatients");
  const pending = t.db.prepare("SELECT * FROM sessions WHERE user_id = ?").all(id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mfa_pending, 1);
  assert.equal(auditCount("login", id), 0, "not a completed login yet");

  for (const p of ["/ehr", "/ehr/patients", "/ehr/account", "/ehr/admin", "/ehr/login", "/ehr/login/mfa/setup"]) {
    r = await c.get(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.location, "/ehr/login/mfa", p);
  }
  r = await c.get("/ehr/login/mfa?next=%2Fehr%2Fpatients");
  assert.equal(r.status, 200);
  assert.match(r.text, /Two-factor verification/);
  assert.doesNotMatch(r.text, /sidebar/, "no app navigation for a pending session");

  const before = t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n;
  r = await c.post("/ehr/patients", { first_name: "Pending", last_name: "Session", dob: "1990-01-01" });
  assert.equal(r.status, 403);
  r = await c.post("/ehr/account/password", { current_password: PW, new_password: "Another-Pass-456!", confirm_password: "Another-Pass-456!" });
  assert.equal(r.status, 403);
  r = await c.post("/ehr/account/mfa/disable", { password: PW, code: totp.generate(secret) });
  assert.equal(r.status, 403);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM patients").get().n, before);
  assert.equal(user("therapist2").mfa_enabled, 1);
  r = await c.request("GET", "/ehr/patients", undefined, { headers: { accept: "application/json" } });
  assert.notEqual(r.status, 200);

  r = await c.post("/ehr/login/mfa", { code: "123456", next: "/ehr/patients" });
  assert.equal(r.status, 401);
  assert.equal(auditCount("mfa_failed", id), 1);

  const code = totp.generate(secret);
  r = await c.post("/ehr/login/mfa", { code, next: "/ehr/patients" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/ehr/patients");
  const sessions = t.db.prepare("SELECT * FROM sessions WHERE user_id = ?").all(id);
  assert.equal(sessions.length, 1);
  assert.notEqual(sessions[0].id, pending[0].id, "session id rotated");
  assert.equal(sessions[0].mfa_pending, 0);
  assert.equal(user("therapist2").failed_logins, 0);
  assert.equal(auditCount("mfa_success", id), 1);
  assert.equal(auditCount("login", id), 1);
  await c.refreshCsrf();
  assert.equal((await c.get("/ehr/patients")).status, 200);

  // The same code can't be replayed in its window.
  const { c: c2 } = await passwordStep("therapist2");
  r = await c2.post("/ehr/login/mfa", { code });
  assert.equal(r.status, 401);

  // Helper path.
  const c3 = await t.login("therapist2", { totpSecret: secret });
  assert.equal((await c3.get("/ehr/patients")).status, 200);
});

test("5 wrong codes lock the account like password lockout", async () => {
  t.enableMfa("prescriber");
  const id = t.ctx.users.prescriber;
  const { c } = await passwordStep("prescriber");
  let r;
  for (let i = 1; i <= 4; i++) {
    r = await c.post("/ehr/login/mfa", { code: String(100000 + i) });
    assert.equal(r.status, 401);
  }
  r = await c.post("/ehr/login/mfa", { code: "999999" });
  assert.equal(r.status, 429);
  const u = user("prescriber");
  assert.ok(u.locked_until);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id).n, 0, "pending session destroyed");
  assert.equal(auditCount("mfa_failed", id), 5);
  // Password login is refused while locked.
  r = await t.client().post("/ehr/login", { email: u.email, password: PW });
  assert.equal(r.status, 429);

  // Re-entering the password doesn't reset the code-attempt counter.
  t.db.prepare("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?").run(id);
  const { c: c2 } = await passwordStep("prescriber");
  for (let i = 0; i < 3; i++) await c2.post("/ehr/login/mfa", { code: "000001" });
  const { c: c3 } = await passwordStep("prescriber");
  await c3.post("/ehr/login/mfa", { code: "000002" });
  r = await c3.post("/ehr/login/mfa", { code: "000003" });
  assert.equal(r.status, 429);
  t.db.prepare("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?").run(id);
});

test("recovery code signs in once and is burned", async () => {
  const id = t.ctx.users.billing;
  const codes = mfa.enable(t.db, id, totp.generateSecret());
  let { c } = await passwordStep("billing");
  let r = await c.post("/ehr/login/mfa", { code: codes[3].toUpperCase() });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/ehr");
  assert.equal(auditCount("mfa_recovery_used", id), 1);
  assert.equal(mfa.readState(user("billing")).codes.length, 9);

  ({ c } = await passwordStep("billing"));
  r = await c.post("/ehr/login/mfa", { code: codes[3] });
  assert.equal(r.status, 401);
  r = await c.post("/ehr/login/mfa", { code: codes[4].replace("-", " ") });
  assert.equal(r.status, 302);
  assert.equal(mfa.readState(user("billing")).codes.length, 8);
});

test("regenerate recovery codes and disable two-factor (password + current code)", async () => {
  const secret = t.enableMfa("frontdesk");
  const id = t.ctx.users.frontdesk;
  const c = await t.login("frontdesk", { totpSecret: secret });
  const old = mfa.readState(user("frontdesk")).codes;

  mfa.forgetStep(t.db, id);
  let r = await c.post("/ehr/account/mfa/recovery-codes", { password: PW, code: totp.generate(secret) });
  assert.equal(r.status, 200);
  assert.equal([...r.text.matchAll(/<li>([a-z2-9]{5}-[a-z2-9]{5})<\/li>/g)].length, 10);
  assert.notDeepEqual(mfa.readState(user("frontdesk")).codes, old);
  assert.equal(auditCount("mfa_recovery_regenerated", id), 1);

  mfa.forgetStep(t.db, id);
  r = await c.post("/ehr/account/mfa/disable", { password: "nope", code: totp.generate(secret) });
  assert.equal(r.status, 400);
  r = await c.post("/ehr/account/mfa/disable", { password: PW, code: "000000" });
  assert.equal(r.status, 400);
  assert.equal(user("frontdesk").mfa_enabled, 1);

  process.env.EHR_REQUIRE_MFA = "1";
  try {
    mfa.forgetStep(t.db, id);
    r = await c.post("/ehr/account/mfa/disable", { password: PW, code: totp.generate(secret) });
    assert.equal(r.status, 403);
    assert.equal(user("frontdesk").mfa_enabled, 1);
  } finally {
    delete process.env.EHR_REQUIRE_MFA;
  }

  mfa.forgetStep(t.db, id);
  r = await c.post("/ehr/account/mfa/disable", { password: PW, code: totp.generate(secret) });
  assert.equal(r.status, 302);
  const u = user("frontdesk");
  assert.equal(u.mfa_enabled, 0);
  assert.equal(u.mfa_secret, null);
  assert.equal(auditCount("mfa_disabled", id), 1);
  r = await t.client().post("/ehr/login", { email: u.email, password: PW });
  assert.equal(r.location, "/ehr");
});

test("admin sees MFA status and can reset a user's two-factor (with password confirmation)", async () => {
  const secret = t.enableMfa("therapist2");
  const id = t.ctx.users.therapist2;
  const victim = await t.login("therapist2", { totpSecret: secret });
  const admin = await t.login("admin");

  let r = await admin.get("/ehr/admin/users");
  assert.match(r.text, /<th>Two-factor<\/th>/);
  r = await admin.get(`/ehr/admin/users/${id}/edit`);
  assert.match(r.text, /Two-factor sign-in/);
  assert.match(r.text, /Reset two-factor/);

  r = await admin.post(`/ehr/admin/users/${id}/reset-mfa`, { admin_password: "wrong" });
  assert.equal(r.status, 400);
  assert.equal(user("therapist2").mfa_enabled, 1);
  assert.equal(auditCount("mfa_reset_failed", t.ctx.users.admin), 1);

  r = await admin.post(`/ehr/admin/users/${id}/reset-mfa`, { admin_password: PW });
  assert.equal(r.status, 302);
  const u = user("therapist2");
  assert.equal(u.mfa_enabled, 0);
  assert.equal(u.mfa_secret, null);
  assert.equal(u.mfa_recovery, null);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id).n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mfa_reset' AND entity_id = ?").get(id).n, 1);
  assert.equal((await victim.get("/ehr/patients")).status, 302, "user signed out everywhere");

  // Non-admins can't reset.
  const other = await t.login("therapist");
  const tid = t.ctx.users.therapist;
  r = await other.post(`/ehr/admin/users/${tid}/reset-mfa`, { admin_password: PW });
  assert.equal(r.status, 403);
});

test("EHR_REQUIRE_MFA=1 forces enrollment right after password login", async () => {
  process.env.EHR_REQUIRE_MFA = "1";
  try {
    const id = t.ctx.users.therapist2; // MFA was reset above
    assert.equal(user("therapist2").mfa_enabled, 0);
    const c = t.client();
    let r = await c.post("/ehr/login", { email: emailOf("therapist2"), password: PW });
    assert.equal(r.status, 302);
    assert.equal(r.location, "/ehr/login/mfa/setup");
    assert.equal(t.db.prepare("SELECT mfa_pending FROM sessions WHERE user_id = ?").get(id).mfa_pending, 2);
    for (const p of ["/ehr", "/ehr/patients", "/ehr/account", "/ehr/login/mfa"]) {
      r = await c.get(p);
      assert.equal(r.status, 302, p);
      assert.equal(r.location, "/ehr/login/mfa/setup", p);
    }
    r = await c.get("/ehr/login/mfa/setup");
    assert.equal(r.status, 200);
    assert.match(r.text, /requires two-factor sign-in/);
    assert.match(r.text, /<svg /);
    const secret = r.text.match(/class="mfa-key"[^>]*>([A-Z2-7 ]+)</)[1].replace(/ /g, "");
    r = await c.post("/ehr/account/mfa/start");
    assert.equal(r.status, 403);

    r = await c.post("/ehr/login/mfa/setup", { code: "000000" });
    assert.equal(r.status, 400);
    r = await c.post("/ehr/login/mfa/setup", { code: totp.generate(secret) });
    assert.equal(r.status, 200);
    assert.equal([...r.text.matchAll(/<li>([a-z2-9]{5}-[a-z2-9]{5})<\/li>/g)].length, 10);
    assert.equal(user("therapist2").mfa_enabled, 1);
    const s = t.db.prepare("SELECT * FROM sessions WHERE user_id = ?").all(id);
    assert.equal(s.length, 1);
    assert.equal(s[0].mfa_pending, 0);
    assert.equal((await c.get("/ehr/patients")).status, 200);
    r = await c.get("/ehr/account");
    assert.match(r.text, /required by your organization/);
    assert.doesNotMatch(r.text, /\/ehr\/account\/mfa\/disable/);

    // Next sign-in asks for the code (not enrollment).
    r = await t.client().post("/ehr/login", { email: emailOf("therapist2"), password: PW });
    assert.equal(r.location, "/ehr/login/mfa");
  } finally {
    delete process.env.EHR_REQUIRE_MFA;
  }
});

test("MFA secret is encrypted at rest when EHR_DATA_KEY is set (and plaintext rows still work)", async () => {
  const key = crypto.randomBytes(32);
  process.env.EHR_DATA_KEY = key.toString("base64");
  const id = t.ctx.users.therapist2;
  try {
    // Enroll through the UI with a key configured.
    t.db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery = NULL WHERE id = ?").run(id);
    const c = await t.login("therapist2");
    await c.post("/ehr/account/mfa/start");
    const r = await c.get("/ehr/account/mfa/setup");
    const secret = r.text.match(/class="mfa-key"[^>]*>([A-Z2-7 ]+)</)[1].replace(/ /g, "");
    const raw = user("therapist2").mfa_secret;
    assert.match(raw, /^enc:v1:/);
    assert.ok(!raw.includes(secret));
    assert.equal(decryptField(raw, "users.mfa_secret"), secret);
    // Ciphertext is bound to the column (AAD) and authenticated.
    assert.throws(() => decryptField(raw, "other.column"));
    await c.post("/ehr/account/mfa/confirm", { code: totp.generate(secret), password: PW });
    assert.equal(user("therapist2").mfa_enabled, 1);
    const c2 = await t.login("therapist2", { totpSecret: secret });
    assert.equal((await c2.get("/ehr/patients")).status, 200);

    // Hex keys work too.
    process.env.EHR_DATA_KEY = key.toString("hex");
    assert.equal(mfa.secretOf(user("therapist2")), secret);

    // A plaintext secret written before the key existed still works and is encrypted on first use.
    const legacy = totp.generateSecret();
    t.db.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").run(legacy, id);
    mfa.forgetStep(t.db, id);
    const c3 = await t.login("therapist2", { totpSecret: legacy });
    assert.equal((await c3.get("/ehr/patients")).status, 200);
    assert.match(user("therapist2").mfa_secret, /^enc:v1:/);
  } finally {
    delete process.env.EHR_DATA_KEY;
    mfa.clear(t.db, id);
  }
  // Without a key the secret is stored as plain base32.
  mfa.enable(t.db, id, totp.generateSecret());
  assert.match(user("therapist2").mfa_secret, /^[A-Z2-7]{32}$/);
  mfa.clear(t.db, id);
});

test("password changes record password_changed_at", async () => {
  const id = t.ctx.users.therapist;
  t.db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery = NULL, password_changed_at = NULL WHERE id = ?").run(id);
  const c = await t.login("therapist");
  let r = await c.post("/ehr/account/password", { current_password: PW, new_password: "Brand-New-Pass-789!", confirm_password: "Brand-New-Pass-789!" });
  assert.equal(r.status, 302);
  assert.ok(user("therapist").password_changed_at);

  const admin = await t.login("admin");
  t.db.prepare("UPDATE users SET password_changed_at = NULL WHERE id = ?").run(id);
  r = await admin.post(`/ehr/admin/users/${id}/reset-password`, { password: PW });
  assert.equal(r.status, 302);
  assert.ok(user("therapist").password_changed_at);

  r = await admin.post("/ehr/admin/users", { name: "New Person", email: "new.person@example.com", role: "frontdesk", password: "Initial-Pass-123!" });
  assert.equal(r.status, 302);
  assert.ok(t.db.prepare("SELECT password_changed_at FROM users WHERE email = 'new.person@example.com'").get().password_changed_at);
});
