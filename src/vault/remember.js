'use strict';
/*
 * «Не спрашивать пароль на этом устройстве».
 *
 * Ключ данных хранилища (DEK) шифруется ключом устройства — неэкспортируемым
 * AES-256-GCM CryptoKey, который живёт в IndexedDB этого приложения. Сам
 * зашифрованный DEK лежит в локальном хранилище Obsidian (saveLocalStorage).
 * Ни то ни другое не попадает в папку хранилища, поэтому Syncthing их не
 * синхронизирует: на каждом устройстве опцию включают отдельно.
 *
 * Защита в этом режиме — блокировка самого устройства/учётной записи.
 *
 * Режим PIN: DEK сначала шифруется ключом из PIN (PBKDF2), затем ключом
 * устройства. Перебрать PIN вне этого приложения нельзя (ключ устройства не
 * извлекается), а внутри — после 5 неверных попыток PIN стирается и нужен
 * мастер-пароль.
 */
const { toBase64, fromBase64, utf8, randomBytes } = require('../crypto/codec');

const subtle = globalThis.crypto.subtle;
const PIN_ITERATIONS = 210000;
const PIN_ATTEMPTS = 5;

class PinError extends Error {
  constructor(message, left) {
    super(message);
    this.name = 'PinError';
    this.left = left;
  }
}
const DB_NAME = 'keyring-device';
const STORE = 'keys';

function lsKey(folder) {
  return `keyring-remember:${folder}`;
}

function load(app, folder) {
  try {
    if (typeof app.loadLocalStorage === 'function') return app.loadLocalStorage(lsKey(folder)) || null;
    return JSON.parse(window.localStorage.getItem(`${app.appId || ''}:${lsKey(folder)}`) || 'null');
  } catch (e) {
    return null;
  }
}

function store(app, folder, value) {
  try {
    if (typeof app.saveLocalStorage === 'function') app.saveLocalStorage(lsKey(folder), value);
    else if (value === null) window.localStorage.removeItem(`${app.appId || ''}:${lsKey(folder)}`);
    else window.localStorage.setItem(`${app.appId || ''}:${lsKey(folder)}`, JSON.stringify(value));
  } catch (e) {
    console.warn('Keyring: не удалось сохранить настройку устройства', e);
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  }));
}

/** Ключ устройства (свой для каждого хранилища Obsidian). */
async function deviceKey(app, create) {
  const id = `device:${app.appId || 'default'}`;
  let key = await idb('readonly', (s) => s.get(id)).catch(() => null);
  if (!key && create) {
    key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb('readwrite', (s) => s.put(key, id));
  }
  return key || null;
}

/** AAD: папка + момент создания хранилища — копия не подойдёт к другому хранилищу. */
function aad(vault) {
  return utf8(`keyring-remember:${vault.folder}:${vault.header && vault.header.created}`);
}

async function pinKey(pin, salt) {
  const base = await subtle.importKey('raw', utf8(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Запомнить открытое хранилище на этом устройстве.
 * opts.pin — вход по PIN-коду; без него — вход без пароля.
 */
async function remember(app, vault, opts = {}) {
  if (!vault.key) throw new Error('Хранилище заблокировано');
  const dk = await deviceKey(app, true);
  let payload = new Uint8Array(await subtle.exportKey('raw', vault.key));
  const rec = { v: 2, mode: opts.pin ? 'pin' : 'none', created: Date.now() };
  try {
    if (opts.pin) {
      const salt = randomBytes(16);
      const pinIv = randomBytes(12);
      const inner = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: pinIv, additionalData: aad(vault) }, await pinKey(opts.pin, salt), payload));
      payload.fill(0);
      payload = inner;
      Object.assign(rec, { salt: toBase64(salt), pinIv: toBase64(pinIv), fails: 0, pinLength: String(opts.pin).length });
    }
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(vault) }, dk, payload);
    store(app, vault.folder, Object.assign(rec, { iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) }));
  } finally {
    payload.fill(0);
  }
}

/**
 * Ключ данных из памяти устройства — или null (не запомнено / ключ устройства утерян).
 * Для режима PIN нужен pin; неверный PIN → PinError (left — сколько попыток осталось).
 */
async function recall(app, vault, pin) {
  const rec = load(app, vault.folder);
  if (!rec || !rec.data) return null;
  const dk = await deviceKey(app, false);
  if (!dk) return null;
  let raw = null;
  try {
    try {
      raw = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(rec.iv), additionalData: aad(vault) }, dk, fromBase64(rec.data)));
    } catch (e) {
      return null;
    }
    if (rec.mode === 'pin') {
      if (!pin) throw new PinError('Введите PIN-код', PIN_ATTEMPTS - (rec.fails || 0));
      let inner;
      try {
        inner = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(rec.pinIv), additionalData: aad(vault) },
          await pinKey(pin, fromBase64(rec.salt)), raw));
      } catch (e) {
        const fails = (rec.fails || 0) + 1;
        if (fails >= PIN_ATTEMPTS) {
          store(app, vault.folder, null);
          throw new PinError('Слишком много неверных попыток — PIN-код отключён. Войдите мастер-паролем.', 0);
        }
        store(app, vault.folder, Object.assign({}, rec, { fails }));
        throw new PinError(`Неверный PIN-код. Осталось попыток: ${PIN_ATTEMPTS - fails}`, PIN_ATTEMPTS - fails);
      }
      raw.fill(0);
      raw = inner;
      if (rec.fails) store(app, vault.folder, Object.assign({}, rec, { fails: 0 }));
    }
    return await subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  } finally {
    if (raw) raw.fill(0);
  }
}

/** Режим входа на этом устройстве: 'none' (без пароля), 'pin' или null. */
function mode(app, folder) {
  const rec = load(app, folder);
  if (!rec || !rec.data) return null;
  return rec.mode === 'pin' ? 'pin' : 'none';
}

function pinInfo(app, folder) {
  const rec = load(app, folder);
  return rec && rec.mode === 'pin' ? { length: rec.pinLength || 0, left: PIN_ATTEMPTS - (rec.fails || 0) } : null;
}

function forget(app, folder) {
  store(app, folder, null);
}

function isRemembered(app, folder) {
  const rec = load(app, folder);
  return !!(rec && rec.data);
}

module.exports = {
  remember, recall, forget, isRemembered, mode, pinInfo, PinError, PIN_ATTEMPTS,
};
