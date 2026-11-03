'use strict';
/* Отдать файл пользователю: скачивание (десктоп) или сохранение в хранилище Obsidian. */

function download(name, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Сохранить текстовый файл в папку хранилища Obsidian; возвращает путь. */
async function saveToVault(app, folder, name, text, freePath) {
  const adapter = app.vault.adapter;
  if (folder && !(await adapter.exists(folder))) await app.vault.createFolder(folder);
  const path = await freePath(app, folder ? `${folder}/${name}` : name);
  await app.vault.create(path, text);
  return path;
}

module.exports = { download, saveToVault };
