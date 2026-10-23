'use strict';
/* Вкладка «Генератор»: генерация, проверка произвольного пароля, история сессии. */
const { el, icon, iconButton, button, clear } = require('../util/dom');
const { generatePassword, generatorEntropy } = require('../crypto/generator');
const { analyzePassword } = require('../crypto/strength');
const { strengthMeter, generatorOptions, colorPassword } = require('./widgets');
const { maskTail } = require('../util/format');

const sessionHistory = [];

function renderGeneratorPage(view) {
  const gen = view.genState || (view.genState = Object.assign({}, view.settings.generator));
  const page = el('div.kr-page.kr-gen-page');

  let current = view.genCurrent || generatePassword(gen);
  view.genCurrent = current;

  const output = el('div.kr-gen-big');
  const meterHost = el('div');
  const entropyChip = el('span.kr-chip.kr-chip-mint');
  const historyHost = el('div.kr-gen-history');

  const renderHistory = () => {
    clear(historyHost);
    if (!sessionHistory.length) {
      historyHost.append(el('div.kr-muted', 'Здесь появятся пароли, сгенерированные в этой сессии. Они не сохраняются на диск.'));
      return;
    }
    for (const pw of sessionHistory.slice(0, 8)) {
      historyHost.append(el('div.kr-gen-hrow', [
        el('span.is-mono', maskTail(pw, 3)),
        el('span.kr-muted', `${pw.length} симв.`),
        el('div.kr-spacer'),
        iconButton('copy', 'Скопировать', () => view.copy(pw, 'пароль')),
      ]));
    }
  };

  const show = () => {
    clear(output).append(colorPassword(current));
    entropyChip.textContent = `${generatorEntropy(gen)}-bit энтропия`;
    clear(meterHost).append(strengthMeter(analyzePassword(current)));
  };
  const regenerate = () => {
    current = generatePassword(gen);
    view.genCurrent = current;
    show();
  };
  const copy = () => {
    view.copy(current, 'пароль');
    if (sessionHistory[0] !== current) sessionHistory.unshift(current);
    if (sessionHistory.length > 20) sessionHistory.pop();
    renderHistory();
  };
  show();
  renderHistory();

  page.append(el('div.kr-page-head', [
    el('div', [el('h1', 'Генератор паролей'), el('p.kr-muted', 'Криптостойкий генератор на crypto.getRandomValues — работает и без разблокировки хранилища.')]),
  ]));

  const main = el('div.kr-panel.kr-gen-main', [
    el('div.kr-genbox-head', [icon('sliders-horizontal'), el('span', 'Генератор криптостойких паролей'), el('div.kr-spacer'), entropyChip]),
    el('div.kr-gen-output.is-big', [
      output,
      iconButton('refresh-cw', 'Сгенерировать заново', regenerate),
      iconButton('copy', 'Скопировать', copy),
    ]),
    meterHost,
    generatorOptions(gen, regenerate),
    el('div.kr-gen-actions', [
      button('Скопировать', 'copy', copy, 'kr-btn-primary'),
      button('Сделать настройками по умолчанию', 'save', async () => {
        view.settings.generator = Object.assign({}, gen);
        await view.core.saveSettings();
        view.core.notice('Настройки генератора сохранены');
      }, 'kr-btn-ghost'),
    ]),
  ]);

  const checkInput = el('input.kr-input', {
    attr: { type: 'password', placeholder: 'Вставьте пароль для проверки', autocomplete: 'off', spellcheck: 'false' },
  });
  const checkResult = el('div');
  const runCheck = () => {
    clear(checkResult);
    if (!checkInput.value) return;
    const s = analyzePassword(checkInput.value);
    checkResult.append(strengthMeter(s));
    const tips = [];
    if (checkInput.value.length < 12) tips.push('Короче 12 символов');
    if (!/[^a-zA-Z0-9]/.test(checkInput.value)) tips.push('Нет спецсимволов');
    if (/^[a-zа-яё]+$/i.test(checkInput.value)) tips.push('Только буквы');
    if (s.bits <= 12) tips.push('Похоже на частый пароль или дату');
    if (tips.length) checkResult.append(el('ul.kr-tips', tips.map((t) => el('li', [icon('alert-circle'), t]))));
  };
  checkInput.addEventListener('input', runCheck);
  const check = el('div.kr-panel', [
    el('div.kr-panel-head', [icon('shield-question'), el('span', 'Проверка пароля')]),
    el('p.kr-muted', 'Проверка выполняется локально, ничего не сохраняется и не отправляется.'),
    el('div.kr-gen-output', [
      checkInput,
      iconButton('eye', 'Показать/скрыть', () => {
        checkInput.type = checkInput.type === 'password' ? 'text' : 'password';
      }),
    ]),
    checkResult,
  ]);

  const history = el('div.kr-panel', [
    el('div.kr-panel-head', [icon('history'), el('span', 'Скопированные в этой сессии')]),
    historyHost,
  ]);

  page.append(el('div.kr-gen-layout', [main, el('div.kr-gen-col', [check, history])]));
  return page;
}

function clearGeneratorHistory() {
  sessionHistory.length = 0;
}

module.exports = { renderGeneratorPage, clearGeneratorHistory };
