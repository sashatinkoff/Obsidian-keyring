'use strict';
/* Ядро плагина: настройки, команды, вид, события файлов, статус-бар. */
const { Notice, Platform } = require('obsidian');
const { VIEW_TYPE, DEFAULT_SETTINGS, DEFAULT_GENERATOR } = require('./constants');
const { VaultManager } = require('./vault/manager');
const headerStore = require('./vault/header-store');
const { SecureClipboard } = require('./util/clipboard');
const { KeyringView } = require('./ui/view');
const { KeyringSettingTab } = require('./ui/settings-tab');
const { generatePassword } = require('./crypto/generator');
const { generatePin } = require('./crypto/pin');
const { formatCountdown } = require('./util/format');
const { icon, clear } = require('./util/dom');

class KeyringCore {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  async load() {
    const plugin = this.plugin;
    const data = (await plugin.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.generator = Object.assign({}, DEFAULT_GENERATOR, data.generator || {});
    if (!Array.isArray(this.settings.vaults)) this.settings.vaults = [];

    headerStore.attach(this);
    this.clipboard = new SecureClipboard(this);
    this.manager = new VaultManager(this);

    plugin.registerView(VIEW_TYPE, (leaf) => new KeyringView(leaf, this));
    plugin.addRibbonIcon('key-round', 'Открыть Keyring', () => this.activateView());
    plugin.addSettingTab(new KeyringSettingTab(this.app, plugin, this));
    this.registerCommands();

    plugin.registerInterval(window.setInterval(() => {
      this.manager.tick();
      this.updateStatusBar();
    }, 1000));

    plugin.registerDomEvent(document, 'visibilitychange', () => {
      if (document.hidden && this.settings.lockOnHide) this.manager.lockAll('hidden');
    });

    const onFile = (file) => {
      if (file && file.path) this.manager.onFileEvent(file.path);
    };
    const v = this.app.vault;
    plugin.registerEvent(v.on('create', onFile));
    plugin.registerEvent(v.on('modify', onFile));
    plugin.registerEvent(v.on('delete', onFile));
    plugin.registerEvent(v.on('rename', (file, oldPath) => {
      onFile(file);
      this.manager.onFileEvent(oldPath);
    }));

    if (!Platform.isMobile) {
      this.statusEl = plugin.addStatusBarItem();
      this.statusEl.classList.add('kr-status');
      this.statusEl.addEventListener('click', () => {
        if (this.manager.anyUnlocked) this.manager.lockAll('manual');
        else this.activateView();
      });
    }
    this.manager.on(() => this.updateStatusBar());

    // ПКМ по папке в проводнике → «Зашифровать папку в Keyring»
    plugin.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!file || file.children === undefined) return;
      const vault = this.manager.get(file.path);
      menu.addItem((item) => item
        .setTitle(vault ? 'Keyring: зашифровать оставшиеся файлы' : 'Keyring: зашифровать папку…')
        .setIcon('folder-lock')
        .onClick(async () => {
          const view = await this.activateView();
          if (view) view.convertFolder(file.path === '/' ? '' : file.path, vault);
        }));
    }));

    this.app.workspace.onLayoutReady(() => this.manager.discover());
  }

  unload() {
    if (this.manager) this.manager.lockAll('unload');
    if (this.clipboard) this.clipboard.dispose();
  }

  registerCommands() {
    const p = this.plugin;
    p.addCommand({ id: 'open', name: 'Открыть Keyring', callback: () => this.activateView() });
    p.addCommand({ id: 'lock-all', name: 'Заблокировать все хранилища', callback: () => this.manager.lockAll('manual') });
    p.addCommand({
      id: 'new-entry',
      name: 'Новая запись',
      callback: async () => {
        const view = await this.activateView();
        if (view) view.openEditor(null);
      },
    });
    p.addCommand({
      id: 'encrypt-folder',
      name: 'Зашифровать папку (рекурсивно)…',
      callback: async () => {
        const view = await this.activateView();
        if (view) view.convertFolder('');
      },
    });
    p.addCommand({
      id: 'copy-generated',
      name: 'Сгенерировать пароль и скопировать',
      callback: () => this.clipboard.copy(generatePassword(this.settings.generator), 'новый пароль'),
    });
    p.addCommand({
      id: 'copy-generated-pin',
      name: 'Сгенерировать PIN-код и скопировать',
      callback: () => {
        const g = Object.assign({ length: 4, avoidWeak: true }, this.settings.pinGenerator);
        this.clipboard.copy(generatePin(g.length, g), 'новый PIN');
      },
    });
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  updateStatusBar() {
    if (!this.statusEl) return;
    const unlocked = this.manager.unlockedVaults();
    const left = this.manager.remainingMs();
    clear(this.statusEl);
    this.statusEl.append(icon(unlocked.length ? 'lock-open' : 'lock'));
    const text = unlocked.length
      ? `Keyring ${left !== null ? formatCountdown(left) : 'открыт'}`
      : 'Keyring';
    this.statusEl.append(document.createTextNode(` ${text}`));
    this.statusEl.title = unlocked.length
      ? `Открыто: ${unlocked.map((v) => v.name).join(', ')}. Нажмите, чтобы заблокировать.`
      : 'Все хранилища заблокированы';
    this.statusEl.classList.toggle('is-unlocked', unlocked.length > 0);
  }

  notice(msg, ms) {
    return new Notice(msg, ms);
  }
}

module.exports = { KeyringCore };
