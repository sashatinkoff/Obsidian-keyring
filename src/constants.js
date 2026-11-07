'use strict';

const VIEW_TYPE = 'keyring-view';
const HEADER_FILE = 'keyring.vault.json';
const ENTRY_EXT = 'kr';
const FORMAT = 'obsidian-keyring';
const FORMAT_VERSION = 1;
const APP_VERSION = '1.8.0';

// Границы числа итераций PBKDF2 в заголовке: защита от подменённого
// заголовка с абсурдными значениями (слишком слабо или «повесить» устройство).
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 5000000;
const DEFAULT_ITERATIONS = 600000; // рекомендация OWASP 2023+ для PBKDF2-SHA256

const CIPHER_LABEL = 'AES-256-GCM';
const KDF_LABEL = 'PBKDF2-SHA256';

const DEFAULT_GENERATOR = {
  length: 24,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  noSimilar: false,
};

const DEFAULT_SETTINGS = {
  vaults: [],
  lastVault: null,
  autoLockMinutes: 5,
  lockOnHide: true,
  lockOnClose: false,
  clipboardSeconds: 30,
  historyLimit: 10,
  favicons: false,
  iterations: DEFAULT_ITERATIONS,
  group: 'alpha',
  layout: 'cards',
  uiLayout: 'auto', // auto | full | compact — вид интерфейса
  theme: 'auto', // auto (как в Obsidian) | light | dark
  design: 'keyring', // keyring (фирменный) | m3 (Material 3)
  mobileTopInset: 'auto',
  mobileBottomInset: 'auto',
  lockoutAttempts: 3,
  lockoutMinutes: 5,
  headerBackups: {}, // копии заголовков хранилищ (без секретов)
  hiddenVaults: [], // папки-хранилища, убранные из Keyring (файлы на месте)
  recovery: null, // { id, publicJwk, created } — только открытый ключ
  generator: Object.assign({}, DEFAULT_GENERATOR),
  pinGenerator: { length: 4, avoidWeak: true },
};

// типы записей с секретом в поле password (пароль, ключ, PIN)
const SECRET_TYPES = ['login', 'secret', 'pin'];

const ENTRY_TYPES = {
  login: { label: 'Логин', secretLabel: 'Пароль', icon: 'key-round', userLabel: 'Логин' },
  secret: { label: 'Секрет / API', secretLabel: 'Секрет', icon: 'key-square', userLabel: 'Ключ ID' },
  pin: { label: 'PIN-код', secretLabel: 'PIN', icon: 'rectangle-ellipsis', userLabel: 'Карта / устройство' },
  note: { label: 'Заметка', secretLabel: null, icon: 'sticky-note' },
  file: { label: 'Файл', secretLabel: null, icon: 'paperclip' },
};

// Максимальный размер файла, который шифруется как вложение (МБ)
const MAX_FILE_MB = 25;

const GROUPS = {
  alpha: { label: 'По имени', icon: 'arrow-down-a-z' },
  folder: { label: 'По папкам', icon: 'folder' },
  recent: { label: 'Недавние', icon: 'clock' },
};

const TABS = {
  vault: { label: 'Хранилище', icon: 'key-round' },
  generator: { label: 'Генератор', icon: 'dices' },
  analysis: { label: 'Анализ', icon: 'shield-check' },
  settings: { label: 'Настройки', icon: 'sliders-horizontal' },
};

module.exports = {
  VIEW_TYPE,
  HEADER_FILE,
  ENTRY_EXT,
  FORMAT,
  FORMAT_VERSION,
  APP_VERSION,
  MIN_ITERATIONS,
  MAX_ITERATIONS,
  DEFAULT_ITERATIONS,
  CIPHER_LABEL,
  KDF_LABEL,
  DEFAULT_GENERATOR,
  DEFAULT_SETTINGS,
  ENTRY_TYPES,
  SECRET_TYPES,
  MAX_FILE_MB,
  GROUPS,
  TABS,
};
