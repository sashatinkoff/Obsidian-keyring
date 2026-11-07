'use strict';
/*
 * Менеджер хранилищ: поиск заголовков в хранилище Obsidian, сессия,
 * автоблокировка по бездействию. Каждое хранилище разблокируется отдельно
 * своим мастер-паролем.
 */
const { HEADER_FILE } = require('../constants');
const remember = require('./remember');
const { Vault } = require('./vault');
const { Emitter } = require('../util/emitter');
const { Lockout } = require('./lockout');
const headerStore = require('./header-store');
const { dirname } = require('../util/format');

class VaultManager extends Emitter {
  constructor(core) {
    super();
    this.manualLocked = new Set();
    this.core = core;
    this.app = core.app;
    this.vaults = new Map();
    this.lockout = new Lockout(core);
    this.lastActivity = Date.now();
  }

  get settings() {
    return this.core.settings;
  }

  list() {
    return Array.from(this.vaults.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  get(folder) {
    return folder ? this.vaults.get(folder) || null : null;
  }

  unlockedVaults() {
    return this.list().filter((v) => v.unlocked);
  }

  get anyUnlocked() {
    return this.list().some((v) => v.unlocked);
  }

  async discover() {
    const candidates = new Set(this.settings.vaults || []);
    for (const folder of headerStore.knownFolders(this.app)) candidates.add(folder);
    const hidden = new Set(this.settings.hiddenVaults || []);
    for (const folder of hidden) candidates.delete(folder);
    for (const folder of hidden) {
      const v = this.vaults.get(folder);
      if (v && v.unlocked) this.lock(v);
    }
    const found = new Set();
    for (const folder of candidates) {
      if (!folder) continue;
      const existing = this.vaults.get(folder);
      if (!(await this.app.vault.adapter.exists(folder))) {
        if (existing && existing.unlocked) this.lock(existing);
        continue; // папки больше нет
      }
      try {
        if (existing) {
          if (!existing.unlocked) await existing.refreshHeader();
          this.restoredNotice(existing);
        } else {
          const v = await Vault.read(this.app, folder);
          this.vaults.set(folder, v);
          this.restoredNotice(v);
        }
        found.add(folder);
      } catch (e) {
        if (existing && existing.unlocked) found.add(folder);
        else console.warn(`Keyring: пропущено хранилище ${folder}:`, e.message);
      }
    }
    for (const folder of Array.from(this.vaults.keys())) {
      if (!found.has(folder)) this.vaults.delete(folder);
    }
    await Promise.all(this.list().filter((v) => !v.unlocked).map((v) => v.countEntries()));
    const list = Array.from(found).sort();
    if (JSON.stringify(list) !== JSON.stringify(this.settings.vaults)) {
      this.settings.vaults = list;
      await this.core.saveSettings();
    }
    this.emit('change');
  }

  async create(folder, opts) {
    this.settings.hiddenVaults = (this.settings.hiddenVaults || []).filter((f) => f !== folder);
    const vault = await Vault.create(this.app, folder, Object.assign({ recovery: this.settings.recovery || null }, opts));
    this.vaults.set(folder, vault);
    if (!this.settings.vaults.includes(folder)) this.settings.vaults.push(folder);
    this.settings.lastVault = folder;
    await this.core.saveSettings();
    this.touch();
    this.emit('change');
    return vault;
  }

  /** Убрать хранилище из Keyring: файлы остаются, папка больше не подхватывается автоматически. */
  async forget(vault) {
    remember.forget(this.app, vault.folder);
    if (vault.unlocked) vault.lock();
    this.vaults.delete(vault.folder);
    this.settings.vaults = this.settings.vaults.filter((f) => f !== vault.folder);
    const hidden = new Set(this.settings.hiddenVaults || []);
    if (await this.app.vault.adapter.exists(vault.folder)) hidden.add(vault.folder);
    else delete this.settings.headerBackups[vault.folder]; // папки нет — копия заголовка не нужна
    this.settings.hiddenVaults = Array.from(hidden);
    await this.core.saveSettings();
    this.emit('change');
  }

  /** Вернуть скрытое хранилище. */
  async unhide(folder) {
    this.settings.hiddenVaults = (this.settings.hiddenVaults || []).filter((f) => f !== folder);
    await this.core.saveSettings();
    await this.discover();
    this.emit('change');
  }

  /** Сколько зашифрованных записей лежит в папке (без расшифровки). */
  async recordCount(folder) {
    const adapter = this.app.vault.adapter;
    let n = 0;
    const walk = async (dir, depth) => {
      if (depth > 10 || !(await adapter.exists(dir))) return;
      const { files, folders } = await adapter.list(dir);
      n += files.filter((f) => f.endsWith('.kr')).length;
      for (const sub of folders) await walk(sub, depth + 1);
    };
    await walk(folder, 0);
    return n;
  }

  /** Удалить хранилище без записей: заголовок, его копии и пустую папку. */
  async removeEmpty(vault) {
    if ((await this.recordCount(vault.folder)) > 0) throw new Error('В папке есть зашифрованные записи — удалите папку вручную, если она не нужна');
    const adapter = this.app.vault.adapter;
    for (const name of [HEADER_FILE, headerStore.BACKUP_FILE]) {
      const p = `${vault.folder}/${name}`;
      if (await adapter.exists(p)) await adapter.remove(p);
    }
    delete this.settings.headerBackups[vault.folder];
    remember.forget(this.app, vault.folder);
    try {
      const { files, folders } = await adapter.list(vault.folder);
      if (!files.length && !folders.length) await adapter.rmdir(vault.folder, false);
    } catch (e) { /* папку оставляем */ }
    if (vault.unlocked) vault.lock();
    this.vaults.delete(vault.folder);
    this.settings.vaults = this.settings.vaults.filter((f) => f !== vault.folder);
    this.settings.hiddenVaults = (this.settings.hiddenVaults || []).filter((f) => f !== vault.folder);
    await this.core.saveSettings();
    this.emit('change');
  }

  async unlock(vault, password, opts = {}) {
    await this.lockout.guard(vault, () => vault.unlock(password));
    await this.ensureRecovery(vault, password);
    if (opts.remember) await this.setRemembered(vault, true);
    this.manualLocked.delete(vault.folder);
    this.touch();
    this.emit('unlock', vault);
  }

  /* ---------- «не спрашивать пароль на этом устройстве» ---------- */

  isRemembered(vault) {
    return remember.isRemembered(this.app, vault.folder);
  }

  /** Как входить на этом устройстве: 'password' | 'pin' | 'none'. */
  deviceMode(vault) {
    return remember.mode(this.app, vault.folder) || 'password';
  }

  pinInfo(vault) {
    return remember.pinInfo(this.app, vault.folder);
  }

  async setRemembered(vault, on) {
    if (on) await remember.remember(this.app, vault);
    else remember.forget(this.app, vault.folder);
    this.emit('change');
  }

  /** Вход по PIN-коду на этом устройстве (хранилище должно быть открыто). */
  async setPin(vault, pin) {
    if (!/^\d{4,12}$/.test(String(pin))) throw new Error('PIN-код — от 4 до 12 цифр');
    await remember.remember(this.app, vault, { pin: String(pin) });
    this.emit('change');
  }

  /** Открыть по PIN-коду. Неверный PIN — PinError (с числом оставшихся попыток). */
  async unlockWithPin(vault, pin) {
    if (vault.unlocked) return true;
    await vault.refreshHeader().catch(() => {});
    let key;
    try {
      key = await remember.recall(this.app, vault, pin);
    } catch (e) {
      if (e.name === 'PinError' && e.left === 0) this.emit('change');
      throw e;
    }
    if (!key) {
      remember.forget(this.app, vault.folder);
      this.emit('change');
      throw new Error('PIN-код больше не действует на этом устройстве — войдите мастер-паролем');
    }
    return this.finishDeviceUnlock(vault, key);
  }

  async finishDeviceUnlock(vault, key) {
    vault.key = key;
    await vault.reload();
    if (!vault.entries.size && vault.errors.length) {
      vault.lock();
      remember.forget(this.app, vault.folder);
      this.emit('change');
      throw new Error('Сохранённый ключ не подходит к хранилищу — войдите мастер-паролем');
    }
    this.manualLocked.delete(vault.folder);
    this.touch();
    this.emit('unlock', vault);
    return true;
  }

  /** Открыть без пароля, если хранилище запомнено на этом устройстве. */
  async unlockRemembered(vault) {
    if (vault.unlocked) return true;
    if (this.deviceMode(vault) !== 'none') return false;
    await vault.refreshHeader().catch(() => {});
    const key = await remember.recall(this.app, vault);
    if (!key) {
      // ключ устройства утерян или хранилище пересоздано — запоминание больше не действует
      remember.forget(this.app, vault.folder);
      this.emit('change');
      return false;
    }
    vault.key = key;
    await vault.reload();
    if (!vault.entries.size && vault.errors.length) {
      vault.lock();
      remember.forget(this.app, vault.folder);
      this.emit('change');
      return false;
    }
    this.manualLocked.delete(vault.folder);
    this.touch();
    this.emit('unlock', vault);
    return true;
  }

  /** Можно ли открыть автоматически (запомнено и не заблокировано вручную в этой сессии). */
  canAutoUnlock(vault) {
    return !vault.unlocked && !this.manualLocked.has(vault.folder) && this.deviceMode(vault) === 'none';
  }

  /** Применить текущий ключ восстановления ко всем открытым хранилищам (пароль не нужен). */
  async applyRecoveryToUnlocked() {
    const rec = this.settings.recovery;
    const retired = (this.settings.retiredRecovery || []).filter((id) => !rec || id !== rec.id);
    const done = [];
    for (const v of this.list().filter((x) => x.unlocked)) {
      try {
        if (await v.syncRecovery(rec ? [rec] : [], rec ? retired : [])) done.push(v.name);
      } catch (e) {
        console.warn('Keyring: не удалось применить ключ восстановления', v.folder, e);
      }
    }
    return done;
  }

  /** Если включён ключ восстановления, а хранилище ещё не «запечатано» им — добавить. */
  async ensureRecovery(vault, password) {
    const rec = this.settings.recovery;
    if (!rec) return false;
    let changed = false;
    try {
      if (!vault.hasRecovery(rec.id)) {
        if (vault.key) await vault.syncRecovery([rec]);
        else await vault.addRecovery(password, rec);
        changed = true;
      }
      // заменённые («отозванные») ключи убираем, когда текущий уже на месте
      const retired = (this.settings.retiredRecovery || []).filter((id) => id !== rec.id && vault.hasRecovery(id));
      if (retired.length) {
        await vault.removeRecoveryIds(retired);
        changed = true;
      }
      if (changed) this.core.notice(`«${vault.name}»: ключ восстановления обновлён`);
      return changed;
    } catch (e) {
      console.warn('Keyring: не удалось обновить ключ восстановления', e);
      return false;
    }
  }

  async unlockWithKey(vault, privateJwk, opts = {}) {
    // заодно «запечатываем» текущий ключ из настроек, если хранилище его ещё не получило
    const reseal = this.settings.recovery ? [this.settings.recovery] : [];
    const res = await vault.unlockWithRecovery(privateJwk, { altHeaders: opts.altHeaders || [], reseal });
    if (res.via === 'alt') this.core.notice(`«${vault.name}»: открыто по копии заголовка из файла, ключ восстановления снова добавлен в хранилище`, 8000);
    else if (res.resealed) this.core.notice(`«${vault.name}»: текущий ключ восстановления добавлен в хранилище`);
    this.lockout.reset(vault);
    this.touch();
    this.emit('unlock', vault);
  }

  async recover(vault, privateJwk, newPassword, opts = {}) {
    await vault.recover(privateJwk, newPassword, this.settings.iterations, opts.altHeaders || []);
    this.lockout.reset(vault);
    await this.ensureRecovery(vault, newPassword);
    this.touch();
    this.emit('unlock', vault);
  }

  lock(vault) {
    if (!vault.unlocked) return;
    this.manualLocked.add(vault.folder); // вручную — не открывать само до нажатия
    vault.lock();
    vault.countEntries().then(() => this.emit('change'));
    if (!this.anyUnlocked) this.core.clipboard.clear();
    this.emit('lock', vault);
  }

  lockAll(reason) {
    // ручная блокировка отключает автооткрытие запомненных хранилищ до нажатия «Открыть»
    if (reason === 'manual' || reason === 'unload') for (const v of this.vaults.values()) this.manualLocked.add(v.folder);
    let any = false;
    for (const v of this.vaults.values()) {
      if (v.unlocked) {
        v.lock();
        any = true;
      }
    }
    if (!any) return;
    this.core.clipboard.clear();
    this.emit('lock', { reason });
    Promise.all(this.list().map((v) => v.countEntries())).then(() => this.emit('change'));
  }

  touch() {
    this.lastActivity = Date.now();
  }

  /** Сколько осталось до автоблокировки, мс (null — блокировать нечего/выключено). */
  remainingMs() {
    const minutes = Number(this.settings.autoLockMinutes) || 0;
    if (!minutes || !this.anyUnlocked) return null;
    return minutes * 60000 - (Date.now() - this.lastActivity);
  }

  tick() {
    const left = this.remainingMs();
    if (left !== null && left <= 0) this.lockAll('timeout');
  }

  /** Реакция на изменение файлов (например, пришло по Syncthing). */
  restoredNotice(vault) {
    if (!vault.restoredFrom) return;
    const from = vault.restoredFrom === 'backup' ? 'резервной копии в папке' : 'копии в настройках плагина';
    this.core.notice(`«${vault.name}»: заголовок хранилища (keyring.vault.json) был утерян и восстановлен из ${from}`, 8000);
    vault.restoredFrom = null;
  }

  async onFileEvent(path) {
    // удалена папка хранилища целиком (или её родитель) — убрать его из списка
    for (const v of this.vaults.values()) {
      if ((v.folder === path || v.folder.startsWith(`${path}/`)) && !(await this.app.vault.adapter.exists(v.folder))) {
        await this.discover();
        return;
      }
    }
    // основной заголовок удалён — сразу восстанавливаем из копии
    for (const v of this.vaults.values()) {
      if (path === v.headerPath && !(await this.app.vault.adapter.exists(path))) {
        try {
          await v.refreshHeader();
          this.restoredNotice(v);
        } catch (e) {
          console.warn('Keyring: не удалось восстановить заголовок', e);
        }
        return;
      }
    }
    if (path.endsWith(HEADER_FILE) && !this.vaults.has(dirname(path))) {
      await this.discover();
      return;
    }
    for (const v of this.vaults.values()) {
      if (!v.owns(path)) continue;
      if (Date.now() - v.lastWrite < 2000) return; // наши собственные записи
      if (v.unlocked) {
        await v.reload();
        this.emit('reload', v);
      } else {
        await v.countEntries();
        this.emit('change');
      }
    }
  }
}

module.exports = { VaultManager };
