'use strict';
/* Небольшие DOM-хелперы, не зависящие от расширений Obsidian. */
const { setIcon } = require('obsidian');

/**
 * el('div.kr-card.is-open', { text, attr, on, style, title }, [children])
 * Второй аргумент может быть строкой (текст) или массивом (дети).
 */
function el(spec, opts, children) {
  const parts = spec.split('.');
  const node = document.createElement(parts[0] || 'div');
  const classes = parts.slice(1).filter(Boolean);
  if (classes.length) node.className = classes.join(' ');

  if (Array.isArray(opts) || opts instanceof Node) {
    children = opts;
    opts = null;
  } else if (typeof opts === 'string' || typeof opts === 'number') {
    node.textContent = String(opts);
    opts = null;
  }

  if (opts) {
    if (opts.cls) node.className = [node.className, opts.cls].filter(Boolean).join(' ');
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.title) node.title = opts.title;
    if (opts.attr) {
      for (const [k, v] of Object.entries(opts.attr)) {
        if (v === null || v === undefined || v === false) continue;
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (opts.style) Object.assign(node.style, opts.style);
    if (opts.on) {
      for (const [ev, fn] of Object.entries(opts.on)) node.addEventListener(ev, fn);
    }
    if (opts.icon) node.prepend(icon(opts.icon));
  }

  append(node, children);
  return node;
}

function append(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (!Array.isArray(children)) children = [children];
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Lucide переименовывает иконки между версиями; Obsidian разных версий
// несёт разные наборы — пробуем альтернативные имена.
const ALIASES = {
  'lock-open': ['unlock'],
  'alert-triangle': ['triangle-alert'],
  'alert-circle': ['circle-alert'],
  'check-circle-2': ['circle-check', 'check-circle'],
  'circle-user': ['user-circle', 'user'],
  'id-card': ['contact', 'tag'],
  'file-pen-line': ['file-edit', 'pencil'],
  'folder-output': ['folder-up', 'folder-open'],
  'folder-root': ['folder'],
  'folder-x': ['folder-minus', 'trash-2'],
  smartphone: ['tablet-smartphone', 'phone'],
  'file-clock': ['history', 'clock'],
  braces: ['code', 'file-json'],
  table: ['sheet', 'grid'],
  files: ['copy', 'file-text'],
  menu: ['align-justify', 'more-vertical'],
  sun: ['sun-medium', 'lightbulb'],
  moon: ['moon-star', 'lightbulb-off'],
  'rectangle-ellipsis': ['form-input', 'hash'],
  'credit-card': ['wallet', 'id-card'],
  'file-check': ['file-check-2', 'file'],
  'folder-down': ['folder-input', 'folder'],
  'sticky-note': ['file-text'],
  history: ['clock', 'rotate-ccw'],
  'rotate-ccw': ['undo-2', 'undo'],
  monitor: ['laptop', 'app-window'],
  tag: ['tags', 'hash'],
  'scan-text': ['scan-line', 'file-text'],
  'key-square': ['key'],
  'sliders-horizontal': ['sliders'],
  'git-pull-request-arrow': ['git-pull-request'],
  'file-lock': ['lock'],
  'folder-tree': ['folder'],
  'chevrons-up-down': ['chevron-down'],
  'chevrons-down-up': ['chevron-up'],
  'wand-2': ['wand', 'sparkles', 'search'],
  'life-buoy': ['lifebuoy', 'help-circle', 'key-round'],
  printer: ['file-text'],
  'file-key': ['file-key-2', 'key-round'],
};

function icon(name, cls) {
  const span = document.createElement('span');
  span.className = `kr-icon${cls ? ` ${cls}` : ''}`;
  const names = [name].concat(ALIASES[name] || []);
  for (const n of names) {
    setIcon(span, n);
    if (span.querySelector('svg')) break;
  }
  return span;
}

/** Кнопка-иконка с подсказкой. */
function iconButton(name, title, onClick, cls) {
  return el(`button.kr-icon-btn${cls ? `.${cls.split(' ').join('.')}` : ''}`, {
    attr: { 'aria-label': title, type: 'button' },
    title,
    on: {
      click: (e) => {
        e.stopPropagation();
        onClick(e);
      },
    },
  }, [icon(name)]);
}

function button(label, iconName, onClick, cls) {
  return el(`button.kr-btn${cls ? `.${cls.split(' ').join('.')}` : ''}`, {
    attr: { type: 'button' },
    on: {
      click: (e) => {
        e.stopPropagation();
        onClick(e);
      },
    },
  }, [iconName ? icon(iconName) : null, label ? el('span', label) : null]);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

module.exports = { el, append, icon, iconButton, button, clear };
