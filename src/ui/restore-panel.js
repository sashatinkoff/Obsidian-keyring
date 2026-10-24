'use strict';
/* Восстановление записей: конфликтные копии без основного файла, версии Syncthing, корзина. */
const { el, icon, button, clear } = require('../util/dom');
const { countLabel, formatDate } = require('../util/format');

const REC = ['запись', 'записи', 'записей'];

/** Баннер на странице хранилища, если записи живут только в конфликтных копиях. */
function renderOrphanBanner(view, vault) {
  const n = vault.orphans.length;
  if (!n) return null;
  return el('div.kr-warn.kr-orphan-banner', [icon('life-buoy'), el('div.kr-grow', [
    el('b', `${countLabel(n, REC)} — только в конфликтных копиях Syncthing.`),
    el('span', ' Основные файлы пропали (скорее всего, удалены синхронизацией), но копии целы — они показаны в списке. '
      + 'Восстановите их как обычные записи.'),
  ]), button('Восстановить', 'rotate-ccw', async (e) => {
    e.target.closest('button').disabled = true;
    const done = await vault.promoteOrphans();
    view.core.notice(`Восстановлено: ${countLabel(done, REC)}`, 6000);
    view.render();
  }, 'kr-btn-primary kr-btn-sm')]);
}

/** Панель «Удалённые записи» во вкладке «Анализ». */
function renderDeletedPanel(view, vault) {
  const body = el('div.kr-restore');
  const state = view.restoreState && view.restoreState.vault === vault ? view.restoreState : null;
  const draw = () => {
    clear(body);
    body.append(el('p.kr-muted', 'Ищет записи этого хранилища, удалённые с диска: в версиях Syncthing (.stversions) и корзине Obsidian (.trash). '
      + 'Подходят только файлы, которые открываются ключом этого хранилища.'));
    if (!state || !state.items) {
      body.append(button(state && state.busy ? 'Поиск…' : 'Найти удалённые записи', 'search', async () => {
        view.restoreState = { vault, busy: true };
        view.render();
        try {
          view.restoreState = { vault, items: await vault.findDeleted() };
        } catch (e) {
          view.restoreState = null;
          view.core.notice(e.message);
        }
        view.render();
      }, 'kr-btn-soft'));
      return;
    }
    if (!state.items.length) {
      body.append(el('div.kr-ok-row', [icon('check-circle-2'), 'Удалённых записей не найдено.']));
      body.append(button('Искать снова', 'refresh-cw', () => {
        view.restoreState = null;
        view.render();
      }, 'kr-btn-ghost kr-btn-sm'));
      return;
    }
    body.append(el('div.kr-issues', state.items.map((it) => el('div.kr-issue', [
      icon('file-clock'),
      el('div.kr-issue-main', [
        el('b', it.entry.title || '(без названия)'),
        el('small', `${it.source} · ${it.entry.category || 'без папки'} · изменена ${formatDate(it.entry.updated)}`),
      ]),
    ]))));
    body.append(button(`Восстановить ${countLabel(state.items.length, REC)}`, 'rotate-ccw', async () => {
      const n = await vault.restoreDeleted(state.items);
      view.restoreState = null;
      view.core.notice(`Восстановлено: ${countLabel(n, REC)}`, 6000);
      view.render();
    }, 'kr-btn-primary'));
  };
  draw();
  return body;
}

module.exports = { renderOrphanBanner, renderDeletedPanel };
