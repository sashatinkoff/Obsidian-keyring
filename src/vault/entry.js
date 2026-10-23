'use strict';
/* Модель записи: нормализация, сериализация, поиск. */
const { randomId } = require('../crypto/codec');

const TRANSIENT = new Set(['category', 'path', 'rev']);

function normalizeEntry(d, id) {
  const now = Date.now();
  const fields = Array.isArray(d.fields) ? d.fields : [];
  return {
    id: id || d.id || randomId(),
    type: ['login', 'secret', 'note', 'file'].includes(d.type) ? d.type : 'login',
    title: String(d.title || 'Без названия'),
    url: String(d.url || ''),
    username: String(d.username || ''),
    password: String(d.password || ''),
    totp: String(d.totp || ''),
    tags: Array.isArray(d.tags) ? d.tags.map(String).filter(Boolean) : [],
    notes: String(d.notes || ''),
    fields: fields
      .filter((f) => f && (f.label || f.value))
      .map((f) => ({ label: String(f.label || ''), value: String(f.value || ''), hidden: !!f.hidden })),
    history: Array.isArray(d.history) ? d.history.filter((h) => h && h.password) : [],
    favorite: !!d.favorite,
    file: d.file && typeof d.file.data === 'string' ? {
      name: String(d.file.name || 'file'),
      mime: String(d.file.mime || 'application/octet-stream'),
      size: Number(d.file.size) || 0,
      data: d.file.data,
    } : null,
    origin: String(d.origin || ''),
    suggestDismissed: !!d.suggestDismissed,
    created: Number(d.created) || now,
    updated: Number(d.updated) || Number(d.created) || now,
    passwordChanged: Number(d.passwordChanged) || Number(d.created) || now,
    category: d.category || '',
    path: d.path || '',
    rev: d.rev || '',
  };
}

function serializeEntry(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!TRANSIENT.has(k)) out[k] = v;
  }
  return out;
}

function newEntry(type = 'login', category = '') {
  const now = Date.now();
  const e = normalizeEntry({ type, created: now, updated: now, category }, randomId());
  e.title = '';
  return e;
}

function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

function haystack(entry) {
  return [
    entry.title,
    entry.username,
    entry.url,
    entry.category,
    entry.notes,
    entry.tags.join(' '),
    entry.file ? entry.file.name : '',
    entry.fields.map((f) => (f.hidden ? f.label : `${f.label} ${f.value}`)).join(' '),
  ].join('\n').toLowerCase();
}

function matchesQuery(entry, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = haystack(entry);
  return q.split(/\s+/).every((t) => hay.includes(t.replace(/^#/, '')));
}

module.exports = { normalizeEntry, serializeEntry, newEntry, cloneEntry, matchesQuery };
