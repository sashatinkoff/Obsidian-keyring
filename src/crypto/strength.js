'use strict';
/*
 * Оценка стойкости пароля: энтропия по алфавиту с поправками на повторы,
 * последовательности, клавиатурные дорожки и словарь частых паролей.
 * Шкала 0–100 (100 ≈ 100+ бит эффективной энтропии).
 */

const COMMON = new Set([
  'password', 'passw0rd', 'qwerty', 'qwerty123', '123456', '12345678', '123456789',
  '1234567890', '111111', '000000', 'admin', 'administrator', 'letmein', 'welcome',
  'iloveyou', 'monkey', 'dragon', 'football', 'master', 'login', 'abc123', 'root',
  'пароль', 'йцукен', 'qwertyuiop', 'asdfgh', 'zxcvbn', '1q2w3e4r', '1qaz2wsx',
]);

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю', '1234567890'];

const LEVELS = [
  { min: 0, label: 'Очень слабый', level: 0 },
  { min: 35, label: 'Слабый', level: 1 },
  { min: 60, label: 'Средний', level: 2 },
  { min: 80, label: 'Надёжный', level: 3 },
  { min: 95, label: 'Сверхстойкий', level: 4 },
];

function poolSize(pw) {
  let size = 0;
  if (/[a-z]/.test(pw)) size += 26;
  if (/[A-Z]/.test(pw)) size += 26;
  if (/[0-9]/.test(pw)) size += 10;
  if (/[^a-zA-Z0-9Ѐ-ӿ]/.test(pw)) size += 33;
  if (/[Ѐ-ӿ]/.test(pw)) size += 66;
  return Math.max(size, 1);
}

function isSequential(a, b) {
  const d = b.charCodeAt(0) - a.charCodeAt(0);
  if (d === 1 || d === -1) return true;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return ROWS.some((row) => {
    const i = row.indexOf(la);
    return i >= 0 && (row[i + 1] === lb || row[i - 1] === lb);
  });
}

function effectiveLength(pw) {
  const chars = Array.from(pw);
  let eff = chars.length ? 1 : 0;
  for (let i = 1; i < chars.length; i++) {
    const prev = chars[i - 1];
    const cur = chars[i];
    if (cur === prev) eff += 0.15;
    else if (isSequential(prev, cur)) eff += 0.35;
    else eff += 1;
  }
  // повтор подстрок («abcabc», «2024-2024»)
  const half = Math.floor(chars.length / 2);
  for (let size = half; size >= 2; size--) {
    const head = chars.slice(0, size).join('');
    if (pw.split(head).length - 1 >= 2) {
      eff *= 0.7;
      break;
    }
  }
  return eff;
}

const cache = new Map();

function analyzePassword(pw) {
  if (!pw) return { bits: 0, score: 0, label: 'Нет пароля', level: 0, empty: true };
  if (cache.has(pw)) return cache.get(pw);

  let bits = effectiveLength(pw) * Math.log2(poolSize(pw));
  const lower = pw.toLowerCase();
  const stripped = lower.replace(/[^a-zа-яё]/g, '');
  if (COMMON.has(lower) || COMMON.has(stripped)) bits = Math.min(bits, 10);
  else if (stripped.length >= 4 && Array.from(COMMON).some((w) => w.length >= 5 && lower.includes(w))) bits *= 0.6;
  if (/^\d+$/.test(pw)) bits = Math.min(bits, pw.length * 3.32 * 0.8);
  if (/^(19|20)\d{2}$|^\d{2}[.\-/]\d{2}[.\-/]\d{2,4}$/.test(pw)) bits = Math.min(bits, 12);

  bits = Math.max(0, Math.round(bits * 10) / 10);
  const score = Math.max(0, Math.min(100, Math.round(bits)));
  let lvl = LEVELS[0];
  for (const l of LEVELS) if (score >= l.min) lvl = l;
  const result = { bits, score, label: lvl.label, level: lvl.level, empty: false };

  if (cache.size > 2000) cache.clear();
  cache.set(pw, result);
  return result;
}

module.exports = { analyzePassword, LEVELS };
