'use strict';
/*
 * Свойства заметки (YAML frontmatter между строками ---).
 * Из свойств берутся только теги. Логины и пароли ищутся исключительно в тексте заметки.
 */

const FM_RE = /^(?:﻿)?---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const TAG_KEYS = /^(tags|tag|теги|тег)$/i;

function unquote(v) {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/**
 * Разделить заметку на свойства и текст.
 * { raw, lines, props: {ключ: строка | массив}, body } — lines: сколько строк занимает блок.
 */
function splitFrontmatter(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const m = src.match(FM_RE);
  if (!m) return { raw: '', lines: 0, props: {}, body: src };
  const props = {};
  let current = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([^\s#:][^:]*):(?:\s+(.*))?\s*$/);
    if (kv) {
      current = kv[1].trim();
      const v = (kv[2] || '').trim();
      if (!v) props[current] = [];
      else if (/^\[.*\]$/.test(v)) props[current] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
      else props[current] = unquote(v);
      continue;
    }
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && current && Array.isArray(props[current])) {
      const v = unquote(item[1]);
      if (v) props[current].push(v);
    }
  }
  return {
    raw: m[0], lines: m[0].replace(/\n$/, '').split('\n').length, props, body: src.slice(m[0].length),
  };
}

/** Теги из свойств: списком, через запятую или пробел, с «#» или без. */
function tagsFromProps(props) {
  const out = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (!TAG_KEYS.test(k)) continue;
    const list = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
    for (const t of list) {
      const tag = String(t).trim().replace(/^#/, '');
      if (tag && !out.includes(tag)) out.push(tag);
    }
  }
  return out;
}

module.exports = { splitFrontmatter, tagsFromProps };
