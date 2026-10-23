'use strict';
/*
 * Хранилище = папка в Obsidian:
 *   <папка>/keyring.vault.json      — заголовок (соль, параметры KDF, обёрнутый ключ)
 *   <папка>/<подпапка>/<id>.kr       — одна зашифрованная запись на файл
 * Подпапки = категории. Имена файлов случайные и ничего не раскрывают.
 * Один файл на запись — конфликт Syncthing затрагивает только одну запись.
 */
const {
  HEADER_FILE, ENTRY_EXT, FORMAT_VERSION,
} = require('../constants');
const {
  createVaultKeys, unlockVaultKey, rewrapVaultKey, validateHeader,
  addRecoveryToHeader, resetWithRecovery, openWithRecovery, openWithRecoveryAny, recoveryKeyId, resealWithDek,
  encryptJson, decryptJson, entryAad,
} = require('../crypto/cipher');
const { sha256Hex } = require('../crypto/codec');
const headerStore = require('./header-store');
const { normalizeEntry, serializeEntry } = require('./entry');
const {
  joinPath, dirname, basename, relativeTo,
} = require('../util/format');

const CONFLICT_RE = /\.sync-conflict-[^/]*$/;

function isEntryFile(path) {
  return path.endsWith(`.${ENTRY_EXT}`);
}

function isConflictFile(path) {
  return isEntryFile(path) && /\.sync-conflict-/.test(basename(path));
}

class Vault {
  constructor(app, folder, header) {
    this.app = app;
    this.adapter = app.vault.adapter;
    this.folder = folder;
    this.header = header;
    this.key = null;
    this.entries = new Map();
    this.conflicts = [];
    this.errors = [];
    this.folders = [];
    this.lastWrite = 0;
    this.fileCount = null;
  }

  get headerPath() {
    return joinPath(this.folder, HEADER_FILE);
  }

  get name() {
    return (this.header && this.header.name) || basename(this.folder) || 'Хранилище';
  }

  get unlocked() {
    return !!this.key;
  }

  get iterations() {
    return this.header && this.header.kdf ? this.header.kdf.iterations : 0;
  }

  static async read(app, folder) {
    const { header, source, restored } = await headerStore.loadHeader(app.vault.adapter, folder);
    const vault = new Vault(app, folder, header);
    if (restored) vault.restoredFrom = source;
    return vault;
  }

  static async create(app, folder, {
    name, password, iterations, recovery,
  }) {
    const adapter = app.vault.adapter;
    const headerPath = joinPath(folder, HEADER_FILE);
    if (await adapter.exists(headerPath) || await adapter.exists(joinPath(folder, headerStore.BACKUP_FILE))) {
      throw new Error('В этой папке уже есть хранилище Keyring');
    }
    if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    const { header, key } = await createVaultKeys(password, iterations, recovery);
    header.name = name || basename(folder);
    header.created = Date.now();
    const saved = await headerStore.writeHeader(adapter, folder, header);
    const vault = new Vault(app, folder, saved);
    vault.key = key;
    await vault.reload();
    return vault;
  }

  async refreshHeader() {
    const { header, source, restored } = await headerStore.loadHeader(this.adapter, this.folder);
    this.header = header;
    if (restored) this.restoredFrom = source;
  }

  async writeHeader(header) {
    this.lastWrite = Date.now();
    this.header = await headerStore.writeHeader(this.adapter, this.folder, header);
    return this.header;
  }

  async unlock(password) {
    await this.refreshHeader();
    this.key = await unlockVaultKey(this.header, password);
    await this.reload();
  }

  lock() {
    this.key = null;
    this.entries.clear();
    this.conflicts = [];
    this.errors = [];
  }

  async scan() {
    const files = [];
    const folders = [];
    const walk = async (dir) => {
      const listing = await this.adapter.list(dir);
      for (const f of listing.files) if (isEntryFile(f)) files.push(f);
      for (const sub of listing.folders) {
        if (basename(sub).startsWith('.')) continue;
        folders.push(relativeTo(this.folder, sub));
        await walk(sub);
      }
    };
    await walk(this.folder);
    return { files, folders };
  }

  /** Число записей без расшифровки — для экрана блокировки. */
  async countEntries() {
    try {
      const { files } = await this.scan();
      this.fileCount = files.filter((f) => !isConflictFile(f)).length;
    } catch (e) {
      this.fileCount = null;
    }
    return this.fileCount;
  }

  async readEntryFile(path) {
    const raw = await this.adapter.read(path);
    const env = JSON.parse(raw);
    if (!env || !env.id || !env.iv || !env.data) throw new Error('Неверный формат файла записи');
    const data = await decryptJson(this.key, env, entryAad(env.id));
    const entry = normalizeEntry(data, env.id);
    entry.category = relativeTo(this.folder, dirname(path));
    entry.path = path;
    entry.rev = (await sha256Hex(env.data)).slice(0, 16);
    return entry;
  }

  async reload() {
    if (!this.key) return;
    const { files, folders } = await this.scan();
    const entries = new Map();
    const conflicts = [];
    const errors = [];
    for (const path of files) {
      try {
        const entry = await this.readEntryFile(path);
        if (isConflictFile(path)) conflicts.push({ path, entry });
        else entries.set(entry.id, entry);
      } catch (e) {
        errors.push({ path, message: e.message });
      }
    }
    for (const c of conflicts) c.original = entries.get(c.entry.id) || null;
    this.entries = entries;
    this.conflicts = conflicts;
    this.errors = errors;
    this.folders = folders.filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
    this.fileCount = entries.size;
  }

  /** Категории (подпапки) с количеством записей. */
  categories() {
    const counts = new Map();
    for (const f of this.folders) counts.set(f, 0);
    for (const e of this.entries.values()) {
      counts.set(e.category, (counts.get(e.category) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([path, count]) => ({ path, count, name: path ? basename(path) : 'Без папки' }))
      .sort((a, b) => {
        if (!a.path) return 1;
        if (!b.path) return -1;
        return a.path.localeCompare(b.path, 'ru');
      });
  }

  async ensureFolder(rel) {
    const path = joinPath(this.folder, rel);
    if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    if (rel && !this.folders.includes(rel)) {
      this.folders.push(rel);
      this.folders.sort((a, b) => a.localeCompare(b, 'ru'));
    }
    return path;
  }

  async save(entry) {
    if (!this.key) throw new Error('Хранилище заблокировано');
    const data = serializeEntry(entry);
    data.version = FORMAT_VERSION;
    const env = await encryptJson(this.key, data, entryAad(entry.id));
    const dir = await this.ensureFolder(entry.category || '');
    const target = joinPath(dir, `${entry.id}.${ENTRY_EXT}`);
    const payload = JSON.stringify({ keyring: FORMAT_VERSION, id: entry.id, iv: env.iv, data: env.data });

    this.lastWrite = Date.now();
    await this.adapter.write(target, payload);
    const old = this.entries.get(entry.id);
    if (old && old.path && old.path !== target && (await this.adapter.exists(old.path))) {
      await this.adapter.remove(old.path);
    }
    const saved = Object.assign({}, entry, {
      path: target,
      rev: (await sha256Hex(env.data)).slice(0, 16),
    });
    this.entries.set(entry.id, saved);
    return saved;
  }

  async remove(entry) {
    const current = this.entries.get(entry.id) || entry;
    this.lastWrite = Date.now();
    if (current.path && (await this.adapter.exists(current.path))) {
      // запись зашифрована — можно отправить в корзину Obsidian без утечки
      if (typeof this.adapter.trashLocal === 'function') await this.adapter.trashLocal(current.path);
      else await this.adapter.remove(current.path);
    }
    this.entries.delete(entry.id);
  }

  /** keep: 'conflict' — взять версию из конфликтного файла, 'original' — оставить текущую. */
  async resolveConflict(conflict, keep) {
    this.lastWrite = Date.now();
    if (keep === 'conflict') {
      const entry = Object.assign({}, conflict.entry, {
        category: conflict.original ? conflict.original.category : conflict.entry.category,
        path: conflict.original ? conflict.original.path : '',
        updated: Date.now(),
      });
      await this.save(entry);
    }
    if (await this.adapter.exists(conflict.path)) await this.adapter.remove(conflict.path);
    this.conflicts = this.conflicts.filter((c) => c !== conflict);
  }

  async changePassword(oldPassword, newPassword, iterations) {
    await this.refreshHeader();
    const header = await rewrapVaultKey(this.header, oldPassword, newPassword, iterations);
    await this.writeHeader(header);
  }

  /* ---------- ключ восстановления ---------- */

  get recoveryIds() {
    return Array.isArray(this.header.recovery) ? this.header.recovery.map((w) => w.keyId) : [];
  }

  hasRecovery(keyId) {
    return keyId ? this.recoveryIds.includes(keyId) : this.recoveryIds.length > 0;
  }

  async addRecovery(password, recovery) {
    await this.refreshHeader();
    const header = await addRecoveryToHeader(this.header, password, recovery);
    await this.writeHeader(header);
  }

  async removeRecovery(keyId) {
    await this.refreshHeader();
    const list = (this.header.recovery || []).filter((w) => keyId && w.keyId !== keyId);
    const header = Object.assign({}, this.header, { recovery: list });
    await this.writeHeader(header);
  }

  /** Открытое хранилище: добавить ключи восстановления и убрать отозванные — без пароля. */
  async syncRecovery(add = [], removeIds = []) {
    if (!this.key) return false;
    const before = JSON.stringify(this.recoveryIds);
    const header = await resealWithDek(this.header, this.key, add, removeIds);
    if (JSON.stringify((header.recovery || []).map((w) => w.keyId)) === before) return false;
    await this.writeHeader(header);
    return true;
  }

  async removeRecoveryIds(ids) {
    await this.refreshHeader();
    const header = Object.assign({}, this.header, {
      recovery: (this.header.recovery || []).filter((w) => !ids.includes(w.keyId)),
    });
    await this.writeHeader(header);
  }

  /** Открыть ключом восстановления (мастер-пароль не меняется). */
  async unlockWithRecovery(privateJwk, { altHeaders = [], reseal = [] } = {}) {
    await this.refreshHeader();
    // ключ из запасного заголовка проверяем на записях этой папки
    const verify = async (key) => {
      const { files } = await this.scan();
      const sample = files.slice(0, 5);
      if (!sample.length) return false;
      for (const path of sample) {
        try {
          const env = JSON.parse(await this.adapter.read(path));
          await decryptJson(key, env, entryAad(env.id));
          return true;
        } catch (e) { /* следующий */ }
      }
      return false;
    };
    const res = await openWithRecoveryAny(this.header, privateJwk, { altHeaders, reseal, verify });
    if (res.header) await this.writeHeader(res.header);
    this.key = res.key;
    await this.reload();
    return { via: res.via, resealed: !!res.header };
  }

  /** Новый мастер-пароль по ключу восстановления; хранилище сразу открывается. */
  async recover(privateJwk, newPassword, iterations, altHeaders = []) {
    await this.refreshHeader();
    if (altHeaders.length && !this.hasRecovery(await recoveryKeyId(privateJwk))) {
      // сначала вернуть «печать» ключа в заголовок по копии из файла
      await this.unlockWithRecovery(privateJwk, { altHeaders });
    }
    const { header, key } = await resetWithRecovery(this.header, privateJwk, newPassword, iterations);
    await this.writeHeader(header);
    this.key = key;
    await this.reload();
  }

  async rename(name) {
    await this.refreshHeader();
    await this.writeHeader(Object.assign({}, this.header, { name }));
  }

  owns(path) {
    return path === this.headerPath || path === joinPath(this.folder, headerStore.BACKUP_FILE)
      || (path.startsWith(`${this.folder}/`) && isEntryFile(path));
  }
}

module.exports = { Vault, isEntryFile, isConflictFile, CONFLICT_RE };
