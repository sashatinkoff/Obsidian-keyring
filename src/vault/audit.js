'use strict';
/* Аудит хранилища: слабые, повторяющиеся, старые пароли, 2FA, конфликты. */
const { analyzePassword } = require('../crypto/strength');
const { parseTotp } = require('../crypto/totp');

const YEAR = 365 * 86400000;

function auditVault(vault) {
  const entries = Array.from(vault.entries.values());
  const withPassword = entries.filter((e) => (e.type === 'login' || e.type === 'secret') && e.password);
  const weak = [];
  const old = [];
  const noTotp = [];
  const byPassword = new Map();
  let bitsSum = 0;
  let totpCount = 0;

  for (const e of entries) {
    if (e.totp && parseTotp(e.totp)) totpCount++;
  }
  for (const e of withPassword) {
    const s = analyzePassword(e.password);
    bitsSum += Math.min(s.bits, 256);
    if (s.score < 60) weak.push(e);
    if (Date.now() - (e.passwordChanged || e.created) > YEAR) old.push(e);
    if (e.type === 'login' && !e.totp) noTotp.push(e);
    const list = byPassword.get(e.password) || [];
    list.push(e);
    byPassword.set(e.password, list);
  }
  const reused = Array.from(byPassword.values()).filter((l) => l.length > 1);
  const reusedCount = reused.reduce((n, l) => n + l.length, 0);
  const vulnerable = new Set([...weak, ...reused.flat()]);

  const total = withPassword.length || 1;
  const penalty = (weak.length * 1 + reusedCount * 0.8 + old.length * 0.3) / total;
  const health = withPassword.length ? Math.max(0, Math.round(100 - penalty * 100)) : 100;

  return {
    total: entries.length,
    withPassword: withPassword.length,
    weak,
    old,
    noTotp,
    reused,
    reusedCount,
    vulnerable: vulnerable.size,
    avgBits: withPassword.length ? Math.round((bitsSum / withPassword.length) * 10) / 10 : 0,
    totpCount,
    health,
    conflicts: vault.conflicts,
    errors: vault.errors,
  };
}

module.exports = { auditVault };
