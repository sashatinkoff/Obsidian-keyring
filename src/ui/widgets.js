'use strict';
/* Переиспользуемые виджеты: шкала стойкости, опции генератора, цветной пароль. */
const { el } = require('../util/dom');

/** Пять сегментов + подпись (как в макете). */
function strengthMeter(s) {
  const filled = s.empty ? 0 : s.level + 1;
  return el(`div.kr-meter.is-l${s.level}`, [
    el('div.kr-meter-bars', [0, 1, 2, 3, 4].map((i) => el(`i${i < filled ? '.is-on' : ''}`))),
    el('div.kr-meter-label', [
      el('b', s.empty ? '—' : s.label),
      s.empty ? null : el('span', `${s.score}/100 · ~${Math.round(s.bits)} бит`),
    ]),
  ]);
}

function checkbox(label, checked, onChange) {
  const input = el('input', { attr: { type: 'checkbox' } });
  input.checked = !!checked;
  const node = el(`label.kr-check${checked ? '.is-on' : ''}`, [input, el('span.kr-check-box'), label ? el('span', label) : null]);
  input.addEventListener('change', () => {
    node.classList.toggle('is-on', input.checked); // визуальное состояние
    onChange(input.checked);
  });
  return node;
}

/** Длина + наборы символов. gen мутируется, onChange вызывается после изменения. */
function generatorOptions(gen, onChange) {
  const lenValue = el('b', `${gen.length}`);
  const range = el('input.kr-range', { attr: { type: 'range', min: 8, max: 64, step: 1 } });
  range.value = String(gen.length);
  range.addEventListener('input', () => {
    gen.length = Number(range.value);
    lenValue.textContent = String(gen.length);
    range.style.setProperty('--kr-fill', `${((gen.length - 8) / 56) * 100}%`);
    onChange();
  });
  range.style.setProperty('--kr-fill', `${((gen.length - 8) / 56) * 100}%`);

  const toggle = (key, label) => {
    const node = checkbox(label, gen[key], (v) => {
      gen[key] = v;
      if (!gen.lower && !gen.upper && !gen.digits && !gen.symbols) {
        gen.lower = true;
        const lower = wrap.querySelector('[data-k="lower"] input');
        if (lower) lower.checked = true;
      }
      onChange(true);
    });
    node.setAttribute('data-k', key);
    return node;
  };

  const wrap = el('div.kr-genopts');
  wrap.append(
    el('div.kr-genopts-len', [el('span', ['Длина: ', lenValue, ' симв.']), range]),
    el('div.kr-genopts-checks', [
      toggle('upper', 'A-Z'),
      toggle('lower', 'a-z'),
      toggle('digits', '0-9'),
      toggle('symbols', '!@#$%^&*'),
      toggle('noSimilar', 'Без похожих (Il1O0)'),
    ]),
  );
  wrap.addEventListener('change', () => {
    wrap.querySelectorAll('.kr-check').forEach((l) => {
      l.classList.toggle('is-on', l.querySelector('input').checked);
    });
  });
  return wrap;
}

/** Пароль с подсветкой классов символов. */
function colorPassword(pw) {
  const box = el('span.kr-colorpw');
  for (const ch of Array.from(pw)) {
    let cls = 'is-letter';
    if (/\d/.test(ch)) cls = 'is-digit';
    else if (!/\p{L}/u.test(ch)) cls = 'is-symbol';
    box.append(el(`span.${cls}`, ch));
  }
  return box;
}

module.exports = { strengthMeter, generatorOptions, colorPassword, checkbox };
