'use strict';
/*
 * Подсказка «в заметке есть логин/пароль»: показывает найденные значения
 * с предпросмотром результата и переносит их в поля записи.
 */
const { el, icon, iconButton, button } = require('../util/dom');
const { suggestionsFor } = require('../vault/detector');
const { analyzePassword } = require('../crypto/strength');
const { checkbox, strengthMeter } = require('./widgets');

const LABELS = {
  username: { label: 'Логин', icon: 'circle-user' },
  password: { label: 'Пароль', icon: 'key-round' },
  url: { label: 'Ссылка', icon: 'globe' },
  totp: { label: '2FA', icon: 'timer' },
  tags: { label: 'Теги', icon: 'tag' },
};

const cache = new Map();

/** Кандидаты для записи (с кэшем по ревизии). */
function picksFor(entry) {
  const key = `${entry.id}:${entry.rev}:${entry.notes.length}:${entry.suggestDismissed}`;
  if (!cache.has(key)) {
    if (cache.size > 500) cache.clear();
    cache.set(key, suggestionsFor(entry));
  }
  return cache.get(key);
}

function hasSuggestions(entry) {
  return !!picksFor(entry);
}

/** Состояние панели хранится во view, чтобы правки переживали перерисовку. */
function stateFor(view, entry, picks) {
  view.suggestState = view.suggestState || new Map();
  let st = view.suggestState.get(entry.id);
  if (!st || st.rev !== entry.rev) {
    st = { rev: entry.rev, fields: {}, removeLines: true, reveal: false, preview: false };
    for (const [field, list] of Object.entries(picks)) {
      st.fields[field] = { enabled: list[0].score >= 0.55, index: 0, value: list[0].value };
    }
    view.suggestState.set(entry.id, st);
  }
  return st;
}

function highlight(line, value) {
  const i = line.indexOf(value);
  if (i < 0) return [line.trim()];
  return [line.slice(0, i).trimStart(), el('mark', value), line.slice(i + value.length).trimEnd()];
}

/** Итоговая запись после применения. */
function buildResult(entry, picks, st) {
  const result = JSON.parse(JSON.stringify(entry));
  const removed = new Set();
  for (const [field, f] of Object.entries(st.fields)) {
    if (!f.enabled || !f.value.trim()) continue;
    if (field === 'tags') {
      const add = f.value.split(/[,\s]+/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
      result.tags = Array.from(new Set([...(entry.tags || []), ...add]));
      continue;
    }
    result[field] = f.value.trim();
    const cand = picks[field][f.index];
    if (st.removeLines && cand && cand.consumes && cand.value === f.value) removed.add(cand.lineIndex);
  }
  // строка-пара «логин / пароль» удаляется, только если перенесены обе части
  for (const idx of Array.from(removed)) {
    const users = Object.entries(st.fields).filter(([fld, f]) => {
      const c = picks[fld][f.index];
      return c && c.lineIndex === idx;
    });
    if (users.some(([, f]) => !f.enabled)) removed.delete(idx);
  }
  if (removed.size) {
    result.notes = entry.notes.split('\n').filter((_, i) => !removed.has(i)).join('\n')
      .replace(/^```[^\n]*\n```[ \t]*$/gm, '') // опустевшие блоки кода
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  if (result.type === 'note' && (result.username || result.password)) result.type = 'login';
  if (result.password && !entry.password) result.passwordChanged = Date.now();
  return { result, removed };
}

function renderSuggestPanel(view, vault, entry, opts = {}) {
  const picks = picksFor(entry);
  if (!picks) return null;
  const st = stateFor(view, entry, picks);
  const panel = el(`div.kr-suggest${opts.compact ? '.is-compact' : ''}`);
  panel.addEventListener('click', (e) => e.stopPropagation()); // не сворачивать карточку
  const rerender = () => panel.replaceWith(renderSuggestPanel(view, vault, entry, opts));

  panel.append(el('div.kr-suggest-head', [
    icon('wand-2'),
    el('div.kr-grow', [
      el('b', 'Похоже, в заметке есть данные для входа'),
      el('small', 'Проверьте найденное и перенесите в поля — так работают копирование в один клик, оценка стойкости и аудит.'),
    ]),
    iconButton('x', 'Больше не предлагать для этой записи', async () => {
      await vault.save(Object.assign({}, entry, { suggestDismissed: true }));
      view.core.notice('Подсказка скрыта для этой записи');
      view.render();
    }),
  ]));

  const rows = el('div.kr-suggest-rows');
  for (const [field, list] of Object.entries(picks)) {
    const f = st.fields[field];
    const meta = LABELS[field];
    const cand = list[f.index];
    const isSecret = field === 'password' || field === 'totp';
    const input = el('input.kr-input', {
      attr: { type: isSecret && !st.reveal ? 'password' : 'text', spellcheck: 'false', autocomplete: 'off' },
    });
    input.value = f.value;
    input.addEventListener('input', () => {
      f.value = input.value;
    });
    input.addEventListener('change', rerender);

    let variants = null;
    if (list.length > 1) {
      variants = el('select.kr-input.kr-select.kr-suggest-variants');
      list.slice(0, 5).forEach((c, i) => {
        const shown = isSecret ? `${c.value.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(8, c.value.length - 2)))}` : c.value;
        const o = el('option', { attr: { value: i } }, `${i + 1}. ${shown}`);
        if (i === f.index) o.selected = true;
        variants.append(o);
      });
      variants.addEventListener('change', () => {
        f.index = Number(variants.value);
        f.value = list[f.index].value;
        f.enabled = true;
        rerender();
      });
    }

    rows.append(el(`div.kr-suggest-row${f.enabled ? '.is-on' : ''}`, [
      checkbox('', f.enabled, (v) => {
        f.enabled = v;
        rerender();
      }),
      el('div.kr-suggest-label', [icon(meta.icon), el('span', meta.label)]),
      el('div.kr-suggest-main', [
        el('div.kr-suggest-input', [input, variants]),
        cand ? el('div.kr-suggest-src', [
          el('span.kr-muted', cand.lineIndex < 0 ? 'из свойств заметки' : `строка ${cand.lineIndex + 1}: `),
          cand.lineIndex < 0 ? null : el('span.kr-suggest-line', isSecret && !st.reveal ? cand.line.replace(cand.value, '•'.repeat(Math.min(10, cand.value.length))).trim() : highlight(cand.line, cand.value)),
          el(`span.kr-suggest-score.is-${cand.score >= 0.75 ? 'hi' : cand.score >= 0.55 ? 'mid' : 'lo'}`, `${Math.round(cand.score * 100)}%`),
        ]) : null,
        field === 'password' && f.enabled && f.value ? strengthMeter(analyzePassword(f.value)) : null,
      ]),
    ]));
  }
  panel.append(rows);

  const { result, removed } = buildResult(entry, picks, st);
  panel.append(el('div.kr-suggest-opts', [
    checkbox('Убрать перенесённые строки из заметки', st.removeLines, (v) => {
      st.removeLines = v;
      rerender();
    }),
    checkbox('Показать секреты', st.reveal, (v) => {
      st.reveal = v;
      rerender();
    }),
  ]));

  // предпросмотр результата
  const previewBtn = el('button.kr-collapse-toggle', { attr: { type: 'button' } }, [
    icon(st.preview ? 'chevron-up' : 'chevron-down'),
    el('span', st.preview ? 'Скрыть предпросмотр' : 'Предпросмотр результата'),
  ]);
  previewBtn.addEventListener('click', () => {
    st.preview = !st.preview;
    rerender();
  });
  panel.append(previewBtn);
  if (st.preview) {
    const fieldsPreview = el('div.kr-suggest-preview-fields', ['username', 'password', 'url', 'totp']
      .filter((k) => result[k])
      .map((k) => el('div', [
        el('span.kr-muted', LABELS[k].label),
        el('b.is-mono', (k === 'password' || k === 'totp') && !st.reveal ? '••••••••••' : result[k]),
        entry[k] !== result[k] ? el('span.kr-suggest-new', 'новое') : null,
      ])));
    const lines = entry.notes.split('\n');
    const notesPreview = el('div.kr-suggest-diff', lines.map((line, i) => el(`div${removed.has(i) ? '.is-removed' : ''}`, line || ' ')));
    panel.append(el('div.kr-suggest-preview', [
      el('div.kr-suggest-preview-head', [icon('eye'), el('span', `Так будет выглядеть запись${result.type !== entry.type ? ' (тип станет «Логин»)' : ''}`)]),
      fieldsPreview,
      el('div.kr-suggest-preview-head', [icon('file-text'), el('span', removed.size ? `Заметка: уберётся строк — ${removed.size}` : 'Заметка останется без изменений')]),
      notesPreview,
    ]));
  }

  const enabledCount = Object.values(st.fields).filter((f) => f.enabled && f.value.trim()).length;
  const apply = button(enabledCount ? `Перенести в поля (${enabledCount})` : 'Перенести в поля', 'check', async () => {
    if (!enabledCount) return;
    apply.disabled = true;
    const final = buildResult(entry, picks, st).result;
    final.updated = Date.now();
    await vault.save(final);
    view.suggestState.delete(entry.id);
    view.core.notice('Данные перенесены в поля записи');
    if (opts.onApplied) opts.onApplied(final);
    else view.render();
  }, 'kr-btn-primary');
  apply.disabled = !enabledCount;

  panel.append(el('div.kr-suggest-actions', [
    apply,
    button('Открыть в редакторе', 'pencil', () => {
      const prefill = buildResult(entry, picks, st).result;
      if (opts.onClose) opts.onClose();
      view.openEditor(entry, { prefill });
    }, 'kr-btn-ghost'),
  ]));
  return panel;
}

module.exports = { renderSuggestPanel, hasSuggestions };
