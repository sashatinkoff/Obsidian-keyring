'use strict';
/*
 * PIN-коды: генерация без «простых» комбинаций и оценка предсказуемости.
 * Энтропия PIN всегда невелика (4 цифры ≈ 13 бит) — защищает его ограничение
 * числа попыток у банка/телефона, поэтому важнее всего не попасть в топ угадываемых.
 */
const { randomInt } = require('./codec');
const { analyzePassword } = require('./strength');

// самые частые PIN (по исследованиям утечек) и «клавиатурные» узоры
const COMMON = new Set([
  '0000', '1111', '1234', '1212', '7777', '1004', '2000', '4444', '2222', '6969', '9999', '3333', '5555', '6666',
  '1122', '1313', '8888', '4321', '2001', '1010', '2580', '0852', '1478', '3698', '1357', '2468', '0987', '1230',
  '0123', '7410', '1590', '9876', '5683', '1001', '1000', '0101', '2525', '1984', '1986', '1987', '1990', '2012',
  '123456', '654321', '111111', '000000', '121212', '123123', '112233', '159753', '147258', '696969', '666666',
  '777777', '555555', '123321', '520520', '258456', '789456', '102030', '000001', '999999', '101010',
  '12345678', '87654321', '11111111', '00000000', '12341234', '11223344', '20202020',
]);

/** Почему PIN предсказуемый (текст) — или null. */
function pinWeakness(pin) {
  const s = String(pin || '');
  if (!/^\d+$/.test(s)) return null;
  if (/^(\d)\1+$/.test(s)) return 'одна цифра подряд';
  if (COMMON.has(s)) return 'входит в список самых частых PIN';
  const d = s.split('').map(Number);
  const steps = d.slice(1).map((v, i) => (v - d[i] + 10) % 10);
  if (steps.every((x) => x === steps[0]) && (steps[0] === 1 || steps[0] === 9 || steps[0] === 2 || steps[0] === 8)) return 'последовательность цифр';
  for (const len of [1, 2, 3]) {
    if (s.length % len === 0 && s.length > len && s === s.slice(0, len).repeat(s.length / len)) return 'повторяющийся узор';
  }
  if (s.length === 4 && /^(19[4-9]\d|20[0-3]\d)$/.test(s)) return 'похоже на год';
  if (s.length === 4) {
    const a = Number(s.slice(0, 2));
    const b = Number(s.slice(2));
    if ((a >= 1 && a <= 31 && b >= 1 && b <= 12) || (a >= 1 && a <= 12 && b >= 1 && b <= 31)) return 'похоже на дату (ДДММ)';
  }
  if (s.length === 6 && /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\d{2}$/.test(s)) return 'похоже на дату (ДДММГГ)';
  if (new Set(s).size <= Math.max(1, Math.floor(s.length / 3))) return 'слишком мало разных цифр';
  return null;
}

/** Случайный PIN нужной длины; по умолчанию без предсказуемых комбинаций. */
function generatePin(length = 4, { avoidWeak = true } = {}) {
  const n = Math.max(4, Math.min(12, Number(length) || 4));
  for (let attempt = 0; attempt < 200; attempt++) {
    let pin = '';
    for (let i = 0; i < n; i++) pin += String(randomInt(10));
    if (!avoidWeak || !pinWeakness(pin)) return pin;
  }
  return Array.from({ length: n }, () => String(randomInt(10))).join('');
}

/** Оценка PIN в том же виде, что analyzePassword (для полос и аудита). */
function analyzePin(pin) {
  const s = String(pin || '');
  if (!s) return { bits: 0, score: 0, label: 'Нет PIN', level: 0, empty: true };
  if (!/^\d+$/.test(s)) return { bits: 0, score: 20, label: 'Не только цифры', level: 1, empty: false, weak: 'не только цифры' };
  const bits = Math.round(s.length * Math.log2(10) * 10) / 10;
  const weak = pinWeakness(s);
  if (weak) return { bits: Math.min(bits, 4), score: 10, label: `Предсказуемый: ${weak}`, level: 0, empty: false, weak };
  if (s.length < 4) return { bits, score: 25, label: 'Слишком короткий', level: 1, empty: false, weak: 'короче 4 цифр' };
  // для PIN шкала своя: 4 цифры — норма для карты, 6+ — хорошо
  const score = Math.min(100, 60 + (s.length - 4) * 12);
  const level = s.length >= 8 ? 4 : s.length >= 6 ? 3 : 2;
  const label = s.length >= 8 ? 'Отличный PIN' : s.length >= 6 ? 'Хороший PIN' : 'Нормальный PIN';
  return { bits, score, label, level, empty: false };
}

/** Оценка секрета записи с учётом типа. */
function strengthOf(entry) {
  return entry && entry.type === 'pin' ? analyzePin(entry.password) : analyzePassword(entry ? entry.password : '');
}

module.exports = { generatePin, analyzePin, pinWeakness, strengthOf };
