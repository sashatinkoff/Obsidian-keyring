'use strict';
/* «Убрать хранилище»: скрыть из Keyring или удалить пустое (без записей). */
const { el, icon, button } = require('../util/dom');
const { countLabel } = require('../util/format');
const { BaseModal } = require('./modals');

class RemoveVaultModal extends BaseModal {
  constructor(view, vault) {
    super(view.app, `Убрать хранилище «${vault.name}»`);
    this.view = view;
    this.vault = vault;
    this.count = null;
    this.exists = true;
  }

  onOpen() {
    if (this.count === null) {
      const m = this.view.manager;
      Promise.all([m.recordCount(this.vault.folder), this.app.vault.adapter.exists(this.vault.folder)])
        .then(([n, ex]) => {
          this.count = n;
          this.exists = ex;
          super.onOpen();
        });
    }
    super.onOpen();
  }

  build(c) {
    const { vault, view } = this;
    const m = view.manager;
    const done = (msg) => {
      this.close();
      view.core.notice(msg, 6000);
      view.render();
    };
    c.append(el('div.kr-info-row', [el('span', 'Папка'), el('b.is-mono', vault.folder)]));
    if (this.count === null) {
      c.append(el('p.kr-modal-text', 'Проверяю папку…'));
      return;
    }
    c.append(el('div.kr-info-row', [el('span', 'Зашифрованных записей'), el('b', String(this.count))]));

    if (!this.exists) {
      c.append(el('p.kr-modal-text', 'Папки больше нет. Хранилище будет убрано из списка вместе с копией заголовка в настройках.'));
      c.append(el('div.kr-modal-foot', [
        button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
        button('Убрать', 'x', async () => {
          await m.forget(vault);
          done(`«${vault.name}» убрано`);
        }, 'kr-btn-primary'),
      ]));
      return;
    }

    if (this.count === 0) {
      c.append(el('p.kr-modal-text', 'В папке нет зашифрованных записей — только заголовок хранилища. '
        + 'Его можно удалить: Keyring перестанет считать папку хранилищем, обычные файлы в ней не затрагиваются.'));
      c.append(el('div.kr-modal-foot', [
        button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
        button('Удалить хранилище', 'trash-2', async () => {
          try {
            await m.removeEmpty(vault);
            done(`Хранилище «${vault.name}» удалено`);
          } catch (e) {
            view.core.notice(e.message, 8000);
          }
        }, 'kr-btn-danger'),
      ]));
      return;
    }

    c.append(
      el('p.kr-modal-text', `В папке ${countLabel(this.count, ['зашифрованная запись', 'зашифрованные записи', 'зашифрованных записей'])}. `
        + 'Keyring может скрыть хранилище: файлы останутся на месте, а вернуть его можно в «Настройки» → «Скрытые хранилища».'),
      el('p.kr-hint', [icon('info'), `Чтобы удалить данные совсем, удалите папку «${vault.folder}» в Obsidian — Keyring её больше не восстанавливает.`]),
      el('div.kr-modal-foot', [
        button('Отмена', null, () => this.close(), 'kr-btn-ghost'),
        button('Скрыть из Keyring', 'eye-off', async () => {
          await m.forget(vault);
          done(`«${vault.name}» скрыто. Вернуть: Настройки → Скрытые хранилища`);
        }, 'kr-btn-primary'),
      ]),
    );
  }
}

module.exports = { RemoveVaultModal };
