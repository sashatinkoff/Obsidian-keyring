'use strict';
/* Окно «PIN-код для входа на этом устройстве». */
const { el, icon, button } = require('../util/dom');
const { BaseModal } = require('./modals');
const { pinWeakness } = require('../crypto/pin');

class SetPinModal extends BaseModal {
  constructor(view, vault) {
    super(view.app, `PIN-код для «${vault.name}»`);
    this.view = view;
    this.vault = vault;
  }

  build(c) {
    const mk = (ph) => el('input.kr-input.kr-pin-field', {
      attr: {
        type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 12, autocomplete: 'off', placeholder: ph, spellcheck: 'false',
      },
    });
    const a = mk('Новый PIN-код (4–12 цифр)');
    const b = mk('Повторите PIN-код');
    const err = el('div.kr-form-error');
    const warn = el('div.kr-pin-hint');
    const digitsOnly = (inp) => inp.addEventListener('input', () => {
      const d = inp.value.replace(/\D/g, '').slice(0, 12);
      if (d !== inp.value) inp.value = d;
      const w = a.value.length >= 4 ? pinWeakness(a.value) : null;
      warn.className = `kr-pin-hint${w ? ' is-bad' : ''}`;
      warn.textContent = w ? `Такой PIN легко угадать: ${w}.` : '';
    });
    digitsOnly(a);
    digitsOnly(b);
    const save = async () => {
      err.textContent = '';
      if (!/^\d{4,12}$/.test(a.value)) {
        err.textContent = 'PIN-код — от 4 до 12 цифр.';
        a.focus();
        return;
      }
      if (a.value !== b.value) {
        err.textContent = 'PIN-коды не совпадают.';
        b.select();
        return;
      }
      try {
        await this.view.manager.setPin(this.vault, a.value);
        this.close();
        this.view.core.notice(`«${this.vault.name}»: вход по PIN-коду на этом устройстве включён`);
        this.view.render();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    c.append(
      el('p.kr-modal-text', 'Хранилище будет открываться коротким PIN-кодом — только в этом приложении на этом устройстве. '
        + 'Мастер-пароль остаётся прежним и по-прежнему работает.'),
      el('div.kr-form-field', [a]),
      el('div.kr-form-field', [b]),
      warn,
      err,
      el('p.kr-hint', [icon('shield-check'), 'PIN не переносится на другие устройства и бесполезен без этого устройства. После 5 неверных попыток он стирается — нужен мастер-пароль.']),
      el('div.kr-modal-foot', [
        button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
        button('Включить вход по PIN', 'rectangle-ellipsis', save, 'kr-btn-primary'),
      ]),
    );
    window.setTimeout(() => a.focus(), 50);
  }
}

module.exports = { SetPinModal };
