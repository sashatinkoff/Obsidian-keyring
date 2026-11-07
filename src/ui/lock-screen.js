'use strict';
/* Экран блокировки и первый запуск. */
const { Platform } = require('obsidian');
const { CIPHER_LABEL, KDF_LABEL, APP_VERSION } = require('../constants');
const { el, icon, button } = require('../util/dom');
const { checkbox } = require('./widgets');
const { countLabel, formatNumber, formatCountdown } = require('../util/format');
const { passwordErrorText } = require('./modals');
const { RecoverModal, pickKeyFile } = require('./recovery');
const { RemoveVaultModal } = require('./remove-vault');

/** Вход по PIN-коду: точки-индикатор, цифровое поле, автоотправка при наборе всех цифр. */
function renderPinUnlock(view, vault) {
  const info = view.manager.pinInfo(vault) || { length: 0, left: 5 };
  const box = el('div.kr-pin-unlock');
  const dots = el('div.kr-pin-dots', Array.from({ length: Math.max(info.length, 4) }, () => el('span')));
  const err = el('div.kr-pin-error');
  const input = el('input.kr-input.kr-pin-field', {
    attr: {
      type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 12, autocomplete: 'off',
      placeholder: 'PIN-код', 'aria-label': 'PIN-код', spellcheck: 'false',
    },
  });
  let busy = false;
  const paint = () => {
    dots.querySelectorAll('span').forEach((d, i) => d.classList.toggle('is-on', i < input.value.length));
  };
  const go = async () => {
    if (busy || input.value.length < 4) return;
    busy = true;
    box.classList.add('is-busy');
    err.textContent = '';
    try {
      await view.manager.unlockWithPin(vault, input.value);
    } catch (e) {
      busy = false;
      box.classList.remove('is-busy');
      input.value = '';
      paint();
      if (e.name === 'PinError' && e.left === 0) {
        view.pinFallback.add(vault.folder);
        view.core.notice(e.message, 8000);
        view.render();
        return;
      }
      err.textContent = e.message;
      box.classList.remove('is-shake');
      void box.offsetWidth;
      box.classList.add('is-shake');
      input.focus();
    }
  };
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 12);
    if (digits !== input.value) input.value = digits;
    paint();
    if (info.length && digits.length === info.length) go();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  box.append(
    el('div.kr-pin-title', [icon('rectangle-ellipsis'), el('span', 'Введите PIN-код')]),
    dots,
    el('div.kr-lock-form', [input, button('Открыть', 'lock-open', go, 'kr-btn-primary kr-btn-lg')]),
    err,
    el('div.kr-pin-links', [
      el('button.kr-link', {
        attr: { type: 'button' },
        on: { click: () => { view.pinFallback.add(vault.folder); view.render(); } },
      }, [icon('key-round'), 'Войти мастер-паролем']),
    ]),
  );
  window.setTimeout(() => {
    if (!Platform.isMobile && input.isConnected) input.focus();
  }, 60);
  return box;
}

function renderLockScreen(view, vault) {
  const wrap = el('div.kr-lock');
  const error = el('div.kr-lock-error');
  const input = el('input.kr-input.kr-lock-input', {
    attr: {
      type: 'password', placeholder: 'Мастер-пароль', autocomplete: 'current-password', spellcheck: 'false',
    },
  });
  const submit = button('Разблокировать', 'lock-open', () => go(), 'kr-btn-primary kr-btn-lg');
  const deviceMode = view.manager.deviceMode(vault);
  const remembered = deviceMode === 'none';
  const pinMode = deviceMode === 'pin' && !view.pinFallback.has(vault.folder);
  let rememberOn = false;
  const rememberBox = deviceMode !== 'password' ? null : checkbox('Не спрашивать пароль на этом устройстве', false, (v) => {
    rememberOn = v;
  });
  const pinBlock = pinMode ? renderPinUnlock(view, vault) : null;

  // запомнено на этом устройстве: открывается сам (если не заблокирован вручную) или одним нажатием
  if (remembered && view.manager.canAutoUnlock(vault) && !view.autoUnlockTried.has(vault.folder)) {
    view.autoUnlockTried.add(vault.folder);
    view.manager.unlockRemembered(vault).then((ok) => {
      if (!ok) view.render();
    }).catch(() => view.render());
  }
  const quick = remembered ? el('div.kr-lock-quick', [
    button('Открыть — пароль не нужен', 'lock-open', async () => {
      const ok = await view.manager.unlockRemembered(vault).catch(() => false);
      if (!ok) {
        error.textContent = 'Не удалось открыть без пароля — введите мастер-пароль.';
        view.render();
      }
    }, 'kr-btn-primary kr-btn-lg kr-lock-quick-btn'),
    el('div.kr-lock-quick-note', [
      icon('smartphone'),
      el('span', 'Хранилище запомнено на этом устройстве. '),
      el('button.kr-link', {
        attr: { type: 'button' },
        on: {
          click: async () => {
            await view.manager.setRemembered(vault, false);
            view.core.notice(`«${vault.name}»: снова спрашивать пароль на этом устройстве`);
            view.render();
          },
        },
      }, 'Снова спрашивать пароль'),
    ]),
  ]) : null;

  // ограничение попыток: пароль заблокирован, но вход ключом восстановления доступен
  const lock = view.manager.lockout.status(vault);
  if (lock.locked) {
    input.disabled = true;
    submit.disabled = true;
    input.placeholder = 'Ввод пароля временно заблокирован';
    wrap.classList.add('is-locked-out');
    error.append(
      icon('timer'),
      el('span', ' Слишком много неверных попыток. Повторите через '),
      el('b.kr-lockout-time', { attr: { 'data-until': lock.until } }, formatCountdown(lock.remainingMs)),
      el('span', ' — или откройте ключом восстановления ниже.'),
    );
  }

  async function go() {
    const pw = input.value;
    if (!pw) {
      input.focus();
      return;
    }
    submit.disabled = true;
    input.disabled = true;
    wrap.classList.add('is-busy');
    error.textContent = '';
    submit.querySelector('span:last-child').textContent = 'Расшифровка…';
    try {
      await view.manager.unlock(vault, pw, { remember: rememberOn });
    } catch (e) {
      wrap.classList.remove('is-busy');
      submit.disabled = false;
      input.disabled = false;
      submit.querySelector('span:last-child').textContent = 'Разблокировать';
      if (e.name === 'LockoutError' || e.lockedUntil) {
        view.render(); // показать экран с таймером
        return;
      }
      error.textContent = passwordErrorText(e);
      wrap.classList.remove('is-shake');
      void wrap.offsetWidth;
      wrap.classList.add('is-shake');
      input.select();
      input.focus();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  const others = view.manager.list().filter((v) => v !== vault);
  const count = vault.fileCount;

  wrap.append(el('div.kr-lock-card', [
    el('div.kr-lock-glyph', [icon('lock-keyhole')]),
    el('h2.kr-lock-title', vault.name),
    el('div.kr-lock-sub', [
      icon('folder'),
      el('span', vault.folder),
      count !== null && count !== undefined ? el('span.kr-muted', ` · ${countLabel(count, ['запись', 'записи', 'записей'])}`) : null,
    ]),
    quick,
    quick ? el('div.kr-lock-or', [el('span', 'или паролем')]) : null,
    pinBlock,
    pinBlock ? null : el('div.kr-lock-form', [input, submit]),
    pinBlock ? null : (rememberBox ? el('div.kr-lock-remember', [rememberBox]) : null),
    deviceMode === 'pin' && !pinBlock ? el('button.kr-link.kr-lock-pinback', {
      attr: { type: 'button' },
      on: { click: () => { view.pinFallback.delete(vault.folder); view.render(); } },
    }, [icon('rectangle-ellipsis'), 'Войти по PIN-коду']) : null,
    error,
    el('div.kr-lock-alt', [
      el('div.kr-lock-or', [el('span', 'или')]),
      button('Открыть файлом ключа восстановления', 'file-key', async () => {
        const file = await pickKeyFile();
        if (file) new RecoverModal(view, vault, { file, mode: 'open' }).open();
      }, 'kr-btn-soft kr-keyfile-btn'),
      el('button.kr-link.kr-forgot', {
        attr: { type: 'button' },
        on: { click: () => new RecoverModal(view, vault, { mode: 'reset' }).open() },
      }, [icon('life-buoy'), 'Забыли пароль? Задать новый по ключу']),
      vault.hasRecovery() ? null : el('small.kr-muted', 'Ключ восстановления для этого хранилища пока не сохранён'),
    ]),
    el('div.kr-lock-meta', [
      el('span.kr-chip.kr-chip-mint', [icon('shield-check'), CIPHER_LABEL]),
      el('span.kr-chip', [icon('fingerprint'), `${KDF_LABEL} × ${formatNumber(vault.iterations)}`]),
    ]),
    others.length ? el('div.kr-lock-others', [
      el('div.kr-lock-others-title', 'Другие хранилища'),
      el('div.kr-lock-others-list', others.map((v) => el('button.kr-chip.kr-chip-btn', {
        attr: { type: 'button' },
        on: { click: () => view.selectVault(v.folder) },
      }, [icon(v.unlocked ? 'lock-open' : 'lock'), v.name]))),
    ]) : null,
    el('div.kr-lock-links', [
      el('button.kr-link', {
        attr: { type: 'button' },
        on: { click: () => view.createVault() },
      }, [icon('folder-plus'), 'Создать новое хранилище']),
      el('button.kr-link.kr-lock-remove', {
        attr: { type: 'button' },
        on: { click: () => new RemoveVaultModal(view, vault).open() },
      }, [icon('folder-x'), 'Убрать это хранилище…']),
    ]),
    el('div.kr-version', `Keyring v${APP_VERSION}`),
  ]));

  // На телефоне не открываем клавиатуру сами: иначе форма прыгает при загрузке.
  // Когда клавиатура появилась, аккуратно держим поле в видимой области.
  const vv = window.visualViewport;
  const keepVisible = () => {
    if (!input.isConnected) {
      if (vv) vv.removeEventListener('resize', keepVisible); // экран блокировки уже закрыт
      return;
    }
    window.setTimeout(() => {
      if (document.activeElement === input) input.scrollIntoView({ block: 'nearest' });
    }, 250);
  };
  input.addEventListener('focus', keepVisible);
  if (vv) vv.addEventListener('resize', keepVisible);
  if (!lock.locked && !Platform.isMobile && view.mode !== 'narrow') window.setTimeout(() => input.focus(), 30);
  return wrap;
}

function renderOnboarding(view) {
  return el('div.kr-lock', [
    el('div.kr-lock-card.kr-onboard', [
      el('div.kr-lock-glyph.is-mint', [icon('key-round')]),
      el('h2.kr-lock-title', 'Keyring'),
      el('p.kr-onboard-text', 'Зашифрованные хранилища паролей и секретов прямо в папках Obsidian. '
        + 'Каждая папка-хранилище открывается своим мастер-паролем, данные на диске всегда зашифрованы, '
        + 'а файлы спокойно синхронизируются через Syncthing.'),
      el('ul.kr-onboard-list', [
        el('li', [icon('shield-check'), `${CIPHER_LABEL} + ${KDF_LABEL}, ключ не покидает память`]),
        el('li', [icon('folder-lock'), 'Отдельный пароль для каждой папки: «Пароли», «Документы»…']),
        el('li', [icon('refresh-cw'), 'Один файл на запись — конфликты синхронизации не ломают всё хранилище']),
        el('li', [icon('folder-lock'), 'Шифрование любой папки целиком: заметки, PDF, сканы — рекурсивно']),
      ]),
      el('div.kr-onboard-actions', [
        button('Создать хранилище', 'folder-plus', () => view.createVault(), 'kr-btn-primary kr-btn-lg'),
        button('Зашифровать папку…', 'folder-lock', () => view.convertFolder(''), 'kr-btn-soft kr-btn-lg'),
      ]),
      el('button.kr-link', {
        attr: { type: 'button' },
        on: { click: () => view.manager.discover() },
      }, [icon('search'), 'Найти существующие хранилища']),
      el('div.kr-version', `Keyring v${APP_VERSION}`),
    ]),
  ]);
}

module.exports = { renderLockScreen, renderOnboarding };
