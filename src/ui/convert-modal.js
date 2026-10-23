'use strict';
/*
 * «Зашифровать папку»: выбрать любую папку (рекурсивно со всеми подпапками)
 * и конвертировать её содержимое в зашифрованные записи — либо превратив
 * саму папку в хранилище, либо перенеся данные в существующее хранилище.
 */
const { normalizePath } = require('obsidian');
const { el, icon, button, clear } = require('../util/dom');
const { countLabel, basename, formatNumber } = require('../util/format');
const { CIPHER_LABEL, KDF_LABEL } = require('../constants');
const { analyzePassword } = require('../crypto/strength');
const { scanFolder, convertItems, formatSize } = require('../vault/converter');
const { attachFolderSuggest } = require('../util/suggest');
const { strengthMeter, checkbox } = require('./widgets');
const {
  BaseModal, passwordInput, labeled, passwordErrorText,
} = require('./modals');

function segmented(options, value, onChange) {
  return el('div.kr-seg.kr-seg-full', options.map(([id, label, ic]) => el(`button.kr-seg-btn${value === id ? '.is-active' : ''}`, {
    attr: { type: 'button' },
    on: { click: () => onChange(id) },
  }, [ic ? icon(ic) : null, el('span', label)])));
}

class ConvertFolderModal extends BaseModal {
  constructor(core, opts = {}) {
    super(core.app, 'Зашифровать папку');
    this.core = core;
    this.onDone = opts.onDone;
    this.folder = opts.folder || '';
    const existing = opts.vault || core.manager.get(this.folder);
    this.target = existing ? 'existing' : 'self';
    this.targetFolder = existing ? existing.folder : (core.manager.list()[0] || {}).folder || '';
    this.mode = 'parse';
    this.includeFiles = true;
    this.deleteOriginals = true;
    this.scan = null;
    this.busy = false;
    this.inputs = {};
    if (opts.autoScan && this.folder) this.runScan();
  }

  get headerHere() {
    return this.core.manager.get(this.folder);
  }

  targetVault() {
    if (this.target === 'self') return this.headerHere || null;
    return this.core.manager.get(this.targetFolder);
  }

  targetFolderPath() {
    const v = this.targetVault();
    if (v) return v.folder;
    return this.target === 'self' ? this.folder : this.targetFolder;
  }

  async runScan() {
    this.scan = await scanFolder(this.core, this.folder, {
      targetFolder: this.targetFolderPath(),
      includeFiles: this.includeFiles,
    });
    if (this.contentEl.isConnected) this.onOpen();
  }

  selectedItems() {
    if (!this.scan) return [];
    return this.scan.notes.concat(this.includeFiles ? this.scan.files : []).filter((i) => i.selected);
  }

  build(c) {
    c.append(el('p.kr-modal-text', 'Выберите папку — Keyring обойдёт её вместе со всеми подпапками и превратит содержимое в зашифрованные записи: '
      + 'заметки (с распознаванием логинов и паролей или текстом целиком) и любые файлы — PDF, сканы, изображения — как зашифрованные вложения. '
      + 'Структура подпапок сохраняется как категории.'));

    // 1. папка
    const folder = el('input.kr-input', { attr: { type: 'text', placeholder: 'Документы', spellcheck: 'false' } });
    folder.value = this.folder;
    attachFolderSuggest(this.app, folder);
    folder.addEventListener('input', () => {
      this.folder = normalizePath(folder.value.trim() || '/').replace(/^\/$/, '');
      this.scan = null;
      if (this.core.manager.get(this.folder)) this.target = 'self';
      this.refreshBelow();
    });
    folder.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.runScan();
    });
    c.append(labeled('Папка (рекурсивно)', el('div.kr-form-row', [
      el('label.kr-input-wrap.kr-grow', [icon('folder-tree'), folder]),
      button('Сканировать', 'scan-search', () => this.runScan(), 'kr-btn-soft'),
    ])));

    this.below = el('div.kr-convert-body');
    c.append(this.below);
    this.renderBelow();
    window.setTimeout(() => folder.focus(), 20);
  }

  refreshBelow() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.renderBelow(), 150);
  }

  renderBelow() {
    const c = clear(this.below);
    const vaults = this.core.manager.list();
    const here = this.headerHere;

    // 2. куда
    const targetOpts = [['self', here ? 'Эта папка — уже хранилище' : 'Сделать папку хранилищем', 'folder-lock']];
    if (vaults.filter((v) => v !== here).length) targetOpts.push(['existing', 'В другое хранилище', 'library']);
    c.append(labeled('Куда', segmented(targetOpts, this.target, (v) => {
      this.target = v;
      this.scan = null;
      this.renderBelow();
    })));

    const tv = this.targetVault();
    if (this.target === 'existing') {
      const select = el('select.kr-input.kr-select');
      for (const v of vaults.filter((x) => x !== here)) {
        const o = el('option', { attr: { value: v.folder } }, `${v.name} (${v.folder})${v.unlocked ? '' : ' — заблокировано'}`);
        if (v.folder === this.targetFolder) o.selected = true;
        select.append(o);
      }
      if (!vaults.some((v) => v.folder === this.targetFolder) && select.options.length) this.targetFolder = select.options[0].value;
      select.addEventListener('change', () => {
        this.targetFolder = select.value;
        this.renderBelow();
      });
      c.append(el('label.kr-input-wrap', [icon('library'), select]));
      c.append(el('p.kr-hint', [icon('info'), `Данные лягут в категорию «${basename(this.folder) || 'Импорт'}» с подпапками.`]));
    }

    if (tv && !tv.unlocked) {
      this.inputs.unlock = passwordInput(`Мастер-пароль «${tv.name}»`, 'current-password');
      c.append(labeled('Разблокировать хранилище', this.inputs.unlock));
    } else {
      this.inputs.unlock = null;
    }
    if (this.target === 'self' && !here) {
      const pw = passwordInput('Новый мастер-пароль');
      const pw2 = passwordInput('Повторите мастер-пароль');
      const meter = el('div');
      pw.addEventListener('input', () => clear(meter).append(strengthMeter(analyzePassword(pw.value))));
      meter.append(strengthMeter(analyzePassword('')));
      this.inputs.pw = pw;
      this.inputs.pw2 = pw2;
      c.append(el('div.kr-form-grid', [labeled('Мастер-пароль нового хранилища', pw), labeled('Повтор', pw2)]), meter);
    } else {
      this.inputs.pw = null;
    }

    // 3. как
    c.append(labeled('Заметки', segmented([
      ['parse', 'Распознать логины и пароли', 'scan-text'],
      ['whole', 'Сохранить текст целиком', 'file-lock'],
    ], this.mode, (v) => {
      this.mode = v;
      this.renderBelow();
    })));
    c.append(el('div.kr-check-col', [
      checkbox('Шифровать и остальные файлы (PDF, изображения, документы…) как вложения', this.includeFiles, (v) => {
        this.includeFiles = v;
        this.renderPreview();
      }),
      checkbox('Удалить открытые исходники после проверки', this.deleteOriginals, (v) => {
        this.deleteOriginals = v;
      }),
    ]));

    this.previewHost = el('div');
    c.append(this.previewHost);
    this.renderPreview();

    c.append(el('div.kr-warn', [icon('alert-triangle'), el('div', [
      el('b', 'Про открытые копии.'),
      el('span', ' Каждая запись шифруется и проверяется обратной расшифровкой, только потом исходник удаляется. '
        + 'Версии Syncthing (.stversions), резервные копии и корзина ОС могут хранить старые открытые файлы — их нужно почистить вручную. '
        + 'Ссылки ![[вложение]] в других заметках перестанут работать.'),
    ])]));

    this.progress = el('div.kr-progress', [el('i')]);
    this.progressText = el('small.kr-muted');
    this.error = el('div.kr-form-error');
    const count = this.selectedItems().length;
    this.goBtn = button(count ? `Зашифровать ${count}` : 'Зашифровать', 'shield-check', () => this.run(), 'kr-btn-primary');
    this.goBtn.disabled = !count || this.busy;
    c.append(
      el('div.kr-modal-meta', [
        el('span.kr-chip.kr-chip-mint', [icon('shield-check'), CIPHER_LABEL]),
        el('span.kr-chip', [icon('fingerprint'), `${KDF_LABEL} × ${formatNumber(tv ? tv.iterations : this.core.settings.iterations)}`]),
      ]),
      this.progress,
      this.progressText,
      this.error,
      el('div.kr-modal-foot', [button('Закрыть', null, () => this.close(), 'kr-btn-ghost'), this.goBtn])
    );
  }

  renderPreview() {
    const host = clear(this.previewHost);
    const s = this.scan;
    if (!s) {
      host.append(el('div.kr-convert-empty', [icon('scan-search'), el('span', 'Нажмите «Сканировать», чтобы увидеть, что будет зашифровано.')]));
      this.updateGo();
      return;
    }
    const files = this.includeFiles ? s.files : [];
    const total = s.notes.length + files.length;
    host.append(el('div.kr-convert-stats', [
      el('span.kr-chip', [icon('file-text'), countLabel(s.notes.length, ['заметка', 'заметки', 'заметок'])]),
      el('span.kr-chip', [icon('paperclip'), countLabel(files.length, ['файл', 'файла', 'файлов'])]),
      el('span.kr-chip', [icon('folder-tree'), countLabel(s.folders.length, ['подпапка', 'подпапки', 'подпапок'])]),
      s.skipped.length ? el('span.kr-chip.kr-chip-warn', [icon('alert-circle'), `пропущено: ${s.skipped.length}`]) : null,
    ]));
    if (!total) {
      host.append(el('div.kr-muted', 'Нечего шифровать: в папке нет открытых файлов.'));
      this.updateGo();
      return;
    }

    // группировка по подпапкам
    const groups = new Map();
    for (const item of s.notes.concat(files)) {
      const key = item.rel || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const list = el('div.kr-import-list');
    for (const [rel, items] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
      const groupCb = el('input', { attr: { type: 'checkbox' } });
      groupCb.checked = items.every((i) => i.selected);
      const rows = [];
      groupCb.addEventListener('change', () => {
        for (const i of items) i.selected = groupCb.checked;
        rows.forEach((r) => {
          r.querySelector('input').checked = groupCb.checked;
        });
        this.updateGo();
      });
      list.append(el('label.kr-import-group', [
        groupCb,
        icon(rel ? 'folder' : 'folder-root'),
        el('b', rel || basename(this.folder) || 'Корень'),
        el('span.kr-muted', String(items.length)),
      ]));
      for (const item of items) {
        const cb = el('input', { attr: { type: 'checkbox' } });
        cb.checked = item.selected;
        cb.addEventListener('change', () => {
          item.selected = cb.checked;
          groupCb.checked = items.every((i) => i.selected);
          this.updateGo();
        });
        let flags;
        if (item.kind === 'note') {
          const p = item.parsed;
          flags = this.mode === 'parse'
            ? [['логин', p.username], ['пароль', p.password], ['сайт', p.url], ['2FA', p.totp]].map(([l, v]) => el(`span.kr-flag${v ? '.is-on' : ''}`, l))
            : [el('span.kr-flag.is-on', 'текст')];
        } else {
          flags = [el('span.kr-flag.is-on', formatSize(item.size))];
        }
        const row = el('label.kr-import-row.is-nested', [
          cb,
          icon(item.kind === 'note' ? 'file-text' : 'paperclip'),
          el('div.kr-grow', [el('b', item.kind === 'note' ? item.file.basename : item.file.name)]),
          el('div.kr-flags', flags),
        ]);
        rows.push(row);
        list.append(row);
      }
    }
    host.append(list);
    if (s.skipped.length) {
      host.append(el('details.kr-skipped', [
        el('summary', `Пропущено: ${s.skipped.length}`),
        el('ul', s.skipped.map((x) => el('li', `${x.file.path} — ${x.reason}`))),
      ]));
    }
    this.updateGo();
  }

  updateGo() {
    if (!this.goBtn) return;
    const n = this.selectedItems().length;
    this.goBtn.disabled = !n || this.busy;
    this.goBtn.querySelector('span:last-child').textContent = n ? `Зашифровать ${n}` : 'Зашифровать';
  }

  async run() {
    if (this.busy) return;
    const items = this.selectedItems();
    if (!items.length) return;
    this.error.textContent = '';
    const manager = this.core.manager;
    let vault = this.targetVault();

    try {
      this.busy = true;
      this.updateGo();
      if (!vault) {
        // новая папка-хранилище
        const pw = this.inputs.pw ? this.inputs.pw.value : '';
        if (pw.length < 8) throw new Error('Мастер-пароль должен быть не короче 8 символов');
        if (pw !== this.inputs.pw2.value) throw new Error('Пароли не совпадают');
        const clash = manager.list().find((v) => this.folder.startsWith(`${v.folder}/`) || v.folder.startsWith(`${this.folder}/`));
        if (clash) throw new Error(`Папка пересекается с хранилищем «${clash.folder}»`);
        if (!this.folder) throw new Error('Корень хранилища Obsidian нельзя сделать хранилищем — выберите папку');
        this.progressText.textContent = 'Создание хранилища…';
        vault = await manager.create(this.folder, { name: basename(this.folder), password: pw, iterations: this.core.settings.iterations });
      } else if (!vault.unlocked) {
        this.progressText.textContent = 'Расшифровка ключа…';
        await manager.unlock(vault, this.inputs.unlock ? this.inputs.unlock.value : '');
      }

      const categoryBase = vault.folder === this.folder ? '' : (basename(this.folder) || 'Импорт');
      const result = await convertItems(this.core, vault, items, {
        mode: this.mode,
        deleteOriginals: this.deleteOriginals,
        categoryBase,
        onProgress: (i, n, path) => {
          this.progress.firstChild.style.width = `${(i / n) * 100}%`;
          this.progressText.textContent = `${i} / ${n} · ${path}`;
        },
      });
      manager.emit('change');
      let msg = `Зашифровано: ${result.converted}`;
      if (result.deleted) msg += `, исходников удалено: ${result.deleted}`;
      if (result.failed.length) msg += `. Ошибки (${result.failed.length}): ${result.failed.slice(0, 3).join('; ')}`;
      this.core.notice(msg, 9000);
      this.close();
      if (this.onDone) this.onDone(vault);
    } catch (e) {
      this.busy = false;
      this.updateGo();
      this.progressText.textContent = '';
      this.error.textContent = passwordErrorText(e);
    }
  }
}

module.exports = { ConvertFolderModal };
