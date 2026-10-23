'use strict';
/* Вкладка «Настройки» внутри Keyring: текущее хранилище, список хранилищ, глобальные опции. */
const { el, icon, button } = require('../util/dom');
const { formatDate, formatNumber, countLabel } = require('../util/format');
const { CIPHER_LABEL, KDF_LABEL } = require('../constants');
const { buildGlobalSettings } = require('./settings-tab');
const { RemoveVaultModal } = require('./remove-vault');
const { renderRecoveryPanel, renderHeaderPanel, CreateRecoveryKeyModal } = require('./recovery');
const {
  PromptModal, ChangePasswordModal, ConfirmModal,
} = require('./modals');

function infoRow(label, value, mono) {
  return el('div.kr-info-row', [el('span', label), el(`b${mono ? '.is-mono' : ''}`, value)]);
}

function vaultCard(view, vault) {
  const unlocked = vault.unlocked;
  const actions = [
    button('Переименовать', 'pencil', async () => {
      const name = await new PromptModal(view.app, { title: 'Название хранилища', value: vault.name, cta: 'Сохранить' }).ask();
      if (!name || !name.trim()) return;
      await vault.rename(name.trim());
      view.manager.emit('change');
    }, 'kr-btn-soft'),
  ];
  if (unlocked) {
    actions.push(
      button('Сменить мастер-пароль', 'key-round', () => new ChangePasswordModal(view.core, vault).open(), 'kr-btn-soft'),
      button(view.core.settings.recovery ? 'Сменить ключ восстановления' : 'Ключ восстановления', 'life-buoy',
        () => new CreateRecoveryKeyModal(view, { vault }).open(), 'kr-btn-soft'),
      button('Зашифровать папку…', 'folder-lock', () => view.convertFolder(vault.folder, vault), 'kr-btn-soft'),
      button('Заблокировать', 'lock', () => view.manager.lock(vault), 'kr-btn-soft')
    );
  } else {
    actions.push(button('Разблокировать', 'lock-open', () => view.setTab('vault'), 'kr-btn-primary'));
  }

  return el('section.kr-panel.kr-vault-card', [
    el('div.kr-panel-head', [icon(unlocked ? 'lock-open' : 'lock'), el('span', `Хранилище «${vault.name}»`), el('div.kr-spacer'),
      el(`span.kr-chip${unlocked ? '.kr-chip-mint' : ''}`, unlocked ? 'открыто' : 'заблокировано')]),
    el('div.kr-info', [
      infoRow('Папка', vault.folder, true),
      infoRow('Записей', unlocked ? String(vault.entries.size) : (vault.fileCount ?? '—').toString()),
      infoRow('Создано', formatDate(vault.header.created)),
      infoRow('Шифрование', CIPHER_LABEL),
      infoRow('Ключ из пароля', `${KDF_LABEL} × ${formatNumber(vault.iterations)}`),
      vault.header.changed ? infoRow('Пароль менялся', formatDate(vault.header.changed)) : null,
    ]),
    el('div.kr-actions-row', actions),
    unlocked ? el('p.kr-hint', [icon('info'), 'Смена пароля перешифровывает только ключ в keyring.vault.json — записи не трогаются, и на других устройствах достаточно ввести новый пароль после синхронизации.']) : null,
  ]);
}

function vaultsList(view) {
  const list = view.manager.list();
  return el('section.kr-panel', [
    el('div.kr-panel-head', [icon('library'), el('span', 'Все хранилища'), el('div.kr-spacer'),
      button('Зашифровать папку', 'folder-lock', () => view.convertFolder(''), 'kr-btn-ghost kr-btn-sm'),
      button('Новое', 'folder-plus', () => view.createVault(), 'kr-btn-soft kr-btn-sm')]),
    el('div.kr-vault-list', list.map((v) => el(`div.kr-vault-row${v === view.vault ? '.is-active' : ''}`, [
      icon(v.unlocked ? 'lock-open' : 'lock'),
      el('div.kr-grow', [el('b', v.name), el('small.is-mono', v.folder)]),
      el('span.kr-muted', v.unlocked ? countLabel(v.entries.size, ['запись', 'записи', 'записей']) : (v.fileCount !== null ? countLabel(v.fileCount, ['запись', 'записи', 'записей']) : '')),
      button('Открыть', null, () => view.selectVault(v.folder), 'kr-btn-ghost kr-btn-sm'),
      el('button.kr-icon-btn', {
        attr: { type: 'button', 'aria-label': 'Убрать хранилище' },
        title: 'Убрать хранилище',
        on: { click: () => new RemoveVaultModal(view, v).open() },
      }, [icon('x')]),
    ]))),
    hiddenList(view),
  ]);
}

function hiddenList(view) {
  const hidden = view.core.settings.hiddenVaults || [];
  if (!hidden.length) return null;
  return el('div.kr-hidden-vaults', [
    el('div.kr-lock-others-title', 'Скрытые хранилища'),
    ...hidden.map((folder) => el('div.kr-vault-row', [
      icon('eye-off'),
      el('div.kr-grow', [el('b', folder.split('/').pop()), el('small.is-mono', folder)]),
      button('Вернуть', 'eye', () => view.manager.unhide(folder).then(() => view.render()), 'kr-btn-ghost kr-btn-sm'),
    ])),
  ]);
}

function renderSettingsPage(view, vault) {
  const page = el('div.kr-page.kr-settings');
  page.append(el('div.kr-page-head', [el('div', [el('h1', 'Настройки'), el('p.kr-muted', 'Хранилища, автоблокировка, буфер обмена и генератор.')])]));
  const cols = el('div.kr-settings-cols');
  const left = el('div.kr-settings-col');
  if (vault) left.append(vaultCard(view, vault));
  left.append(vaultsList(view));
  left.append(renderRecoveryPanel(view));
  left.append(renderHeaderPanel(view));
  const global = el('section.kr-panel.kr-global');
  buildGlobalSettings(global, view.core, null);
  cols.append(left, global);
  page.append(cols);
  return page;
}

module.exports = { renderSettingsPage };
