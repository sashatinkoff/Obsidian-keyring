'use strict';
/*
 * Тема Keyring: «авто» — как в Obsidian (а Obsidian может следовать системе),
 * либо принудительно светлая / тёмная. Класс .kr-theme-light / .kr-theme-dark
 * ставится на корень вида и на каждое окно плагина.
 */
let core = null;

function attach(c) {
  core = c;
}

/** Итоговая тема: 'light' | 'dark'. */
function resolveTheme() {
  const pref = core && core.settings ? core.settings.theme || 'auto' : 'auto';
  if (pref === 'light' || pref === 'dark') return pref;
  const body = typeof document !== 'undefined' ? document.body : null;
  if (body && body.classList.contains('theme-light')) return 'light';
  if (body && body.classList.contains('theme-dark')) return 'dark';
  // Obsidian ещё не выставил класс — смотрим на систему
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch (e) {
    return 'dark';
  }
}

function applyTheme(el) {
  if (!el) return;
  const t = resolveTheme();
  el.classList.toggle('kr-theme-light', t === 'light');
  el.classList.toggle('kr-theme-dark', t === 'dark');
  const design = core && core.settings ? core.settings.design || 'keyring' : 'keyring';
  el.classList.toggle('kr-style-m3', design === 'm3');
}

/** Перекрасить всё, что уже открыто: вкладки Keyring и окна плагина. */
function applyEverywhere() {
  document.querySelectorAll('.kr-view, .modal.kr-modal').forEach((el) => applyTheme(el));
}

module.exports = { attach, resolveTheme, applyTheme, applyEverywhere };
