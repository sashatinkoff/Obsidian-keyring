'use strict';
/* Модальные окна: подтверждение, ввод, создание хранилища, смена пароля, история, импорт. */
const { Modal, normalizePath } = require('obsidian');
const { el, icon, iconButton, button, clear } = require('../util/dom');
const { analyzePassword } = require('../crypto/strength');
const {
  formatDate, formatNumber, basename, countLabel, maskTail, formatCountdown,
} = require('../util/format');
const { CIPHER_LABEL, KDF_LABEL } = require('../constants');
const { attachFolderSuggest } = require('../util/suggest');
const { strengthMeter, checkbox } = require('./widgets');
const { fileBlob } = require('../vault/converter');

/** Текст ошибки пароля с учётом лимита попыток. */
function passwordErrorText(e, wrongText = 'Неверный мастер-пароль') {
  if (e && e.name === 'LockoutError') {
    return `Слишком много неверных попыток. Ввод пароля заблокирован ещё на ${formatCountdown(e.remainingMs)}.`;
  }
  if (e && e.name === 'WrongPasswordError') {
    if (e.lockedUntil) return `${wrongText}. Ввод пароля заблокирован на ${formatCountdown(e.lockedUntil - Date.now())}.`;
    if (Number.isFinite(e.attemptsLeft)) return `${wrongText} · осталось попыток: ${e.attemptsLeft}`;
    return wrongText;
  }
  return e ? e.message : '';
}

class BaseModal extends Modal {
  constructor(app, title) {
    super(app);
    this.modalEl.classList.add('kr-modal');
    this.titleText = title;
  }

  onOpen() {
    clear(this.contentEl);
    if (this.titleText) this.titleEl.textContent = this.titleText;
    this.build(this.contentEl);
  }

  onClose() {
    clear(this.contentEl);
  }

  build() {}
}

function passwordInput(placeholder, autocomplete = 'new-password') {
  return el('input.kr-input', { attr: { type: 'password', placeholder, autocomplete, spellcheck: 'false' } });
}

function labeled(label, control, aside) {
  return el('div.kr-form-field', [el('div.kr-form-label', [el('span', label), aside || null]), control]);
}

/* ---------- простые ---------- */

class ConfirmModal extends BaseModal {
  constructor(app, opts) {
    super(app, opts.title);
    this.opts = opts;
    this.result = false;
  }

  ask() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  build(c) {
    c.append(el('p.kr-modal-text', this.opts.message || ''));
    c.append(el('div.kr-modal-foot', [
      button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
      button(this.opts.cta || 'OK', null, () => {
        this.result = true;
        this.close();
      }, this.opts.danger ? 'kr-btn-danger' : 'kr-btn-primary'),
    ]));
  }

  onClose() {
    super.onClose();
    if (this.resolve) this.resolve(this.result);
  }
}

class PromptModal extends BaseModal {
  constructor(app, opts) {
    super(app, opts.title);
    this.opts = opts;
    this.result = null;
  }

  ask() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  build(c) {
    const input = el('input.kr-input', { attr: { type: 'text', placeholder: this.opts.placeholder || '' } });
    input.value = this.opts.value || '';
    const submit = () => {
      this.result = input.value;
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    if (this.opts.desc) c.append(el('p.kr-modal-text', this.opts.desc));
    c.append(input);
    c.append(el('div.kr-modal-foot', [
      button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
      button(this.opts.cta || 'OK', null, submit, 'kr-btn-primary'),
    ]));
    window.setTimeout(() => input.focus(), 20);
  }

  onClose() {
    super.onClose();
    if (this.resolve) this.resolve(this.result);
  }
}

/* ---------- новое хранилище ---------- */

class CreateVaultModal extends BaseModal {
  constructor(core, onDone) {
    super(core.app, 'Новое хранилище');
    this.core = core;
    this.onDone = onDone;
  }

  build(c) {
    const core = this.core;
    const existing = core.manager.list().map((v) => v.folder);
    const folder = el('input.kr-input', { attr: { type: 'text', placeholder: 'Пароли', spellcheck: 'false' } });
    folder.value = existing.includes('Пароли') ? '' : 'Пароли';
    attachFolderSuggest(this.app, folder);
    const name = el('input.kr-input', { attr: { type: 'text', placeholder: 'Название (по умолчанию — имя папки)' } });
    const pw = passwordInput('Мастер-пароль');
    const pw2 = passwordInput('Повторите мастер-пароль');
    const meter = el('div');
    const notesInfo = el('div');
    const error = el('div.kr-form-error');
    let importNotes = true;
    const ack = { value: false };

    const updateMeter = () => clear(meter).append(strengthMeter(analyzePassword(pw.value)));
    pw.addEventListener('input', updateMeter);
    updateMeter();

    const updateNotes = () => {
      clear(notesInfo);
      const path = normalizePath(folder.value.trim() || '/');
      const inside = this.app.vault.getFiles().filter((f) => f.path.startsWith(`${path}/`) && !f.path.endsWith('.kr'));
      if (inside.length && path !== '/') {
        notesInfo.append(checkbox(
          `После создания зашифровать ${countLabel(inside.length, ['файл', 'файла', 'файлов'])} из этой папки (рекурсивно)`,
          importNotes,
          (v) => { importNotes = v; }
        ));
      }
    };
    folder.addEventListener('input', updateNotes);
    updateNotes();

    const submit = async () => {
      error.textContent = '';
      const path = normalizePath(folder.value.trim());
      if (!path || path === '/') return void (error.textContent = 'Укажите папку (корень хранилища Obsidian нельзя).');
      const clash = existing.find((f) => f === path || path.startsWith(`${f}/`) || f.startsWith(`${path}/`));
      if (clash) return void (error.textContent = `Пересекается с хранилищем в «${clash}». Хранилища не могут быть вложены друг в друга.`);
      if (pw.value.length < 8) return void (error.textContent = 'Мастер-пароль должен быть не короче 8 символов.');
      if (pw.value !== pw2.value) return void (error.textContent = 'Пароли не совпадают.');
      if (!ack.value) return void (error.textContent = 'Подтвердите, что понимаете: пароль невозможно восстановить.');
      createBtn.disabled = true;
      createBtn.querySelector('span:last-child').textContent = 'Создание…';
      try {
        const vault = await core.manager.create(path, {
          name: name.value.trim() || basename(path),
          password: pw.value,
          iterations: core.settings.iterations,
        });
        this.close();
        core.notice(`Хранилище «${vault.name}» создано и открыто`);
        if (this.onDone) this.onDone(vault, importNotes);
      } catch (e) {
        createBtn.disabled = false;
        createBtn.querySelector('span:last-child').textContent = 'Создать хранилище';
        error.textContent = e.message;
      }
    };

    const createBtn = button('Создать хранилище', 'shield-check', submit, 'kr-btn-primary');
    c.append(
      el('p.kr-modal-text', 'Хранилище — это папка: в ней появится keyring.vault.json и зашифрованные файлы записей (*.kr). Подпапки станут категориями.'),
      labeled('Папка в Obsidian', folder, el('span.kr-form-aside', 'создастся, если её нет')),
      labeled('Название', name),
      labeled('Мастер-пароль', pw),
      meter,
      labeled('Повтор', pw2),
      notesInfo,
      el('div.kr-warn', [
        icon('alert-triangle'),
        el('div', [
          el('b', 'Пароль нигде не хранится и не восстанавливается.'),
          el('span', ' Если забыть его, данные хранилища будет невозможно расшифровать.'),
        ]),
      ]),
      checkbox('Понимаю, пароль запомню или сохраню в надёжном месте', false, (v) => { ack.value = v; }),
      el('div.kr-modal-meta', [
        el('span.kr-chip.kr-chip-mint', [icon('shield-check'), CIPHER_LABEL]),
        el('span.kr-chip', [icon('fingerprint'), `${KDF_LABEL} × ${formatNumber(core.settings.iterations)}`]),
      ]),
      error,
      el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), createBtn])
    );
    window.setTimeout(() => (folder.value ? pw : folder).focus(), 20);
  }
}

/* ---------- смена мастер-пароля ---------- */

class ChangePasswordModal extends BaseModal {
  constructor(core, vault) {
    super(core.app, `Мастер-пароль «${vault.name}»`);
    this.core = core;
    this.vault = vault;
  }

  build(c) {
    const cur = passwordInput('Текущий пароль', 'current-password');
    const pw = passwordInput('Новый пароль');
    const pw2 = passwordInput('Повторите новый пароль');
    const meter = el('div');
    const error = el('div.kr-form-error');
    pw.addEventListener('input', () => clear(meter).append(strengthMeter(analyzePassword(pw.value))));
    clear(meter).append(strengthMeter(analyzePassword('')));

    const submit = async () => {
      error.textContent = '';
      if (pw.value.length < 8) return void (error.textContent = 'Новый пароль должен быть не короче 8 символов.');
      if (pw.value !== pw2.value) return void (error.textContent = 'Новые пароли не совпадают.');
      btn.disabled = true;
      try {
        await this.core.manager.lockout.guard(this.vault, () => this.vault.changePassword(cur.value, pw.value, this.core.settings.iterations));
        this.close();
        this.core.notice('Мастер-пароль изменён');
        this.core.manager.emit('change');
      } catch (e) {
        btn.disabled = false;
        error.textContent = passwordErrorText(e, 'Текущий пароль неверен');
      }
    };
    const btn = button('Сменить пароль', 'key-round', submit, 'kr-btn-primary');
    c.append(
      el('p.kr-modal-text', 'Ключ данных перешифровывается новым паролем; сами записи не меняются. На других устройствах после синхронизации keyring.vault.json хранилище откроется новым паролем.'),
      labeled('Текущий пароль', cur),
      labeled('Новый пароль', pw),
      meter,
      labeled('Повтор', pw2),
      el('div.kr-modal-meta', [el('span.kr-chip', [icon('fingerprint'), `${KDF_LABEL} × ${formatNumber(this.core.settings.iterations)}`])]),
      error,
      el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), btn])
    );
    window.setTimeout(() => cur.focus(), 20);
  }
}

/* ---------- история версий пароля ---------- */

class HistoryModal extends BaseModal {
  constructor(view, vault, entry) {
    super(view.app, `История: ${entry.title}`);
    this.view = view;
    this.vault = vault;
    this.entry = entry;
    this.revealed = new Set();
  }

  build(c) {
    const e = this.vault.entries.get(this.entry.id) || this.entry;
    const rows = [{ password: e.password, changed: e.passwordChanged, current: true }].concat(e.history);
    const list = el('div.kr-history');
    rows.forEach((h, i) => {
      const shown = this.revealed.has(i);
      list.append(el(`div.kr-history-row${h.current ? '.is-current' : ''}`, [
        el('div.kr-history-dot'),
        el('div.kr-grow', [
          el('small', h.current ? `Текущий · с ${formatDate(h.changed)}` : `Действовал с ${formatDate(h.changed)}${h.replaced ? ` по ${formatDate(h.replaced)}` : ''}`),
          el('span.is-mono', shown ? h.password : maskTail(h.password, 2)),
        ]),
        iconButton(shown ? 'eye-off' : 'eye', 'Показать', () => {
          if (shown) this.revealed.delete(i);
          else this.revealed.add(i);
          this.onOpen();
        }),
        iconButton('copy', 'Скопировать', () => this.view.copy(h.password, 'старый пароль')),
        h.current ? null : button('Восстановить', 'undo-2', () => this.restore(i - 1), 'kr-btn-ghost kr-btn-sm'),
      ]));
    });
    c.append(list);
  }

  async restore(index) {
    const e = this.vault.entries.get(this.entry.id);
    const old = e.history[index];
    const now = Date.now();
    const history = e.history.filter((_, i) => i !== index);
    history.unshift({ password: e.password, changed: e.passwordChanged, replaced: now });
    const updated = Object.assign({}, e, {
      password: old.password,
      passwordChanged: now,
      updated: now,
      history: history.slice(0, Math.max(1, Number(this.view.settings.historyLimit) || 1)),
    });
    await this.vault.save(updated);
    this.view.core.notice('Пароль восстановлен из истории');
    this.close();
    this.view.render();
  }
}

/* ---------- просмотр вложения (только в памяти) ---------- */

class FilePreviewModal extends BaseModal {
  constructor(view, entry) {
    super(view.app, entry.file ? entry.file.name : entry.title);
    this.view = view;
    this.entry = entry;
    this.modalEl.classList.add('kr-modal-wide');
  }

  build(c) {
    const f = this.entry.file;
    if (!f) return;
    this.url = URL.createObjectURL(fileBlob(this.entry));
    let body;
    if (f.mime.startsWith('image/')) body = el('img.kr-preview-img', { attr: { src: this.url, alt: f.name } });
    else if (f.mime === 'application/pdf') body = el('iframe.kr-preview-frame', { attr: { src: this.url } });
    else {
      body = el('pre.kr-preview-text');
      fileBlob(this.entry).text().then((t) => { body.textContent = t; });
    }
    c.append(body, el('p.kr-hint', [icon('shield-check'), 'Файл расшифрован только в памяти и не записывается на диск.']));
  }

  onClose() {
    super.onClose();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

module.exports = {
  FilePreviewModal,
  passwordErrorText, BaseModal, ConfirmModal, PromptModal, CreateVaultModal, ChangePasswordModal, HistoryModal, passwordInput, labeled,
};
