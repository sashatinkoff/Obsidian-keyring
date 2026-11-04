'use strict';
/* Карточка записи: полная (десктоп), компактная (мобильный) и строка таблицы. */
const { ENTRY_TYPES, SECRET_TYPES, CIPHER_LABEL } = require('../constants');
const { el, icon, iconButton, button } = require('../util/dom');
const {
  hostOf, hueOf, initialOf, formatDate, formatRelative, countLabel,
} = require('../util/format');
const { strengthOf } = require('../crypto/pin');
const { parseTotp } = require('../crypto/totp');
const { formatSize } = require('../vault/converter');
const { renderSuggestPanel, hasSuggestions } = require('./suggest-panel');

const DOTS = '••••••••••';

function avatar(view, entry, size) {
  const hue = hueOf(entry.title);
  const box = el(`div.kr-avatar${size ? `.is-${size}` : ''}`, {
    style: { '--kr-hue': String(hue) },
  });
  box.style.setProperty('--kr-hue', String(hue));
  const letter = el('span.kr-avatar-letter', initialOf(entry.title));
  const host = hostOf(entry.url).split('/')[0];
  if (view.settings.favicons && host) {
    const img = el('img.kr-avatar-img', { attr: { alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' } });
    img.addEventListener('error', () => {
      img.remove();
      box.append(letter);
    });
    img.src = `https://icons.duckduckgo.com/ip3/${host}.ico`;
    box.append(img);
  } else if (entry.type === 'note') {
    box.append(icon('sticky-note'));
  } else if (entry.type === 'file') {
    const ext = entry.file ? (entry.file.name.split('.').pop() || '').slice(0, 4).toUpperCase() : '';
    box.append(ext ? el('span.kr-avatar-ext', ext) : icon('paperclip'));
  } else {
    box.append(letter);
  }
  return box;
}

/** Тег на карточке: нажатие включает фильтр по нему. */
function tagChip(view, t) {
  if (!view) return el('span.kr-tag', `#${t}`);
  const active = view.state.tags.has(String(t).toLowerCase());
  return el(`button.kr-tag.is-clickable${active ? '.is-active' : ''}`, {
    attr: { type: 'button' },
    title: active ? 'Убрать фильтр по тегу' : `Показать все записи с #${t}`,
    on: {
      click: (e) => {
        e.stopPropagation();
        view.toggleTag(t);
      },
    },
  }, `#${t}`);
}

function chips(entry, limit, view) {
  const out = [];
  if (limit) {
    const hasTotp = entry.totp && parseTotp(entry.totp);
    if (entry.tags.length) out.push(tagChip(view, entry.tags[0]));
    else if (hasTotp) out.push(el('span.kr-tag.is-mint', [icon('lock'), '2FA']));
    return out;
  }
  const tags = limit ? entry.tags.slice(0, limit) : entry.tags;
  for (const t of tags) out.push(tagChip(view, t));
  const hasTotp = entry.totp && parseTotp(entry.totp);
  if (hasTotp && (!limit || out.length < limit + 1)) out.push(el('span.kr-tag.is-mint', [icon('lock'), '2FA']));
  if (entry.type === 'secret' && !limit) out.push(el('span.kr-tag.is-blue', [icon('key-square'), 'Секрет']));
  if (entry.type === 'pin' && !limit) out.push(el('span.kr-tag.is-blue', [icon('rectangle-ellipsis'), 'PIN']));
  if (entry.type === 'note' && !limit) out.push(el('span.kr-tag.is-blue', [icon('sticky-note'), 'Заметка']));
  if (entry.type === 'file' && !limit) out.push(el('span.kr-tag.is-blue', [icon('paperclip'), 'Вложение']));
  return out;
}

function hasSecret(entry) {
  return SECRET_TYPES.includes(entry.type);
}

function fileRow(view, vault, entry, compact) {
  const f = entry.file;
  if (!f) return el('div.kr-file-row', [icon('file-x'), el('span.kr-muted', 'Файл не прикреплён')]);
  const canPreview = /^(image\/|application\/pdf|text\/|application\/json)/.test(f.mime);
  return el(`div.kr-file-row${compact ? '.is-compact' : ''}`, [
    el('div.kr-file-info', [
      icon('file-lock'),
      el('div.kr-grow', [el('b', f.name), el('small', `${formatSize(f.size)} · ${f.mime}`)]),
      copyBtn(view, f.name, 'имя файла'),
    ]),
    el('div.kr-file-actions', [
      canPreview ? button('Просмотр', 'eye', () => view.previewFile(entry), 'kr-btn-soft') : null,
      button(compact ? 'Скачать' : 'Сохранить копию', 'download', () => view.downloadFile(entry), 'kr-btn-soft'),
      iconButton('folder-output', 'Расшифровать обратно в папку Obsidian', () => view.decryptEntry(entry)),
    ]),
  ]);
}

function strengthBadge(entry, compact) {
  if (!hasSecret(entry) || !entry.password) return null;
  const s = strengthOf(entry);
  if (compact) {
    return el(`span.kr-score.is-l${s.level}`, { title: `${s.label} · ~${s.bits} бит` }, [icon('shield-check'), `${s.score}%`]);
  }
  return el(`div.kr-strength.is-l${s.level}`, { title: `~${s.bits} бит эффективной энтропии` }, [
    icon(s.level >= 3 ? 'shield-check' : 'shield-alert'),
    el('div.kr-strength-text', [el('b', `${s.score}/100`), el('span', s.label)]),
    el('div.kr-strength-bar', [el('i', { style: { width: `${s.score}%` } })]),
  ]);
}

function secretValue(view, entry) {
  const revealed = view.state.revealed.has(entry.id);
  return el(`span.kr-secret-value${revealed ? '.is-revealed' : ''}`, revealed ? entry.password : DOTS);
}

/* Клик по свободному месту карточки раскрывает/сворачивает её. */
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, iframe, .kr-alpha';

function attachToggle(view, card, entry) {
  card.classList.add('is-clickable');
  card.addEventListener('click', (e) => {
    if (e.target.closest(INTERACTIVE)) return;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && String(sel).length && card.contains(sel.anchorNode)) return; // выделяют текст
    view.toggleExpand(entry.id);
  });
}

/** Маленькая кнопка «копировать» для любого поля. */
function copyBtn(view, value, label, title) {
  if (!value) return null;
  return iconButton('copy', title || `Скопировать: ${label}`, () => view.copy(value, label), 'kr-copy-btn');
}

/** Строка «подпись — значение — копировать». */
function copyRow(view, iconName, label, value, display) {
  if (!value) return null;
  return el('div.kr-copy-row', [
    icon(iconName),
    el('span.kr-copy-label', label),
    el('span.kr-copy-value', { title: value }, display || value),
    copyBtn(view, value, label.toLowerCase()),
  ]);
}

function metaPill(iconName, text, actions) {
  return el('div.kr-meta-pill', [icon(iconName), el('span.kr-meta-text', { title: text }, text), ...actions]);
}

/* ---------- детали ---------- */

function totpBlock(view, entry) {
  if (!entry.totp) return null;
  const cfg = parseTotp(entry.totp);
  return el('div.kr-totp', { attr: { 'data-totp-id': entry.id } }, [
    el('div.kr-totp-ring', [el('span.kr-totp-left', '')]),
    el('div.kr-totp-main', [
      el('small', cfg && cfg.issuer ? `TOTP · ${cfg.issuer}` : 'Код 2FA (TOTP)'),
      el('span.kr-totp-code', '··· ···'),
    ]),
    iconButton('copy', 'Скопировать код', () => view.copyTotp(entry)),
    iconButton('key-round', 'Скопировать секрет 2FA (для переноса в другое приложение)', () => view.copy(entry.totp, 'секрет 2FA')),
  ]);
}

function fieldsBlock(view, entry) {
  if (!entry.fields.length) return null;
  return el('div.kr-fields', entry.fields.map((f, i) => {
    const key = `${entry.id}:f${i}`;
    const shown = !f.hidden || view.state.revealed.has(key);
    return el('div.kr-field-row', [
      el('span.kr-field-label', f.label || 'Поле'),
      el(`span.kr-field-value${f.hidden ? '.is-secret' : ''}`, shown ? f.value : '••••••••'),
      f.hidden ? iconButton(shown ? 'eye-off' : 'eye', shown ? 'Скрыть' : 'Показать', () => {
        const s = view.state.revealed;
        if (s.has(key)) s.delete(key);
        else s.add(key);
        view.replaceCard(entry.id);
      }) : null,
      iconButton('copy', 'Скопировать', () => view.copy(f.value, (f.label || 'поле').toLowerCase()), 'kr-copy-btn'),
    ]);
  }));
}

function notesBlock(view, vault, entry) {
  const box = el('div.kr-panel.kr-notes');
  box.append(el('div.kr-panel-head', [
    icon('file-text'),
    el('span', 'Заметки и поля'),
    el('span.kr-panel-aside', '[[Wikilinks]]'),
    entry.notes.trim() ? copyBtn(view, entry.notes, 'заметки', 'Скопировать заметки (Markdown)') : null,
  ]));
  const fields = fieldsBlock(view, entry);
  if (fields) box.append(fields);
  if (entry.notes.trim()) {
    const md = el('div.kr-markdown.markdown-rendered');
    view.renderMarkdown(entry.notes, md, vault);
    box.append(md);
  } else if (!fields) {
    box.append(el('div.kr-muted.kr-notes-empty', 'Заметок нет'));
  }
  return box;
}

function auditBlock(view, entry) {
  const rows = [
    ['Шифрование', CIPHER_LABEL],
    ['Создана', formatDate(entry.created)],
    ['Изменена', formatDate(entry.updated)],
  ];
  if (hasSecret(entry)) rows.push([entry.type === 'pin' ? 'PIN сменён' : 'Пароль сменён', formatDate(entry.passwordChanged)]);
  if (entry.origin) rows.push(['Исходник', entry.origin]);
  rows.push(['Ревизия', entry.rev ? `0x${entry.rev.slice(0, 4)}…${entry.rev.slice(-4)}` : '—', entry.rev ? `0x${entry.rev}` : '']);
  const versions = entry.history.length;
  return el('div.kr-panel.kr-audit', [
    el('div.kr-panel-head', [icon('fingerprint'), el('span', 'Шифрование и аудит')]),
    totpBlock(view, entry),
    el('dl.kr-dl', rows.flatMap(([k, v, raw]) => [
      el('dt', k),
      el(`dd${k === 'Ревизия' ? '.is-mono' : ''}`, [el('span', v), v && v !== '—' ? copyBtn(view, raw || v, k.toLowerCase()) : null]),
    ])),
    hasSecret(entry) ? el('div.kr-audit-foot', [
      icon('history'),
      el('span', versions ? countLabel(versions + 1, ['версия', 'версии', 'версий']) : 'Одна версия'),
      el('div.kr-spacer'),
      versions ? el('button.kr-link', {
        attr: { type: 'button' },
        on: { click: () => view.showHistory(entry) },
      }, 'История изменений') : null,
    ]) : null,
  ]);
}

function detailsBlock(view, vault, entry) {
  return el('div.kr-card-details', [renderSuggestPanel(view, vault, entry), notesBlock(view, vault, entry), auditBlock(view, entry)]);
}

/** Метка «найдены данные» на свёрнутой карточке. */
function suggestChip(view, entry) {
  if (view.state.expanded.has(entry.id) || !hasSuggestions(entry)) return null;
  return el('span.kr-tag.is-amber', { title: 'В заметке найдены логин/пароль — раскройте карточку, чтобы перенести их в поля' }, [icon('wand-2'), 'Найдены данные']);
}

function footToggle(view, entry, label) {
  const open = view.state.expanded.has(entry.id);
  return el('button.kr-card-foot', {
    attr: { type: 'button', 'aria-expanded': open ? 'true' : 'false' },
    on: { click: () => view.toggleExpand(entry.id) },
  }, [
    icon('scan-search'),
    el('span', label),
    el('div.kr-spacer'),
    el('span.kr-card-updated', formatRelative(entry.updated)),
    icon(open ? 'chevron-up' : 'chevron-down', 'kr-chevron'),
  ]);
}

/* ---------- полная карточка (десктоп) ---------- */

function renderFullCard(view, vault, entry) {
  const open = view.state.expanded.has(entry.id);
  const type = ENTRY_TYPES[entry.type] || ENTRY_TYPES.login;
  const card = el(`article.kr-card${open ? '.is-open' : ''}`, { attr: { 'data-kr-id': entry.id } });
  card.style.setProperty('--kr-hue', String(hueOf(entry.title)));
  attachToggle(view, card, entry);

  const meta = [];
  if (entry.username) {
    meta.push(metaPill('circle-user', entry.username, [
      iconButton('copy', 'Скопировать логин', () => view.copy(entry.username, 'логин')),
    ]));
  }
  if (entry.url) {
    meta.push(metaPill('globe', hostOf(entry.url), [
      iconButton('copy', 'Скопировать ссылку', () => view.copy(entry.url, 'ссылка')),
      iconButton('external-link', 'Открыть сайт', () => view.openUrl(entry.url)),
    ]));
  }

  card.append(el('div.kr-card-head', [
    avatar(view, entry),
    el('div.kr-card-main', [
      el('div.kr-card-titlerow', [el('h3.kr-card-title', entry.title), copyBtn(view, entry.title, 'название'), ...chips(entry, 0, view), suggestChip(view, entry)]),
      meta.length ? el('div.kr-card-meta', meta) : null,
    ]),
    el('div.kr-card-actions', [
      entry.username ? iconButton('user', `Скопировать: ${(type.userLabel || 'логин').toLowerCase()}`, () => view.copy(entry.username, (type.userLabel || 'логин').toLowerCase())) : null,
      entry.password && hasSecret(entry) ? iconButton('copy', `Скопировать: ${type.secretLabel.toLowerCase()}`, () => view.copy(entry.password, type.secretLabel.toLowerCase())) : null,
      iconButton('pencil', 'Изменить', () => view.openEditor(entry)),
    ]),
  ]));

  if (entry.type === 'file') {
    card.append(el('div.kr-secret', [fileRow(view, vault, entry)]));
  } else if (hasSecret(entry)) {
    const revealed = view.state.revealed.has(entry.id);
    card.append(el('div.kr-secret', [
      el('div.kr-secret-field', [
        el('span.kr-secret-label', `${type.secretLabel}:`),
        entry.password ? secretValue(view, entry) : el('span.kr-muted', 'не задан'),
        entry.password ? iconButton(revealed ? 'eye-off' : 'eye', revealed ? 'Скрыть' : 'Показать', () => view.toggleReveal(entry.id)) : null,
        entry.password ? button('Копировать', 'copy', () => view.copy(entry.password, type.secretLabel.toLowerCase()), 'kr-btn-soft') : null,
      ]),
      strengthBadge(entry),
    ]));
  }

  if (open) card.append(detailsBlock(view, vault, entry));
  card.append(footToggle(view, entry, entry.totp ? '2FA TOTP и скрытые метаданные' : 'Заметки и метаданные'));
  return card;
}

/* ---------- компактная карточка (мобильный) ---------- */

function renderCompactCard(view, vault, entry) {
  const open = view.state.expanded.has(entry.id);
  const type = ENTRY_TYPES[entry.type] || ENTRY_TYPES.login;
  const card = el(`article.kr-card.kr-card-compact${open ? '.is-open' : ''}`, { attr: { 'data-kr-id': entry.id } });
  card.style.setProperty('--kr-hue', String(hueOf(entry.title)));
  attachToggle(view, card, entry);

  const sub = [entry.username, hostOf(entry.url)].filter(Boolean).join(' · ');
  card.append(el('div.kr-card-head', [
    avatar(view, entry),
    el('div.kr-card-main', [
      el('div.kr-card-titlerow', [el('h3.kr-card-title', entry.title)]),
      el('div.kr-card-sub', sub || type.label),
      suggestChip(view, entry),
    ]),
    el('div.kr-card-side', [
      strengthBadge(entry, true),
      el('span.kr-card-date', formatRelative(entry.updated)),
    ]),
  ]));

  if (entry.type === 'file') {
    card.append(fileRow(view, vault, entry, true));
  } else if (hasSecret(entry)) {
    const isPin = entry.type === 'pin';
    card.append(el('div.kr-card-btns', [
      isPin ? null : el('button.kr-cbtn.is-icon', {
        attr: { type: 'button', 'aria-label': 'Скопировать ссылку', disabled: !entry.url },
        on: { click: () => view.copy(entry.url, 'ссылка') },
      }, [icon('link')]),
      el('button.kr-cbtn', {
        attr: { type: 'button', disabled: !entry.username },
        on: { click: () => view.copy(entry.username, (type.userLabel || 'логин').toLowerCase()) },
      }, [icon(entry.type === 'pin' ? 'credit-card' : 'user'), el('span', entry.type === 'pin' ? 'Карта' : 'Логин')]),
      el('button.kr-cbtn.is-primary', {
        attr: { type: 'button', disabled: !entry.password },
        on: { click: () => view.copy(entry.password, type.secretLabel.toLowerCase()) },
      }, [icon(type.icon), el('span', type.secretLabel)]),
      isPin ? null : el('button.kr-cbtn.is-icon.is-mint', {
        attr: { type: 'button', 'aria-label': 'Открыть сайт', disabled: !entry.url },
        on: { click: () => view.openUrl(entry.url) },
      }, [icon('external-link')]),
    ]));
  }

  if (open) {
    const revealed = view.state.revealed.has(entry.id);
    const details = el('div.kr-card-details');
    const sp = renderSuggestPanel(view, vault, entry, { compact: true });
    if (sp) details.append(sp);
    if (hasSecret(entry) && entry.password) {
      details.append(el('div.kr-secret-field', [
        el('span.kr-secret-label', `${type.secretLabel}:`),
        secretValue(view, entry),
        iconButton(revealed ? 'eye-off' : 'eye', revealed ? 'Скрыть' : 'Показать', () => view.toggleReveal(entry.id)),
        copyBtn(view, entry.password, type.secretLabel.toLowerCase()),
      ]));
    }
    const rows = [
      copyRow(view, 'id-card', 'Название', entry.title),
      copyRow(view, entry.type === 'pin' ? 'credit-card' : 'circle-user', type.userLabel || 'Логин', entry.username),
      copyRow(view, 'globe', 'Ссылка', entry.url, hostOf(entry.url)),
      entry.tags.length ? copyRow(view, 'hash', 'Теги', entry.tags.map((t) => `#${t}`).join(' ')) : null,
    ].filter(Boolean);
    if (rows.length) details.append(el('div.kr-copy-rows', rows));
    const tb = totpBlock(view, entry);
    if (tb) details.append(tb);
    details.append(notesBlock(view, vault, entry));
    details.append(el('div.kr-mini-meta', [
      el('span', `Изменена ${formatDate(entry.updated)}`),
      entry.rev ? el('span.is-mono', [`0x${entry.rev.slice(0, 4)}…${entry.rev.slice(-4)}`, copyBtn(view, `0x${entry.rev}`, 'ревизия')]) : null,
    ]));
    details.append(el('div.kr-card-btns', [
      button('Изменить', 'pencil', () => view.openEditor(entry), 'kr-btn-soft'),
      entry.history.length ? button('История', 'history', () => view.showHistory(entry), 'kr-btn-soft') : null,
    ]));
    card.append(details);
  }

  card.append(footToggle(view, entry, entry.totp ? '2FA TOTP и скрытые данные' : 'Подробности'));
  return card;
}

/* ---------- строка таблицы ---------- */

function renderRowHeader() {
  return el('div.kr-row.kr-row-head', [
    el('span'), el('span', 'Название'), el('span', 'Логин'), el('span', 'Сайт'), el('span', 'Стойкость'), el('span', 'Изменена'), el('span'),
  ]);
}

function renderRow(view, vault, entry) {
  const type = ENTRY_TYPES[entry.type] || ENTRY_TYPES.login;
  return el('div.kr-row', {
    attr: { 'data-kr-id': entry.id },
    title: 'Открыть запись',
    on: {
      click: (e) => {
        if (e.target.closest(INTERACTIVE)) return;
        view.showEntry(entry);
      },
    },
  }, [
    avatar(view, entry, 'sm'),
    el('div.kr-row-title', [el('b', entry.title), el('small', entry.category || type.label)]),
    el('span.kr-row-cell', { title: entry.username }, entry.username || (entry.file ? entry.file.name : '—')),
    el('span.kr-row-cell', { title: entry.url }, hostOf(entry.url) || '—'),
    strengthBadge(entry, true) || el('span.kr-muted', '—'),
    el('span.kr-row-cell.kr-muted', formatRelative(entry.updated)),
    el('div.kr-row-actions', [
      entry.url ? iconButton('link', 'Скопировать ссылку', () => view.copy(entry.url, 'ссылка')) : null,
      entry.username ? iconButton('user', 'Скопировать логин', () => view.copy(entry.username, 'логин')) : null,
      entry.password && hasSecret(entry) ? iconButton('copy', `Скопировать: ${type.secretLabel.toLowerCase()}`, () => view.copy(entry.password, type.secretLabel.toLowerCase())) : null,
      iconButton('pencil', 'Изменить', () => view.openEditor(entry)),
    ]),
  ]);
}

function renderCard(view, vault, entry) {
  if (view.state.layout === 'list') return renderRow(view, vault, entry);
  if (view.mode === 'narrow') return renderCompactCard(view, vault, entry);
  return renderFullCard(view, vault, entry);
}

module.exports = {
  suggestChip,
  renderCard, renderRowHeader, avatar, strengthBadge, chips, totpBlock, fileRow, fieldsBlock, copyBtn, hasSecret,
};
