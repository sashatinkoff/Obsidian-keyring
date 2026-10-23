'use strict';
/* Форматирование дат, чисел, путей и мелкие текстовые утилиты. */
const { normalizePath } = require('obsidian');

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function countLabel(n, forms) {
  return `${n} ${plural(n, forms)}`;
}

const pad = (n) => String(n).padStart(2, '0');

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatRelative(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = startOfDay(Date.now());
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ts >= today) return `Сегодня, ${time}`;
  if (ts >= today - 86400000) return `Вчера, ${time}`;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function recencyBucket(ts) {
  const today = startOfDay(Date.now());
  if (ts >= today) return 'Сегодня';
  if (ts >= today - 86400000) return 'Вчера';
  if (ts >= today - 6 * 86400000) return 'На этой неделе';
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function formatNumber(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function hostOf(url) {
  if (!url) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    return (u.host + (u.pathname !== '/' ? u.pathname : '')).replace(/^www\./, '').replace(/\/$/, '');
  } catch (e) {
    return url;
  }
}

function hrefOf(url) {
  if (!url) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

/** Стабильный оттенок для монограммы по строке. */
function hueOf(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function initialOf(title) {
  const ch = Array.from(String(title || '?').trim())[0] || '?';
  return ch.toUpperCase();
}

function joinPath(...parts) {
  const p = parts.filter((x) => x !== undefined && x !== null && x !== '' && x !== '/').join('/');
  return normalizePath(p || '/');
}

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function basename(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function relativeTo(base, path) {
  if (!base) return path;
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function maskTail(value, keep = 4) {
  if (!value) return '';
  if (value.length <= keep + 4) return '•'.repeat(value.length);
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

module.exports = {
  plural,
  countLabel,
  formatDate,
  formatRelative,
  recencyBucket,
  formatCountdown,
  formatNumber,
  hostOf,
  hrefOf,
  hueOf,
  initialOf,
  joinPath,
  dirname,
  basename,
  relativeTo,
  maskTail,
};
