'use strict';
/* Окна экспорта (JSON / CSV / Markdown) и импорта (JSON / CSV / Markdown). */
const { Platform } = require('obsidian');
const { el, icon, button } = require('../util/dom');
const { countLabel } = require('../util/format');
const {
  toJson, toCsv, toSingleMarkdown, parseImport, planImport, exportMarkdown, readMarkdownFolder, stamp, safeName,
} = require('../vault/exchange');
const { toBase64 } = require('../crypto/codec');
const { attachFolderSuggest } = require('../util/suggest');
const { freePath } = require('../vault/converter');
const { download, saveToVault } = require('../util/download');
const {
  BaseModal, passwordInput, labeled, passwordErrorText,
} = require('./modals');
const { checkbox } = require('./widgets');

const REC = ['запись', 'записи', 'записей'];

function seg(options, value, onChange) {
  return el('div.kr-seg.kr-seg-full', options.map(([id, label, ic]) => el(`button.kr-seg-btn${value === id ? '.is-active' : ''}`, {
    attr: { type: 'button' },
    on: { click: () => onChange(id) },
  }, [ic ? icon(ic) : null, el('span', label)])));
}

/* ---------------- экспорт ---------------- */

class ExportModal extends BaseModal {
  constructor(view, vault) {
    super(view.app, `Экспорт «${vault.name}»`);
    this.view = view;
    this.vault = vault;
    this.format = 'json';
    this.scope = view.state.category ? 'folder' : 'all';
    this.attachments = true;
    this.mdMode = 'single'; // single — один файл, notes — заметка на запись
    this.target = Platform.isMobile ? 'vault' : 'download';
    this.modalEl.classList.add('kr-exchange-modal');
  }

  entries() {
    const all = Array.from(this.vault.entries.values());
    if (this.scope !== 'folder' || !this.view.state.category) return all;
    const c = this.view.state.category;
    return all.filter((e) => e.category === c || e.category.startsWith(`${c}/`));
  }

  build(c) {
    const list = this.entries();
    const folderName = this.view.state.category;
    c.append(el('div.kr-warn.is-danger', [icon('alert-triangle'), el('div', [
      el('b', 'Экспорт без шифрования.'),
      el('span', ' Логины и пароли попадут в файл открытым текстом. Не храните его в синхронизируемых папках и удалите после использования.'),
    ])]));

    c.append(labeled('Формат', seg([
      ['json', 'JSON', 'braces'],
      ['csv', 'CSV', 'table'],
      ['md', 'Markdown', 'file-text'],
    ], this.format, (v) => {
      this.format = v;
      this.onOpen();
    })));
    if (this.format === 'md') {
      c.append(labeled('Вид', seg([
        ['single', 'Один файл .md', 'file-text'],
        ['notes', 'Заметка на запись', 'files'],
      ], this.mdMode, (v) => {
        this.mdMode = v;
        this.onOpen();
      })));
    }
    const perNote = this.format === 'md' && this.mdMode === 'notes';
    c.append(el('p.kr-hint', [icon('info'), {
      json: 'Полная копия: все поля, история паролей и вложения. Импортируется обратно без потерь.',
      csv: 'Таблица для Excel и других менеджеров паролей. Без вложений и истории паролей.',
      md: perNote
        ? 'Одна запись — одна заметка с вёрсткой. Подпапки повторяют категории, вложения сохраняются рядом. Импортируется обратно из папки.'
        : 'Все записи одним документом, по разделам-папкам. Без вложений. Импортируется обратно.',
    }[this.format]]));

    if (folderName) {
      c.append(labeled('Что выгрузить', seg([
        ['all', `Всё хранилище (${this.vault.entries.size})`],
        ['folder', `Папку «${folderName}»`],
      ], this.scope, (v) => {
        this.scope = v;
        this.onOpen();
      })));
    }
    if (this.format === 'json') {
      c.append(checkbox('Включить вложения (файлы)', this.attachments, (v) => {
        this.attachments = v;
      }));
    }
    if (!perNote) {
      c.append(labeled('Куда', seg([
        ['download', 'Скачать файл', 'download'],
        ['vault', 'В папку Obsidian', 'folder-down'],
      ], this.target, (v) => {
        this.target = v;
        this.onOpen();
      })));
    }
    const outFolder = `Keyring export ${stamp()}`;
    if (this.target === 'vault' || perNote) {
      c.append(el('p.kr-hint', [icon('folder'), `Будет создана папка «${outFolder}» в корне хранилища Obsidian.`]));
    }

    const pw = passwordInput(`Мастер-пароль «${this.vault.name}»`, 'current-password');
    c.append(labeled('Подтвердите мастер-паролем', pw));
    const error = el('div.kr-form-error');
    const go = async () => {
      error.textContent = '';
      if (!list.length) return void (error.textContent = 'Нет записей для экспорта.');
      btn.disabled = true;
      try {
        await this.view.manager.lockout.guard(this.vault, () => this.vault.verifyPassword(pw.value));
      } catch (e) {
        btn.disabled = false;
        error.textContent = passwordErrorText(e);
        return;
      }
      try {
        const base = `${safeName(this.vault.name)} ${stamp()}`;
        let where;
        if (perNote) {
          const n = await exportMarkdown(this.app, list, outFolder, freePath);
          where = `${countLabel(n, ['заметка', 'заметки', 'заметок'])} в папке «${outFolder}»`;
        } else {
          const text = this.format === 'json' ? toJson(this.vault, list, { attachments: this.attachments })
            : this.format === 'md' ? toSingleMarkdown(this.vault, list) : toCsv(list);
          const name = `${base}.${this.format}`;
          if (this.target === 'vault') {
            const path = await saveToVault(this.app, outFolder, name, text, freePath);
            where = `файл «${path}»`;
          } else {
            download(name, text, { json: 'application/json', csv: 'text/csv', md: 'text/markdown' }[this.format]);
            where = `файл «${name}»`;
          }
        }
        this.close();
        this.view.core.notice(`Экспортировано ${countLabel(list.length, REC)}: ${where}. Файлы не зашифрованы — удалите их после использования.`, 10000);
      } catch (e) {
        btn.disabled = false;
        error.textContent = `Не удалось экспортировать: ${e.message}`;
      }
    };
    pw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const btn = button(`Экспортировать ${countLabel(list.length, REC)}`, 'download', go, 'kr-btn-primary');
    c.append(error, el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), btn]));
  }
}

/* ---------------- импорт ---------------- */

function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.csv,.md,.markdown,.txt,application/json,text/csv,text/markdown';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const list = Array.from(input.files || []);
      input.remove();
      resolve(list.length ? await Promise.all(list.map(async (f) => ({ name: f.name, text: await f.text() }))) : null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

class ImportModal extends BaseModal {
  constructor(view, vault) {
    super(view.app, `Импорт в «${vault.name}»`);
    this.view = view;
    this.vault = vault;
    this.file = null;
    this.parsed = null;
    this.error = '';
    this.duplicates = 'skip';
    this.folder = '';
    this.modalEl.classList.add('kr-exchange-modal');
  }

  /** Один или несколько файлов: записи объединяются. */
  async load(files) {
    const list = Array.isArray(files) ? files : [files];
    this.file = { name: list.length > 1 ? `${list.length} файлов` : list[0].name };
    this.error = '';
    this.parsed = null;
    const entries = [];
    const formats = new Set();
    const bad = [];
    for (const f of list) {
      try {
        const r = parseImport(f.text, f.name);
        formats.add(r.format);
        entries.push(...r.entries);
      } catch (e) {
        bad.push(`${f.name}: ${e.message}`);
      }
    }
    if (entries.length) this.parsed = { format: Array.from(formats).join(', '), entries, bad };
    else this.error = bad[0] || 'В файле нет записей';
    this.onOpen();
  }

  /** Заметки из папки Obsidian (например, экспорт «заметка на запись»). */
  async loadFolder(folder) {
    this.file = { name: `папка «${folder || '/'}»` };
    this.error = '';
    this.parsed = null;
    try {
      const entries = await readMarkdownFolder(this.app, folder, toBase64);
      if (entries.length) this.parsed = { format: 'Markdown', entries, bad: [] };
      else this.error = 'В папке нет заметок .md';
    } catch (e) {
      this.error = e.message;
    }
    this.onOpen();
  }

  build(c) {
    const drop = el(`div.kr-keydrop${this.parsed ? '.is-loaded' : ''}${this.error ? '.is-bad' : ''}`, { attr: { role: 'button', tabindex: '0' } }, [
      icon(this.parsed ? 'file-check' : 'upload'),
      el('div.kr-grow', this.file
        ? [el('b', this.file.name), el('small', this.error || `${this.parsed.format} · ${countLabel(this.parsed.entries.length, REC)}`)]
        : [el('b', 'Выбрать файлы JSON, CSV или .md'), el('small', 'экспорт Keyring, Bitwarden, Chrome, 1Password, KeePass, LastPass, заметки — можно несколько или перетащить сюда')]),
      this.file ? button('Другой файл', null, () => choose(), 'kr-btn-ghost kr-btn-sm') : null,
    ]);
    const choose = async () => {
      const f = await pickFiles();
      if (f) await this.load(f);
    };
    drop.addEventListener('click', (e) => {
      if (!e.target.closest('button')) choose();
    });
    drop.addEventListener('dragover', (e) => e.preventDefault());
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const fl = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (fl.length) await this.load(await Promise.all(fl.map(async (f) => ({ name: f.name, text: await f.text() }))));
    });
    c.append(drop);

    // или папка Obsidian с заметками
    const folderPick = el('input.kr-input', { attr: { type: 'text', placeholder: 'или папка Obsidian с заметками .md', spellcheck: 'false' } });
    attachFolderSuggest(this.app, folderPick);
    const goFolder = () => this.loadFolder(folderPick.value.trim().replace(/^\/+|\/+$/g, ''));
    folderPick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goFolder();
    });
    c.append(el('div.kr-import-folder', [folderPick, button('Из папки', 'folder-open', goFolder, 'kr-btn-soft')]));
    if (this.parsed && this.parsed.bad && this.parsed.bad.length) {
      c.append(el('p.kr-hint', [icon('alert-triangle'), `Пропущены файлы: ${this.parsed.bad.join('; ')}`]));
    }

    if (!this.parsed || this.error) {
      c.append(el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost')]));
      return;
    }

    c.append(labeled('Совпадающие записи', seg([
      ['skip', 'Пропустить'],
      ['update', 'Обновить'],
      ['keep', 'Добавить копией'],
    ], this.duplicates, (v) => {
      this.duplicates = v;
      this.onOpen();
    })));
    const folderInput = el('input.kr-input', { attr: { type: 'text', placeholder: 'например, Импорт (необязательно)', spellcheck: 'false' } });
    folderInput.value = this.folder;
    folderInput.addEventListener('change', () => {
      this.folder = folderInput.value.trim().replace(/^\/+|\/+$/g, '');
      this.onOpen();
    });
    c.append(labeled('Положить в папку', folderInput));

    const plan = planImport(this.vault, this.parsed.entries, { duplicates: this.duplicates, folder: this.folder });
    c.append(el('div.kr-import-sum', [
      el('span.kr-chip.kr-chip-mint', `новых: ${plan.add.length}`),
      plan.update.length ? el('span.kr-chip', `обновить: ${plan.update.length}`) : null,
      plan.skip.length ? el('span.kr-chip', `пропустить: ${plan.skip.length}`) : null,
    ]));
    const preview = [...plan.add, ...plan.update].slice(0, 6);
    if (preview.length) {
      c.append(el('div.kr-issues.kr-import-preview', preview.map((e) => el('div.kr-issue', [
        icon(e.type === 'note' ? 'sticky-note' : 'key-round'),
        el('div.kr-issue-main', [el('b', e.title), el('small', [e.username, e.url, e.category].filter(Boolean).join(' · ') || '—')]),
      ]))));
      const more = plan.add.length + plan.update.length - preview.length;
      if (more > 0) c.append(el('small.kr-muted', `и ещё ${countLabel(more, REC)}`));
    }
    c.append(el('p.kr-hint', [icon('shield-check'), 'Записи сразу шифруются ключом хранилища. Исходный файл не зашифрован — удалите его после импорта.']));

    const error = el('div.kr-form-error');
    const total = plan.add.length + plan.update.length;
    const btn = button(total ? `Импортировать ${countLabel(total, REC)}` : 'Нечего импортировать', 'upload', async () => {
      btn.disabled = true;
      try {
        const r = await this.vault.applyImport(plan, (i, n) => {
          btn.querySelector('span:last-child').textContent = `Шифрование ${i} / ${n}…`;
        });
        this.close();
        this.view.core.notice(`Импорт: добавлено ${r.added}, обновлено ${r.updated}, пропущено ${r.skipped}`, 8000);
        this.view.render();
      } catch (e) {
        btn.disabled = false;
        error.textContent = `Не удалось импортировать: ${e.message}`;
      }
    }, 'kr-btn-primary');
    btn.disabled = !total;
    c.append(error, el('div.kr-modal-foot', [button('Отмена', null, () => this.close(), 'kr-btn-ghost'), btn]));
  }
}

module.exports = { ExportModal, ImportModal };
