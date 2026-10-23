'use strict';
/* Автодополнение папок хранилища Obsidian для текстовых полей. */
const obsidian = require('obsidian');

function attachFolderSuggest(app, input) {
  const Base = obsidian.AbstractInputSuggest;
  if (!Base) return null;

  class FolderSuggest extends Base {
    getSuggestions(query) {
      const q = query.toLowerCase();
      return app.vault.getAllLoadedFiles()
        .filter((f) => f.children !== undefined && f.path !== '/' && !f.path.startsWith('.'))
        .filter((f) => f.path.toLowerCase().includes(q))
        .sort((a, b) => a.path.localeCompare(b.path, 'ru'))
        .slice(0, 50);
    }

    renderSuggestion(folder, elx) {
      elx.textContent = folder.path;
    }

    selectSuggestion(folder) {
      input.value = folder.path;
      input.dispatchEvent(new Event('input'));
      this.close();
    }
  }

  try {
    return new FolderSuggest(app, input);
  } catch (e) {
    return null;
  }
}

module.exports = { attachFolderSuggest };
