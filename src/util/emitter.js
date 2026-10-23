'use strict';

class Emitter {
  constructor() {
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, data) {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(type, data);
      } catch (e) {
        console.error('Keyring: listener error', e);
      }
    }
  }
}

module.exports = { Emitter };
