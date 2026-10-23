'use strict';
/* Криптостойкий генератор паролей (crypto.getRandomValues, без смещения). */
const { randomInt } = require('./codec');

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
};
const SIMILAR = new Set('Il1O0o|'.split(''));

const SET_LABELS = {
  upper: 'A-Z',
  lower: 'a-z',
  digits: '0-9',
  symbols: '!@#$%^&*',
};

function pools(opts) {
  const out = [];
  for (const name of ['lower', 'upper', 'digits', 'symbols']) {
    if (!opts[name]) continue;
    let chars = SETS[name];
    if (opts.noSimilar) chars = chars.split('').filter((c) => !SIMILAR.has(c)).join('');
    out.push(chars);
  }
  if (!out.length) out.push(SETS.lower);
  return out;
}

function generatePassword(opts) {
  const length = Math.max(4, Math.min(128, Number(opts.length) || 20));
  const sets = pools(opts);
  const all = sets.join('');
  const chars = [];
  // по одному символу из каждого выбранного набора…
  for (const s of sets) {
    if (chars.length < length) chars.push(s[randomInt(s.length)]);
  }
  // …остальное — из объединения
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  // перемешивание Фишера — Йетса
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = chars[i];
    chars[i] = chars[j];
    chars[j] = t;
  }
  return chars.join('');
}

/** Теоретическая энтропия сгенерированного пароля, бит. */
function generatorEntropy(opts) {
  const size = pools(opts).join('').length;
  return Math.round((Number(opts.length) || 0) * Math.log2(size));
}

module.exports = { generatePassword, generatorEntropy, SET_LABELS };
