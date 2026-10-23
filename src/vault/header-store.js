'use strict';
/*
 * Надёжное хранение заголовка хранилища (keyring.vault.json).
 *
 * В заголовке лежит зашифрованный ключ данных — без него записи не открыть.
 * Секретов в нём нет (ключ данных зашифрован паролем / ключом восстановления),
 * поэтому копии можно держать где угодно. Keyring хранит три копии:
 *   1. <папка>/keyring.vault.json          — основной файл;
 *   2. <папка>/keyring.vault.backup.json   — резервная копия рядом;
 *   3. настройки плагина (data.json)        — копия вне папки хранилища.
 * При чтении: если основной файл пропал или повреждён — берётся самая свежая
 * исправная копия и основной файл восстанавливается автоматически.
 */
const { HEADER_FILE } = require('../constants');
const { validateHeader } = require('../crypto/cipher');
const { joinPath, basename } = require('../util/format');

const BACKUP_FILE = 'keyring.vault.backup.json';
const EXPORT_FORMAT = 'keyring-headers';

let core = null;

function attach(c) {
  core = c;
  if (!core.settings.headerBackups || typeof core.settings.headerBackups !== 'object') core.settings.headerBackups = {};
}

function isValid(h) {
  try {
    validateHeader(h);
    return true;
  } catch (e) {
    return false;
  }
}

async function readJson(adapter, path) {
  try {
    if (!(await adapter.exists(path))) return null;
    return JSON.parse(await adapter.read(path));
  } catch (e) {
    return null;
  }
}

let saveTimer = null;
function saveSettingsSoon() {
  if (!core) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => core.saveSettings(), 300);
}

/** Записать заголовок во все три места. */
async function writeHeader(adapter, folder, header) {
  const h = Object.assign({}, header, { savedAt: Date.now() });
  const json = JSON.stringify(h, null, 2);
  await adapter.write(joinPath(folder, HEADER_FILE), json);
  try {
    await adapter.write(joinPath(folder, BACKUP_FILE), json);
  } catch (e) {
    console.warn('Keyring: не удалось записать резервную копию заголовка', e);
  }
  if (core) {
    core.settings.headerBackups[folder] = h;
    saveSettingsSoon();
  }
  return h;
}

/** Есть ли в папке зашифрованные записи (*.kr) — иначе восстанавливать нечего. */
async function hasRecords(adapter, folder, depth = 0) {
  try {
    if (!(await adapter.exists(folder))) return false;
    const { files, folders } = await adapter.list(folder);
    if (files.some((f) => f.endsWith('.kr'))) return true;
    if (depth > 8) return false;
    for (const sub of folders) {
      if (await hasRecords(adapter, sub, depth + 1)) return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * Прочитать заголовок с автовосстановлением.
 * Возвращает { header, source: 'main' | 'backup' | 'settings', restored }.
 */
async function loadHeader(adapter, folder) {
  const main = await readJson(adapter, joinPath(folder, HEADER_FILE));
  if (isValid(main)) {
    // поддерживаем копии в актуальном состоянии
    const backup = await readJson(adapter, joinPath(folder, BACKUP_FILE));
    if (!isValid(backup) || JSON.stringify(backup) !== JSON.stringify(main)) {
      try {
        await adapter.write(joinPath(folder, BACKUP_FILE), JSON.stringify(main, null, 2));
      } catch (e) { /* ignore */ }
    }
    if (core && JSON.stringify(core.settings.headerBackups[folder]) !== JSON.stringify(main)) {
      core.settings.headerBackups[folder] = main;
      saveSettingsSoon();
    }
    return { header: main, source: 'main', restored: false };
  }

  // папку удалили (или в ней нет записей) — хранилище не воскрешаем
  const mainExists = await adapter.exists(joinPath(folder, HEADER_FILE)).catch(() => false);
  if (!mainExists && !(await hasRecords(adapter, folder))) {
    throw new Error('Заголовок хранилища не найден');
  }

  const candidates = [];
  const backup = await readJson(adapter, joinPath(folder, BACKUP_FILE));
  if (isValid(backup)) candidates.push({ header: backup, source: 'backup' });
  const stored = core && core.settings.headerBackups[folder];
  if (isValid(stored)) candidates.push({ header: stored, source: 'settings' });
  if (!candidates.length) {
    throw new Error(main ? 'Заголовок хранилища повреждён, резервных копий нет' : 'Заголовок хранилища не найден');
  }
  candidates.sort((a, b) => (b.header.savedAt || b.header.changed || 0) - (a.header.savedAt || a.header.changed || 0));
  const best = candidates[0];
  await writeHeader(adapter, folder, best.header);
  return { header: best.header, source: best.source, restored: true };
}

/** Папки, для которых есть хоть какая-то копия заголовка. */
function knownFolders(app) {
  const out = new Set();
  for (const f of app.vault.getFiles()) {
    if (f.name === HEADER_FILE || f.name === BACKUP_FILE) out.add(f.parent ? f.parent.path : '');
  }
  // копии из настроек — только для папок, где ещё лежат зашифрованные записи
  if (core) {
    const files = app.vault.getFiles();
    for (const folder of Object.keys(core.settings.headerBackups)) {
      if (files.some((f) => f.extension === 'kr' && f.path.startsWith(`${folder}/`))) out.add(folder);
    }
  }
  out.delete('');
  out.delete('/');
  return out;
}

/* ---------- экспорт / импорт копий заголовков ---------- */

function exportHeaders(vaults) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    created: Date.now(),
    note: 'Копии заголовков хранилищ Keyring. Секретов не содержат: без мастер-пароля или ключа восстановления бесполезны. Храните вместе с ключом восстановления.',
    vaults: vaults.map((v) => ({ folder: v.folder, name: v.name, header: v.header })),
  }, null, 2);
}

/** Из файла любого формата достаёт заголовки: экспорт, одиночный заголовок, резервную копию. */
function parseHeaders(text) {
  const raw = String(text || '').replace(/^﻿/, '').replace(/\u0000/g, '').trim();
  const found = [];
  const take = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.headers)) {
      // файл ключа восстановления с копиями заголовков
      for (const v of obj.headers) if (v && isValid(v.header)) found.push({ folder: v.folder, name: v.name || v.header.name, header: v.header });
    } else if (obj.format === EXPORT_FORMAT && Array.isArray(obj.vaults)) {
      for (const v of obj.vaults) if (isValid(v.header)) found.push({ folder: v.folder, name: v.name || v.header.name, header: v.header });
    } else if (isValid(obj)) {
      found.push({ folder: null, name: obj.name, header: obj });
    }
  };
  try {
    take(JSON.parse(raw));
  } catch (e) {
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        take(JSON.parse(raw.slice(a, b + 1)));
      } catch (e2) { /* ignore */ }
    }
  }
  if (!found.length) throw new Error('В файле не найдено ни одного заголовка хранилища Keyring');
  return found;
}

/** Восстановить заголовок в папку (из импортированного файла). */
async function restoreHeaderTo(adapter, folder, header) {
  if (!isValid(header)) throw new Error('Неверный заголовок');
  if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
  return writeHeader(adapter, folder, header);
}

/** Папки с зашифрованными записями, у которых нет ни заголовка, ни его копий. */
function orphanFolders(app, knownVaultFolders) {
  const known = new Set(knownVaultFolders);
  const roots = new Map();
  for (const f of app.vault.getFiles()) {
    if (f.extension !== 'kr') continue;
    if (Array.from(known).some((k) => f.path.startsWith(`${k}/`))) continue;
    const top = f.path.split('/')[0];
    if (!top || top === f.path) continue;
    roots.set(top, (roots.get(top) || 0) + 1);
  }
  return Array.from(roots.entries()).map(([folder, count]) => ({ folder, count, name: basename(folder) }));
}

module.exports = {
  BACKUP_FILE, attach, restoreHeaderTo, writeHeader, loadHeader, knownFolders, exportHeaders, parseHeaders, orphanFolders, isValid,
};
