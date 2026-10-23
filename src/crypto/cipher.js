'use strict';
/*
 * Шифрование хранилища.
 *
 * Схема (только WebCrypto — есть и в десктопном, и в мобильном Obsidian):
 *   мастер-пароль --PBKDF2-SHA256(salt, N итераций)--> KEK (AES-256-GCM)
 *   случайный ключ данных DEK (AES-256) хранится в заголовке, зашифрованный KEK
 *   каждая запись = AES-256-GCM(DEK, iv 96 бит, AAD = "keyring:entry:<id>")
 *
 * DEK позволяет менять мастер-пароль без перешифровки всех записей,
 * а AAD привязывает шифротекст к id записи.
 * В памяти DEK живёт как CryptoKey; его сырые байты извлекаются только
 * на мгновение — чтобы «запечатать» ключом восстановления открытое хранилище.
 */
const {
  webcrypto, utf8, fromUtf8, toBase64, fromBase64, randomBytes, wipe,
} = require('./codec');
const {
  FORMAT, FORMAT_VERSION, MIN_ITERATIONS, MAX_ITERATIONS,
} = require('../constants');

const subtle = webcrypto.subtle;
const DEK_AAD = utf8('keyring:dek:v1');

class WrongPasswordError extends Error {
  constructor() {
    super('Неверный мастер-пароль');
    this.name = 'WrongPasswordError';
  }
}

function checkIterations(n) {
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new Error(`Недопустимое число итераций PBKDF2: ${n}`);
  }
}

async function deriveKek(password, salt, iterations) {
  checkIterations(iterations);
  const base = await subtle.importKey(
    'raw', utf8(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function importDek(raw) {
  // extractable: открытое хранилище можно защитить новым ключом восстановления без ввода пароля
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/** «Запечатать» ключ данных открытого хранилища ключами восстановления, убрать отозванные. */
async function resealWithDek(header, dek, add = [], removeIds = []) {
  const raw = new Uint8Array(await subtle.exportKey('raw', dek));
  try {
    let next = Object.assign({}, header, {
      recovery: (Array.isArray(header.recovery) ? header.recovery : []).filter((w) => !removeIds.includes(w.keyId)),
    });
    for (const r of add) {
      if (!r || !r.publicJwk) continue;
      if (next.recovery.some((w) => w.keyId === r.id)) continue;
      next = withRecovery(next, await sealForRecovery(raw, r));
    }
    return next;
  } finally {
    wipe(raw);
  }
}

async function wrapRawKey(raw, password, iterations) {
  const salt = randomBytes(16);
  const kek = await deriveKek(password, salt, iterations);
  const iv = randomBytes(12);
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: DEK_AAD }, kek, raw);
  return {
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    key: { iv: toBase64(iv), data: toBase64(data) },
  };
}

async function unwrapRawKey(header, password) {
  validateHeader(header);
  const salt = fromBase64(header.kdf.salt);
  const kek = await deriveKek(password, salt, header.kdf.iterations);
  try {
    const raw = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(header.key.iv), additionalData: DEK_AAD },
      kek,
      fromBase64(header.key.data)
    );
    return new Uint8Array(raw);
  } catch (e) {
    throw new WrongPasswordError();
  }
}

function validateHeader(h) {
  if (!h || h.format !== FORMAT) throw new Error('Это не заголовок хранилища Keyring');
  if (h.version > FORMAT_VERSION) {
    throw new Error(`Хранилище создано более новой версией Keyring (формат ${h.version})`);
  }
  if (!h.kdf || h.kdf.name !== 'PBKDF2' || h.kdf.hash !== 'SHA-256') {
    throw new Error('Неподдерживаемый KDF в заголовке хранилища');
  }
  checkIterations(h.kdf.iterations);
  if (!h.key || !h.key.iv || !h.key.data) throw new Error('Повреждён заголовок хранилища');
}

/* ---------- ключ восстановления (ECDH P-256 → HKDF-SHA256 → AES-256-GCM) ----------
 * Пара ключей создаётся один раз. Открытый ключ хранится в настройках плагина,
 * им «запечатывается» ключ данных каждого хранилища (запись в header.recovery).
 * Закрытый ключ — файл/текст, который пользователь хранит вне хранилища.
 * Им можно расшифровать ключ данных и задать новый мастер-пароль. */
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const REC_AAD = utf8('keyring:recovery:v1');

function pubJwk(j) {
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
}

async function generateRecoveryKeyPair() {
  const kp = await subtle.generateKey(EC, true, ['deriveBits']);
  const pub = pubJwk(await subtle.exportKey('jwk', kp.publicKey));
  const privFull = await subtle.exportKey('jwk', kp.privateKey);
  const priv = Object.assign(pubJwk(privFull), { d: privFull.d });
  const digest = await subtle.digest('SHA-256', utf8(`${pub.x}.${pub.y}`));
  const id = Array.from(new Uint8Array(digest).slice(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { id, publicJwk: pub, privateJwk: priv };
}

async function recoveryWrapKey(privateKey, publicKey, salt) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('keyring-recovery-v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function sealForRecovery(raw, recovery) {
  const recipient = await subtle.importKey('jwk', recovery.publicJwk, EC, false, []);
  const eph = await subtle.generateKey(EC, true, ['deriveBits']);
  const salt = randomBytes(16);
  const key = await recoveryWrapKey(eph.privateKey, recipient, salt);
  const iv = randomBytes(12);
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: REC_AAD }, key, raw);
  return {
    keyId: recovery.id,
    alg: 'ECDH-P256+HKDF-SHA256+A256GCM',
    epk: pubJwk(await subtle.exportKey('jwk', eph.publicKey)),
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(data),
    created: Date.now(),
  };
}

async function openRecovery(wrap, privateJwk) {
  let key;
  try {
    const priv = await subtle.importKey('jwk', Object.assign({}, privateJwk, { ext: true }), EC, false, ['deriveBits']);
    const epk = await subtle.importKey('jwk', wrap.epk, EC, false, []);
    key = await recoveryWrapKey(priv, epk, fromBase64(wrap.salt));
  } catch (e) {
    throw new Error('Ключ восстановления повреждён или введён с ошибкой');
  }
  try {
    const raw = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(wrap.iv), additionalData: REC_AAD }, key, fromBase64(wrap.data));
    return new Uint8Array(raw);
  } catch (e) {
    throw new Error('Этот ключ восстановления не подходит к хранилищу');
  }
}

function withRecovery(header, wrap) {
  const list = (Array.isArray(header.recovery) ? header.recovery : []).filter((w) => w.keyId !== wrap.keyId);
  return Object.assign({}, header, { recovery: list.concat(wrap) });
}

/** Добавить в заголовок «печать» ключа восстановления (нужен мастер-пароль). */
async function addRecoveryToHeader(header, password, recovery) {
  const raw = await unwrapRawKey(header, password);
  try {
    return withRecovery(header, await sealForRecovery(raw, recovery));
  } finally {
    wipe(raw);
  }
}

async function rawFromRecovery(header, privateJwk) {
  validateHeader(header);
  const wraps = Array.isArray(header.recovery) ? header.recovery : [];
  if (!wraps.length) throw new Error('В этом хранилище ключ восстановления ещё не сохранён');
  let lastError = null;
  for (const w of wraps) {
    try {
      return await openRecovery(w, privateJwk);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** ID ключа восстановления по его открытой части (как при создании). */
async function recoveryKeyId(jwk) {
  const digest = await subtle.digest('SHA-256', utf8(`${jwk.x}.${jwk.y}`));
  return Array.from(new Uint8Array(digest).slice(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Открыть ключом восстановления по основному заголовку, а если в нём нет
 * подходящей «печати» — по запасным заголовкам (из комплекта восстановления).
 * Дополнительно «запечатывает» основной заголовок ключами из reseal.
 * Возвращает { key, via: 'header' | 'alt', header } — header новый, если изменился.
 */
async function openWithRecoveryAny(header, privateJwk, { altHeaders = [], reseal = [], verify } = {}) {
  let raw = null;
  let via = 'header';
  try {
    raw = await rawFromRecovery(header, privateJwk);
  } catch (e) {
    for (const h of altHeaders) {
      try {
        raw = await rawFromRecovery(h, privateJwk);
        via = 'alt';
        break;
      } catch (e2) { /* следующий */ }
    }
    if (!raw) throw e;
  }
  try {
    const key = await importDek(raw);
    if (verify && !(await verify(key))) {
      throw new Error('Копия заголовка из файла относится к другому хранилищу: записи этой папки ею не открываются');
    }
    let next = header;
    let changed = false;
    const ownId = await recoveryKeyId(privateJwk);
    const list = via === 'alt' ? [{ id: ownId, publicJwk: pubJwk(privateJwk) }].concat(reseal) : reseal;
    const have = new Set((Array.isArray(header.recovery) ? header.recovery : []).map((w) => w.keyId));
    for (const r of list) {
      if (!r || !r.publicJwk || have.has(r.id)) continue;
      next = withRecovery(next, await sealForRecovery(raw, r));
      have.add(r.id);
      changed = true;
    }
    return { key, via, header: changed ? next : null };
  } finally {
    wipe(raw);
  }
}

/** Открыть хранилище ключом восстановления, не меняя мастер-пароль. */
async function openWithRecovery(header, privateJwk) {
  const raw = await rawFromRecovery(header, privateJwk);
  try {
    return await importDek(raw);
  } finally {
    wipe(raw);
  }
}

/** Сброс мастер-пароля ключом восстановления. */
async function resetWithRecovery(header, privateJwk, newPassword, iterations) {
  const raw = await rawFromRecovery(header, privateJwk);
  try {
    const wrapped = await wrapRawKey(raw, newPassword, iterations || header.kdf.iterations);
    const newHeader = Object.assign({}, header, wrapped, { changed: Date.now() });
    const key = await importDek(raw);
    return { header: newHeader, key };
  } finally {
    wipe(raw);
  }
}

/** Новый заголовок + ключ данных. */
async function createVaultKeys(password, iterations, recovery) {
  const raw = randomBytes(32);
  try {
    const wrapped = await wrapRawKey(raw, password, iterations);
    const key = await importDek(raw);
    let header = Object.assign(
      { format: FORMAT, version: FORMAT_VERSION, cipher: 'AES-256-GCM' },
      wrapped
    );
    if (recovery) header = withRecovery(header, await sealForRecovery(raw, recovery));
    return { header, key };
  } finally {
    wipe(raw);
  }
}

async function unlockVaultKey(header, password) {
  const raw = await unwrapRawKey(header, password);
  try {
    return await importDek(raw);
  } finally {
    wipe(raw);
  }
}

/** Смена мастер-пароля: тот же ключ данных, новая соль и обёртка. */
async function rewrapVaultKey(header, oldPassword, newPassword, iterations) {
  const raw = await unwrapRawKey(header, oldPassword);
  try {
    const wrapped = await wrapRawKey(raw, newPassword, iterations || header.kdf.iterations);
    return Object.assign({}, header, wrapped, { changed: Date.now() });
  } finally {
    wipe(raw);
  }
}

function entryAad(id) {
  return utf8(`keyring:entry:${id}`);
}

async function encryptJson(key, obj, aad) {
  const iv = randomBytes(12);
  const plain = utf8(JSON.stringify(obj));
  try {
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
    return { iv: toBase64(iv), data: toBase64(data) };
  } finally {
    wipe(plain);
  }
}

async function decryptJson(key, envelope, aad) {
  let plain;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad },
      key,
      fromBase64(envelope.data)
    );
  } catch (e) {
    throw new Error('Не удалось расшифровать: файл повреждён или зашифрован другим ключом');
  }
  const bytes = new Uint8Array(plain);
  try {
    return JSON.parse(fromUtf8(bytes));
  } finally {
    wipe(bytes);
  }
}

module.exports = {
  WrongPasswordError,
  createVaultKeys,
  generateRecoveryKeyPair,
  addRecoveryToHeader,
  resetWithRecovery,
  openWithRecovery,
  openWithRecoveryAny,
  resealWithDek,
  recoveryKeyId,
  unlockVaultKey,
  rewrapVaultKey,
  validateHeader,
  encryptJson,
  decryptJson,
  entryAad,
};
