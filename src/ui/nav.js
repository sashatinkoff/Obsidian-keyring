'use strict';
/* Навигация: рейка и проводник (десктоп), шапка, нижнее меню и FAB (мобильный). */
const { TABS, APP_VERSION, CIPHER_LABEL } = require('../constants');
const { el, icon, iconButton } = require('../util/dom');

function renderRail(view) {
  const rail = el('nav.kr-rail');
  rail.append(el('div.kr-rail-logo', { title: `Keyring v${APP_VERSION}` }, [icon('hexagon')]));
  for (const [id, t] of Object.entries(TABS)) {
    rail.append(el(`button.kr-rail-btn${view.state.tab === id ? '.is-active' : ''}`, {
      title: t.label,
      attr: { type: 'button', 'aria-label': t.label },
      on: { click: () => view.setTab(id) },
    }, [icon(t.icon)]));
  }
  rail.append(el('div.kr-spacer'));
  rail.append(el('button.kr-rail-btn', {
    title: 'Заблокировать все (Ctrl/Cmd+L)',
    attr: { type: 'button' },
    on: { click: () => view.manager.lockAll('manual') },
  }, [icon('lock')]));
  return rail;
}

function renderSidebar(view) {
  const side = el('aside.kr-side');
  side.append(el('div.kr-side-head', [
    el('span.kr-side-title', 'Хранилища'),
    el('div.kr-side-tools', [
      iconButton('folder-lock', 'Зашифровать папку…', () => view.convertFolder('')),
      iconButton('folder-plus', 'Новое хранилище', () => view.createVault()),
    ]),
  ]));

  const list = el('div.kr-side-list');
  const current = view.vault;
  for (const v of view.manager.list()) {
    const active = v === current;
    const count = v.unlocked ? v.entries.size : v.fileCount;
    list.append(el(`div.kr-side-vault${active ? '.is-active' : ''}${v.unlocked ? '.is-unlocked' : ''}`, {
      on: { click: () => view.selectVault(v.folder) },
      title: v.folder,
    }, [
      icon(v.unlocked ? 'lock-open' : 'lock'),
      el('span.kr-side-name', v.name),
      count !== null && count !== undefined ? el('span.kr-side-count', String(count)) : null,
    ]));

    if (active && v.unlocked) {
      const cats = el('div.kr-side-cats');
      const all = view.state.category === null;
      cats.append(el(`div.kr-side-cat${all ? '.is-active' : ''}`, {
        on: { click: () => view.setCategory(null) },
      }, [icon('layers'), el('span.kr-side-name', 'Все записи'), el('span.kr-side-count', String(v.entries.size))]));
      for (const c of v.categories()) {
        const depth = c.path ? c.path.split('/').length - 1 : 0;
        cats.append(el(`div.kr-side-cat${view.state.category === c.path ? '.is-active' : ''}`, {
          style: { paddingLeft: `${12 + depth * 14}px` },
          on: { click: () => view.setCategory(c.path) },
          title: c.path || 'Записи в корне хранилища',
        }, [icon(c.path ? 'folder' : 'inbox'), el('span.kr-side-name', c.name), el('span.kr-side-count', String(c.count))]));
      }
      list.append(cats);
    }
  }
  side.append(list);

  const unlocked = view.manager.anyUnlocked;
  side.append(el(`div.kr-side-foot${unlocked ? '.is-on' : ''}`, [
    el('span.kr-dot'),
    el('span', unlocked ? 'Сессия активна' : 'Всё заблокировано'),
    unlocked ? el('span.kr-session-time', '') : null,
  ]));
  return side;
}

function renderMobileHeader(view, vault) {
  const unlocked = vault && vault.unlocked;
  return el('header.kr-mhead', [
    el('div.kr-brand', [
      el('div.kr-brand-logo', [icon('hexagon')]),
      el('div.kr-brand-text', [
        el('div.kr-brand-name', [el('span', vault ? vault.name : 'Keyring'), el('small', `v${APP_VERSION}`)]),
        el('div.kr-brand-sub', [el('span.kr-dot'), `E2EE • ${CIPHER_LABEL}`]),
      ]),
    ]),
    el('div.kr-spacer'),
    vault ? el(`button.kr-status-pill${unlocked ? '.is-on' : ''}`, {
      attr: { type: 'button' },
      title: unlocked ? 'Заблокировать' : 'Заблокировано',
      on: { click: () => (unlocked ? view.manager.lock(vault) : null) },
    }, [icon(unlocked ? 'lock-open' : 'lock'), el('span', unlocked ? 'Открыто' : 'Закрыто')]) : null,
    el('button.kr-round-btn', {
      attr: { type: 'button', 'aria-label': 'Хранилища' },
      title: 'Хранилища',
      on: { click: (e) => view.vaultMenu(e) },
    }, [icon('shield')]),
  ]);
}

function renderBottomNav(view) {
  const nav = el('nav.kr-bottom');
  for (const [id, t] of Object.entries(TABS)) {
    nav.append(el(`button.kr-bottom-btn${view.state.tab === id ? '.is-active' : ''}`, {
      attr: { type: 'button' },
      on: { click: () => view.setTab(id) },
    }, [el('span.kr-bottom-ico', [icon(t.icon)]), el('span.kr-bottom-label', t.label)]));
  }
  return nav;
}

function renderFab(view) {
  return el('button.kr-fab', {
    attr: { type: 'button' },
    on: { click: () => view.openEditor(null) },
  }, [icon('plus'), el('span', 'Создать запись')]);
}

module.exports = {
  renderRail, renderSidebar, renderMobileHeader, renderBottomNav, renderFab,
};
