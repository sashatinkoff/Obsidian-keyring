'use strict';
/*
 * Экспорт и импорт записей хранилища.
 *   JSON — полная копия (все поля, история, вложения), обратимо импортируется.
 *   CSV  — таблица для Excel / других менеджеров паролей; импорт понимает
 *          выгрузки Chrome, Bitwarden, 1Password, KeePass, LastPass и Keyring.
 *   MD   — один общий файл или заметка на запись; служебные метки в HTML-комментариях
 *          (не видны в режиме чтения) позволяют импортировать обратно без потерь.
 * Внимание: все форматы экспорта — НЕзашифрованные.
 */
const { normalizeEntry, serializeEntry } = require('./entry');
const { fromBase64 } = require('../crypto/codec');
const { randomId } = require('../crypto/codec');
const { splitFrontmatter, tagsFromProps } = require('../util/frontmatter');
const { parseNote } = require('./importer');

const EXPORT_FORMAT = 'keyring-export';
const TYPE_LABELS = {
  login: 'Логин', secret: 'Секрет', pin: 'PIN-код', note: 'Заметка', file: 'Файл',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/* ---------------- JSON ---------------- */

function toJson(vault, entries, { attachments = true } = {}) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    vault: vault.name,
    exported: Date.now(),
    warning: 'Файл НЕ зашифрован: здесь все пароли открытым текстом. Удалите его после использования.',
    entries: entries.map((e) => {
      const out = Object.assign(serializeEntry(e), { category: e.category || '' });
      delete out.orphan;
      if (!attachments && out.file) out.file = Object.assign({}, out.file, { data: undefined, omitted: true });
      return out;
    }),
  }, null, 2);
}

/* ---------------- CSV ---------------- */

const CSV_COLUMNS = ['title', 'username', 'password', 'url', 'totp', 'notes', 'tags', 'folder', 'type', 'fields', 'favorite', 'created', 'updated'];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r;]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(entries) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const e of entries) {
    rows.push([
      e.title, e.username, e.password, e.url, e.totp, e.notes,
      (e.tags || []).join(', '),
      e.category || '',
      e.type,
      (e.fields || []).map((f) => `${f.label}: ${f.value}`).join('\n'),
      e.favorite ? '1' : '',
      isoDate(e.created),
      isoDate(e.updated),
    ].map(csvCell).join(','));
  }
  // BOM — чтобы Excel правильно показал кириллицу
  return `﻿${rows.join('\r\n')}\r\n`;
}

/** Разбор CSV (RFC 4180): кавычки, переносы внутри ячеек, разделитель , ; или таб. */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// колонки других менеджеров паролей → поле записи
const COLUMN_ALIASES = {
  title: ['title', 'name', 'название', 'заголовок', 'account', 'сервис', 'entry'],
  username: ['username', 'login', 'login_username', 'user', 'user name', 'логин', 'пользователь', 'email', 'e-mail'],
  password: ['password', 'login_password', 'pass', 'пароль'],
  url: ['url', 'uri', 'login_uri', 'website', 'web site', 'site', 'сайт', 'ссылка', 'адрес'],
  totp: ['totp', 'otp', 'login_totp', 'otpauth', 'one-time password', '2fa', 'otp secret'],
  notes: ['notes', 'note', 'extra', 'comments', 'comment', 'заметки', 'заметка', 'примечание', 'описание'],
  tags: ['tags', 'tag', 'теги', 'labels'],
  folder: ['folder', 'category', 'group', 'grouping', 'папка', 'категория', 'группа', 'vault'],
  type: ['type', 'тип'],
  fields: ['fields', 'custom fields', 'поля'],
  favorite: ['favorite', 'favourite', 'fav', 'избранное'],
  archived: ['archived', 'архив'],
  created: ['created', 'создано', 'creation time'],
  updated: ['updated', 'modified', 'изменено', 'last modified', 'last modification time'],
};

function mapColumns(header) {
  const map = {};
  header.forEach((h, i) => {
    const k = String(h).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] === undefined && aliases.includes(k)) map[field] = i;
    }
  });
  return map;
}

function parseDate(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return Number(s.length === 10 ? `${s}000` : s);
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

function guessType(raw, has) {
  const t = String(raw || '').toLowerCase();
  if (/^(login|логин|1)$/.test(t)) return 'login';
  if (/^(note|securenote|secure note|заметка|2)$/.test(t)) return 'note';
  if (/^(secret|секрет)$/.test(t)) return 'secret';
  if (/^(pin|пин|pin-код|пин-код)$/.test(t)) return 'pin';
  return has.username || has.password ? 'login' : 'note';
}

function fromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('В CSV нет строк с данными');
  const map = mapColumns(rows[0]);
  if (map.password === undefined && map.username === undefined && map.title === undefined && map.url === undefined) {
    throw new Error('Не удалось сопоставить колонки CSV: нужны хотя бы name/title, login/username, password или url');
  }
  const get = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] || ''));
  const known = new Set(Object.values(map));
  return rows.slice(1).map((r) => {
    const fields = get(r, 'fields').split('\n').map((line) => {
      const m = line.match(/^([^:]{1,64}):\s?(.*)$/);
      return m ? { label: m[1].trim(), value: m[2] } : null;
    }).filter(Boolean);
    // незнакомые колонки — в дополнительные поля, ничего не теряем
    rows[0].forEach((h, i) => {
      if (!known.has(i) && r[i] && String(r[i]).trim()) fields.push({ label: String(h).trim() || `Колонка ${i + 1}`, value: String(r[i]) });
    });
    const url = get(r, 'url');
    const has = { username: get(r, 'username'), password: get(r, 'password') };
    return {
      type: guessType(get(r, 'type'), has),
      title: get(r, 'title') || (url ? url.replace(/^https?:\/\//, '').split('/')[0] : '') || get(r, 'username') || 'Без названия',
      username: has.username,
      password: has.password,
      url,
      totp: get(r, 'totp'),
      notes: get(r, 'notes'),
      tags: get(r, 'tags').split(/[,;]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
        .concat(/^(1|true|yes|да)$/i.test(get(r, 'archived').trim()) ? ['архив'] : []),
      category: get(r, 'folder').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/^(Root|Корень)(\/|$)/i, ''),
      fields,
      favorite: /^(1|true|yes|да|\*)$/i.test(get(r, 'favorite').trim()),
      created: parseDate(get(r, 'created')),
      updated: parseDate(get(r, 'updated')),
    };
  });
}

/* ---------------- импорт: общий разбор ---------------- */

/** Bitwarden JSON → наш вид. */
function fromBitwarden(obj) {
  const folders = new Map((obj.folders || []).map((f) => [f.id, f.name]));
  return (obj.items || []).map((it) => {
    const login = it.login || {};
    return {
      type: it.type === 2 ? 'note' : 'login',
      title: it.name,
      username: login.username || '',
      password: login.password || '',
      url: (login.uris && login.uris[0] && login.uris[0].uri) || '',
      totp: login.totp || '',
      notes: it.notes || '',
      favorite: !!it.favorite,
      category: folders.get(it.folderId) || '',
      fields: (it.fields || []).map((f) => ({ label: f.name, value: f.value || '', hidden: f.type === 1 })),
      created: parseDate(it.creationDate),
      updated: parseDate(it.revisionDate),
    };
  });
}

/**
 * Разобрать файл импорта. Возвращает { format, entries:[черновики записей] }.
 * Понимает: экспорт Keyring (JSON), Bitwarden JSON, массив объектов, CSV.
 */
function parseImport(text, name = '') {
  const raw = String(text || '').replace(/^﻿/, '').trim();
  if (!raw) throw new Error('Файл пустой');
  const looksJson = /^[[{]/.test(raw) || /\.json$/i.test(name);
  if (looksJson) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Не удалось прочитать JSON: ${e.message}`);
    }
    if (obj && obj.format === EXPORT_FORMAT && Array.isArray(obj.entries)) return { format: 'Keyring JSON', entries: obj.entries };
    if (obj && Array.isArray(obj.items)) return { format: 'Bitwarden JSON', entries: fromBitwarden(obj) };
    if (Array.isArray(obj)) return { format: 'JSON', entries: obj };
    if (obj && Array.isArray(obj.entries)) return { format: 'JSON', entries: obj.entries };
    throw new Error('В JSON не найден список записей');
  }
  if (/\.(md|markdown|txt)$/i.test(name) || /^---\n|^# |<!-- keyring:/m.test(raw)) return fromMarkdown(raw, name);
  return { format: 'CSV', entries: fromCsv(raw) };
}

function dupKey(e) {
  return [e.title, e.username, e.url].map((v) => String(v || '').trim().toLowerCase()).join('\u0001');
}

/**
 * Подготовить записи к сохранению.
 * opts.duplicates: 'skip' | 'update' | 'keep'; opts.folder — общая папка-префикс.
 */
function planImport(vault, drafts, opts = {}) {
  const byId = new Map(Array.from(vault.entries.values()).map((e) => [e.id, e]));
  const byKey = new Map(Array.from(vault.entries.values()).map((e) => [dupKey(e), e]));
  const plan = { add: [], update: [], skip: [] };
  for (const d of drafts) {
    if (!d || typeof d !== 'object') continue;
    const existing = (d.id && byId.get(d.id)) || byKey.get(dupKey(d));
    const category = [opts.folder, d.category].filter(Boolean).join('/').replace(/\/+/g, '/');
    if (existing && opts.duplicates !== 'keep') {
      if (opts.duplicates === 'update') {
        const merged = normalizeEntry(Object.assign({}, existing, d, { id: existing.id, updated: Date.now() }), existing.id);
        merged.category = opts.folder ? category : (d.category !== undefined ? d.category : existing.category);
        merged.path = existing.path;
        plan.update.push(merged);
      } else plan.skip.push(d);
      continue;
    }
    const id = d.id && !byId.has(d.id) ? d.id : randomId();
    const e = normalizeEntry(Object.assign({}, d, { id }), id);
    e.category = category;
    if (e.file && !e.file.data) e.file = null; // вложение не было выгружено
    plan.add.push(e);
  }
  return plan;
}

/* ---------------- Markdown ---------------- */

const NOTES_OPEN = '<!-- keyring:notes -->';
const NOTES_CLOSE = '<!-- /keyring:notes -->';
const ENTRY_MARK = '<!-- keyring:entry -->';
const META_RE = /<!-- keyring:meta (\{.*?\}) -->/;
const KNOWN_ROWS = {
  Логин: 'username', Пароль: 'password', Сайт: 'url', '2FA': 'totp', PIN: 'password', 'Карта / устройство': 'username', 'Ключ ID': 'username', Секрет: 'password',
};
const ROW_LABELS = {
  login: ['Логин', 'Пароль'], secret: ['Ключ ID', 'Секрет'], pin: ['Карта / устройство', 'PIN'],
};

function safeName(s) {
  return String(s || 'Без названия').replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Без названия';
}

/** Значение в `код`; многострочное — JSON-строкой, чтобы не потерять переносы. */
function code(v) {
  let s = String(v);
  if (/[\r\n]/.test(s)) s = `json:${JSON.stringify(s)}`;
  const ticks = s.includes('`') ? '``' : '`';
  return `${ticks}${ticks === '``' ? ' ' : ''}${s}${ticks === '``' ? ' ' : ''}${ticks}`;
}

function uncode(v) {
  let s = String(v).trim();
  let m = s.match(/^``\s?([\s\S]*?)\s?``$/) || s.match(/^`([\s\S]*)`$/);
  if (m) s = m[1];
  else {
    m = s.match(/^<(.+)>$/);
    if (m) s = m[1];
  }
  if (/^json:"/.test(s)) {
    try {
      return JSON.parse(s.slice(5));
    } catch (e) { /* как есть */ }
  }
  return s === '—' ? '' : s;
}

function yamlStr(v) {
  return JSON.stringify(String(v));
}

/** Тело записи: поля, вложение, заметки, история (общее для обоих видов .md). */
function bodyMarkdown(e, attachmentName) {
  const out = [];
  out.push(`> [!info] ${TYPE_LABELS[e.type] || 'Запись'}${e.category ? ` · ${e.category}` : ''}`, '');
  const rows = [];
  const [userLabel, secretLabel] = ROW_LABELS[e.type] || ROW_LABELS.login;
  if (e.username) rows.push([userLabel, code(e.username)]);
  if (e.password) rows.push([secretLabel, code(e.password)]);
  if (e.url) rows.push(['Сайт', `<${e.url}>`]);
  if (e.totp) rows.push(['2FA', code(e.totp)]);
  for (const f of e.fields || []) rows.push([`${f.label || 'Поле'}${f.hidden ? ' 🔒' : ''}`, f.value ? code(f.value) : '—']);
  if (rows.length) {
    for (const [k, v] of rows) out.push(`- **${k}:** ${v}`);
    out.push('');
  }
  if (attachmentName) out.push('**Вложение:** ', `![[${attachmentName}]]`, '');
  if (e.notes && e.notes.trim()) out.push(NOTES_OPEN, e.notes.trim(), NOTES_CLOSE, '');
  if (e.history && e.history.length) {
    out.push('**История паролей:**', '');
    for (const h of e.history) out.push(`- ${isoDate(h.changed || h.date)} — ${code(h.password)}`);
    out.push('');
  }
  return out;
}

/** Заметка на одну запись. attachmentName — имя сохранённого рядом файла. */
function toMarkdown(e, attachmentName) {
  const fm = ['---'];
  if (e.tags && e.tags.length) {
    fm.push('tags:');
    for (const t of e.tags) fm.push(`  - ${yamlStr(t)}`);
  }
  fm.push(`keyring-id: ${e.id}`, `keyring-type: ${e.type}`);
  if (e.category) fm.push(`keyring-folder: ${yamlStr(e.category)}`);
  if (e.url) fm.push(`url: ${yamlStr(e.url)}`);
  if (e.favorite) fm.push('favorite: true');
  fm.push(`created: ${isoDate(e.created)}`, `updated: ${isoDate(e.updated)}`, '---', '');
  return [...fm, `# ${e.title}`, '', ...bodyMarkdown(e, attachmentName)].join('\n');
}

/** Все записи одним файлом .md: оглавление по папкам и запись за записью. */
function toSingleMarkdown(vault, entries) {
  const out = [
    `# Keyring — «${vault.name}»`, '',
    `> [!warning] Экспорт без шифрования · ${isoDate(Date.now())} · ${entries.length} зап.`,
    '> Здесь все пароли открытым текстом. Удалите файл после использования.', '',
  ];
  const sorted = entries.slice().sort((a, b) => (a.category || '').localeCompare(b.category || '', 'ru') || a.title.localeCompare(b.title, 'ru'));
  let cat = null;
  for (const e of sorted) {
    if ((e.category || '') !== cat) {
      cat = e.category || '';
      out.push(`## 📁 ${cat || 'Без папки'}`, '');
    }
    const meta = {
      id: e.id, type: e.type, folder: e.category || '', tags: e.tags || [], favorite: !!e.favorite, created: e.created, updated: e.updated,
    };
    out.push(ENTRY_MARK, `### ${e.title}`, `<!-- keyring:meta ${JSON.stringify(meta)} -->`, '');
    if (e.tags && e.tags.length) out.push(e.tags.map((t) => `#${String(t).replace(/\s+/g, '_')}`).join(' '), '');
    out.push(...bodyMarkdown(e, null));
    if (e.file) out.push(`*Вложение «${e.file.name}» в этот файл не входит — используйте JSON или «заметку на запись».*`, '');
  }
  return out.join('\n');
}

/** Разбор тела записи (после заголовка). */
function parseBody(lines) {
  const d = { fields: [], history: [], notes: '' };
  let i = 0;
  let inNotes = false;
  const notes = [];
  let inHistory = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (inNotes) {
      if (line.trim() === NOTES_CLOSE) inNotes = false;
      else notes.push(line);
      continue;
    }
    if (line.trim() === NOTES_OPEN) {
      inNotes = true;
      continue;
    }
    if (/^\*\*История паролей:\*\*/.test(line.trim())) {
      inHistory = true;
      continue;
    }
    const row = line.match(/^- \*\*(.+?):\*\* (.*)$/);
    if (row && !inHistory) {
      const label = row[1].replace(/\s*🔒$/, '');
      const value = uncode(row[2]);
      const kind = KNOWN_ROWS[label];
      if (kind && !d[kind]) d[kind] = value;
      else d.fields.push({ label, value, hidden: /🔒$/.test(row[1]) });
      continue;
    }
    const hist = line.match(/^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.+)$/);
    if (hist && inHistory) {
      d.history.push({ password: uncode(hist[2]), changed: parseDate(hist[1]) });
      continue;
    }
    const att = line.match(/^!\[\[(.+?)\]\]$/);
    if (att) d.attachmentName = att[1];
  }
  d.notes = notes.join('\n').trim();
  return d;
}

/** Обычная заметка (не экспорт Keyring): логин/пароль из текста, теги из свойств. */
function foreignNote(text, title) {
  const fm = splitFrontmatter(text);
  let body = fm.body.replace(/^\s+/, '');
  const h1 = body.match(/^# (.+)\n?/);
  if (h1) {
    title = h1[1].trim();
    body = body.slice(h1[0].length);
  }
  const p = parseNote(body, title);
  return {
    type: p.password ? 'login' : 'note',
    title: p.title || title,
    username: p.username,
    password: p.password,
    url: p.url,
    totp: p.totp,
    tags: tagsFromProps(fm.props),
    notes: p.notes,
  };
}

/** Одна заметка: экспорт Keyring «заметка на запись» или обычная заметка. */
function fromNote(text, fileName) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const fm = splitFrontmatter(src);
  const fallbackTitle = String(fileName || 'Без названия').replace(/\.md$/i, '').split('/').pop();
  if (!fm.props['keyring-id'] && !fm.props['keyring-type']) return foreignNote(src, fallbackTitle);
  const lines = fm.body.split('\n');
  const h = lines.findIndex((l) => /^# /.test(l));
  const title = h >= 0 ? lines[h].slice(2).trim() : fallbackTitle;
  const body = parseBody(h >= 0 ? lines.slice(h + 1) : lines);
  const props = fm.props;
  return Object.assign(body, {
    id: props['keyring-id'] || undefined,
    type: props['keyring-type'] || 'login',
    title,
    category: props['keyring-folder'] || '',
    tags: tagsFromProps(props),
    favorite: String(props.favorite) === 'true',
    created: parseDate(props.created),
    updated: parseDate(props.updated),
  });
}

/** Общий файл .md (экспорт Keyring): записи между метками keyring:entry. */
function fromSingleMarkdown(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(ENTRY_MARK).slice(1);
  return blocks.map((block) => {
    const lines = block.split('\n');
    // хвост блока: заголовок следующей папки относится уже к следующим записям
    while (lines.length && (/^## 📁 /.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();
    const h = lines.findIndex((l) => /^### /.test(l));
    const title = h >= 0 ? lines[h].slice(4).trim() : 'Без названия';
    let meta = {};
    const mi = lines.findIndex((l) => META_RE.test(l));
    if (mi >= 0) {
      try {
        meta = JSON.parse(lines[mi].match(META_RE)[1]);
      } catch (e) { /* без метаданных */ }
    }
    const rest = lines.slice(Math.max(h, mi) + 1).filter((l) => !/^\*Вложение «/.test(l));
    // строка хэштегов сразу после метаданных — это теги, а не заметка
    const firstText = rest.findIndex((l) => l.trim());
    if (firstText >= 0 && /^(#[^\s#]+\s*)+$/.test(rest[firstText].trim())) rest.splice(firstText, 1);
    return Object.assign(parseBody(rest), {
      id: meta.id, type: meta.type || 'login', title, category: meta.folder || '', tags: meta.tags || [],
      favorite: !!meta.favorite, created: meta.created || 0, updated: meta.updated || 0,
    });
  });
}

/** Markdown любого вида → черновики записей. */
function fromMarkdown(text, name) {
  if (String(text).includes(ENTRY_MARK)) return { format: 'Markdown (один файл)', entries: fromSingleMarkdown(text) };
  return { format: 'Markdown', entries: [fromNote(text, name)] };
}

/** Записать по заметке на запись в папку Obsidian (подпапки = категории). */
async function exportMarkdown(app, entries, folder, freePath) {
  const adapter = app.vault.adapter;
  const ensure = async (dir) => {
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await app.vault.createFolder(cur);
    }
  };
  await ensure(folder);
  let n = 0;
  for (const e of entries) {
    const dir = [folder, ...(e.category ? e.category.split('/').map(safeName) : [])].join('/');
    await ensure(dir);
    let attachment = null;
    if (e.file && e.file.data) {
      const fpath = await freePath(app, `${dir}/${safeName(e.file.name)}`);
      await app.vault.createBinary(fpath, fromBase64(e.file.data).buffer);
      attachment = fpath.split('/').pop();
    }
    const path = await freePath(app, `${dir}/${safeName(e.title)}.md`);
    await app.vault.create(path, toMarkdown(e, attachment));
    n++;
  }
  return n;
}

/** Импорт заметок из папки Obsidian (рекурсивно); вложения ![[…]] подхватываются из той же папки. */
async function readMarkdownFolder(app, folder, toBase64) {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const files = app.vault.getFiles().filter((f) => f.extension === 'md' && (!prefix || f.path.startsWith(prefix)));
  const out = [];
  for (const f of files) {
    const text = await app.vault.cachedRead(f);
    const items = fromMarkdown(text, f.path).entries;
    const rel = (f.parent ? f.parent.path : '').slice(prefix.length).replace(/^\/+/, '');
    for (const d of items) {
      if (!d.category && rel) d.category = rel;
      if (d.attachmentName) {
        const dir = f.parent ? f.parent.path : '';
        const att = app.vault.getFiles().find((x) => x.path === (dir ? `${dir}/${d.attachmentName}` : d.attachmentName))
          || app.vault.getFiles().find((x) => x.name === d.attachmentName);
        if (att) {
          const buf = await app.vault.readBinary(att);
          d.type = d.type || 'file';
          d.file = { name: att.name, mime: '', size: att.stat ? att.stat.size : buf.byteLength, data: toBase64(new Uint8Array(buf)) };
        }
      }
      delete d.attachmentName;
      out.push(d);
    }
  }
  return out;
}

module.exports = {
  toJson, toCsv, parseCsv, fromCsv, parseImport, planImport, toMarkdown, toSingleMarkdown, fromMarkdown,
  exportMarkdown, readMarkdownFolder, stamp, safeName, EXPORT_FORMAT,
};
