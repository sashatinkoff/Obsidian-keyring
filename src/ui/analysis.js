'use strict';
/* Вкладка «Анализ»: здоровье хранилища, проблемные записи, конфликты синхронизации. */
const { el, icon, button } = require('../util/dom');
const { renderDeletedPanel } = require('./restore-panel');
const { formatDate, countLabel, basename } = require('../util/format');
const { auditVault } = require('../vault/audit');
const { avatar, strengthBadge } = require('./card');
const { ConfirmModal } = require('./modals');
const { hasSuggestions } = require('./suggest-panel');

function issueList(view, vault, entries, reason) {
  if (!entries.length) return el('div.kr-ok-line', [icon('check-circle-2'), 'Проблем не найдено']);
  return el('div.kr-issues', entries.map((e) => el('button.kr-issue', {
    attr: { type: 'button' },
    on: { click: () => view.focusEntry(e.id) },
  }, [
    avatar(view, e, 'sm'),
    el('div.kr-issue-main', [el('b', e.title), el('small', reason(e))]),
    strengthBadge(e, true),
    icon('chevron-right'),
  ])));
}

function section(title, iconName, count, tone, content) {
  return el(`section.kr-panel.kr-audit-sec${count ? `.is-${tone}` : ''}`, [
    el('div.kr-panel-head', [icon(iconName), el('span', title), el('div.kr-spacer'), count === null ? null : el(`span.kr-count-chip${count ? `.is-${tone}` : ''}`, String(count))]),
    content,
  ]);
}

function diffFields(a, b) {
  if (!a) return ['оригинал отсутствует'];
  const names = {
    title: 'название', username: 'логин', password: 'пароль', url: 'ссылка', totp: '2FA', notes: 'заметки',
  };
  const out = [];
  for (const [k, label] of Object.entries(names)) if ((a[k] || '') !== (b[k] || '')) out.push(label);
  if (JSON.stringify(a.tags) !== JSON.stringify(b.tags)) out.push('теги');
  if (JSON.stringify(a.fields) !== JSON.stringify(b.fields)) out.push('поля');
  return out.length ? out : ['отличий в данных нет'];
}

function conflictList(view, vault) {
  if (!vault.conflicts.length) {
    return el('div.kr-ok-line', [icon('check-circle-2'), 'Конфликтных копий Syncthing нет']);
  }
  return el('div.kr-conflicts', vault.conflicts.map((c) => {
    const resolve = async (keep) => {
      const ok = await new ConfirmModal(view.app, {
        title: keep === 'conflict' ? 'Взять версию из конфликтной копии?' : 'Оставить текущую версию?',
        message: keep === 'conflict'
          ? 'Текущая версия будет заменена содержимым конфликтной копии, копия удалится.'
          : 'Конфликтная копия будет удалена.',
        cta: 'Применить',
      }).ask();
      if (!ok) return;
      await vault.resolveConflict(c, keep);
      view.core.notice('Конфликт разрешён');
      view.render();
    };
    return el('div.kr-conflict', [
      el('div.kr-conflict-head', [
        icon('git-merge'),
        el('div', [el('b', c.entry.title), el('small.is-mono', basename(c.path))]),
      ]),
      el('div.kr-conflict-cols', [
        el('div', [el('small', 'Текущая'), el('span', c.original ? formatDate(c.original.updated) : '—')]),
        el('div', [el('small', 'Конфликтная копия'), el('span', formatDate(c.entry.updated))]),
        el('div', [el('small', 'Отличается'), el('span', diffFields(c.original, c.entry).join(', '))]),
      ]),
      el('div.kr-conflict-actions', [
        button('Оставить текущую', 'check', () => resolve('original'), 'kr-btn-soft'),
        button('Взять из копии', 'git-pull-request-arrow', () => resolve('conflict'), 'kr-btn-soft'),
      ]),
    ]);
  }));
}

function renderAnalysisPage(view, vault) {
  const a = auditVault(vault);
  const ring = el('div.kr-ring', { style: { '--kr-p': String(a.health / 100) } }, [
    el('div.kr-ring-inner', [el('b', `${a.health}%`), el('small', 'здоровье')]),
  ]);
  ring.style.setProperty('--kr-p', String(a.health / 100));
  const tone = a.health >= 85 ? 'good' : a.health >= 60 ? 'warn' : 'bad';

  const summary = [];
  if (a.weak.length) summary.push(countLabel(a.weak.length, ['слабый пароль', 'слабых пароля', 'слабых паролей']));
  if (a.reusedCount) summary.push(`${a.reusedCount} с повторами`);
  if (a.old.length) summary.push(`${a.old.length} старше года`);

  const tiles = [
    ['Записей', a.total, 'key-round', ''],
    ['Слабые', a.weak.length, 'shield-alert', a.weak.length ? 'bad' : ''],
    ['Повторы', a.reusedCount, 'copy', a.reusedCount ? 'bad' : ''],
    ['Старше года', a.old.length, 'calendar-clock', a.old.length ? 'warn' : ''],
    ['С 2FA', a.totpCount, 'timer', 'violet'],
    ['Конфликты', a.conflicts.length, 'git-merge', a.conflicts.length ? 'warn' : ''],
  ];

  const page = el('div.kr-page.kr-analysis');
  page.append(el('div.kr-page-head', [
    el('div', [el('h1', 'Анализ хранилища'), el('p.kr-muted', vault.name === vault.folder ? `Папка «${vault.folder}»` : `«${vault.name}» · ${vault.folder}`)]),
  ]));
  page.append(el(`div.kr-panel.kr-health.is-${tone}`, [
    ring,
    el('div.kr-health-text', [
      el('h2', tone === 'good' ? 'Хранилище в хорошем состоянии' : tone === 'warn' ? 'Есть что улучшить' : 'Нужно внимание'),
      el('p', summary.length ? `Найдено: ${summary.join(', ')}.` : 'Слабых и повторяющихся паролей нет.'),
      el('p.kr-muted', `Средняя эффективная энтропия — ${a.avgBits} бит. Оценка учитывает длину, алфавит, повторы, клавиатурные последовательности и словарь частых паролей.`),
    ]),
  ]));
  page.append(el('div.kr-tiles', tiles.map(([label, value, ic, t]) => el(`div.kr-tile${t ? `.is-${t}` : ''}`, [
    icon(ic), el('b', String(value)), el('small', label),
  ]))));

  const grid = el('div.kr-audit-grid');
  grid.append(section('Слабые пароли', 'shield-alert', a.weak.length, 'bad',
    issueList(view, vault, a.weak, (e) => `${e.password.length} симв. · рекомендуем 16+`)));
  const reusedEntries = a.reused.flat();
  grid.append(section('Повторяющиеся пароли', 'copy', reusedEntries.length, 'bad',
    issueList(view, vault, reusedEntries, (e) => {
      const group = a.reused.find((g) => g.includes(e)) || [];
      return `тот же пароль: ${group.filter((x) => x !== e).map((x) => x.title).join(', ')}`;
    })));
  grid.append(section('Пароль не менялся больше года', 'calendar-clock', a.old.length, 'warn',
    issueList(view, vault, a.old, (e) => `сменён ${formatDate(e.passwordChanged)}`)));
  const withData = Array.from(vault.entries.values()).filter((e) => hasSuggestions(e));
  grid.append(section('Данные для входа в тексте заметок', 'wand-2', withData.length, 'warn',
    issueList(view, vault, withData, () => 'логин/пароль не оформлены полями — откройте, чтобы перенести')));
  grid.append(section('Логины без 2FA', 'timer-off', a.noTotp.length, 'info',
    issueList(view, vault, a.noTotp, () => 'включите двухфакторную защиту, если сервис поддерживает')));
  grid.append(section('Конфликты синхронизации', 'git-merge', a.conflicts.length, 'warn', conflictList(view, vault)));
  grid.append(section('Удалённые записи', 'history', null, 'info', renderDeletedPanel(view, vault)));
  if (a.errors.length) {
    grid.append(section('Не удалось прочитать', 'file-warning', a.errors.length, 'bad',
      el('div.kr-issues', a.errors.map((er) => el('div.kr-issue', [icon('file-x'), el('div.kr-issue-main', [el('b.is-mono', basename(er.path)), el('small', er.message)])])))));
  }
  page.append(grid);
  return page;
}

module.exports = { renderAnalysisPage };
