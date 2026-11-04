'use strict';
/* Страница хранилища: поиск, статистика, группировка, список карточек. */
const { Menu } = require('obsidian');
const {
  GROUPS, CIPHER_LABEL, KDF_LABEL,
} = require('../constants');
const { el, icon, iconButton, button, clear } = require('../util/dom');
const { countLabel, recencyBucket, formatNumber } = require('../util/format');
const { matchesQuery } = require('../vault/entry');
const { auditVault } = require('../vault/audit');
const { renderCard, renderRowHeader } = require('./card');
const { renderOrphanBanner } = require('./restore-panel');

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

function searchBox(view, placeholder) {
  const input = el('input.kr-search-input', {
    attr: { type: 'search', placeholder, spellcheck: 'false', autocomplete: 'off' },
  });
  input.value = view.state.query;
  input.addEventListener('input', () => view.setQuery(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      view.setQuery('');
    }
  });
  view.searchInput = input;
  return input;
}

function renderTopbar(view, vault) {
  return el('div.kr-topbar', [
    el('label.kr-search', [
      icon('search'),
      searchBox(view, 'Поиск по названию, логину, тегам, заметкам…'),
      el('kbd.kr-kbd', isMac ? '⌘F' : 'Ctrl F'),
    ]),
    button('Безопасность', 'shield', (e) => view.securityMenu(e, vault), 'kr-btn-soft kr-security-btn'),
    el('button.kr-status-pill.is-on', {
      attr: { type: 'button' },
      title: 'Заблокировать хранилище',
      on: { click: () => view.manager.lock(vault) },
    }, [el('span.kr-dot'), el('span', 'Хранилище открыто')]),
    iconButton('smartphone', 'Компактный вид (как на телефоне)', () => view.toggleUiLayout(), 'kr-layout-btn'),
    button('Новая запись', 'plus', () => view.openEditor(null), 'kr-btn-primary kr-new-btn'),
  ]);
}

function filterMenu(view, evt) {
  const menu = new Menu();
  menu.addItem((item) => item.setTitle('Карточки').setIcon('layout-grid')
    .setChecked(view.state.layout === 'cards').onClick(() => view.setLayout('cards')));
  menu.addItem((item) => item.setTitle('Список').setIcon('list')
    .setChecked(view.state.layout === 'list').onClick(() => view.setLayout('list')));
  menu.addSeparator();
  menu.addItem((item) => item.setTitle('Полный вид (как на компьютере)').setIcon('monitor')
    .onClick(() => view.toggleUiLayout()));
  menu.addSeparator();
  for (const [id, g] of Object.entries(GROUPS)) {
    menu.addItem((item) => item.setTitle(g.label).setIcon(g.icon)
      .setChecked(view.state.group === id)
      .onClick(() => view.setGroup(id)));
  }
  menu.showAtMouseEvent(evt);
}

/** Телефон: закреплённый поиск + прокручиваемые вместе со списком папки и теги. */
function renderMobileSearch(view, vault) {
  const frag = document.createDocumentFragment();
  frag.append(renderMobileSearchBar(view, vault));
  const filters = el('div.kr-mfilters', [renderFolderChips(view, vault), renderTagBar(view, vault)]);
  frag.append(filters);
  return frag;
}

function renderFolderChips(view, vault) {
  const chips = el('div.kr-chips');
  const all = view.state.category === null;
  chips.append(el(`button.kr-chip-tab${all ? '.is-active' : ''}`, {
    attr: { type: 'button' },
    on: { click: () => view.setCategory(null) },
  }, [icon('layout-grid'), `Все (${vault.entries.size})`]));
  // без горизонтальной прокрутки: чипы переносятся, лишние — под «ещё N»
  const cats = vault.categories().filter((c) => c.count || c.path);
  const FOLDERS_SHOWN = 5;
  const shown = view.state.foldersAll ? cats : cats.filter((c, i) => i < FOLDERS_SHOWN || view.state.category === c.path);
  for (const c of shown) {
    chips.append(el(`button.kr-chip-tab${view.state.category === c.path ? '.is-active' : ''}`, {
      attr: { type: 'button' },
      on: { click: () => view.setCategory(c.path) },
    }, [icon(c.path ? 'folder' : 'inbox'), el('span.kr-chip-tab-text', `${c.name} (${c.count})`)]));
  }
  if (cats.length > shown.length || (view.state.foldersAll && cats.length > FOLDERS_SHOWN)) {
    chips.append(el('button.kr-link.kr-chips-more', {
      attr: { type: 'button' },
      on: { click: () => { view.state.foldersAll = !view.state.foldersAll; view.render(); } },
    }, view.state.foldersAll ? 'свернуть' : `ещё ${cats.length - shown.length}`));
  }
  return chips;
}

function renderMobileSearchBar(view) {
  return el('div.kr-msearch', [
    el('label.kr-search', [
      icon('search'),
      searchBox(view, 'Поиск по сервису, логину, тегам…'),
      el('button.kr-search-btn', {
        attr: { type: 'button', 'aria-label': 'Группировка' },
        on: {
          click: (e) => {
            e.preventDefault();
            filterMenu(view, e);
          },
        },
      }, [icon('sliders-horizontal')]),
    ]),
  ]);
}

function renderStats(view, vault) {
  const a = auditVault(vault);
  const vuln = a.vulnerable;
  return el('div.kr-stats', [
    el('div.kr-stat', [
      el('div.kr-stat-head', [el('span', 'Всего ключей'), icon('shield')]),
      el('div.kr-stat-body', [
        el('div.kr-stat-value', [String(a.total), el('small', countLabel(a.total, ['запись', 'записи', 'записей']).split(' ')[1])]),
        el(`button.kr-stat-badge${vuln ? '.is-bad' : ''}`, {
          attr: { type: 'button' },
          on: { click: () => view.setTab('analysis') },
        }, `${vuln} ${vuln === 1 ? 'уязвимый' : 'уязвимых'}`),
      ]),
    ]),
    el('div.kr-stat', [
      el('div.kr-stat-head', [el('span', 'Средняя энтропия'), icon('zap')]),
      el('div.kr-stat-body', [
        el('div.kr-stat-value.is-mint', [`${a.avgBits}`, el('small', 'бит')]),
        el('span.kr-stat-note', `здоровье ${a.health}%`),
      ]),
    ]),
    el('div.kr-stat', [
      el('div.kr-stat-head', [el('span', '2FA TOTP токены'), icon('timer')]),
      el('div.kr-stat-body', [
        el('div.kr-stat-value.is-violet', [String(a.totpCount), el('small', a.totpCount === 1 ? 'активный' : 'активных')]),
        el('span.kr-stat-note', 'цикл 30 с'),
      ]),
    ]),
  ]);
}

function renderStrip(view, vault) {
  const seg = el('div.kr-seg');
  for (const [id, g] of Object.entries(GROUPS)) {
    seg.append(el(`button.kr-seg-btn${view.state.group === id ? '.is-active' : ''}`, {
      attr: { type: 'button', 'data-group': id },
      on: { click: () => view.setGroup(id) },
    }, [icon(g.icon), el('span', g.label)]));
  }
  const layout = el('div.kr-seg.kr-seg-icons', [
    el(`button.kr-seg-btn${view.state.layout === 'cards' ? '.is-active' : ''}`, {
      attr: { type: 'button', 'aria-label': 'Карточки' },
      title: 'Карточки',
      on: { click: () => view.setLayout('cards') },
    }, [icon('layout-grid')]),
    el(`button.kr-seg-btn${view.state.layout === 'list' ? '.is-active' : ''}`, {
      attr: { type: 'button', 'aria-label': 'Таблица' },
      title: 'Таблица',
      on: { click: () => view.setLayout('list') },
    }, [icon('list')]),
  ]);
  return el('div.kr-strip', [
    el('div.kr-strip-crypto', [el('span.kr-dot'), el('div', [el('b', CIPHER_LABEL), el('small', `${KDF_LABEL} · ${formatNumber(vault.iterations)}`)])]),
    el('div.kr-strip-info', [icon('fingerprint'), el('div', [el('small', 'Папка в Obsidian'), el('b', vault.folder)])]),
    el('div.kr-spacer'),
    seg,
    layout,
  ]);
}

/** Есть ли у записи тег (с учётом вложенных: «работа» находит «работа/devops»). */
function hasTag(e, tag) {
  return (e.tags || []).some((t) => {
    const x = String(t).toLowerCase();
    return x === tag || x.startsWith(`${tag}/`);
  });
}

function filtered(view, vault, opts = {}) {
  const { category, query, tags } = view.state;
  return Array.from(vault.entries.values()).filter((e) => {
    if (category !== null && e.category !== category && !(category && e.category.startsWith(`${category}/`))) return false;
    if (!opts.ignoreTags && tags.size && !Array.from(tags).every((t) => hasTag(e, t))) return false;
    return matchesQuery(e, query);
  });
}

const TAGS_SHOWN = 12;

/** Панель тегов: частые теги текущей выборки, выбранные — подсвечены. */
function renderTagBar(view, vault) {
  const base = filtered(view, vault, { ignoreTags: true });
  const sel = view.state.tags;
  const counts = new Map();
  const names = new Map();
  // теги, которые ещё сужают выборку: считаем по записям, прошедшим уже выбранные теги
  const narrowed = base.filter((e) => Array.from(sel).every((t) => hasTag(e, t)));
  for (const e of narrowed) {
    for (const t of new Set((e.tags || []).map((x) => String(x)))) {
      const k = t.toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!names.has(k)) names.set(k, t);
    }
  }
  for (const t of sel) if (!counts.has(t)) counts.set(t, 0);
  if (!counts.size) return null;
  const list = Array.from(counts.entries())
    .sort((a, b) => Number(sel.has(b[0])) - Number(sel.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  const wide = view.mode === 'wide';
  const limit = view.state.tagsAll ? Infinity : (wide ? TAGS_SHOWN : 6);
  const shown = list.filter(([k], i) => i < limit || sel.has(k));
  const bar = el(`div.kr-tagbar${wide ? '' : '.is-narrow'}`, [
    icon('hash', 'kr-tagbar-icon'),
    ...shown.map(([k, n]) => el(`button.kr-tagchip${sel.has(k) ? '.is-active' : ''}`, {
      attr: { type: 'button', 'aria-pressed': sel.has(k) ? 'true' : 'false' },
      title: sel.has(k) ? 'Убрать фильтр' : `Показать записи с #${names.get(k) || k}`,
      on: { click: () => view.toggleTag(k) },
    }, [el('span', `#${names.get(k) || k}`), el('small', String(n)), sel.has(k) ? icon('x') : null])),
    list.length > shown.length ? el('button.kr-link.kr-tagbar-more', {
      attr: { type: 'button' },
      on: { click: () => { view.state.tagsAll = true; view.render(); } },
    }, `ещё ${list.length - shown.length}`) : null,
    view.state.tagsAll && list.length > (wide ? TAGS_SHOWN : 6) ? el('button.kr-link.kr-tagbar-more', {
      attr: { type: 'button' },
      on: { click: () => { view.state.tagsAll = false; view.render(); } },
    }, 'свернуть') : null,
    sel.size ? el('button.kr-link.kr-tagbar-reset', {
      attr: { type: 'button' },
      on: { click: () => view.toggleTag(null) },
    }, [icon('x'), 'Сбросить']) : null,
  ]);
  return bar;
}

function buildSections(view, entries) {
  const group = view.state.group;
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true });
  const sections = new Map();
  const put = (key, label, badge, e) => {
    if (!sections.has(key)) sections.set(key, { key, label, badge, items: [] });
    sections.get(key).items.push(e);
  };
  if (group === 'recent') {
    entries.sort((a, b) => b.updated - a.updated);
    for (const e of entries) {
      const b = recencyBucket(e.updated);
      put(b, b, null, e);
    }
    return Array.from(sections.values());
  }
  if (group === 'folder') {
    entries.sort((a, b) => a.category.localeCompare(b.category, 'ru') || byTitle(a, b));
    for (const e of entries) put(e.category || '~', e.category || 'Без папки', null, e);
    return Array.from(sections.values()).sort((a, b) => {
      if (a.key === '~') return 1;
      if (b.key === '~') return -1;
      return a.key.localeCompare(b.key, 'ru');
    });
  }
  entries.sort(byTitle);
  for (const e of entries) {
    let letter = (Array.from(e.title.trim())[0] || '#').toUpperCase();
    if (!/\p{L}/u.test(letter)) letter = '#';
    put(letter, `Секция ${letter}`, letter, e);
  }
  return Array.from(sections.values());
}

function renderEmpty(view, vault) {
  if (view.state.query || view.state.tags.size) {
    const by = [
      view.state.query ? `по запросу «${view.state.query}»` : null,
      view.state.tags.size ? `с тегами ${Array.from(view.state.tags).map((t) => `#${t}`).join(' + ')}` : null,
    ].filter(Boolean).join(' и ');
    return el('div.kr-empty', [icon('search-x'), el('h3', 'Ничего не найдено'), el('p', `Записей ${by} нет.`),
      view.state.tags.size ? button('Сбросить теги', 'x', () => view.toggleTag(null), 'kr-btn-soft') : null]);
  }
  return el('div.kr-empty', [
    icon('key-round'),
    el('h3', vault.entries.size ? 'В этой папке пусто' : 'Хранилище пока пустое'),
    el('p', 'Добавьте первую запись или импортируйте заметки с паролями в настройках.'),
    button('Новая запись', 'plus', () => view.openEditor(null), 'kr-btn-primary'),
  ]);
}

function sectionKey(view, s) {
  return `${view.state.group}:${s.key}`;
}

function fillList(view, vault, host) {
  clear(host);
  if (view.mode === 'wide') {
    host.append(renderStats(view, vault), renderStrip(view, vault));
    const tb = renderTagBar(view, vault);
    if (tb) host.append(tb);
  }

  const entries = filtered(view, vault);
  if (view.state.category !== null) {
    host.append(el('div.kr-crumb', [
      icon(view.state.category ? 'folder-open' : 'inbox'),
      el('span', view.state.category || 'Без папки'),
      iconButton('x', 'Показать все', () => view.setCategory(null)),
    ]));
  }
  if (!entries.length) {
    host.append(renderEmpty(view, vault));
    return;
  }

  const sections = buildSections(view, entries);
  const listMode = view.state.layout === 'list';
  const body = el(`div.kr-sections${listMode ? '.is-table' : ''}`);
  const searching = !!view.state.query.trim();
  if (listMode && sections.length > 1) {
    body.append(el('div.kr-section-tools', [
      el('button.kr-link', {
        attr: { type: 'button' },
        on: { click: () => { sections.forEach((s) => view.state.openSections.add(sectionKey(view, s))); view.renderList(); } },
      }, [icon('chevrons-up-down'), 'Развернуть все']),
      el('button.kr-link', {
        attr: { type: 'button' },
        on: { click: () => { view.state.openSections.clear(); view.renderList(); } },
      }, [icon('chevrons-down-up'), 'Свернуть все']),
    ]));
  }
  for (const s of sections) {
    const key = sectionKey(view, s);
    // в режиме списка группы свёрнуты по умолчанию; при поиске и переходе к записи — раскрыты
    const open = !listMode || searching || view.state.openSections.has(key)
      || (view.state.focusId && s.items.some((e) => e.id === view.state.focusId));
    const sec = el(`section.kr-section${listMode ? '.is-collapsible' : ''}${open ? '.is-open' : ''}`, { attr: { 'data-section': s.key } });
    const headChildren = [
      listMode ? icon(open ? 'chevron-down' : 'chevron-right', 'kr-section-chevron') : null,
      s.badge ? el('span.kr-letter', s.badge) : icon(view.state.group === 'folder' ? 'folder' : 'calendar'),
      el('span.kr-section-title', s.badge ? 'Секция' : s.label),
      s.badge ? el('span.kr-section-letter', s.badge) : null,
      el('span.kr-section-line'),
      el('span.kr-count-chip', countLabel(s.items.length, ['запись', 'записи', 'записей'])),
    ];
    sec.append(listMode
      ? el('button.kr-section-head', {
        attr: { type: 'button', 'aria-expanded': open ? 'true' : 'false' },
        on: {
          click: () => {
            if (view.state.openSections.has(key)) view.state.openSections.delete(key);
            else view.state.openSections.add(key);
            view.state.focusId = null;
            view.renderList();
          },
        },
      }, headChildren)
      : el('div.kr-section-head', headChildren));
    if (open) {
      const grid = el(`div.${listMode ? 'kr-table' : 'kr-grid'}`);
      if (listMode) grid.append(renderRowHeader());
      for (const e of s.items) grid.append(renderCard(view, vault, e));
      sec.append(grid);
    }
    body.append(sec);
  }
  host.append(body);

  view.root.querySelectorAll('.kr-alpha').forEach((n) => n.remove());
  // алфавитный указатель справа отключён: на телефоне он закрывал список
  if (false && view.mode === 'narrow' && view.state.group === 'alpha' && sections.length > 1) {
    view.root.append(el('div.kr-alpha', sections.map((s) => el('button.kr-alpha-btn', {
      attr: { type: 'button' },
      on: {
        click: () => {
          const target = host.querySelector(`[data-section="${CSS.escape(s.key)}"]`);
          if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        },
      },
    }, s.key))));
  }
}

function renderVaultPage(view, vault) {
  const page = el('div.kr-page.kr-vault-page');
  page.append(view.mode === 'wide' ? renderTopbar(view, vault) : renderMobileSearch(view, vault));
  const banner = renderOrphanBanner(view, vault);
  if (banner) page.append(banner);
  const host = el('div.kr-list-host');
  page.append(host);
  view.listHost = host;
  fillList(view, vault, host);
  return page;
}

module.exports = { renderVaultPage, fillList };
