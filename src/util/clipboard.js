'use strict';
/* Копирование секретов с автоочисткой буфера обмена. */
const { Notice } = require('obsidian');

class SecureClipboard {
  constructor(core) {
    this.core = core;
    this.timer = null;
    this.last = null;
  }

  async copy(text, label) {
    if (!text) {
      new Notice('Поле пустое — копировать нечего');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      new Notice('Не удалось скопировать в буфер обмена');
      return;
    }
    this.core.manager.touch();
    const sec = Number(this.core.settings.clipboardSeconds) || 0;
    new Notice(sec > 0 ? `Скопировано: ${label} · очистка через ${sec} с` : `Скопировано: ${label}`, 2500);
    window.clearTimeout(this.timer);
    this.last = text;
    if (sec > 0) this.timer = window.setTimeout(() => this.clear(), sec * 1000);
  }

  /** Очищает буфер, только если там всё ещё наш секрет. */
  async clear() {
    window.clearTimeout(this.timer);
    const last = this.last;
    this.last = null;
    if (!last) return;
    try {
      const current = await navigator.clipboard.readText();
      if (current !== last) return;
    } catch (e) {
      // чтение недоступно — очищаем на всякий случай
    }
    try {
      await navigator.clipboard.writeText('');
    } catch (e) {
      /* ignore */
    }
  }

  dispose() {
    this.clear();
  }
}

module.exports = { SecureClipboard };
