'use strict';
/* TOTP по RFC 6238: base32-секрет или ссылка otpauth://totp/... */
const { webcrypto } = require('./codec');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGORITHMS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Разбор поля TOTP. Возвращает null, если секрет некорректен. */
function parseTotp(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let secret = raw;
  let algorithm = 'SHA-1';
  let digits = 6;
  let period = 30;
  let issuer = '';
  let account = '';

  if (/^otpauth:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.host.toLowerCase() !== 'totp') return null;
      const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const [a, b] = label.includes(':') ? label.split(':') : ['', label];
      issuer = url.searchParams.get('issuer') || a || '';
      account = b || '';
      secret = url.searchParams.get('secret') || '';
      const alg = (url.searchParams.get('algorithm') || 'SHA1').toUpperCase();
      algorithm = ALGORITHMS[alg] || 'SHA-1';
      digits = parseInt(url.searchParams.get('digits') || '6', 10);
      period = parseInt(url.searchParams.get('period') || '30', 10);
    } catch (e) {
      return null;
    }
  }

  const key = base32Decode(secret);
  if (!key || key.length < 5) return null;
  if (![6, 7, 8].includes(digits)) digits = 6;
  if (!(period >= 10 && period <= 120)) period = 30;
  return { key, algorithm, digits, period, issuer, account };
}

async function hotp(key, counter, algorithm, digits) {
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const hmacKey = await webcrypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: algorithm }, false, ['sign']
  );
  const mac = new Uint8Array(await webcrypto.subtle.sign('HMAC', hmacKey, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

async function totpCode(cfg, now = Date.now()) {
  const counter = Math.floor(now / 1000 / cfg.period);
  const code = await hotp(cfg.key, counter, cfg.algorithm, cfg.digits);
  const remaining = cfg.period - (Math.floor(now / 1000) % cfg.period);
  return { code, counter, remaining };
}

function formatCode(code) {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

module.exports = { parseTotp, totpCode, formatCode, base32Decode };
