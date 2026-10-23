'use strict';
/* Кодирование байтов: UTF-8, base64, hex, случайные значения. */

const webcrypto = globalThis.crypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(str) {
  return encoder.encode(str);
}

function fromUtf8(buf) {
  return decoder.decode(buf);
}

function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  webcrypto.getRandomValues(out);
  return out;
}

function randomId() {
  return toHex(randomBytes(10));
}

/** Равномерное случайное целое [0, max) без смещения по модулю. */
function randomInt(max) {
  if (max <= 0) throw new Error('randomInt: max must be > 0');
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    webcrypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return toHex(await webcrypto.subtle.digest('SHA-256', bytes));
}

function wipe(buf) {
  if (buf && typeof buf.fill === 'function') buf.fill(0);
}

module.exports = {
  webcrypto,
  utf8,
  fromUtf8,
  toBase64,
  fromBase64,
  toHex,
  randomBytes,
  randomId,
  randomInt,
  sha256Hex,
  wipe,
};
