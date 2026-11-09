"use strict";
/*
 * Field-level encryption for secrets stored in SQLite (AES-256-GCM).
 *   EHR_DATA_KEY = 32 bytes as base64 (44 chars) or hex (64 chars). Read at call time.
 *   encryptField('x', 'users.mfa_secret') -> 'enc:v1:<iv>.<tag>.<ciphertext>' (base64url parts)
 *     or the plaintext unchanged when no key is configured.
 *   decryptField(value, aad) -> plaintext; values without the prefix are returned as-is
 *     (rows written before a key was configured keep working and are re-encrypted on next write).
 * The optional `aad` binds a ciphertext to its column so it can't be swapped into another field.
 */
const crypto = require("node:crypto");

const PREFIX = "enc:v1:";

function dataKey() {
  const raw = String(process.env.EHR_DATA_KEY || "").trim();
  if (!raw) return null;
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("EHR_DATA_KEY must be 32 bytes, as base64 or 64 hex characters.");
  return key;
}

const hasDataKey = () => !!dataKey();
const isEncrypted = (v) => typeof v === "string" && v.startsWith(PREFIX);

function encryptField(plain, aad = "") {
  if (plain == null) return plain;
  const key = dataKey();
  if (!key) return String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

function decryptField(value, aad = "") {
  if (!isEncrypted(value)) return value;
  const key = dataKey();
  if (!key) throw new Error("Encrypted field found but EHR_DATA_KEY is not set.");
  const [iv, tag, ct] = value.slice(PREFIX.length).split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Call once at startup: warns when secrets would be stored in plaintext in production. */
function warnIfNoDataKey(log = console.warn) {
  try {
    if (process.env.NODE_ENV === "production" && !hasDataKey()) {
      log("[security] EHR_DATA_KEY is not set: two-factor secrets are stored unencrypted. Set a 32-byte key (base64 or hex).");
    }
  } catch (e) {
    log(`[security] ${e.message}`);
  }
}

module.exports = { PREFIX, encryptField, decryptField, isEncrypted, hasDataKey, warnIfNoDataKey };
