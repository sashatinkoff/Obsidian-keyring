'use strict';
/*
 * Импорт из 1Password: формат 1PUX (1Password 8 → Файл → Экспорт → 1PUX).
 * Берётся всё: логины, пароли, заметки, карты, учётные данные, документы,
 * дополнительные поля, теги, ссылки, 2FA, избранное и история старых паролей.
 */
const { listZip, readZipFile } = require('../util/unzip');
const { toBase64 } = require('../crypto/codec');

// категории 1Password → тип записи Keyring
const CATEGORY = {
  '001': ['login', 'Логин'],
  '002': ['note', 'Банковская карта'],
  '003': ['note', 'Защищённая заметка'],
  '004': ['note', 'Личные данные'],
  '005': ['login', 'Пароль'],
  '006': ['file', 'Документ'],
  100: ['secret', 'Лицензия ПО'],
  101: ['note', 'Банковский счёт'],
  102: ['secret', 'База данных'],
  103: ['note', 'Водительские права'],
  104: ['note', 'Лицензия'],
  105: ['note', 'Членство'],
  106: ['note', 'Паспорт'],
  107: ['note', 'Программа лояльности'],
  108: ['note', 'Соцномер'],
  109: ['secret', 'Wi-Fi роутер'],
  110: ['secret', 'Сервер'],
  111: ['login', 'Почта'],
  112: ['secret', 'API'],
  113: ['note', 'Медкарта'],
  114: ['secret', 'SSH-ключ'],
  115: ['secret', 'Криптокошелёк'],
};

const MAX_FILE = 25 * 1024 * 1024;

/** Значение поля 1PUX → { text, hidden, totp, file }. */
function fieldValue(v) {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v !== 'object') return { text: String(v) };
  if ('concealed' in v) return { text: String(v.concealed || ''), hidden: true };
  if ('totp' in v) return { text: String(v.totp || ''), totp: true };
  if ('creditCardNumber' in v) return { text: String(v.creditCardNumber || ''), hidden: true };
  if ('file' in v) return { text: '', file: v.file };
  if ('date' in v) return { text: v.date ? new Date(Number(v.date) * 1000).toISOString().slice(0, 10) : '' };
  if ('monthYear' in v) {
    const s = String(v.monthYear || '');
    return { text: s.length === 6 ? `${s.slice(4)}/${s.slice(0, 4)}` : s };
  }
  if ('address' in v && v.address) {
    const a = v.address;
    return { text: [a.street, a.city, a.state, a.zip, a.country].filter(Boolean).join(', ') };
  }
  if ('sshKey' in v && v.sshKey) return { text: String(v.sshKey.privateKey || ''), hidden: true };
  // string, email, url, phone, menu, gender, creditCardType, reference …
  const first = Object.values(v)[0];
  if (first && typeof first === 'object') return { text: first.email_address || first.address || JSON.stringify(first) };
  return { text: first === null || first === undefined ? '' : String(first) };
}

const PIN_TITLE = /^(pin|пин|пин-код|pin-код|pin code)$/i;
const PASS_TITLE = /^(password|пароль|wireless password|пароль сети|server password|пароль базы)$/i;
const USER_TITLE = /^(username|user|логин|имя пользователя|account|аккаунт|cardholder name|владелец)$/i;

/** Один элемент 1PUX → черновик записи Keyring (+ отдельные записи для вложений). */
function convertItem(item, vaultName, attachments) {
  const ov = item.overview || {};
  const d = item.details || {};
  const [type0, catLabel] = CATEGORY[item.categoryUuid] || ['note', null];
  let type = type0;
  const e = {
    type,
    title: ov.title || 'Без названия',
    username: '',
    password: '',
    url: ov.url || (ov.urls && ov.urls[0] && ov.urls[0].url) || '',
    totp: '',
    notes: d.notesPlain || '',
    tags: (ov.tags || []).map((t) => String(t).replace(/^#/, '')).filter(Boolean),
    category: vaultName,
    fields: [],
    favorite: Number(item.favIndex) > 0,
    created: item.createdAt ? item.createdAt * 1000 : 0,
    updated: item.updatedAt ? item.updatedAt * 1000 : 0,
    history: [],
  };
  if (catLabel && !['001', '005', '003'].includes(item.categoryUuid)) e.tags.push(`1password/${catLabel.toLowerCase().replace(/\s+/g, '-')}`);
  if (item.state === 'archived') e.tags.push('архив');

  for (const f of d.loginFields || []) {
    if (f.designation === 'username' && !e.username) e.username = String(f.value || '');
    else if (f.designation === 'password' && !e.password) e.password = String(f.value || '');
  }
  if (d.password && !e.password) e.password = String(d.password);

  const extra = [];
  for (const sec of d.sections || []) {
    for (const f of sec.fields || []) {
      const val = fieldValue(f.value);
      const label = [sec.title, f.title].filter(Boolean).join(' · ') || f.id || 'Поле';
      if (val.file) {
        extra.push(val.file);
        continue;
      }
      if (!val.text) continue;
      if (val.totp && !e.totp) {
        e.totp = val.text;
        continue;
      }
      const passLike = PASS_TITLE.test(f.title || '') || /pass|credential|пароль/i.test(`${f.id} ${f.title}`);
      if (!e.password && val.hidden && type0 !== 'note' && passLike) {
        e.password = val.text;
        continue;
      }
      if (!e.username && !val.hidden && type0 !== 'note' && (USER_TITLE.test(f.title || '') || /^(username|network_name|user)$/.test(f.id || ''))) {
        e.username = val.text;
        continue;
      }
      e.fields.push({ label, value: val.text, hidden: !!val.hidden });
    }
  }
  // дополнительные ссылки
  (ov.urls || []).slice(1).forEach((u, i) => {
    if (u && u.url && u.url !== e.url) e.fields.push({ label: u.label || `Ссылка ${i + 2}`, value: u.url, hidden: false });
  });
  // история старых паролей
  e.history = (d.passwordHistory || [])
    .filter((h) => h && h.value)
    .map((h) => ({ password: String(h.value), changed: h.time ? h.time * 1000 : 0 }))
    .sort((a, b) => b.changed - a.changed);

  // одна только карта с PIN — отдельная запись типа «PIN-код»
  const out = [];
  if (item.categoryUuid === '002') {
    const pin = e.fields.find((f) => PIN_TITLE.test(f.label.split(' · ').pop()));
    if (pin) {
      out.push({
        type: 'pin', title: `${e.title} — PIN`, username: e.title, password: pin.value.replace(/\D/g, ''),
        category: vaultName, tags: e.tags.slice(), created: e.created, updated: e.updated,
      });
    }
  }
  if (type === 'login' && !e.username && !e.password) type = 'note';
  if (type === 'secret' && !e.password && !e.username) type = 'note';
  e.type = type;

  // документ и вложения
  const docAttr = d.documentAttributes;
  if (item.categoryUuid === '006' && docAttr) {
    const att = attachments(docAttr.documentId, docAttr.fileName);
    if (att) e.file = att;
    else {
      e.type = 'note';
      e.notes = `${e.notes}\n\n(Файл «${docAttr.fileName}» не найден в архиве или больше 25 МБ)`.trim();
    }
  }
  out.unshift(e);
  for (const f of extra) {
    const att = attachments(f.documentId, f.fileName);
    if (att) {
      out.push({
        type: 'file', title: `${e.title} — ${f.fileName}`, category: vaultName, tags: e.tags.slice(),
        file: att, notes: `Вложение записи «${e.title}» из 1Password`, created: e.created, updated: e.updated,
      });
    }
  }
  return out;
}

/** Разобрать .1pux (ArrayBuffer). Возвращает { format, entries, skipped }. */
async function from1pux(buffer) {
  const zip = listZip(buffer);
  const dataEntry = zip.files.find((f) => f.name === 'export.data' || f.name.endsWith('/export.data'));
  if (!dataEntry) throw new Error('В архиве нет export.data — это не экспорт 1Password (1PUX)');
  const data = JSON.parse(new TextDecoder().decode(await readZipFile(zip, dataEntry)));
  const byDoc = new Map();
  for (const f of zip.files) {
    const m = f.name.match(/(?:^|\/)files\/([^/]+?)___(.+)$/);
    if (m) byDoc.set(m[1], f);
  }
  // вложения читаем заранее, чтобы convertItem оставался синхронным
  const cache = new Map();
  for (const acc of data.accounts || []) {
    for (const v of acc.vaults || []) {
      for (const it of v.items || []) {
        const docs = [];
        const d = it.details || {};
        if (d.documentAttributes) docs.push(d.documentAttributes.documentId);
        for (const s of d.sections || []) for (const f of s.fields || []) if (f.value && f.value.file) docs.push(f.value.file.documentId);
        for (const id of docs) {
          const zf = byDoc.get(id);
          if (zf && !cache.has(id) && zf.size <= MAX_FILE) cache.set(id, await readZipFile(zip, zf));
        }
      }
    }
  }
  const attachments = (id, name) => {
    const bytes = cache.get(id);
    if (!bytes) return null;
    return { name: name || 'файл', mime: '', size: bytes.length, data: toBase64(bytes) };
  };
  const entries = [];
  let skipped = 0;
  const vaultCount = (data.accounts || []).reduce((n, a) => n + (a.vaults || []).length, 0);
  for (const acc of data.accounts || []) {
    for (const v of acc.vaults || []) {
      const vaultName = vaultCount > 1 ? String((v.attrs && v.attrs.name) || 'Vault').replace(/[\\/:*?"<>|]/g, '_') : '';
      for (const it of v.items || []) {
        if (it.state === 'trashed' || it.trashed) {
          skipped++;
          continue;
        }
        entries.push(...convertItem(it, vaultName, attachments));
      }
    }
  }
  return { format: '1Password (1PUX)', entries, skipped };
}

module.exports = { from1pux, convertItem };
