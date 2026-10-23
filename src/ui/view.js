'use strict';
/*
 * Главный вид Keyring (вкладка в рабочей области Obsidian).
 * Адаптивный: «wide» — десктопный макет (рейка + проводник + контент + панель
 * редактора), «narrow» — мобильный (шапка, чипы, нижняя навигация, FAB).
 */
const {
  ItemView, Menu, Keymap, MarkdownRenderer, Platform,
} = require('obsidian');
const { VIEW_TYPE } = require('../constants');
const { el, icon, clear } = require('../util/dom');
const { formatCountdown, hrefOf } = require('../util/format');
const { parseTotp, totpCode, formatCode } = require('../crypto/totp');
const {
  renderRail, renderSidebar, renderBottomNav, renderMobileHeader, renderFab,
} = require('./nav');
const { renderLockScreen, renderOnboarding } = require('./lock-screen');
const { renderVaultPage, fillList } = require('./vault-page');
const { renderCard } = require('./card');
const { EditorPanel } = require('./editor');
const { renderGeneratorPage, clearGeneratorHistory } = require('./generator-page');
const { renderAnalysisPage } = require('./analysis');
const { renderSettingsPage } = require('./settings-page');
const { ConvertFolderModal } = require('./convert-modal');
const { EntryModal } = require('./entry-modal');
const {
  CreateVaultModal, ConfirmModal, HistoryModal, FilePreviewModal, ChangePasswordModal,
} = require('./modals');
const { CreateRecoveryKeyModal, AddRecoveryNowModal } = require('./recovery');
const { fileBlob, decryptToVault } = require('../vault/converter');

const NARROW_MAX = 760;
const DOCK_MIN = 1180;

class KeyringView extends ItemView {
  constructor(leaf, core) {
    super(leaf);
    this.core = core;
    const s = core.settings;
    this.state = {
      tab: 'vault',
      vaultFolder: s.lastVault,
      category: null,
      query: '',
      group: s.group || 'alpha',
      layout: s.layout || 'cards',
      expanded: new Set(),
      openSections: new Set(),
      focusId: null,
      revealed: new Set(),
    };
    this.editor = null;
    this.mode = 'wide';
    this.docked = true;
    this.totpCache = new Map();
    this.listHost = null;
    this.searchInput = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Keyring';
  }

  getIcon() {
    return 'key-round';
  }

  get manager() {
    return this.core.manager;
  }

  get settings() {
    return this.core.settings;
  }

  /** Текущее хранилище (выбранное или первое доступное). */
  get vault() {
    const m = this.manager;
    let v = m.get(this.state.vaultFolder);
    if (!v) {
      const list = m.list();
      v = list.find((x) => x.unlocked) || list[0] || null;
      if (v) this.state.vaultFolder = v.folder;
    }
    return v;
  }

  async onOpen() {
    this.root = this.contentEl;
    clear(this.root);
    this.root.classList.add('kr-view');
    this.ro = new ResizeObserver(() => this.updateMode());
    this.ro.observe(this.root);
    this.unsub = this.manager.on((type, data) => this.onManagerEvent(type, data));
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.registerDomEvent(this.root, 'pointerdown', () => this.manager.touch());
    this.registerDomEvent(this.root, 'keydown', (e) => this.onKeyDown(e));
    this.registerDomEvent(window, 'resize', () => this.updateInsets());
    this.registerEvent(this.app.workspace.on('layout-change', () => window.setTimeout(() => this.updateInsets(), 50)));
    this.updateMode(true);
    this.render();
    if (!this.manager.list().length) await this.manager.discover();
  }

  async onClose() {
    if (this.unsub) this.unsub();
    if (this.ro) this.ro.disconnect();
    if (this.settings.lockOnClose) this.manager.lockAll('close');
  }

  onKeyDown(e) {
    this.manager.touch();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f' && this.searchInput) {
      e.preventDefault();
      e.stopPropagation();
      this.searchInput.focus();
      this.searchInput.select();
    } else if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      this.manager.lockAll('manual');
    } else if (e.key === 'Escape' && this.editor) {
      this.closeEditor();
    }
  }

  /** Безопасная зона сверху (вырез/статус-бар при edge-to-edge на телефоне). */
  updateInsets() {
    const setting = this.settings.mobileTopInset;
    let inset = 0;
    if (setting !== 'auto' && setting !== undefined) {
      inset = Number(setting) || 0;
    } else if (Platform.isMobile) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
        + 'padding-top:max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px));';
      document.body.appendChild(probe);
      const safe = parseFloat(getComputedStyle(probe).paddingTop) || 0;
      probe.remove();
      const top = this.root.getBoundingClientRect().top;
      // если вид начинается в самом верху экрана — значит, шапка Obsidian скрыта
      // и наш заголовок оказался под статус-баром
      if (top < 4) inset = Math.max(safe, 28);
      else inset = Math.max(0, safe - top);
    }
    document.body.style.setProperty('--kr-top-inset', `${Math.round(inset)}px`);
    document.body.style.setProperty('--kr-bottom-inset', `${Math.round(this.measureBottomInset())}px`);
  }

  /**
   * Сколько снизу перекрыто: системная панель жестов/кнопок (edge-to-edge)
   * и нижняя панель самого Obsidian на телефоне.
   */
  measureBottomInset() {
    const setting = this.settings.mobileBottomInset;
    if (setting !== 'auto' && setting !== undefined) return Number(setting) || 0;
    if (!Platform.isMobile || !this.root) return 0;
    const rect = this.root.getBoundingClientRect();
    if (!rect.height) return 0;
    const screenBottom = window.innerHeight;
    let inset = 0;

    // вид уходит ниже видимой области
    if (rect.bottom > screenBottom) inset = rect.bottom - screenBottom;

    // нижняя панель Obsidian (кнопки навигации) поверх вида — встаём ровно над ней.
    // Панель редактирования (.mobile-toolbar) не учитываем: в режиме чтения она скрыта, но остаётся в DOM.
    let bar = null;
    for (const sel of ['.mobile-navbar-actions', '.mobile-navbar']) {
      for (const node of Array.from(document.querySelectorAll(sel))) {
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = node.getBoundingClientRect();
        if (r.height > 0 && r.top < rect.bottom && r.top > rect.top + rect.height / 2) {
          bar = bar ? Math.min(bar, r.top) : r.top;
        }
      }
      if (bar !== null) break;
    }
    if (bar !== null) return Math.max(0, Math.min(rect.bottom - bar, 120));

    // панели Obsidian нет — учитываем только системную безопасную зону (полоса жестов)
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;visibility:hidden;pointer-events:none;'
      + 'padding-bottom:max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px));';
    document.body.appendChild(probe);
    const safe = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    if (rect.bottom >= screenBottom - 2) inset = Math.max(inset, safe);
    return Math.min(inset, 160);
  }

  updateMode(force) {
    this.updateInsets();
    const w = this.root.clientWidth;
    if (!w && !force) return;
    const width = w || 1200;
    const mode = width < NARROW_MAX ? 'narrow' : 'wide';
    const docked = width >= DOCK_MIN;
    if (force || mode !== this.mode || docked !== this.docked) {
      this.mode = mode;
      this.docked = docked;
      if (!force) this.render();
    }
  }

  onManagerEvent(type) {
    if (type === 'lock' || type === 'unlock') this.state.category = null; // всегда начинаем со «Все записи»
    if (type === 'lock') {
      this.editor = null;
      this.state.revealed.clear();
      this.state.expanded.clear();
      this.totpCache.clear();
      this.genCurrent = null;
      clearGeneratorHistory();
    }
    this.render();
  }

  /* ---------- отрисовка ---------- */

  render() {
    if (!this.root) return;
    const scroller = this.root.querySelector('.kr-main');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    clear(this.root);
    this.root.className = `kr-view kr-mode-${this.mode}${this.docked ? ' kr-docked' : ''}`;
    this.searchInput = null;
    this.listHost = null;

    const vault = this.vault;
    const tab = this.state.tab;
    const shell = el('div.kr-shell');
    this.root.append(shell);
    if (this.mode === 'wide') shell.append(renderRail(this), renderSidebar(this));

    const main = el('div.kr-main');
    shell.append(main);
    if (this.mode === 'narrow') main.append(renderMobileHeader(this, vault));

    if (tab === 'generator') main.append(renderGeneratorPage(this));
    else if (tab === 'settings') main.append(renderSettingsPage(this, vault));
    else if (!vault) main.append(renderOnboarding(this));
    else if (!vault.unlocked) main.append(renderLockScreen(this, vault));
    else if (tab === 'analysis') main.append(renderAnalysisPage(this, vault));
    else main.append(renderVaultPage(this, vault));

    if (this.editor && vault && vault.unlocked) {
      this.editor.el.classList.toggle('is-overlay', this.mode === 'narrow' || !this.docked);
      shell.append(this.editor.el);
      shell.classList.add('has-editor');
    }

    if (this.mode === 'narrow') {
      if (tab === 'vault' && vault && vault.unlocked && !this.editor) this.root.append(renderFab(this));
      this.root.append(renderBottomNav(this));
    }
    main.scrollTop = this.resetScroll ? 0 : scrollTop;
    this.resetScroll = false;
    this.tick();
  }

  renderList() {
    const vault = this.vault;
    if (this.listHost && vault && vault.unlocked) fillList(this, vault, this.listHost);
    this.tick();
  }

  replaceCard(id) {
    const vault = this.vault;
    const entry = vault && vault.entries.get(id);
    const node = this.root.querySelector(`[data-kr-id="${id}"]`);
    if (!entry || !node) return this.renderList();
    node.replaceWith(renderCard(this, vault, entry));
    this.tick();
  }

  /* ---------- действия ---------- */

  setTab(tab) {
    if (tab !== this.state.tab) this.resetScroll = true;
    this.state.tab = tab;
    if (this.mode === 'narrow') this.editor = null;
    this.render();
  }

  selectVault(folder) {
    if (this.state.vaultFolder !== folder) {
      this.resetScroll = true;
      this.state.vaultFolder = folder;
      this.state.category = null;
      this.state.query = '';
      this.state.expanded.clear();
      this.state.revealed.clear();
      this.editor = null;
      this.settings.lastVault = folder;
      this.core.saveSettings();
    }
    if (this.state.tab === 'settings' || this.state.tab === 'generator') this.state.tab = 'vault';
    this.render();
  }

  setCategory(path) {
    this.state.category = path;
    this.state.tab = 'vault';
    this.render();
  }

  setQuery(q) {
    this.state.query = q;
    this.renderList();
  }

  setGroup(group) {
    this.state.group = group;
    this.settings.group = group;
    this.core.saveSettings();
    this.renderList();
    this.root.querySelectorAll('[data-group]').forEach((b) => {
      b.classList.toggle('is-active', b.getAttribute('data-group') === group);
    });
  }

  setLayout(layout) {
    this.state.layout = layout;
    this.settings.layout = layout;
    this.core.saveSettings();
    this.render();
  }

  toggleExpand(id) {
    const s = this.state.expanded;
    const collapsing = s.has(id);
    if (collapsing) s.delete(id);
    else s.add(id);
    this.replaceCard(id);
    if (collapsing) {
      // длинная карточка свернулась — вернуть её начало в поле зрения
      const node = this.root.querySelector(`[data-kr-id="${id}"]`);
      const main = this.root.querySelector('.kr-main');
      if (node && main) {
        const top = node.getBoundingClientRect().top - main.getBoundingClientRect().top;
        if (top < 0 || top > main.clientHeight) node.scrollIntoView({ block: 'start' });
      }
    }
  }

  showEntry(entry) {
    new EntryModal(this, this.vault, entry).open();
  }

  toggleReveal(id) {
    const s = this.state.revealed;
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.manager.touch();
    this.replaceCard(id);
  }

  copy(text, label) {
    return this.core.clipboard.copy(text, label);
  }

  openUrl(url) {
    if (!url) return;
    window.open(hrefOf(url), '_blank');
  }

  openEditor(entry, opts) {
    const vault = this.vault;
    if (!vault || !vault.unlocked) return;
    this.state.tab = 'vault';
    this.editor = new EditorPanel(this, vault, entry, opts);
    this.render();
    this.editor.focus();
  }

  closeEditor() {
    this.editor = null;
    this.render();
  }

  async afterSave(entry) {
    this.editor = null;
    this.state.expanded.add(entry.id);
    this.render();
    const node = this.root.querySelector(`[data-kr-id="${entry.id}"]`);
    if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async deleteEntry(entry) {
    const ok = await new ConfirmModal(this.app, {
      title: 'Удалить запись?',
      message: `«${entry.title}» будет перемещена в корзину Obsidian (.trash) в зашифрованном виде.`,
      cta: 'Удалить',
      danger: true,
    }).ask();
    if (!ok) return false;
    await this.vault.remove(entry);
    this.editor = null;
    this.core.notice('Запись удалена');
    this.render();
    return true;
  }

  previewFile(entry) {
    new FilePreviewModal(this, entry).open();
  }

  downloadFile(entry) {
    if (!entry.file) return;
    const url = URL.createObjectURL(fileBlob(entry));
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.core.notice('Расшифрованная копия сохраняется через диалог загрузки. Если на телефоне ничего не произошло — используйте «Расшифровать обратно в папку».', 6000);
  }

  async decryptEntry(entry) {
    const ok = await new ConfirmModal(this.app, {
      title: 'Расшифровать обратно?',
      message: `Открытая копия «${entry.title}» будет записана в хранилище Obsidian${entry.origin ? ` (${entry.origin})` : ''}. `
        + 'Зашифрованная запись останется — удалите её сами, если она больше не нужна.',
      cta: 'Расшифровать',
    }).ask();
    if (!ok) return;
    try {
      const path = await decryptToVault(this.app, this.vault, entry);
      this.core.notice(`Открытая копия: ${path}`, 6000);
    } catch (e) {
      this.core.notice(`Не удалось: ${e.message}`, 8000);
    }
  }

  showHistory(entry) {
    new HistoryModal(this, this.vault, entry).open();
  }

  createVault() {
    new CreateVaultModal(this.core, (vault, convert) => {
      this.selectVault(vault.folder);
      const hasFiles = this.app.vault.getFiles().some((f) => f.path.startsWith(`${vault.folder}/`) && f.extension !== 'kr' && f.name !== 'keyring.vault.json');
      if (convert && hasFiles) this.convertFolder(vault.folder, vault);
    }).open();
  }

  convertFolder(folder, vault) {
    new ConvertFolderModal(this.core, {
      folder: folder || '',
      vault,
      autoScan: !!folder,
      onDone: (v) => this.selectVault(v.folder),
    }).open();
  }

  focusEntry(id) {
    this.state.tab = 'vault';
    this.state.category = null;
    this.state.query = '';
    this.state.expanded.add(id);
    this.state.focusId = id;
    this.editor = null;
    this.render();
    const node = this.root.querySelector(`[data-kr-id="${id}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      node.classList.add('is-flash');
      window.setTimeout(() => node.classList.remove('is-flash'), 1600);
    }
  }

  vaultMenu(evt) {
    const menu = new Menu();
    for (const v of this.manager.list()) {
      menu.addItem((item) => item
        .setTitle(v.name)
        .setIcon(v.unlocked ? 'lock-open' : 'lock')
        .setChecked(v === this.vault)
        .onClick(() => this.selectVault(v.folder)));
    }
    const current = this.vault;
    if (current && current.unlocked) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(`«${current.name}»: сменить мастер-пароль…`).setIcon('key-round')
        .onClick(() => new ChangePasswordModal(this.core, current).open()));
      menu.addItem((item) => item
        .setTitle(this.settings.recovery ? `«${current.name}»: сменить ключ восстановления…` : 'Создать ключ восстановления…')
        .setIcon('life-buoy')
        .onClick(() => new CreateRecoveryKeyModal(this, { vault: current }).open()));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Новое хранилище…').setIcon('folder-plus').onClick(() => this.createVault()));
    menu.addItem((item) => item.setTitle('Зашифровать папку…').setIcon('folder-lock').onClick(() => this.convertFolder('')));
    if (this.manager.anyUnlocked) {
      menu.addItem((item) => item.setTitle('Заблокировать все').setIcon('lock').onClick(() => this.manager.lockAll('manual')));
    }
    menu.showAtMouseEvent(evt);
  }

  /** Меню «Безопасность» для открытого хранилища: пароль и ключ восстановления. */
  securityMenu(evt, vault) {
    vault = vault || this.vault;
    if (!vault || !vault.unlocked) return;
    const rec = this.settings.recovery;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle('Сменить мастер-пароль…').setIcon('key-round')
      .onClick(() => new ChangePasswordModal(this.core, vault).open()));
    menu.addSeparator();
    if (!rec) {
      menu.addItem((item) => item.setTitle('Создать ключ восстановления…').setIcon('life-buoy')
        .onClick(() => new CreateRecoveryKeyModal(this, { vault }).open()));
    } else {
      menu.addItem((item) => item.setTitle('Сменить ключ восстановления (новый файл)…').setIcon('refresh-cw')
        .onClick(() => new CreateRecoveryKeyModal(this, { vault }).open()));
      if (!vault.hasRecovery(rec.id)) {
        menu.addItem((item) => item.setTitle('Добавить ключ восстановления в это хранилище…').setIcon('shield-check')
          .onClick(() => new AddRecoveryNowModal(this, vault).open()));
      }
    }
    menu.addItem((item) => item.setTitle('Настройки восстановления').setIcon('life-buoy').onClick(() => this.setTab('settings')));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Заблокировать').setIcon('lock').onClick(() => this.manager.lock(vault)));
    menu.showAtMouseEvent(evt);
  }

  renderMarkdown(markdown, container, vault) {
    const source = `${vault.folder}/`;
    const render = MarkdownRenderer.render || MarkdownRenderer.renderMarkdown;
    if (MarkdownRenderer.render) MarkdownRenderer.render(this.app, markdown, container, source, this);
    else render.call(MarkdownRenderer, markdown, container, source, this);
    container.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a.internal-link');
      if (!a) return;
      e.preventDefault();
      const target = a.getAttribute('data-href') || a.getAttribute('href');
      this.app.workspace.openLinkText(target, source, Keymap.isModEvent(e));
    });
  }

  /* ---------- таймеры: TOTP и сессия ---------- */

  tick() {
    if (!this.root) return;
    const left = this.manager.remainingMs();
    this.root.querySelectorAll('.kr-session-time').forEach((n) => {
      n.textContent = left === null ? 'без таймера' : formatCountdown(left);
    });
    // таймер блокировки ввода пароля на экране входа
    let lockoutExpired = false;
    this.root.querySelectorAll('.kr-lockout-time[data-until]').forEach((n) => {
      const ms = Number(n.getAttribute('data-until')) - Date.now();
      if (ms <= 0) lockoutExpired = true;
      else n.textContent = formatCountdown(ms);
    });
    if (lockoutExpired) {
      this.render();
      return;
    }
    const vault = this.vault;
    if (!vault || !vault.unlocked) return;
    const now = Date.now();
    this.root.querySelectorAll('[data-totp-id]').forEach((node) => this.updateTotp(node, vault, now));
  }

  updateTotp(node, vault, now) {
    const entry = vault.entries.get(node.getAttribute('data-totp-id'));
    if (!entry) return;
    const cfg = parseTotp(entry.totp);
    const codeEl = node.querySelector('.kr-totp-code');
    const leftEl = node.querySelector('.kr-totp-left');
    if (!cfg) {
      if (codeEl) codeEl.textContent = 'неверный секрет';
      node.classList.add('is-invalid');
      return;
    }
    const remaining = cfg.period - (Math.floor(now / 1000) % cfg.period);
    if (leftEl) leftEl.textContent = `${remaining}s`;
    node.style.setProperty('--kr-totp-p', String(remaining / cfg.period));
    node.classList.toggle('is-ending', remaining <= 5);
    const key = `${entry.id}:${entry.totp}`;
    const counter = Math.floor(now / 1000 / cfg.period);
    const cached = this.totpCache.get(key);
    if (cached && cached.counter === counter) {
      if (codeEl && codeEl.textContent !== cached.text) codeEl.textContent = cached.text;
      node.setAttribute('data-code', cached.code);
      return;
    }
    totpCode(cfg, now).then((r) => {
      const text = formatCode(r.code);
      this.totpCache.set(key, { counter: r.counter, code: r.code, text });
      if (codeEl) codeEl.textContent = text;
      node.setAttribute('data-code', r.code);
    });
  }

  currentTotp(entry) {
    const cached = this.totpCache.get(`${entry.id}:${entry.totp}`);
    return cached ? cached.code : '';
  }

  async copyTotp(entry) {
    const cfg = parseTotp(entry.totp);
    if (!cfg) return;
    const r = await totpCode(cfg);
    this.copy(r.code, 'код 2FA');
  }

  iconEl(name) {
    return icon(name);
  }
}

module.exports = { KeyringView };
