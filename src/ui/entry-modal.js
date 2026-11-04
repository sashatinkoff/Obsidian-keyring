'use strict';
/*
 * Просмотр записи в модальном окне (режим списка): все поля, секреты скрыты
 * до нажатия «показать», длинные значения и заметки сворачиваются.
 */
const { ENTRY_TYPES, CIPHER_LABEL } = require('../constants');
const { el, icon, iconButton, button, clear } = require('../util/dom');
const { formatDate, countLabel } = require('../util/format');
const { BaseModal } = require('./modals');
const { renderSuggestPanel } = require('./suggest-panel');
const {
  avatar, strengthBadge, chips, totpBlock, fileRow, copyBtn, hasSecret,
} = require('./card');

const LONG_TEXT = 90; // символов — длиннее этого значение сворачивается
const NOTES_MAX = 220; // px — выше этого заметки сворачиваются

/** Делает блок сворачиваемым, если он выше maxHeight. */
function collapsible(content, maxHeight) {
  const wrap = el('div.kr-collapse', [content]);
  const toggle = el('button.kr-collapse-toggle', { attr: { type: 'button' } }, [icon('chevron-down'), el('span', 'Развернуть')]);
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('is-expanded');
    clear(toggle).append(icon(open ? 'chevron-up' : 'chevron-down'), el('span', open ? 'Свернуть' : 'Развернуть'));
  });
  wrap.style.setProperty('--kr-collapse-h', `${maxHeight}px`);
  const measure = () => {
    if (content.scrollHeight > maxHeight + 24) {
      wrap.classList.add('is-clamped');
      if (!toggle.isConnected) wrap.after(toggle);
    }
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(measure));
  return wrap;
}

class EntryModal extends BaseModal {
  constructor(view, vault, entry) {
    super(view.app, '');
    this.view = view;
    this.vault = vault;
    this.entryId = entry.id;
    this.revealed = new Set();
    this.modalEl.classList.add('kr-modal-wide', 'kr-entry-modal');
  }

  get entry() {
    return this.vault.entries.get(this.entryId);
  }

  onOpen() {
    super.onOpen();
    this.timer = window.setInterval(() => this.tick(), 1000);
    this.tick();
  }

  onClose() {
    window.clearInterval(this.timer);
    super.onClose();
  }

  tick() {
    const now = Date.now();
    this.contentEl.querySelectorAll('[data-totp-id]').forEach((n) => this.view.updateTotp(n, this.vault, now));
    this.view.manager.touch();
  }

  rerender() {
    const scroll = this.modalEl.scrollTop;
    this.onClose();
    this.onOpen();
    this.modalEl.scrollTop = scroll;
  }

  /** Строка поля: подпись, значение (скрытое/длинное), действия. */
  row(iconName, label, value, opts = {}) {
    if (!value) return null;
    const key = opts.key || label;
    const hidden = opts.secret && !this.revealed.has(key);
    const long = !hidden && (value.length > LONG_TEXT || value.includes('\n'));
    let valueEl = el(`div.kr-mfield-value${opts.secret ? '.is-secret' : ''}${opts.mono !== false ? '.is-mono' : ''}`,
      hidden ? '••••••••••••' : (opts.display || value));
    if (long) valueEl = collapsible(valueEl, 44);
    return el('div.kr-mfield', [
      el('div.kr-mfield-label', [icon(iconName), el('span', label)]),
      el('div.kr-mfield-main', [valueEl, opts.extra || null]),
      el('div.kr-mfield-actions', [
        opts.secret ? iconButton(hidden ? 'eye' : 'eye-off', hidden ? 'Показать' : 'Скрыть', () => {
          if (this.revealed.has(key)) this.revealed.delete(key);
          else this.revealed.add(key);
          this.rerender();
        }) : null,
        opts.open ? iconButton('external-link', 'Открыть', opts.open) : null,
        copyBtn(this.view, value, label.toLowerCase()),
      ]),
    ]);
  }

  section(title, iconName, children) {
    const items = children.filter(Boolean);
    if (!items.length) return null;
    return el('section.kr-msection', [
      el('div.kr-panel-head', [icon(iconName), el('span', title)]),
      ...items,
    ]);
  }

  build(c) {
    const e = this.entry;
    if (!e) {
      c.append(el('p.kr-muted', 'Запись не найдена — возможно, её удалили.'));
      return;
    }
    const view = this.view;
    const type = ENTRY_TYPES[e.type] || ENTRY_TYPES.login;
    this.titleEl.textContent = '';

    c.append(el('div.kr-mhead-entry', [
      avatar(view, e),
      el('div.kr-grow', [
        el('div.kr-card-titlerow', [el('h2.kr-card-title', e.title), copyBtn(view, e.title, 'название')]),
        el('div.kr-card-titlerow', [
          el('span.kr-chip', [icon(type.icon), type.label]),
          e.category ? el('span.kr-chip', [icon('folder'), e.category]) : null,
          ...chips(e, 0, { state: view.state, toggleTag: (t) => { this.close(); view.toggleTag(t); } }),
        ]),
      ]),
      button('Изменить', 'pencil', () => {
        this.close();
        view.openEditor(e);
      }, 'kr-btn-soft'),
    ]));

    // доступ
    const access = [];
    if (hasSecret(e)) {
      access.push(this.row(e.type === 'pin' ? 'credit-card' : 'circle-user', type.userLabel || 'Логин', e.username));
      access.push(this.row(type.icon, type.secretLabel, e.password, { secret: true, key: 'password', extra: strengthBadge(e, true) }));
      access.push(this.row('globe', 'Ссылка', e.url, { display: e.url, open: () => view.openUrl(e.url), mono: false }));
      if (e.totp) {
        access.push(totpBlock(view, e));
        access.push(this.row('key-round', 'Секрет 2FA', e.totp, { secret: true, key: 'totp' }));
      }
    }
    const sp = renderSuggestPanel(view, this.vault, e, {
      onApplied: () => {
        view.render();
        this.rerender();
      },
      onClose: () => this.close(),
    });
    if (sp) c.append(sp);
    c.append(this.section('Доступ', 'key-round', access) || '');

    if (e.type === 'file') c.append(this.section('Вложение', 'paperclip', [fileRow(view, this.vault, e)]) || '');

    c.append(this.section('Поля', 'list', e.fields.map((f, i) => this.row(
      f.hidden ? 'eye-off' : 'tag', f.label || 'Поле', f.value, { secret: f.hidden, key: `f${i}` }
    ))) || '');

    if (e.notes.trim()) {
      const md = el('div.kr-markdown.markdown-rendered');
      view.renderMarkdown(e.notes, md, this.vault);
      c.append(el('section.kr-msection', [
        el('div.kr-panel-head', [icon('file-text'), el('span', 'Заметки'), el('div.kr-spacer'),
          copyBtn(view, e.notes, 'заметки', 'Скопировать заметки (Markdown)')]),
        collapsible(md, NOTES_MAX),
      ]));
    }

    const versions = e.history.length;
    c.append(this.section('Метаданные', 'fingerprint', [
      el('dl.kr-dl', [
        ['Шифрование', CIPHER_LABEL],
        ['Создана', formatDate(e.created)],
        ['Изменена', formatDate(e.updated)],
        hasSecret(e) ? [e.type === 'pin' ? 'PIN сменён' : 'Пароль сменён', formatDate(e.passwordChanged)] : null,
        e.origin ? ['Исходник', e.origin] : null,
        e.rev ? ['Ревизия', `0x${e.rev.slice(0, 4)}…${e.rev.slice(-4)}`, `0x${e.rev}`] : null,
      ].filter(Boolean).flatMap(([k, v, raw]) => [
        el('dt', k),
        el(`dd${k === 'Ревизия' ? '.is-mono' : ''}`, [el('span', v), copyBtn(view, raw || v, k.toLowerCase())]),
      ])),
      hasSecret(e) && versions ? el('div.kr-audit-foot', [
        icon('history'),
        el('span', countLabel(versions + 1, ['версия', 'версии', 'версий'])),
        el('div.kr-spacer'),
        el('button.kr-link', { attr: { type: 'button' }, on: { click: () => view.showHistory(e) } }, 'История изменений'),
      ]) : null,
    ]) || '');

    c.append(el('div.kr-modal-foot', [
      el('span.kr-muted.kr-modal-hint', [icon('shield-check'), 'Расшифровано только в памяти']),
      el('div.kr-spacer'),
      button('Закрыть', null, () => this.close(), 'kr-btn-ghost'),
    ]));
  }
}

module.exports = { EntryModal, collapsible };
