'use strict';
/*
 * Ограничение попыток ввода мастер-пароля: после N неверных попыток ввод
 * пароля для хранилища блокируется на M минут. Счётчик хранится локально
 * на устройстве (не синхронизируется). Вход ключом восстановления под
 * ограничение не попадает и сбрасывает счётчик.
 */

class LockoutError extends Error {
  constructor(remainingMs) {
    super('Слишком много неверных попыток — ввод пароля временно заблокирован');
    this.name = 'LockoutError';
    this.remainingMs = remainingMs;
  }
}

class Lockout {
  constructor(core) {
    this.core = core;
  }

  get attempts() {
    return Number(this.core.settings.lockoutAttempts) || 0; // 0 — выключено
  }

  get minutes() {
    return Number(this.core.settings.lockoutMinutes) || 5;
  }

  key(vault) {
    return `keyring-lockout:${vault.folder}`;
  }

  load(vault) {
    const app = this.core.app;
    try {
      const data = typeof app.loadLocalStorage === 'function'
        ? app.loadLocalStorage(this.key(vault))
        : JSON.parse(window.localStorage.getItem(this.key(vault)) || 'null');
      if (data && typeof data === 'object') return { fails: Number(data.fails) || 0, until: Number(data.until) || 0 };
    } catch (e) {
      /* ignore */
    }
    return { fails: 0, until: 0 };
  }

  save(vault, state) {
    const app = this.core.app;
    try {
      if (typeof app.saveLocalStorage === 'function') app.saveLocalStorage(this.key(vault), state);
      else window.localStorage.setItem(this.key(vault), JSON.stringify(state));
    } catch (e) {
      /* ignore */
    }
  }

  status(vault) {
    if (!this.attempts) return { locked: false, left: Infinity };
    const s = this.load(vault);
    const now = Date.now();
    if (s.until > now) return { locked: true, until: s.until, remainingMs: s.until - now };
    if (s.until) {
      this.reset(vault); // срок истёк — начинаем заново
      return { locked: false, left: this.attempts };
    }
    return { locked: false, left: Math.max(0, this.attempts - s.fails) };
  }

  fail(vault) {
    if (!this.attempts) return { locked: false, left: Infinity };
    const now = Date.now();
    let s = this.load(vault);
    if (s.until && s.until <= now) s = { fails: 0, until: 0 };
    s.fails += 1;
    if (s.fails >= this.attempts) s = { fails: 0, until: now + this.minutes * 60000 };
    this.save(vault, s);
    return this.status(vault);
  }

  reset(vault) {
    this.save(vault, { fails: 0, until: 0 });
  }

  /** Выполнить проверку пароля с учётом ограничения. */
  async guard(vault, fn) {
    const st = this.status(vault);
    if (st.locked) throw new LockoutError(st.remainingMs);
    try {
      const result = await fn();
      this.reset(vault);
      return result;
    } catch (e) {
      if (e && e.name === 'WrongPasswordError') {
        const after = this.fail(vault);
        e.attemptsLeft = after.left;
        e.lockedUntil = after.locked ? after.until : 0;
      }
      throw e;
    }
  }
}

module.exports = { Lockout, LockoutError };
