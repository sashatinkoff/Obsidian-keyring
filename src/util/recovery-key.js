'use strict';
/* Формат ключа восстановления: JSON-файл и компактный текст для печати. */

const PREFIX = 'KEYRING-RECOVERY-1';

function toText(id, jwk) {
  return `${PREFIX}:${id}:${jwk.x}:${jwk.y}:${jwk.d}`;
}

/** Первая строка — префикс и ID, дальше ключ группами по 4 символа (удобно печатать и сверять). */
function toPrintable(text) {
  const parts = text.split(':');
  const head = `${parts[0]}:${parts[1]}:`;
  const body = parts.slice(2).join(':');
  const groups = body.match(/.{1,4}/g) || [];
  const lines = [head];
  for (let i = 0; i < groups.length; i += 8) lines.push(groups.slice(i, i + 8).join(' '));
  return lines.join('\n');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Файл ключа — обычный текст: сам ключ одной строкой и пояснение.
 * Комплект восстановления дописывает ниже копии заголовков хранилищ (JSON).
 */
function toKeyFile(id, jwk, created, headers) {
  const d = new Date(created || Date.now());
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const lines = [
    toText(id, jwk),
    '',
    '# Keyring — ключ восстановления',
    `# ID: ${id} · создан ${date}`,
    '# Открывает все хранилища, защищённые этим ключом.',
    '# Храните вне хранилища Obsidian и вне папок Syncthing.',
  ];
  const list = Array.isArray(headers) ? headers : [];
  if (list.length) {
    lines.push(
      '',
      `# Копии заголовков хранилищ (${list.map((h) => h.name || h.folder).join(', ')}) — секретов не содержат.`,
      '# Нужны, если keyring.vault.json в папке хранилища утерян.',
      JSON.stringify({ format: 'keyring-headers', version: 1, headers: list }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function toFile(id, jwk, created, headers) {
  return JSON.stringify({
    format: 'keyring-recovery-key',
    version: 1,
    id,
    created,
    alg: 'ECDH-P256',
    privateJwk: jwk,
    text: toText(id, jwk),
    headers: Array.isArray(headers) ? headers : [],
    warning: 'Храните вне хранилища Obsidian и вне Syncthing. Этот файл открывает все хранилища, защищённые ключом.',
  }, null, 2);
}

const TEXT_RE = /KEYRING-RECOVERY-1:([0-9a-f]{12}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})/;

function fromJsonObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.privateJwk && obj.privateJwk.d) return { id: obj.id, privateJwk: obj.privateJwk };
  if (typeof obj.text === 'string') return fromText(obj.text);
  return null;
}

function fromText(str) {
  const m = String(str).replace(/\s+/g, '').match(TEXT_RE);
  if (!m) return null;
  return {
    id: m[1],
    privateJwk: {
      kty: 'EC', crv: 'P-256', x: m[2], y: m[3], d: m[4],
    },
  };
}

/**
 * Принимает содержимое файла любого формата (JSON, .txt, .md, заметку, письмо…):
 * ищет внутри JSON ключа или текстовую строку KEYRING-RECOVERY-1:…
 */
function parseRecoveryKey(input) {
  const raw = String(input || '').replace(/^﻿/, '').replace(/\u0000/g, '').trim();
  if (!raw) throw new Error('Пустой ключ');

  // 1. JSON целиком
  try {
    const k = fromJsonObject(JSON.parse(raw));
    if (k) return k;
  } catch (e) {
    /* не JSON — ищем дальше */
  }
  // 2. JSON внутри другого текста
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const k = fromJsonObject(JSON.parse(raw.slice(a, b + 1)));
      if (k) return k;
    } catch (e) {
      /* ignore */
    }
  }
  // 3. текстовая форма где угодно (в том числе с переносами и пробелами с распечатки)
  const k = fromText(raw);
  if (k) return k;
  throw new Error('В файле не найден ключ восстановления Keyring');
}

module.exports = {
  toText, toPrintable, toFile, toKeyFile, parseRecoveryKey,
};
