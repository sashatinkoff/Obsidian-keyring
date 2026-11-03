'use strict';
/*
 * Конвертация открытых данных в зашифрованные: рекурсивный обход папки,
 * заметки → записи (с распознаванием логинов/паролей или текстом целиком),
 * прочие файлы (PDF, сканы, изображения…) → записи-вложения.
 * Каждая запись после сохранения проверяется обратной расшифровкой,
 * и только потом (по желанию) удаляется исходник.
 */
const { HEADER_FILE, ENTRY_EXT, MAX_FILE_MB } = require('../constants');
const { toBase64, fromBase64 } = require('../crypto/codec');
const { parseNote, toEntry } = require('./importer');
const { splitFrontmatter, tagsFromProps } = require('../util/frontmatter');
const { newEntry } = require('./entry');
const {
  relativeTo, dirname, basename, joinPath,
} = require('../util/format');

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

function mimeOf(ext) {
  return MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function isHidden(path) {
  return path.split('/').some((p) => p.startsWith('.'));
}

/**
 * Рекурсивный обход папки. folder = '' — всё хранилище Obsidian.
 * targetFolder — папка хранилища, в которое конвертируем (её .kr пропускаются).
 */
async function scanFolder(core, folder, opts = {}) {
  const app = core.app;
  const prefix = folder ? `${folder}/` : '';
  const vaultFolders = core.manager.list().map((v) => v.folder);
  const target = opts.targetFolder || null;
  const maxBytes = MAX_FILE_MB * 1024 * 1024;
  const notes = [];
  const files = [];
  const skipped = [];
  const folders = new Set();

  const all = app.vault.getFiles()
    .filter((f) => (!folder || f.path.startsWith(prefix)) && !isHidden(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'ru'));

  for (const f of all) {
    if (f.name === HEADER_FILE || f.name === 'keyring.vault.backup.json' || f.extension === ENTRY_EXT) continue;
    const foreign = vaultFolders.find((v) => v !== target && (f.path.startsWith(`${v}/`)));
    if (foreign) {
      skipped.push({ file: f, reason: `внутри другого хранилища «${foreign}»` });
      continue;
    }
    const rel = relativeTo(folder, dirname(f.path));
    if (rel) folders.add(rel);
    if (f.extension === 'md') {
      const text = await app.vault.cachedRead(f);
      notes.push({
        kind: 'note', file: f, rel, text, parsed: parseNote(text, f.basename), selected: true,
      });
    } else {
      const size = f.stat ? f.stat.size : 0;
      if (size > maxBytes) {
        skipped.push({ file: f, reason: `больше ${MAX_FILE_MB} МБ (${formatSize(size)})` });
        continue;
      }
      files.push({
        kind: 'file', file: f, rel, size, selected: true,
      });
    }
  }
  return {
    notes, files, skipped, folders: Array.from(folders).sort(),
  };
}

function noteToEntry(item, mode, category) {
  if (mode === 'parse') {
    const e = toEntry(item, category);
    e.origin = item.file.path;
    return e;
  }
  const e = newEntry('note', category);
  Object.assign(e, {
    title: item.file.basename,
    notes: item.text,
    tags: tagsFromProps(splitFrontmatter(item.text).props),
    created: item.file.stat ? item.file.stat.ctime : Date.now(),
    updated: Date.now(),
    origin: item.file.path,
  });
  return e;
}

async function fileToEntry(app, item, category) {
  const buf = await app.vault.readBinary(item.file);
  const e = newEntry('file', category);
  Object.assign(e, {
    title: item.file.name,
    file: {
      name: item.file.name,
      mime: mimeOf(item.file.extension),
      size: buf.byteLength,
      data: toBase64(new Uint8Array(buf)),
    },
    created: item.file.stat ? item.file.stat.ctime : Date.now(),
    updated: Date.now(),
    origin: item.file.path,
  });
  return e;
}

function sameContent(a, b) {
  if (a.type === 'file') return !!(a.file && b.file && a.file.data === b.file.data && a.file.size === b.file.size);
  return a.notes === b.notes && a.password === b.password && a.username === b.username;
}

/**
 * items — выбранные элементы из scanFolder.
 * opts: { mode: 'parse'|'whole', deleteOriginals, categoryBase, onProgress }
 */
async function convertItems(core, vault, items, opts) {
  const app = core.app;
  const result = { converted: 0, deleted: 0, failed: [] };
  let i = 0;
  for (const item of items) {
    i++;
    if (opts.onProgress) opts.onProgress(i, items.length, item.file.path);
    try {
      const category = [opts.categoryBase, item.rel].filter(Boolean).join('/');
      const entry = item.kind === 'note'
        ? noteToEntry(item, opts.mode, category)
        : await fileToEntry(app, item, category);
      const saved = await vault.save(entry);
      const check = await vault.readEntryFile(saved.path);
      if (!sameContent(saved, check)) throw new Error('проверка расшифровки не прошла');
      result.converted++;
      if (opts.deleteOriginals) {
        await app.vault.delete(item.file);
        result.deleted++;
      }
    } catch (e) {
      result.failed.push(`${item.file.path}: ${e.message}`);
    }
  }
  await vault.reload();
  return result;
}

/* ---------- обратная расшифровка в обычный файл ---------- */

function entryToMarkdown(entry) {
  if (entry.type === 'note' && !entry.username && !entry.password && !entry.url) return entry.notes;
  // свойства заметки должны остаться в начале файла
  const fm = splitFrontmatter(entry.notes || '');
  const lines = fm.raw ? [fm.raw.replace(/\n$/, '')] : [];
  if (entry.username) lines.push(`Логин: ${entry.username}`);
  if (entry.password) lines.push(`Пароль: ${entry.password}`);
  if (entry.url) lines.push(`Сайт: ${entry.url}`);
  if (entry.totp) lines.push(`2FA: ${entry.totp}`);
  for (const f of entry.fields) lines.push(`${f.label}: ${f.value}`);
  const rest = fm.raw ? fm.body.trim() : entry.notes;
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

async function freePath(app, path) {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(path))) return path;
  const dir = dirname(path);
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = joinPath(dir, `${stem} (расшифровано${n > 1 ? ` ${n}` : ''})${ext}`);
    if (!(await adapter.exists(candidate))) return candidate;
  }
  throw new Error('не удалось подобрать имя файла');
}

/** Записывает открытую копию записи в хранилище Obsidian. Возвращает путь. */
async function decryptToVault(app, vault, entry) {
  let path = entry.origin;
  if (!path) {
    const dir = joinPath(vault.folder, entry.category);
    path = entry.type === 'file' && entry.file
      ? joinPath(dir, entry.file.name)
      : joinPath(dir, `${entry.title.replace(/[\\/:*?"<>|#^[\]]/g, '_')}.md`);
  }
  path = await freePath(app, path);
  const dir = dirname(path);
  if (dir && !(await app.vault.adapter.exists(dir))) await app.vault.createFolder(dir);
  if (entry.type === 'file' && entry.file) {
    const bytes = fromBase64(entry.file.data);
    await app.vault.createBinary(path, bytes.buffer);
  } else {
    await app.vault.create(path, entryToMarkdown(entry));
  }
  return path;
}

function fileBlob(entry) {
  const bytes = fromBase64(entry.file.data);
  return new Blob([bytes], { type: entry.file.mime });
}

module.exports = {
  scanFolder, convertItems, decryptToVault, fileBlob, formatSize, mimeOf, freePath,
};
