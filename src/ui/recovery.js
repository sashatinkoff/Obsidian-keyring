'use strict';
/* Ключ восстановления: создание, статус по хранилищам, сброс забытого пароля. */
const { el, icon, button, clear } = require('../util/dom');
const { formatDate } = require('../util/format');
const { generateRecoveryKeyPair } = require('../crypto/cipher');
const { analyzePassword } = require('../crypto/strength');
const {
  toText, toPrintable, toKeyFile, parseRecoveryKey,
} = require('../util/recovery-key');
const {
  BaseModal, ConfirmModal, passwordInput, labeled, passwordErrorText,
} = require('./modals');
const { strengthMeter, checkbox } = require('./widgets');
const headerStore = require('../vault/header-store');

function download(name, text) {
  const type = name.endsWith('.json') ? 'application/json' : 'text/plain';
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- создание ключа ---------- */

class CreateRecoveryKeyModal extends BaseModal {
  constructor(view, opts = {}) {
    super(view.app, view.core.settings.recovery ? 'Новый ключ восстановления' : 'Ключ восстановления');
    this.view = view;
    this.core = view.core;
    this.vault = opts.vault && opts.vault.unlocked ? opts.vault : null;
    this.pair = null;
    this.saved = { file: false, text: false };
    this.confirmed = false;
  }

  async onOpen() {
    super.onOpen();
  }

  build(c) {
    if (this.done && this.pair) {
      this.buildKit(c);
      return;
    }
    const replacing = !!this.core.settings.recovery;
    if (!this.pair) {
      c.append(
        el('p.kr-modal-text', 'Ключ восстановления — запасной способ открыть хранилища, если мастер-пароль забыт. '
          + 'Keyring создаст пару ключей: открытый останется в настройках плагина и будет «запечатывать» ключ каждого хранилища, '
          + 'а закрытый вы сохраните у себя — файлом и/или распечаткой.'),
        el('ul.kr-onboard-list', [
          el('li', [icon('shield-check'), 'Новые хранилища защищаются автоматически, существующие — при следующей разблокировке']),
          el('li', [icon('key-round'), 'Мастер-пароли не нужны для восстановления — только этот ключ']),
          el('li', [icon('alert-triangle'), 'Кто получит закрытый ключ, откроет все хранилища. Не кладите его в хранилище Obsidian и в папки Syncthing']),
        ]),
        replacing ? el('div.kr-warn', [icon('alert-triangle'), el('div', [
          el('b', 'Ключ уже есть — он будет заменён.'),
          el('span', ' Новый ключ «запечатает» хранилища, а старый файл перестанет их открывать: в текущем хранилище — сразу (если ввести пароль), в остальных — при их разблокировке.'),
        ])]) : null,
        el('div.kr-modal-foot', [
          button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
          button(replacing ? 'Создать новый ключ' : 'Создать ключ', 'key-round', async () => {
            this.pair = await generateRecoveryKeyPair();
            this.pair.created = Date.now();
            this.onOpen();
          }, 'kr-btn-primary'),
        ])
      );
      return;
    }

    const { id, privateJwk, created } = this.pair;
    const text = toText(id, privateJwk);
    const fileName = `keyring-recovery-${id}.key`;
    const status = el('div.kr-recovery-status');
    const refreshStatus = () => {
      clear(status).append(
        el(`span.kr-flag${this.saved.file ? '.is-on' : ''}`, 'файл'),
        el(`span.kr-flag${this.saved.text ? '.is-on' : ''}`, 'текст'),
      );
    };
    refreshStatus();

    // replacing — объявлен выше
    const finish = button(replacing ? 'Ключ сохранён — заменить' : 'Ключ сохранён — включить', 'shield-check', async () => {
      if (!this.confirmed) return;
      const settings = this.core.settings;
      const newRec = { id, publicJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y }, created };
      finish.disabled = true;
      const old = settings.recovery;
      if (old && old.id !== id) settings.retiredRecovery = Array.from(new Set([...(settings.retiredRecovery || []), old.id]));
      settings.recovery = newRec;
      await this.core.saveSettings();
      // все открытые хранилища защищаются сразу, без пароля
      const applied = await this.view.manager.applyRecoveryToUnlocked();
      const locked = this.view.manager.list().filter((v) => !v.unlocked).map((v) => `«${v.name}»`);
      this.core.notice(`${replacing ? 'Ключ заменён' : 'Ключ восстановления включён'}.`
        + `${applied.length ? ` Защищены: ${applied.map((n) => `«${n}»`).join(', ')}.` : ''}`
        + `${locked.length ? ` ${locked.join(', ')} — при разблокировке.` : ''}`, 8000);
      this.done = true;
      this.view.render();
      this.onOpen(); // шаг «комплект восстановления»
    }, 'kr-btn-primary');
    finish.disabled = true;

    c.append(
      el('div.kr-recovery-id', [icon('fingerprint'), el('span', 'ID ключа'), el('b.is-mono', id), el('small', formatDate(created))]),
      el('p.kr-modal-text', 'Сохраните закрытый ключ сейчас — после закрытия окна показать его снова будет невозможно.'),
      el('div.kr-recovery-actions', [
        button('Скачать файл ключа', 'download', () => {
          download(fileName, toKeyFile(id, privateJwk, created));
          this.saved.file = true;
          refreshStatus();
        }, 'kr-btn-soft'),
        button('Скопировать текст', 'copy', async () => {
          try {
            await navigator.clipboard.writeText(text);
            this.core.notice('Текст ключа скопирован. Вставьте его туда, где храните, и очистите буфер.', 5000);
          } catch (e) {
            this.core.notice('Не удалось скопировать — перепишите текст вручную');
          }
          this.saved.text = true;
          refreshStatus();
        }, 'kr-btn-soft'),
        button('Распечатать', 'printer', () => {
          const w = window.open('', '_blank');
          if (!w) return;
          w.document.write(`<pre style="font:16px/1.6 monospace;padding:24px">Keyring — ключ восстановления\nID: ${id}\nСоздан: ${formatDate(created)}\n\n${toPrintable(text)}\n\nХраните отдельно от устройств с Obsidian.</pre>`);
          w.document.close();
          w.print();
          this.saved.text = true;
          refreshStatus();
        }, 'kr-btn-soft'),
      ]),
      el('pre.kr-recovery-text', toPrintable(text)),
      status,
      el('div.kr-warn', [icon('alert-triangle'), el('div', [
        el('b', 'Где хранить:'),
        el('span', ' на флешке или распечатке в надёжном месте, в другом менеджере паролей. '
          + 'Не в этом хранилище Obsidian и не в папках, которые синхронизирует Syncthing.'),
      ])]),
      this.applyHint(replacing),
      checkbox('Я сохранил закрытый ключ вне хранилища', false, (v) => {
        this.confirmed = v;
        finish.disabled = !v;
      }),
      el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), finish])
    );
  }

  /** Какие хранилища получат ключ сразу, а какие — при разблокировке. */
  applyHint(replacing) {
    const list = this.core.manager.list();
    const open = list.filter((v) => v.unlocked).map((v) => `«${v.name}»`);
    const closed = list.filter((v) => !v.unlocked).map((v) => `«${v.name}»`);
    const parts = [];
    if (open.length) parts.push(`${open.join(', ')} ${open.length > 1 ? 'открыты и будут защищены' : 'открыто и будет защищено'} сразу`);
    if (closed.length) parts.push(`${closed.join(', ')} — при следующей разблокировке паролем`);
    if (replacing) parts.push('старый ключ перестанет действовать там же');
    return parts.length ? el('p.kr-hint', [icon('info'), `${parts.join('; ')}.`]) : null;
  }

  /** Последний шаг: ключ + копии заголовков хранилищ, уже защищённых этим ключом. */
  buildKit(c) {
    const { id, privateJwk, created } = this.pair;
    const sealed = this.core.manager.list().filter((v) => v.hasRecovery(id));
    c.append(
      el('div.kr-recovery-id', [icon('shield-check'), el('span', 'Ключ включён'), el('b.is-mono', id)]),
      el('p.kr-modal-text', 'Рекомендуем скачать «комплект восстановления» — тот же ключ плюс копии заголовков хранилищ (keyring.vault.json). '
        + 'С ним можно открыть хранилище, даже если заголовок в папке утерян. Заголовки секретов не содержат.'),
      el('div.kr-vault-list', sealed.length ? sealed.map((v) => el('div.kr-vault-row.is-active', [icon('shield-check'), el('div.kr-grow', [el('b', v.name), el('small.is-mono', v.folder)])]))
        : [el('div.kr-muted', 'Пока ни одно хранилище не защищено этим ключом — заголовки появятся в файле после разблокировки хранилищ.')]),
      el('div.kr-recovery-actions', [
        button('Скачать комплект восстановления', 'download', () => {
          const headers = sealed.map((v) => ({ folder: v.folder, name: v.name, header: v.header }));
          download(`keyring-recovery-${id}.key`, toKeyFile(id, privateJwk, created, headers));
        }, 'kr-btn-primary'),
      ]),
      el('p.kr-hint', [icon('info'), 'Этот файл заменяет скачанный ранее файл ключа: ключ в нём тот же.']),
      el('div.kr-modal-foot', [button('Готово', null, () => this.close(), 'kr-btn-ghost')])
    );
  }

  onClose() {
    this.pair = null;
    this.done = false;
    super.onClose();
    this.view.render();
  }
}

/* ---------- вход / восстановление по ключу ---------- */

/** Открыть системный выбор файла и вернуть текст (или null). */
function pickKeyFile() {
  return new Promise((resolve) => {
    const picker = document.createElement('input');
    picker.type = 'file';
    // без ограничения типа: подойдёт файл любого формата и с любым расширением
    picker.style.display = 'none';
    picker.addEventListener('change', async () => {
      const f = picker.files && picker.files[0];
      picker.remove();
      resolve(f ? { name: f.name, text: await f.text() } : null);
    });
    document.body.appendChild(picker);
    picker.click();
  });
}

class RecoverModal extends BaseModal {
  /**
   * opts.mode: 'open' — только открыть, 'reset' — открыть и задать новый пароль.
   * opts.file: { name, text } — уже выбранный файл ключа.
   */
  constructor(view, vault, opts = {}) {
    super(view.app, `Ключ восстановления — «${vault.name}»`);
    this.view = view;
    this.vault = vault;
    this.mode = opts.mode || 'open';
    this.keyText = opts.file ? opts.file.text : '';
    this.fileName = opts.file ? opts.file.name : '';
    this.showText = false;
    this.modalEl.classList.add('kr-recover-modal');
  }

  parsed() {
    try {
      return { key: parseRecoveryKey(this.keyText) };
    } catch (e) {
      return { error: this.keyText.trim() ? e.message : '' };
    }
  }

  /** Копии заголовков из того же файла (комплект восстановления): сначала для этой папки. */
  altHeaders() {
    let list = [];
    try {
      list = headerStore.parseHeaders(this.keyText);
    } catch (e) {
      return [];
    }
    const own = list.filter((h) => h.folder === this.vault.folder);
    const rest = list.filter((h) => h.folder !== this.vault.folder);
    return own.concat(rest).map((h) => h.header);
  }

  onOpen() {
    // перечитать заголовок: он мог измениться на другом устройстве
    if (!this.headerChecked) {
      this.headerChecked = true;
      this.vault.refreshHeader().catch(() => {}).then(() => this.onOpen());
    }
    super.onOpen();
  }

  /** Почему ключ не подходит — и что делать. */
  diagnose(key, alt) {
    const settings = this.view.core.settings;
    const ids = this.vault.recoveryIds;
    const current = settings.recovery && settings.recovery.id;
    const retired = (settings.retiredRecovery || []).includes(key.id);
    const kitHit = alt.some((h) => Array.isArray(h.recovery) && h.recovery.some((w) => w.keyId === key.id));
    let title;
    let text;
    if (kitHit) {
      title = 'В файле есть копия заголовка с этим ключом.';
      text = 'Keyring откроет хранилище по ней, проверит на записях папки и снова добавит ключ в хранилище.';
    } else if (retired) {
      title = 'Этот ключ был заменён новым.';
      text = `Старый ключ удаляется из хранилища при разблокировке паролем. Нужен файл текущего ключа${current ? ` ${current}` : ''}.`;
    } else if (key.id === current) {
      title = 'Это текущий ключ, но хранилище его ещё не получило.';
      text = 'Ключ добавляется при разблокировке паролем. Хранилище не открывалось паролем на этом устройстве после создания ключа — или создано на другом устройстве с другим ключом.';
    } else {
      title = 'Ключ создан на другом устройстве или в другой установке плагина.';
      text = 'Этим ключом хранилище не «запечатано». Попробуйте другой файл ключа или комплект восстановления.';
    }
    const known = ids.length
      ? el('div.kr-keyids', [el('span', 'Ключи в хранилище:'), ...ids.map((id) => el(`code${id === current ? '.is-current' : ''}`, id + (id === current ? ' · текущий' : '')))])
      : null;
    return el(`div.kr-warn${kitHit ? '.is-ok' : ''}`, [icon(kitHit ? 'shield-check' : 'alert-triangle'), el('div', [el('b', title), el('span', ` ${text}`), known])]);
  }

  build(c) {
    const vault = this.vault;
    const { key, error: parseError } = this.parsed();
    const matches = key ? vault.hasRecovery(key.id) : false;
    const alt = key && !matches ? this.altHeaders() : [];
    const kitHit = !!key && alt.some((h) => Array.isArray(h.recovery) && h.recovery.some((w) => w.keyId === key.id));

    if (!vault.hasRecovery() && !alt.length) {
      c.append(el('div.kr-warn', [icon('alert-triangle'), el('div', [
        el('b', 'В этом хранилище ключ восстановления ещё не сохранён.'),
        el('span', ' Ключ попадает в хранилище, когда оно открыто: при создании ключа или при следующем входе паролем. '
          + 'Войдите паролем один раз — после этого файл ключа будет открывать хранилище.'),
      ])]));
    }

    // 1. файл ключа — главный способ
    const drop = el(`div.kr-keydrop${key ? '.is-loaded' : ''}${key && !matches && !kitHit ? '.is-miss' : ''}${parseError ? '.is-bad' : ''}`, {
      attr: { role: 'button', tabindex: '0' },
    }, [
      icon(key ? (matches ? 'shield-check' : 'shield-alert') : 'upload'),
      el('div.kr-grow', key
        ? [el('b', this.fileName || 'Ключ из текста'), el('small', matches ? `ключ ${key.id} — подходит к этому хранилищу` : (kitHit ? `ключ ${key.id} — найден в копии заголовка из файла` : `ключ ${key.id} — не найден в этом хранилище`))]
        : [el('b', 'Выбрать файл ключа восстановления'), el('small', parseError || 'файл любого формата с ключом — или перетащите его сюда')]),
      key ? button('Другой файл', null, () => choose(), 'kr-btn-ghost kr-btn-sm') : null,
    ]);
    const choose = async () => {
      const f = await pickKeyFile();
      if (!f) return;
      this.keyText = f.text;
      this.fileName = f.name;
      this.onOpen();
    };
    drop.addEventListener('click', (e) => {
      if (!e.target.closest('button')) choose();
    });
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') choose();
    });
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      this.keyText = await f.text();
      this.fileName = f.name;
      this.onOpen();
    });
    c.append(drop);
    if (key && !matches && (vault.hasRecovery() || kitHit)) c.append(this.diagnose(key, alt));

    // 2. или текст (распечатка)
    const textToggle = el('button.kr-link', { attr: { type: 'button' } }, [icon(this.showText ? 'chevron-up' : 'chevron-down'), 'Ввести ключ текстом (с распечатки)']);
    textToggle.addEventListener('click', () => {
      this.showText = !this.showText;
      this.onOpen();
    });
    c.append(textToggle);
    if (this.showText) {
      const ta = el('textarea.kr-input.kr-textarea', {
        attr: { rows: 4, placeholder: 'KEYRING-RECOVERY-1:…', spellcheck: 'false' },
      });
      ta.value = this.fileName ? '' : this.keyText;
      ta.addEventListener('change', () => {
        this.keyText = ta.value;
        this.fileName = '';
        this.onOpen();
      });
      c.append(ta);
    }

    // 3. что сделать
    const seg = el('div.kr-seg.kr-seg-full', [
      ['open', 'Только открыть', 'lock-open'],
      ['reset', 'Открыть и сменить пароль', 'key-round'],
    ].map(([id, label, ic]) => el(`button.kr-seg-btn${this.mode === id ? '.is-active' : ''}`, {
      attr: { type: 'button' },
      on: {
        click: () => {
          this.mode = id;
          this.onOpen();
        },
      },
    }, [icon(ic), el('span', label)])));
    c.append(labeled('Действие', seg));

    let pw = null;
    let pw2 = null;
    if (this.mode === 'reset') {
      pw = passwordInput('Новый мастер-пароль');
      pw2 = passwordInput('Повторите новый пароль');
      const meter = el('div', [strengthMeter(analyzePassword(''))]);
      pw.addEventListener('input', () => clear(meter).append(strengthMeter(analyzePassword(pw.value))));
      c.append(labeled('Новый мастер-пароль', pw), meter, labeled('Повтор', pw2));
    } else {
      c.append(el('p.kr-hint', [icon('info'), 'Хранилище откроется на эту сессию, мастер-пароль останется прежним.']));
    }

    const error = el('div.kr-form-error');
    const go = async () => {
      error.textContent = '';
      if (!key) {
        error.textContent = parseError || 'Выберите файл ключа или введите его текст.';
        return;
      }
      if (this.mode === 'reset') {
        if (pw.value.length < 8) return void (error.textContent = 'Новый пароль должен быть не короче 8 символов.');
        if (pw.value !== pw2.value) return void (error.textContent = 'Пароли не совпадают.');
      }
      btn.disabled = true;
      try {
        if (this.mode === 'reset') await this.view.manager.recover(vault, key.privateJwk, pw.value, { altHeaders: alt });
        else await this.view.manager.unlockWithKey(vault, key.privateJwk, { altHeaders: alt });
        this.keyText = '';
        this.close();
        this.view.core.notice(this.mode === 'reset' ? 'Доступ восстановлен, мастер-пароль заменён' : 'Хранилище открыто ключом восстановления', 6000);
      } catch (e) {
        btn.disabled = false;
        error.textContent = e.message;
      }
    };
    const btn = button(this.mode === 'reset' ? 'Открыть и задать пароль' : 'Открыть хранилище', 'lock-open', go, 'kr-btn-primary');
    btn.disabled = !key;
    c.append(error, el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), btn]));
  }

  onClose() {
    this.keyText = '';
    super.onClose();
  }
}

/* ---------- добавить ключ к хранилищу сейчас ---------- */

class AddRecoveryNowModal extends BaseModal {
  constructor(view, vault) {
    super(view.app, `Ключ восстановления для «${vault.name}»`);
    this.view = view;
    this.vault = vault;
  }

  build(c) {
    const pw = passwordInput('Мастер-пароль хранилища', 'current-password');
    const error = el('div.kr-form-error');
    const go = async () => {
      btn.disabled = true;
      try {
        await this.view.manager.lockout.guard(this.vault, () => this.vault.addRecovery(pw.value, this.view.core.settings.recovery));
        this.close();
        this.view.core.notice('Ключ восстановления добавлен');
        this.view.render();
      } catch (e) {
        btn.disabled = false;
        error.textContent = passwordErrorText(e);
      }
    };
    pw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const btn = button('Добавить', 'shield-check', go, 'kr-btn-primary');
    c.append(
      el('p.kr-modal-text', 'Чтобы «запечатать» ключ хранилища ключом восстановления, нужен мастер-пароль — один раз.'),
      pw,
      error,
      el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), btn])
    );
    window.setTimeout(() => pw.focus(), 20);
  }
}

/* ---------- копии заголовков ---------- */

class RestoreHeaderModal extends BaseModal {
  constructor(view, folder) {
    super(view.app, 'Восстановить заголовок хранилища');
    this.view = view;
    this.folder = folder || '';
    this.found = null;
    this.pick = 0;
  }

  build(c) {
    c.append(el('p.kr-modal-text', 'Выберите файл с копией заголовка: «комплект восстановления» (файл ключа), экспорт заголовков, '
      + 'keyring.vault.backup.json или старый keyring.vault.json — подойдёт файл любого формата.'));
    const folder = el('input.kr-input', { attr: { type: 'text', placeholder: 'Папка хранилища' } });
    folder.value = this.folder;
    folder.addEventListener('input', () => { this.folder = folder.value.trim(); });
    c.append(labeled('Папка хранилища', folder));
    c.append(button(this.found ? 'Выбрать другой файл' : 'Выбрать файл…', 'upload', async () => {
      const f = await pickKeyFile();
      if (!f) return;
      try {
        this.found = headerStore.parseHeaders(f.text);
        this.pick = Math.max(0, this.found.findIndex((h) => h.folder === this.folder));
        if (!this.folder && this.found[this.pick].folder) this.folder = this.found[this.pick].folder;
        this.error = '';
      } catch (e) {
        this.found = null;
        this.error = e.message;
      }
      this.onOpen();
    }, 'kr-btn-soft'));
    if (this.error) c.append(el('div.kr-form-error', this.error));
    if (this.found) {
      c.append(el('div.kr-vault-list', this.found.map((h, i) => el(`div.kr-vault-row${i === this.pick ? '.is-active' : ''}`, {
        on: { click: () => { this.pick = i; if (h.folder) this.folder = h.folder; this.onOpen(); } },
      }, [
        icon(i === this.pick ? 'check-circle-2' : 'file-text'),
        el('div.kr-grow', [el('b', h.name || 'Хранилище'), el('small.is-mono', h.folder || 'папка не указана')]),
        el('small.kr-muted', h.header.recovery && h.header.recovery.length ? 'есть ключ восстановления' : ''),
      ]))));
    }
    const err = el('div.kr-form-error');
    const go = button('Восстановить', 'shield-check', async () => {
      const h = this.found && this.found[this.pick];
      if (!h) return;
      const target = (this.folder || h.folder || '').replace(/^\/+|\/+$/g, '');
      if (!target) return void (err.textContent = 'Укажите папку хранилища');
      try {
        await headerStore.restoreHeaderTo(this.view.app.vault.adapter, target, h.header);
        await this.view.manager.discover();
        this.close();
        this.view.core.notice(`Заголовок восстановлен: ${target}. Откройте хранилище паролем или ключом восстановления.`, 7000);
        this.view.selectVault(target);
      } catch (e) {
        err.textContent = e.message;
      }
    }, 'kr-btn-primary');
    go.disabled = !this.found;
    c.append(err, el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), go]));
  }
}

function renderHeaderPanel(view) {
  const vaults = view.manager.list();
  const backups = view.core.settings.headerBackups || {};
  const orphans = headerStore.orphanFolders(view.app, vaults.map((v) => v.folder));
  const panel = el('section.kr-panel.kr-recovery-panel');
  panel.append(el('div.kr-panel-head', [icon('copy'), el('span', 'Копии заголовков')]));
  panel.append(el('p.kr-hint', [icon('info'), 'keyring.vault.json хранит зашифрованный ключ данных: без него записи не открыть. '
    + 'Keyring держит копию рядом (keyring.vault.backup.json) и в настройках плагина и сам восстанавливает пропавший заголовок.']));
  panel.append(el('div.kr-vault-list', vaults.map((v) => el('div.kr-vault-row.is-active', [
    icon('shield-check'),
    el('div.kr-grow', [el('b', v.name), el('small', `копии: в папке${backups[v.folder] ? ', в настройках' : ''}`)]),
  ]))));
  if (orphans.length) {
    panel.append(el('div.kr-warn', [icon('alert-triangle'), el('div', [
      el('b', 'Найдены записи без заголовка.'),
      el('span', ' Восстановите заголовок из комплекта восстановления или экспорта.'),
    ])]));
    panel.append(el('div.kr-vault-list', orphans.map((o) => el('div.kr-vault-row', [
      icon('file-warning'),
      el('div.kr-grow', [el('b', o.name), el('small', `${o.count} зашифр. файлов без keyring.vault.json`)]),
      button('Восстановить…', null, () => new RestoreHeaderModal(view, o.folder).open(), 'kr-btn-ghost kr-btn-sm'),
    ]))));
  }
  panel.append(el('div.kr-actions-row', [
    button('Скачать копию заголовков', 'download', () => {
      download(`keyring-headers-${new Date().toISOString().slice(0, 10)}.json`, headerStore.exportHeaders(vaults));
    }, 'kr-btn-soft'),
    button('Восстановить заголовок из файла…', 'upload', () => new RestoreHeaderModal(view, '').open(), 'kr-btn-ghost'),
  ]));
  return panel;
}

/* ---------- панель в настройках ---------- */

function renderRecoveryPanel(view) {
  const rec = view.core.settings.recovery;
  const vaults = view.manager.list();
  const panel = el('section.kr-panel.kr-recovery-panel');
  panel.append(el('div.kr-panel-head', [icon('life-buoy'), el('span', 'Восстановление доступа'), el('div.kr-spacer'),
    el(`span.kr-chip${rec ? '.kr-chip-mint' : ''}`, rec ? 'включено' : 'выключено')]));

  if (!rec) {
    panel.append(
      el('p.kr-hint', [icon('info'), 'Если забыть мастер-пароль, данные не вернуть. Ключ восстановления — запасной вход: '
        + 'закрытый ключ хранится у вас вне Obsidian, им можно задать новый пароль.']),
      el('div.kr-actions-row', [button('Создать ключ восстановления', 'key-round', () => new CreateRecoveryKeyModal(view, { vault: view.vault }).open(), 'kr-btn-primary')])
    );
    return panel;
  }

  panel.append(el('div.kr-info', [
    el('div.kr-info-row', [el('span', 'ID ключа'), el('b.is-mono', rec.id)]),
    el('div.kr-info-row', [el('span', 'Создан'), el('b', formatDate(rec.created))]),
    (view.core.settings.retiredRecovery || []).length
      ? el('div.kr-info-row', [el('span', 'Отозванные ключи'), el('b.is-mono', view.core.settings.retiredRecovery.join(', '))])
      : null,
  ]));
  panel.append(el('div.kr-vault-list', vaults.map((v) => {
    const ok = v.hasRecovery(rec.id);
    const other = !ok && v.hasRecovery();
    return el(`div.kr-vault-row${ok ? '.is-active' : ''}`, [
      icon(ok ? 'shield-check' : 'shield-alert'),
      el('div.kr-grow', [
        el('b', v.name),
        el('small', ok
          ? (v.recoveryIds.length > 1 ? 'защищено этим ключом + старые ключи' : 'защищено этим ключом')
          : other ? 'только старым ключом — обновится при разблокировке' : 'ещё не защищено — добавится при разблокировке'),
      ]),
      ok ? null : button('Добавить сейчас', null, async () => {
        if (v.unlocked) {
          // открытое хранилище — пароль не нужен
          await v.syncRecovery([view.core.settings.recovery]);
          view.core.notice(`«${v.name}»: ключ восстановления добавлен`);
          view.render();
        } else new AddRecoveryNowModal(view, v).open();
      }, 'kr-btn-ghost kr-btn-sm'),
      v.recoveryIds.some((x) => x !== rec.id) ? button('Убрать старые', null, async () => {
        const yes = await new ConfirmModal(view.app, {
          title: 'Убрать старые ключи восстановления?',
          message: `В «${v.name}» останется только текущий ключ ${rec.id}${ok ? '' : ' (после его добавления)'}. Старые файлы ключей перестанут открывать это хранилище.`,
          cta: 'Убрать',
          danger: true,
        }).ask();
        if (!yes) return;
        if (!ok) {
          view.core.notice('Сначала добавьте текущий ключ к хранилищу');
          return;
        }
        await v.removeRecovery(rec.id);
        view.render();
      }, 'kr-btn-ghost kr-btn-sm') : null,
    ]);
  })));
  panel.append(el('div.kr-actions-row', [
    button('Сменить ключ (новый файл)', 'refresh-cw', () => new CreateRecoveryKeyModal(view, { vault: view.vault }).open(), 'kr-btn-soft'),
    button('Выключить', 'x', async () => {
      const yes = await new ConfirmModal(view.app, {
        title: 'Выключить ключ восстановления?',
        message: 'Новые хранилища перестанут получать ключ. Уже защищённые хранилища останутся открываемыми этим ключом, пока вы не уберёте его вручную.',
        cta: 'Выключить',
      }).ask();
      if (!yes) return;
      view.core.settings.recovery = null;
      await view.core.saveSettings();
      view.render();
    }, 'kr-btn-ghost'),
  ]));
  return panel;
}

module.exports = {
  CreateRecoveryKeyModal, RecoverModal, AddRecoveryNowModal, RestoreHeaderModal, renderRecoveryPanel, renderHeaderPanel, pickKeyFile,
};
