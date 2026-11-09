"use strict";
/*
 * Time-based one-time passwords (RFC 6238 / RFC 4226) and a small QR code encoder for enrollment.
 *   generateSecret()                    -> base32 secret (20 random bytes, 32 chars)
 *   otpauthUri(secret, accountEmail)    -> otpauth://totp/... URI understood by authenticator apps
 *   generate(secret, { time })          -> current 6-digit code (string)
 *   verify(secret, code, { afterStep }) -> matched time step (number) or null; ±1 step window,
 *                                          steps <= afterStep are rejected (replay protection)
 *   qrSvg(text)                         -> inline <svg> QR code (byte mode, ECC level M, versions 1-10)
 * No dependencies beyond node:crypto.
 */
const crypto = require("node:crypto");

const ISSUER = "Clinic Ready EHR";
const PERIOD = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/* ------------------------------------------------------------------ */
/* Base32 (RFC 4648, no padding)                                       */
/* ------------------------------------------------------------------ */
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** "ABCD EFGH ..." for easier manual entry. */
const groupSecret = (secret) => String(secret).replace(/(.{4})(?=.)/g, "$1 ");

function otpauthUri(secret, account, issuer = ISSUER) {
  const label = encodeURIComponent(issuer) + ":" + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

/* ------------------------------------------------------------------ */
/* HOTP / TOTP                                                         */
/* ------------------------------------------------------------------ */
function hotp(key, counter, digits = DIGITS, algorithm = "sha1") {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

const stepAt = (time = Date.now()) => Math.floor(time / 1000 / PERIOD);
const keyOf = (secret) => (Buffer.isBuffer(secret) ? secret : base32Decode(secret));

/** Code for the given time (ms). Options: digits, step (overrides time), algorithm. */
function generate(secret, { time = Date.now(), step, digits = DIGITS, algorithm = "sha1" } = {}) {
  return hotp(keyOf(secret), step == null ? stepAt(time) : step, digits, algorithm);
}

/**
 * Returns the matching time step, or null. Accepts the previous, current and next step (clock drift).
 * Steps at or before `afterStep` are refused so a code cannot be replayed within its window.
 */
function verify(secret, code, { time = Date.now(), window = 1, afterStep = -1 } = {}) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = keyOf(secret);
  const now = stepAt(time);
  let match = null;
  for (let s = now - window; s <= now + window; s++) {
    const expected = Buffer.from(hotp(key, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(c)) && s > afterStep && match === null) match = s;
  }
  return match;
}

/* ------------------------------------------------------------------ */
/* QR code encoder: byte mode, error correction level M, versions 1-10 */
/* (structure follows ISO/IEC 18004; verified against reference output */
/* in test/mfa.test.js)                                                */
/* ------------------------------------------------------------------ */
const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Reed-Solomon error correction codewords for `data` (array of bytes). */
function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const out = [];
  for (let pos = size - 7; out.length < num - 1; pos -= step) out.unshift(pos);
  out.unshift(6);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Encode text as a QR matrix: array of rows, each an array of booleans (true = dark). */
function qrMatrix(text, { mask: forcedMask } = {}) {
  const bytes = Buffer.from(String(text), "utf8");
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error("QR payload too long");

  // --- data bit stream ---
  const capacityBits = dataCodewords(ver) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // --- split into blocks, add ECC, interleave ---
  const numBlocks = NUM_BLOCKS_M[ver];
  const eccLen = ECC_PER_BLOCK_M[ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, eccLen);
    if (i < numShort) dat.push(0); // placeholder so all blocks align when interleaving
    blocks.push(dat.concat(ecc));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(blk[i]);
    });
  }

  // --- function patterns ---
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignmentPositions(ver);
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const drawFormat = (mask) => {
    const dataBits = (0 << 3) | mask; // ECC level M = 00
    let rem = dataBits;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((dataBits << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // dark module
  };
  drawFormat(0); // reserve the format areas
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // --- place codewords in the zigzag ---
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = forcedMask;
  if (best == null) {
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const score = penalty(mod);
      if (score < bestScore) { bestScore = score; best = m; }
      applyMask(m); // undo (XOR)
    }
  }
  applyMask(best);
  drawFormat(best);
  return mod;
}

/** Mask penalty (ISO/IEC 18004 §7.8.3): runs, 2x2 blocks, finder-like patterns, dark/light balance. */
function penalty(m) {
  const size = m.length;
  let score = 0, dark = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(m[y]);
  for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]));
  const finderA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].join("");
  const finderB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].join("");
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    const s = line.map((v) => (v ? 1 : 0)).join("");
    for (let i = 0; i + 11 <= size; i++) {
      const sub = s.slice(i, i + 11);
      if (sub === finderA || sub === finderB) score += 40;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Inline SVG (black on white, 4-module quiet zone). Safe to embed: contains no user text. */
function qrSvg(text, { scale = 4, title = "QR code" } = {}) {
  const m = qrMatrix(text);
  const n = m.length + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  const px = n * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" role="img" aria-label="${title}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

module.exports = {
  ISSUER, PERIOD, DIGITS,
  base32Encode, base32Decode, generateSecret, groupSecret, otpauthUri,
  hotp, generate, verify, stepAt,
  qrMatrix, qrSvg, rsRemainder,
};
