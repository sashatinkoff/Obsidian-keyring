'use strict';
/* Панель создания/редактирования записи со встроенным генератором. */
const { ENTRY_TYPES, SECRET_TYPES, CIPHER_LABEL, MAX_FILE_MB } = require('../constants');
const { generatePin, analyzePin } = require('../crypto/pin');
const { toBase64 } = require('../crypto/codec');
const { formatSize, mimeOf } = require('../vault/converter');
const { el, icon, iconButton, button, clear } = require('../util/dom');
const { generatePassword } = require('../crypto/generator');
const { analyzePassword } = require('../crypto/strength');
const { parseTotp, totpCode, formatCode } = require('../crypto/totp');
const { newEntry, cloneEntry } = require('../vault/entry');
const { PromptModal } = require('./modals');
const { strengthMeter, generatorOptions, checkbox } = require('./widgets');

class EditorPanel {
  constructor(view, vault, entry, opts = {}) {
    this.view = view;
    this.vault = vault;
    this.isNew = !entry;
    this.original = entry || null;
    this.draft = entry ? cloneEntry(entry) : newEntry(opts.type || 'login', view.state.category || '');
    if (opts.prefill) Object.assign(this.draft, cloneEntry(opts.prefill), { id: this.draft.id, category: this.draft.category });
    this.gen = Object.assign({}, view.settings.generator);
    this.pinGen = Object.assign({ length: 4, avoidWeak: true }, view.settings.pinGenerator);
    if (this.isNew && SECRET_TYPES.includes(this.draft.type)) this.draft.password = this.freshSecret(this.draft.type);
    this.showPassword = this.isNew;
    this.tagsText = this.draft.tags.join(', ');
    this.el = el('aside.kr-editor');
    this.build();
  }

  /** Новый секрет для типа: PIN — цифры, остальное — пароль по настройкам генератора. */
  freshSecret(type) {
    return type === 'pin' ? generatePin(this.pinGen.length, this.pinGen) : generatePassword(this.gen);
  }

  focus() {
    window.setTimeout(() => {
      const input = this.el.querySelector('[data-focus]');
      if (input) input.focus();
    }, 30);
  }

  field(label, aside, control, cls) {
    return el(`div.kr-form-field${cls ? `.${cls}` : ''}`, [
      el('div.kr-form-label', [el('span', label), aside ? el('span.kr-form-aside', aside) : null]),
      control,
    ]);
  }

  /** Кнопка копирования текущего значения поля ввода. */
  copyInput(input, label) {
    return iconButton('copy', `Скопировать: ${label}`, (e) => {
      e.preventDefault();
      this.view.copy(input.value, label);
    }, 'kr-copy-btn');
  }

  input(key, iconName, placeholder, extra = {}) {
    const input = el('input.kr-input', {
      attr: Object.assign({
        type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off',
      }, extra.attr || {}),
    });
    input.value = this.draft[key] || '';
    input.addEventListener('input', () => {
      this.draft[key] = input.value;
      if (extra.onInput) extra.onInput(input.value);
    });
    return el('label.kr-input-wrap', [icon(iconName), input, this.copyInput(input, extra.copyLabel || 'значение')]);
  }

  build() {
    const d = this.draft;
    const type = ENTRY_TYPES[d.type] || ENTRY_TYPES.login;
    clear(this.el);

    const head = el('div.kr-editor-head', [
      el('div.kr-editor-title', [
        icon(this.isNew ? 'file-plus-2' : 'file-pen-line'),
        el('h2', this.isNew ? 'Новая запись' : 'Редактирование'),
      ]),
      el('span.kr-chip.kr-chip-violet', CIPHER_LABEL),
      iconButton('x', 'Закрыть (Esc)', () => this.view.closeEditor(), 'kr-editor-close'),
    ]);

    const typeSeg = el('div.kr-seg.kr-seg-full', Object.entries(ENTRY_TYPES).map(([id, t]) => el(`button.kr-seg-btn${d.type === id ? '.is-active' : ''}`, {
      attr: { type: 'button' },
      on: {
        click: () => {
          if (d.type === id) return;
          const wasPin = d.type === 'pin';
          d.type = id;
          if (SECRET_TYPES.includes(id)) {
            // у новой записи сгенерированный пароль меняем на PIN и обратно
            if (!d.password || (this.isNew && (id === 'pin' ? !/^\d+$/.test(d.password) : wasPin))) d.password = this.freshSecret(id);
          }
          this.build();
        },
      },
    }, [icon(t.icon), el('span', t.label)])));

    const body = el('div.kr-editor-body', [typeSeg]);

    const titleWrap = this.input('title', 'id-card', 'Например, GitHub', { attr: { 'data-focus': true }, copyLabel: 'название' });
    body.append(this.field('Название сервиса / записи', el('span.is-req', '*обязательно'), titleWrap));
    const hasSecret = SECRET_TYPES.includes(d.type);
    const isPin = d.type === 'pin';
    if (hasSecret && !isPin) {
      body.append(this.field('Ссылка / URL', null, this.input('url', 'link', 'https://example.com', { copyLabel: 'ссылка' })));
    }
    if (d.type === 'file') body.append(this.fileControl(titleWrap));
    body.append(this.field('Категория / папка в хранилище', null, this.categoryControl()));
    if (hasSecret) {
      if (isPin) {
        body.append(this.field('Карта, телефон или устройство', 'необязательно',
          this.input('username', 'credit-card', 'Visa •• 4411, SIM МТС, домофон', { copyLabel: 'карта / устройство' })));
        body.append(this.pinBox(type));
      } else {
        body.append(this.field(
          d.type === 'secret' ? 'Идентификатор / ключ ID' : 'Имя пользователя или email',
          null,
          this.input('username', 'at-sign', d.type === 'secret' ? 'sk_live_… или client id' : 'name@example.com', { copyLabel: 'логин' })
        ));
        body.append(this.generatorBox(type));
        body.append(this.totpField());
      }
    }

    const tags = el('input.kr-input', { attr: { type: 'text', placeholder: 'работа, devops', spellcheck: 'false' } });
    tags.value = this.tagsText;
    tags.addEventListener('input', () => {
      this.tagsText = tags.value;
    });
    body.append(this.field('Теги', 'через запятую', el('label.kr-input-wrap', [icon('hash'), tags, this.copyInput(tags, 'теги')])));
    body.append(this.fieldsEditor());

    const notes = el('textarea.kr-input.kr-textarea', {
      attr: { rows: d.type === 'note' ? 10 : 5, placeholder: '## Резервные коды 2FA\n- 8492-1049-5510\n\nСм. [[Инфраструктура]]', spellcheck: 'false' },
    });
    notes.value = d.notes;
    notes.addEventListener('input', () => {
      d.notes = notes.value;
    });
    body.append(this.field('Заметки (Markdown Obsidian)', el('span.kr-form-aside-row', [
      el('span.is-violet', 'Поддержка [[Wikilinks]]'),
      this.copyInput(notes, 'заметки'),
    ]), notes));

    const save = button('Сохранить в хранилище', 'shield-check', () => this.save(), 'kr-btn-primary');
    this.saveBtn = save;
    const foot = el('div.kr-editor-foot', [
      !this.isNew ? iconButton('trash-2', 'Удалить запись', () => this.view.deleteEntry(this.original), 'is-danger') : null,
      el('div.kr-spacer'),
      button('Отмена', null, () => this.view.closeEditor(), 'kr-btn-ghost'),
      save,
    ]);

    this.el.append(head, body, foot);
  }

  fileControl(titleWrap) {
    const d = this.draft;
    const picker = el('input', { attr: { type: 'file' }, style: { display: 'none' } });
    const info = d.file
      ? el('div.kr-file-info', [icon('file-lock'), el('div', [el('b', d.file.name), el('small', `${formatSize(d.file.size)} · ${d.file.mime}`)])])
      : el('div.kr-file-info.kr-muted', [icon('paperclip'), el('span', `Файл не выбран (до ${MAX_FILE_MB} МБ)`)]);
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        this.view.core.notice(`Файл больше ${MAX_FILE_MB} МБ`);
        return;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      d.file = {
        name: file.name,
        mime: file.type || mimeOf(file.name.split('.').pop()),
        size: buf.byteLength,
        data: toBase64(buf),
      };
      if (!d.title.trim()) d.title = file.name;
      this.build();
    });
    return this.field('Вложение', 'шифруется целиком', el('div.kr-form-row', [
      el('div.kr-file-box.kr-grow', [info]),
      picker,
      button(d.file ? 'Заменить' : 'Выбрать файл', 'upload', () => picker.click(), 'kr-btn-soft'),
    ]));
  }

  categoryControl() {
    const d = this.draft;
    const select = el('select.kr-input.kr-select');
    const cats = this.vault.categories().map((c) => c.path);
    if (!cats.includes('')) cats.push('');
    if (!cats.includes(d.category)) cats.push(d.category);
    for (const path of cats.sort((a, b) => (a ? (b ? a.localeCompare(b, 'ru') : -1) : 1))) {
      const opt = el('option', { attr: { value: path } }, path || 'Без папки (корень хранилища)');
      if (path === d.category) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      d.category = select.value;
    });
    const add = button('Новая папка', 'folder-plus', async () => {
      const name = await new PromptModal(this.view.app, {
        title: 'Новая папка в хранилище',
        placeholder: 'Работа/DevOps',
        cta: 'Создать',
        desc: 'Вложенность через «/». Папки видны в проводнике Obsidian, записи внутри зашифрованы.',
      }).ask();
      const clean = (name || '').split('/').map((s) => s.trim().replace(/[\\:*?"<>|#^[\]]/g, '')).filter(Boolean).join('/');
      if (!clean) return;
      d.category = clean;
      this.build();
    }, 'kr-btn-soft');
    return el('div.kr-form-row', [el('label.kr-input-wrap.kr-grow', [icon('folder'), select]), add]);
  }

  /** PIN: только цифры, генератор с выбором длины и защитой от простых комбинаций. */
  pinBox(type) {
    const d = this.draft;
    const g = this.pinGen;
    const input = el('input.kr-gen-input.kr-pin-input', {
      attr: {
        type: this.showPassword ? 'text' : 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 12,
        spellcheck: 'false', autocomplete: 'off', placeholder: 'Цифры PIN-кода',
      },
    });
    input.value = d.password;
    const meterHost = el('div');
    const hint = el('div.kr-pin-hint');
    const lenChip = el('span.kr-chip.kr-chip-mint');
    const refresh = () => {
      const s = analyzePin(d.password);
      lenChip.textContent = d.password ? `${d.password.length} цифр · 1 из ${(10 ** d.password.length).toLocaleString('ru-RU')}` : 'нет PIN';
      clear(meterHost).append(strengthMeter(s));
      hint.className = `kr-pin-hint${s.weak ? ' is-bad' : ''}`;
      hint.textContent = s.weak ? `Легко угадать: ${s.weak}. Сгенерируйте случайный PIN.` : '';
    };
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 12);
      if (digits !== input.value) input.value = digits;
      d.password = digits;
      refresh();
    });
    const regenerate = () => {
      d.password = generatePin(g.length, g);
      input.value = d.password;
      refresh();
    };
    const saveGen = () => {
      this.view.settings.pinGenerator = { length: g.length, avoidWeak: g.avoidWeak };
      this.view.core.saveSettings();
    };
    const lengths = el('div.kr-seg.kr-pin-lengths', [4, 5, 6, 8].map((n) => el(`button.kr-seg-btn${g.length === n ? '.is-active' : ''}`, {
      attr: { type: 'button' },
      on: {
        click: () => {
          g.length = n;
          lengths.querySelectorAll('.kr-seg-btn').forEach((b) => b.classList.toggle('is-active', b.textContent === String(n)));
          saveGen();
          regenerate();
        },
      },
    }, String(n))));
    refresh();
    return el('div.kr-genbox', [
      el('div.kr-genbox-head', [icon(type.icon), el('span', 'PIN-код и генератор'), el('div.kr-spacer'), lenChip]),
      el('div.kr-gen-output', [
        input,
        iconButton(this.showPassword ? 'eye-off' : 'eye', 'Показать/скрыть', () => {
          this.showPassword = !this.showPassword;
          input.type = this.showPassword ? 'text' : 'password';
        }),
        iconButton('refresh-cw', 'Сгенерировать заново', regenerate),
        iconButton('copy', 'Скопировать', () => this.view.copy(d.password, 'PIN')),
      ]),
      meterHost,
      hint,
      el('div.kr-genopts', [
        el('div.kr-pin-row', [el('span', 'Цифр:'), lengths]),
        checkbox('Без простых комбинаций (1234, 0000, годы, даты)', g.avoidWeak, (v) => {
          g.avoidWeak = v;
          saveGen();
          regenerate();
        }),
      ]),
      !this.isNew && this.original && this.original.password && this.original.password !== d.password
        ? el('div.kr-hint', [icon('history'), 'Старый PIN сохранится в истории версий'])
        : null,
    ]);
  }

  generatorBox(type) {
    const d = this.draft;
    const input = el('input.kr-gen-input', {
      attr: {
        type: this.showPassword ? 'text' : 'password', spellcheck: 'false', autocomplete: 'new-password', placeholder: 'Введите или сгенерируйте',
      },
    });
    input.value = d.password;
    const meterHost = el('div');
    const bitsChip = el('span.kr-chip.kr-chip-mint');
    const refresh = () => {
      const s = analyzePassword(d.password);
      bitsChip.textContent = `${Math.round(s.bits)}-bit энтропия`;
      clear(meterHost).append(strengthMeter(s));
    };
    input.addEventListener('input', () => {
      d.password = input.value;
      refresh();
    });
    const regenerate = () => {
      d.password = generatePassword(this.gen);
      input.value = d.password;
      refresh();
    };
    refresh();

    const opts = generatorOptions(this.gen, () => regenerate());
    return el('div.kr-genbox', [
      el('div.kr-genbox-head', [icon('sliders-horizontal'), el('span', `${type.secretLabel} и генератор`), el('div.kr-spacer'), bitsChip]),
      el('div.kr-gen-output', [
        input,
        iconButton(this.showPassword ? 'eye-off' : 'eye', 'Показать/скрыть', () => {
          this.showPassword = !this.showPassword;
          input.type = this.showPassword ? 'text' : 'password';
        }),
        iconButton('refresh-cw', 'Сгенерировать заново', regenerate),
        iconButton('copy', 'Скопировать', () => this.view.copy(d.password, type.secretLabel.toLowerCase())),
      ]),
      meterHost,
      opts,
      !this.isNew && this.original && this.original.password && this.original.password !== d.password
        ? el('div.kr-hint', [icon('history'), 'Старый пароль сохранится в истории версий'])
        : null,
    ]);
  }

  totpField() {
    const d = this.draft;
    const status = el('span.kr-form-aside');
    const update = async () => {
      if (!d.totp.trim()) {
        status.textContent = 'base32 или otpauth://';
        status.className = 'kr-form-aside';
        return;
      }
      const cfg = parseTotp(d.totp);
      if (!cfg) {
        status.textContent = 'неверный секрет';
        status.className = 'kr-form-aside is-bad';
        return;
      }
      const r = await totpCode(cfg);
      status.textContent = `сейчас: ${formatCode(r.code)}`;
      status.className = 'kr-form-aside is-mint';
    };
    const wrap = this.input('totp', 'timer', 'JBSWY3DPEHPK3PXP или otpauth://totp/…', { onInput: update, copyLabel: 'секрет 2FA' });
    update();
    return el('div.kr-form-field', [
      el('div.kr-form-label', [el('span', '2FA / TOTP секрет'), status]),
      wrap,
    ]);
  }

  fieldsEditor() {
    const d = this.draft;
    const list = el('div.kr-fields-edit');
    const renderRows = () => {
      clear(list);
      d.fields.forEach((f, i) => {
        const label = el('input.kr-input', { attr: { type: 'text', placeholder: 'Название' } });
        label.value = f.label;
        label.addEventListener('input', () => {
          f.label = label.value;
        });
        const value = el('input.kr-input', { attr: { type: f.hidden ? 'password' : 'text', placeholder: 'Значение', spellcheck: 'false' } });
        value.value = f.value;
        value.addEventListener('input', () => {
          f.value = value.value;
        });
        list.append(el('div.kr-fields-row', [
          label,
          value,
          this.copyInput(value, (f.label || 'поле').toLowerCase()),
          iconButton(f.hidden ? 'eye-off' : 'eye', f.hidden ? 'Скрытое поле' : 'Открытое поле', () => {
            f.hidden = !f.hidden;
            renderRows();
          }, f.hidden ? 'is-on' : ''),
          iconButton('trash-2', 'Удалить поле', () => {
            d.fields.splice(i, 1);
            renderRows();
          }),
        ]));
      });
    };
    renderRows();
    return el('div.kr-form-field', [
      el('div.kr-form-label', [el('span', 'Дополнительные поля'), el('span.kr-form-aside', 'кодовое слово, PIN, номер документа…')]),
      list,
      button('Добавить поле', 'plus', () => {
        d.fields.push({ label: '', value: '', hidden: true });
        renderRows();
      }, 'kr-btn-ghost kr-btn-sm'),
    ]);
  }

  async save() {
    const d = this.draft;
    d.title = d.title.trim();
    if (d.type === 'file' && !d.file) {
      this.view.core.notice('Выберите файл для вложения');
      return;
    }
    if (!d.title) {
      const input = this.el.querySelector('[data-focus]');
      if (input) {
        input.classList.add('is-error');
        input.focus();
      }
      this.view.core.notice('Укажите название записи');
      return;
    }
    const now = Date.now();
    const entry = cloneEntry(d);
    entry.tags = this.tagsText.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    entry.fields = entry.fields.filter((f) => f.label.trim() || f.value);
    entry.url = entry.url.trim();
    entry.username = entry.username.trim();
    entry.totp = entry.totp.trim();
    if (entry.type === 'pin') {
      entry.url = '';
      entry.totp = '';
    }
    entry.updated = now;
    if (this.isNew) {
      entry.created = now;
      entry.passwordChanged = now;
    } else if (this.original.password && this.original.password !== entry.password) {
      const limit = Number(this.view.settings.historyLimit) || 0;
      entry.history = [{ password: this.original.password, changed: this.original.passwordChanged || this.original.updated, replaced: now }]
        .concat(entry.history || [])
        .slice(0, limit);
      entry.passwordChanged = now;
    }
    this.saveBtn.disabled = true;
    try {
      const saved = await this.vault.save(entry);
      this.view.core.notice(this.isNew ? 'Запись зашифрована и сохранена' : 'Изменения сохранены');
      await this.view.afterSave(saved);
    } catch (e) {
      this.saveBtn.disabled = false;
      this.view.core.notice(`Не удалось сохранить: ${e.message}`, 8000);
    }
  }
}

module.exports = { EditorPanel };
