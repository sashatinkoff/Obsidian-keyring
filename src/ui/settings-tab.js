'use strict';
/* Глобальные настройки (используются и во вкладке Obsidian, и внутри Keyring). */
const { PluginSettingTab, Setting } = require('obsidian');
const { applyEverywhere } = require('../util/theme');
const { formatNumber } = require('../util/format');
const { el } = require('../util/dom');

function dropdown(setting, options, value, onChange) {
  setting.addDropdown((d) => {
    for (const [k, label] of options) d.addOption(String(k), label);
    d.setValue(String(value));
    d.onChange((v) => onChange(v));
  });
}

function buildGlobalSettings(container, core, refresh) {
  const s = core.settings;
  const save = async () => {
    await core.saveSettings();
    if (refresh) refresh();
  };

  new Setting(container).setName('Безопасность').setHeading();

  dropdown(
    new Setting(container)
      .setName('Автоблокировка')
      .setDesc('Заблокировать все хранилища после бездействия. Ключи стираются из памяти.'),
    [[1, '1 минута'], [2, '2 минуты'], [5, '5 минут'], [10, '10 минут'], [15, '15 минут'], [30, '30 минут'], [60, '1 час'], [0, 'Никогда']],
    s.autoLockMinutes,
    async (v) => {
      s.autoLockMinutes = Number(v);
      core.manager.touch();
      await save();
    }
  );

  new Setting(container)
    .setName('Блокировать при сворачивании')
    .setDesc('Когда окно Obsidian скрыто или приложение на телефоне уходит в фон.')
    .addToggle((t) => t.setValue(s.lockOnHide).onChange(async (v) => {
      s.lockOnHide = v;
      await save();
    }));

  new Setting(container)
    .setName('Блокировать при закрытии вкладки Keyring')
    .addToggle((t) => t.setValue(s.lockOnClose).onChange(async (v) => {
      s.lockOnClose = v;
      await save();
    }));

  dropdown(
    new Setting(container)
      .setName('Лимит попыток ввода пароля')
      .setDesc('После стольких неверных попыток ввод мастер-пароля блокируется на время ниже. Вход ключом восстановления работает всегда. Счётчик хранится только на этом устройстве.'),
    [[3, '3 попытки'], [5, '5 попыток'], [10, '10 попыток'], [0, 'Без ограничения']],
    s.lockoutAttempts === undefined ? 3 : s.lockoutAttempts,
    async (v) => {
      s.lockoutAttempts = Number(v);
      await save();
    }
  );

  dropdown(
    new Setting(container)
      .setName('Блокировка после лимита')
      .setDesc('На сколько блокировать ввод пароля.'),
    [[1, '1 минута'], [5, '5 минут'], [15, '15 минут'], [30, '30 минут'], [60, '1 час']],
    s.lockoutMinutes === undefined ? 5 : s.lockoutMinutes,
    async (v) => {
      s.lockoutMinutes = Number(v);
      await save();
    }
  );

  dropdown(
    new Setting(container)
      .setName('Очистка буфера обмена')
      .setDesc('Через сколько секунд стереть скопированный секрет (если в буфере всё ещё он).'),
    [[10, '10 секунд'], [20, '20 секунд'], [30, '30 секунд'], [45, '45 секунд'], [60, '1 минута'], [120, '2 минуты'], [0, 'Не очищать']],
    s.clipboardSeconds,
    async (v) => {
      s.clipboardSeconds = Number(v);
      await save();
    }
  );

  dropdown(
    new Setting(container)
      .setName('История паролей')
      .setDesc('Сколько прежних версий пароля хранить внутри записи (зашифрованно).'),
    [[0, 'Не хранить'], [3, '3 версии'], [5, '5 версий'], [10, '10 версий'], [20, '20 версий']],
    s.historyLimit,
    async (v) => {
      s.historyLimit = Number(v);
      await save();
    }
  );

  new Setting(container)
    .setName('Иконки сайтов')
    .setDesc('Загружать favicon через icons.duckduckgo.com. Внешний сервис увидит адреса сайтов из ваших записей — по умолчанию выключено.')
    .addToggle((t) => t.setValue(s.favicons).onChange(async (v) => {
      s.favicons = v;
      await save();
    }));

  dropdown(
    new Setting(container)
      .setName('Итерации PBKDF2 для новых хранилищ')
      .setDesc('Больше — устойчивее к перебору, но дольше разблокировка на телефоне. Для существующего хранилища меняется вместе с мастер-паролем.'),
    [[310000, '310 000 (быстрее)'], [600000, '600 000 (рекомендуется)'], [1000000, '1 000 000'], [2000000, '2 000 000 (медленно на телефоне)']],
    s.iterations,
    async (v) => {
      s.iterations = Number(v);
      await save();
    }
  );

  new Setting(container).setName('Интерфейс').setHeading();
  dropdown(
    new Setting(container)
      .setName('Тема')
      .setDesc('«Авто» — как в Obsidian: переключается вместе с ним (и с системой, если в Obsidian выбрано «Как в системе»). Или задайте тему принудительно.'),
    [['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']],
    s.theme || 'auto',
    async (v) => {
      s.theme = v;
      await save();
      applyEverywhere();
    }
  );
  dropdown(
    new Setting(container)
      .setName('Оформление')
      .setDesc('«Keyring» — фирменный стиль. «Material 3» — стандартный дизайн Google: тональные поверхности, скруглённые кнопки, без свечений. Работает со светлой и тёмной темой.'),
    [['keyring', 'Keyring'], ['m3', 'Material 3']],
    s.design || 'keyring',
    async (v) => {
      s.design = v;
      await save();
      applyEverywhere();
    }
  );
  dropdown(
    new Setting(container)
      .setName('Вид интерфейса')
      .setDesc('«Авто» выбирает по ширине окна. «Компактный» — как на телефоне, удобен на планшете в портретной ориентации. Переключается и кнопкой в верхней панели.'),
    [['auto', 'Авто'], ['full', 'Полный'], ['compact', 'Компактный']],
    s.uiLayout || 'auto',
    async (v) => {
      s.uiLayout = v;
      await save();
      core.app.workspace.getLeavesOfType('keyring-view').forEach((l) => {
        if (l.view && l.view.updateMode) {
          l.view.updateMode(true);
          l.view.render();
        }
      });
    }
  );
  dropdown(
    new Setting(container)
      .setName('Отступ сверху на телефоне')
      .setDesc('Если шапка Keyring уходит под статус-бар (режим edge-to-edge), увеличьте отступ. «Авто» определяет его по безопасной зоне экрана.'),
    [['auto', 'Авто'], [0, 'Нет'], [24, '24 px'], [32, '32 px'], [44, '44 px'], [56, '56 px'], [72, '72 px']],
    s.mobileTopInset === undefined ? 'auto' : s.mobileTopInset,
    async (v) => {
      s.mobileTopInset = v === 'auto' ? 'auto' : Number(v);
      await save();
      core.app.workspace.getLeavesOfType('keyring-view').forEach((l) => l.view && l.view.updateInsets && l.view.updateInsets());
    }
  );

  dropdown(
    new Setting(container)
      .setName('Отступ снизу на телефоне')
      .setDesc('Если нижнее меню Keyring скрыто под панелью навигации телефона или Obsidian, увеличьте отступ.'),
    [['auto', 'Авто'], [0, 'Нет'], [16, '16 px'], [24, '24 px'], [32, '32 px'], [48, '48 px'], [64, '64 px'], [80, '80 px']],
    s.mobileBottomInset === undefined ? 'auto' : s.mobileBottomInset,
    async (v) => {
      s.mobileBottomInset = v === 'auto' ? 'auto' : Number(v);
      await save();
      core.app.workspace.getLeavesOfType('keyring-view').forEach((l) => l.view && l.view.updateInsets && l.view.updateInsets());
    }
  );

  new Setting(container).setName('Генератор по умолчанию').setHeading();
  const g = s.generator;
  new Setting(container)
    .setName('Длина пароля')
    .addSlider((sl) => sl.setLimits(8, 64, 1).setValue(g.length).setDynamicTooltip().onChange(async (v) => {
      g.length = v;
      await save();
    }));
  for (const [key, label] of [['upper', 'Заглавные A-Z'], ['lower', 'Строчные a-z'], ['digits', 'Цифры 0-9'], ['symbols', 'Спецсимволы !@#$'], ['noSimilar', 'Исключать похожие (Il1O0)']]) {
    new Setting(container).setName(label).addToggle((t) => t.setValue(!!g[key]).onChange(async (v) => {
      g[key] = v;
      await save();
    }));
  }
}

class KeyringSettingTab extends PluginSettingTab {
  constructor(app, plugin, core) {
    super(app, plugin);
    this.core = core;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const core = this.core;

    new Setting(containerEl).setName('Хранилища').setHeading();
    const vaults = core.manager.list();
    if (!vaults.length) {
      containerEl.append(el('p.setting-item-description', 'Хранилищ пока нет. Создайте первое в окне Keyring.'));
    }
    for (const v of vaults) {
      new Setting(containerEl)
        .setName(v.name)
        .setDesc(`${v.folder} · ${v.unlocked ? 'открыто' : 'заблокировано'} · PBKDF2 × ${formatNumber(v.iterations)}`)
        .addButton((b) => b.setButtonText('Открыть').onClick(async () => {
          const view = await core.activateView();
          if (view) view.selectVault(v.folder);
        }))
        .addExtraButton((b) => b.setIcon('x').setTooltip('Убрать из списка (файлы не удаляются)').onClick(async () => {
          await core.manager.forget(v);
          this.display();
        }));
    }
    new Setting(containerEl)
      .addButton((b) => b.setButtonText('Открыть Keyring').setCta().onClick(() => core.activateView()))
      .addButton((b) => b.setButtonText('Найти хранилища').onClick(async () => {
        await core.manager.discover();
        this.display();
      }));

    const rec = core.settings.recovery;
    new Setting(containerEl)
      .setName('Ключ восстановления')
      .setDesc(rec ? `Включён (ID ${rec.id}). Управление — в Keyring → Настройки.` : 'Не создан. Без него забытый мастер-пароль означает потерю данных.')
      .addButton((b) => b.setButtonText(rec ? 'Открыть' : 'Создать…').onClick(async () => {
        const view = await core.activateView();
        if (view) view.setTab('settings');
      }));

    buildGlobalSettings(containerEl, core);
  }
}

module.exports = { KeyringSettingTab, buildGlobalSettings };
