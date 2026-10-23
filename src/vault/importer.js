'use strict';
/*
 * Импорт обычных заметок с паролями в зашифрованное хранилище.
 * Распознаёт строки вида «Логин: …», «Пароль = …», «URL: …», «2FA: …»
 * только в тексте заметки. Из свойств (frontmatter) берутся лишь теги —
 * сами свойства сохраняются в заметке записи без изменений.
 */
const { newEntry } = require('./entry');
const { splitFrontmatter, tagsFromProps } = require('../util/frontmatter');

const KEYS = {
  username: /^(логин|login|user|username|user name|пользователь|имя пользователя|e-?mail|email|почта|аккаунт|account|учётка|учетка)$/i,
  password: /^(пароль|password|pass|passwd|pwd|пасс|pin|пин|пин-код|pin-код|код доступа)$/i,
  url: /^(url|сайт|site|ссылка|link|адрес|website|web|домен)$/i,
  totp: /^(totp|2fa|otp|2fa secret|секрет 2fa|totp secret|otpauth|ключ 2fa)$/i,
  tags: /^(tags|теги)$/i,
};

const LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?([^:=\n*_]{1,32}?)(?:\*\*|__)?\s*[:=]\s*(?:\*\*|__)?\s*(.+?)\s*$/;
const URL_RE = /^\s*(?:[-*+]\s+)?<?(https?:\/\/[^\s>]+)>?\s*$/i;

function cleanValue(v) {
  return String(v).trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^(\*\*|__)|(\*\*|__)$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function keyKind(key) {
  const k = key.trim().replace(/\s+/g, ' ');
  for (const [kind, re] of Object.entries(KEYS)) if (re.test(k)) return kind;
  return null;
}

function parseNote(text, title) {
  const result = {
    title, username: '', password: '', url: '', totp: '', tags: [], notes: '', matched: 0,
  };
  // свойства: только теги; логин/пароль из свойств не берутся
  const fm = splitFrontmatter(text);
  result.tags = tagsFromProps(fm.props);
  const otherProps = Object.keys(fm.props).some((k) => !/^(tags|tag|теги|тег)$/i.test(k));
  const body = fm.body;

  const rest = [];
  for (const line of body.split('\n')) {
    const m = line.match(LINE_RE);
    if (m) {
      const kind = keyKind(m[1]);
      if (kind && kind !== 'tags' && !result[kind]) {
        result[kind] = cleanValue(m[2]);
        result.matched++;
        continue;
      }
    }
    const u = line.match(URL_RE);
    if (u && !result.url) {
      result.url = u[1];
      result.matched++;
      continue;
    }
    rest.push(line);
  }
  result.notes = rest.join('\n').replace(/^\s*#\s+.*\n/, (h) => (h.trim().slice(1).trim() === title ? '' : h)).trim();
  // прочие свойства (aliases, даты…) остаются в заметке как есть
  if (otherProps) result.notes = `${fm.raw.replace(/\n?$/, '\n')}${result.notes ? `\n${result.notes}` : ''}`;
  return result;
}

function toEntry(item, category) {
  const p = item.parsed;
  const entry = newEntry(p.password ? 'login' : 'note', category);
  Object.assign(entry, {
    title: p.title,
    username: p.username,
    password: p.password,
    url: p.url,
    totp: p.totp,
    tags: p.tags,
    notes: p.notes,
    created: item.file.stat ? item.file.stat.ctime : Date.now(),
    updated: Date.now(),
  });
  entry.passwordChanged = entry.created;
  return entry;
}

module.exports = {
  parseNote, toEntry, keyKind, cleanValue,
};
