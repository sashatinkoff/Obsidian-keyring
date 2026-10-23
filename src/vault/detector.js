'use strict';
/*
 * Поиск данных для входа в свободном тексте заметки, когда они не оформлены
 * полями: «alex@mail.ru / Qwe!2024», «пароль от роутера admin123»,
 * голые ссылки, телефоны, секреты 2FA. Результат — кандидаты с оценкой
 * уверенности и строкой-источником для предпросмотра.
 */
const { keyKind, cleanValue } = require('./importer');
const { splitFrontmatter, tagsFromProps } = require('../util/frontmatter');
const { parseTotp } = require('../crypto/totp');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/[^\s<>()"'`]+|www\.[^\s<>()"'`]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ru|com|org|net|io|me|рф|su|by|kz|ua|de|app|dev|co|info|online|site|tech)(?:\/[^\s<>()"'`]*)?)/gi;
const PHONE_RE = /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
const OTPAUTH_RE = /otpauth:\/\/totp\/[^\s<>"'`]+/i;
const BASE32_RE = /\b[A-Z2-7]{16,64}\b/;
// «логин / пароль», «логин | пароль», «логин : пароль» в одной строке
const PAIR_RE = /^\s*(?:[-*+]\s+)?`?([^\s/|:`]{3,64})`?\s*(?:\/|\||:|\s—\s|\s-\s|\s{2,}|\t)\s*`?([^\s`]{4,64})`?\s*$/;
// «пароль от wifi qwerty123», «pass admin123»
const KEYWORD_RE = /(?:пароль|парол|password|pass|pwd|пасс|pin|пин(?:-код)?|код)\s*(?:от|для|на)?\s*[^\s:=]*?\s*[:=—-]?\s*`?([^\s`,;]{4,64})`?\s*$/i;
const LOGIN_KEYWORD_RE = /(?<![\p{L}\d_.@-])(?:логин|login|user(?:name)?|юзер|ник|учётка|учетка)(?![\p{L}\d_.@-])\s*(?:от|для|на)?\s*[:=—-]?\s*`?([^\s`,;]{3,64})`?/iu;

const STOP = new Set(['пароль', 'password', 'логин', 'login', 'https', 'http', 'admin', 'user']);

function classes(s) {
  let n = 0;
  if (/[a-zа-яё]/.test(s)) n++;
  if (/[A-ZА-ЯЁ]/.test(s)) n++;
  if (/\d/.test(s)) n++;
  if (/[^A-Za-zА-Яа-яЁё0-9]/.test(s)) n++;
  return n;
}

/** Похоже ли слово на пароль: оценка 0..1. */
function passwordScore(token) {
  const t = token.replace(/^[`'"«]+|[`'"»,.;]+$/g, '');
  if (t.length < 4 || t.length > 64) return 0;
  if (/^[a-z]+:\/\/|^www\./i.test(t)) return 0;
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t)) return 0; // e-mail
  if (new RegExp(`^${URL_RE.source}$`, 'i').test(t) && !/[A-Z]/.test(t)) return 0; // домен
  if (/^\d{1,4}([./-]\d{1,4}){1,2}$/.test(t)) return 0; // даты
  if (/^[+\d\s()-]{7,}$/.test(t) && /^\+?\d/.test(t)) return 0; // телефоны
  if (/^[\p{L}]+$/u.test(t) && t.length < 10) return 0; // обычное слово
  if (STOP.has(t.toLowerCase())) return 0;
  if (/^[a-z]+([._-][a-z]+)+$/.test(t)) return 0.15; // alex.petrov — похоже на логин
  const c = classes(t);
  let score = 0;
  if (c >= 3) score = 0.75;
  else if (c === 2 && t.length >= 8) score = 0.55;
  else if (c === 2) score = 0.35;
  else if (/^\d{4,8}$/.test(t)) score = 0.3; // PIN
  if (t.length >= 12 && c >= 2) score += 0.15;
  return Math.min(1, score);
}

function push(list, c) {
  const exist = list.find((x) => x.field === c.field && x.value === c.value);
  if (exist) {
    exist.score = Math.max(exist.score, c.score);
    return;
  }
  list.push(c);
}

/**
 * Возвращает { username:[], password:[], url:[], totp:[] } — кандидаты,
 * отсортированные по уверенности. Каждый: { field, value, score, line, lineIndex, consumes }.
 * consumes — строку целиком можно убрать из заметки после переноса в поле.
 */
function detectCredentials(text) {
  const out = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  // свойства заметки (frontmatter) пропускаем: из них берутся только теги
  const fmLines = splitFrontmatter(text).lines;

  lines.forEach((raw, i) => {
    if (i < fmLines) return;
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^```/.test(line)) return;
    const plain = line.replace(/^[-*+]\s+/, '').replace(/\*\*|__/g, '');
    const base = { line: raw, lineIndex: i };

    // 1. «Ключ: значение» с известным ключом
    const kv = plain.match(/^([^:=]{1,32}?)\s*[:=]\s*(.+)$/);
    if (kv) {
      const kind = keyKind(kv[1]);
      if (kind && kind !== 'tags') {
        push(out, Object.assign({ field: kind, value: cleanValue(kv[2]), score: 0.98, consumes: true }, base));
        return;
      }
    }

    // 2. otpauth / base32
    const otp = plain.match(OTPAUTH_RE);
    if (otp && parseTotp(otp[0])) {
      push(out, Object.assign({ field: 'totp', value: otp[0], score: 0.95, consumes: plain.trim() === otp[0] }, base));
    } else {
      const b32 = plain.match(BASE32_RE);
      if (b32 && /2fa|totp|otp|google auth|authenticator|секрет/i.test(plain) && parseTotp(b32[0])) {
        push(out, Object.assign({ field: 'totp', value: b32[0], score: 0.85, consumes: false }, base));
      }
    }

    // 3. пара «логин / пароль» в одной строке
    const pair = plain.includes('://') ? null : plain.match(PAIR_RE);
    if (pair && passwordScore(pair[2]) >= 0.3) {
      push(out, Object.assign({ field: 'username', value: cleanValue(pair[1]), score: 0.8, consumes: true }, base));
      push(out, Object.assign({ field: 'password', value: cleanValue(pair[2]), score: 0.8 + passwordScore(pair[2]) * 0.15, consumes: true }, base));
      return;
    }

    // 4. ключевые слова без двоеточия
    const kw = plain.match(KEYWORD_RE);
    if (kw && passwordScore(kw[1]) >= 0.3) {
      push(out, Object.assign({ field: 'password', value: cleanValue(kw[1]), score: 0.7 + passwordScore(kw[1]) * 0.2, consumes: false }, base));
    }
    const lk = plain.match(LOGIN_KEYWORD_RE);
    if (lk && !/^(от|для|на)$/i.test(lk[1])) {
      push(out, Object.assign({ field: 'username', value: cleanValue(lk[1]), score: 0.7, consumes: false }, base));
    }

    // 5. e-mail и телефон → логин
    for (const m of plain.matchAll(EMAIL_RE)) {
      push(out, Object.assign({ field: 'username', value: m[0], score: plain.trim() === m[0] ? 0.75 : 0.6, consumes: plain.trim() === m[0] }, base));
    }
    for (const m of plain.matchAll(PHONE_RE)) {
      push(out, Object.assign({ field: 'username', value: m[0].trim(), score: 0.45, consumes: plain.trim() === m[0].trim() }, base));
    }

    // 6. ссылки (не внутри e-mail)
    const noMail = plain.replace(EMAIL_RE, ' ');
    for (const m of noMail.matchAll(URL_RE)) {
      if (/^otpauth/i.test(m[0]) || /^\[\[/.test(m[0])) continue;
      const v = m[0].replace(/[.,;)]+$/, '');
      push(out, Object.assign({ field: 'url', value: v, score: /^https?:/.test(v) ? 0.8 : 0.55, consumes: plain.trim() === v }, base));
    }

    // 7. одиночное слово на строке: «парольное» → пароль, «логинное» → логин
    const tokens = plain.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) {
      const tok = cleanValue(tokens[0]);
      const s = passwordScore(tok);
      if (s >= 0.55) {
        push(out, Object.assign({ field: 'password', value: tok, score: s * 0.8, consumes: true }, base));
      } else if (/^[a-z][a-z0-9._-]{2,31}$/i.test(tok) && /[._\d-]/.test(tok) && !/\.(ru|com|org|net|io|me|рф)$/i.test(tok)) {
        push(out, Object.assign({ field: 'username', value: tok, score: 0.5, consumes: true }, base));
      }
    }
  });

  // запись «в столбик»: строка-логин (e-mail, ник), а следующая строка текста — одно слово.
  // Пустые строки и ограды ``` между ними пропускаются.
  const content = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (i < fmLines || !t || /^```/.test(t) || /^#{1,6}\s/.test(t)) return;
    content.push({ i, t: t.replace(/^[-*+]\s+/, '') });
  });
  for (let k = 0; k + 1 < content.length; k++) {
    const u = out.find((c) => c.field === 'username' && c.lineIndex === content[k].i && c.consumes);
    if (!u) continue;
    const next = content[k + 1];
    const tok = cleanValue(next.t);
    if (/\s/.test(tok) || tok.length < 4 || tok.length > 64) continue;
    if (EMAIL_RE.test(tok) || /:\/\/|^www\./i.test(tok)) {
      EMAIL_RE.lastIndex = 0;
      continue;
    }
    EMAIL_RE.lastIndex = 0;
    const colScore = Math.min(0.9, 0.6 + passwordScore(tok) * 0.3);
    const already = out.find((c) => c.field === 'password' && c.lineIndex === next.i);
    if (already) {
      already.score = Math.max(already.score, colScore);
      u.score = Math.min(1, u.score + 0.1);
      continue;
    }
    // домены, телефоны и даты паролем не считаем
    if ((new RegExp(`^${URL_RE.source}$`, 'i').test(tok) && !/[A-Z]/.test(tok))
      || /^\+?[\d\s()-]{7,}$/.test(tok) || /^\d{1,4}([./-]\d{1,4}){1,2}$/.test(tok)) continue;
    // это слово не должно быть уже принято за логин или ссылку с высокой уверенностью
    out.forEach((c) => {
      if (c.lineIndex === next.i && c.field === 'username') c.score = Math.min(c.score, 0.4);
    });
    push(out, {
      field: 'password', value: tok, score: colScore, consumes: true, line: lines[next.i], lineIndex: next.i,
    });
    u.score = Math.min(1, u.score + 0.1);
  }

  // логин на строке и пароль на следующей — типичная запись «в столбик»
  for (const u of out.filter((c) => c.field === 'username')) {
    const p = out.find((c) => c.field === 'password' && c.lineIndex === u.lineIndex + 1);
    if (p) {
      u.score = Math.min(1, u.score + 0.15);
      p.score = Math.min(1, p.score + 0.15);
    }
  }

  const result = { username: [], password: [], url: [], totp: [] };
  for (const c of out) if (result[c.field] && c.value) result[c.field].push(c);
  for (const k of Object.keys(result)) result[k].sort((a, b) => b.score - a.score);
  return result;
}

/** Есть ли что предложить для записи (только пустые поля). */
function suggestionsFor(entry) {
  if (!entry || entry.suggestDismissed || entry.type === 'file') return null;
  const text = [entry.notes, ...entry.fields.map((f) => `${f.label}: ${f.value}`)].join('\n');
  if (!text.trim()) return null;
  const found = detectCredentials(entry.notes);
  const picks = {};
  let any = false;
  // теги из свойств заметки — если у записи своих тегов ещё нет
  const fmTags = tagsFromProps(splitFrontmatter(entry.notes).props);
  const newTags = fmTags.filter((t) => !(entry.tags || []).includes(t));
  for (const field of ['username', 'password', 'url', 'totp']) {
    if (entry[field]) continue; // поле уже заполнено
    const list = found[field].filter((c) => c.score >= 0.45);
    if (list.length) {
      picks[field] = list;
      any = true;
    }
  }
  // одна только ссылка — не повод беспокоить
  if (!any || (Object.keys(picks).length === 1 && picks.url)) return null;
  if (newTags.length) {
    picks.tags = [{
      field: 'tags', value: newTags.join(', '), score: 0.9, consumes: false, line: 'свойство tags', lineIndex: -1,
    }];
  }
  return picks;
}

module.exports = { detectCredentials, suggestionsFor, passwordScore };
