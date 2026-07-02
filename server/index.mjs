import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir, stat, statfs, unlink } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { deflateRawSync, gzipSync, inflateRawSync } from "node:zlib";
import {
  projectRoot as rootDir,
  dataRootDir,
  dataDir,
  galleryDir,
  backupsDir as backupDir,
  documentUploadsDir,
  musicUploadsDir,
  dbPath,
  persistentEnvPath,
  requiredStorageDirs,
  legacyDbCandidates
} from "./storage-paths.mjs";

const publicDir = path.join(rootDir, "public");
const drsLoginMarker = path.join(dataDir, ".login-drs-20260614");
const documentKeyPath = path.join(dataDir, ".documents-key");
const passwordKeyPath = path.join(dataDir, ".passwords-key");
const steamApiKeyPath = path.join(dataDir, ".steam-api-key");
const openAiSettingsPath = path.join(dataDir, ".openai-settings");
const runtimeProcess = globalThis.process;
const localEnvPath = persistentEnvPath;
const localEnv = {};
try {
  const envText = await readFile(localEnvPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    localEnv[key.trim()] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
  }
} catch {
  // Arquivo .env e opcional; variaveis do sistema continuam funcionando.
}
const galleryRootDir = galleryDir;
const port = Number(runtimeProcess?.env?.PORT || 3333);
const sessions = new Map();
const databaseTokens = new Map();
const passwordVaultTokens = new Map();
const galleryAlbumTokens = new Map();
const twofaVaultTokens = new Map();
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SESSION_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const APP_TIME_ZONE = "America/Sao_Paulo";
const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const formatMoneyBR = (value) => roundMoney(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

await Promise.all(requiredStorageDirs.map((directory) => mkdir(directory, { recursive: true })));
const pendingLegacyDb = !existsSync(dbPath) && legacyDbCandidates.find((candidate) => existsSync(candidate));
if (pendingLegacyDb) {
  throw new Error(`Banco legado encontrado em ${pendingLegacyDb}. Execute scripts\\migrate-storage.mjs antes de iniciar para evitar abrir um banco vazio.`);
}
if (!existsSync(documentKeyPath)) await writeFile(documentKeyPath, randomBytes(32).toString("hex"));
if (!existsSync(passwordKeyPath)) await writeFile(passwordKeyPath, randomBytes(32).toString("hex"));
const documentEncryptionKey = Buffer.from((await readFile(documentKeyPath, "utf8")).trim(), "hex");
const passwordEncryptionKey = Buffer.from((await readFile(passwordKeyPath, "utf8")).trim(), "hex");
let encryptedSteamApiKey = "";
try {
  encryptedSteamApiKey = (await readFile(steamApiKeyPath, "utf8")).trim();
} catch {
  encryptedSteamApiKey = "";
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA temp_store = MEMORY");
db.exec("PRAGMA cache_size = -20000");

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT 'Usuario DRSO',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  slogan TEXT NOT NULL DEFAULT 'Uma Vida. Um Sistema.',
  city TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  date_format TEXT NOT NULL DEFAULT 'pt-BR',
  accent_color TEXT NOT NULL DEFAULT '#2563EB',
  theme TEXT NOT NULL DEFAULT 'dark',
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS financial_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  destination_account_id INTEGER,
  pocket_id INTEGER,
  type TEXT NOT NULL CHECK(type IN ('entrada','saida','transferencia')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  payment_method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  bank TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'conta corrente',
  color TEXT NOT NULL DEFAULT '#2dd4bf',
  initial_balance REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS finance_account_pockets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'caixinha' CHECK(kind IN ('caixinha','investimento','cripto')),
  initial_balance REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#2dd4bf',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS finance_account_pocket_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pocket_id INTEGER NOT NULL REFERENCES finance_account_pockets(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES financial_transactions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('entrada','saida')),
  amount REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS finance_catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('type','category','payment_method')),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2dd4bf',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS finance_catalog_deleted_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('type','category','payment_method')),
  name TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS credit_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bank TEXT,
  brand TEXT,
  last_four TEXT,
  total_limit REAL NOT NULL DEFAULT 0,
  closing_day INTEGER NOT NULL DEFAULT 1,
  due_day INTEGER NOT NULL DEFAULT 10,
  color TEXT NOT NULL DEFAULT '#2dd4bf',
  status TEXT NOT NULL DEFAULT 'Ativo',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS credit_card_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2dd4bf',
  icon TEXT NOT NULL DEFAULT '',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS credit_card_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '00:00',
  description TEXT NOT NULL,
  category TEXT,
  total_value REAL NOT NULL DEFAULT 0,
  installments_count INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS credit_card_installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expense_id INTEGER NOT NULL REFERENCES credit_card_expenses(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL,
  installment_total INTEGER NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  billing_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(expense_id, installment_number)
);
CREATE TABLE IF NOT EXISTS credit_card_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  billing_month TEXT NOT NULL,
  total_value REAL NOT NULL DEFAULT 0,
  paid_value REAL NOT NULL DEFAULT 0,
  remaining_value REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Aberta',
  due_date TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(card_id, billing_month)
);
CREATE TABLE IF NOT EXISTS credit_card_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES credit_card_invoices(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  payment_type TEXT NOT NULL DEFAULT 'Parcial',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agenda_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  source_id TEXT,
  calendar_id TEXT,
  calendar_name TEXT,
  calendar_color TEXT,
  html_link TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, source_id)
);
CREATE TABLE IF NOT EXISTS google_calendar_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL DEFAULT '',
  encrypted_client_secret TEXT NOT NULL DEFAULT '',
  encrypted_refresh_token TEXT NOT NULL DEFAULT '',
  calendar_id TEXT NOT NULL DEFAULT 'all',
  connected_email TEXT,
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS betting_houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  initial_balance REAL NOT NULL DEFAULT 0,
  monthly_goal REAL NOT NULL DEFAULT 0,
  monthly_loss_limit REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Ativa',
  notes TEXT,
  strategy_notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  betting_house TEXT NOT NULL,
  sport TEXT NOT NULL,
  external_bet_id TEXT,
  competition TEXT,
  event TEXT,
  market TEXT NOT NULL,
  entry TEXT NOT NULL,
  odd REAL NOT NULL DEFAULT 0,
  stake REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT NOT NULL CHECK(result IN ('green','red','void','cashout')),
  return_amount REAL NOT NULL DEFAULT 0,
  profit_loss REAL NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  roi REAL NOT NULL DEFAULT 0,
  cashout_value REAL NOT NULL DEFAULT 0,
  cashout_available INTEGER NOT NULL DEFAULT 0,
  cashout_unavailable_reason TEXT,
  cashout_at TEXT,
  month TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS betting_bonuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  betting_house TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  converted_value REAL NOT NULL DEFAULT 0,
  used_in_bet TEXT NOT NULL DEFAULT 'Nao',
  bet_reference TEXT,
  month TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS betting_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('Deposito','Saque','Ajuste')),
  betting_house TEXT NOT NULL,
  method TEXT,
  amount REAL NOT NULL DEFAULT 0,
  month TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS delivery_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '99',
  trips INTEGER NOT NULL DEFAULT 0,
  earned_amount REAL NOT NULL DEFAULT 0,
  kilometers REAL NOT NULL DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  hours_worked REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS delivery_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '99',
  amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS delivery_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'Geral',
  daily_goal REAL NOT NULL DEFAULT 0,
  weekly_goal REAL NOT NULL DEFAULT 0,
  monthly_goal REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, month, platform)
);
CREATE TABLE IF NOT EXISTS planning_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  person TEXT NOT NULL CHECK(person IN ('Dauan','Geovana')),
  title TEXT NOT NULL,
  category TEXT,
  due_date TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','partial','canceled')),
  paid_amount REAL NOT NULL DEFAULT 0,
  paid_date TEXT,
  notes TEXT,
  recurring INTEGER NOT NULL DEFAULT 0,
  recurrence_type TEXT,
  installment_current INTEGER NOT NULL DEFAULT 1,
  installment_total INTEGER NOT NULL DEFAULT 1,
  total_value REAL NOT NULL DEFAULT 0,
  split_details TEXT,
  parent_item_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS planning_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2dd4bf',
  icon TEXT NOT NULL DEFAULT '',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS planning_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color_identification TEXT NOT NULL DEFAULT '#2dd4bf',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS planning_partial_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  planning_item_id INTEGER NOT NULL REFERENCES planning_items(id) ON DELETE CASCADE,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  due_date TEXT,
  notes TEXT,
  file_path TEXT,
  original_name TEXT,
  mime_type TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  source_modified_at TEXT,
  uploaded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  start_date TEXT,
  deadline TEXT,
  priority TEXT NOT NULL DEFAULT 'media',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('anotacao','ideia')),
  content TEXT,
  tags TEXT,
  created_date TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'Usuario DRSO',
  category TEXT NOT NULL DEFAULT 'Anotacoes',
  priority TEXT NOT NULL DEFAULT 'Media',
  status TEXT NOT NULL DEFAULT 'Ativa',
  favorite INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  reminder_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS note_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_vault_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT,
  uri TEXT,
  folder TEXT,
  notes TEXT,
  tags TEXT,
  source TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  encrypted_password TEXT,
  encrypted_totp TEXT,
  raw_encrypted TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER,
  title TEXT NOT NULL,
  content TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS custom_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS custom_module_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES custom_modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  required INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS custom_module_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES custom_modules(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'OTHER',
  severity TEXT NOT NULL DEFAULT 'INFO',
  source_module TEXT NOT NULL DEFAULT '',
  source_entity_type TEXT NOT NULL DEFAULT '',
  source_entity_id TEXT NOT NULL DEFAULT '',
  action_url TEXT NOT NULL DEFAULT '',
  primary_action_label TEXT NOT NULL DEFAULT '',
  secondary_action_label TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  snoozed_until TEXT,
  dedupe_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  in_app_enabled INTEGER NOT NULL DEFAULT 1,
  browser_enabled INTEGER NOT NULL DEFAULT 0,
  sound_enabled INTEGER NOT NULL DEFAULT 0,
  minimum_severity TEXT NOT NULL DEFAULT 'INFO',
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '07:00',
  critical_ignore_quiet_hours INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, category)
);
CREATE TABLE IF NOT EXISTS steam_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  nickname TEXT NOT NULL,
  steam_id TEXT NOT NULL UNIQUE,
  profile_url TEXT,
  avatar_url TEXT,
  persona_name TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'Nunca sincronizada',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS twofa_vault_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  master_password_hash TEXT NOT NULL,
  encryption_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS twofa_totp_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',
  service_name TEXT NOT NULL,
  account_label TEXT,
  issuer TEXT,
  encrypted_secret TEXT NOT NULL,
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  notes TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS steam_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_account_id INTEGER NOT NULL REFERENCES steam_accounts(id) ON DELETE CASCADE,
  appid INTEGER NOT NULL,
  name TEXT NOT NULL,
  img_icon_url TEXT,
  img_logo_url TEXT,
  playtime_forever INTEGER NOT NULL DEFAULT 0,
  playtime_2weeks INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(steam_account_id, appid)
);
CREATE TABLE IF NOT EXISTS steam_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_account_id INTEGER NOT NULL REFERENCES steam_accounts(id) ON DELETE CASCADE,
  appid INTEGER NOT NULL,
  achievement_name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  icon_url TEXT,
  unlocked INTEGER NOT NULL DEFAULT 0,
  unlock_time TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(steam_account_id, appid, achievement_name)
);
CREATE TABLE IF NOT EXISTS steam_friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_account_id INTEGER NOT NULL REFERENCES steam_accounts(id) ON DELETE CASCADE,
  friend_steam_id TEXT NOT NULL,
  persona_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  person_state INTEGER,
  game_extra_info TEXT,
  last_logoff_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(steam_account_id, friend_steam_id)
);
CREATE TABLE IF NOT EXISTS steam_inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_account_id INTEGER NOT NULL REFERENCES steam_accounts(id) ON DELETE CASCADE,
  appid INTEGER NOT NULL,
  asset_id TEXT,
  class_id TEXT,
  instance_id TEXT,
  item_name TEXT,
  market_hash_name TEXT,
  item_type TEXT,
  image_url TEXT,
  rarity TEXT,
  inspect_url TEXT,
  float_value REAL,
  tradable INTEGER NOT NULL DEFAULT 0,
  marketable INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  estimated_price REAL NOT NULL DEFAULT 0,
  steam_price_text TEXT,
  steam_price_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(steam_account_id, appid, asset_id)
);
CREATE TABLE IF NOT EXISTS steam_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_account_id INTEGER REFERENCES steam_accounts(id) ON DELETE SET NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS csgo_skins_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  nickname TEXT NOT NULL,
  notes TEXT,
  encrypted_token TEXT NOT NULL DEFAULT '',
  token_hint TEXT,
  user_agent TEXT,
  accept_language TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  manual_inventory_enabled INTEGER NOT NULL DEFAULT 0,
  manual_inventory_value_brl REAL NOT NULL DEFAULT 0,
  connection_status TEXT NOT NULL DEFAULT 'precisa reconectar',
  last_sync_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'Nunca sincronizada',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS csgo_skins_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES csgo_skins_accounts(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  value_brl REAL NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  balance_brl REAL NOT NULL DEFAULT 0,
  wallet_type TEXT,
  action TEXT,
  direction TEXT NOT NULL DEFAULT 'neutro',
  created_at_remote TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS csgo_skins_inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES csgo_skins_accounts(id) ON DELETE CASCADE,
  remote_item_id TEXT NOT NULL,
  item_id TEXT,
  origin TEXT,
  source_type TEXT,
  source_id TEXT,
  name TEXT,
  status TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  value INTEGER NOT NULL DEFAULT 0,
  sale_value_brl REAL NOT NULL DEFAULT 0,
  image TEXT,
  color TEXT,
  roll_id TEXT,
  created_at_remote TEXT,
  updated_at_remote TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, remote_item_id)
);
CREATE TABLE IF NOT EXISTS csgo_skins_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  remote_case_id TEXT NOT NULL UNIQUE,
  category_name TEXT,
  slug TEXT,
  name TEXT,
  image TEXT,
  modes TEXT,
  original_price INTEGER NOT NULL DEFAULT 0,
  original_price_brl REAL NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  price_brl REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS csgo_skins_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES csgo_skins_accounts(id) ON DELETE SET NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS motorcycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL DEFAULT 'Moto',
  name TEXT NOT NULL DEFAULT 'Minha moto',
  brand TEXT,
  model TEXT,
  year TEXT,
  plate TEXT,
  color TEXT,
  initial_mileage REAL NOT NULL DEFAULT 0,
  purchase_date TEXT,
  purchase_value REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_fuel_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  station TEXT,
  fuel_type TEXT,
  total_value REAL NOT NULL DEFAULT 0,
  liters REAL NOT NULL DEFAULT 0,
  price_per_liter REAL NOT NULL DEFAULT 0,
  mileage REAL NOT NULL DEFAULT 0,
  payment_method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_oil_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  mileage REAL NOT NULL DEFAULT 0,
  oil_type TEXT,
  oil_value REAL NOT NULL DEFAULT 0,
  labor_value REAL NOT NULL DEFAULT 0,
  place TEXT,
  next_mileage REAL NOT NULL DEFAULT 0,
  next_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  category TEXT,
  service_type TEXT,
  item TEXT,
  workshop TEXT,
  parts_value REAL NOT NULL DEFAULT 0,
  labor_value REAL NOT NULL DEFAULT 0,
  mileage REAL NOT NULL DEFAULT 0,
  warranty_until TEXT,
  next_mileage REAL NOT NULL DEFAULT 0,
  next_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_tire_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  tire_position TEXT,
  brand_model TEXT,
  value REAL NOT NULL DEFAULT 0,
  mileage REAL NOT NULL DEFAULT 0,
  next_mileage REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_date TEXT,
  installments TEXT,
  attachment_name TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_mileage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  mileage REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS motorcycle_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  category TEXT,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  payment_method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  capa TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS playlist_musicas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  artista TEXT,
  youtube_url TEXT NOT NULL,
  youtube_video_id TEXT NOT NULL,
  thumbnail_url TEXT,
  source_type TEXT NOT NULL DEFAULT 'youtube',
  audio_url TEXT,
  audio_file_name TEXT,
  audio_mime_type TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vendinha_establishments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vendinha_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  default_value REAL NOT NULL DEFAULT 0,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vendinha_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  establishment_id INTEGER REFERENCES vendinha_establishments(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES vendinha_products(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_value REAL NOT NULL DEFAULT 0,
  total_value REAL NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  payment_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vendinha_month_closings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  establishment_id INTEGER REFERENCES vendinha_establishments(id) ON DELETE SET NULL,
  total_consumed REAL NOT NULL DEFAULT 0,
  total_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid',
  payment_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, month, establishment_id)
);
CREATE TABLE IF NOT EXISTS vendinha_month_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  establishment_id INTEGER REFERENCES vendinha_establishments(id) ON DELETE SET NULL,
  limit_value REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, month, establishment_id)
);
CREATE TABLE IF NOT EXISTS recurring_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT,
  category TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Ativa',
  worth_it TEXT NOT NULL DEFAULT 'Em analise',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  payment_method TEXT,
  card_name TEXT,
  card_last_four TEXT,
  payer TEXT,
  shared INTEGER NOT NULL DEFAULT 0,
  total_value REAL NOT NULL DEFAULT 0,
  my_share REAL NOT NULL DEFAULT 0,
  shared_people TEXT,
  frequency TEXT NOT NULL DEFAULT 'mensal',
  first_payment_date TEXT,
  next_charge_date TEXT,
  fixed_charge_day INTEGER,
  auto_generate INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  canceled_at TEXT,
  cancel_reason TEXT,
  last_paid_value REAL NOT NULL DEFAULT 0,
  finance_integration_ready INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES recurring_subscriptions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  payment_date TEXT NOT NULL,
  due_date TEXT,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'Pago',
  notes TEXT,
  finance_payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscription_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES recurring_subscriptions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  adjustment_date TEXT NOT NULL,
  old_value REAL NOT NULL DEFAULT 0,
  new_value REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscription_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES recurring_subscriptions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS codex_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'Free',
  reset_type TEXT NOT NULL DEFAULT 'Manual',
  last_used_at TEXT,
  next_available_at TEXT,
  weekly_reset_at TEXT,
  phone_linked INTEGER NOT NULL DEFAULT 0,
  phone_notes TEXT,
  notes TEXT,
  tags TEXT,
  manual_status TEXT,
  plan_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, email)
);
CREATE TABLE IF NOT EXISTS google_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  nome_conta TEXT,
  email TEXT NOT NULL,
  senha_criptografada TEXT NOT NULL,
  data_criacao TEXT,
  status TEXT NOT NULL DEFAULT 'Ativa',
  uso_principal TEXT NOT NULL DEFAULT 'Outros',
  email_recuperacao TEXT,
  telefone_recuperacao TEXT,
  dois_fatores_ativo INTEGER NOT NULL DEFAULT 0,
  tipo_dois_fatores TEXT,
  ultima_troca_senha TEXT,
  ultima_revisao TEXT,
  codigos_backup_criptografados TEXT,
  observacoes_recuperacao TEXT,
  observacoes TEXT,
  servicos_usados TEXT,
  senha_repetida INTEGER NOT NULL DEFAULT 0,
  nivel_risco TEXT NOT NULL DEFAULT 'Medio',
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  arquivado INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, email)
);
CREATE TABLE IF NOT EXISTS instagram_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  usuario TEXT NOT NULL,
  link_perfil TEXT,
  email_login TEXT,
  senha_criptografada TEXT NOT NULL DEFAULT '',
  telefone TEXT,
  email_recuperacao TEXT,
  codigo_2fa TEXT,
  tipo_conta TEXT NOT NULL DEFAULT 'Pessoal',
  status TEXT NOT NULL DEFAULT 'Ativa',
  dois_fatores_ativo INTEGER NOT NULL DEFAULT 0,
  seguidores INTEGER NOT NULL DEFAULT 0,
  seguindo INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  data_criacao_conta TEXT,
  ultimo_acesso TEXT,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, usuario)
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Nova conversa',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  sources TEXT,
  actions TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'preferencia',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  executed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  source_module TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dismissed_at TEXT
);
CREATE TABLE IF NOT EXISTS bi_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  module_title TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  music_id TEXT,
  music_title TEXT,
  music_artist TEXT,
  music_playing INTEGER NOT NULL DEFAULT 0,
  activity_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gallery_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  descricao TEXT,
  capa_media_id INTEGER,
  password_hash TEXT,
  data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gallery_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  nome_original TEXT NOT NULL,
  nome_armazenado TEXT NOT NULL,
  tipo_arquivo TEXT NOT NULL,
  extensao TEXT NOT NULL,
  tamanho_original INTEGER NOT NULL DEFAULT 0,
  tamanho_final INTEGER NOT NULL DEFAULT 0,
  caminho_arquivo TEXT NOT NULL,
  caminho_thumbnail TEXT,
  data_upload TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data_original TEXT,
  album_id INTEGER REFERENCES gallery_albums(id) ON DELETE SET NULL,
  categoria TEXT,
  tags TEXT,
  descricao TEXT,
  favorito INTEGER NOT NULL DEFAULT 0,
  manter_original INTEGER NOT NULL DEFAULT 1,
  compressed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wishlist_pastas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  descricao TEXT,
  icone TEXT,
  cor TEXT,
  pasta_pai_id INTEGER REFERENCES wishlist_pastas(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS produtos_wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  pasta_id INTEGER REFERENCES wishlist_pastas(id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  link_original TEXT,
  imagem_url TEXT,
  preco_atual REAL NOT NULL DEFAULT 0,
  preco_desejado REAL NOT NULL DEFAULT 0,
  loja TEXT,
  categoria TEXT,
  prioridade TEXT NOT NULL DEFAULT 'Media',
  status TEXT NOT NULL DEFAULT 'Quero comprar',
  observacoes TEXT,
  comprado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultima_atualizacao_preco TEXT
);
CREATE TABLE IF NOT EXISTS historico_precos_wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos_wishlist(id) ON DELETE CASCADE,
  preco_antigo REAL NOT NULL DEFAULT 0,
  preco_novo REAL NOT NULL DEFAULT 0,
  loja TEXT,
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;
db.exec(schema);
for (const statement of [
  "ALTER TABLE users ADD COLUMN username TEXT",
  "ALTER TABLE users ADD COLUMN password_hash TEXT",
  "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN slogan TEXT NOT NULL DEFAULT 'Uma Vida. Um Sistema.'",
  "ALTER TABLE users ADD COLUMN city TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN birth_date TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN date_format TEXT NOT NULL DEFAULT 'pt-BR'",
  "ALTER TABLE users ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#2563EB'",
  "ALTER TABLE financial_transactions ADD COLUMN account_id INTEGER",
  "ALTER TABLE financial_transactions ADD COLUMN destination_account_id INTEGER",
  "ALTER TABLE financial_transactions ADD COLUMN pocket_id INTEGER",
  "ALTER TABLE finance_account_pocket_movements ADD COLUMN transaction_id INTEGER",
  "CREATE TABLE IF NOT EXISTS finance_catalog_deleted_items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('type','category','payment_method')), name TEXT NOT NULL, deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(kind, name))",
  "CREATE TABLE IF NOT EXISTS delivery_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '99', trips INTEGER NOT NULL DEFAULT 0, earned_amount REAL NOT NULL DEFAULT 0, kilometers REAL NOT NULL DEFAULT 0, start_time TEXT, end_time TEXT, hours_worked REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS delivery_withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '99', amount REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS delivery_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'Geral', daily_goal REAL NOT NULL DEFAULT 0, weekly_goal REAL NOT NULL DEFAULT 0, monthly_goal REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, month, platform))",
  "ALTER TABLE betting_houses ADD COLUMN initial_balance REAL NOT NULL DEFAULT 0",
  "ALTER TABLE betting_houses ADD COLUMN monthly_goal REAL NOT NULL DEFAULT 0",
  "ALTER TABLE betting_houses ADD COLUMN monthly_loss_limit REAL NOT NULL DEFAULT 0",
  "ALTER TABLE betting_houses ADD COLUMN status TEXT NOT NULL DEFAULT 'Ativa'",
  "ALTER TABLE betting_houses ADD COLUMN notes TEXT",
  "ALTER TABLE betting_houses ADD COLUMN strategy_notes TEXT",
  "ALTER TABLE betting_houses ADD COLUMN updated_at TEXT",
  "ALTER TABLE bets ADD COLUMN competition TEXT",
  "ALTER TABLE bets ADD COLUMN event TEXT",
  "ALTER TABLE bets ADD COLUMN external_bet_id TEXT",
  "ALTER TABLE bets ADD COLUMN return_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN units REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN roi REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN month TEXT",
  "ALTER TABLE bets ADD COLUMN status TEXT NOT NULL DEFAULT 'settled'",
  "ALTER TABLE bets ADD COLUMN cashout_value REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN cashout_available INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN cashout_unavailable_reason TEXT",
  "ALTER TABLE bets ADD COLUMN cashout_at TEXT",
  "ALTER TABLE planning_items ADD COLUMN month TEXT",
  "ALTER TABLE planning_items ADD COLUMN person TEXT",
  "ALTER TABLE planning_items ADD COLUMN title TEXT",
  "ALTER TABLE planning_items ADD COLUMN category TEXT",
  "ALTER TABLE planning_items ADD COLUMN due_date TEXT",
  "ALTER TABLE planning_items ADD COLUMN amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE planning_items ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
  "ALTER TABLE planning_items ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE planning_items ADD COLUMN paid_date TEXT",
  "ALTER TABLE planning_items ADD COLUMN notes TEXT",
  "ALTER TABLE planning_items ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE planning_items ADD COLUMN recurrence_type TEXT",
  "ALTER TABLE planning_items ADD COLUMN installment_current INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE planning_items ADD COLUMN installment_total INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE planning_items ADD COLUMN total_value REAL NOT NULL DEFAULT 0",
  "ALTER TABLE planning_items ADD COLUMN split_details TEXT",
  "ALTER TABLE planning_items ADD COLUMN parent_item_id INTEGER",
  "ALTER TABLE planning_categories ADD COLUMN color TEXT NOT NULL DEFAULT '#2dd4bf'",
  "ALTER TABLE planning_categories ADD COLUMN icon TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE notes ADD COLUMN author TEXT NOT NULL DEFAULT 'Usuario DRSO'",
  "ALTER TABLE notes ADD COLUMN category TEXT NOT NULL DEFAULT 'Anotacoes'",
  "ALTER TABLE notes ADD COLUMN priority TEXT NOT NULL DEFAULT 'Media'",
  "ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'Ativa'",
  "ALTER TABLE notes ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE notes ADD COLUMN reminder_at TEXT",
  "ALTER TABLE timeline_events ADD COLUMN updated_at TEXT",
  "ALTER TABLE documents ADD COLUMN original_name TEXT",
  "ALTER TABLE documents ADD COLUMN mime_type TEXT",
  "ALTER TABLE documents ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE documents ADD COLUMN source_modified_at TEXT",
  "ALTER TABLE documents ADD COLUMN uploaded_at TEXT",
  "CREATE TABLE IF NOT EXISTS planning_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS planning_people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color_identification TEXT NOT NULL DEFAULT '#2dd4bf', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS planning_partial_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, planning_item_id INTEGER NOT NULL REFERENCES planning_items(id) ON DELETE CASCADE, amount_paid REAL NOT NULL DEFAULT 0, payment_date TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS note_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, name TEXT NOT NULL, mime_type TEXT, size INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "ALTER TABLE steam_accounts ADD COLUMN user_id INTEGER",
  "ALTER TABLE steam_accounts ADD COLUMN persona_name TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE steam_accounts ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'Nunca sincronizada'",
  "ALTER TABLE steam_accounts ADD COLUMN steam_login TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN encrypted_steam_password TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN email TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN encrypted_email_password TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN phone TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN account_created_at TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'Outro'",
  "ALTER TABLE steam_accounts ADD COLUMN account_status TEXT NOT NULL DEFAULT 'Ativa'",
  "ALTER TABLE steam_accounts ADD COLUMN steam_guard_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE steam_accounts ADD COLUMN encrypted_shared_secret TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN encrypted_backup_codes TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN inventory_estimated_value REAL NOT NULL DEFAULT 0",
  "ALTER TABLE steam_accounts ADD COLUMN last_login_at TEXT",
  "ALTER TABLE steam_accounts ADD COLUMN notes TEXT",
  "CREATE TABLE IF NOT EXISTS twofa_vault_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, master_password_hash TEXT NOT NULL, encryption_salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS twofa_totp_items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL DEFAULT 'google', service_name TEXT NOT NULL, account_label TEXT, issuer TEXT, encrypted_secret TEXT NOT NULL, digits INTEGER NOT NULL DEFAULT 6, period INTEGER NOT NULL DEFAULT 30, algorithm TEXT NOT NULL DEFAULT 'SHA1', notes TEXT, favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "ALTER TABLE steam_games ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE steam_inventory_items ADD COLUMN estimated_price REAL NOT NULL DEFAULT 0",
  "ALTER TABLE steam_inventory_items ADD COLUMN market_hash_name TEXT",
  "ALTER TABLE steam_inventory_items ADD COLUMN inspect_url TEXT",
  "ALTER TABLE steam_inventory_items ADD COLUMN float_value REAL",
  "ALTER TABLE steam_inventory_items ADD COLUMN steam_price_text TEXT",
  "ALTER TABLE steam_inventory_items ADD COLUMN steam_price_updated_at TEXT",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN user_id INTEGER",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN notes TEXT",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN encrypted_token TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN token_hint TEXT",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN user_agent TEXT",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN accept_language TEXT",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN manual_inventory_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN manual_inventory_value_brl REAL NOT NULL DEFAULT 0",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'precisa reconectar'",
  "ALTER TABLE csgo_skins_accounts ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'Nunca sincronizada'",
    "ALTER TABLE csgo_skins_transactions ADD COLUMN value_brl REAL NOT NULL DEFAULT 0",
    "ALTER TABLE csgo_skins_transactions ADD COLUMN balance_brl REAL NOT NULL DEFAULT 0",
    "ALTER TABLE csgo_skins_transactions ADD COLUMN direction TEXT NOT NULL DEFAULT 'neutro'",
    "ALTER TABLE csgo_skins_inventory_items ADD COLUMN sale_value_brl REAL NOT NULL DEFAULT 0",
    "ALTER TABLE motorcycles ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'Moto'"
  ,"ALTER TABLE agenda_events ADD COLUMN calendar_id TEXT"
  ,"ALTER TABLE agenda_events ADD COLUMN calendar_name TEXT"
  ,"ALTER TABLE agenda_events ADD COLUMN calendar_color TEXT"
  ,"CREATE TABLE IF NOT EXISTS motorcycles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, vehicle_type TEXT NOT NULL DEFAULT 'Moto', name TEXT NOT NULL DEFAULT 'Minha moto', brand TEXT, model TEXT, year TEXT, plate TEXT, color TEXT, initial_mileage REAL NOT NULL DEFAULT 0, purchase_date TEXT, purchase_value REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ,"CREATE TABLE IF NOT EXISTS motorcycle_fuel_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, date TEXT NOT NULL, station TEXT, fuel_type TEXT, total_value REAL NOT NULL DEFAULT 0, liters REAL NOT NULL DEFAULT 0, price_per_liter REAL NOT NULL DEFAULT 0, mileage REAL NOT NULL DEFAULT 0, payment_method TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ,"CREATE TABLE IF NOT EXISTS motorcycle_oil_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, date TEXT NOT NULL, mileage REAL NOT NULL DEFAULT 0, oil_type TEXT, oil_value REAL NOT NULL DEFAULT 0, labor_value REAL NOT NULL DEFAULT 0, place TEXT, next_mileage REAL NOT NULL DEFAULT 0, next_date TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ,"CREATE TABLE IF NOT EXISTS motorcycle_maintenance_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, date TEXT NOT NULL, category TEXT, service_type TEXT, item TEXT, workshop TEXT, parts_value REAL NOT NULL DEFAULT 0, labor_value REAL NOT NULL DEFAULT 0, mileage REAL NOT NULL DEFAULT 0, warranty_until TEXT, next_mileage REAL NOT NULL DEFAULT 0, next_date TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ,"CREATE TABLE IF NOT EXISTS motorcycle_tire_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, date TEXT NOT NULL, tire_position TEXT, brand_model TEXT, value REAL NOT NULL DEFAULT 0, mileage REAL NOT NULL DEFAULT 0, next_mileage REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ,"CREATE TABLE IF NOT EXISTS motorcycle_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, type TEXT NOT NULL, description TEXT, due_date TEXT, amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', paid_date TEXT, installments TEXT, attachment_name TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS motorcycle_mileage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, date TEXT NOT NULL, mileage REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual', notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS motorcycle_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL, date TEXT NOT NULL, category TEXT, description TEXT, amount REAL NOT NULL DEFAULT 0, payment_method TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_resume (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, full_name TEXT, professional_title TEXT, summary TEXT, phone TEXT, email TEXT, location TEXT, linkedin TEXT, github TEXT, portfolio TEXT, website TEXT, objective TEXT, visible_sections TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_courses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, institution TEXT, category TEXT, status TEXT NOT NULL DEFAULT 'em andamento', start_date TEXT, expected_end_date TEXT, end_date TEXT, hours REAL NOT NULL DEFAULT 0, certificate TEXT NOT NULL DEFAULT 'Nao', link TEXT, paid_value REAL NOT NULL DEFAULT 0, progress REAL NOT NULL DEFAULT 0, priority TEXT NOT NULL DEFAULT 'media', notes TEXT, modules TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_future_studies (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, reason TEXT, priority TEXT NOT NULL DEFAULT 'media', start_goal TEXT, finish_goal TEXT, estimated_cost REAL NOT NULL DEFAULT 0, link TEXT, status TEXT NOT NULL DEFAULT 'planejado', notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_experiences (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, company TEXT NOT NULL, role TEXT, type TEXT, start_date TEXT, end_date TEXT, current_job TEXT NOT NULL DEFAULT 'Nao', description TEXT, learnings TEXT, achievements TEXT, income REAL NOT NULL DEFAULT 0, leaving_reason TEXT, reference_contact TEXT, resume_visible INTEGER NOT NULL DEFAULT 1, highlight INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, category TEXT, current_level TEXT, desired_level TEXT, score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'aprendendo', last_practice TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT, category TEXT, priority TEXT NOT NULL DEFAULT 'media', start_date TEXT, due_date TEXT, status TEXT NOT NULL DEFAULT 'em andamento', progress REAL NOT NULL DEFAULT 0, importance_reason TEXT, reward TEXT, notes TEXT, tasks TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_life_checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'pendente', due_date TEXT, priority TEXT NOT NULL DEFAULT 'media', steps TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_achievements (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT, date TEXT, category TEXT, importance TEXT NOT NULL DEFAULT 'media', related_goal TEXT NOT NULL DEFAULT 'Nao', attachment_name TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT, category TEXT, status TEXT NOT NULL DEFAULT 'ideia', start_date TEXT, expected_end_date TEXT, progress REAL NOT NULL DEFAULT 0, tools TEXT, tasks TEXT, link TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_habits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, category TEXT, frequency TEXT NOT NULL DEFAULT 'diario', target TEXT, status TEXT NOT NULL DEFAULT 'ativo', done_days INTEGER NOT NULL DEFAULT 0, current_streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, last_done_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_course_modules (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, course_id INTEGER REFERENCES personal_courses(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pendente', sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_goal_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, goal_id INTEGER REFERENCES personal_goals(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pendente', due_date TEXT, sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_project_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, project_id INTEGER REFERENCES personal_projects(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pendente', due_date TEXT, sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS personal_habit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, habit_id INTEGER REFERENCES personal_habits(id) ON DELETE CASCADE, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'feito', notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, descricao TEXT, capa TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS playlist_musicas (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, titulo TEXT NOT NULL, artista TEXT, youtube_url TEXT NOT NULL, youtube_video_id TEXT NOT NULL, thumbnail_url TEXT, ordem INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"ALTER TABLE playlist_musicas ADD COLUMN source_type TEXT NOT NULL DEFAULT 'youtube'"
    ,"ALTER TABLE playlist_musicas ADD COLUMN audio_url TEXT"
    ,"ALTER TABLE playlist_musicas ADD COLUMN audio_file_name TEXT"
    ,"ALTER TABLE playlist_musicas ADD COLUMN audio_mime_type TEXT"
    ,"CREATE TABLE IF NOT EXISTS vendinha_establishments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, notes TEXT, status TEXT NOT NULL DEFAULT 'ativo', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS vendinha_products (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, default_value REAL NOT NULL DEFAULT 0, category TEXT, status TEXT NOT NULL DEFAULT 'ativo', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS vendinha_consumptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, establishment_id INTEGER REFERENCES vendinha_establishments(id) ON DELETE SET NULL, product_id INTEGER REFERENCES vendinha_products(id) ON DELETE SET NULL, date TEXT NOT NULL, product_name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, unit_value REAL NOT NULL DEFAULT 0, total_value REAL NOT NULL DEFAULT 0, notes TEXT, status TEXT NOT NULL DEFAULT 'open', payment_date TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS vendinha_month_closings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, establishment_id INTEGER REFERENCES vendinha_establishments(id) ON DELETE SET NULL, total_consumed REAL NOT NULL DEFAULT 0, total_paid REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'paid', payment_date TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, month, establishment_id))"
    ,"CREATE TABLE IF NOT EXISTS vendinha_month_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, establishment_id INTEGER REFERENCES vendinha_establishments(id) ON DELETE SET NULL, limit_value REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, month, establishment_id))"
    ,"CREATE TABLE IF NOT EXISTS recurring_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, provider TEXT, category TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'Ativa', worth_it TEXT NOT NULL DEFAULT 'Em analise', amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'BRL', payment_method TEXT, card_name TEXT, card_last_four TEXT, payer TEXT, shared INTEGER NOT NULL DEFAULT 0, total_value REAL NOT NULL DEFAULT 0, my_share REAL NOT NULL DEFAULT 0, shared_people TEXT, frequency TEXT NOT NULL DEFAULT 'mensal', first_payment_date TEXT, next_charge_date TEXT, fixed_charge_day INTEGER, auto_generate INTEGER NOT NULL DEFAULT 1, notes TEXT, canceled_at TEXT, cancel_reason TEXT, last_paid_value REAL NOT NULL DEFAULT 0, finance_integration_ready INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS subscription_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL REFERENCES recurring_subscriptions(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, payment_date TEXT NOT NULL, due_date TEXT, amount_paid REAL NOT NULL DEFAULT 0, payment_method TEXT, status TEXT NOT NULL DEFAULT 'Pago', notes TEXT, finance_payload TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS subscription_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL REFERENCES recurring_subscriptions(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, adjustment_date TEXT NOT NULL, old_value REAL NOT NULL DEFAULT 0, new_value REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS subscription_shares (id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL REFERENCES recurring_subscriptions(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, person_name TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS ai_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT 'Nova conversa', favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, sources TEXT, actions TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS ai_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'preferencia', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS ai_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, executed_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS ai_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, severity TEXT NOT NULL DEFAULT 'info', source_module TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, dismissed_at TEXT)"
    ,"CREATE TABLE IF NOT EXISTS life_objectives (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, short_description TEXT, reason TEXT, category TEXT NOT NULL DEFAULT 'Pessoal', priority TEXT NOT NULL DEFAULT 'Media', status TEXT NOT NULL DEFAULT 'not_started', target_date TEXT, created_date TEXT NOT NULL, completed_date TEXT, notes TEXT, current_action TEXT, useful_links TEXT, column_order REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS life_objective_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, objective_id INTEGER NOT NULL REFERENCES life_objectives(id) ON DELETE CASCADE, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, step_order REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS life_objective_history (id INTEGER PRIMARY KEY AUTOINCREMENT, objective_id INTEGER NOT NULL REFERENCES life_objectives(id) ON DELETE CASCADE, action TEXT NOT NULL, previous_status TEXT, new_status TEXT, description TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS bi_usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, module TEXT NOT NULL, module_title TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, music_id TEXT, music_title TEXT, music_artist TEXT, music_playing INTEGER NOT NULL DEFAULT 0, activity_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS gallery_albums (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, nome TEXT NOT NULL, descricao TEXT, capa_media_id INTEGER, password_hash TEXT, data_criacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"ALTER TABLE gallery_albums ADD COLUMN password_hash TEXT"
    ,"CREATE TABLE IF NOT EXISTS gallery_media (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, nome_original TEXT NOT NULL, nome_armazenado TEXT NOT NULL, tipo_arquivo TEXT NOT NULL, extensao TEXT NOT NULL, tamanho_original INTEGER NOT NULL DEFAULT 0, tamanho_final INTEGER NOT NULL DEFAULT 0, caminho_arquivo TEXT NOT NULL, caminho_thumbnail TEXT, data_upload TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, data_original TEXT, album_id INTEGER REFERENCES gallery_albums(id) ON DELETE SET NULL, categoria TEXT, tags TEXT, descricao TEXT, favorito INTEGER NOT NULL DEFAULT 0, manter_original INTEGER NOT NULL DEFAULT 1, compressed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS google_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, nome_conta TEXT, email TEXT NOT NULL, senha_criptografada TEXT NOT NULL, data_criacao TEXT, status TEXT NOT NULL DEFAULT 'Ativa', uso_principal TEXT NOT NULL DEFAULT 'Outros', email_recuperacao TEXT, telefone_recuperacao TEXT, dois_fatores_ativo INTEGER NOT NULL DEFAULT 0, tipo_dois_fatores TEXT, ultima_troca_senha TEXT, ultima_revisao TEXT, codigos_backup_criptografados TEXT, observacoes_recuperacao TEXT, observacoes TEXT, servicos_usados TEXT, senha_repetida INTEGER NOT NULL DEFAULT 0, nivel_risco TEXT NOT NULL DEFAULT 'Medio', criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, arquivado INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, email))"
    ,"ALTER TABLE google_accounts ADD COLUMN observacoes_recuperacao TEXT"
    ,"ALTER TABLE google_accounts ADD COLUMN senha_repetida INTEGER NOT NULL DEFAULT 0"
    ,"CREATE TABLE IF NOT EXISTS instagram_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, nome TEXT NOT NULL, usuario TEXT NOT NULL, link_perfil TEXT, email_login TEXT, senha_criptografada TEXT NOT NULL DEFAULT '', telefone TEXT, email_recuperacao TEXT, codigo_2fa TEXT, tipo_conta TEXT NOT NULL DEFAULT 'Pessoal', status TEXT NOT NULL DEFAULT 'Ativa', dois_fatores_ativo INTEGER NOT NULL DEFAULT 0, seguidores INTEGER NOT NULL DEFAULT 0, seguindo INTEGER NOT NULL DEFAULT 0, avatar TEXT, data_criacao_conta TEXT, ultimo_acesso TEXT, observacoes TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, usuario))"
    ,"ALTER TABLE instagram_accounts ADD COLUMN seguidores INTEGER NOT NULL DEFAULT 0"
    ,"ALTER TABLE instagram_accounts ADD COLUMN seguindo INTEGER NOT NULL DEFAULT 0"
    ,"CREATE TABLE IF NOT EXISTS wishlist_pastas (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, nome TEXT NOT NULL, descricao TEXT, icone TEXT, cor TEXT, pasta_pai_id INTEGER REFERENCES wishlist_pastas(id) ON DELETE SET NULL, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ,"CREATE TABLE IF NOT EXISTS produtos_wishlist (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, pasta_id INTEGER REFERENCES wishlist_pastas(id) ON DELETE SET NULL, nome TEXT NOT NULL, link_original TEXT, imagem_url TEXT, preco_atual REAL NOT NULL DEFAULT 0, preco_desejado REAL NOT NULL DEFAULT 0, loja TEXT, categoria TEXT, prioridade TEXT NOT NULL DEFAULT 'Media', status TEXT NOT NULL DEFAULT 'Quero comprar', observacoes TEXT, comprado INTEGER NOT NULL DEFAULT 0, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ultima_atualizacao_preco TEXT)"
    ,"CREATE TABLE IF NOT EXISTS historico_precos_wishlist (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, produto_id INTEGER REFERENCES produtos_wishlist(id) ON DELETE CASCADE, preco_antigo REAL NOT NULL DEFAULT 0, preco_novo REAL NOT NULL DEFAULT 0, loja TEXT, criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ]) {
  try {
    db.exec(statement);
  } catch (error) {
    if (!String(error.message).includes("duplicate column")) throw error;
  }
}

function ensureFinancialTransactionsTransferConstraint() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_transactions'").get();
  if (!table?.sql || table.sql.includes("'transferencia'")) return;
  const columns = db.prepare("PRAGMA table_info(financial_transactions)").all().map((column) => column.name);
  const wantedColumns = [
    "id",
    "account_id",
    "destination_account_id",
    "pocket_id",
    "type",
    "category",
    "description",
    "amount",
    "date",
    "payment_method",
    "notes",
    "created_at",
    "updated_at"
  ];
  const copyColumns = wantedColumns.filter((column) => columns.includes(column));
  const selectColumns = copyColumns.join(", ");
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    CREATE TABLE financial_transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      destination_account_id INTEGER,
      pocket_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('entrada','saida','transferencia')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      payment_method TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO financial_transactions_new (${selectColumns})
    SELECT ${selectColumns}
    FROM financial_transactions;
    DROP TABLE financial_transactions;
    ALTER TABLE financial_transactions_new RENAME TO financial_transactions;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

ensureFinancialTransactionsTransferConstraint();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
for (const statement of [
  "CREATE INDEX IF NOT EXISTS idx_financial_transactions_date ON financial_transactions(date)",
  "CREATE INDEX IF NOT EXISTS idx_financial_transactions_type_date ON financial_transactions(type, date)",
  "CREATE INDEX IF NOT EXISTS idx_planning_items_due_status ON planning_items(due_date, status)",
  "CREATE INDEX IF NOT EXISTS idx_agenda_events_user_start ON agenda_events(user_id, start_at)",
  "CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at)",
  "CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_bets_month_date ON bets(month, date)",
  "CREATE INDEX IF NOT EXISTS idx_codex_accounts_user_next ON codex_accounts(user_id, next_available_at)",
  "CREATE INDEX IF NOT EXISTS idx_projects_deadline_status ON projects(deadline, status)",
  "CREATE INDEX IF NOT EXISTS idx_personal_goals_user_due ON personal_goals(user_id, due_date)",
  "CREATE INDEX IF NOT EXISTS idx_personal_habits_user_updated ON personal_habits(user_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_recurring_subscriptions_user_next ON recurring_subscriptions(user_id, next_charge_date)",
  "CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription_date ON subscription_payments(subscription_id, payment_date)",
  "CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_updated ON ai_conversations(user_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created ON ai_messages(conversation_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_ai_memories_user_updated ON ai_memories(user_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_life_objectives_user_status_order ON life_objectives(user_id, status, column_order)",
  "CREATE INDEX IF NOT EXISTS idx_life_steps_objective_order ON life_objective_steps(objective_id, step_order)",
  "CREATE INDEX IF NOT EXISTS idx_life_history_objective_created ON life_objective_history(objective_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_bi_usage_logs_user_date ON bi_usage_logs(user_id, activity_date, module)",
  "CREATE INDEX IF NOT EXISTS idx_gallery_media_user_type_date ON gallery_media(user_id, tipo_arquivo, data_upload)",
  "CREATE INDEX IF NOT EXISTS idx_gallery_media_user_album ON gallery_media(user_id, album_id)",
  "CREATE INDEX IF NOT EXISTS idx_gallery_media_user_favorite ON gallery_media(user_id, favorito)",
  "CREATE INDEX IF NOT EXISTS idx_google_accounts_user_status ON google_accounts(user_id, status, arquivado)",
  "CREATE INDEX IF NOT EXISTS idx_google_accounts_user_email ON google_accounts(user_id, email)",
  "CREATE INDEX IF NOT EXISTS idx_instagram_accounts_user_status ON instagram_accounts(user_id, status, dois_fatores_ativo)",
  "CREATE INDEX IF NOT EXISTS idx_instagram_accounts_user_usuario ON instagram_accounts(user_id, usuario)",
  "CREATE INDEX IF NOT EXISTS idx_wishlist_pastas_user_parent ON wishlist_pastas(user_id, pasta_pai_id)",
  "CREATE INDEX IF NOT EXISTS idx_produtos_wishlist_user_folder ON produtos_wishlist(user_id, pasta_id)",
  "CREATE INDEX IF NOT EXISTS idx_produtos_wishlist_user_status ON produtos_wishlist(user_id, status, comprado)",
  "CREATE INDEX IF NOT EXISTS idx_historico_precos_wishlist_product ON historico_precos_wishlist(produto_id, criado_em)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created ON notifications(user_id, is_read, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_user_archived_created ON notifications(user_id, is_archived, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_user_category ON notifications(user_id, category)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_user_severity ON notifications(user_id, severity)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_user_snoozed ON notifications(user_id, snoozed_until)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key <> ''",
  "CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_category ON notification_preferences(user_id, category)"
]) {
  try {
    db.exec(statement);
  } catch {
    // Bases antigas podem nao ter alguma tabela/coluna; os demais indices seguem.
  }
}
try {
  db.exec("PRAGMA optimize");
} catch {}
db.exec("INSERT INTO users (id, username, name, theme) SELECT 1, 'admin', 'Usuario DRSO', 'dark' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 1)");
db.exec("UPDATE users SET username = 'admin' WHERE id = 1 AND (username IS NULL OR username = '')");
db.exec("UPDATE bets SET status = 'settled' WHERE status IS NULL OR status = ''");
db.exec("UPDATE planning_items SET status = 'pending' WHERE status IS NULL OR status = ''");
db.exec("UPDATE timeline_events SET updated_at = COALESCE(updated_at, created_at, date) WHERE updated_at IS NULL OR updated_at = ''");
db.exec("UPDATE notes SET created_at = datetime(created_at, '-3 hours') WHERE datetime(created_at) > datetime('now', 'localtime', '+30 minutes')");
db.exec("UPDATE notes SET updated_at = datetime(updated_at, '-3 hours') WHERE updated_at IS NOT NULL AND datetime(updated_at) > datetime('now', 'localtime', '+30 minutes')");
db.exec("UPDATE notes SET created_at = datetime(created_at, '-3 hours') WHERE strftime('%H', created_at) IN ('22','23')");
db.exec("UPDATE notes SET updated_at = datetime(updated_at, '-3 hours') WHERE updated_at IS NOT NULL AND strftime('%H', updated_at) IN ('22','23')");
db.exec("UPDATE documents SET uploaded_at = COALESCE(uploaded_at, created_at), original_name = COALESCE(original_name, name) WHERE uploaded_at IS NULL OR uploaded_at = '' OR original_name IS NULL OR original_name = ''");
db.exec("UPDATE documents SET created_at = datetime(created_at, '-3 hours') WHERE uploaded_at IS NOT NULL AND datetime(created_at) > datetime(uploaded_at, '+2 hours')");
db.exec("UPDATE documents SET created_at = datetime(created_at, '-3 hours') WHERE datetime(created_at) > datetime('now', 'localtime', '+30 minutes')");
db.exec("UPDATE documents SET uploaded_at = datetime(uploaded_at, '-3 hours') WHERE uploaded_at IS NOT NULL AND datetime(uploaded_at) > datetime('now', 'localtime', '+30 minutes')");
db.exec("UPDATE documents SET updated_at = datetime(updated_at, '-3 hours') WHERE updated_at IS NOT NULL AND datetime(updated_at) > datetime('now', 'localtime', '+30 minutes')");
db.exec("UPDATE documents SET source_modified_at = datetime(source_modified_at, '-3 hours') WHERE source_modified_at IS NOT NULL AND datetime(source_modified_at) > datetime('now', 'localtime', '+30 minutes')");

if (!existsSync(drsLoginMarker)) {
  run("UPDATE users SET username = ?, name = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1", [
    "drs",
    "Dauan",
    "scrypt:e0991fbc1a1d84f5037bb50bbb325466:2b7f566ba357e31ac67e33ca907a89165da28b40f01f4b5761ee6ae55d7538fbbb73f0dc0a8f81d2b8caf045c8d25311ca8821a18a26c0d078053b9573b19a57"
  ]);
  await writeFile(drsLoginMarker, "drs\n", "utf8");
}

const tables = {
  finance: "financial_transactions",
  bets: "bets",
  planning: "planning_items",
  documents: "documents",
  projects: "projects",
  notes: "notes",
  timeline: "timeline_events"
};

const databaseTables = [
  "users",
  "financial_transactions",
  "bank_accounts",
  "finance_catalog_items",
  "credit_cards",
  "credit_card_categories",
  "credit_card_expenses",
  "credit_card_installments",
  "credit_card_invoices",
  "credit_card_payments",
  "agenda_events",
  "google_calendar_settings",
  "betting_houses",
  "bets",
  "betting_bonuses",
  "betting_movements",
  "delivery_entries",
  "delivery_withdrawals",
  "delivery_goals",
  "planning_items",
  "planning_categories",
  "planning_people",
  "planning_partial_payments",
  "documents",
  "notes",
  "note_attachments",
  "password_vault_items",
  "life_objectives",
  "life_objective_steps",
  "life_objective_history",
  "timeline_events",
  "projects",
  "ideas",
  "custom_modules",
  "custom_module_fields",
  "custom_module_records",
  "backups",
  "steam_accounts",
  "steam_games",
  "steam_achievements",
  "steam_friends",
  "steam_inventory_items",
  "steam_sync_logs",
  "csgo_skins_accounts",
  "csgo_skins_transactions",
  "csgo_skins_inventory_items",
  "csgo_skins_cases",
  "csgo_skins_sync_logs",
  "motorcycles",
  "motorcycle_fuel_logs",
  "motorcycle_oil_changes",
  "motorcycle_maintenance_logs",
    "motorcycle_tire_logs",
    "motorcycle_documents",
    "motorcycle_mileage_logs",
    "motorcycle_expenses",
    "personal_resume",
    "personal_courses",
    "personal_course_modules",
    "personal_future_studies",
    "personal_experiences",
    "personal_skills",
    "personal_goals",
    "personal_goal_tasks",
    "personal_life_checklist",
    "personal_achievements",
    "personal_projects",
    "personal_project_tasks",
    "personal_habits",
    "personal_habit_logs",
    "instagram_accounts",
    "playlists",
    "playlist_musicas",
    "vendinha_establishments",
    "vendinha_products",
    "vendinha_consumptions",
    "vendinha_month_closings",
    "vendinha_month_limits",
    "recurring_subscriptions",
    "subscription_payments",
    "subscription_adjustments",
    "subscription_shares"
  ];

const fields = {
  finance: ["account_id", "destination_account_id", "pocket_id", "type", "category", "description", "amount", "date", "payment_method", "notes"],
  bets: ["date", "external_bet_id", "betting_house", "sport", "competition", "event", "market", "entry", "odd", "stake", "status", "result", "return_amount", "profit_loss", "units", "roi", "cashout_value", "cashout_available", "cashout_unavailable_reason", "cashout_at", "month", "notes"],
  planning: ["month", "person", "title", "category", "due_date", "amount", "status", "paid_amount", "paid_date", "notes", "recurring", "recurrence_type", "installment_current", "installment_total", "total_value", "split_details", "parent_item_id"],
  documents: ["name", "category", "notes", "file_path", "original_name", "mime_type", "file_size", "source_modified_at", "uploaded_at"],
  projects: ["name", "status", "description", "start_date", "deadline", "priority", "notes"],
  notes: ["title", "type", "content", "tags", "created_date", "author", "category", "priority", "status", "favorite", "pinned", "reminder_at"],
  timeline: ["date", "title", "description", "category"]
};

const bettingHouseFields = ["name", "initial_balance", "monthly_goal", "monthly_loss_limit", "status", "notes", "strategy_notes"];
const bettingBonusFields = ["date", "betting_house", "type", "description", "converted_value", "used_in_bet", "bet_reference", "month", "notes"];
const bettingMovementFields = ["date", "type", "betting_house", "method", "amount", "month", "notes"];
const deliveryEntryFields = ["user_id", "date", "platform", "trips", "earned_amount", "kilometers", "start_time", "end_time", "hours_worked", "notes"];
const deliveryWithdrawalFields = ["user_id", "date", "platform", "amount", "notes"];
const deliveryGoalFields = ["user_id", "month", "platform", "daily_goal", "weekly_goal", "monthly_goal", "notes"];
const wishlistFolderFields = ["user_id", "nome", "descricao", "icone", "cor", "pasta_pai_id"];
const wishlistProductFields = ["user_id", "pasta_id", "nome", "link_original", "imagem_url", "preco_atual", "preco_desejado", "loja", "categoria", "prioridade", "status", "observacoes", "comprado", "ultima_atualizacao_preco"];
const planningFields = ["month", "person", "title", "category", "due_date", "amount", "status", "paid_amount", "paid_date", "notes", "recurring", "recurrence_type", "installment_current", "installment_total", "total_value", "split_details", "parent_item_id"];
const planningCategoryFields = ["name", "color", "icon", "notes"];
const creditCardFields = ["user_id", "name", "bank", "brand", "last_four", "total_limit", "closing_day", "due_day", "color", "status", "notes"];
const creditCardExpenseFields = ["user_id", "card_id", "date", "time", "description", "category", "total_value", "installments_count", "notes"];
const creditCardCategoryFields = ["user_id", "name", "color", "icon", "notes"];
const steamAccountFields = ["user_id", "nickname", "steam_id", "profile_url", "avatar_url", "persona_name", "is_primary", "is_active", "last_sync_at", "sync_status"];
const csgoSkinsAccountFields = ["user_id", "nickname", "notes", "encrypted_token", "token_hint", "user_agent", "accept_language", "is_active", "manual_inventory_enabled", "manual_inventory_value_brl", "connection_status", "last_sync_at", "sync_status"];
const steamInventoryGames = [
  { appid: 730, name: "CS2", contextId: 2 },
  { appid: 570, name: "Dota 2", contextId: 2 },
  { appid: 440, name: "Team Fortress 2", contextId: 2 },
  { appid: 252490, name: "Rust", contextId: 2 }
];
const defaultBettingHouses = ["Betano", "Superbet", "Bet365", "Sportingbet", "Betnacional", "Stake", "Novibet", "Betfair", "Pixbet", "Outras"];
const defaultSports = ["Futebol", "Basquete", "Tenis", "Volei", "MMA", "E-Sports", "Outro"];
const defaultBonusTypes = ["Freebet", "Cashback", "Bonus de deposito", "Missao", "Indicacao", "Rodadas gratis", "Credito promocional", "Ajuste da casa", "Outro"];
const defaultCreditCardCategories = ["Alimentacao", "Mercado", "Combustivel", "Farmacia", "Saude", "Lazer", "Compras", "Assinaturas", "Transporte", "Educacao", "Outros"];
const defaultUnitValue = 100;

const orderBy = {
  finance: "date DESC, id DESC",
  bets: "date DESC, id DESC",
  documents: "COALESCE(due_date, created_at) DESC, id DESC",
  projects: "COALESCE(deadline, created_at) DESC, id DESC",
  notes: "datetime(notes.created_at) DESC, notes.id DESC",
  timeline: "datetime(date) DESC, id DESC"
};

function all(sql, values = []) {
  return db.prepare(sql).all(...values);
}

function get(sql, values = []) {
  return db.prepare(sql).get(...values);
}

function run(sql, values = []) {
  return db.prepare(sql).run(...values);
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function steamApiKey() {
  return String(runtimeProcess?.env?.STEAM_API_KEY || localEnv.STEAM_API_KEY || decryptSteamApiKey(encryptedSteamApiKey) || "").trim();
}

function decryptSteamApiKey(value) {
  const text = String(value || "");
  if (!text.startsWith("DRSOSTEAM1:")) return "";
  try {
    const buffer = Buffer.from(text.replace("DRSOSTEAM1:", ""), "base64");
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", passwordEncryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function steamProfileUrl(steamId) {
  return `https://steamcommunity.com/profiles/${steamId}`;
}

function steamInventoryProfilePath(account) {
  const profileUrl = String(account.profile_url || "");
  const match = profileUrl.match(/steamcommunity\.com\/(id|profiles)\/([^/?#]+)/i);
  if (match?.[1] && match?.[2]) return `${match[1]}/${match[2]}`;
  return `profiles/${account.steam_id}`;
}

function minutesToHours(minutes) {
  return roundMoney(Number(minutes || 0) / 60);
}

function unixToSqlDateTime(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function steamImageUrl(hash, appid = null) {
  if (!hash) return "";
  return appid
    ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`
    : `https://community.cloudflare.steamstatic.com/economy/image/${hash}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function steamFetch(url, context = "Steam", options = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "DRSOSystem/1.0",
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      ...(options.headers || {})
    }
  });
  if (response.status === 403) {
    const error = new Error(`${context}: dados privados ou acesso negado pela Steam.`);
    error.code = "STEAM_PRIVATE";
    throw error;
  }
  if (response.status === 401) {
    const error = new Error(`${context}: nao autorizado pela Steam. Verifique privacidade do inventario e se este jogo tem inventario publico.`);
    error.code = "STEAM_UNAUTHORIZED";
    throw error;
  }
  if (response.status === 429) {
    const error = new Error(`${context}: limite de requisicoes da Steam atingido. Tente novamente mais tarde.`);
    error.code = "STEAM_RATE_LIMIT";
    throw error;
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${context}: Steam respondeu ${response.status}. ${text.slice(0, 160)}`);
  if (!text || text === "null") throw new Error(`${context}: Steam retornou resposta vazia.`);
  return JSON.parse(text);
}

function steamCommunityHeaders(account, extra = {}) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Referer": `${steamProfileUrl(account.steam_id)}/inventory/`,
    ...extra
  };
}

function normalizeSteamInventoryPayload(data) {
  if (Array.isArray(data?.assets)) {
    return {
      assets: data.assets,
      descriptions: data.descriptions || [],
      more: Boolean(data.more_items),
      lastAssetId: data.last_assetid || "",
      totalInventoryCount: Number(data.total_inventory_count || data.assets.length || 0)
    };
  }
  if (data?.rgInventory && data?.rgDescriptions) {
    return {
      assets: Object.values(data.rgInventory || {}).map((asset) => ({
        assetid: asset.id || asset.assetid || "",
        classid: asset.classid || "",
        instanceid: asset.instanceid || "0",
        amount: asset.amount || 1
      })),
      descriptions: Object.values(data.rgDescriptions || {}),
      more: false,
      lastAssetId: "",
      totalInventoryCount: Object.keys(data.rgInventory || {}).length
    };
  }
  if (data?.success === false) throw new Error(data.Error || "Steam nao liberou este inventario.");
  return { assets: [], descriptions: [], more: false, lastAssetId: "", totalInventoryCount: 0 };
}

function parseSteamBRLPrice(value) {
  const text = String(value || "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(text);
  return Number.isFinite(number) ? roundMoney(number) : 0;
}

async function fetchSteamMarketPrice(appid, marketHashName, account) {
  if (!marketHashName) return { price: 0, text: "" };
  const url = `https://steamcommunity.com/market/priceoverview/?appid=${encodeURIComponent(appid)}&currency=7&market_hash_name=${encodeURIComponent(marketHashName)}`;
  const data = await steamFetch(url, `Preco Steam ${marketHashName}`, {
    headers: steamCommunityHeaders(account, { "Referer": `https://steamcommunity.com/market/listings/${appid}/${encodeURIComponent(marketHashName)}` })
  });
  if (!data?.success) return { price: 0, text: "" };
  const text = data.lowest_price || data.median_price || "";
  return { price: parseSteamBRLPrice(text), text };
}

function steamInspectUrl(description, asset) {
  const action = [...(description.actions || []), ...(description.market_actions || [])].find((item) => String(item.link || "").includes("csgo_econ_action_preview"));
  if (!action?.link) return "";
  return String(action.link)
    .replace(/%assetid%/g, asset.assetid || "")
    .replace(/%contextid%/g, asset.contextid || "2")
    .replace(/%owner_steamid%/g, asset.owner || "")
    .replace(/%listingid%/g, asset.assetid || "");
}

async function fetchSteamInventoryGame(account, game) {
  const headers = steamCommunityHeaders(account);
  const profilePath = steamInventoryProfilePath(account);
  const variants = [
    (startAssetId = "") => `https://steamcommunity.com/inventory/${encodeURIComponent(account.steam_id)}/${game.appid}/${game.contextId}?l=brazilian&count=500${startAssetId ? `&start_assetid=${encodeURIComponent(startAssetId)}` : ""}`,
    (startAssetId = "") => `https://steamcommunity.com/inventory/${encodeURIComponent(account.steam_id)}/${game.appid}/${game.contextId}?count=500${startAssetId ? `&start_assetid=${encodeURIComponent(startAssetId)}` : ""}`,
    () => `https://steamcommunity.com/${profilePath}/inventory/json/${game.appid}/${game.contextId}/?l=brazilian`,
    () => `https://steamcommunity.com/profiles/${encodeURIComponent(account.steam_id)}/inventory/json/${game.appid}/${game.contextId}/?l=brazilian`
  ];
  let lastError = null;
  for (const buildUrl of variants) {
    const pages = [];
    let startAssetId = "";
    let safety = 0;
    try {
      do {
        const data = await steamFetch(buildUrl(startAssetId), `${game.name} inventario`, { headers });
        const page = normalizeSteamInventoryPayload(data);
        pages.push(page);
        startAssetId = page.more ? page.lastAssetId : "";
        safety += 1;
        if (startAssetId) await sleep(1200);
      } while (startAssetId && safety < 10);
      return {
        assets: pages.flatMap((page) => page.assets),
        descriptions: pages.flatMap((page) => page.descriptions),
        totalInventoryCount: pages.at(-1)?.totalInventoryCount || pages.reduce((sum, page) => sum + page.assets.length, 0)
      };
    } catch (error) {
      lastError = error;
      if (error.code === "STEAM_RATE_LIMIT") await sleep(2500);
    }
  }
  throw lastError || new Error(`${game.name}: inventario indisponivel.`);
}

function steamAccountPayload(payload, userId) {
  const steamId = String(payload.steam_id || payload.steamId || "").replace(/\D/g, "");
  return {
    user_id: userId,
    nickname: String(payload.nickname || payload.persona_name || "Conta Steam").trim(),
    steam_id: steamId,
    profile_url: String(payload.profile_url || (steamId ? steamProfileUrl(steamId) : "")).trim(),
    avatar_url: String(payload.avatar_url || "").trim(),
    persona_name: String(payload.persona_name || "").trim(),
    is_primary: payload.is_primary ? 1 : 0,
    is_active: payload.is_active === undefined ? 1 : Number(Boolean(payload.is_active)),
    last_sync_at: payload.last_sync_at || "",
    sync_status: payload.sync_status || "Nunca sincronizada"
  };
}

function setPrimarySteamAccount(id, userId) {
  run("UPDATE steam_accounts SET is_primary = 0 WHERE user_id = ?", [userId]);
  run("UPDATE steam_accounts SET is_primary = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", [id, userId]);
}

function steamStats(userId) {
  const accountCount = get("SELECT COUNT(*) AS count FROM steam_accounts WHERE user_id = ? AND is_active = 1", [userId]).count;
  const gameStats = get(`SELECT COUNT(*) AS total_games, COALESCE(SUM(steam_games.playtime_forever), 0) AS total_minutes, SUM(CASE WHEN steam_games.playtime_forever = 0 THEN 1 ELSE 0 END) AS never_played, SUM(CASE WHEN steam_games.playtime_2weeks > 0 THEN 1 ELSE 0 END) AS recently_played FROM steam_games JOIN steam_accounts ON steam_accounts.id = steam_games.steam_account_id WHERE steam_accounts.user_id = ?`, [userId]);
  const topGame = get("SELECT steam_games.name, steam_games.playtime_forever FROM steam_games JOIN steam_accounts ON steam_accounts.id = steam_games.steam_account_id WHERE steam_accounts.user_id = ? ORDER BY steam_games.playtime_forever DESC LIMIT 1", [userId]) || {};
  const achievements = get("SELECT COUNT(*) AS total, SUM(CASE WHEN steam_achievements.unlocked = 1 THEN 1 ELSE 0 END) AS unlocked FROM steam_achievements JOIN steam_accounts ON steam_accounts.id = steam_achievements.steam_account_id WHERE steam_accounts.user_id = ?", [userId]);
  const inventory = get("SELECT COUNT(*) AS total_items, COALESCE(SUM(steam_inventory_items.quantity * steam_inventory_items.estimated_price), 0) AS estimated_value FROM steam_inventory_items JOIN steam_accounts ON steam_accounts.id = steam_inventory_items.steam_account_id WHERE steam_accounts.user_id = ?", [userId]);
  return {
    total_accounts: accountCount,
    total_games: Number(gameStats.total_games || 0),
    total_hours: minutesToHours(gameStats.total_minutes),
    top_game: topGame.name || "",
    top_game_hours: minutesToHours(topGame.playtime_forever),
    never_played: Number(gameStats.never_played || 0),
    recently_played: Number(gameStats.recently_played || 0),
    total_achievements: Number(achievements.total || 0),
    unlocked_achievements: Number(achievements.unlocked || 0),
    achievement_progress: achievements.total ? roundMoney((Number(achievements.unlocked || 0) / Number(achievements.total || 1)) * 100) : 0,
    inventory_items: Number(inventory.total_items || 0),
    inventory_value: roundMoney(inventory.estimated_value)
  };
}

function listSteamAccounts(userId) {
  return all(`
    SELECT steam_accounts.*,
      COUNT(steam_inventory_items.id) AS inventory_count,
      COALESCE(SUM(steam_inventory_items.quantity * steam_inventory_items.estimated_price), 0) AS inventory_value
    FROM steam_accounts
    LEFT JOIN steam_inventory_items ON steam_inventory_items.steam_account_id = steam_accounts.id
    WHERE steam_accounts.user_id = ?
    GROUP BY steam_accounts.id
    ORDER BY steam_accounts.is_primary DESC, steam_accounts.is_active DESC, steam_accounts.nickname
  `, [userId]);
}

function steamOverview(userId) {
  return {
    apiKeyConfigured: Boolean(steamApiKey()),
    stats: steamStats(userId),
    accounts: listSteamAccounts(userId),
    topGames: all("SELECT steam_games.*, steam_accounts.nickname AS account_nickname FROM steam_games JOIN steam_accounts ON steam_accounts.id = steam_games.steam_account_id WHERE steam_accounts.user_id = ? ORDER BY steam_games.playtime_forever DESC LIMIT 10", [userId]),
    recentGames: all("SELECT steam_games.*, steam_accounts.nickname AS account_nickname FROM steam_games JOIN steam_accounts ON steam_accounts.id = steam_games.steam_account_id WHERE steam_accounts.user_id = ? AND (steam_games.playtime_2weeks > 0 OR steam_games.last_played_at IS NOT NULL) ORDER BY COALESCE(steam_games.last_played_at, steam_games.updated_at) DESC LIMIT 12", [userId]),
    logs: all("SELECT steam_sync_logs.*, steam_accounts.nickname AS account_nickname FROM steam_sync_logs LEFT JOIN steam_accounts ON steam_accounts.id = steam_sync_logs.steam_account_id WHERE steam_accounts.user_id = ? OR steam_sync_logs.steam_account_id IS NULL ORDER BY steam_sync_logs.started_at DESC LIMIT 12", [userId])
  };
}

function createSteamSyncLog(accountId, syncType) {
  const result = run("INSERT INTO steam_sync_logs (steam_account_id, sync_type, status, message, started_at) VALUES (?, ?, 'rodando', ?, CURRENT_TIMESTAMP)", [accountId, syncType, "Sincronizacao iniciada"]);
  return Number(result.lastInsertRowid);
}

function finishSteamSyncLog(logId, status, message) {
  run("UPDATE steam_sync_logs SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [status, String(message || "").slice(0, 1000), logId]);
}

async function syncSteamProfile(account, key) {
  const data = await steamFetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(account.steam_id)}`, "Perfil Steam");
  const player = data.response?.players?.[0];
  if (!player) throw new Error("SteamID invalido ou perfil nao encontrado.");
  run("UPDATE steam_accounts SET persona_name = ?, avatar_url = ?, profile_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    player.personaname || account.persona_name || "",
    player.avatarfull || player.avatarmedium || account.avatar_url || "",
    player.profileurl || account.profile_url || steamProfileUrl(account.steam_id),
    account.id
  ]);
}

async function syncSteamGames(account, key) {
  const data = await steamFetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(account.steam_id)}&include_appinfo=true&include_played_free_games=true&format=json`, "Biblioteca Steam");
  const games = data.response?.games || [];
  for (const game of games) {
    run(`INSERT INTO steam_games (steam_account_id, appid, name, img_icon_url, img_logo_url, playtime_forever, playtime_2weeks, last_played_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(steam_account_id, appid) DO UPDATE SET
        name = excluded.name,
        img_icon_url = excluded.img_icon_url,
        img_logo_url = excluded.img_logo_url,
        playtime_forever = excluded.playtime_forever,
        playtime_2weeks = excluded.playtime_2weeks,
        last_played_at = excluded.last_played_at,
        updated_at = CURRENT_TIMESTAMP`, [
      account.id,
      Number(game.appid),
      game.name || `App ${game.appid}`,
      steamImageUrl(game.img_icon_url, game.appid),
      steamImageUrl(game.img_logo_url, game.appid),
      Number(game.playtime_forever || 0),
      Number(game.playtime_2weeks || 0),
      unixToSqlDateTime(game.rtime_last_played)
    ]);
  }
  return games.length;
}

async function syncSteamRecentGames(account, key) {
  try {
    const data = await steamFetch(`https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(account.steam_id)}&count=20&format=json`, "Jogos recentes");
    const games = data.response?.games || [];
    for (const game of games) {
      run(`INSERT INTO steam_games (steam_account_id, appid, name, img_icon_url, img_logo_url, playtime_forever, playtime_2weeks, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(steam_account_id, appid) DO UPDATE SET
          name = excluded.name,
          playtime_forever = MAX(steam_games.playtime_forever, excluded.playtime_forever),
          playtime_2weeks = excluded.playtime_2weeks,
          updated_at = CURRENT_TIMESTAMP`, [
        account.id,
        Number(game.appid),
        game.name || `App ${game.appid}`,
        steamImageUrl(game.img_icon_url, game.appid),
        steamImageUrl(game.img_logo_url, game.appid),
        Number(game.playtime_forever || 0),
        Number(game.playtime_2weeks || 0)
      ]);
    }
    return games.length;
  } catch {
    return 0;
  }
}

async function syncSteamFriends(account, key) {
  const friendsData = await steamFetch(`https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(account.steam_id)}&relationship=friend`, "Amigos Steam");
  const friends = friendsData.friendslist?.friends || [];
  const ids = friends.map((friend) => friend.steamid).filter(Boolean);
  const summaries = new Map();
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const data = await steamFetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}&steamids=${chunk.join(",")}`, "Perfis de amigos");
    for (const player of data.response?.players || []) summaries.set(player.steamid, player);
  }
  for (const friend of friends) {
    const player = summaries.get(friend.steamid) || {};
    run(`INSERT INTO steam_friends (steam_account_id, friend_steam_id, persona_name, avatar_url, profile_url, person_state, game_extra_info, last_logoff_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(steam_account_id, friend_steam_id) DO UPDATE SET
        persona_name = excluded.persona_name,
        avatar_url = excluded.avatar_url,
        profile_url = excluded.profile_url,
        person_state = excluded.person_state,
        game_extra_info = excluded.game_extra_info,
        last_logoff_at = excluded.last_logoff_at,
        updated_at = CURRENT_TIMESTAMP`, [
      account.id,
      friend.steamid,
      player.personaname || "",
      player.avatarfull || player.avatarmedium || "",
      player.profileurl || steamProfileUrl(friend.steamid),
      Number(player.personastate || 0),
      player.gameextrainfo || "",
      unixToSqlDateTime(player.lastlogoff)
    ]);
  }
  return friends.length;
}

async function syncSteamAchievements(account, key) {
  const games = all("SELECT appid, name FROM steam_games WHERE steam_account_id = ? AND playtime_forever > 0 ORDER BY playtime_forever DESC LIMIT 25", [account.id]);
  let total = 0;
  for (const game of games) {
    try {
      const data = await steamFetch(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(account.steam_id)}&appid=${game.appid}&l=portuguese`, `Conquistas ${game.name}`);
      const achievements = data.playerstats?.achievements || [];
      for (const achievement of achievements) {
        run(`INSERT INTO steam_achievements (steam_account_id, appid, achievement_name, display_name, description, icon_url, unlocked, unlock_time, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(steam_account_id, appid, achievement_name) DO UPDATE SET
            display_name = excluded.display_name,
            description = excluded.description,
            icon_url = excluded.icon_url,
            unlocked = excluded.unlocked,
            unlock_time = excluded.unlock_time,
            updated_at = CURRENT_TIMESTAMP`, [
          account.id,
          Number(game.appid),
          achievement.apiname || achievement.name || "",
          achievement.name || achievement.apiname || "",
          achievement.description || "",
          achievement.icon || "",
          Number(achievement.achieved || 0),
          unixToSqlDateTime(achievement.unlocktime)
        ]);
        total += 1;
      }
    } catch {
      finishSteamSyncLog(createSteamSyncLog(account.id, `conquistas ${game.appid}`), "aviso", `${game.name}: conquistas privadas ou indisponiveis.`);
    }
  }
  return total;
}

async function syncSteamInventory(account) {
  let total = 0;
  const warnings = [];
  const priceCache = new Map();
  for (const game of steamInventoryGames) {
    try {
      await sleep(2500);
      const data = await fetchSteamInventoryGame(account, game);
      const descriptions = new Map((data.descriptions || []).map((item) => [`${item.classid}_${item.instanceid}`, item]));
      run("DELETE FROM steam_inventory_items WHERE steam_account_id = ? AND appid = ?", [account.id, game.appid]);
      for (const asset of data.assets || []) {
        const description = descriptions.get(`${asset.classid}_${asset.instanceid}`) || {};
        const rarity = (description.tags || []).find((tag) => /rarity/i.test(tag.category || ""))?.localized_tag_name || "";
        const marketHashName = description.market_hash_name || description.name || "";
        const cacheKey = `${game.appid}:${marketHashName}`;
        let marketPrice = { price: 0, text: "" };
        if (Number(description.marketable || 0) && marketHashName) {
          if (!priceCache.has(cacheKey)) {
            try {
              marketPrice = await fetchSteamMarketPrice(game.appid, marketHashName, account);
              await sleep(350);
            } catch {
              marketPrice = { price: 0, text: "" };
            }
            priceCache.set(cacheKey, marketPrice);
          } else {
            marketPrice = priceCache.get(cacheKey);
          }
        }
        run(`INSERT INTO steam_inventory_items (steam_account_id, appid, asset_id, class_id, instance_id, item_name, market_hash_name, item_type, image_url, rarity, inspect_url, float_value, tradable, marketable, quantity, estimated_price, steam_price_text, steam_price_updated_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(steam_account_id, appid, asset_id) DO UPDATE SET
            item_name = excluded.item_name,
            market_hash_name = excluded.market_hash_name,
            item_type = excluded.item_type,
            image_url = excluded.image_url,
            rarity = excluded.rarity,
            inspect_url = excluded.inspect_url,
            float_value = excluded.float_value,
            tradable = excluded.tradable,
            marketable = excluded.marketable,
            quantity = excluded.quantity,
            estimated_price = excluded.estimated_price,
            steam_price_text = excluded.steam_price_text,
            steam_price_updated_at = excluded.steam_price_updated_at,
            updated_at = CURRENT_TIMESTAMP`, [
          account.id,
          game.appid,
          asset.assetid || "",
          asset.classid || "",
          asset.instanceid || "",
          description.market_hash_name || description.name || "Item Steam",
          marketHashName,
          description.type || game.name,
          steamImageUrl(description.icon_url),
          rarity,
          steamInspectUrl(description, asset),
          null,
          Number(description.tradable || 0),
          Number(description.marketable || 0),
          Number(asset.amount || 1),
          marketPrice.price || 0,
          marketPrice.text || ""
        ]);
        total += 1;
      }
      finishSteamSyncLog(createSteamSyncLog(account.id, `inventario ${game.name}`), "sucesso", `${game.name}: ${data.assets.length} itens sincronizados.`);
    } catch (error) {
      const message = error.code === "STEAM_RATE_LIMIT"
        ? `${game.name}: limite temporario da Steam atingido. Aguarde alguns minutos e sincronize novamente.`
        : error.message || `${game.name}: inventario indisponivel.`;
      warnings.push(message);
      finishSteamSyncLog(createSteamSyncLog(account.id, `inventario ${game.name}`), "aviso", message);
      if (error.code === "STEAM_RATE_LIMIT") break;
    }
  }
  return { total, warnings };
}

async function syncSteamAccount(accountId, userId, options = {}) {
  const includeInventory = Boolean(options.includeInventory);
  const key = steamApiKey();
  const account = get("SELECT * FROM steam_accounts WHERE id = ? AND user_id = ?", [accountId, userId]);
  if (!account) throw new Error("Conta Steam nao encontrada.");
  const logId = createSteamSyncLog(account.id, "geral");
  if (!key) {
    const message = "Configure STEAM_API_KEY para sincronizar com a Steam Web API.";
    run("UPDATE steam_accounts SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, account.id]);
    finishSteamSyncLog(logId, "erro", message);
    throw new Error(message);
  }
  try {
    await syncSteamProfile(account, key);
    const games = await syncSteamGames(account, key);
    const recent = await syncSteamRecentGames(account, key);
    let friends = 0;
    try {
      friends = await syncSteamFriends(account, key);
    } catch (error) {
      finishSteamSyncLog(createSteamSyncLog(account.id, "amigos"), "aviso", error.message);
    }
    const achievements = await syncSteamAchievements(account, key);
    const inventory = includeInventory ? await syncSteamInventory(account) : null;
    const inventoryText = includeInventory ? `${inventory.total} itens${inventory.warnings.length ? `, ${inventory.warnings.length} aviso(s)` : ""}` : "inventario mantido como estava";
    const message = `Sincronizado: ${games} jogos, ${recent} recentes, ${achievements} conquistas, ${friends} amigos, ${inventoryText}.`;
    run("UPDATE steam_accounts SET last_sync_at = CURRENT_TIMESTAMP, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, account.id]);
    finishSteamSyncLog(logId, "sucesso", message);
    return get("SELECT * FROM steam_accounts WHERE id = ?", [account.id]);
  } catch (error) {
    run("UPDATE steam_accounts SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [error.message, account.id]);
    finishSteamSyncLog(logId, "erro", error.message);
    throw error;
  }
}

async function syncSteamInventoryOnly(accountId, userId) {
  const account = get("SELECT * FROM steam_accounts WHERE id = ? AND user_id = ?", [accountId, userId]);
  if (!account) throw new Error("Conta Steam nao encontrada.");
  const logId = createSteamSyncLog(account.id, "inventario manual");
  try {
    const inventory = await syncSteamInventory(account);
    const message = inventory.total
      ? `Inventario sincronizado manualmente: ${inventory.total} itens${inventory.warnings.length ? `, ${inventory.warnings.length} aviso(s)` : ""}.`
      : `Inventario sincronizado manualmente: 0 itens${inventory.warnings.length ? `. Avisos: ${inventory.warnings.slice(0, 2).join(" | ")}` : "."}`;
    run("UPDATE steam_accounts SET last_sync_at = CURRENT_TIMESTAMP, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, account.id]);
    finishSteamSyncLog(logId, inventory.total ? "sucesso" : "aviso", message);
    return { account: get("SELECT * FROM steam_accounts WHERE id = ?", [account.id]), inventory };
  } catch (error) {
    run("UPDATE steam_accounts SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [error.message, account.id]);
    finishSteamSyncLog(logId, "erro", error.message);
    throw error;
  }
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return `salvo ${"•".repeat(8)} ${text.slice(-4)}`;
}

function csgoTokenHint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `token salvo ${"•".repeat(8)}${text.slice(-4)}`;
}

function cleanCsgoAccount(row) {
  if (!row) return null;
  const { encrypted_token, ...clean } = row;
  clean.has_token = Boolean(encrypted_token);
  clean.token_hint = row.token_hint || (encrypted_token ? "token salvo ••••••••" : "");
  return clean;
}

function csgoInventorySaleValue(value) {
  return roundMoney((Number(value || 0) * 6) / 100);
}

function csgoCentValue(value) {
  return roundMoney(Number(value || 0) / 100);
}

function csgoTransactionDirection(action, value) {
  const text = String(action || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const amount = Number(value || 0);
  if (amount > 0 || /(deposit|credit|bonus|sell|sale|venda|entrada|win|profit|refund)/.test(text)) return "entrada";
  if (amount < 0 || /(withdraw|buy|case|open|purchase|saida|debit|loss|perda)/.test(text)) return "saida";
  return "neutro";
}

function createCsgoSkinsSyncLog(accountId, syncType) {
  const result = run("INSERT INTO csgo_skins_sync_logs (account_id, sync_type, status, message, started_at) VALUES (?, ?, 'rodando', ?, CURRENT_TIMESTAMP)", [accountId, syncType, "Sincronizacao iniciada"]);
  return result.lastInsertRowid;
}

function finishCsgoSkinsSyncLog(logId, status, message) {
  run("UPDATE csgo_skins_sync_logs SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [status, String(message || "").slice(0, 1000), logId]);
}

function csgoSkinsAccountToken(account) {
  if (!account?.encrypted_token) return "";
  try {
    return decryptVaultText(account.encrypted_token);
  } catch {
    return "";
  }
}

function normalizeCsgoSkinsSecret(secret) {
  let text = String(secret || "").trim();
  text = text.replace(/^cookie\s*:\s*/i, "").trim();
  text = text.replace(/^authorization\s*:\s*/i, "").trim();
  return text;
}

function unquoteCurlValue(value) {
  return String(value || "")
    .trim()
    .replace(/^\^?[$]?['"]|[\^]?['"]$/g, "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .replace(/\^(.)/g, "$1")
    .trim();
}

function extractHeaderFromText(text, headerName) {
  const source = String(text || "")
    .replace(/\^\r?\n/g, " ")
    .replace(/\\\r?\n/g, " ")
    .replace(/`\r?\n/g, " ");
  const escaped = headerName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const lineMatch = source.match(new RegExp(`(?:^|\\n|\\r)\\s*${escaped}\\s*:\\s*([^\\r\\n]+)`, "i"));
  if (lineMatch) return unquoteCurlValue(lineMatch[1]);
  const headerPattern = /(?:-H|--header)\s+\^?(['"])([\s\S]*?)(?:\1|\^\1)/gi;
  let match;
  while ((match = headerPattern.exec(source))) {
    const header = unquoteCurlValue(match[2]);
    const separator = header.indexOf(":");
    if (separator === -1) continue;
    const name = header.slice(0, separator).trim().toLowerCase();
    if (name === headerName.toLowerCase()) return unquoteCurlValue(header.slice(separator + 1));
  }
  return "";
}

function extractCookieOptionFromText(text) {
  const source = String(text || "")
    .replace(/\^\r?\n/g, " ")
    .replace(/\\\r?\n/g, " ")
    .replace(/`\r?\n/g, " ");
  const cookiePattern = /(?:-b|--cookie)\s+\^?(['"])([\s\S]*?)(?:\1|\^\1)/gi;
  const match = cookiePattern.exec(source);
  return match ? unquoteCurlValue(match[2]) : "";
}

function parseCsgoSkinsAuthInput(raw) {
  const text = String(raw || "").trim();
  const cookie = extractHeaderFromText(text, "cookie") || extractCookieOptionFromText(text);
  const authorization = extractHeaderFromText(text, "authorization");
  const userAgent = extractHeaderFromText(text, "user-agent");
  const acceptLanguage = extractHeaderFromText(text, "accept-language");
  return {
    secret: normalizeCsgoSkinsSecret(cookie || authorization || text),
    user_agent: userAgent,
    accept_language: acceptLanguage
  };
}

function csgoSkinsResponseError(response, text) {
  const compact = String(text || "").replace(/\s+/g, " ").slice(0, 180);
  const lower = compact.toLowerCase();
  if (lower.includes("just a moment") || lower.includes("cloudflare") || lower.includes("cf-browser-verification")) {
    const error = new Error("O CSGO-SKINS pediu verificacao do Cloudflare. Edite a conta e cole o Copy as cURL completo do navegador, incluindo Cookie, cf_clearance e User-Agent.");
    error.code = "CSGO_CLOUDFLARE";
    error.status = response.status;
    return error;
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error("Cookie/token expirado ou sem permissao. Reconecte esta conta e cole o Cookie completo atualizado.");
    error.code = "CSGO_TOKEN_EXPIRED";
    error.status = response.status;
    return error;
  }
  if (response.status === 404) {
    const error = new Error("Endpoint do CSGO-SKINS nao encontrado.");
    error.code = "CSGO_NOT_FOUND";
    error.status = response.status;
    return error;
  }
  if (response.status === 429) {
    const error = new Error("Limite temporario do CSGO-SKINS atingido. Aguarde e tente novamente.");
    error.code = "CSGO_RATE_LIMIT";
    error.status = response.status;
    return error;
  }
  const error = new Error(`CSGO-SKINS respondeu ${response.status}. ${compact || response.statusText || "Sem detalhes."}`);
  error.code = "CSGO_HTTP_ERROR";
  error.status = response.status;
  return error;
}

async function csgoSkinsFetch(account, endpoint) {
  const savedAuth = parseCsgoSkinsAuthInput(csgoSkinsAccountToken(account));
  const token = savedAuth.secret;
  if (!token) {
    const error = new Error("Cookie/token ausente. Atualize a conexao da conta.");
    error.code = "CSGO_TOKEN_MISSING";
    throw error;
  }
  const headers = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": savedAuth.user_agent || account.user_agent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "accept-language": savedAuth.accept_language || account.accept_language || "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-currency": "BRL",
    "x-requested-with": "XMLHttpRequest",
    "referer": "https://csgo-skins.com/",
    "origin": "https://csgo-skins.com"
  };
  if (/=|;/.test(token)) headers.cookie = token;
  else headers.authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`https://csgo-skins.com${endpoint}`, { headers });
  } catch {
    const error = new Error("Nao foi possivel conectar ao CSGO-SKINS agora.");
    error.code = "CSGO_CONNECTION_ERROR";
    throw error;
  }
  const text = await response.text();
  if (!response.ok) throw csgoSkinsResponseError(response, text);
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw csgoSkinsResponseError(response, text);
    }
  }
  if (data && typeof data !== "object") {
      const error = new Error("CSGO-SKINS retornou uma resposta invalida.");
      error.code = "CSGO_INVALID_JSON";
      throw error;
  }
  return data || {};
}

async function fetchCsgoSkinsTransactions(accountId, page = 1) {
  const account = get("SELECT * FROM csgo_skins_accounts WHERE id = ?", [accountId]);
  if (!account) throw new Error("Conta CSGO-SKINS nao encontrada.");
  return csgoSkinsFetch(account, `/api/transactions?page=${Number(page || 1)}`);
}

async function fetchAllCsgoSkinsTransactions(accountId) {
  const first = await fetchCsgoSkinsTransactions(accountId, 1);
  const pages = Math.max(1, Number(first.maxPage || first.max_page || 1));
  const transactions = [...(first.transactions || [])];
  for (let page = 2; page <= pages; page += 1) {
    const data = await fetchCsgoSkinsTransactions(accountId, page);
    transactions.push(...(data.transactions || []));
  }
  return { ...first, transactions, maxPage: pages };
}

async function fetchCsgoSkinsInventory(accountId) {
  const account = get("SELECT * FROM csgo_skins_accounts WHERE id = ?", [accountId]);
  if (!account) throw new Error("Conta CSGO-SKINS nao encontrada.");
  return csgoSkinsFetch(account, "/api/inventory/available-with-withdrawing?trustpilot=true");
}

async function fetchCsgoSkinsCasesCatalog(accountId = 0) {
  const account = accountId ? get("SELECT * FROM csgo_skins_accounts WHERE id = ?", [accountId]) : get("SELECT * FROM csgo_skins_accounts WHERE is_active = 1 AND encrypted_token <> '' ORDER BY id LIMIT 1");
  if (!account) throw new Error("Cadastre uma conta com cookie/token para sincronizar as caixas.");
  return csgoSkinsFetch(account, "/api/ui/index");
}

function saveCsgoSkinsTransactions(accountId, transactions = []) {
  let saved = 0;
  for (const item of transactions) {
    const transactionId = String(item.id || "");
    if (!transactionId) continue;
    const value = Number(item.value || 0);
    const balance = Number(item.balance || 0);
    const action = String(item.action || "");
    run(`INSERT INTO csgo_skins_transactions
      (account_id, transaction_id, value, value_brl, balance, balance_brl, wallet_type, action, direction, created_at_remote, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, transaction_id) DO UPDATE SET
        value = excluded.value,
        value_brl = excluded.value_brl,
        balance = excluded.balance,
        balance_brl = excluded.balance_brl,
        wallet_type = excluded.wallet_type,
        action = excluded.action,
        direction = excluded.direction,
        created_at_remote = excluded.created_at_remote,
        updated_at = CURRENT_TIMESTAMP`, [
      accountId,
      transactionId,
      value,
      csgoCentValue(value),
      balance,
      csgoCentValue(balance),
      item.walletType || item.wallet_type || "",
      action,
      csgoTransactionDirection(action, value),
      String(item.createdAt || item.created_at || "").replace("T", " ").replace("Z", "")
    ]);
    saved += 1;
  }
  return saved;
}

function saveCsgoSkinsInventory(accountId, payload = {}) {
  const items = payload.items || [];
  let saved = 0;
  for (const item of items) {
    const remoteId = String(item.id || "");
    if (!remoteId) continue;
    run(`INSERT INTO csgo_skins_inventory_items
      (account_id, remote_item_id, item_id, origin, source_type, source_id, name, status, is_locked, value, sale_value_brl, image, color, roll_id, created_at_remote, updated_at_remote, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, remote_item_id) DO UPDATE SET
        item_id = excluded.item_id,
        origin = excluded.origin,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        name = excluded.name,
        status = excluded.status,
        is_locked = excluded.is_locked,
        value = excluded.value,
        sale_value_brl = excluded.sale_value_brl,
        image = excluded.image,
        color = excluded.color,
        roll_id = excluded.roll_id,
        created_at_remote = excluded.created_at_remote,
        updated_at_remote = excluded.updated_at_remote,
        updated_at = CURRENT_TIMESTAMP`, [
      accountId,
      remoteId,
      String(item.itemId || item.item_id || ""),
      item.origin || "",
      item.sourceType || item.source_type || "",
      String(item.sourceId || item.source_id || ""),
      item.name || "",
      item.status || "",
      item.isLocked ? 1 : 0,
      Number(item.value || 0),
      csgoInventorySaleValue(item.value),
      item.image || "",
      item.color || "",
      String(item.rollId || item.roll_id || ""),
      String(item.createdAt || item.created_at || "").replace("T", " ").replace("Z", ""),
      String(item.updatedAt || item.updated_at || "").replace("T", " ").replace("Z", "")
    ]);
    saved += 1;
  }
  return { saved, availableItemsCount: Number(payload.availableItemsCount || items.length || 0), totalSaleValue: csgoInventorySaleValue(payload.availableItemsValue || 0) };
}

function collectCsgoCases(data) {
  const found = [];
  const walk = (node, category = "") => {
    if (!node || typeof node !== "object") return;
    const nextCategory = node.title || node.name && Array.isArray(node.containers) ? node.name : category;
    const containers = Array.isArray(node.containers) ? node.containers : Array.isArray(node.cases) ? node.cases : [];
    for (const item of containers) found.push({ ...item, category_name: nextCategory || category || "Catalogo" });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => walk(child, nextCategory || category));
      else if (value && typeof value === "object") walk(value, nextCategory || category);
    }
  };
  walk(data);
  const unique = new Map();
  for (const item of found) {
    const id = String(item.id || "");
    if (id && !unique.has(id)) unique.set(id, item);
  }
  return [...unique.values()];
}

function saveCsgoSkinsCases(data = {}) {
  const cases = collectCsgoCases(data);
  let saved = 0;
  for (const item of cases) {
    const remoteId = String(item.id || "");
    if (!remoteId) continue;
    run(`INSERT INTO csgo_skins_cases
      (remote_case_id, category_name, slug, name, image, modes, original_price, original_price_brl, price, price_brl, position, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(remote_case_id) DO UPDATE SET
        category_name = excluded.category_name,
        slug = excluded.slug,
        name = excluded.name,
        image = excluded.image,
        modes = excluded.modes,
        original_price = excluded.original_price,
        original_price_brl = excluded.original_price_brl,
        price = excluded.price,
        price_brl = excluded.price_brl,
        position = excluded.position,
        updated_at = CURRENT_TIMESTAMP`, [
      remoteId,
      item.category_name || "Catalogo",
      item.slug || "",
      item.name || "",
      item.image || "",
      Array.isArray(item.modes) ? item.modes.join(", ") : String(item.modes || ""),
      Number(item.originalPrice || item.original_price || 0),
      csgoCentValue(item.originalPrice || item.original_price || 0),
      Number(item.price || 0),
      csgoCentValue(item.price || 0),
      Number(item.position || 0)
    ]);
    saved += 1;
  }
  return saved;
}

async function syncCsgoSkinsInventory(accountId, userId) {
  const account = get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [accountId, userId]);
  if (!account) throw new Error("Conta CSGO-SKINS nao encontrada.");
  const logId = createCsgoSkinsSyncLog(account.id, "inventario");
  try {
    const payload = await fetchCsgoSkinsInventory(account.id);
    const result = saveCsgoSkinsInventory(account.id, payload);
    const message = `Inventario sincronizado: ${result.saved} itens. Total venda: ${formatMoneyBR(result.totalSaleValue)}.`;
    run("UPDATE csgo_skins_accounts SET connection_status = 'conectado', last_sync_at = CURRENT_TIMESTAMP, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, account.id]);
    finishCsgoSkinsSyncLog(logId, "sucesso", message);
    return result;
  } catch (error) {
    const status = error.code === "CSGO_TOKEN_EXPIRED" ? "expirado" : "erro";
    run("UPDATE csgo_skins_accounts SET connection_status = ?, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, error.message, account.id]);
    finishCsgoSkinsSyncLog(logId, "erro", error.message);
    throw error;
  }
}

async function syncCsgoSkinsTransactions(accountId, userId) {
  const account = get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [accountId, userId]);
  if (!account) throw new Error("Conta CSGO-SKINS nao encontrada.");
  const logId = createCsgoSkinsSyncLog(account.id, "transacoes");
  try {
    const payload = await fetchAllCsgoSkinsTransactions(account.id);
    const saved = saveCsgoSkinsTransactions(account.id, payload.transactions || []);
    const message = `Transacoes sincronizadas: ${saved} registros.`;
    run("UPDATE csgo_skins_accounts SET connection_status = 'conectado', last_sync_at = CURRENT_TIMESTAMP, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, account.id]);
    finishCsgoSkinsSyncLog(logId, "sucesso", message);
    return { saved };
  } catch (error) {
    const status = error.code === "CSGO_TOKEN_EXPIRED" ? "expirado" : "erro";
    run("UPDATE csgo_skins_accounts SET connection_status = ?, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, error.message, account.id]);
    finishCsgoSkinsSyncLog(logId, "erro", error.message);
    throw error;
  }
}

async function syncCsgoSkinsCases(userId, accountId = 0) {
  const account = accountId ? get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [accountId, userId]) : get("SELECT * FROM csgo_skins_accounts WHERE user_id = ? AND is_active = 1 AND encrypted_token <> '' ORDER BY id LIMIT 1", [userId]);
  if (!account) throw new Error("Cadastre uma conta ativa com cookie/token para sincronizar caixas.");
  const logId = createCsgoSkinsSyncLog(account.id, "caixas");
  try {
    const payload = await fetchCsgoSkinsCasesCatalog(account.id);
    const saved = saveCsgoSkinsCases(payload);
    const message = `Catalogo sincronizado: ${saved} caixas.`;
    finishCsgoSkinsSyncLog(logId, "sucesso", message);
    return { saved };
  } catch (error) {
    finishCsgoSkinsSyncLog(logId, "erro", error.message);
    throw error;
  }
}

async function syncCsgoSkinsAccount(accountId, userId) {
  const inventory = await syncCsgoSkinsInventory(accountId, userId);
  const transactions = await syncCsgoSkinsTransactions(accountId, userId);
  return { inventory, transactions };
}

async function testCsgoSkinsAccountConnection(accountId, userId) {
  const account = get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [accountId, userId]);
  if (!account) throw new Error("Conta CSGO-SKINS nao encontrada.");
  const logId = createCsgoSkinsSyncLog(account.id, "teste conexao");
  try {
    await fetchCsgoSkinsTransactions(account.id, 1);
    const message = "Conexao validada com sucesso.";
    run("UPDATE csgo_skins_accounts SET connection_status = 'conectado', sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [message, account.id]);
    finishCsgoSkinsSyncLog(logId, "sucesso", message);
    return { ok: true, message };
  } catch (error) {
    const status = error.code === "CSGO_TOKEN_EXPIRED" ? "expirado" : "erro";
    run("UPDATE csgo_skins_accounts SET connection_status = ?, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, error.message, account.id]);
    finishCsgoSkinsSyncLog(logId, "erro", error.message);
    throw error;
  }
}

const csgoSkinsService = {
  fetchTransactions: fetchCsgoSkinsTransactions,
  fetchAllTransactions: fetchAllCsgoSkinsTransactions,
  fetchInventory: fetchCsgoSkinsInventory,
  fetchCasesCatalog: fetchCsgoSkinsCasesCatalog,
  syncAccount: syncCsgoSkinsAccount,
  syncAllAccounts: async (userId) => {
    const accounts = all("SELECT id FROM csgo_skins_accounts WHERE user_id = ? AND is_active = 1", [userId]);
    const results = [];
    for (const account of accounts) {
      try {
        results.push({ id: account.id, ok: true, result: await syncCsgoSkinsAccount(account.id, userId) });
      } catch (error) {
        results.push({ id: account.id, ok: false, error: error.message });
      }
    }
    return results;
  },
  testAccountConnection: testCsgoSkinsAccountConnection
};

function listCsgoSkinsAccounts(userId) {
  return all(`
    SELECT
      csgo_skins_accounts.*,
      COALESCE(inv.items_count, 0) AS items_count,
      COALESCE(inv.inventory_value_brl, 0) AS synced_inventory_value_brl,
      CASE
        WHEN COALESCE(csgo_skins_accounts.manual_inventory_enabled, 0) = 1
          THEN COALESCE(csgo_skins_accounts.manual_inventory_value_brl, 0)
        ELSE COALESCE(inv.inventory_value_brl, 0)
      END AS inventory_value_brl,
      COALESCE(tx.transactions_count, 0) AS transactions_count,
      COALESCE(tx.entries_brl, 0) AS entries_brl,
      COALESCE(tx.exits_brl, 0) AS exits_brl
    FROM csgo_skins_accounts
      LEFT JOIN (
        SELECT account_id, COUNT(*) AS items_count, SUM(sale_value_brl) AS inventory_value_brl
        FROM csgo_skins_inventory_items
        GROUP BY account_id
      ) inv ON inv.account_id = csgo_skins_accounts.id
      LEFT JOIN (
        SELECT account_id,
          COUNT(*) AS transactions_count,
          SUM(CASE WHEN direction = 'entrada' THEN ABS(value_brl) ELSE 0 END) AS entries_brl,
          SUM(CASE WHEN direction = 'saida' THEN ABS(value_brl) ELSE 0 END) AS exits_brl
        FROM csgo_skins_transactions
        GROUP BY account_id
      ) tx ON tx.account_id = csgo_skins_accounts.id
    WHERE csgo_skins_accounts.user_id = ?
    ORDER BY csgo_skins_accounts.is_active DESC, csgo_skins_accounts.id DESC
  `, [userId]).map(cleanCsgoAccount);
}

function csgoSkinsOverview(userId) {
  const accounts = listCsgoSkinsAccounts(userId);
  const totalItems = accounts.reduce((sum, account) => sum + Number(account.items_count || 0), 0);
  const inventoryValue = accounts.reduce((sum, account) => sum + Number(account.inventory_value_brl || 0), 0);
  const totals = get(`
    SELECT
      COUNT(*) AS total_accounts,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_accounts,
      SUM(CASE WHEN connection_status IN ('expirado','erro','precisa reconectar') THEN 1 ELSE 0 END) AS problem_accounts
    FROM csgo_skins_accounts WHERE user_id = ?
  `, [userId]);
  const transactions = get(`
    SELECT COUNT(*) AS total_transactions,
      COALESCE(SUM(CASE WHEN direction = 'entrada' THEN ABS(value_brl) ELSE 0 END), 0) AS entries_brl,
      COALESCE(SUM(CASE WHEN direction = 'saida' THEN ABS(value_brl) ELSE 0 END), 0) AS exits_brl
    FROM csgo_skins_transactions
    WHERE account_id IN (SELECT id FROM csgo_skins_accounts WHERE user_id = ?)
  `, [userId]);
  const logs = all(`
    SELECT csgo_skins_sync_logs.*, csgo_skins_accounts.nickname AS account_nickname
    FROM csgo_skins_sync_logs
    LEFT JOIN csgo_skins_accounts ON csgo_skins_accounts.id = csgo_skins_sync_logs.account_id
    WHERE csgo_skins_accounts.user_id = ? OR csgo_skins_sync_logs.account_id IS NULL
    ORDER BY started_at DESC LIMIT 12
  `, [userId]);
  return {
    accounts,
    totals: {
      total_accounts: Number(totals.total_accounts || 0),
      active_accounts: Number(totals.active_accounts || 0),
      problem_accounts: Number(totals.problem_accounts || 0),
      total_items: totalItems,
      inventory_value_brl: roundMoney(inventoryValue),
      total_transactions: Number(transactions.total_transactions || 0),
      entries_brl: roundMoney(transactions.entries_brl || 0),
      exits_brl: roundMoney(transactions.exits_brl || 0),
      estimated_profit_brl: roundMoney(Number(transactions.entries_brl || 0) - Number(transactions.exits_brl || 0) + inventoryValue)
    },
    logs
  };
}

function listCsgoSkinsTransactions(userId, query) {
  const where = ["csgo_skins_accounts.user_id = ?"];
  const values = [userId];
  if (query.get("account")) {
    where.push("csgo_skins_transactions.account_id = ?");
    values.push(Number(query.get("account")));
  }
  if (query.get("from")) {
    where.push("date(created_at_remote) >= date(?)");
    values.push(query.get("from"));
  }
  if (query.get("to")) {
    where.push("date(created_at_remote) <= date(?)");
    values.push(query.get("to"));
  }
  if (query.get("action")) {
    where.push("action LIKE ?");
    values.push(`%${query.get("action")}%`);
  }
  if (query.get("direction")) {
    where.push("direction = ?");
    values.push(query.get("direction"));
  }
  if (query.get("walletType")) {
    where.push("wallet_type LIKE ?");
    values.push(`%${query.get("walletType")}%`);
  }
  return all(`
    SELECT csgo_skins_transactions.*, csgo_skins_accounts.nickname AS account_nickname
    FROM csgo_skins_transactions
    JOIN csgo_skins_accounts ON csgo_skins_accounts.id = csgo_skins_transactions.account_id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(created_at_remote, csgo_skins_transactions.created_at) DESC, csgo_skins_transactions.id DESC
  `, values);
}

function listCsgoSkinsInventory(userId, query) {
  const where = ["csgo_skins_accounts.user_id = ?"];
  const values = [userId];
  if (query.get("account")) {
    where.push("csgo_skins_inventory_items.account_id = ?");
    values.push(Number(query.get("account")));
  }
  return all(`
    SELECT csgo_skins_inventory_items.*, csgo_skins_accounts.nickname AS account_nickname
    FROM csgo_skins_inventory_items
    JOIN csgo_skins_accounts ON csgo_skins_accounts.id = csgo_skins_inventory_items.account_id
    WHERE ${where.join(" AND ")}
    ORDER BY sale_value_brl DESC, name
  `, values);
}

function csgoSkinsReports(userId) {
  return {
    monthly: all(`
      SELECT substr(COALESCE(created_at_remote, created_at), 1, 7) AS month,
        SUM(CASE WHEN direction = 'entrada' THEN ABS(value_brl) ELSE 0 END) AS entries_brl,
        SUM(CASE WHEN direction = 'saida' THEN ABS(value_brl) ELSE 0 END) AS exits_brl,
        SUM(CASE WHEN direction = 'entrada' THEN ABS(value_brl) ELSE -ABS(value_brl) END) AS balance_brl,
        COUNT(*) AS transactions_count
      FROM csgo_skins_transactions
      WHERE account_id IN (SELECT id FROM csgo_skins_accounts WHERE user_id = ?)
      GROUP BY month ORDER BY month DESC
    `, [userId]),
    byAccount: all(`
      SELECT csgo_skins_accounts.nickname,
        COUNT(DISTINCT csgo_skins_inventory_items.id) AS items_count,
        COALESCE(SUM(csgo_skins_inventory_items.sale_value_brl), 0) AS synced_inventory_value_brl,
        CASE
          WHEN COALESCE(csgo_skins_accounts.manual_inventory_enabled, 0) = 1
            THEN COALESCE(csgo_skins_accounts.manual_inventory_value_brl, 0)
          ELSE COALESCE(SUM(csgo_skins_inventory_items.sale_value_brl), 0)
        END AS inventory_value_brl
      FROM csgo_skins_accounts
      LEFT JOIN csgo_skins_inventory_items ON csgo_skins_inventory_items.account_id = csgo_skins_accounts.id
      WHERE csgo_skins_accounts.user_id = ?
      GROUP BY csgo_skins_accounts.id ORDER BY inventory_value_brl DESC
    `, [userId]),
    byAction: all(`
      SELECT action, direction, COUNT(*) AS total, SUM(ABS(value_brl)) AS amount_brl
      FROM csgo_skins_transactions
      WHERE account_id IN (SELECT id FROM csgo_skins_accounts WHERE user_id = ?)
      GROUP BY action, direction ORDER BY total DESC
    `, [userId])
  };
}

function encryptDocument(content) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", documentEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  return Buffer.concat([Buffer.from("DRSODOC1"), iv, cipher.getAuthTag(), encrypted]);
}

function decryptDocument(content) {
  const magic = content.subarray(0, 8).toString("utf8");
  if (magic !== "DRSODOC1") return content;
  const iv = content.subarray(8, 20);
  const tag = content.subarray(20, 36);
  const encrypted = content.subarray(36);
  const decipher = createDecipheriv("aes-256-gcm", documentEncryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function encryptVaultText(value) {
  const text = String(value ?? "");
  if (!text) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", passwordEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  });
}

function decryptVaultText(value) {
  if (!value) return "";
  try {
    const payload = JSON.parse(value);
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const encrypted = Buffer.from(payload.data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", passwordEncryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return String(value || "");
  }
}

function documentStoragePath(record) {
  const storedName = String(record.file_path || "").replace("drso-secure://", "");
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName.includes("..")) return null;
  return path.join(documentUploadsDir, storedName);
}

function xmlDecode(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function xmlEncode(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function zipEntries(content) {
  let offset = content.length - 22;
  while (offset >= 0 && content.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  if (offset < 0) return [];
  let centralOffset = content.readUInt32LE(offset + 16);
  const centralEnd = centralOffset + content.readUInt32LE(offset + 12);
  const entries = [];
  while (centralOffset < centralEnd && content.readUInt32LE(centralOffset) === 0x02014b50) {
    const method = content.readUInt16LE(centralOffset + 10);
    const compressedSize = content.readUInt32LE(centralOffset + 20);
    const uncompressedSize = content.readUInt32LE(centralOffset + 24);
    const fileNameLength = content.readUInt16LE(centralOffset + 28);
    const extraLength = content.readUInt16LE(centralOffset + 30);
    const commentLength = content.readUInt16LE(centralOffset + 32);
    const localOffset = content.readUInt32LE(centralOffset + 42);
    const nameStart = centralOffset + 46;
    const name = content.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const localNameLength = content.readUInt16LE(localOffset + 26);
    const localExtraLength = content.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = content.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    entries.push({ name, data, uncompressedSize });
    centralOffset = nameStart + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function zipEntry(content, targetName) {
  return zipEntries(content).find((entry) => entry.name === targetName)?.data || null;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function docxXmlFromText(text) {
  const paragraphs = String(text || "").split(/\r?\n/).map((line) => {
    const runs = line ? `<w:r><w:t xml:space="preserve">${xmlEncode(line)}</w:t></w:r>` : "";
    return `<w:p>${runs}</w:p>`;
  }).join("");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
}

function updateDocxText(content, text) {
  const entries = zipEntries(content);
  if (!entries.some((entry) => entry.name === "word/document.xml")) return null;
  return buildZip(entries.map((entry) => entry.name === "word/document.xml" ? { ...entry, data: docxXmlFromText(text) } : entry));
}

function previewDocumentText(record, content) {
  const name = String(record.original_name || record.name || "").toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".csv")) return content.toString("utf8");
  if (name.endsWith(".docx") || content.subarray(0, 2).toString("utf8") === "PK") {
    const xml = zipEntry(content, "word/document.xml");
    if (!xml) return "";
    return xmlDecode(xml.toString("utf8")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return "";
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

function cleanProfileText(value, fallback = "", max = 500) {
  return String(value ?? fallback).trim().slice(0, max);
}

const USER_AVATAR_MAX_LENGTH = 2200000;

function cleanUserAvatar(value, current = "") {
  const avatar = String(value ?? current ?? "").trim();
  if (!avatar) return "";
  if (avatar.startsWith("data:image/") && avatar.length === 250000) return "";
  if (avatar.length > USER_AVATAR_MAX_LENGTH) throw new Error("Imagem muito grande. Use uma foto menor para o avatar.");
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(avatar) && !/^https?:\/\//i.test(avatar)) {
    throw new Error("Formato de avatar invalido.");
  }
  return avatar;
}

function normalizeUserProfilePayload(payload = {}, current = {}) {
  const name = cleanProfileText(payload.name ?? payload.displayName ?? current.name, "Usuario DRSO", 120) || "Usuario DRSO";
  const theme = ["dark", "light"].includes(String(payload.theme || "")) ? String(payload.theme) : (current.theme || "light");
  const accent = cleanProfileText(payload.accent_color ?? payload.accentColor ?? current.accent_color, "#2563EB", 32) || "#2563EB";
  return {
    name,
    first_name: cleanProfileText(payload.first_name ?? payload.firstName ?? current.first_name, "", 80),
    last_name: cleanProfileText(payload.last_name ?? payload.lastName ?? current.last_name, "", 100),
    avatar_url: cleanUserAvatar(payload.avatar_url ?? payload.avatar, current.avatar_url),
    bio: cleanProfileText(payload.bio ?? current.bio, "", 800),
    slogan: cleanProfileText(payload.slogan ?? current.slogan, "Uma Vida. Um Sistema.", 180) || "Uma Vida. Um Sistema.",
    city: cleanProfileText(payload.city ?? current.city, "", 120),
    birth_date: cleanProfileText(payload.birth_date ?? payload.birthDate ?? current.birth_date, "", 20),
    date_format: cleanProfileText(payload.date_format ?? payload.dateFormat ?? current.date_format, "pt-BR", 20) || "pt-BR",
    accent_color: accent,
    theme
  };
}

function databaseToken(req) {
  return req.headers["x-database-token"] || "";
}

function passwordVaultToken(req) {
  return req.headers["x-password-vault-token"] || "";
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function selectOnlySql(sql) {
  const text = String(sql || "").trim();
  if (!text) return "";
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
  if (!/^select\b/i.test(withoutComments)) return "";
  if (withoutComments.includes(";")) return "";
  const blocked = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|pragma|reindex)\b/i;
  return blocked.test(withoutComments) ? "" : withoutComments;
}

const globalSearchSources = [
  { module: "Anotacoes", section: "notes", table: "notes", title: ["title"], detail: ["category", "type", "tags"], fields: ["title", "content", "tags", "category", "type", "author", "priority", "status"], date: "updated_at", excludeWhere: "COALESCE(category, '') <> 'Confidencial'" },
  { module: "Documentos", section: "documents", table: "documents", title: ["name", "original_name"], detail: ["category", "notes"], fields: ["name", "original_name", "category", "notes", "mime_type"], date: "updated_at", excludeWhere: "COALESCE(category, '') <> 'Confidencial'" },
  { module: "Financeiro", section: "finance", table: "financial_transactions", title: ["description", "category"], detail: ["type", "payment_method", "notes"], fields: ["description", "category", "type", "payment_method", "notes", "date", "amount"], date: "date" },
  { module: "Financeiro", section: "finance", table: "bank_accounts", title: ["name", "bank"], detail: ["account_type", "notes"], fields: ["name", "bank", "account_type", "notes"], date: "updated_at" },
  { module: "Cartoes", section: "finance", table: "credit_cards", title: ["name", "bank"], detail: ["brand", "last_four", "notes"], fields: ["name", "bank", "brand", "last_four", "notes"], date: "updated_at" },
  { module: "Cartoes", section: "finance", table: "credit_card_expenses", title: ["description", "category"], detail: ["date", "notes"], fields: ["description", "category", "date", "time", "notes", "total_value"], date: "date", userScoped: true },
  { module: "Agenda", section: "agenda", table: "agenda_events", title: ["title"], detail: ["calendar_name", "start_at", "location"], fields: ["title", "description", "location", "calendar_name", "source", "start_at", "end_at"], date: "start_at", userScoped: true },
  { module: "Apostas", section: "bets", table: "bets", title: ["event", "competition", "market"], detail: ["betting_house", "status", "notes"], fields: ["external_bet_id", "betting_house", "sport", "competition", "event", "market", "entry", "status", "result", "month", "notes"], date: "date" },
  { module: "Apostas", section: "bets", table: "betting_houses", title: ["name"], detail: ["status", "notes"], fields: ["name", "status", "notes", "strategy_notes"], date: "updated_at" },
  { module: "Apostas", section: "bets", table: "betting_bonuses", title: ["description", "bet_reference"], detail: ["betting_house", "notes"], fields: ["betting_house", "type", "description", "bet_reference", "month", "notes"], date: "date" },
  { module: "Meu mes", section: "planning", table: "planning_items", title: ["title"], detail: ["person", "category", "due_date", "notes"], fields: ["month", "person", "title", "category", "due_date", "status", "notes", "recurrence_type", "split_details"], date: "due_date" },
  { module: "Meu mes", section: "planning", table: "planning_categories", title: ["name"], detail: ["notes"], fields: ["name", "notes", "icon"], date: "updated_at" },
  { module: "Projetos", section: "projects", table: "projects", title: ["name"], detail: ["status", "priority", "notes"], fields: ["name", "status", "description", "priority", "notes"], date: "updated_at" },
  { module: "Musicas", section: "music", table: "playlists", title: ["nome"], detail: ["descricao"], fields: ["nome", "descricao", "capa"], date: "atualizado_em" },
  { module: "Musicas", section: "music", table: "playlist_musicas", title: ["titulo"], detail: ["artista", "youtube_url", "audio_file_name"], fields: ["titulo", "artista", "youtube_url", "youtube_video_id", "audio_file_name"], date: "atualizado_em" },
  { module: "Conta da Vendinha", section: "vendinha", table: "vendinha_establishments", title: ["name"], detail: ["notes", "status"], fields: ["name", "notes", "status"], date: "updated_at", userScoped: true },
  { module: "Conta da Vendinha", section: "vendinha", table: "vendinha_products", title: ["name"], detail: ["category", "default_value"], fields: ["name", "category", "status", "default_value"], date: "updated_at", userScoped: true },
  { module: "Conta da Vendinha", section: "vendinha", table: "vendinha_consumptions", title: ["product_name"], detail: ["date", "notes"], fields: ["product_name", "date", "quantity", "unit_value", "total_value", "notes", "status"], date: "date", userScoped: true },
  { module: "Assinaturas", section: "subscriptions", table: "recurring_subscriptions", title: ["name", "provider"], detail: ["category", "payment_method", "notes"], fields: ["name", "provider", "category", "description", "status", "worth_it", "payment_method", "card_name", "card_last_four", "payer", "shared_people", "notes"], date: "updated_at", userScoped: true },
  { module: "Assinaturas", section: "subscriptions", table: "subscription_payments", title: ["payment_date", "status"], detail: ["payment_method", "notes"], fields: ["payment_date", "due_date", "amount_paid", "payment_method", "status", "notes"], date: "payment_date", userScoped: true },
  { module: "Assinaturas", section: "subscriptions", table: "subscription_adjustments", title: ["adjustment_date", "notes"], detail: ["old_value", "new_value"], fields: ["adjustment_date", "old_value", "new_value", "notes"], date: "adjustment_date", userScoped: true },
  { module: "Codex Manager", section: "codexManager", table: "codex_accounts", title: ["email"], detail: ["plan", "reset_type", "notes"], fields: ["email", "plan", "reset_type", "phone_notes", "notes", "tags", "manual_status"], date: "updated_at", userScoped: true },
  { module: "Veiculos", section: "moto", table: "motorcycles", title: ["name", "model"], detail: ["brand", "plate", "notes"], fields: ["vehicle_type", "name", "brand", "model", "year", "plate", "color", "notes"], date: "updated_at", userScoped: true },
  { module: "Veiculos", section: "moto", table: "motorcycle_maintenance_logs", title: ["service_type", "item"], detail: ["workshop", "notes"], fields: ["category", "service_type", "item", "workshop", "notes", "date"], date: "date", userScoped: true },
  { module: "Veiculos", section: "moto", table: "motorcycle_expenses", title: ["description", "category"], detail: ["payment_method", "notes"], fields: ["category", "description", "payment_method", "notes", "date"], date: "date", userScoped: true },
  { module: "Vida pessoal", section: "personal", table: "personal_courses", title: ["name"], detail: ["institution", "category", "notes"], fields: ["name", "institution", "category", "status", "link", "notes", "modules"], date: "updated_at", userScoped: true },
  { module: "Vida pessoal", section: "personal", table: "personal_goals", title: ["title"], detail: ["category", "status", "notes"], fields: ["title", "description", "category", "status", "importance_reason", "reward", "notes", "tasks"], date: "updated_at", userScoped: true },
  { module: "Vida pessoal", section: "personal", table: "personal_projects", title: ["name"], detail: ["category", "status", "notes"], fields: ["name", "description", "category", "status", "tools", "tasks", "link", "notes"], date: "updated_at", userScoped: true },
  { module: "Vida pessoal", section: "personal", table: "personal_life_checklist", title: ["title"], detail: ["category", "status", "notes"], fields: ["title", "category", "status", "steps", "notes"], date: "updated_at", userScoped: true },
  { module: "Vida pessoal", section: "personal", table: "personal_skills", title: ["name"], detail: ["category", "status", "notes"], fields: ["name", "category", "current_level", "desired_level", "status", "notes"], date: "updated_at", userScoped: true },
  { module: "Linha do tempo", section: "timeline", table: "timeline_events", title: ["title"], detail: ["category", "description"], fields: ["title", "description", "category", "date"], date: "date" },
  { module: "Modulos proprios", section: "modules", table: "custom_module_records", title: ["data"], detail: ["data"], fields: ["data"], date: "updated_at" }
];

function normalizeGlobalSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function compactText(value, max = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function pickFirstText(row, fields) {
  for (const field of fields || []) {
    const value = compactText(row[field], 220);
    if (value) return value;
  }
  return "";
}

function globalSearchSnippet(row, source, normalizedQuery) {
  const field = source.fields.find((name) => normalizeGlobalSearchText(row[name]).includes(normalizedQuery));
  const text = compactText(field ? row[field] : pickFirstText(row, source.fields), 500);
  if (!text) return "";
  const lower = normalizeGlobalSearchText(text);
  const index = lower.indexOf(normalizedQuery);
  if (index < 0) return compactText(text, 150);
  const start = Math.max(0, index - 55);
  const end = Math.min(text.length, index + normalizedQuery.length + 95);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function globalSearch(userId, query) {
  const normalizedQuery = normalizeGlobalSearchText(query);
  if (normalizedQuery.length < 2) return [];
  const results = [];
  for (const source of globalSearchSources) {
    try {
      const columns = [...new Set(["id", source.date, ...(source.title || []), ...(source.detail || []), ...(source.fields || [])])];
      const order = source.date ? `ORDER BY ${quoteIdentifier(source.date)} DESC` : "ORDER BY id DESC";
      const whereParts = [];
      const values = [];
      if (source.userScoped) {
        whereParts.push("user_id = ?");
        values.push(userId);
      }
      if (source.excludeWhere) whereParts.push(source.excludeWhere);
      const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
      const rows = all(
        `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(source.table)} ${where} ${order}`,
        values
      );
      for (const row of rows) {
        const haystack = normalizeGlobalSearchText(source.fields.map((field) => row[field]).join(" "));
        if (!haystack.includes(normalizedQuery)) continue;
        const title = pickFirstText(row, source.title) || `${source.module} #${row.id}`;
        const detail = pickFirstText(row, source.detail) || "Resultado encontrado";
        const titleMatch = normalizeGlobalSearchText(title).includes(normalizedQuery);
        const score = (titleMatch ? 50 : 0) + Math.max(0, 20 - results.length);
        results.push({
          id: row.id,
          module: source.module,
          section: source.section,
          title,
          detail,
          snippet: globalSearchSnippet(row, source, normalizedQuery),
          updated_at: row[source.date] || "",
          score
        });
      }
    } catch {
      // Algumas tabelas podem nao existir em bases antigas; a busca segue nas demais.
    }
  }
  return results
    .sort((a, b) => (b.score - a.score) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 40);
}

function validateDatabaseToken(req, user) {
  const token = databaseToken(req);
  const access = token ? databaseTokens.get(token) : null;
  if (!access || access.userId !== user.id || access.expiresAt < Date.now()) {
    if (token) databaseTokens.delete(token);
    return false;
  }
  return true;
}

function validatePasswordVaultToken(req, user) {
  const token = passwordVaultToken(req);
  const access = token ? passwordVaultTokens.get(token) : null;
  if (!access || access.userId !== user.id || access.expiresAt < Date.now()) {
    if (token) passwordVaultTokens.delete(token);
    return false;
  }
  return true;
}

function twofaVaultToken(req) {
  return req.headers["x-2fa-vault-token"] || "";
}

function twofaAccess(req, user) {
  const token = twofaVaultToken(req);
  const access = token ? twofaVaultTokens.get(token) : null;
  if (!access || access.userId !== user.id || access.expiresAt < Date.now()) {
    if (token) twofaVaultTokens.delete(token);
    return null;
  }
  access.expiresAt = Date.now() + 15 * 60 * 1000;
  twofaVaultTokens.set(token, access);
  return access;
}

function requireTwofaAccess(req, user) {
  const access = twofaAccess(req, user);
  if (!access) {
    const error = new Error("Desbloqueie o Cofre 2FA com a senha mestre.");
    error.statusCode = 401;
    throw error;
  }
  return access;
}

function safePasswordVaultItem(row, includeSecrets = true) {
  return {
    id: row.id,
    name: decryptVaultText(row.name),
    username: decryptVaultText(row.username),
    uri: decryptVaultText(row.uri),
    folder: decryptVaultText(row.folder),
    notes: decryptVaultText(row.notes),
    tags: decryptVaultText(row.tags),
    source: row.source || "",
    favorite: Number(row.favorite || 0),
    password: includeSecrets ? decryptVaultText(row.encrypted_password) : "",
    totp: includeSecrets ? decryptVaultText(row.encrypted_totp) : "",
    raw: includeSecrets ? decryptVaultText(row.raw_encrypted) : "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const LIFE_STATUS_LABELS = {
  not_started: "Nao Iniciado",
  in_progress: "Em Andamento",
  done: "Concluido"
};

function normalizeLifeStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["done", "concluido", "concluído", "finalizado"].includes(text)) return "done";
  if (["in_progress", "andamento", "em andamento", "fazendo"].includes(text)) return "in_progress";
  return "not_started";
}

function normalizeLifePriority(value) {
  const text = String(value || "Media").trim();
  return ["Baixa", "Media", "Média", "Alta", "Muito Alta"].includes(text) ? text.replace("Média", "Media") : "Media";
}

function normalizeLifeObjectivePayload(payload = {}, fallback = {}) {
  const status = normalizeLifeStatus(payload.status ?? fallback.status);
  const nowDate = currentDateTime().slice(0, 10);
  return {
    title: String(payload.title ?? payload.titulo ?? fallback.title ?? "").trim().slice(0, 180),
    short_description: String(payload.short_description ?? payload.descricao_curta ?? fallback.short_description ?? "").trim().slice(0, 360),
    reason: String(payload.reason ?? payload.motivo ?? fallback.reason ?? "").trim(),
    category: String(payload.category ?? payload.categoria ?? fallback.category ?? "Pessoal").trim().slice(0, 80) || "Pessoal",
    priority: normalizeLifePriority(payload.priority ?? payload.prioridade ?? fallback.priority),
    status,
    target_date: String(payload.target_date ?? payload.prazo ?? fallback.target_date ?? "").slice(0, 10),
    created_date: String(payload.created_date ?? fallback.created_date ?? nowDate).slice(0, 10),
    completed_date: status === "done" ? String(payload.completed_date ?? fallback.completed_date ?? nowDate).slice(0, 10) : "",
    notes: String(payload.notes ?? payload.observacoes ?? fallback.notes ?? "").trim(),
    current_action: String(payload.current_action ?? payload.o_que_estou_fazendo ?? fallback.current_action ?? "").trim(),
    useful_links: String(payload.useful_links ?? payload.links_uteis ?? fallback.useful_links ?? "").trim()
  };
}

function lifeObjectiveSteps(objectiveId) {
  return all("SELECT * FROM life_objective_steps WHERE objective_id = ? ORDER BY step_order, id", [objectiveId]);
}

function lifeObjectiveHistory(objectiveId) {
  return all("SELECT * FROM life_objective_history WHERE objective_id = ? ORDER BY created_at DESC, id DESC", [objectiveId]);
}

function safeLifeObjective(row, includeDetails = false) {
  if (!row) return null;
  const item = {
    ...row,
    status_label: LIFE_STATUS_LABELS[row.status] || row.status,
    steps_done: Number(row.steps_done || 0),
    steps_total: Number(row.steps_total || 0)
  };
  if (includeDetails) {
    item.steps = lifeObjectiveSteps(row.id);
    item.history = lifeObjectiveHistory(row.id);
  }
  return item;
}

function lifeObjectiveById(userId, id, includeDetails = false) {
  const row = get(`
    SELECT life_objectives.*,
      COUNT(life_objective_steps.id) AS steps_total,
      SUM(CASE WHEN life_objective_steps.completed = 1 THEN 1 ELSE 0 END) AS steps_done
    FROM life_objectives
    LEFT JOIN life_objective_steps ON life_objective_steps.objective_id = life_objectives.id
    WHERE life_objectives.user_id = ? AND life_objectives.id = ?
    GROUP BY life_objectives.id
  `, [userId, id]);
  return safeLifeObjective(row, includeDetails);
}

function listLifeObjectives(userId) {
  const rows = all(`
    SELECT life_objectives.*,
      COUNT(life_objective_steps.id) AS steps_total,
      SUM(CASE WHEN life_objective_steps.completed = 1 THEN 1 ELSE 0 END) AS steps_done
    FROM life_objectives
    LEFT JOIN life_objective_steps ON life_objective_steps.objective_id = life_objectives.id
    WHERE life_objectives.user_id = ?
    GROUP BY life_objectives.id
    ORDER BY life_objectives.status, life_objectives.column_order, life_objectives.id
  `, [userId]).map((row) => safeLifeObjective(row));
  const total = rows.length;
  const done = rows.filter((item) => item.status === "done").length;
  const latestDone = rows
    .filter((item) => item.status === "done" && item.completed_date)
    .sort((a, b) => String(b.completed_date).localeCompare(String(a.completed_date)))[0] || null;
  return {
    items: rows,
    summary: {
      total,
      not_started: rows.filter((item) => item.status === "not_started").length,
      in_progress: rows.filter((item) => item.status === "in_progress").length,
      done,
      progress: total ? roundMoney((done / total) * 100) : 0,
      latest_done: latestDone
    }
  };
}

function nextLifeObjectiveOrder(userId, status) {
  const row = get("SELECT COALESCE(MAX(column_order), 0) AS max_order FROM life_objectives WHERE user_id = ? AND status = ?", [userId, status]);
  return Number(row?.max_order || 0) + 1000;
}

function addLifeHistory(objectiveId, action, previousStatus, newStatus, description = "") {
  run("INSERT INTO life_objective_history (objective_id, action, previous_status, new_status, description, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", [
    objectiveId,
    action,
    previousStatus || "",
    newStatus || "",
    description
  ]);
}

function createLifeObjective(userId, payload) {
  const item = normalizeLifeObjectivePayload(payload);
  if (!item.title) throw new Error("Informe o titulo do objetivo.");
  const order = nextLifeObjectiveOrder(userId, item.status);
  const result = run(`
    INSERT INTO life_objectives (user_id, title, short_description, reason, category, priority, status, target_date, created_date, completed_date, notes, current_action, useful_links, column_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [userId, item.title, item.short_description, item.reason, item.category, item.priority, item.status, item.target_date, item.created_date, item.completed_date, item.notes, item.current_action, item.useful_links, order]);
  addLifeHistory(Number(result.lastInsertRowid), "criado", "", item.status, `Objetivo criado em ${LIFE_STATUS_LABELS[item.status]}.`);
  recordTimeline("Objetivo criado", item.title, "life-kanban");
  return lifeObjectiveById(userId, Number(result.lastInsertRowid), true);
}

function updateLifeObjective(userId, id, payload) {
  const current = lifeObjectiveById(userId, id, false);
  if (!current) throw new Error("Objetivo nao encontrado.");
  const item = normalizeLifeObjectivePayload(payload, current);
  if (!item.title) throw new Error("Informe o titulo do objetivo.");
  const completedDate = item.status === "done"
    ? (current.status === "done" ? item.completed_date || current.completed_date || currentDateTime().slice(0, 10) : currentDateTime().slice(0, 10))
    : "";
  run(`
    UPDATE life_objectives SET title = ?, short_description = ?, reason = ?, category = ?, priority = ?, status = ?, target_date = ?, created_date = ?, completed_date = ?, notes = ?, current_action = ?, useful_links = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `, [item.title, item.short_description, item.reason, item.category, item.priority, item.status, item.target_date, item.created_date, completedDate, item.notes, item.current_action, item.useful_links, id, userId]);
  if (current.status !== item.status) addLifeHistory(id, "status", current.status, item.status, `Status alterado para ${LIFE_STATUS_LABELS[item.status]}.`);
  return lifeObjectiveById(userId, id, true);
}

function deleteLifeObjective(userId, id) {
  const current = lifeObjectiveById(userId, id, false);
  if (!current) throw new Error("Objetivo nao encontrado.");
  run("DELETE FROM life_objectives WHERE id = ? AND user_id = ?", [id, userId]);
  recordTimeline("Objetivo removido", current.title, "life-kanban");
  return { ok: true };
}

function reorderLifeObjectives(userId, items = []) {
  for (const entry of items) {
    const id = Number(entry.id);
    const current = lifeObjectiveById(userId, id, false);
    if (!current) continue;
    const status = normalizeLifeStatus(entry.status);
    const order = Number(entry.column_order ?? entry.order ?? current.column_order);
    const completedDate = status === "done"
      ? (current.status === "done" && current.completed_date ? current.completed_date : currentDateTime().slice(0, 10))
      : "";
    run("UPDATE life_objectives SET status = ?, column_order = ?, completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", [status, order, completedDate, id, userId]);
    if (current.status !== status) addLifeHistory(id, "movido", current.status, status, `Movido de ${LIFE_STATUS_LABELS[current.status]} para ${LIFE_STATUS_LABELS[status]}.`);
  }
  return listLifeObjectives(userId);
}

function createLifeStep(userId, objectiveId, payload) {
  if (!lifeObjectiveById(userId, objectiveId, false)) throw new Error("Objetivo nao encontrado.");
  const title = String(payload.title || payload.titulo || "").trim().slice(0, 220);
  if (!title) throw new Error("Informe o passo.");
  const row = get("SELECT COALESCE(MAX(step_order), 0) AS max_order FROM life_objective_steps WHERE objective_id = ?", [objectiveId]);
  const result = run("INSERT INTO life_objective_steps (objective_id, title, completed, step_order, created_at, updated_at) VALUES (?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", [objectiveId, title, Number(row?.max_order || 0) + 1000]);
  addLifeHistory(objectiveId, "passo", "", "", `Passo adicionado: ${title}`);
  return get("SELECT * FROM life_objective_steps WHERE id = ?", [result.lastInsertRowid]);
}

function updateLifeStep(userId, objectiveId, stepId, payload) {
  if (!lifeObjectiveById(userId, objectiveId, false)) throw new Error("Objetivo nao encontrado.");
  const step = get("SELECT * FROM life_objective_steps WHERE id = ? AND objective_id = ?", [stepId, objectiveId]);
  if (!step) throw new Error("Passo nao encontrado.");
  const title = String(payload.title ?? step.title).trim().slice(0, 220);
  const completed = payload.completed === undefined ? Number(step.completed || 0) : Number(Boolean(payload.completed));
  run("UPDATE life_objective_steps SET title = ?, completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND objective_id = ?", [title, completed, stepId, objectiveId]);
  return get("SELECT * FROM life_objective_steps WHERE id = ?", [stepId]);
}

function deleteLifeStep(userId, objectiveId, stepId) {
  if (!lifeObjectiveById(userId, objectiveId, false)) throw new Error("Objetivo nao encontrado.");
  run("DELETE FROM life_objective_steps WHERE id = ? AND objective_id = ?", [stepId, objectiveId]);
  return { ok: true };
}

function normalizePasswordVaultPayload(payload) {
  return {
    name: String(payload.name || payload.title || payload.uri || "Senha sem nome").trim().slice(0, 240),
    username: String(payload.username || "").trim().slice(0, 320),
    uri: String(payload.uri || payload.url || "").trim().slice(0, 800),
    folder: String(payload.folder || "").trim().slice(0, 240),
    notes: String(payload.notes || "").trim(),
    tags: String(payload.tags || "").trim().slice(0, 320),
    source: String(payload.source || "manual").trim().slice(0, 80),
    favorite: payload.favorite ? 1 : 0,
    password: String(payload.password || ""),
    totp: String(payload.totp || ""),
    raw: payload.raw ? (typeof payload.raw === "string" ? payload.raw : JSON.stringify(payload.raw)) : ""
  };
}

function insertPasswordVaultItem(payload) {
  const item = normalizePasswordVaultPayload(payload);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO password_vault_items
      (name, username, uri, folder, notes, tags, source, favorite, encrypted_password, encrypted_totp, raw_encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    encryptVaultText(item.name),
    encryptVaultText(item.username),
    encryptVaultText(item.uri),
    encryptVaultText(item.folder),
    encryptVaultText(item.notes),
    encryptVaultText(item.tags),
    item.source,
    item.favorite,
    encryptVaultText(item.password),
    encryptVaultText(item.totp),
    encryptVaultText(item.raw),
    now,
    now
  ]);
  return safePasswordVaultItem(get("SELECT * FROM password_vault_items WHERE id = ?", [result.lastInsertRowid]));
}

const GOOGLE_STATUSES = ["Ativa", "Inativa", "Perdida", "Bloqueada", "Arquivada"];
const GOOGLE_USES = ["Gmail", "Drive", "Fotos", "YouTube", "Play Store", "Android", "Projetos", "Outros"];
const GOOGLE_2FA_TYPES = ["", "SMS", "Authenticator", "Chave fisica", "Outro"];
const GOOGLE_RISK_LEVELS = ["Baixo", "Medio", "Alto"];
const GOOGLE_SERVICES = ["Gmail", "Drive", "Google Fotos", "YouTube", "Play Store", "Android", "Projetos", "Outros"];

function normalizeChoice(value, allowed, fallback) {
  const text = String(value || "").trim();
  return allowed.includes(text) ? text : fallback;
}

function normalizeBoolFlag(value, fallback = 0) {
  if (value === undefined || value === null) return Number(fallback || 0) ? 1 : 0;
  return value === true || value === "1" || value === "Sim" || value === 1 ? 1 : 0;
}

function normalizeGoogleServices(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,\n;|]/);
  return [...new Set(list.map((item) => String(item || "").trim()).filter((item) => GOOGLE_SERVICES.includes(item)))];
}

function dateAgeDays(value) {
  if (!value) return Infinity;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return Infinity;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function googleAccountFlags(item) {
  const semRecuperacao = !item.email_recuperacao && !item.telefone_recuperacao;
  const sem2fa = !Number(item.dois_fatores_ativo || 0);
  const incompleto = !item.nome_conta || !item.data_criacao || !item.uso_principal || semRecuperacao || sem2fa || !item.ultima_revisao;
  const precisaRevisar = !item.ultima_revisao || dateAgeDays(item.ultima_revisao) > 180;
  return {
    sem_2fa: sem2fa,
    sem_recuperacao: semRecuperacao,
    cadastro_incompleto: incompleto,
    precisa_revisar: precisaRevisar,
    segura: !sem2fa && !semRecuperacao && !precisaRevisar && String(item.nivel_risco || "") === "Baixo"
  };
}

function normalizeGooglePayload(payload = {}, fallback = {}) {
  const email = String(payload.email ?? fallback.email ?? "").trim().toLocaleLowerCase("pt-BR").slice(0, 320);
  const services = normalizeGoogleServices(payload.servicos_usados ?? fallback.servicos_usados);
  return {
    nome_conta: String(payload.nome_conta ?? fallback.nome_conta ?? "").trim().slice(0, 240),
    email,
    password: String(payload.password ?? payload.senha ?? ""),
    data_criacao: String(payload.data_criacao ?? fallback.data_criacao ?? "").slice(0, 10),
    status: normalizeChoice(payload.status ?? fallback.status, GOOGLE_STATUSES, "Ativa"),
    uso_principal: normalizeChoice(payload.uso_principal ?? fallback.uso_principal, GOOGLE_USES, "Outros"),
    email_recuperacao: String(payload.email_recuperacao ?? fallback.email_recuperacao ?? "").trim().slice(0, 320),
    telefone_recuperacao: String(payload.telefone_recuperacao ?? fallback.telefone_recuperacao ?? "").trim().slice(0, 80),
    dois_fatores_ativo: normalizeBoolFlag(payload.dois_fatores_ativo, fallback.dois_fatores_ativo),
    tipo_dois_fatores: normalizeChoice(payload.tipo_dois_fatores ?? fallback.tipo_dois_fatores, GOOGLE_2FA_TYPES, ""),
    ultima_troca_senha: String(payload.ultima_troca_senha ?? fallback.ultima_troca_senha ?? "").slice(0, 10),
    ultima_revisao: String(payload.ultima_revisao ?? fallback.ultima_revisao ?? "").slice(0, 10),
    codigos_backup: String(payload.codigos_backup ?? payload.codigos_backup_criptografados ?? fallback.codigos_backup ?? "").trim(),
    observacoes_recuperacao: String(payload.observacoes_recuperacao ?? fallback.observacoes_recuperacao ?? "").trim(),
    observacoes: String(payload.observacoes ?? fallback.observacoes ?? "").trim(),
    servicos_usados: services,
    senha_repetida: normalizeBoolFlag(payload.senha_repetida, fallback.senha_repetida),
    nivel_risco: normalizeChoice(payload.nivel_risco ?? fallback.nivel_risco, GOOGLE_RISK_LEVELS, "Medio"),
    arquivado: payload.arquivado === true || payload.arquivado === "1" || payload.arquivado === 1 || payload.status === "Arquivada" ? 1 : Number(fallback.arquivado || 0)
  };
}

function safeGoogleAccount(row, includeSecretFields = false) {
  const item = {
    id: row.id,
    nome_conta: row.nome_conta || "",
    email: row.email || "",
    senha_mascarada: "••••••••",
    has_password: Boolean(row.senha_criptografada),
    data_criacao: row.data_criacao || "",
    status: row.status || "Ativa",
    uso_principal: row.uso_principal || "Outros",
    email_recuperacao: row.email_recuperacao || "",
    telefone_recuperacao: row.telefone_recuperacao || "",
    dois_fatores_ativo: Number(row.dois_fatores_ativo || 0),
    tipo_dois_fatores: row.tipo_dois_fatores || "",
    ultima_troca_senha: row.ultima_troca_senha || "",
    ultima_revisao: row.ultima_revisao || "",
    codigos_backup_mascarados: row.codigos_backup_criptografados ? "••••••••" : "",
    observacoes_recuperacao: row.observacoes_recuperacao || "",
    observacoes: row.observacoes || "",
    servicos_usados: normalizeGoogleServices(row.servicos_usados),
    senha_repetida: Number(row.senha_repetida || 0),
    nivel_risco: row.nivel_risco || "Medio",
    criado_em: row.criado_em,
    atualizado_em: row.atualizado_em,
    arquivado: Number(row.arquivado || 0)
  };
  Object.assign(item, googleAccountFlags(item));
  if (includeSecretFields) item.codigos_backup = decryptVaultText(row.codigos_backup_criptografados);
  return item;
}

function googleAccountById(userId, id) {
  const row = get("SELECT * FROM google_accounts WHERE user_id = ? AND id = ?", [userId, id]);
  if (!row) {
    const error = new Error("Conta Google nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return row;
}

function googleDashboard(userId) {
  const rows = all("SELECT * FROM google_accounts WHERE user_id = ? ORDER BY atualizado_em DESC, id DESC", [userId]).map((row) => safeGoogleAccount(row));
  return {
    total: rows.length,
    active: rows.filter((item) => item.status === "Ativa" && !item.arquivado).length,
    no_2fa: rows.filter((item) => item.sem_2fa && !item.arquivado).length,
    no_recovery: rows.filter((item) => item.sem_recuperacao && !item.arquivado).length,
    incomplete: rows.filter((item) => item.cadastro_incompleto && !item.arquivado).length,
    review: rows.filter((item) => item.precisa_revisar && !item.arquivado).length
  };
}

function listGoogleAccounts(userId, query) {
  const filter = String(query.get("filter") || "all");
  const search = String(query.get("search") || "").trim().toLocaleLowerCase("pt-BR");
  let rows = all("SELECT * FROM google_accounts WHERE user_id = ? ORDER BY atualizado_em DESC, id DESC", [userId]).map((row) => safeGoogleAccount(row));
  rows = rows.filter((item) => {
    if (filter === "active" && (item.status !== "Ativa" || item.arquivado)) return false;
    if (filter === "inactive" && item.status !== "Inativa") return false;
    if (filter === "archived" && !item.arquivado && item.status !== "Arquivada") return false;
    if (filter === "no_2fa" && !item.sem_2fa) return false;
    if (filter === "no_recovery" && !item.sem_recuperacao) return false;
    if (filter === "incomplete" && !item.cadastro_incompleto) return false;
    if (filter === "review" && !item.precisa_revisar) return false;
    if (filter === "all" && item.arquivado) return false;
    if (!search) return true;
    return [item.nome_conta, item.email, item.status, item.uso_principal, item.email_recuperacao, item.telefone_recuperacao, item.observacoes]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
  });
  return { items: rows, summary: googleDashboard(userId), filter, options: { statuses: GOOGLE_STATUSES, uses: GOOGLE_USES, two_factor_types: GOOGLE_2FA_TYPES, risk_levels: GOOGLE_RISK_LEVELS, services: GOOGLE_SERVICES } };
}

function createGoogleAccount(userId, payload) {
  const item = normalizeGooglePayload(payload);
  if (!item.email) {
    const error = new Error("Informe o e-mail da conta Google.");
    error.statusCode = 400;
    throw error;
  }
  if (!item.password) {
    const error = new Error("Informe a senha da conta Google.");
    error.statusCode = 400;
    throw error;
  }
  const now = currentDateTime();
  const result = run(`
    INSERT INTO google_accounts
      (user_id, nome_conta, email, senha_criptografada, data_criacao, status, uso_principal, email_recuperacao, telefone_recuperacao, dois_fatores_ativo, tipo_dois_fatores, ultima_troca_senha, ultima_revisao, codigos_backup_criptografados, observacoes_recuperacao, observacoes, servicos_usados, senha_repetida, nivel_risco, arquivado, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    userId, item.nome_conta, item.email, encryptVaultText(item.password), item.data_criacao, item.status, item.uso_principal,
    item.email_recuperacao, item.telefone_recuperacao, item.dois_fatores_ativo, item.tipo_dois_fatores, item.ultima_troca_senha,
    item.ultima_revisao, encryptVaultText(item.codigos_backup), item.observacoes_recuperacao, item.observacoes, JSON.stringify(item.servicos_usados),
    item.senha_repetida, item.nivel_risco, item.arquivado, now, now
  ]);
  return safeGoogleAccount(googleAccountById(userId, result.lastInsertRowid));
}

function updateGoogleAccount(userId, id, payload) {
  const row = googleAccountById(userId, id);
  const item = normalizeGooglePayload(payload, safeGoogleAccount(row, true));
  if (!item.email) {
    const error = new Error("Informe o e-mail da conta Google.");
    error.statusCode = 400;
    throw error;
  }
  const encryptedPassword = item.password ? encryptVaultText(item.password) : row.senha_criptografada;
  const encryptedBackupCodes = Object.prototype.hasOwnProperty.call(payload, "codigos_backup") ? encryptVaultText(item.codigos_backup) : row.codigos_backup_criptografados;
  run(`
    UPDATE google_accounts
    SET nome_conta = ?, email = ?, senha_criptografada = ?, data_criacao = ?, status = ?, uso_principal = ?,
        email_recuperacao = ?, telefone_recuperacao = ?, dois_fatores_ativo = ?, tipo_dois_fatores = ?,
        ultima_troca_senha = ?, ultima_revisao = ?, codigos_backup_criptografados = ?, observacoes_recuperacao = ?,
        observacoes = ?, servicos_usados = ?, senha_repetida = ?, nivel_risco = ?, arquivado = ?, atualizado_em = ?
    WHERE user_id = ? AND id = ?
  `, [
    item.nome_conta, item.email, encryptedPassword, item.data_criacao, item.status, item.uso_principal,
    item.email_recuperacao, item.telefone_recuperacao, item.dois_fatores_ativo, item.tipo_dois_fatores,
    item.ultima_troca_senha, item.ultima_revisao, encryptedBackupCodes, item.observacoes_recuperacao,
    item.observacoes, JSON.stringify(item.servicos_usados), item.senha_repetida, item.nivel_risco, item.arquivado,
    currentDateTime(), userId, id
  ]);
  return safeGoogleAccount(googleAccountById(userId, id));
}

const INSTAGRAM_STATUSES = ["Ativa", "Inativa", "Arquivada", "Bloqueada"];
const INSTAGRAM_ACCOUNT_TYPES = ["Pessoal", "Comercial", "Projeto", "Backup", "Cliente", "Outro"];

function normalizeInstagramUsername(value) {
  return String(value || "").trim().replace(/^@+/, "").slice(0, 80);
}

function normalizeInstagramCounter(value, fallback = 0) {
  const parsed = Number(String(value ?? fallback ?? 0).replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function normalizeInstagramPayload(payload = {}, fallback = {}) {
  const status = normalizeChoice(payload.status ?? fallback.status, INSTAGRAM_STATUSES, "Ativa");
  const avatar = String(payload.avatar ?? fallback.avatar ?? "").trim();
  return {
    nome: String(payload.nome ?? fallback.nome ?? "").trim().slice(0, 180),
    usuario: normalizeInstagramUsername(payload.usuario ?? fallback.usuario),
    link_perfil: String(payload.link_perfil ?? fallback.link_perfil ?? "").trim().slice(0, 600),
    email_login: String(payload.email_login ?? fallback.email_login ?? "").trim().slice(0, 320),
    password: String(payload.password ?? payload.senha ?? ""),
    telefone: String(payload.telefone ?? fallback.telefone ?? "").trim().slice(0, 80),
    email_recuperacao: String(payload.email_recuperacao ?? fallback.email_recuperacao ?? "").trim().slice(0, 320),
    codigo_2fa_text: String(payload.codigo_2fa_text ?? payload.codigo_2fa ?? ""),
    tipo_conta: normalizeChoice(payload.tipo_conta ?? fallback.tipo_conta, INSTAGRAM_ACCOUNT_TYPES, "Pessoal"),
    status,
    dois_fatores_ativo: normalizeBoolFlag(payload.dois_fatores_ativo, fallback.dois_fatores_ativo),
    seguidores: normalizeInstagramCounter(payload.seguidores, fallback.seguidores),
    seguindo: normalizeInstagramCounter(payload.seguindo, fallback.seguindo),
    avatar: avatar.slice(0, 2500000),
    data_criacao_conta: String(payload.data_criacao_conta ?? fallback.data_criacao_conta ?? "").slice(0, 10),
    ultimo_acesso: String(payload.ultimo_acesso ?? fallback.ultimo_acesso ?? "").slice(0, 10),
    observacoes: String(payload.observacoes ?? fallback.observacoes ?? "").trim().slice(0, 10000)
  };
}

function safeInstagramAccount(row) {
  return {
    id: Number(row.id),
    nome: row.nome || "",
    usuario: row.usuario || "",
    link_perfil: row.link_perfil || "",
    email_login: row.email_login || "",
    senha_mascarada: row.senha_criptografada ? "••••••••••" : "",
    has_password: Boolean(row.senha_criptografada),
    telefone: row.telefone || "",
    email_recuperacao: row.email_recuperacao || "",
    codigo_2fa_mascarado: row.codigo_2fa ? "••••••••" : "",
    has_2fa_backup: Boolean(row.codigo_2fa),
    tipo_conta: row.tipo_conta || "Pessoal",
    status: row.status || "Ativa",
    dois_fatores_ativo: Number(row.dois_fatores_ativo || 0),
    seguidores: Number(row.seguidores || 0),
    seguindo: Number(row.seguindo || 0),
    avatar: row.avatar || "",
    data_criacao_conta: row.data_criacao_conta || "",
    ultimo_acesso: row.ultimo_acesso || "",
    observacoes: row.observacoes || "",
    criado_em: row.criado_em || "",
    atualizado_em: row.atualizado_em || ""
  };
}

function instagramAccountById(userId, id) {
  const row = get("SELECT * FROM instagram_accounts WHERE user_id = ? AND id = ?", [userId, id]);
  if (!row) {
    const error = new Error("Conta Instagram nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return row;
}

function instagramSummary(userId) {
  const rows = all("SELECT status, dois_fatores_ativo, seguidores, seguindo FROM instagram_accounts WHERE user_id = ?", [userId]);
  return {
    total: rows.length,
    active: rows.filter((item) => item.status === "Ativa").length,
    inactive_archived: rows.filter((item) => item.status === "Inativa" || item.status === "Arquivada").length,
    with_2fa: rows.filter((item) => Number(item.dois_fatores_ativo || 0)).length,
    total_followers: rows.reduce((sum, item) => sum + Number(item.seguidores || 0), 0),
    total_following: rows.reduce((sum, item) => sum + Number(item.seguindo || 0), 0)
  };
}

function listInstagramAccounts(userId, query) {
  const filter = String(query.get("filter") || "all");
  const type = String(query.get("type") || "all");
  const search = String(query.get("search") || "").trim().toLocaleLowerCase("pt-BR");
  let items = all("SELECT * FROM instagram_accounts WHERE user_id = ? ORDER BY atualizado_em DESC, id DESC", [userId]).map(safeInstagramAccount);
  items = items.filter((item) => {
    if (filter === "active" && item.status !== "Ativa") return false;
    if (filter === "inactive" && item.status !== "Inativa") return false;
    if (filter === "archived" && item.status !== "Arquivada") return false;
    if (filter === "without_2fa" && item.dois_fatores_ativo) return false;
    if (filter === "with_2fa" && !item.dois_fatores_ativo) return false;
    if (type !== "all" && item.tipo_conta !== type) return false;
    if (!search) return true;
    return [item.nome, item.usuario, item.email_login, item.telefone, item.status, item.tipo_conta, item.observacoes]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
  });
  return {
    items,
    summary: instagramSummary(userId),
    options: { statuses: INSTAGRAM_STATUSES, account_types: INSTAGRAM_ACCOUNT_TYPES }
  };
}

function createInstagramAccount(userId, payload) {
  const item = normalizeInstagramPayload(payload);
  if (!item.nome || !item.usuario) {
    const error = new Error("Informe o nome e o usuario da conta Instagram.");
    error.statusCode = 400;
    throw error;
  }
  const now = currentDateTime();
  const result = run(`
    INSERT INTO instagram_accounts
      (user_id, nome, usuario, link_perfil, email_login, senha_criptografada, telefone, email_recuperacao, codigo_2fa, tipo_conta, status, dois_fatores_ativo, seguidores, seguindo, avatar, data_criacao_conta, ultimo_acesso, observacoes, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    userId, item.nome, item.usuario, item.link_perfil, item.email_login, encryptVaultText(item.password), item.telefone,
    item.email_recuperacao, encryptVaultText(item.codigo_2fa_text), item.tipo_conta, item.status, item.dois_fatores_ativo,
    item.seguidores, item.seguindo, item.avatar, item.data_criacao_conta, item.ultimo_acesso, item.observacoes, now, now
  ]);
  return safeInstagramAccount(instagramAccountById(userId, result.lastInsertRowid));
}

function updateInstagramAccount(userId, id, payload) {
  const row = instagramAccountById(userId, id);
  const item = normalizeInstagramPayload(payload, safeInstagramAccount(row));
  if (!item.nome || !item.usuario) {
    const error = new Error("Informe o nome e o usuario da conta Instagram.");
    error.statusCode = 400;
    throw error;
  }
  const encryptedPassword = Object.prototype.hasOwnProperty.call(payload, "password") || Object.prototype.hasOwnProperty.call(payload, "senha")
    ? encryptVaultText(item.password)
    : row.senha_criptografada;
  const encrypted2fa = Object.prototype.hasOwnProperty.call(payload, "codigo_2fa_text") || Object.prototype.hasOwnProperty.call(payload, "codigo_2fa")
    ? encryptVaultText(item.codigo_2fa_text)
    : row.codigo_2fa;
  run(`
    UPDATE instagram_accounts
    SET nome = ?, usuario = ?, link_perfil = ?, email_login = ?, senha_criptografada = ?, telefone = ?,
        email_recuperacao = ?, codigo_2fa = ?, tipo_conta = ?, status = ?, dois_fatores_ativo = ?, avatar = ?,
        seguidores = ?, seguindo = ?, data_criacao_conta = ?, ultimo_acesso = ?, observacoes = ?, atualizado_em = ?
    WHERE user_id = ? AND id = ?
  `, [
    item.nome, item.usuario, item.link_perfil, item.email_login, encryptedPassword, item.telefone, item.email_recuperacao,
    encrypted2fa, item.tipo_conta, item.status, item.dois_fatores_ativo, item.avatar, item.seguidores, item.seguindo,
    item.data_criacao_conta, item.ultimo_acesso, item.observacoes, currentDateTime(), userId, id
  ]);
  return safeInstagramAccount(instagramAccountById(userId, id));
}

const TWOFA_STEAM_TYPES = ["Principal", "Secundaria", "Farm", "Trade", "Jogos", "Skin", "Outro"];
const TWOFA_STEAM_STATUSES = ["Ativa", "Inativa", "Banida", "Limitada", "Recuperacao"];
const STEAM_GUARD_CHARS = "23456789BCDFGHJKMNPQRTVWXY";

function twofaSettings(userId) {
  return get("SELECT * FROM twofa_vault_settings WHERE user_id = ?", [userId]);
}

function deriveTwofaKey(masterPassword, saltHex) {
  return scryptSync(String(masterPassword || ""), Buffer.from(saltHex, "hex"), 32);
}

function encryptTwofaText(value, key) {
  const text = String(value ?? "");
  if (!text) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
}

function decryptTwofaText(value, key) {
  if (!value) return "";
  const payload = JSON.parse(value);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

function normalizeTwofaSteamPayload(payload = {}, fallback = {}) {
  const login = String(payload.steam_login ?? fallback.steam_login ?? "").trim().slice(0, 180);
  const nickname = String(payload.name ?? payload.nickname ?? fallback.nickname ?? login ?? "Conta Steam").trim().slice(0, 180);
  return {
    nickname,
    steam_login: login,
    steam_password: String(payload.steam_password ?? payload.password ?? ""),
    email: String(payload.email ?? fallback.email ?? "").trim().slice(0, 320),
    email_password: String(payload.email_password ?? ""),
    phone: String(payload.phone ?? fallback.phone ?? "").trim().slice(0, 80),
    account_created_at: String(payload.account_created_at ?? fallback.account_created_at ?? "").slice(0, 10),
    account_type: normalizeChoice(payload.account_type ?? fallback.account_type, TWOFA_STEAM_TYPES, "Outro"),
    account_status: normalizeChoice(payload.account_status ?? fallback.account_status, TWOFA_STEAM_STATUSES, "Ativa"),
    steam_guard_enabled: normalizeBoolFlag(payload.steam_guard_enabled, fallback.steam_guard_enabled),
    shared_secret: String(payload.shared_secret ?? "").trim(),
    backup_codes: String(payload.backup_codes ?? "").trim(),
    inventory_estimated_value: Number(payload.inventory_estimated_value ?? fallback.inventory_estimated_value ?? 0) || 0,
    last_login_at: String(payload.last_login_at ?? fallback.last_login_at ?? "").slice(0, 16),
    notes: String(payload.notes ?? fallback.notes ?? "").trim()
  };
}

function safeTwofaSteamAccount(row) {
  const inventoryValue = Number(row.inventory_estimated_value || 0) || Number(row.inventory_value || 0) || 0;
  return {
    id: row.id,
    name: row.nickname || row.persona_name || "Conta Steam",
    nickname: row.nickname || "",
    steam_login: row.steam_login || "",
    email: row.email || "",
    phone: row.phone || "",
    account_created_at: row.account_created_at || "",
    account_type: row.account_type || "Outro",
    account_status: row.account_status || (Number(row.is_active || 0) ? "Ativa" : "Inativa"),
    steam_guard_enabled: Number(row.steam_guard_enabled || 0),
    has_steam_password: Boolean(row.encrypted_steam_password),
    has_email_password: Boolean(row.encrypted_email_password),
    has_shared_secret: Boolean(row.encrypted_shared_secret),
    has_backup_codes: Boolean(row.encrypted_backup_codes),
    inventory_estimated_value: inventoryValue,
    last_login_at: row.last_login_at || "",
    notes: row.notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function twofaSteamRows(userId) {
  return all(`
    SELECT steam_accounts.*,
      COALESCE(SUM(steam_inventory_items.quantity * steam_inventory_items.estimated_price), 0) AS inventory_value
    FROM steam_accounts
    LEFT JOIN steam_inventory_items ON steam_inventory_items.steam_account_id = steam_accounts.id
    WHERE steam_accounts.user_id = ?
    GROUP BY steam_accounts.id
    ORDER BY steam_accounts.updated_at DESC, steam_accounts.id DESC
  `, [userId]).map(safeTwofaSteamAccount);
}

function listTwofaSteam(userId, query) {
  const search = String(query.get("search") || "").trim().toLocaleLowerCase("pt-BR");
  const type = String(query.get("type") || "");
  const guard = String(query.get("guard") || "");
  let items = twofaSteamRows(userId).filter((item) => {
    if (type && item.account_type !== type) return false;
    if (guard === "enabled" && !item.steam_guard_enabled) return false;
    if (guard === "disabled" && item.steam_guard_enabled) return false;
    if (!search) return true;
    return [item.name, item.steam_login, item.email].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
  });
  const allItems = twofaSteamRows(userId);
  return {
    unlocked: true,
    items,
    summary: {
      total: allItems.length,
      guard_enabled: allItems.filter((item) => item.steam_guard_enabled).length,
      guard_pending: allItems.filter((item) => !item.steam_guard_enabled).length,
      inventory_total: allItems.reduce((sum, item) => sum + Number(item.inventory_estimated_value || 0), 0),
      principal: allItems.filter((item) => item.account_type === "Principal").length,
      farm: allItems.filter((item) => item.account_type === "Farm").length,
      trade: allItems.filter((item) => item.account_type === "Trade").length
    },
    options: { types: TWOFA_STEAM_TYPES, statuses: TWOFA_STEAM_STATUSES }
  };
}

function twofaSteamById(userId, id) {
  const row = get("SELECT * FROM steam_accounts WHERE user_id = ? AND id = ?", [userId, id]);
  if (!row) {
    const error = new Error("Conta Steam nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return row;
}

function createTwofaSteam(userId, payload, key) {
  const item = normalizeTwofaSteamPayload(payload);
  if (!item.steam_login) {
    const error = new Error("Informe o login Steam.");
    error.statusCode = 400;
    throw error;
  }
  const steamId = String(payload.steam_id || `cofre2fa:${userId}:${item.steam_login}`).slice(0, 120);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO steam_accounts
      (user_id, nickname, steam_id, steam_login, encrypted_steam_password, email, encrypted_email_password, phone, account_created_at, account_type, account_status, steam_guard_enabled, encrypted_shared_secret, encrypted_backup_codes, inventory_estimated_value, last_login_at, notes, is_active, sync_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    userId, item.nickname, steamId, item.steam_login, encryptTwofaText(item.steam_password, key), item.email, encryptTwofaText(item.email_password, key),
    item.phone, item.account_created_at, item.account_type, item.account_status, item.steam_guard_enabled, encryptTwofaText(item.shared_secret, key),
    encryptTwofaText(item.backup_codes, key), item.inventory_estimated_value, item.last_login_at, item.notes, item.account_status === "Ativa" ? 1 : 0,
    "Cadastrada pelo Cofre 2FA", now, now
  ]);
  return safeTwofaSteamAccount(twofaSteamById(userId, result.lastInsertRowid));
}

function updateTwofaSteam(userId, id, payload, key) {
  const row = twofaSteamById(userId, id);
  const item = normalizeTwofaSteamPayload(payload, row);
  const encryptedSteamPassword = item.steam_password ? encryptTwofaText(item.steam_password, key) : row.encrypted_steam_password;
  const encryptedEmailPassword = item.email_password ? encryptTwofaText(item.email_password, key) : row.encrypted_email_password;
  const encryptedSharedSecret = Object.prototype.hasOwnProperty.call(payload, "shared_secret") && item.shared_secret ? encryptTwofaText(item.shared_secret, key) : row.encrypted_shared_secret;
  const encryptedBackupCodes = Object.prototype.hasOwnProperty.call(payload, "backup_codes") && item.backup_codes ? encryptTwofaText(item.backup_codes, key) : row.encrypted_backup_codes;
  run(`
    UPDATE steam_accounts
    SET nickname = ?, steam_login = ?, encrypted_steam_password = ?, email = ?, encrypted_email_password = ?, phone = ?,
        account_created_at = ?, account_type = ?, account_status = ?, steam_guard_enabled = ?, encrypted_shared_secret = ?,
        encrypted_backup_codes = ?, inventory_estimated_value = ?, last_login_at = ?, notes = ?, is_active = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `, [
    item.nickname, item.steam_login, encryptedSteamPassword, item.email, encryptedEmailPassword, item.phone, item.account_created_at,
    item.account_type, item.account_status, item.steam_guard_enabled, encryptedSharedSecret, encryptedBackupCodes, item.inventory_estimated_value,
    item.last_login_at, item.notes, item.account_status === "Ativa" ? 1 : 0, currentDateTime(), userId, id
  ]);
  return safeTwofaSteamAccount(twofaSteamById(userId, id));
}

function twofaSteamSecrets(row, key) {
  return {
    steam_password: decryptTwofaText(row.encrypted_steam_password, key),
    email_password: decryptTwofaText(row.encrypted_email_password, key),
    shared_secret: decryptTwofaText(row.encrypted_shared_secret, key),
    backup_codes: decryptTwofaText(row.encrypted_backup_codes, key)
  };
}

function steamGuardCode(sharedSecret, now = Math.floor(Date.now() / 1000)) {
  if (!sharedSecret) return null;
  const secret = Buffer.from(sharedSecret, "base64");
  const time = Buffer.alloc(8);
  time.writeUInt32BE(Math.floor(now / 30), 4);
  const hmac = createHmac("sha1", secret).update(time).digest();
  const start = hmac[19] & 0x0f;
  let codeInt = hmac.readUInt32BE(start) & 0x7fffffff;
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += STEAM_GUARD_CHARS[codeInt % STEAM_GUARD_CHARS.length];
    codeInt = Math.floor(codeInt / STEAM_GUARD_CHARS.length);
  }
  return { code, expires_in: 30 - (now % 30), generated_at: currentDateTime() };
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  const bytes = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      bytes.push(parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }
  return Buffer.from(bytes);
}

function normalizeTotpSecret(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("otpauth://")) {
    const parsed = new URL(raw);
    return String(parsed.searchParams.get("secret") || "").trim();
  }
  return raw;
}

function totpCode(secretValue, options = {}, now = Math.floor(Date.now() / 1000)) {
  const period = Math.max(10, Number(options.period || 30));
  const digits = Math.max(6, Math.min(8, Number(options.digits || 6)));
  const algorithm = String(options.algorithm || "SHA1").toLowerCase().replace("-", "");
  const secret = base32Decode(normalizeTotpSecret(secretValue));
  if (!secret.length) {
    const error = new Error("Secret TOTP invalido.");
    error.statusCode = 400;
    throw error;
  }
  const counter = Math.floor(now / period);
  const time = Buffer.alloc(8);
  time.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  time.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac(algorithm, secret).update(time).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  const code = String(binary % (10 ** digits)).padStart(digits, "0");
  return { code, expires_in: period - (now % period), generated_at: currentDateTime() };
}

function safeTotpItem(row) {
  return {
    id: row.id,
    provider: row.provider || "google",
    service_name: row.service_name || "",
    account_label: row.account_label || "",
    issuer: row.issuer || "",
    has_secret: Boolean(row.encrypted_secret),
    digits: Number(row.digits || 6),
    period: Number(row.period || 30),
    algorithm: row.algorithm || "SHA1",
    notes: row.notes || "",
    favorite: Number(row.favorite || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function listTotpItems(userId, provider = "google") {
  const rows = all("SELECT * FROM twofa_totp_items WHERE user_id = ? AND provider = ? ORDER BY favorite DESC, service_name, account_label", [userId, provider]).map(safeTotpItem);
  return { items: rows, summary: { total: rows.length, favorites: rows.filter((item) => item.favorite).length } };
}

function normalizeTotpPayload(payload = {}, fallback = {}) {
  return {
    provider: String(payload.provider || fallback.provider || "google").trim().slice(0, 40),
    service_name: String(payload.service_name ?? fallback.service_name ?? "Google").trim().slice(0, 160) || "Google",
    account_label: String(payload.account_label ?? fallback.account_label ?? "").trim().slice(0, 220),
    issuer: String(payload.issuer ?? fallback.issuer ?? "Google").trim().slice(0, 120),
    secret: normalizeTotpSecret(payload.secret ?? ""),
    digits: Number(payload.digits ?? fallback.digits ?? 6) || 6,
    period: Number(payload.period ?? fallback.period ?? 30) || 30,
    algorithm: String(payload.algorithm ?? fallback.algorithm ?? "SHA1").trim().toUpperCase() || "SHA1",
    notes: String(payload.notes ?? fallback.notes ?? "").trim(),
    favorite: normalizeBoolFlag(payload.favorite, fallback.favorite)
  };
}

function totpById(userId, id) {
  const row = get("SELECT * FROM twofa_totp_items WHERE user_id = ? AND id = ?", [userId, id]);
  if (!row) {
    const error = new Error("Autenticador nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
  return row;
}

function createTotpItem(userId, payload, key) {
  const item = normalizeTotpPayload(payload);
  if (!item.secret) {
    const error = new Error("Informe a chave secreta do autenticador.");
    error.statusCode = 400;
    throw error;
  }
  totpCode(item.secret, item);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO twofa_totp_items
      (user_id, provider, service_name, account_label, issuer, encrypted_secret, digits, period, algorithm, notes, favorite, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, item.provider, item.service_name, item.account_label, item.issuer, encryptTwofaText(item.secret, key), item.digits, item.period, item.algorithm, item.notes, item.favorite, now, now]);
  return safeTotpItem(totpById(userId, result.lastInsertRowid));
}

function updateTotpItem(userId, id, payload, key) {
  const row = totpById(userId, id);
  const item = normalizeTotpPayload(payload, row);
  const encryptedSecret = item.secret ? encryptTwofaText(item.secret, key) : row.encrypted_secret;
  if (item.secret) totpCode(item.secret, item);
  run(`
    UPDATE twofa_totp_items
    SET service_name = ?, account_label = ?, issuer = ?, encrypted_secret = ?, digits = ?, period = ?, algorithm = ?, notes = ?, favorite = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `, [item.service_name, item.account_label, item.issuer, encryptedSecret, item.digits, item.period, item.algorithm, item.notes, item.favorite, currentDateTime(), userId, id]);
  return safeTotpItem(totpById(userId, id));
}

function databaseTableInfo(tableName) {
  const columns = all(`PRAGMA table_info(${quoteIdentifier(tableName)})`).map((column) => ({
    name: column.name,
    type: column.type || "TEXT",
    required: Number(column.notnull || 0) === 1,
    primary: Number(column.pk || 0) === 1
  }));
  const count = get(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).count;
  const updatedColumn = columns.find((column) => column.name === "updated_at") ? "updated_at" : columns.find((column) => column.name === "created_at") ? "created_at" : "id";
  return { name: tableName, columns, count, updatedColumn };
}

function safeDatabaseRow(row) {
  const copy = { ...row };
  if (copy.password_hash) copy.password_hash = "[protegido]";
  if (copy.name && row.encrypted_password) copy.name = "[cofre criptografado]";
  if (copy.username) copy.username = "[cofre criptografado]";
  if (copy.uri) copy.uri = "[cofre criptografado]";
  if (copy.folder) copy.folder = "[cofre criptografado]";
  if (copy.notes) copy.notes = "[cofre criptografado]";
  if (copy.tags) copy.tags = "[cofre criptografado]";
  if (copy.encrypted_password) copy.encrypted_password = "[cofre criptografado]";
  if (copy.encrypted_totp) copy.encrypted_totp = "[cofre criptografado]";
  if (copy.raw_encrypted) copy.raw_encrypted = "[cofre criptografado]";
  if (copy.encrypted_steam_password) copy.encrypted_steam_password = "[cofre 2FA criptografado]";
  if (copy.encrypted_email_password) copy.encrypted_email_password = "[cofre 2FA criptografado]";
  if (copy.encrypted_shared_secret) copy.encrypted_shared_secret = "[cofre 2FA criptografado]";
  if (copy.encrypted_backup_codes) copy.encrypted_backup_codes = "[cofre 2FA criptografado]";
  if (copy.encrypted_secret) copy.encrypted_secret = "[cofre 2FA criptografado]";
  if (copy.data && String(copy.data).length > 160) copy.data = `[conteudo protegido: ${String(copy.data).length} caracteres]`;
  if (copy.content && String(copy.content).length > 320) copy.content = `${String(copy.content).slice(0, 320)}...`;
  return copy;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored?.startsWith("scrypt:")) return false;
  const [, salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function cookie(req, name) {
  const header = req.headers.cookie || "";
  const found = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.split("=")[1]) : "";
}

function setSession(res, userId, keepConnected = false) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(token, { userId, keepConnected: Boolean(keepConnected), createdAt: now, lastActiveAt: now });
  const maxAge = keepConnected ? Math.floor(SESSION_REMEMBER_MS / 1000) : Math.floor(SESSION_IDLE_MS / 1000);
  res.setHeader("Set-Cookie", `drso_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function clearSession(req, res) {
  const token = cookie(req, "drso_session");
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "drso_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function currentSession(req) {
  const token = cookie(req, "drso_session");
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  const now = Date.now();
  if (!session.keepConnected && now - Number(session.lastActiveAt || session.createdAt || 0) > SESSION_IDLE_MS) {
    sessions.delete(token);
    return null;
  }
  if (session.keepConnected && now - Number(session.createdAt || 0) > SESSION_REMEMBER_MS) {
    sessions.delete(token);
    return null;
  }
  session.lastActiveAt = now;
  sessions.set(token, session);
  return session;
}

function currentUser(req) {
  const session = currentSession(req);
  if (!session) return null;
  return get("SELECT * FROM users WHERE id = ?", [session.userId]);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeKind(kind) {
  if (kind === "tipos") return "type";
  if (kind === "categorias") return "category";
  if (kind === "pagamentos") return "payment_method";
  return kind;
}

function catalogLabel(kind) {
  return kind === "type" ? "tipo" : kind === "category" ? "categoria" : "forma de pagamento";
}

function listCatalog(kind) {
  const normalized = normalizeKind(kind);
  return all("SELECT * FROM finance_catalog_items WHERE kind = ? ORDER BY name", [normalized]);
}

function recordTimeline(title, description, category) {
  const now = currentDateTime();
  run("INSERT INTO timeline_events (date, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
    now,
    title,
    description || "",
    category,
    now,
    now
  ]);
}

const NOTIFICATION_CATEGORIES = ["AGENDA", "TASK", "FINANCE", "BACKUP", "SECURITY", "PROJECT", "GOAL", "WISHLIST", "GALLERY", "MUSIC", "INTEGRATION", "SYSTEM", "OTHER"];
const NOTIFICATION_SEVERITIES = ["INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"];
const NOTIFICATION_MODULE_LABELS = {
  AGENDA: "Agenda",
  TASK: "Tarefas",
  FINANCE: "Financeiro",
  BACKUP: "Backup",
  SECURITY: "Seguranca",
  PROJECT: "Projetos",
  GOAL: "Objetivos",
  WISHLIST: "Lista de desejos",
  GALLERY: "Galeria",
  MUSIC: "Musicas",
  INTEGRATION: "Integracoes",
  SYSTEM: "Sistema",
  OTHER: "Outros"
};

function normalizeNotificationCategory(value) {
  const category = String(value || "OTHER").trim().toUpperCase();
  return NOTIFICATION_CATEGORIES.includes(category) ? category : "OTHER";
}

function normalizeNotificationSeverity(value) {
  const severity = String(value || "INFO").trim().toUpperCase();
  return NOTIFICATION_SEVERITIES.includes(severity) ? severity : "INFO";
}

function cleanNotificationText(value, max = 240) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}

function cleanNotificationActionUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("#")) return "";
  return raw.slice(0, 120);
}

function safeNotificationMetadata(value) {
  try {
    const data = value && typeof value === "object" ? value : {};
    const jsonText = JSON.stringify(data, (key, item) => {
      if (/password|senha|token|secret|cookie|key|chave/i.test(key)) return "[protegido]";
      if (typeof item === "string") return item.slice(0, 1000);
      return item;
    });
    return jsonText.slice(0, 6000);
  } catch {
    return "{}";
  }
}

function notificationRow(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || "{}"); } catch {}
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    message: row.message,
    category: row.category,
    severity: row.severity,
    sourceModule: row.source_module,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    actionUrl: row.action_url,
    primaryActionLabel: row.primary_action_label,
    secondaryActionLabel: row.secondary_action_label,
    metadata,
    isRead: Boolean(row.is_read),
    readAt: row.read_at,
    isPinned: Boolean(row.is_pinned),
    pinnedAt: row.pinned_at,
    isArchived: Boolean(row.is_archived),
    archivedAt: row.archived_at,
    snoozedUntil: row.snoozed_until,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

function ensureNotificationPreferences(userId) {
  const now = currentDateTime();
  for (const category of NOTIFICATION_CATEGORIES) {
    run(`INSERT OR IGNORE INTO notification_preferences
      (user_id, category, in_app_enabled, browser_enabled, sound_enabled, minimum_severity, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, critical_ignore_quiet_hours, created_at, updated_at)
      VALUES (?, ?, 1, 0, 0, 'INFO', 0, '22:00', '07:00', 0, ?, ?)`, [userId, category, now, now]);
  }
}

function notificationPreferences(userId) {
  ensureNotificationPreferences(userId);
  return all("SELECT * FROM notification_preferences WHERE user_id = ? ORDER BY category", [userId]).map((row) => ({
    category: row.category,
    label: NOTIFICATION_MODULE_LABELS[row.category] || row.category,
    inAppEnabled: Boolean(row.in_app_enabled),
    browserEnabled: Boolean(row.browser_enabled),
    soundEnabled: Boolean(row.sound_enabled),
    minimumSeverity: row.minimum_severity,
    quietHoursEnabled: Boolean(row.quiet_hours_enabled),
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    criticalIgnoreQuietHours: Boolean(row.critical_ignore_quiet_hours)
  }));
}

function isNotificationQuietTime(pref) {
  if (!pref?.quiet_hours_enabled) return false;
  const start = /^\d{2}:\d{2}$/.test(String(pref.quiet_hours_start || "")) ? pref.quiet_hours_start : "22:00";
  const end = /^\d{2}:\d{2}$/.test(String(pref.quiet_hours_end || "")) ? pref.quiet_hours_end : "07:00";
  const now = currentDateTime().slice(11, 16);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function notificationPreferenceAllows(userId, category, severity) {
  ensureNotificationPreferences(userId);
  const pref = get("SELECT * FROM notification_preferences WHERE user_id = ? AND category = ?", [userId, category]);
  if (!pref || !pref.in_app_enabled) return false;
  if (isNotificationQuietTime(pref) && !(severity === "CRITICAL" && pref.critical_ignore_quiet_hours)) return false;
  return NOTIFICATION_SEVERITIES.indexOf(severity) >= NOTIFICATION_SEVERITIES.indexOf(pref.minimum_severity || "INFO");
}

function createNotification(input = {}) {
  const userId = Number(input.userId || input.user_id || 0);
  if (!userId) throw new Error("Usuario da notificacao nao informado.");
  const category = normalizeNotificationCategory(input.category);
  const severity = normalizeNotificationSeverity(input.severity);
  if (!notificationPreferenceAllows(userId, category, severity)) return null;
  const now = currentDateTime();
  const title = cleanNotificationText(input.title, 140);
  if (!title) throw new Error("Titulo da notificacao nao informado.");
  const payload = {
    userId,
    title,
    message: cleanNotificationText(input.message, 700),
    category,
    severity,
    sourceModule: cleanNotificationText(input.sourceModule || input.source_module || NOTIFICATION_MODULE_LABELS[category] || "", 80),
    sourceEntityType: cleanNotificationText(input.sourceEntityType || input.source_entity_type || "", 80),
    sourceEntityId: cleanNotificationText(input.sourceEntityId || input.source_entity_id || "", 80),
    actionUrl: cleanNotificationActionUrl(input.actionUrl || input.action_url),
    primaryActionLabel: cleanNotificationText(input.primaryActionLabel || input.primary_action_label || "", 80),
    secondaryActionLabel: cleanNotificationText(input.secondaryActionLabel || input.secondary_action_label || "", 80),
    metadata: safeNotificationMetadata(input.metadata),
    dedupeKey: cleanNotificationText(input.dedupeKey || input.dedupe_key || "", 180),
    expiresAt: cleanNotificationText(input.expiresAt || input.expires_at || "", 30)
  };
  if (payload.dedupeKey) {
    const existing = get("SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?", [userId, payload.dedupeKey]);
    if (existing) {
      run(`UPDATE notifications
        SET title = ?, message = ?, category = ?, severity = ?, source_module = ?, source_entity_type = ?, source_entity_id = ?,
            action_url = ?, primary_action_label = ?, secondary_action_label = ?, metadata = ?, is_archived = 0, archived_at = NULL,
            expires_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`, [
        payload.title, payload.message, payload.category, payload.severity, payload.sourceModule, payload.sourceEntityType, payload.sourceEntityId,
        payload.actionUrl, payload.primaryActionLabel, payload.secondaryActionLabel, payload.metadata, payload.expiresAt || null, now, existing.id, userId
      ]);
      return notificationRow(get("SELECT * FROM notifications WHERE id = ? AND user_id = ?", [existing.id, userId]));
    }
  }
  const result = run(`INSERT INTO notifications
    (user_id, title, message, category, severity, source_module, source_entity_type, source_entity_id, action_url,
     primary_action_label, secondary_action_label, metadata, dedupe_key, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    userId, payload.title, payload.message, payload.category, payload.severity, payload.sourceModule, payload.sourceEntityType, payload.sourceEntityId,
    payload.actionUrl, payload.primaryActionLabel, payload.secondaryActionLabel, payload.metadata, payload.dedupeKey, now, now, payload.expiresAt || null
  ]);
  return notificationRow(get("SELECT * FROM notifications WHERE id = ? AND user_id = ?", [result.lastInsertRowid, userId]));
}

function unreadNotificationCount(userId) {
  createDueNotifications(userId);
  const now = currentDateTime();
  return Number(get(`SELECT COUNT(*) AS total FROM notifications
    WHERE user_id = ? AND is_read = 0 AND is_archived = 0
      AND (snoozed_until IS NULL OR snoozed_until = '' OR snoozed_until <= ?)
      AND (expires_at IS NULL OR expires_at = '' OR expires_at > ?)`, [userId, now, now])?.total || 0);
}

function createDueNotifications(userId) {
  const today = todayDate();
  const tomorrow = addDays(today, 1);
  const inThree = addDays(today, 3);
  for (const item of all("SELECT * FROM planning_items WHERE due_date <> '' AND status <> 'paid' AND due_date <= ? ORDER BY due_date ASC LIMIT 80", [inThree])) {
    const due = String(item.due_date || "");
    const amount = Number(item.amount || 0) - Number(item.paid_amount || 0);
    const base = `${item.title || item.category || "Compromisso"}${amount > 0 ? ` - ${formatMoneyBR(amount)}` : ""}`;
    if (due < today) {
      createNotification({ userId, title: "Conta vencida", message: `${base} venceu em ${due}.`, category: "FINANCE", severity: "ERROR", sourceModule: "Financeiro", sourceEntityType: "planning_item", sourceEntityId: item.id, actionUrl: "#planning", primaryActionLabel: "Abrir financeiro", dedupeKey: `finance:planning:${item.id}:overdue` });
    } else if (due === today) {
      createNotification({ userId, title: "Conta vence hoje", message: base, category: "FINANCE", severity: "WARNING", sourceModule: "Financeiro", sourceEntityType: "planning_item", sourceEntityId: item.id, actionUrl: "#planning", primaryActionLabel: "Abrir financeiro", dedupeKey: `finance:planning:${item.id}:today` });
    } else if (due === tomorrow) {
      createNotification({ userId, title: "Conta vence amanha", message: base, category: "FINANCE", severity: "WARNING", sourceModule: "Financeiro", sourceEntityType: "planning_item", sourceEntityId: item.id, actionUrl: "#planning", primaryActionLabel: "Abrir financeiro", dedupeKey: `finance:planning:${item.id}:tomorrow` });
    } else if (due <= inThree) {
      createNotification({ userId, title: "Conta vence em 3 dias", message: `${base} vence em ${due}.`, category: "FINANCE", severity: "INFO", sourceModule: "Financeiro", sourceEntityType: "planning_item", sourceEntityId: item.id, actionUrl: "#planning", primaryActionLabel: "Abrir financeiro", dedupeKey: `finance:planning:${item.id}:3days` });
    }
  }
  const now = currentDateTime();
  const next24 = currentDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
  for (const event of all("SELECT * FROM agenda_events WHERE user_id = ? AND start_at >= ? AND start_at <= ? ORDER BY start_at ASC LIMIT 80", [userId, now, next24])) {
    createNotification({ userId, title: "Compromisso nas proximas 24 horas", message: `${event.title || "Evento"} comeca em ${formatBRDateTimeServer(event.start_at)}.`, category: "AGENDA", severity: "INFO", sourceModule: "Agenda", sourceEntityType: "agenda_event", sourceEntityId: event.id, actionUrl: "#agenda", primaryActionLabel: "Abrir agenda", dedupeKey: `agenda:event:${event.id}:24h` });
  }
  const latestBackup = get("SELECT * FROM backups ORDER BY created_at DESC LIMIT 1");
  if (latestBackup) {
    createNotification({ userId, title: "Backup disponivel", message: `${latestBackup.file_name} foi gerado em ${formatBRDateTimeServer(latestBackup.created_at)}.`, category: "BACKUP", severity: "SUCCESS", sourceModule: "Backup", sourceEntityType: "backup", sourceEntityId: latestBackup.id, actionUrl: "#settings", primaryActionLabel: "Ver backups", dedupeKey: `backup:${latestBackup.id}:created` });
  }
}

function formatBRDateTimeServer(value) {
  const text = String(value || "");
  if (!text) return "";
  const [date, time = ""] = text.replace("T", " ").split(" ");
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}/${month}/${year}${time ? ` ${time.slice(0, 5)}` : ""}` : text;
}

function listNotifications(userId, query) {
  createDueNotifications(userId);
  const tab = String(query.get("tab") || "all");
  const category = normalizeNotificationCategory(query.get("category") || "");
  const rawCategory = String(query.get("category") || "");
  const severity = normalizeNotificationSeverity(query.get("severity") || "");
  const rawSeverity = String(query.get("severity") || "");
  const page = Math.max(1, Number(query.get("page") || 1));
  const limit = Math.min(50, Math.max(5, Number(query.get("limit") || 20)));
  const now = currentDateTime();
  const where = ["user_id = ?", "is_archived = 0", "(snoozed_until IS NULL OR snoozed_until = '' OR snoozed_until <= ?)", "(expires_at IS NULL OR expires_at = '' OR expires_at > ?)"];
  const values = [userId, now, now];
  if (tab === "unread") where.push("is_read = 0");
  if (tab === "important") where.push("(is_pinned = 1 OR severity IN ('ERROR','CRITICAL'))");
  if (rawCategory) { where.push("category = ?"); values.push(category); }
  if (rawSeverity) { where.push("severity = ?"); values.push(severity); }
  const whereSql = where.join(" AND ");
  const total = Number(get(`SELECT COUNT(*) AS total FROM notifications WHERE ${whereSql}`, values)?.total || 0);
  const items = all(`SELECT * FROM notifications WHERE ${whereSql}
    ORDER BY is_pinned DESC, datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]).map(notificationRow);
  const modules = all("SELECT DISTINCT category FROM notifications WHERE user_id = ? ORDER BY category", [userId]).map((row) => ({ value: row.category, label: NOTIFICATION_MODULE_LABELS[row.category] || row.category }));
  return { items, total, page, limit, hasMore: page * limit < total, unreadCount: unreadNotificationCount(userId), modules, severities: NOTIFICATION_SEVERITIES, preferences: notificationPreferences(userId) };
}

function updateNotification(userId, id, payload = {}) {
  const row = get("SELECT * FROM notifications WHERE id = ? AND user_id = ?", [Number(id), userId]);
  if (!row) throw Object.assign(new Error("Notificacao nao encontrada."), { statusCode: 404 });
  const action = String(payload.action || "").trim();
  const now = currentDateTime();
  if (action === "read") run("UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ? AND user_id = ?", [now, now, id, userId]);
  if (action === "unread") run("UPDATE notifications SET is_read = 0, read_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?", [now, id, userId]);
  if (action === "pin") run("UPDATE notifications SET is_pinned = 1, pinned_at = COALESCE(pinned_at, ?), updated_at = ? WHERE id = ? AND user_id = ?", [now, now, id, userId]);
  if (action === "unpin") run("UPDATE notifications SET is_pinned = 0, pinned_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?", [now, id, userId]);
  if (action === "archive") run("UPDATE notifications SET is_archived = 1, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?", [now, now, id, userId]);
  if (action === "snooze") {
    const until = cleanNotificationText(payload.snoozedUntil || payload.snoozed_until || currentDateTime(new Date(Date.now() + 60 * 60 * 1000)), 30);
    run("UPDATE notifications SET snoozed_until = ?, updated_at = ? WHERE id = ? AND user_id = ?", [until, now, id, userId]);
  }
  return notificationRow(get("SELECT * FROM notifications WHERE id = ? AND user_id = ?", [Number(id), userId]));
}

function markAllNotificationsRead(userId) {
  const now = currentDateTime();
  const result = run("UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE user_id = ? AND is_read = 0 AND is_archived = 0", [now, now, userId]);
  return { ok: true, changed: Number(result.changes || 0), unreadCount: unreadNotificationCount(userId) };
}

function updateNotificationPreferences(userId, payload = {}) {
  ensureNotificationPreferences(userId);
  const items = Array.isArray(payload.preferences) ? payload.preferences : [];
  const now = currentDateTime();
  for (const item of items) {
    const category = normalizeNotificationCategory(item.category);
    run(`UPDATE notification_preferences
      SET in_app_enabled = ?, browser_enabled = ?, sound_enabled = ?, minimum_severity = ?, quiet_hours_enabled = ?,
          quiet_hours_start = ?, quiet_hours_end = ?, critical_ignore_quiet_hours = ?, updated_at = ?
      WHERE user_id = ? AND category = ?`, [
      item.inAppEnabled === false ? 0 : 1,
      item.browserEnabled ? 1 : 0,
      item.soundEnabled ? 1 : 0,
      normalizeNotificationSeverity(item.minimumSeverity || "INFO"),
      item.quietHoursEnabled ? 1 : 0,
      cleanNotificationText(item.quietHoursStart || "22:00", 5),
      cleanNotificationText(item.quietHoursEnd || "07:00", 5),
      item.criticalIgnoreQuietHours ? 1 : 0,
      now,
      userId,
      category
    ]);
  }
  return notificationPreferences(userId);
}

function seedDemoNotifications(userId) {
  const samples = [
    { title: "Backup concluido", message: "O backup do banco local foi finalizado com sucesso.", category: "BACKUP", severity: "SUCCESS", sourceModule: "Backup", actionUrl: "#settings", primaryActionLabel: "Ver backups", dedupeKey: "demo:backup:success" },
    { title: "Conta vence amanha", message: "Internet - R$ 119,90", category: "FINANCE", severity: "WARNING", sourceModule: "Financeiro", actionUrl: "#planning", primaryActionLabel: "Abrir financeiro", dedupeKey: "demo:finance:tomorrow" },
    { title: "Tarefa atrasada", message: "Revisar documentos pessoais esta fora do prazo.", category: "TASK", severity: "ERROR", sourceModule: "Tarefas", actionUrl: "#personal", primaryActionLabel: "Abrir tarefas", dedupeKey: "demo:task:late" },
    { title: "Novo login detectado", message: "Uma sessao foi iniciada neste dispositivo.", category: "SECURITY", severity: "INFO", sourceModule: "Seguranca", actionUrl: "#profile", primaryActionLabel: "Ver perfil", dedupeKey: "demo:security:login" },
    { title: "Integracao desconectada", message: "Uma integracao precisa de revisao antes da proxima sincronizacao.", category: "INTEGRATION", severity: "WARNING", sourceModule: "Integracoes", actionUrl: "#googleCentral", primaryActionLabel: "Abrir integracoes", dedupeKey: "demo:integration:disconnected" }
  ];
  return samples.map((item) => createNotification({ userId, ...item })).filter(Boolean);
}

function listResource(resource, query) {
  if (resource === "finance") return listFinancialTransactions(query);
  const table = tables[resource];
  const where = [];
  const values = [];
  for (const key of fields[resource]) {
    if (query.get(key)) {
      where.push(`${key} LIKE ?`);
      values.push(`%${query.get(key)}%`);
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  if (resource === "notes") {
    return all(`
      SELECT notes.*, COUNT(note_attachments.id) AS attachment_count
      FROM notes
      LEFT JOIN note_attachments ON note_attachments.note_id = notes.id
      ${clause}
      GROUP BY notes.id
      ORDER BY ${orderBy[resource]}
    `, values);
  }
  return all(`SELECT * FROM ${table} ${clause} ORDER BY ${orderBy[resource]}`, values);
}

function listPlanning(query) {
  const month = query.get("month") || currentMonth();
  const person = query.get("person") || "";
  const where = ["month = ?"];
  const values = [month];
  for (const key of ["person", "title", "category", "due_date", "status"]) {
    const value = query.get(key);
    if (value) {
      where.push(`${key} LIKE ?`);
      values.push(`%${value}%`);
    }
  }
  const entries = all(`SELECT * FROM planning_items WHERE ${where.join(" AND ")} ORDER BY due_date ASC, id DESC`, values);
  const today = todayDate();
  const stats = get(`
    SELECT
      COALESCE(SUM(amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE paid_amount END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN amount - paid_amount ELSE 0 END), 0) AS pending_amount,
      COALESCE(SUM(CASE WHEN status = 'partial' THEN amount - paid_amount ELSE 0 END), 0) AS partial_amount,
      COALESCE(SUM(CASE WHEN due_date < ? AND status <> 'paid' THEN amount - paid_amount ELSE 0 END), 0) AS overdue_amount,
      COUNT(*) AS total_items,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
      COALESCE(SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END), 0) AS partial_count,
      COALESCE(SUM(CASE WHEN due_date < ? AND status <> 'paid' THEN 1 ELSE 0 END), 0) AS overdue_count
    FROM planning_items
    WHERE month = ?
  `, [today, today, month]);
  stats.resolved_amount = Number(stats.paid_amount || 0) + Number(stats.partial_amount || 0);
  stats.remaining_amount = Math.max(0, Number(stats.total_amount || 0) - Number(stats.resolved_amount || 0));
  stats.estimated_leftover = stats.resolved_amount;
  stats.resolved_percent = Number(stats.total_amount || 0) ? Math.round((stats.resolved_amount / Number(stats.total_amount || 0)) * 100) : 0;
  const byPerson = all(`
    SELECT
      person,
      COUNT(*) AS total_items,
      COALESCE(SUM(amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE paid_amount END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN status <> 'paid' THEN amount - paid_amount ELSE 0 END), 0) AS remaining_amount
    FROM planning_items
    WHERE month = ?
    GROUP BY person
    ORDER BY person
  `, [month]);
  const byCategory = all(`
    SELECT COALESCE(NULLIF(category, ''), 'Sem categoria') AS category, COUNT(*) AS total_items,
      COALESCE(SUM(amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE paid_amount END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN status <> 'paid' THEN amount - paid_amount ELSE 0 END), 0) AS remaining_amount
    FROM planning_items WHERE month = ?
    GROUP BY COALESCE(NULLIF(category, ''), 'Sem categoria') ORDER BY category
  `, [month]);
  const byStatus = all(`
    SELECT status, COUNT(*) AS total_items, COALESCE(SUM(amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE paid_amount END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN status <> 'paid' THEN amount - paid_amount ELSE 0 END), 0) AS remaining_amount
    FROM planning_items WHERE month = ? GROUP BY status ORDER BY status
  `, [month]);
  const byDueDate = all(`
    SELECT COALESCE(NULLIF(due_date, ''), 'Sem vencimento') AS due_date, COUNT(*) AS total_items,
      COALESCE(SUM(amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE paid_amount END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN status <> 'paid' THEN amount - paid_amount ELSE 0 END), 0) AS remaining_amount
    FROM planning_items WHERE month = ?
    GROUP BY COALESCE(NULLIF(due_date, ''), 'Sem vencimento') ORDER BY due_date
  `, [month]);
  const payments = all(`
    SELECT planning_partial_payments.*
    FROM planning_partial_payments
    JOIN planning_items ON planning_items.id = planning_partial_payments.planning_item_id
    WHERE planning_items.month = ?
    ORDER BY payment_date DESC, id DESC
  `, [month]);
  return { month, person, today, entries, stats, byPerson, byCategory, byStatus, byDueDate, calendar: byDueDate.filter((item) => item.due_date !== "Sem vencimento"), payments };
}

function listPlanningCategories() {
  return all("SELECT * FROM planning_categories ORDER BY name");
}

function listPlanningPeople() {
  return all("SELECT * FROM planning_people ORDER BY name");
}

function seedPlanningCategories() {
  const seeds = ["Moradia", "Contas Fixas", "Alimentacao", "Transporte", "Cartoes", "Saude", "Faculdade", "Lazer", "Outros"];
  for (const name of seeds) {
    run("INSERT OR IGNORE INTO planning_categories (name) VALUES (?)", [name]);
  }
}

seedPlanningCategories();

function seedPlanningMetadata() {
  const categories = [
    ["Moradia", "#38bdf8", "Casa"],
    ["Contas Fixas", "#2dd4bf", "Fixo"],
    ["Alimenta\u00e7\u00e3o", "#f59e0b", "Mercado"],
    ["Transporte", "#a78bfa", "Carro"],
    ["Cart\u00f5es", "#fb7185", "Cartao"],
    ["Sa\u00fade", "#34d399", "Saude"],
    ["Faculdade", "#60a5fa", "Estudo"],
    ["Lazer", "#f472b6", "Lazer"],
    ["Outros", "#94a3b8", "Outro"]
  ];
  for (const [name, color, icon] of categories) {
    run("INSERT OR IGNORE INTO planning_categories (name, color, icon) VALUES (?, ?, ?)", [name, color, icon]);
    run("UPDATE planning_categories SET color = COALESCE(NULLIF(color, ''), ?), icon = COALESCE(NULLIF(icon, ''), ?) WHERE name = ?", [color, icon, name]);
  }
  for (const duplicate of ["Alimentacao", "Cartoes", "Saude"]) {
    run("DELETE FROM planning_categories WHERE name = ? AND NOT EXISTS (SELECT 1 FROM planning_items WHERE planning_items.category = planning_categories.name)", [duplicate]);
  }
  for (const [name, color] of [["Dauan", "#2dd4bf"], ["Geovana", "#f472b6"]]) {
    run("INSERT OR IGNORE INTO planning_people (name, color_identification) VALUES (?, ?)", [name, color]);
  }
}

seedPlanningMetadata();

function listFinancialTransactions(query) {
  const where = [];
  const values = [];
  for (const key of fields.finance) {
    if (query.get(key)) {
      if (key === "account_id") {
        where.push("financial_transactions.account_id = ?");
        values.push(Number(query.get(key)));
      } else {
        where.push(`financial_transactions.${key} LIKE ?`);
        values.push(`%${query.get(key)}%`);
      }
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return all(`
    SELECT financial_transactions.*,
      bank_accounts.name AS account_name, bank_accounts.bank AS bank_name,
      destination_accounts.name AS destination_account_name, destination_accounts.bank AS destination_bank_name,
      finance_account_pockets.name AS pocket_name, finance_account_pockets.kind AS pocket_kind
    FROM financial_transactions
    LEFT JOIN bank_accounts ON bank_accounts.id = financial_transactions.account_id
    LEFT JOIN bank_accounts AS destination_accounts ON destination_accounts.id = financial_transactions.destination_account_id
    LEFT JOIN finance_account_pockets ON finance_account_pockets.id = financial_transactions.pocket_id
    ${clause}
    ORDER BY financial_transactions.date DESC, financial_transactions.id DESC
  `, values);
}

function accountBalances() {
  const accounts = all(`
    SELECT
      bank_accounts.*,
      bank_accounts.initial_balance
        + COALESCE(SUM(CASE WHEN financial_transactions.type = 'entrada' AND financial_transactions.pocket_id IS NULL THEN financial_transactions.amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN financial_transactions.type = 'saida' AND financial_transactions.pocket_id IS NULL THEN financial_transactions.amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN financial_transactions.type = 'transferencia' AND financial_transactions.account_id = bank_accounts.id THEN financial_transactions.amount ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN financial_transactions.type = 'transferencia' AND financial_transactions.destination_account_id = bank_accounts.id THEN financial_transactions.amount ELSE 0 END), 0) AS balance,
      COALESCE(SUM(CASE WHEN financial_transactions.type = 'entrada' AND financial_transactions.pocket_id IS NULL THEN financial_transactions.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN financial_transactions.type = 'saida' AND financial_transactions.pocket_id IS NULL THEN financial_transactions.amount ELSE 0 END), 0) AS expense,
      COALESCE(SUM(CASE WHEN financial_transactions.type = 'transferencia' AND financial_transactions.account_id = bank_accounts.id THEN financial_transactions.amount ELSE 0 END), 0) AS transferred_out,
      COALESCE(SUM(CASE WHEN financial_transactions.type = 'transferencia' AND financial_transactions.destination_account_id = bank_accounts.id THEN financial_transactions.amount ELSE 0 END), 0) AS transferred_in,
      COUNT(financial_transactions.id) AS transaction_count
    FROM bank_accounts
    LEFT JOIN financial_transactions ON financial_transactions.account_id = bank_accounts.id OR financial_transactions.destination_account_id = bank_accounts.id
    GROUP BY bank_accounts.id
    ORDER BY bank_accounts.name
  `);
  const pockets = all(`
    SELECT
      finance_account_pockets.*,
      finance_account_pockets.initial_balance
        + COALESCE(SUM(CASE WHEN finance_account_pocket_movements.type = 'entrada' THEN finance_account_pocket_movements.amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN finance_account_pocket_movements.type = 'saida' THEN finance_account_pocket_movements.amount ELSE 0 END), 0) AS balance,
      COALESCE(SUM(CASE WHEN finance_account_pocket_movements.type = 'entrada' THEN finance_account_pocket_movements.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN finance_account_pocket_movements.type = 'saida' THEN finance_account_pocket_movements.amount ELSE 0 END), 0) AS expense,
      COUNT(finance_account_pocket_movements.id) AS movement_count
    FROM finance_account_pockets
    LEFT JOIN finance_account_pocket_movements ON finance_account_pocket_movements.pocket_id = finance_account_pockets.id
    GROUP BY finance_account_pockets.id
    ORDER BY finance_account_pockets.kind, finance_account_pockets.name
  `);
  const byAccount = pockets.reduce((result, pocket) => {
    const key = Number(pocket.account_id);
    result[key] = result[key] || [];
    result[key].push(pocket);
    return result;
  }, {});
  return accounts.map((account) => {
    const accountPockets = byAccount[Number(account.id)] || [];
    const pocketsBalance = accountPockets.reduce((sum, pocket) => sum + Number(pocket.balance || 0), 0);
    const cryptoBalance = accountPockets.filter((pocket) => pocket.kind === "cripto").reduce((sum, pocket) => sum + Number(pocket.balance || 0), 0);
    const reserveBalance = accountPockets.filter((pocket) => pocket.kind !== "cripto").reduce((sum, pocket) => sum + Number(pocket.balance || 0), 0);
    return {
      ...account,
      main_balance: Number(account.balance || 0),
      available_balance: Number(account.balance || 0),
      pockets_balance: roundMoney(pocketsBalance),
      reserve_balance: roundMoney(reserveBalance),
      crypto_balance: roundMoney(cryptoBalance),
      total_balance: roundMoney(Number(account.balance || 0) + pocketsBalance),
      pockets: accountPockets
    };
  });
}

function normalizeFinanceTransactionPayload(payload) {
  const type = ["entrada", "saida", "transferencia"].includes(payload.type) ? payload.type : "saida";
  return {
    account_id: Number(payload.account_id || 0) || null,
    destination_account_id: type === "transferencia" ? (Number(payload.destination_account_id || 0) || null) : null,
    pocket_id: type === "transferencia" ? null : (Number(payload.pocket_id || 0) || null),
    type,
    category: String(payload.category || "geral").trim(),
    description: String(payload.description || "").trim(),
    amount: roundMoney(payload.amount || 0),
    date: normalizeDateTime(payload.date || currentDateTime()),
    payment_method: String(payload.payment_method || "").trim(),
    notes: String(payload.notes || "").trim()
  };
}

function syncPocketMovementFromTransaction(transaction) {
  run("DELETE FROM finance_account_pocket_movements WHERE transaction_id = ?", [transaction.id]);
  const pocketId = Number(transaction.pocket_id || 0);
  if (!pocketId) return;
  const pocket = get("SELECT * FROM finance_account_pockets WHERE id = ?", [pocketId]);
  if (!pocket) return;
  if (!["entrada", "saida"].includes(transaction.type)) return;
  run("INSERT INTO finance_account_pocket_movements (pocket_id, transaction_id, type, amount, date, notes) VALUES (?, ?, ?, ?, ?, ?)", [
    pocketId,
    transaction.id,
    transaction.type,
    Number(transaction.amount || 0),
    transaction.date || currentDateTime(),
    transaction.notes || transaction.description || "Movimento vinculado ao lancamento"
  ]);
}

function createFinanceTransaction(payload) {
  const clean = normalizeFinanceTransactionPayload(payload);
  if (!clean.account_id) throw new Error("Selecione a conta do lancamento.");
  if (clean.type === "transferencia" && !clean.destination_account_id) throw new Error("Selecione a conta destino da transferencia.");
  if (clean.type === "transferencia" && Number(clean.destination_account_id) === Number(clean.account_id)) throw new Error("A conta destino precisa ser diferente da conta origem.");
  if (!clean.description) throw new Error("Informe o motivo do lancamento.");
  if (clean.amount <= 0) throw new Error("Informe um valor maior que zero.");
  const result = run(`INSERT INTO financial_transactions
    (account_id, destination_account_id, pocket_id, type, category, description, amount, date, payment_method, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    clean.account_id,
    clean.destination_account_id,
    clean.pocket_id,
    clean.type,
    clean.category,
    clean.description,
    clean.amount,
    clean.date,
    clean.payment_method,
    clean.notes
  ]);
  const saved = get("SELECT * FROM financial_transactions WHERE id = ?", [result.lastInsertRowid]);
  syncPocketMovementFromTransaction(saved);
  recordTimeline("Movimentacao criada", clean.description || "", "finance");
  return saved;
}

function updateFinanceTransaction(id, payload) {
  const existing = get("SELECT * FROM financial_transactions WHERE id = ?", [id]) || {};
  const clean = { ...existing, ...normalizeFinanceTransactionPayload({ ...existing, ...payload }) };
  if (!clean.account_id) throw new Error("Selecione a conta do lancamento.");
  if (clean.type === "transferencia" && !clean.destination_account_id) throw new Error("Selecione a conta destino da transferencia.");
  if (clean.type === "transferencia" && Number(clean.destination_account_id) === Number(clean.account_id)) throw new Error("A conta destino precisa ser diferente da conta origem.");
  if (!clean.description) throw new Error("Informe o motivo do lancamento.");
  if (Number(clean.amount || 0) <= 0) throw new Error("Informe um valor maior que zero.");
  run(`UPDATE financial_transactions SET
    account_id = ?, destination_account_id = ?, pocket_id = ?, type = ?, category = ?, description = ?, amount = ?, date = ?, payment_method = ?, notes = ?, updated_at = ?
    WHERE id = ?`, [
    clean.account_id,
    clean.destination_account_id,
    clean.pocket_id,
    clean.type,
    clean.category,
    clean.description,
    clean.amount,
    clean.date,
    clean.payment_method,
    clean.notes,
    currentDateTime(),
    id
  ]);
  const saved = get("SELECT * FROM financial_transactions WHERE id = ?", [id]);
  syncPocketMovementFromTransaction(saved);
  return saved;
}

function seedFinanceCatalog() {
  const seeds = [
    ["type", "entrada"],
    ["type", "saida"],
    ["type", "transferencia"],
    ["category", "alimentacao"],
    ["category", "transporte"],
    ["category", "casa"],
    ["payment_method", "pix"],
    ["payment_method", "debito"],
    ["payment_method", "credito"],
    ["payment_method", "dinheiro"]
  ];
  for (const [kind, name] of seeds) {
    const wasDeleted = get("SELECT id FROM finance_catalog_deleted_items WHERE kind = ? AND lower(name) = lower(?)", [kind, name]);
    if (!wasDeleted) run("INSERT OR IGNORE INTO finance_catalog_items (kind, name) VALUES (?, ?)", [kind, name]);
  }
}

seedFinanceCatalog();

function seedCreditCardCategories(userId = 1) {
  for (const name of defaultCreditCardCategories) {
    run("INSERT OR IGNORE INTO credit_card_categories (user_id, name) VALUES (?, ?)", [userId, name]);
  }
}

seedCreditCardCategories();

function monthFromBillingDate(dateText, closingDay = 1) {
  const normalized = String(dateText || todayDate()).slice(0, 10);
  const day = Number(normalized.slice(8, 10) || 1);
  const base = `${normalized.slice(0, 7)}-01`;
  return day > Number(closingDay || 1) ? addMonths(base, 1).slice(0, 7) : base.slice(0, 7);
}

function monthKeyAdd(monthKey, amount) {
  return addMonths(`${monthKey || currentMonth()}-01`, amount).slice(0, 7);
}

function invoiceDueDate(monthKey, dueDay = 10) {
  const base = new Date(`${monthKey || currentMonth()}-01T00:00:00`);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const day = Math.max(1, Math.min(lastDay, Number(dueDay || 10)));
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

function normalizeCreditCardPayload(payload, userId) {
  return {
    user_id: userId,
    name: String(payload.name || payload.nome || "").trim(),
    bank: String(payload.bank || payload.banco || "").trim(),
    brand: String(payload.brand || payload.bandeira || "").trim(),
    last_four: String(payload.last_four || payload.ultimos_digitos || "").replace(/\D/g, "").slice(-4),
    total_limit: roundMoney(payload.total_limit ?? payload.limite_total ?? 0),
    closing_day: Math.max(1, Math.min(31, Number(payload.closing_day || payload.fechamento || 1))),
    due_day: Math.max(1, Math.min(31, Number(payload.due_day || payload.vencimento || 10))),
    color: payload.color || payload.cor || "#2dd4bf",
    status: payload.status || "Ativo",
    notes: payload.notes || payload.observacoes || ""
  };
}

function normalizeCreditCardExpensePayload(payload, userId) {
  const rawDate = normalizeDateTime(payload.date || payload.data || currentDateTime());
  const [datePart, timePart = "00:00:00"] = rawDate.split(" ");
  return {
    user_id: userId,
    card_id: Number(payload.card_id || payload.cartao_id || 0),
    date: datePart,
    time: String(payload.time || payload.hora || timePart.slice(0, 5) || "00:00").slice(0, 5),
    description: String(payload.description || payload.descricao || "").trim(),
    category: String(payload.category || payload.categoria || "Outros").trim(),
    total_value: roundMoney(payload.total_value ?? payload.valor_total ?? payload.amount ?? 0),
    installments_count: Math.max(1, Number(payload.installments_count || payload.parcelas || 1)),
    notes: payload.notes || payload.observacoes || ""
  };
}

function installmentAmounts(totalValue, totalInstallments) {
  const count = Math.max(1, Number(totalInstallments || 1));
  const totalCents = Math.round(Number(totalValue || 0) * 100);
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - (base * count);
  return Array.from({ length: count }, (_, index) => roundMoney((base + (index < remainder ? 1 : 0)) / 100));
}

function generateCreditCardInstallments(expense) {
  const card = get("SELECT * FROM credit_cards WHERE id = ? AND user_id = ?", [expense.card_id, expense.user_id]);
  if (!card) throw new Error("Cartao nao encontrado.");
  run("DELETE FROM credit_card_installments WHERE expense_id = ?", [expense.id]);
  const firstMonth = monthFromBillingDate(expense.date, card.closing_day);
  const amounts = installmentAmounts(expense.total_value, expense.installments_count);
  amounts.forEach((amount, index) => {
    run(`INSERT INTO credit_card_installments
      (user_id, expense_id, card_id, installment_number, installment_total, amount, billing_month, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`, [
      expense.user_id,
      expense.id,
      expense.card_id,
      index + 1,
      expense.installments_count,
      amount,
      monthKeyAdd(firstMonth, index)
    ]);
  });
}

function recalculateCreditCardInvoice(userId, cardId, billingMonth) {
  const card = get("SELECT * FROM credit_cards WHERE id = ? AND user_id = ?", [cardId, userId]);
  if (!card || !billingMonth) return null;
  const existing = get("SELECT * FROM credit_card_invoices WHERE card_id = ? AND billing_month = ?", [cardId, billingMonth]);
  const total = get("SELECT COALESCE(SUM(amount), 0) AS total FROM credit_card_installments WHERE card_id = ? AND user_id = ? AND billing_month = ?", [cardId, userId, billingMonth]).total || 0;
  if (!existing) {
    const result = run(`INSERT INTO credit_card_invoices
      (user_id, card_id, billing_month, total_value, paid_value, remaining_value, status, due_date)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`, [
      userId,
      cardId,
      billingMonth,
      roundMoney(total),
      roundMoney(total),
      Number(total || 0) > 0 ? "Aberta" : "Sem gastos",
      invoiceDueDate(billingMonth, card.due_day)
    ]);
    return recalculateCreditCardInvoice(userId, cardId, billingMonth) || get("SELECT * FROM credit_card_invoices WHERE id = ?", [result.lastInsertRowid]);
  }
  const paid = get("SELECT COALESCE(SUM(amount), 0) AS paid FROM credit_card_payments WHERE invoice_id = ?", [existing.id]).paid || 0;
  const remaining = Math.max(0, roundMoney(Number(total || 0) - Number(paid || 0)));
  const status = Number(total || 0) <= 0
    ? "Sem gastos"
    : remaining <= 0
      ? "Paga"
      : Number(paid || 0) > 0
        ? "Parcialmente paga"
        : "Aberta";
  run(`UPDATE credit_card_invoices
    SET total_value = ?, paid_value = ?, remaining_value = ?, status = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`, [roundMoney(total), roundMoney(paid), remaining, status, invoiceDueDate(billingMonth, card.due_day), existing.id]);
  const installmentStatus = status === "Paga" ? "paid" : "pending";
  run("UPDATE credit_card_installments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE card_id = ? AND user_id = ? AND billing_month = ?", [installmentStatus, cardId, userId, billingMonth]);
  return get("SELECT * FROM credit_card_invoices WHERE id = ?", [existing.id]);
}

function recalculateCreditCardInvoicesForCard(userId, cardId) {
  const months = new Set([
    ...all("SELECT DISTINCT billing_month FROM credit_card_installments WHERE card_id = ? AND user_id = ?", [cardId, userId]).map((item) => item.billing_month),
    ...all("SELECT DISTINCT billing_month FROM credit_card_invoices WHERE card_id = ? AND user_id = ?", [cardId, userId]).map((item) => item.billing_month)
  ].filter(Boolean));
  months.forEach((month) => recalculateCreditCardInvoice(userId, cardId, month));
}

function listCreditCardCategories(userId) {
  seedCreditCardCategories(userId);
  return all("SELECT * FROM credit_card_categories WHERE user_id = ? ORDER BY name", [userId]);
}

function creditCardSummary(userId, month = currentMonth()) {
  const cards = all("SELECT * FROM credit_cards WHERE user_id = ? ORDER BY status DESC, name", [userId]).map((card) => {
    recalculateCreditCardInvoicesForCard(userId, card.id);
    const used = get("SELECT COALESCE(SUM(remaining_value), 0) AS value FROM credit_card_invoices WHERE card_id = ? AND user_id = ? AND status NOT IN ('Paga','Sem gastos')", [card.id, userId]).value || 0;
    const invoice = get("SELECT * FROM credit_card_invoices WHERE card_id = ? AND user_id = ? AND billing_month = ?", [card.id, userId, month])
      || recalculateCreditCardInvoice(userId, card.id, month);
    const nextInvoice = get("SELECT * FROM credit_card_invoices WHERE card_id = ? AND user_id = ? AND billing_month >= ? AND total_value > 0 ORDER BY billing_month ASC LIMIT 1", [card.id, userId, month]);
    const future = get("SELECT COALESCE(SUM(amount), 0) AS value, COUNT(*) AS total FROM credit_card_installments WHERE card_id = ? AND user_id = ? AND billing_month > ?", [card.id, userId, month]);
    return {
      ...card,
      used_limit: roundMoney(used),
      available_limit: roundMoney(Number(card.total_limit || 0) - Number(used || 0)),
      used_percent: Number(card.total_limit || 0) ? Math.min(100, Math.round((Number(used || 0) / Number(card.total_limit || 0)) * 100)) : 0,
      current_invoice: invoice || null,
      next_invoice: nextInvoice || null,
      future_installments_total: roundMoney(future?.value || 0),
      future_installments_count: Number(future?.total || 0)
    };
  });
  const installments = all(`
    SELECT credit_card_installments.*, credit_card_expenses.description, credit_card_expenses.category,
      credit_card_expenses.date, credit_card_expenses.time, credit_cards.name AS card_name, credit_cards.color AS card_color
    FROM credit_card_installments
    JOIN credit_card_expenses ON credit_card_expenses.id = credit_card_installments.expense_id
    JOIN credit_cards ON credit_cards.id = credit_card_installments.card_id
    WHERE credit_card_installments.user_id = ? AND credit_card_installments.billing_month = ?
    ORDER BY credit_card_expenses.date DESC, credit_card_installments.id DESC
  `, [userId, month]);
  const invoices = all(`
    SELECT credit_card_invoices.*, credit_cards.name AS card_name, credit_cards.color AS card_color
    FROM credit_card_invoices
    JOIN credit_cards ON credit_cards.id = credit_card_invoices.card_id
    WHERE credit_card_invoices.user_id = ?
    ORDER BY credit_card_invoices.billing_month DESC, credit_card_invoices.card_id
  `, [userId]);
  const payments = all(`
    SELECT credit_card_payments.*, credit_card_invoices.billing_month, credit_cards.name AS card_name
    FROM credit_card_payments
    JOIN credit_card_invoices ON credit_card_invoices.id = credit_card_payments.invoice_id
    JOIN credit_cards ON credit_cards.id = credit_card_payments.card_id
    WHERE credit_card_payments.user_id = ?
    ORDER BY credit_card_payments.payment_date DESC, credit_card_payments.id DESC
  `, [userId]);
  const totals = get(`
    SELECT
      COALESCE(SUM(total_value), 0) AS invoices_total,
      COALESCE(SUM(paid_value), 0) AS paid_total,
      COALESCE(SUM(remaining_value), 0) AS remaining_total
    FROM credit_card_invoices WHERE user_id = ? AND billing_month = ?
  `, [userId, month]);
  const byCategory = all(`
    SELECT COALESCE(NULLIF(credit_card_expenses.category, ''), 'Outros') AS category,
      COUNT(*) AS total_items, COALESCE(SUM(credit_card_installments.amount), 0) AS total_value
    FROM credit_card_installments
    JOIN credit_card_expenses ON credit_card_expenses.id = credit_card_installments.expense_id
    WHERE credit_card_installments.user_id = ? AND credit_card_installments.billing_month = ?
    GROUP BY COALESCE(NULLIF(credit_card_expenses.category, ''), 'Outros')
    ORDER BY total_value DESC
  `, [userId, month]);
  const byCard = all(`
    SELECT credit_cards.name AS card_name, COUNT(*) AS total_items, COALESCE(SUM(credit_card_installments.amount), 0) AS total_value
    FROM credit_card_installments
    JOIN credit_cards ON credit_cards.id = credit_card_installments.card_id
    WHERE credit_card_installments.user_id = ? AND credit_card_installments.billing_month = ?
    GROUP BY credit_cards.id
    ORDER BY total_value DESC
  `, [userId, month]);
  const monthlyEvolution = all(`
    SELECT billing_month, COALESCE(SUM(total_value), 0) AS total_value, COALESCE(SUM(paid_value), 0) AS paid_value, COALESCE(SUM(remaining_value), 0) AS remaining_value
    FROM credit_card_invoices
    WHERE user_id = ?
    GROUP BY billing_month
    ORDER BY billing_month DESC
    LIMIT 12
  `, [userId]).reverse();
  const futureInstallments = all(`
    SELECT credit_card_installments.*, credit_card_expenses.description, credit_card_expenses.category,
      credit_card_expenses.date, credit_card_expenses.time, credit_cards.name AS card_name, credit_cards.color AS card_color
    FROM credit_card_installments
    JOIN credit_card_expenses ON credit_card_expenses.id = credit_card_installments.expense_id
    JOIN credit_cards ON credit_cards.id = credit_card_installments.card_id
    WHERE credit_card_installments.user_id = ? AND credit_card_installments.billing_month > ?
    ORDER BY credit_card_installments.billing_month ASC, credit_cards.name, credit_card_expenses.description
    LIMIT 80
  `, [userId, month]);
  const openInstallments = all(`
    SELECT credit_card_installments.*, credit_card_expenses.description, credit_card_expenses.category,
      credit_card_expenses.date, credit_card_expenses.time, credit_cards.name AS card_name, credit_cards.color AS card_color,
      credit_card_invoices.status AS invoice_status, credit_card_invoices.remaining_value AS invoice_remaining_value
    FROM credit_card_installments
    JOIN credit_card_expenses ON credit_card_expenses.id = credit_card_installments.expense_id
    JOIN credit_cards ON credit_cards.id = credit_card_installments.card_id
    JOIN credit_card_invoices
      ON credit_card_invoices.card_id = credit_card_installments.card_id
      AND credit_card_invoices.user_id = credit_card_installments.user_id
      AND credit_card_invoices.billing_month = credit_card_installments.billing_month
    WHERE credit_card_installments.user_id = ?
      AND credit_card_invoices.status NOT IN ('Paga','Sem gastos')
    ORDER BY credit_card_installments.billing_month ASC, credit_cards.name, credit_card_expenses.date DESC, credit_card_installments.id DESC
  `, [userId]);
  return {
    month,
    cards,
    installments,
    openInstallments,
    futureInstallments,
    invoices,
    payments,
    categories: listCreditCardCategories(userId),
    totals: {
      invoices_total: roundMoney(totals?.invoices_total || 0),
      paid_total: roundMoney(totals?.paid_total || 0),
      remaining_total: roundMoney(totals?.remaining_total || 0)
    },
    reports: { byCategory, byCard, monthlyEvolution }
  };
}

function createCreditCardExpense(userId, payload) {
  const clean = normalizeCreditCardExpensePayload(payload, userId);
  if (!clean.card_id) throw new Error("Selecione o cartao.");
  if (!clean.description) throw new Error("Informe a descricao.");
  if (clean.total_value <= 0) throw new Error("Informe um valor maior que zero.");
  const card = get("SELECT * FROM credit_cards WHERE id = ? AND user_id = ?", [clean.card_id, userId]);
  if (!card) throw new Error("Cartao nao encontrado.");
  const result = insertByFields("credit_card_expenses", creditCardExpenseFields, clean);
  const expense = get("SELECT * FROM credit_card_expenses WHERE id = ?", [result.lastInsertRowid]);
  generateCreditCardInstallments(expense);
  recalculateCreditCardInvoicesForCard(userId, expense.card_id);
  recordTimeline("Gasto no cartao registrado", `${card.name} - ${expense.description}`, "finance");
  return get("SELECT * FROM credit_card_expenses WHERE id = ?", [expense.id]);
}

function seedBettingHouses() {
  for (const name of defaultBettingHouses) {
    run("INSERT OR IGNORE INTO betting_houses (name, status) VALUES (?, 'Ativa')", [name]);
  }
}

seedBettingHouses();

function monthFromDate(date) {
  return date ? `${String(date).slice(0, 7)}-01` : "";
}

function currentMonth() {
  return currentDateTime().slice(0, 7);
}

function todayDate() {
  return currentDateTime().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText || todayDate()}T00:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function addMonths(dateText, months) {
  const date = new Date(`${dateText || todayDate()}T00:00:00`);
  const originalDay = date.getDate();
  date.setMonth(date.getMonth() + Number(months || 0), 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return date.toISOString().slice(0, 10);
}

function nextDueDate(record, step = 1) {
  if (record.recurrence_type === "weekly") return addDays(record.due_date, 7 * step);
  if (record.recurrence_type === "annual") return addMonths(record.due_date, 12 * step);
  return addMonths(record.due_date, step);
}

function monthKeyFromDueDate(dateText, fallback = currentMonth()) {
  return dateText ? String(dateText).slice(0, 7) : fallback;
}

function localDateParts(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
}

function currentDateTime(date = new Date()) {
  const parts = localDateParts(date);
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

function normalizeDateTime(value) {
  if (!value) return currentDateTime();
  const raw = String(value).trim();
  if (/[zZ]$/.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw)) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return currentDateTime(date);
    }
  }
  const text = raw.replace("T", " ");
  return text.length === 16 ? `${text}:00` : text.slice(0, 19);
}

try {
  const futureCutoff = currentDateTime(new Date(Date.now() + 30 * 60 * 1000));
  ["date", "created_at", "updated_at"].forEach((column) => {
    run(`UPDATE bets SET ${column} = datetime(${column}, '-3 hours') WHERE ${column} IS NOT NULL AND ${column} != '' AND datetime(${column}) > datetime(?)`, [futureCutoff]);
  });
} catch {
  // Correcao defensiva para apostas antigas com horario UTC adiantado.
}

function normalizePlanningPayload(payload, existing = {}) {
  const merged = { ...existing, ...payload };
  const amount = Number(merged.amount || 0);
  const status = merged.status || "pending";
  const paidAmount = Math.min(amount, status === "paid" ? amount : Number(merged.paid_amount || 0));
  const installmentTotal = Math.max(1, Number(merged.installment_total || 1));
  const installmentCurrent = Math.max(1, Math.min(installmentTotal, Number(merged.installment_current || 1)));
  return {
    ...merged,
    month: merged.month || currentMonth(),
    person: merged.person || "Dauan",
    title: merged.title || "",
    category: merged.category || "",
    due_date: merged.due_date || "",
    amount,
    status,
    paid_amount: paidAmount,
    paid_date: status === "paid" ? (merged.paid_date || todayDate()) : (merged.paid_date || ""),
    notes: merged.notes || "",
    recurring: merged.recurring === true || merged.recurring === "1" || merged.recurring === 1 ? 1 : 0,
    recurrence_type: merged.recurrence_type || "",
    installment_current: installmentCurrent,
    installment_total: installmentTotal,
    total_value: Number(merged.total_value || (installmentTotal > 1 ? amount * installmentTotal : amount)),
    split_details: typeof merged.split_details === "string" ? merged.split_details : JSON.stringify(merged.split_details || []),
    parent_item_id: merged.parent_item_id ? Number(merged.parent_item_id) : null,
    created_at: merged.created_at || existing.created_at || "",
    updated_at: merged.updated_at || existing.updated_at || ""
  };
}

function insertPlanningItem(payload) {
  const normalized = normalizePlanningPayload(payload, { status: "pending" });
  const result = insertByFields("planning_items", planningFields, normalized);
  const record = get("SELECT * FROM planning_items WHERE id = ?", [result.lastInsertRowid]);
  generatePlanningFutureItems(record);
  return record;
}

function generatePlanningFutureItems(record) {
  if (!record) return;
  const total = Math.max(1, Number(record.installment_total || 1));
  const shouldGenerate = Number(record.recurring || 0) === 1 || total > 1;
  if (!shouldGenerate) return;
  const limit = total > 1 ? total : 12;
  for (let step = 1; step < limit; step += 1) {
    const due = nextDueDate(record, step);
    const installment = total > 1 ? Number(record.installment_current || 1) + step : Number(record.installment_current || 1);
    if (total > 1 && installment > total) break;
    const exists = get("SELECT id FROM planning_items WHERE parent_item_id = ? AND installment_current = ? AND due_date = ?", [record.id, installment, due]);
    if (exists) continue;
    insertByFields("planning_items", planningFields, normalizePlanningPayload({
      ...record,
      id: undefined,
      month: monthKeyFromDueDate(due, record.month),
      due_date: due,
      status: "pending",
      paid_amount: 0,
      paid_date: "",
      installment_current: installment,
      parent_item_id: record.id
    }, { status: "pending" }));
  }
}

function duplicatePlanningToNextMonth(record) {
  const due = addMonths(record.due_date || `${record.month}-01`, 1);
  return insertPlanningItem({
    ...record,
    id: undefined,
    month: monthKeyFromDueDate(due, addMonths(`${record.month}-01`, 1).slice(0, 7)),
    due_date: due,
    status: "pending",
    paid_amount: 0,
    paid_date: "",
    parent_item_id: record.id
  });
}

function normalizeBetResult(result) {
  const map = {
    Win: "green",
    Loss: "red",
    Push: "void",
    green: "green",
    red: "red",
    void: "void",
    cashout: "cashout"
  };
  return map[result] || "red";
}

function prepareBetPayload(payload, existing = {}) {
  const merged = { ...existing, ...payload };
  merged.external_bet_id = String(merged.external_bet_id || "").trim();
  const stake = Number(merged.stake || 0);
  const odd = Number(merged.odd || 0);
  const status = merged.status || "pending";
  const settledResult = normalizeBetResult(merged.result);
  const cashoutValue = roundMoney(Number(merged.cashout_value ?? merged.cashoutValue ?? 0));
  const cashoutAvailable = Number(merged.cashout_available ?? merged.cashoutAvailable ?? 0) ? 1 : 0;
  let returnAmount = 0;
  let profitLoss = 0;
  let roi = 0;

  if (status !== "pending") {
    if (settledResult === "green") returnAmount = stake * odd;
    else if (settledResult === "void") returnAmount = stake;
    else if (settledResult === "cashout") returnAmount = Number(merged.return_amount || cashoutValue || 0);
    profitLoss = returnAmount - stake;
    roi = stake ? profitLoss / stake : 0;
  }

  return {
    ...merged,
    status,
    result: status === "pending" ? "void" : settledResult,
    odd,
    stake,
    return_amount: returnAmount,
    profit_loss: profitLoss,
    units: stake ? stake / defaultUnitValue : 0,
    roi,
    cashout_value: cashoutValue,
    cashout_available: status === "pending" ? cashoutAvailable : 0,
    cashout_unavailable_reason: String(merged.cashout_unavailable_reason ?? merged.cashoutUnavailableReason ?? "").trim(),
    cashout_at: merged.cashout_at || merged.cashoutAt || "",
    month: monthFromDate(merged.date)
  };
}

function bettingHouseAvailableBalance(name, excludeBetId = 0) {
  const row = get(`
    SELECT
      COALESCE(betting_houses.initial_balance, 0)
      + COALESCE(bets_summary.profit, 0)
      + COALESCE(bonuses_summary.bonus, 0)
      + COALESCE(movements_summary.adjustments, 0)
      + COALESCE(movements_summary.deposits, 0)
      - COALESCE(movements_summary.withdrawals, 0)
      - COALESCE(bets_summary.pending_stake, 0) AS available
    FROM betting_houses
    LEFT JOIN (
      SELECT betting_house,
        SUM(CASE WHEN status = 'settled' THEN profit_loss ELSE 0 END) AS profit,
        SUM(CASE WHEN status = 'pending' AND id <> ? THEN stake ELSE 0 END) AS pending_stake
      FROM bets
      GROUP BY betting_house
    ) bets_summary ON bets_summary.betting_house = betting_houses.name
    LEFT JOIN (
      SELECT betting_house, SUM(converted_value) AS bonus
      FROM betting_bonuses GROUP BY betting_house
    ) bonuses_summary ON bonuses_summary.betting_house = betting_houses.name
    LEFT JOIN (
      SELECT betting_house,
        SUM(CASE WHEN type IN ('Saque') THEN amount ELSE 0 END) AS withdrawals,
        SUM(CASE WHEN type = 'Deposito' THEN amount ELSE 0 END) AS deposits,
        SUM(CASE WHEN type = 'Ajuste' AND COALESCE(method, '') <> 'Cash Out' THEN amount ELSE 0 END) AS adjustments
      FROM betting_movements GROUP BY betting_house
    ) movements_summary ON movements_summary.betting_house = betting_houses.name
    WHERE betting_houses.name = ?
  `, [excludeBetId || 0, name]);
  return Number(row?.available || 0);
}

function assertBetHasAvailableBalance(payload, existing = {}) {
  if (payload.status !== "pending") return;
  if (existing.id && existing.status !== "pending") return;
  const stake = Number(payload.stake || 0);
  if (!stake) return;
  const available = bettingHouseAvailableBalance(payload.betting_house, existing.id || 0);
  if (stake <= available + 0.00001) return;
  console.warn(`[bets] Stake acima da banca livre em ${payload.betting_house}: disponivel ${formatMoneyBR(available)}, stake ${formatMoneyBR(stake)}. Salvando mesmo assim.`);
}

function prepareBonusPayload(payload) {
  return {
    ...payload,
    converted_value: Number(payload.converted_value || 0),
    used_in_bet: payload.used_in_bet || "Nao",
    month: monthFromDate(payload.date)
  };
}

function prepareMovementPayload(payload) {
  const typeMap = { Deposito: "Deposito", Saque: "Saque", Ajuste: "Ajuste" };
  return {
    ...payload,
    type: typeMap[payload.type] || payload.type,
    amount: Number(payload.amount || 0),
    month: monthFromDate(payload.date)
  };
}

function cashOutBet(id, payload = {}) {
  const record = get("SELECT * FROM bets WHERE id = ?", [id]);
  if (!record) {
    const error = new Error("Aposta nao encontrada.");
    error.status = 404;
    throw error;
  }
  if (record.status !== "pending") {
    const error = new Error("Apenas apostas ativas podem ter Cash Out.");
    error.status = 400;
    throw error;
  }
  const cashoutValue = roundMoney(Number(payload.cashout_value ?? payload.cashoutValue ?? record.cashout_value ?? 0));
  if (cashoutValue <= 0) {
    const error = new Error("Informe um valor de Cash Out maior que zero.");
    error.status = 400;
    throw error;
  }

  const now = currentDateTime();
  const prepared = prepareBetPayload({
    ...record,
    status: "settled",
    result: "cashout",
    return_amount: cashoutValue,
    cashout_value: cashoutValue,
    cashout_available: 0,
    cashout_at: now
  }, record);
  updateByFields("bets", fields.bets, id, prepared);

  const eventName = record.event || record.market || record.entry || `Aposta #${id}`;
  const movement = prepareMovementPayload({
    date: now,
    type: "Ajuste",
    betting_house: record.betting_house,
    method: "Cash Out",
    amount: cashoutValue,
    notes: [
      "Cash Out realizado",
      `ID aposta: #${id}`,
      `Aposta: ${eventName}`,
      `Valor apostado: ${formatMoneyBR(record.stake || 0)}`,
      `Valor recebido: ${formatMoneyBR(cashoutValue)}`
    ].join("\n")
  });
  insertByFields("betting_movements", bettingMovementFields, movement);
  recordTimeline("Cash Out realizado", `${eventName} - ${formatMoneyBR(cashoutValue)}`, "bets");

  return get("SELECT * FROM bets WHERE id = ?", [id]);
}

function revertCashOutBet(id) {
  const record = get("SELECT * FROM bets WHERE id = ?", [id]);
  if (!record) {
    const error = new Error("Aposta nao encontrada.");
    error.status = 404;
    throw error;
  }
  if (record.status !== "settled" || record.result !== "cashout") {
    const error = new Error("Somente apostas com Cash Out realizado podem ser revertidas por aqui.");
    error.status = 400;
    throw error;
  }

  const prepared = prepareBetPayload({
    ...record,
    status: "pending",
    result: "void",
    return_amount: 0,
    profit_loss: 0,
    roi: 0,
    cashout_value: 0,
    cashout_available: 0,
    cashout_at: ""
  }, record);
  updateByFields("bets", fields.bets, id, prepared);
  run(`
    DELETE FROM betting_movements
    WHERE method = 'Cash Out'
      AND betting_house = ?
      AND ABS(amount - ?) < 0.00001
      AND (date = ? OR notes LIKE ?)
  `, [record.betting_house, Number(record.return_amount || record.cashout_value || 0), record.cashout_at || "", `%ID aposta: #${id}%`]);
  recordTimeline("Cash Out revertido", `${record.event || record.market || `Aposta #${id}`} voltou para ativa`, "bets");
  return get("SELECT * FROM bets WHERE id = ?", [id]);
}

function insertByFields(table, allowed, payload) {
  const cols = allowed.filter((field) => payload[field] !== undefined);
  const values = cols.map((field) => payload[field]);
  const marks = cols.map(() => "?").join(", ");
  return run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks})`, values);
}

function updateByFields(table, allowed, id, payload) {
  const cols = allowed.filter((field) => payload[field] !== undefined);
  if (!cols.length) return;
  const assignments = cols.map((field) => `${field} = ?`).join(", ");
  run(`UPDATE ${table} SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...cols.map((field) => payload[field]), id]);
}

function deliveryMoney(value) {
  if (typeof value === "number") return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
  const text = String(value ?? "0").trim();
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text;
  const parsed = Number(normalized.replace(/[^\d.-]/g, ""));
  return Math.round((Number.isFinite(parsed) ? parsed : Number(value || 0)) * 100) / 100;
}

function deliveryNumber(value) {
  const parsed = Number(String(value ?? "0").replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function deliveryRemainingBalance(totalEarned, totalWithdrawn) {
  const earned = deliveryMoney(totalEarned);
  const withdrawn = deliveryMoney(totalWithdrawn);
  const remaining = deliveryMoney(earned - withdrawn);
  if (remaining <= 0) return 0;
  if (earned > 0 && withdrawn / earned >= 0.98 && remaining <= 25) return 0;
  return remaining;
}

function deliveryPlatform(value) {
  const text = String(value || "").trim();
  return text || "99";
}

function deliveryMonth(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : currentMonth();
}

function normalizeDeliveryDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} ${currentDateTime().slice(11)}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return normalizeDateTime(text);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) return normalizeDateTime(text);
  return currentDateTime();
}

function deliveryHoursFromTimes(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = String(startTime).split(":").map(Number);
  const [eh, em] = String(endTime).split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  let start = sh * 60 + sm;
  let end = eh * 60 + em;
  if (end < start) end += 24 * 60;
  return Math.round(((end - start) / 60) * 100) / 100;
}

function normalizeDeliveryEntryPayload(payload, userId) {
  const start_time = String(payload.start_time || "").slice(0, 5);
  const end_time = String(payload.end_time || "").slice(0, 5);
  const hours = deliveryNumber(payload.hours_worked) || deliveryHoursFromTimes(start_time, end_time);
  return {
    user_id: userId,
    date: normalizeDeliveryDate(payload.date),
    platform: deliveryPlatform(payload.platform),
    trips: Math.max(0, Math.round(deliveryNumber(payload.trips))),
    earned_amount: deliveryMoney(payload.earned_amount),
    kilometers: Math.max(0, deliveryNumber(payload.kilometers)),
    start_time,
    end_time,
    hours_worked: Math.max(0, hours),
    notes: String(payload.notes || "").trim()
  };
}

function normalizeDeliveryWithdrawalPayload(payload, userId) {
  return {
    user_id: userId,
    date: normalizeDeliveryDate(payload.date),
    platform: deliveryPlatform(payload.platform),
    amount: Math.max(0, deliveryMoney(payload.amount)),
    notes: String(payload.notes || "").trim()
  };
}

function normalizeDeliveryGoalPayload(payload, userId) {
  return {
    user_id: userId,
    month: deliveryMonth(payload.month),
    platform: deliveryPlatform(payload.platform || "Geral"),
    daily_goal: Math.max(0, deliveryMoney(payload.daily_goal)),
    weekly_goal: Math.max(0, deliveryMoney(payload.weekly_goal)),
    monthly_goal: Math.max(0, deliveryMoney(payload.monthly_goal)),
    notes: String(payload.notes || "").trim()
  };
}

function deliveryGoalFor(goals, platform) {
  return goals.find((goal) => goal.platform === platform) || goals.find((goal) => goal.platform === "Geral") || {};
}

function deliveryGoalStatus(total, goal) {
  if (!goal) return "Sem meta";
  if (!total) return "Nao trabalhou";
  return total >= goal ? "Meta batida" : "Meta nao batida";
}

function deliveryDateOnly(dateText) {
  return String(dateText || "").slice(0, 10);
}

function deliveryWeekStart(dateText) {
  const date = new Date(`${deliveryDateOnly(dateText) || todayDate()}T12:00:00`);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.toISOString().slice(0, 10);
}

function deliveryAddDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function listDeliveries(userId, query) {
  const period = ["month", "year", "all"].includes(query.get("period")) ? query.get("period") : "month";
  const month = deliveryMonth(query.get("month"));
  const yearText = String(query.get("year") || month.slice(0, 4) || todayDate().slice(0, 4)).trim();
  const year = /^\d{4}$/.test(yearText) ? yearText : todayDate().slice(0, 4);
  const platform = deliveryPlatform(query.get("platform") || "");
  const selectedPlatform = query.get("platform") ? platform : "";
  let dateWhere = " AND substr(date, 1, 7) = ?";
  let values = [userId, month];
  if (period === "year") {
    dateWhere = " AND substr(date, 1, 4) = ?";
    values = [userId, year];
  } else if (period === "all") {
    dateWhere = "";
    values = [userId];
  }
  const wherePlatform = selectedPlatform ? " AND platform = ?" : "";
  if (selectedPlatform) values.push(selectedPlatform);
  const entries = all(`SELECT * FROM delivery_entries WHERE user_id = ?${dateWhere}${wherePlatform} ORDER BY date DESC, id DESC`, values);
  const withdrawals = all(`SELECT * FROM delivery_withdrawals WHERE user_id = ?${dateWhere}${wherePlatform} ORDER BY date DESC, id DESC`, values);
  const goals = all("SELECT * FROM delivery_goals WHERE user_id = ? AND month = ? ORDER BY platform", [userId, month]);
  const platforms = [...new Set([
    "99",
    "iFood",
    ...all("SELECT DISTINCT platform FROM delivery_entries WHERE user_id = ? UNION SELECT DISTINCT platform FROM delivery_withdrawals WHERE user_id = ?", [userId, userId]).map((item) => item.platform).filter(Boolean),
    ...goals.map((item) => item.platform).filter((item) => item && item !== "Geral")
  ])].sort((a, b) => a.localeCompare(b, "pt-BR"));

  const totalEarned = entries.reduce((sum, item) => sum + Number(item.earned_amount || 0), 0);
  const totalWithdrawn = withdrawals.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalTrips = entries.reduce((sum, item) => sum + Number(item.trips || 0), 0);
  const totalKm = entries.reduce((sum, item) => sum + Number(item.kilometers || 0), 0);
  const totalHours = entries.reduce((sum, item) => sum + Number(item.hours_worked || 0), 0);
  const activeGoal = selectedPlatform ? deliveryGoalFor(goals, selectedPlatform) : goals.find((goal) => goal.platform === "Geral") || goals[0] || {};

  const entriesWithGoal = entries.map((item) => {
    const goal = deliveryGoalFor(goals, item.platform);
    return { ...item, goal_status: deliveryGoalStatus(Number(item.earned_amount || 0), Number(goal.daily_goal || 0)) };
  });

  const weekMap = new Map();
  for (const item of entries) {
    const key = deliveryWeekStart(item.date);
    const row = weekMap.get(key) || { week_start: key, week_end: deliveryAddDays(key, 6), total_earned: 0, total_trips: 0, total_km: 0, total_hours: 0, days_worked: 0 };
    row.total_earned += Number(item.earned_amount || 0);
    row.total_trips += Number(item.trips || 0);
    row.total_km += Number(item.kilometers || 0);
    row.total_hours += Number(item.hours_worked || 0);
    row.days_worked += Number(item.earned_amount || 0) || Number(item.trips || 0) ? 1 : 0;
    weekMap.set(key, row);
  }
  const weeks = [...weekMap.values()].sort((a, b) => b.week_start.localeCompare(a.week_start)).map((row) => {
    const goal = Number(activeGoal.weekly_goal || 0);
    return {
      ...row,
      avg_per_day: row.days_worked ? row.total_earned / row.days_worked : 0,
      goal_status: deliveryGoalStatus(row.total_earned, goal)
    };
  });

  const platformMap = new Map();
  for (const item of entries) {
    const row = platformMap.get(item.platform) || { platform: item.platform, total_earned: 0, total_withdrawn: 0, remaining_to_withdraw: 0, total_trips: 0, total_km: 0 };
    row.total_earned += Number(item.earned_amount || 0);
    row.total_trips += Number(item.trips || 0);
    row.total_km += Number(item.kilometers || 0);
    platformMap.set(item.platform, row);
  }
  for (const item of withdrawals) {
    const row = platformMap.get(item.platform) || { platform: item.platform, total_earned: 0, total_withdrawn: 0, remaining_to_withdraw: 0, total_trips: 0, total_km: 0 };
    row.total_withdrawn += Number(item.amount || 0);
    platformMap.set(item.platform, row);
  }
  const platformSummary = [...platformMap.values()]
    .map((row) => ({ ...row, remaining_to_withdraw: deliveryRemainingBalance(row.total_earned, row.total_withdrawn) }))
    .sort((a, b) => a.platform.localeCompare(b.platform, "pt-BR"));

  return {
    period,
    month,
    year,
    platform: selectedPlatform,
    platforms,
    entries: entriesWithGoal,
    withdrawals,
    goals,
    weeks,
    platformSummary,
    summary: {
      total_earned: totalEarned,
      total_withdrawn: totalWithdrawn,
      remaining_to_withdraw: deliveryRemainingBalance(totalEarned, totalWithdrawn),
      total_trips: totalTrips,
      total_km: totalKm,
      total_hours: totalHours,
      avg_per_trip: totalTrips ? totalEarned / totalTrips : 0,
      avg_per_km: totalKm ? totalEarned / totalKm : 0,
      avg_per_hour: totalHours ? totalEarned / totalHours : 0,
      monthly_goal: Number(activeGoal.monthly_goal || 0),
      goal_status: deliveryGoalStatus(totalEarned, Number(activeGoal.monthly_goal || 0))
    }
  };
}

function upsertBettingHouseName(name) {
  if (name) run("INSERT OR IGNORE INTO betting_houses (name, status) VALUES (?, 'Ativa')", [name]);
}

function listBettingHouses() {
  return all(`
    SELECT
      betting_houses.*,
      COALESCE(bets_summary.profit, 0) AS betting_profit,
      COALESCE(bets_summary.losses, 0) AS betting_losses,
      COALESCE(bets_summary.stake, 0) AS stake,
      COALESCE(bets_summary.pending_stake, 0) AS pending_stake,
      COALESCE(bets_summary.total, 0) AS bet_count,
      COALESCE(bonuses_summary.bonus, 0) AS bonus_total,
      COALESCE(movements_summary.deposits, 0) AS deposits,
      COALESCE(movements_summary.withdrawals, 0) AS withdrawals,
      COALESCE(movements_summary.adjustments, 0) AS adjustments,
      COALESCE(bets_summary.profit, 0) + COALESCE(bonuses_summary.bonus, 0) + COALESCE(movements_summary.adjustments, 0) AS real_result,
      betting_houses.initial_balance + COALESCE(bets_summary.profit, 0) + COALESCE(bonuses_summary.bonus, 0) + COALESCE(movements_summary.adjustments, 0) + COALESCE(movements_summary.deposits, 0) - COALESCE(movements_summary.withdrawals, 0) - COALESCE(bets_summary.pending_stake, 0) AS estimated_bankroll,
      CASE WHEN COALESCE(bets_summary.stake, 0) = 0 THEN 0 ELSE COALESCE(bets_summary.profit, 0) / bets_summary.stake END AS roi
    FROM betting_houses
      LEFT JOIN (
      SELECT
        betting_house,
        SUM(CASE WHEN status = 'settled' THEN profit_loss ELSE 0 END) AS profit,
        SUM(CASE WHEN status = 'settled' AND result = 'red' THEN ABS(profit_loss) ELSE 0 END) AS losses,
        SUM(CASE WHEN status = 'settled' THEN stake ELSE 0 END) AS stake,
        SUM(CASE WHEN status = 'pending' THEN stake ELSE 0 END) AS pending_stake,
        COUNT(*) AS total
      FROM bets
      GROUP BY betting_house
    ) bets_summary ON bets_summary.betting_house = betting_houses.name
    LEFT JOIN (
      SELECT betting_house, SUM(converted_value) AS bonus
      FROM betting_bonuses GROUP BY betting_house
    ) bonuses_summary ON bonuses_summary.betting_house = betting_houses.name
    LEFT JOIN (
      SELECT betting_house,
        SUM(CASE WHEN type LIKE 'Dep%' THEN amount ELSE 0 END) AS deposits,
        SUM(CASE WHEN type = 'Saque' THEN amount ELSE 0 END) AS withdrawals,
        SUM(CASE WHEN type = 'Ajuste' AND COALESCE(method, '') <> 'Cash Out' THEN amount ELSE 0 END) AS adjustments
      FROM betting_movements GROUP BY betting_house
    ) movements_summary ON movements_summary.betting_house = betting_houses.name
    ORDER BY betting_houses.name
  `).map((house) => ({
    ...house,
    initial_balance: roundMoney(house.initial_balance),
    betting_profit: roundMoney(house.betting_profit),
    betting_losses: roundMoney(house.betting_losses),
    stake: roundMoney(house.stake),
    pending_stake: roundMoney(house.pending_stake),
    bonus_total: roundMoney(house.bonus_total),
    deposits: roundMoney(house.deposits),
    withdrawals: roundMoney(house.withdrawals),
    adjustments: roundMoney(house.adjustments),
    real_result: roundMoney(house.real_result),
    estimated_bankroll: roundMoney(house.estimated_bankroll)
  }));
}

function bettingTotals() {
  const bets = get(`SELECT
    COALESCE(SUM(CASE WHEN status = 'settled' THEN stake ELSE 0 END), 0) AS total_staked,
    COALESCE(SUM(CASE WHEN status = 'settled' THEN profit_loss ELSE 0 END), 0) AS betting_profit,
    COUNT(*) AS total_bets,
    COALESCE(SUM(CASE WHEN status = 'settled' AND result = 'green' THEN 1 ELSE 0 END), 0) AS wins,
    COALESCE(SUM(CASE WHEN status = 'settled' AND result = 'red' THEN 1 ELSE 0 END), 0) AS losses,
    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_bets,
    COALESCE(SUM(CASE WHEN status = 'pending' THEN stake ELSE 0 END), 0) AS pending_stake
    FROM bets`);
  const bonuses = get("SELECT COALESCE(SUM(converted_value), 0) AS bonus_total FROM betting_bonuses");
  const movements = get(`SELECT
    COALESCE(SUM(CASE WHEN type LIKE 'Dep%' THEN amount ELSE 0 END), 0) AS deposits,
    COALESCE(SUM(CASE WHEN type = 'Saque' THEN amount ELSE 0 END), 0) AS withdrawals,
    COALESCE(SUM(CASE WHEN type = 'Ajuste' AND COALESCE(method, '') <> 'Cash Out' THEN amount ELSE 0 END), 0) AS adjustments
    FROM betting_movements`);
  const houses = get(`SELECT
    COALESCE(SUM(initial_balance), 0) AS initial_bankroll,
    COALESCE(SUM(monthly_goal), 0) AS monthly_goal,
    COALESCE(SUM(monthly_loss_limit), 0) AS monthly_loss_limit
    FROM betting_houses`);
  const realResult = bets.betting_profit + bonuses.bonus_total + movements.adjustments;
  return {
    ...bets,
    ...bonuses,
    ...movements,
    ...houses,
    real_result: roundMoney(realResult),
    betting_roi: bets.total_staked ? bets.betting_profit / bets.total_staked : 0,
    real_roi: bets.total_staked ? realResult / bets.total_staked : 0,
    win_rate: bets.wins + bets.losses ? bets.wins / (bets.wins + bets.losses) : 0,
    estimated_bankroll: roundMoney(houses.initial_bankroll + realResult + movements.deposits - movements.withdrawals - bets.pending_stake),
    total_staked: roundMoney(bets.total_staked),
    betting_profit: roundMoney(bets.betting_profit),
    pending_stake: roundMoney(bets.pending_stake),
    bonus_total: roundMoney(bonuses.bonus_total),
    deposits: roundMoney(movements.deposits),
    withdrawals: roundMoney(movements.withdrawals),
    adjustments: roundMoney(movements.adjustments),
    initial_bankroll: roundMoney(houses.initial_bankroll),
    monthly_goal: roundMoney(houses.monthly_goal),
    monthly_loss_limit: roundMoney(houses.monthly_loss_limit)
  };
}

function bettingDashboard() {
  return {
    totals: bettingTotals(),
    houses: listBettingHouses().slice(0, 12),
    latestBets: all("SELECT * FROM bets ORDER BY date DESC, id DESC LIMIT 8"),
    latestBonuses: all("SELECT * FROM betting_bonuses ORDER BY date DESC, id DESC LIMIT 6"),
    latestMovements: all("SELECT * FROM betting_movements ORDER BY date DESC, id DESC LIMIT 6"),
    monthly: bettingMonthly()
  };
}

function bettingMonthly() {
  return all(`
    SELECT month,
      SUM(betting_profit) AS betting_profit,
      SUM(bonus_total) AS bonus_total,
      SUM(adjustments) AS adjustments,
      SUM(stake) AS stake,
      SUM(deposits) AS deposits,
      SUM(withdrawals) AS withdrawals,
      SUM(betting_profit) + SUM(bonus_total) + SUM(adjustments) AS real_result,
      CASE WHEN SUM(stake) = 0 THEN 0 ELSE SUM(betting_profit) / SUM(stake) END AS roi
    FROM (
      SELECT month, SUM(profit_loss) AS betting_profit, 0 AS bonus_total, 0 AS adjustments, SUM(stake) AS stake, 0 AS deposits, 0 AS withdrawals FROM bets WHERE status = 'settled' GROUP BY month
      UNION ALL
      SELECT month, 0, SUM(converted_value), 0, 0, 0, 0 FROM betting_bonuses GROUP BY month
      UNION ALL
      SELECT month, 0, 0, SUM(CASE WHEN type = 'Ajuste' AND COALESCE(method, '') <> 'Cash Out' THEN amount ELSE 0 END), 0, 
        SUM(CASE WHEN type = 'Deposito' THEN amount ELSE 0 END),
        SUM(CASE WHEN type = 'Saque' THEN amount ELSE 0 END)
      FROM betting_movements GROUP BY month
    )
    WHERE month IS NOT NULL AND month <> ''
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `);
}

function bettingAnalyses() {
  const bySport = all(`
    SELECT sport, COUNT(*) AS total, COALESCE(SUM(stake), 0) AS stake, COALESCE(SUM(profit_loss), 0) AS profit,
      CASE WHEN COALESCE(SUM(stake), 0) = 0 THEN 0 ELSE COALESCE(SUM(profit_loss), 0) / SUM(stake) END AS roi,
      COALESCE(SUM(CASE WHEN result = 'green' THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN result = 'red' THEN 1 ELSE 0 END), 0) AS losses
    FROM bets WHERE status = 'settled' GROUP BY sport ORDER BY profit DESC
  `);
  const byMarket = all(`
    SELECT market, COUNT(*) AS total, COALESCE(SUM(stake), 0) AS stake, COALESCE(SUM(profit_loss), 0) AS profit,
      CASE WHEN COALESCE(SUM(stake), 0) = 0 THEN 0 ELSE COALESCE(SUM(profit_loss), 0) / SUM(stake) END AS roi
    FROM bets WHERE status = 'settled' GROUP BY market ORDER BY profit DESC LIMIT 12
  `);
  const byBonusType = all(`
    SELECT type, COUNT(*) AS total, COALESCE(SUM(converted_value), 0) AS converted_value,
      COALESCE(SUM(CASE WHEN used_in_bet = 'Sim' THEN converted_value ELSE 0 END), 0) AS used_value,
      COALESCE(SUM(CASE WHEN used_in_bet <> 'Sim' THEN converted_value ELSE 0 END), 0) AS unused_value
    FROM betting_bonuses GROUP BY type ORDER BY converted_value DESC
  `);
  return { bySport, byMarket, byBonusType };
}

function biStatusLabel(status = "") {
  const labels = {
    not_started: "Nao iniciado",
    in_progress: "Em andamento",
    done: "Concluido",
    pending: "Pendente",
    paid: "Pago",
    canceled: "Cancelado",
    active: "Ativo"
  };
  return labels[String(status || "").toLowerCase()] || status || "Sem status";
}

function biMonthSeries(rows, months, valueKey = "total") {
  const byMonth = rows.reduce((acc, row) => {
    acc[String(row.month || "").slice(0, 7)] = Number(row[valueKey] || 0);
    return acc;
  }, {});
  return months.map((month) => ({ label: month, total: roundMoney(byMonth[month] || 0) }));
}

function biMonthKeys(month = currentMonth(), total = 6) {
  return Array.from({ length: total }, (_, index) => addMonths(`${month}-01`, index - (total - 1)).slice(0, 7));
}

function biCountBy(rows, key, labelKey = "label", valueKey = "total") {
  return Object.entries(rows.reduce((acc, item) => {
    const label = item[key] || "Sem informacao";
    acc[label] = Number(acc[label] || 0) + 1;
    return acc;
  }, {})).map(([label, total]) => ({ [labelKey]: label, [valueKey]: total }));
}

function biMoneyRows(rows, labelKey = "label", valueKey = "total") {
  return rows.map((row) => ({ ...row, [labelKey]: row[labelKey] || row.category || row.type || row.status || "Sem informacao", [valueKey]: roundMoney(row[valueKey] || 0) }));
}

function biUsageTrack(userId, payload = {}) {
  const duration = Math.max(0, Math.min(600, Math.round(Number(payload.duration_seconds || 0))));
  if (!duration) return { ok: true, ignored: true };
  run(`
    INSERT INTO bi_usage_logs (user_id, module, module_title, duration_seconds, music_id, music_title, music_artist, music_playing, activity_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    userId,
    String(payload.module || "dashboard").slice(0, 80),
    String(payload.module_title || payload.module || "Modulo").slice(0, 120),
    duration,
    payload.music_id ? String(payload.music_id).slice(0, 80) : "",
    payload.music_title ? String(payload.music_title).slice(0, 180) : "",
    payload.music_artist ? String(payload.music_artist).slice(0, 160) : "",
    payload.music_playing ? 1 : 0,
    todayDate(),
    currentDateTime()
  ]);
  return { ok: true };
}

function biFinance(month) {
  const accounts = accountBalances();
  const months = biMonthKeys(month, 6);
  const current = get(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'entrada' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'saida' THEN amount ELSE 0 END), 0) AS expense,
      COALESCE(SUM(CASE WHEN type = 'transferencia' THEN amount ELSE 0 END), 0) AS transfers
    FROM financial_transactions
    WHERE substr(date, 1, 7) = ?
  `, [month]) || {};
  const monthlyRows = all(`
    SELECT substr(date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN type = 'entrada' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'saida' THEN amount ELSE 0 END), 0) AS expense
    FROM financial_transactions
    WHERE substr(date, 1, 7) >= ?
    GROUP BY substr(date, 1, 7)
    ORDER BY month
  `, [months[0]]);
  const byMonth = months.map((item) => {
    const row = monthlyRows.find((entry) => entry.month === item) || {};
    return { label: item, entradas: roundMoney(row.income || 0), saidas: roundMoney(row.expense || 0), saldo: roundMoney(Number(row.income || 0) - Number(row.expense || 0)) };
  });
  const categories = biMoneyRows(all(`
    SELECT category AS label, COALESCE(SUM(amount), 0) AS total
    FROM financial_transactions
    WHERE type = 'saida' AND substr(date, 1, 7) = ?
    GROUP BY category
    ORDER BY total DESC
    LIMIT 8
  `, [month]));
  const paymentMethods = biMoneyRows(all(`
    SELECT COALESCE(payment_method, 'Sem metodo') AS label, COALESCE(SUM(amount), 0) AS total
    FROM financial_transactions
    WHERE type = 'saida' AND substr(date, 1, 7) = ?
    GROUP BY payment_method
    ORDER BY total DESC
    LIMIT 8
  `, [month]));
  const planning = get(`
    SELECT COALESCE(SUM(amount), 0) AS planned, COALESCE(SUM(paid_amount), 0) AS paid,
      COALESCE(SUM(CASE WHEN status NOT IN ('paid','canceled') THEN amount - paid_amount ELSE 0 END), 0) AS open
    FROM planning_items
    WHERE month = ?
  `, [month]) || {};
  return {
    total_balance: roundMoney(accounts.reduce((sum, account) => sum + Number(account.total_balance || 0), 0)),
    income: roundMoney(current.income || 0),
    expense: roundMoney(current.expense || 0),
    result: roundMoney(Number(current.income || 0) - Number(current.expense || 0)),
    transfers: roundMoney(current.transfers || 0),
    accounts: accounts.map((account) => ({ label: `${account.bank} - ${account.name}`, total: roundMoney(account.total_balance || 0) })).sort((a, b) => b.total - a.total).slice(0, 8),
    byMonth,
    categories,
    paymentMethods,
    planning: {
      planned: roundMoney(planning.planned || 0),
      paid: roundMoney(planning.paid || 0),
      open: roundMoney(planning.open || 0)
    }
  };
}

function biVehicles(userId, month) {
  const months = biMonthKeys(month, 6);
  const fuelMonth = get(`
    SELECT COALESCE(SUM(total_value), 0) AS total, COALESCE(SUM(liters), 0) AS liters,
      CASE WHEN COALESCE(SUM(liters), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_value), 0) / SUM(liters) END AS avg_price,
      COUNT(*) AS entries
    FROM motorcycle_fuel_logs
    WHERE user_id = ? AND substr(date, 1, 7) = ?
  `, [userId, month]) || {};
  const fuelMonthly = biMonthSeries(all(`
    SELECT substr(date, 1, 7) AS month, COALESCE(SUM(total_value), 0) AS total
    FROM motorcycle_fuel_logs
    WHERE user_id = ? AND substr(date, 1, 7) >= ?
    GROUP BY substr(date, 1, 7)
  `, [userId, months[0]]), months);
  const fuelByType = biMoneyRows(all(`
    SELECT COALESCE(fuel_type, 'Combustivel') AS label, COALESCE(SUM(total_value), 0) AS total
    FROM motorcycle_fuel_logs
    WHERE user_id = ? AND substr(date, 1, 7) = ?
    GROUP BY fuel_type
    ORDER BY total DESC
  `, [userId, month]));
  const maintenance = get(`
    SELECT
      COALESCE((SELECT SUM(oil_value + labor_value) FROM motorcycle_oil_changes WHERE user_id = ? AND substr(date, 1, 7) = ?), 0) AS oil,
      COALESCE((SELECT SUM(parts_value + labor_value) FROM motorcycle_maintenance_logs WHERE user_id = ? AND substr(date, 1, 7) = ?), 0) AS maintenance,
      COALESCE((SELECT SUM(value) FROM motorcycle_tire_logs WHERE user_id = ? AND substr(date, 1, 7) = ?), 0) AS tires,
      COALESCE((SELECT SUM(amount) FROM motorcycle_documents WHERE user_id = ? AND substr(COALESCE(paid_date, due_date), 1, 7) = ?), 0) AS documents,
      COALESCE((SELECT SUM(amount) FROM motorcycle_expenses WHERE user_id = ? AND substr(date, 1, 7) = ?), 0) AS extras
  `, [userId, month, userId, month, userId, month, userId, month, userId, month]) || {};
  const maintenanceRows = [
    { label: "Oleo", total: roundMoney(maintenance.oil || 0) },
    { label: "Manutencao", total: roundMoney(maintenance.maintenance || 0) },
    { label: "Pneus", total: roundMoney(maintenance.tires || 0) },
    { label: "Documentos", total: roundMoney(maintenance.documents || 0) },
    { label: "Extras", total: roundMoney(maintenance.extras || 0) }
  ].filter((item) => item.total > 0);
  return {
    fuel_total: roundMoney(fuelMonth.total || 0),
    liters: roundMoney(fuelMonth.liters || 0),
    avg_price: roundMoney(fuelMonth.avg_price || 0),
    entries: Number(fuelMonth.entries || 0),
    maintenance_total: roundMoney(maintenanceRows.reduce((sum, item) => sum + item.total, 0)),
    fuelMonthly,
    fuelByType,
    maintenanceRows
  };
}

function biGoalsProjects(userId) {
  const life = listLifeObjectives(userId);
  const personalGoals = all("SELECT * FROM personal_goals WHERE user_id = ?", [userId]);
  const personalProjects = all("SELECT * FROM personal_projects WHERE user_id = ?", [userId]);
  const oldProjects = all("SELECT * FROM projects ORDER BY updated_at DESC");
  const lifeByStatus = Object.entries(life.summary || {}).filter(([key]) => ["not_started", "in_progress", "done"].includes(key)).map(([key, total]) => ({ label: biStatusLabel(key), total: Number(total || 0) }));
  const lifeByCategory = biCountBy(life.items || [], "category").sort((a, b) => b.total - a.total).slice(0, 8);
  return {
    life_summary: life.summary,
    lifeByStatus,
    lifeByCategory,
    personalGoalStatus: biCountBy(personalGoals, "status"),
    personalProjectStatus: biCountBy(personalProjects, "status"),
    projectsStatus: biCountBy(oldProjects, "status"),
    avg_goal_progress: roundMoney(personalGoals.length ? personalGoals.reduce((sum, item) => sum + Number(item.progress || 0), 0) / personalGoals.length : 0),
    avg_project_progress: roundMoney(personalProjects.length ? personalProjects.reduce((sum, item) => sum + Number(item.progress || 0), 0) / personalProjects.length : 0),
    next_targets: [
      ...life.items.filter((item) => item.target_date && item.status !== "done").map((item) => ({ title: item.title, date: item.target_date, kind: "Objetivo" })),
      ...personalGoals.filter((item) => item.due_date && item.status !== "concluido").map((item) => ({ title: item.title, date: item.due_date, kind: "Meta" })),
      ...personalProjects.filter((item) => item.expected_end_date && item.status !== "concluido").map((item) => ({ title: item.name, date: item.expected_end_date, kind: "Projeto" }))
    ].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 8)
  };
}

function biBets() {
  const dashboard = bettingDashboard();
  const analyses = bettingAnalyses();
  return {
    totals: dashboard.totals,
    monthly: dashboard.monthly.map((item) => ({ label: item.month, total: roundMoney(item.real_result || 0), stake: roundMoney(item.stake || 0), roi: Number(item.roi || 0) })),
    bySport: analyses.bySport.map((item) => ({ label: item.sport || "Esporte", total: roundMoney(item.profit || 0), stake: roundMoney(item.stake || 0), roi: Number(item.roi || 0) })).slice(0, 8),
    byMarket: analyses.byMarket.map((item) => ({ label: item.market || "Mercado", total: roundMoney(item.profit || 0), stake: roundMoney(item.stake || 0), roi: Number(item.roi || 0) })).slice(0, 8),
    latest: dashboard.latestBets.slice(0, 5)
  };
}

function biSubscriptions(userId, month) {
  const active = all("SELECT * FROM recurring_subscriptions WHERE user_id = ? AND status <> 'Cancelada'", [userId]);
  const payments = get("SELECT COALESCE(SUM(amount_paid), 0) AS total FROM subscription_payments WHERE user_id = ? AND substr(payment_date, 1, 7) = ?", [userId, month]) || {};
  const monthlyEstimate = active.reduce((sum, item) => sum + Number(item.my_share || item.amount || 0), 0);
  return {
    active_total: active.length,
    monthly_estimate: roundMoney(monthlyEstimate),
    paid_month: roundMoney(payments.total || 0),
    byCategory: biMoneyRows(all(`
      SELECT COALESCE(category, 'Sem categoria') AS label, COALESCE(SUM(CASE WHEN my_share > 0 THEN my_share ELSE amount END), 0) AS total
      FROM recurring_subscriptions
      WHERE user_id = ? AND status <> 'Cancelada'
      GROUP BY category
      ORDER BY total DESC
      LIMIT 8
    `, [userId])),
    nextCharges: active
      .filter((item) => item.next_charge_date)
      .sort((a, b) => String(a.next_charge_date).localeCompare(String(b.next_charge_date)))
      .slice(0, 8)
      .map((item) => ({ title: item.name, date: item.next_charge_date, total: roundMoney(item.my_share || item.amount || 0), category: item.category || "" }))
  };
}

function biUsage(userId) {
  const total = get("SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM bi_usage_logs WHERE user_id = ?", [userId])?.total || 0;
  const today = get("SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM bi_usage_logs WHERE user_id = ? AND activity_date = ?", [userId, todayDate()])?.total || 0;
  const byModule = all(`
    SELECT module_title AS label, COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM bi_usage_logs
    WHERE user_id = ?
    GROUP BY module
    ORDER BY seconds DESC
    LIMIT 10
  `, [userId]);
  const daily = all(`
    SELECT activity_date AS label, COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM bi_usage_logs
    WHERE user_id = ? AND activity_date >= date('now','localtime','-13 days')
    GROUP BY activity_date
    ORDER BY activity_date
  `, [userId]);
  const music = all(`
    SELECT COALESCE(NULLIF(music_title, ''), 'Musica sem nome') AS label, COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM bi_usage_logs
    WHERE user_id = ? AND music_playing = 1
    GROUP BY music_id, music_title
    ORDER BY seconds DESC
    LIMIT 8
  `, [userId]);
  return {
    total_seconds: Number(total || 0),
    today_seconds: Number(today || 0),
    byModule,
    daily,
    music,
    favorite_module: byModule[0] || null,
    favorite_music: music[0] || null
  };
}

function biVendinha(userId, month) {
  const summary = get("SELECT COALESCE(SUM(total_value), 0) AS total, COUNT(*) AS entries FROM vendinha_consumptions WHERE user_id = ? AND substr(date, 1, 7) = ?", [userId, month]) || {};
  const open = get("SELECT COALESCE(SUM(total_value), 0) AS total FROM vendinha_consumptions WHERE user_id = ? AND substr(date, 1, 7) = ? AND status = 'open'", [userId, month]) || {};
  return {
    total: roundMoney(summary.total || 0),
    open: roundMoney(open.total || 0),
    entries: Number(summary.entries || 0),
    byProduct: biMoneyRows(all(`
      SELECT product_name AS label, COALESCE(SUM(total_value), 0) AS total
      FROM vendinha_consumptions
      WHERE user_id = ? AND substr(date, 1, 7) = ?
      GROUP BY product_name
      ORDER BY total DESC
      LIMIT 8
    `, [userId, month]))
  };
}

function biCodex(userId) {
  const rows = all("SELECT * FROM codex_accounts WHERE user_id = ?", [userId]);
  const now = currentDateTime();
  const available = rows.filter((item) => !item.next_available_at || String(item.next_available_at) <= now).length;
  return {
    total: rows.length,
    available,
    waiting: Math.max(0, rows.length - available),
    byPlan: biCountBy(rows, "plan"),
    phoneLinked: rows.filter((item) => Number(item.phone_linked || 0)).length
  };
}

function biInsights(data) {
  const insights = [];
  if (data.finance.expense > data.finance.income && data.finance.expense > 0) insights.push({ tone: "danger", title: "Saidas acima das entradas", text: "Neste mes voce gastou mais do que entrou. Vale olhar categorias e formas de pagamento." });
  if (data.vehicles.fuel_total > 0) insights.push({ tone: "info", title: "Combustivel monitorado", text: `Gasolina/combustivel no mes: ${formatMoneyBR(data.vehicles.fuel_total)} em ${data.vehicles.entries} registro(s).` });
  if ((data.goals.life_summary?.progress || 0) < 30 && (data.goals.life_summary?.total || 0) > 0) insights.push({ tone: "warn", title: "Metas precisam de movimento", text: "Seu progresso geral de objetivos ainda esta baixo. Abrir um objetivo por vez pode destravar bem." });
  if (data.bets.totals?.real_result < 0) insights.push({ tone: "danger", title: "Apostas negativas", text: "O resultado real das apostas esta negativo. Bom revisar esporte, mercado e stake." });
  if (data.usage.favorite_module) insights.push({ tone: "positive", title: "Modulo mais usado", text: `${data.usage.favorite_module.label} e onde voce mais passou tempo no sistema.` });
  if (!insights.length) insights.push({ tone: "positive", title: "Sistema em ordem", text: "Ainda nao apareceu nenhum alerta forte. Continue alimentando os dados para o BI ficar mais inteligente." });
  return insights.slice(0, 6);
}

function biOverview(userId, month = currentMonth()) {
  const finance = biFinance(month);
  const vehicles = biVehicles(userId, month);
  const goals = biGoalsProjects(userId);
  const bets = biBets();
  const subscriptions = biSubscriptions(userId, month);
  const usage = biUsage(userId);
  const vendinha = biVendinha(userId, month);
  const codex = biCodex(userId);
  const data = { month, generated_at: currentDateTime(), finance, vehicles, goals, bets, subscriptions, usage, vendinha, codex };
  return { ...data, insights: biInsights(data) };
}

const galleryImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const galleryVideoExtensions = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const galleryFolders = ["Fotos", "Videos", "Thumbnails", "Compressed", "Downloads", "Albuns"];

function safeFileName(value = "arquivo") {
  return path.basename(String(value || "arquivo")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180) || "arquivo";
}

function galleryExt(name = "") {
  return path.extname(String(name || "")).toLowerCase();
}

function galleryMediaType(ext = "") {
  if (galleryImageExtensions.has(ext)) return "foto";
  if (galleryVideoExtensions.has(ext)) return "video";
  return "";
}

async function ensureGalleryStorage() {
  await mkdir(galleryRootDir, { recursive: true });
  await Promise.all(galleryFolders.map((folder) => mkdir(path.join(galleryRootDir, folder), { recursive: true })));
}

function assertGalleryPath(filePath = "") {
  const resolved = path.resolve(filePath);
  const relative = path.relative(galleryRootDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error("Caminho de galeria invalido.");
    error.statusCode = 403;
    throw error;
  }
  return resolved;
}

function resolveGalleryStoredPath(filePath = "") {
  const raw = String(filePath || "").trim();
  if (!raw) return "";

  // Caminhos ja gravados com a raiz atual podem ser usados diretamente.
  const direct = path.resolve(raw);
  const directRelative = path.relative(galleryRootDir, direct);
  if (directRelative !== ".." && !directRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(directRelative)) {
    return direct;
  }

  // Registros antigos podem conter uma letra de unidade ou uma raiz anterior.
  // Aproveitamos somente o trecho relativo depois de DRSOStorage/Galeria e o
  // remontamos sob a raiz configurada; assertGalleryPath bloqueia qualquer "..".
  const parts = raw.split(/[\\/]+/);
  const storageIndex = parts.findIndex((part, index) => (
    part.toLowerCase() === "drsostorage"
    && ["galeria", "gallery"].includes(parts[index + 1]?.toLowerCase())
  ));
  if (storageIndex >= 0) {
    return assertGalleryPath(path.join(galleryRootDir, ...parts.slice(storageIndex + 2)));
  }

  // Caminhos relativos no banco sao sempre relativos a pasta Galeria.
  if (!path.isAbsolute(raw)) {
    return assertGalleryPath(path.join(galleryRootDir, ...parts));
  }

  return assertGalleryPath(direct);
}

function wishlistCleanText(value, max = 600) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function wishlistValidUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    return new URL(text).href;
  } catch {
    return "";
  }
}

function wishlistStoreFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function wishlistTitleFromUrl(value) {
  try {
    const url = new URL(value);
    const lastSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    const withoutIds = lastSegment
      .replace(/-i\.\d+\.\d+.*$/i, "")
      .replace(/\.\d+\.\d+.*$/i, "")
      .replace(/\.(html?|php)$/i, "");
    return wishlistCleanText(withoutIds.replace(/[-_]+/g, " "), 180);
  } catch {
    return "";
  }
}

function wishlistPrice(value) {
  if (typeof value === "number") return roundMoney(value);
  const text = String(value || "").replace(/\s/g, "");
  const br = text.match(/(?:R\$)?(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (br) return roundMoney(Number(br[1].replace(/\./g, "").replace(",", ".")));
  const plain = text.match(/^(?:\d+(?:[.,]\d{2})?)$/);
  return plain ? roundMoney(Number(plain[1].replace(",", "."))) : 0;
}

function wishlistMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return wishlistCleanText(match[1], 1200);
  }
  return "";
}

function wishlistJsonLdProducts(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const products = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : String(value["@type"] || "");
    if (/Product/i.test(type)) products.push(value);
    Object.values(value).forEach(visit);
  };
  for (const block of blocks) {
    try {
      visit(JSON.parse(block.replace(/&quot;/g, "\"")));
    } catch {}
  }
  return products;
}

async function wishlistFetchMetadata(url) {
  const validUrl = wishlistValidUrl(url);
  if (!validUrl) {
    const error = new Error("Informe um link iniciando com http:// ou https://.");
    error.statusCode = 400;
    throw error;
  }
  const fallback = { link_original: validUrl, loja: wishlistStoreFromUrl(validUrl), nome: wishlistTitleFromUrl(validUrl), imagem_url: "", preco_atual: 0, descricao: "" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const response = await fetch(validUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 DRSOSystem Wishlist",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    clearTimeout(timer);
    const html = await response.text();
    const product = wishlistJsonLdProducts(html)[0] || {};
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
    const title = wishlistMeta(html, "og:title") || wishlistCleanText(product.name, 240) || wishlistCleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], 240) || fallback.nome;
    const image = wishlistMeta(html, "og:image") || (Array.isArray(product.image) ? product.image[0] : product.image) || "";
    const description = wishlistMeta(html, "og:description") || wishlistMeta(html, "description") || wishlistCleanText(product.description, 600);
    const store = fallback.loja.toLowerCase();
    const trustedPriceSource = offers.price || wishlistMeta(html, "product:price:amount") || wishlistMeta(html, "og:price:amount");
    const price = store.includes("shopee.") ? 0 : wishlistPrice(trustedPriceSource);
    return { ...fallback, nome: wishlistCleanText(title, 240), imagem_url: String(image || "").trim(), preco_atual: price, descricao: wishlistCleanText(description, 600) };
  } catch {
    return fallback;
  }
}

function wishlistNormalizeFolder(payload, userId) {
  return {
    user_id: userId,
    nome: wishlistCleanText(payload.nome || payload.name, 120) || "Nova pasta",
    descricao: wishlistCleanText(payload.descricao || payload.description, 260),
    icone: wishlistCleanText(payload.icone || payload.icon || "folder", 40),
    cor: wishlistCleanText(payload.cor || payload.color || "#facc15", 32),
    pasta_pai_id: payload.pasta_pai_id || payload.parent_id ? Number(payload.pasta_pai_id || payload.parent_id) : null
  };
}

function wishlistNormalizeProduct(payload, userId) {
  const link = wishlistValidUrl(payload.link_original || payload.url || "");
  return {
    user_id: userId,
    pasta_id: payload.pasta_id ? Number(payload.pasta_id) : null,
    nome: wishlistCleanText(payload.nome || payload.name, 220) || "Produto sem nome",
    link_original: link || "",
    imagem_url: wishlistCleanText(payload.imagem_url || payload.image_url, 900),
    preco_atual: wishlistPrice(payload.preco_atual),
    preco_desejado: wishlistPrice(payload.preco_desejado),
    loja: wishlistCleanText(payload.loja || (link ? wishlistStoreFromUrl(link) : ""), 120),
    categoria: wishlistCleanText(payload.categoria, 120),
    prioridade: ["Baixa", "Media", "Alta", "Urgente"].includes(payload.prioridade) ? payload.prioridade : "Media",
    status: ["Quero comprar", "Pesquisando", "Aguardando promocao", "Comprado", "Descartado"].includes(payload.status) ? payload.status : "Quero comprar",
    observacoes: wishlistCleanText(payload.observacoes || payload.descricao, 1200),
    comprado: Number(payload.comprado || 0) ? 1 : 0,
    ultima_atualizacao_preco: payload.ultima_atualizacao_preco || null
  };
}

function wishlistProductPublic(row) {
  return { ...row, preco_atual: Number(row.preco_atual || 0), preco_desejado: Number(row.preco_desejado || 0), comprado: Number(row.comprado || 0) };
}

function wishlistHistory(userId, productId) {
  return all("SELECT * FROM historico_precos_wishlist WHERE user_id = ? AND produto_id = ? ORDER BY datetime(criado_em) DESC, id DESC", [userId, productId]);
}

function wishlistOverview(userId, query) {
  const currentFolder = query.get("folder") ? Number(query.get("folder")) : null;
  const allProducts = query.get("all") === "1";
  const folders = all("SELECT * FROM wishlist_pastas WHERE user_id = ? ORDER BY nome COLLATE NOCASE", [userId]);
  const where = ["produtos_wishlist.user_id = ?"];
  const params = [userId];
  if (!allProducts) {
    if (currentFolder) {
      where.push("produtos_wishlist.pasta_id = ?");
      params.push(currentFolder);
    } else {
      where.push("produtos_wishlist.pasta_id IS NULL");
    }
  }
  for (const [key, col] of [["status", "status"], ["prioridade", "prioridade"], ["loja", "loja"]]) {
    if (query.get(key)) {
      where.push(`produtos_wishlist.${col} = ?`);
      params.push(query.get(key));
    }
  }
  if (query.get("comprado")) {
    where.push("produtos_wishlist.comprado = ?");
    params.push(query.get("comprado") === "sim" ? 1 : 0);
  }
  if (query.get("search")) {
    const like = `%${query.get("search")}%`;
    where.push("(produtos_wishlist.nome LIKE ? OR produtos_wishlist.loja LIKE ? OR produtos_wishlist.categoria LIKE ? OR produtos_wishlist.observacoes LIKE ? OR wishlist_pastas.nome LIKE ?)");
    params.push(like, like, like, like, like);
  }
  if (query.get("min")) {
    where.push("produtos_wishlist.preco_atual >= ?");
    params.push(wishlistPrice(query.get("min")));
  }
  if (query.get("max")) {
    where.push("produtos_wishlist.preco_atual <= ?");
    params.push(wishlistPrice(query.get("max")));
  }
  const products = all(`
    SELECT produtos_wishlist.*, wishlist_pastas.nome AS pasta_nome
    FROM produtos_wishlist
    LEFT JOIN wishlist_pastas ON wishlist_pastas.id = produtos_wishlist.pasta_id
    WHERE ${where.join(" AND ")}
    ORDER BY produtos_wishlist.comprado ASC, datetime(produtos_wishlist.atualizado_em) DESC, produtos_wishlist.id DESC
  `, params).map(wishlistProductPublic);
  const breadcrumb = [];
  let cursor = currentFolder ? folders.find((folder) => Number(folder.id) === currentFolder) : null;
  while (cursor) {
    breadcrumb.unshift(cursor);
    cursor = cursor.pasta_pai_id ? folders.find((folder) => Number(folder.id) === Number(cursor.pasta_pai_id)) : null;
  }
  return {
    currentFolder,
    allProducts,
    folders,
    currentFolders: allProducts ? [] : folders.filter((folder) => Number(folder.pasta_pai_id || 0) === Number(currentFolder || 0)),
    products,
    breadcrumb,
    summary: {
      folders: folders.length,
      products: get("SELECT COUNT(*) AS total FROM produtos_wishlist WHERE user_id = ?", [userId])?.total || 0,
      bought: get("SELECT COUNT(*) AS total FROM produtos_wishlist WHERE user_id = ? AND comprado = 1", [userId])?.total || 0,
      wanted: get("SELECT COALESCE(SUM(preco_atual), 0) AS total FROM produtos_wishlist WHERE user_id = ? AND comprado = 0", [userId])?.total || 0
    }
  };
}

async function wishlistRefreshProductPrice(userId, product) {
  if (!product.link_original) return wishlistProductPublic(product);
  const metadata = await wishlistFetchMetadata(product.link_original);
  const oldPrice = Number(product.preco_atual || 0);
  const newPrice = Number(metadata.preco_atual || 0);
  const now = currentDateTime();
  if (newPrice > 0 && newPrice !== oldPrice) {
    run("INSERT INTO historico_precos_wishlist (user_id, produto_id, preco_antigo, preco_novo, loja, criado_em) VALUES (?, ?, ?, ?, ?, ?)", [userId, product.id, oldPrice, newPrice, metadata.loja || product.loja || "", now]);
  }
  run("UPDATE produtos_wishlist SET nome = COALESCE(NULLIF(?, ''), nome), imagem_url = COALESCE(NULLIF(?, ''), imagem_url), preco_atual = CASE WHEN ? > 0 THEN ? ELSE preco_atual END, loja = COALESCE(NULLIF(?, ''), loja), ultima_atualizacao_preco = ?, atualizado_em = ? WHERE id = ? AND user_id = ?", [metadata.nome || "", metadata.imagem_url || "", newPrice, newPrice, metadata.loja || "", now, now, product.id, userId]);
  return wishlistProductPublic(get("SELECT * FROM produtos_wishlist WHERE id = ? AND user_id = ?", [product.id, userId]));
}

function galleryDatedFolder(kind, dateText = todayDate()) {
  const year = String(dateText || todayDate()).slice(0, 4);
  const month = String(dateText || todayDate()).slice(5, 7);
  return path.join(galleryRootDir, kind, year, month);
}

function galleryAlbumPublic(row) {
  if (!row) return row;
  const { password_hash, ...safe } = row;
  return { ...safe, protegido: password_hash ? 1 : 0 };
}

function galleryAlbumTokenValid(userId, albumId, token) {
  if (!token) return false;
  const entry = galleryAlbumTokens.get(String(token));
  if (!entry || entry.userId !== userId || entry.albumId !== Number(albumId) || entry.expiresAt < Date.now()) {
    if (entry) galleryAlbumTokens.delete(String(token));
    return false;
  }
  return true;
}

function createGalleryAlbumToken(userId, albumId) {
  const token = randomBytes(24).toString("hex");
  galleryAlbumTokens.set(token, { userId, albumId: Number(albumId), expiresAt: Date.now() + 4 * 60 * 60 * 1000 });
  return token;
}

function galleryPublicMedia(row, albumToken = "") {
  const tokenQuery = albumToken ? `?album_token=${encodeURIComponent(albumToken)}` : "";
  return {
    ...row,
    file_url: `/api/galeria/file/${row.id}${tokenQuery}`,
    thumbnail_url: row.caminho_thumbnail ? `/api/galeria/thumbnail/${row.id}${tokenQuery}` : `/api/galeria/file/${row.id}${tokenQuery}`,
    download_url: `/api/galeria/download/${row.id}${tokenQuery}`,
    tamanho_original: Number(row.tamanho_original || 0),
    tamanho_final: Number(row.tamanho_final || 0),
    favorito: Number(row.favorito || 0)
  };
}

function galleryDownloadName(row) {
  const original = safeFileName(row.nome_original || `galeria-${row.id}`);
  const originalExt = path.extname(original).replace(".", "").toLowerCase();
  const finalExt = String(row.extensao || originalExt || "bin").toLowerCase();
  return originalExt === finalExt ? original : `${path.parse(original).name}.${finalExt}`;
}

function galleryAlbumRows(userId) {
  return all(`
    SELECT gallery_albums.*,
      COUNT(gallery_media.id) AS quantidade_midias,
      COALESCE(SUM(gallery_media.tamanho_final), 0) AS tamanho_total,
      MIN(gallery_media.id) AS primeira_media_id
    FROM gallery_albums
    LEFT JOIN gallery_media ON gallery_media.album_id = gallery_albums.id AND gallery_media.user_id = gallery_albums.user_id
    WHERE gallery_albums.user_id = ?
    GROUP BY gallery_albums.id
    ORDER BY datetime(gallery_albums.created_at) DESC, gallery_albums.id DESC
  `, [userId]).map(galleryAlbumPublic);
}

async function galleryStorageStats(userId) {
  await ensureGalleryStorage();
  const summary = get(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN tipo_arquivo = 'foto' THEN 1 ELSE 0 END), 0) AS photos,
      COALESCE(SUM(CASE WHEN tipo_arquivo = 'video' THEN 1 ELSE 0 END), 0) AS videos,
      COALESCE(SUM(tamanho_final), 0) AS used
    FROM gallery_media
    WHERE user_id = ?
  `, [userId]) || {};
  let disk = { total: 0, free: 0 };
  try {
    const info = await statfs(galleryRootDir);
    disk = {
      total: Number(info.blocks || 0) * Number(info.bsize || 0),
      free: Number(info.bavail || 0) * Number(info.bsize || 0)
    };
  } catch {}
  const total = Number(summary.total || 0);
  const photos = Number(summary.photos || 0);
  const videos = Number(summary.videos || 0);
  const used = Number(summary.used || 0);
  const average = total ? Math.round(used / total) : 0;
  return {
    root: galleryRootDir,
    total_files: total,
    total_midias: total,
    photos,
    total_fotos: photos,
    videos,
    total_videos: videos,
    used,
    gallery_used: used,
    free: disk.free,
    disk_free: disk.free,
    disk_total: disk.total,
    average_size: average
  };
}

async function galleryList(userId, query) {
  await ensureGalleryStorage();
  const where = ["gallery_media.user_id = ?"];
  const values = [userId];
  const type = String(query.get("type") || "");
  const album = String(query.get("album") || "");
  const albumToken = String(query.get("album_token") || "");
  const favorite = String(query.get("favorite") || "");
  const period = String(query.get("period") || "");
  const search = String(query.get("search") || "").trim();
  if (["foto", "video"].includes(type)) {
    where.push("gallery_media.tipo_arquivo = ?");
    values.push(type);
  }
  if (album) {
    const albumRow = get("SELECT * FROM gallery_albums WHERE id = ? AND user_id = ?", [Number(album), userId]);
    if (!albumRow) {
      return {
        summary: await galleryStorageStats(userId),
        albums: galleryAlbumRows(userId),
        media: [],
        latest: [],
        periods: [],
        album_locked: false
      };
    }
    if (albumRow.password_hash && !galleryAlbumTokenValid(userId, Number(album), albumToken)) {
      return {
        summary: await galleryStorageStats(userId),
        albums: galleryAlbumRows(userId),
        media: [],
        latest: [],
        periods: [],
        album_locked: true
      };
    }
    where.push("gallery_media.album_id = ?");
    values.push(Number(album));
  } else {
    where.push("(gallery_albums.password_hash IS NULL OR gallery_albums.password_hash = '')");
  }
  if (favorite === "1") where.push("gallery_media.favorito = 1");
  if (/^\d{4}-\d{2}$/.test(period)) {
    where.push("substr(COALESCE(gallery_media.data_original, gallery_media.data_upload), 1, 7) = ?");
    values.push(period);
  } else if (/^\d{4}$/.test(period)) {
    where.push("substr(COALESCE(gallery_media.data_original, gallery_media.data_upload), 1, 4) = ?");
    values.push(period);
  }
  if (search) {
    where.push("(gallery_media.nome_original LIKE ? OR gallery_media.categoria LIKE ? OR gallery_media.tags LIKE ? OR gallery_media.descricao LIKE ?)");
    values.push(...Array(4).fill(`%${search}%`));
  }
  const media = all(`
    SELECT gallery_media.*, gallery_albums.nome AS album_nome
    FROM gallery_media
    LEFT JOIN gallery_albums ON gallery_albums.id = gallery_media.album_id
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(COALESCE(gallery_media.data_original, gallery_media.data_upload)) DESC, gallery_media.id DESC
    LIMIT 500
  `, values).map((item) => galleryPublicMedia(item, albumToken));
  const periods = all(`
    SELECT DISTINCT substr(COALESCE(data_original, data_upload), 1, 7) AS period
    FROM gallery_media
    WHERE user_id = ?
    ORDER BY period DESC
  `, [userId]).map((item) => item.period).filter(Boolean);
  const latest = all(`
    SELECT gallery_media.*, gallery_albums.nome AS album_nome
    FROM gallery_media
    LEFT JOIN gallery_albums ON gallery_albums.id = gallery_media.album_id
    WHERE gallery_media.user_id = ?
      AND (gallery_albums.password_hash IS NULL OR gallery_albums.password_hash = '')
    ORDER BY datetime(gallery_media.data_upload) DESC, gallery_media.id DESC
    LIMIT 10
  `, [userId]).map(galleryPublicMedia);
  return {
    summary: await galleryStorageStats(userId),
    albums: galleryAlbumRows(userId),
    media,
    latest,
    periods
  };
}

async function saveGalleryMedia(userId, payload = {}) {
  await ensureGalleryStorage();
  const originalName = safeFileName(payload.name || payload.nome_original || "arquivo");
  const ext = galleryExt(originalName);
  const type = galleryMediaType(ext);
  if (!type) {
    const error = new Error("Extensao nao permitida para a galeria.");
    error.statusCode = 400;
    throw error;
  }
  const encoded = String(payload.data || "").includes(",") ? String(payload.data).split(",").pop() : String(payload.data || "");
  const content = Buffer.from(encoded, "base64");
  if (!content.length) {
    const error = new Error("O arquivo selecionado esta vazio.");
    error.statusCode = 400;
    throw error;
  }
  if (content.length > 350 * 1024 * 1024) {
    const error = new Error("Arquivo muito grande para upload via navegador. Use ate 350 MB por arquivo nesta versao.");
    error.statusCode = 400;
    throw error;
  }
  const keepOriginal = !(payload.manter_original === false || payload.manter_original === "nao");
  const canUseOptimized = type === "foto" && !keepOriginal && payload.optimized_data;
  const optimizedContent = canUseOptimized
    ? Buffer.from(String(payload.optimized_data).includes(",") ? String(payload.optimized_data).split(",").pop() : String(payload.optimized_data || ""), "base64")
    : null;
  const finalContent = optimizedContent?.length ? optimizedContent : content;
  const finalExt = optimizedContent?.length ? ".webp" : ext;
  const dateText = payload.data_original ? normalizeDateTime(payload.data_original).slice(0, 10) : todayDate();
  const baseFolder = type === "video" ? "Videos" : optimizedContent?.length ? "Compressed" : "Fotos";
  const targetDir = galleryDatedFolder(baseFolder, dateText);
  await mkdir(targetDir, { recursive: true });
  const storedName = `${randomBytes(16).toString("hex")}${finalExt}`;
  const targetPath = assertGalleryPath(path.join(targetDir, storedName));
  await writeFile(targetPath, finalContent);
  let thumbnailPath = type === "foto" ? targetPath : "";
  if (type === "foto" && payload.thumbnail_data) {
    const thumbEncoded = String(payload.thumbnail_data).includes(",") ? String(payload.thumbnail_data).split(",").pop() : String(payload.thumbnail_data || "");
    const thumbnailContent = Buffer.from(thumbEncoded, "base64");
    if (thumbnailContent.length) {
      const thumbnailDir = galleryDatedFolder("Thumbnails", dateText);
      await mkdir(thumbnailDir, { recursive: true });
      thumbnailPath = assertGalleryPath(path.join(thumbnailDir, `${path.parse(storedName).name}-thumb.webp`));
      await writeFile(thumbnailPath, thumbnailContent);
    }
  }
  const result = run(`
    INSERT INTO gallery_media (
      user_id, nome_original, nome_armazenado, tipo_arquivo, extensao, tamanho_original, tamanho_final,
      caminho_arquivo, caminho_thumbnail, data_upload, data_original, album_id, categoria, tags, descricao,
      favorito, manter_original, compressed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `, [
    userId,
    originalName,
    storedName,
    type,
    finalExt.replace(".", ""),
    content.length,
    finalContent.length,
    targetPath,
    thumbnailPath,
    currentDateTime(),
    payload.data_original ? normalizeDateTime(payload.data_original) : null,
    payload.album_id ? Number(payload.album_id) : null,
    payload.categoria || "",
    payload.tags || "",
    payload.descricao || "",
    keepOriginal ? 1 : 0,
    optimizedContent?.length ? 1 : 0,
    currentDateTime(),
    currentDateTime()
  ]);
  const row = get("SELECT * FROM gallery_media WHERE id = ?", [result.lastInsertRowid]);
  recordTimeline("Midia adicionada na Galeria", originalName, "galeria");
  return galleryPublicMedia(row);
}

async function galleryMediaFile(userId, id, thumbnail = false, albumToken = "") {
  const row = get(`
    SELECT gallery_media.*, gallery_albums.password_hash AS album_password_hash
    FROM gallery_media
    LEFT JOIN gallery_albums ON gallery_albums.id = gallery_media.album_id
    WHERE gallery_media.id = ? AND gallery_media.user_id = ?
  `, [Number(id), userId]);
  if (!row) return null;
  if (row.album_password_hash && !galleryAlbumTokenValid(userId, Number(row.album_id || 0), albumToken)) return null;
  const filePath = resolveGalleryStoredPath(thumbnail && row.caminho_thumbnail ? row.caminho_thumbnail : row.caminho_arquivo);
  console.log(`[Galeria] Caminho final ${thumbnail ? "da miniatura" : "da midia"}: ${filePath}`);
  if (!existsSync(filePath)) return null;
  const fileStat = await stat(filePath);
  return { row, filePath, size: fileStat.size };
}

function createResource(resource, payload) {
  const table = tables[resource];
  const allowed = fields[resource];
  if (resource === "finance") return createFinanceTransaction(payload);
  if (resource === "bets") {
    payload = prepareBetPayload(payload, { status: "pending" });
    assertBetHasAvailableBalance(payload, {});
  }
  if (resource === "planning") payload = normalizePlanningPayload(payload, { status: "pending" });
  if (resource === "notes") {
    const importedFromTxt = String(payload.tags || "").toLowerCase().split(",").map((tag) => tag.trim()).includes("txt");
    if (importedFromTxt && !String(payload.content || "").trim()) {
      const error = new Error("O arquivo TXT esta vazio e nao pode ser importado.");
      error.statusCode = 400;
      throw error;
    }
    const now = currentDateTime();
    const createdAt = payload.source_created_at ? normalizeDateTime(payload.source_created_at) : now;
    payload = { ...payload, created_date: createdAt.slice(0, 10) };
    const cols = allowed.filter((field) => payload[field] !== undefined);
    const values = cols.map((field) => payload[field]);
    const marks = [...cols, "created_at", "updated_at"].map(() => "?").join(", ");
    const result = run(
      `INSERT INTO ${table} (${[...cols, "created_at", "updated_at"].join(", ")}) VALUES (${marks})`,
      [...values, createdAt, now]
    );
    if (payload.type === "ideia") {
      run("INSERT INTO ideas (note_id, title, content, tags) VALUES (?, ?, ?, ?)", [result.lastInsertRowid, payload.title, payload.content || "", payload.tags || ""]);
    }
    recordTimeline("Nota ou ideia criada", payload.title || "", resource);
    return get(`SELECT * FROM ${table} WHERE id = ?`, [result.lastInsertRowid]);
  }
  if (resource === "timeline") {
    const now = currentDateTime();
    payload = { ...payload, date: normalizeDateTime(payload.date || now) };
    const result = run(
      "INSERT INTO timeline_events (date, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [payload.date, payload.title || "", payload.description || "", payload.category || "geral", now, now]
    );
    return get("SELECT * FROM timeline_events WHERE id = ?", [result.lastInsertRowid]);
  }
  if (resource === "documents") {
    const now = currentDateTime();
    payload = {
      ...payload,
      uploaded_at: normalizeDateTime(payload.uploaded_at || now),
      source_modified_at: payload.source_modified_at ? normalizeDateTime(payload.source_modified_at) : ""
    };
    const cols = allowed.filter((field) => payload[field] !== undefined);
    const values = cols.map((field) => payload[field]);
    const marks = [...cols, "created_at", "updated_at"].map(() => "?").join(", ");
    const result = run(
      `INSERT INTO ${table} (${[...cols, "created_at", "updated_at"].join(", ")}) VALUES (${marks})`,
      [...values, now, now]
    );
    recordTimeline("Documento cadastrado", payload.name || "", resource);
    return get(`SELECT * FROM ${table} WHERE id = ?`, [result.lastInsertRowid]);
  }
  const cols = allowed.filter((field) => payload[field] !== undefined);
  const values = cols.map((field) => payload[field]);
  const marks = cols.map(() => "?").join(", ");
  const result = run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks})`, values);
  if (resource === "bets") upsertBettingHouseName(payload.betting_house);
  const labels = { finance: "Movimentacao criada", bets: "Aposta registrada", planning: "Compromisso financeiro criado", documents: "Documento cadastrado", projects: "Projeto criado", notes: "Nota ou ideia criada" };
  if (labels[resource]) recordTimeline(labels[resource], payload.title || payload.description || payload.name || payload.entry || "", resource);
  return get(`SELECT * FROM ${table} WHERE id = ?`, [result.lastInsertRowid]);
}

function updateResource(resource, id, payload) {
  const table = tables[resource];
  if (resource === "finance") return updateFinanceTransaction(id, payload);
  const existingBet = resource === "bets" ? get("SELECT * FROM bets WHERE id = ?", [id]) || {} : {};
  if (resource === "bets") {
    payload = prepareBetPayload(payload, existingBet);
    assertBetHasAvailableBalance(payload, existingBet);
  }
  if (resource === "planning") payload = normalizePlanningPayload(payload, get("SELECT * FROM planning_items WHERE id = ?", [id]) || {});
  if (resource === "timeline" && payload.date) payload = { ...payload, date: normalizeDateTime(payload.date) };
  const cols = fields[resource].filter((field) => payload[field] !== undefined);
  const assignments = cols.map((field) => `${field} = ?`).join(", ");
  run(`UPDATE ${table} SET ${assignments}, updated_at = ? WHERE id = ?`, [...cols.map((field) => payload[field]), currentDateTime(), id]);
  if (resource === "bets") upsertBettingHouseName(payload.betting_house);
  return get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

function deleteResource(resource, id) {
  if (resource === "finance") {
    run("DELETE FROM finance_account_pocket_movements WHERE transaction_id = ?", [id]);
  }
  run(`DELETE FROM ${tables[resource]} WHERE id = ?`, [id]);
  return { ok: true };
}

function youtubeVideoIdFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  let id = "";
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
    else {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts") id = parts[1] || "";
    }
  } else if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] || "";
  }
  return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
}

function youtubeThumbnail(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function musicAudioMime(fileName, fallback = "") {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return fallback || {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".flac": "audio/flac"
  }[ext] || "application/octet-stream";
}

function assertMusicAudioFile(name, mimeType) {
  const ext = path.extname(String(name || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  const allowedExt = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac"]);
  if (!allowedExt.has(ext) && !mime.startsWith("audio/")) {
    const error = new Error("Envie um arquivo de audio valido: MP3, M4A, WAV, OGG, AAC ou FLAC.");
    error.statusCode = 400;
    throw error;
  }
  return ext || ".mp3";
}

function musicAudioUrl(fileName) {
  return `/api/music/audio/${encodeURIComponent(fileName)}`;
}

function parseRadioPlaylist(text, baseUrl = "") {
  const source = String(text || "");
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pls = lines.find((line) => /^File\d+=/i.test(line));
  const htmlLink = source.match(/href\s*=\s*["']([^"']*(?:m3u8?|pls|asx|playlist|stream)[^"']*)["']/i);
  const raw = pls
    ? pls.replace(/^File\d+=/i, "").trim()
    : (htmlLink?.[1] || lines.find((line) => !line.startsWith("#") && !line.startsWith("[") && !/^(Title|Length|NumberOfEntries|Version)\d*=/i.test(line)));
  const asx = source.match(/href\s*=\s*["']([^"']+)["']/i);
  const next = raw || asx?.[1] || "";
  if (!next) return "";
  try {
    return new URL(next, baseUrl || undefined).toString();
  } catch {
    return next;
  }
}

async function resolveRadioStreamUrl(rawUrl, depth = 0) {
  const url = String(rawUrl || "").trim();
  if (!url || depth > 3) {
    const error = new Error("Nao consegui encontrar o stream dessa radio.");
    error.statusCode = 400;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error("Informe um link valido da radio.");
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("Use um link http ou https da radio.");
    error.statusCode = 400;
    throw error;
  }
  const response = await fetch(parsed.toString(), {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 DRSOSystem Radio Player",
      "Accept": "audio/*, application/pls+xml, audio/x-mpegurl, application/vnd.apple.mpegurl, application/xml, text/plain, */*",
      "Referer": `${parsed.origin}/`
    }
  });
  if (!response.ok) {
    const error = new Error(`Nao consegui acessar a radio (${response.status}).`);
    error.statusCode = 400;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  const pathname = parsed.pathname.toLowerCase();
  const isPlaylist = /mpegurl|x-scpls|pls|asx|xml|text|html/.test(contentType) || /\.(m3u8?|pls|asx)$/i.test(pathname);
  if (!isPlaylist) return response.url || parsed.toString();
  const text = await response.text();
  const next = parseRadioPlaylist(text, response.url || parsed.toString());
  if (!next || next === parsed.toString()) return response.url || parsed.toString();
  return resolveRadioStreamUrl(next, depth + 1);
}

async function proxyRadioStream(rawUrl, req, res) {
  const target = await resolveRadioStreamUrl(rawUrl);
  const headers = {
    "User-Agent": "Mozilla/5.0 DRSOSystem Radio Player",
    "Accept": "audio/*, */*",
    "Referer": new URL(target).origin + "/"
  };
  if (req.headers.range) headers.Range = req.headers.range;
  const response = await fetch(target, { redirect: "follow", headers });
  if (!response.ok || !response.body) {
    const error = new Error(`Nao consegui abrir o stream da radio (${response.status}).`);
    error.statusCode = 400;
    throw error;
  }
  const responseHeaders = {
    "Content-Type": response.headers.get("content-type") || "audio/mpeg",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  };
  ["content-length", "content-range", "accept-ranges"].forEach((name) => {
    const value = response.headers.get(name);
    if (value) responseHeaders[name.replace(/\b\w/g, (char) => char.toUpperCase())] = value;
  });
  res.writeHead(response.status, responseHeaders);
  return Readable.fromWeb(response.body).pipe(res);
}

async function saveMusicAudio(payload) {
  const originalName = path.basename(String(payload.name || "musica.mp3")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const mimeType = String(payload.mime_type || "");
  const ext = assertMusicAudioFile(originalName, mimeType);
  const encoded = String(payload.data || "").includes(",") ? String(payload.data).split(",").pop() : String(payload.data || "");
  const content = Buffer.from(encoded, "base64");
  if (!content.length) {
    const error = new Error("O arquivo de audio esta vazio.");
    error.statusCode = 400;
    throw error;
  }
  if (content.length > 120 * 1024 * 1024) {
    const error = new Error("O arquivo de audio deve ter no maximo 120 MB.");
    error.statusCode = 400;
    throw error;
  }
  const storedName = `${randomBytes(24).toString("hex")}${ext}`;
  await writeFile(path.join(musicUploadsDir, storedName), content);
  return {
    original_name: originalName,
    audio_file_name: storedName,
    audio_mime_type: musicAudioMime(originalName, mimeType),
    audio_url: musicAudioUrl(storedName),
    storage_label: "Salvo no armazenamento permanente"
  };
}

function musicPlaylistList() {
  return all(`
    SELECT playlists.*,
      COUNT(playlist_musicas.id) AS musicas_total,
      COALESCE(MAX(playlist_musicas.thumbnail_url), '') AS ultima_thumbnail
    FROM playlists
    LEFT JOIN playlist_musicas ON playlist_musicas.playlist_id = playlists.id
    GROUP BY playlists.id
    ORDER BY datetime(playlists.criado_em) DESC, playlists.id DESC
  `);
}

function musicPlaylistDetail(id) {
  const playlist = get("SELECT * FROM playlists WHERE id = ?", [id]);
  if (!playlist) return null;
  const musicas = all("SELECT * FROM playlist_musicas WHERE playlist_id = ? ORDER BY ordem ASC, id ASC", [id]);
  return { ...playlist, musicas };
}

function createMusicPlaylist(payload) {
  const nome = String(payload.nome || "").trim();
  if (!nome) {
    const error = new Error("Informe o nome da playlist.");
    error.statusCode = 400;
    throw error;
  }
  const now = currentDateTime();
  const result = run("INSERT INTO playlists (nome, descricao, capa, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)", [
    nome,
    String(payload.descricao || "").trim(),
    String(payload.capa || "").trim(),
    now,
    now
  ]);
  recordTimeline("Playlist criada", nome, "music");
  return musicPlaylistDetail(result.lastInsertRowid);
}

function updateMusicPlaylist(id, payload) {
  const current = get("SELECT * FROM playlists WHERE id = ?", [id]);
  if (!current) {
    const error = new Error("Playlist nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const nome = String(payload.nome ?? current.nome ?? "").trim();
  if (!nome) {
    const error = new Error("Informe o nome da playlist.");
    error.statusCode = 400;
    throw error;
  }
  run("UPDATE playlists SET nome = ?, descricao = ?, capa = ?, atualizado_em = ? WHERE id = ?", [
    nome,
    String(payload.descricao ?? current.descricao ?? "").trim(),
    String(payload.capa ?? current.capa ?? "").trim(),
    currentDateTime(),
    id
  ]);
  recordTimeline("Playlist atualizada", nome, "music");
  return musicPlaylistDetail(id);
}

function deleteMusicPlaylist(id) {
  const current = get("SELECT * FROM playlists WHERE id = ?", [id]);
  if (!current) {
    const error = new Error("Playlist nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  run("DELETE FROM playlists WHERE id = ?", [id]);
  recordTimeline("Playlist excluida", current.nome, "music");
  return { ok: true };
}

function prepareMusicPayload(payload, current = {}) {
  const sourceType = String(payload.source_type || current.source_type || (payload.audio_url || payload.audio_file_name ? "audio" : "youtube")).trim();
  if (sourceType === "audio") {
    const audioUrl = String(payload.audio_url ?? current.audio_url ?? "").trim();
    const audioFileName = String(payload.audio_file_name ?? current.audio_file_name ?? "").trim();
    if (!audioUrl && !audioFileName) {
      const error = new Error("Envie um arquivo de audio.");
      error.statusCode = 400;
      throw error;
    }
    const titulo = String(payload.titulo ?? current.titulo ?? "").trim();
    return {
      titulo: titulo || String(payload.original_name || audioFileName || "Musica local").replace(/\.[^.]+$/, ""),
      artista: String(payload.artista ?? current.artista ?? "").trim(),
      youtube_url: "",
      youtube_video_id: "",
      thumbnail_url: String(payload.thumbnail_url ?? current.thumbnail_url ?? "").trim(),
      source_type: "audio",
      audio_url: audioUrl || musicAudioUrl(audioFileName),
      audio_file_name: audioFileName,
      audio_mime_type: String(payload.audio_mime_type ?? current.audio_mime_type ?? "").trim()
    };
  }
  const youtubeUrl = String(payload.youtube_url ?? current.youtube_url ?? "").trim();
  const videoId = youtubeVideoIdFromUrl(youtubeUrl);
  if (!videoId) {
    const error = new Error("Informe um link valido do YouTube, YouTube Music, youtu.be ou YouTube Shorts.");
    error.statusCode = 400;
    throw error;
  }
  const titulo = String(payload.titulo ?? current.titulo ?? "").trim();
  return {
    titulo: titulo || `YouTube ${videoId}`,
    artista: String(payload.artista ?? current.artista ?? "").trim(),
    youtube_url: youtubeUrl,
    youtube_video_id: videoId,
    thumbnail_url: String(payload.thumbnail_url ?? current.thumbnail_url ?? "").trim() || youtubeThumbnail(videoId),
    source_type: "youtube",
    audio_url: "",
    audio_file_name: "",
    audio_mime_type: ""
  };
}

function addMusicToPlaylist(playlistId, payload) {
  if (!get("SELECT id FROM playlists WHERE id = ?", [playlistId])) {
    const error = new Error("Playlist nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const clean = prepareMusicPayload(payload);
  const nextOrder = Number(get("SELECT COALESCE(MAX(ordem), 0) + 1 AS next_order FROM playlist_musicas WHERE playlist_id = ?", [playlistId])?.next_order || 1);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO playlist_musicas (playlist_id, titulo, artista, youtube_url, youtube_video_id, thumbnail_url, source_type, audio_url, audio_file_name, audio_mime_type, ordem, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [playlistId, clean.titulo, clean.artista, clean.youtube_url, clean.youtube_video_id, clean.thumbnail_url, clean.source_type, clean.audio_url, clean.audio_file_name, clean.audio_mime_type, nextOrder, now, now]);
  run("UPDATE playlists SET atualizado_em = ? WHERE id = ?", [now, playlistId]);
  recordTimeline("Musica adicionada", clean.titulo, "music");
  return get("SELECT * FROM playlist_musicas WHERE id = ?", [result.lastInsertRowid]);
}

function updatePlaylistMusic(id, payload) {
  const current = get("SELECT * FROM playlist_musicas WHERE id = ?", [id]);
  if (!current) {
    const error = new Error("Musica nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const clean = prepareMusicPayload(payload, current);
  const now = currentDateTime();
  run(`
    UPDATE playlist_musicas
    SET titulo = ?, artista = ?, youtube_url = ?, youtube_video_id = ?, thumbnail_url = ?, source_type = ?, audio_url = ?, audio_file_name = ?, audio_mime_type = ?, atualizado_em = ?
    WHERE id = ?
  `, [clean.titulo, clean.artista, clean.youtube_url, clean.youtube_video_id, clean.thumbnail_url, clean.source_type, clean.audio_url, clean.audio_file_name, clean.audio_mime_type, now, id]);
  run("UPDATE playlists SET atualizado_em = ? WHERE id = ?", [now, current.playlist_id]);
  recordTimeline("Musica atualizada", clean.titulo, "music");
  return get("SELECT * FROM playlist_musicas WHERE id = ?", [id]);
}

function deletePlaylistMusic(id) {
  const current = get("SELECT * FROM playlist_musicas WHERE id = ?", [id]);
  if (!current) {
    const error = new Error("Musica nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  run("DELETE FROM playlist_musicas WHERE id = ?", [id]);
  const remaining = all("SELECT id FROM playlist_musicas WHERE playlist_id = ? ORDER BY ordem ASC, id ASC", [current.playlist_id]);
  remaining.forEach((item, index) => run("UPDATE playlist_musicas SET ordem = ? WHERE id = ?", [index + 1, item.id]));
  run("UPDATE playlists SET atualizado_em = ? WHERE id = ?", [currentDateTime(), current.playlist_id]);
  recordTimeline("Musica removida", current.titulo, "music");
  return { ok: true };
}

function reorderPlaylistMusic(playlistId, ids) {
  if (!Array.isArray(ids) || !ids.length) {
    const error = new Error("Informe a nova ordem das musicas.");
    error.statusCode = 400;
    throw error;
  }
  const currentIds = all("SELECT id FROM playlist_musicas WHERE playlist_id = ?", [playlistId]).map((item) => Number(item.id));
  const requested = ids.map(Number);
  if (requested.length !== currentIds.length || requested.some((id) => !currentIds.includes(id))) {
    const error = new Error("A ordem enviada nao corresponde as musicas desta playlist.");
    error.statusCode = 400;
    throw error;
  }
  requested.forEach((id, index) => run("UPDATE playlist_musicas SET ordem = ?, atualizado_em = ? WHERE id = ? AND playlist_id = ?", [index + 1, currentDateTime(), id, playlistId]));
  run("UPDATE playlists SET atualizado_em = ? WHERE id = ?", [currentDateTime(), playlistId]);
  return musicPlaylistDetail(playlistId);
}

function vendinhaMonth(value = "") {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : currentMonth();
}

function vendinhaEstablishmentFilter(value) {
  const id = Number(value || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function vendinhaStatus(value) {
  const text = String(value || "").toLowerCase();
  return ["pago", "paid"].includes(text) ? "paid" : "open";
}

function vendinhaEnsureDefaults(userId) {
  const existingStores = get("SELECT COUNT(*) AS count FROM vendinha_establishments WHERE user_id = ?", [userId]).count;
  if (!existingStores) {
    run("INSERT INTO vendinha_establishments (user_id, name, notes, status) VALUES (?, ?, ?, 'ativo')", [
      userId,
      "Tia Adelia Cruvinel",
      "Vendinha/lanchonete do trabalho"
    ]);
  }
  const existingProducts = get("SELECT COUNT(*) AS count FROM vendinha_products WHERE user_id = ?", [userId]).count;
  if (!existingProducts) {
    [
      ["Cafe", 3, "Bebida"],
      ["Pao de queijo", 4.5, "Lanche"],
      ["Salgado", 6, "Lanche"],
      ["Refrigerante", 5, "Bebida"],
      ["Suco", 5, "Bebida"],
      ["Outro", 0, "Outro"]
    ].forEach(([name, value, category]) => {
      run("INSERT INTO vendinha_products (user_id, name, default_value, category, status) VALUES (?, ?, ?, ?, 'ativo')", [userId, name, value, category]);
    });
  }
}

function vendinhaMonthPaid(userId, month, establishmentId = null) {
  const clauses = ["user_id = ?", "month = ?", "status = 'paid'"];
  const values = [userId, month];
  if (establishmentId) {
    clauses.push("(establishment_id = ? OR establishment_id IS NULL)");
    values.push(establishmentId);
  }
  return Boolean(get(`SELECT id FROM vendinha_month_closings WHERE ${clauses.join(" AND ")} LIMIT 1`, values));
}

function vendinhaRequireChangeAllowed(userId, date, establishmentId, payload = {}) {
  const month = String(date || "").slice(0, 7);
  if (month && vendinhaMonthPaid(userId, month, establishmentId) && !payload.force_paid_month) {
    const error = new Error("Esse mes ja esta pago. Confirme para alterar lancamentos quitados.");
    error.statusCode = 409;
    throw error;
  }
}

function vendinhaList(userId, query) {
  vendinhaEnsureDefaults(userId);
  const month = vendinhaMonth(query.get("month"));
  const establishmentId = vendinhaEstablishmentFilter(query.get("establishment_id"));
  const where = ["c.user_id = ?", "substr(c.date, 1, 7) = ?"];
  const values = [userId, month];
  if (establishmentId) {
    where.push("c.establishment_id = ?");
    values.push(establishmentId);
  }
  const consumptions = all(`
    SELECT c.*, e.name AS establishment_name, p.category AS product_category
    FROM vendinha_consumptions c
    LEFT JOIN vendinha_establishments e ON e.id = c.establishment_id
    LEFT JOIN vendinha_products p ON p.id = c.product_id
    WHERE ${where.join(" AND ")}
    ORDER BY c.date DESC, c.id DESC
  `, values);
  const establishments = all("SELECT * FROM vendinha_establishments WHERE user_id = ? ORDER BY status ASC, name ASC", [userId]);
  const products = all("SELECT * FROM vendinha_products WHERE user_id = ? ORDER BY status ASC, category ASC, name ASC", [userId]);
  const closings = all("SELECT mc.*, e.name AS establishment_name FROM vendinha_month_closings mc LEFT JOIN vendinha_establishments e ON e.id = mc.establishment_id WHERE mc.user_id = ? ORDER BY mc.month DESC, mc.payment_date DESC LIMIT 24", [userId]);
  const limit = get(
    `SELECT * FROM vendinha_month_limits WHERE user_id = ? AND month = ? AND ${establishmentId ? "establishment_id = ?" : "establishment_id IS NULL"} LIMIT 1`,
    establishmentId ? [userId, month, establishmentId] : [userId, month]
  ) || { limit_value: 0 };
  const currentClosing = get(
    `SELECT * FROM vendinha_month_closings WHERE user_id = ? AND month = ? AND ${establishmentId ? "establishment_id = ?" : "establishment_id IS NULL"} ORDER BY id DESC LIMIT 1`,
    establishmentId ? [userId, month, establishmentId] : [userId, month]
  ) || null;
  const totals = consumptions.reduce((acc, item) => {
    const value = Number(item.total_value || 0);
    acc.total += value;
    acc.count += 1;
    if (item.status === "paid") acc.paid += value;
    else acc.open += value;
    acc.days.add(item.date);
    acc.products[item.product_name] = (acc.products[item.product_name] || 0) + value;
    acc.daily[item.date] = (acc.daily[item.date] || 0) + value;
    return acc;
  }, { total: 0, paid: 0, open: 0, count: 0, days: new Set(), products: {}, daily: {} });
  const monthPaid = Boolean(consumptions.length) && totals.open <= 0 && (vendinhaMonthPaid(userId, month, establishmentId) || totals.paid >= totals.total);
  const amountPaid = currentClosing ? Number(currentClosing.total_paid || 0) : totals.paid;
  const closingTotal = currentClosing ? Number(currentClosing.total_consumed || totals.total) : totals.total;
  const paymentDifference = currentClosing ? roundMoney(amountPaid - closingTotal) : 0;
  const limitValue = Number(limit.limit_value || 0);
  const monthlyRows = all(`
    SELECT substr(date, 1, 7) AS month, SUM(total_value) AS total
    FROM vendinha_consumptions
    WHERE user_id = ?
    GROUP BY substr(date, 1, 7)
    ORDER BY month DESC
    LIMIT 12
  `, [userId]).reverse();
  return {
    month,
    establishment_id: establishmentId || "",
    establishments,
    products,
    consumptions,
    closings,
    current_closing: currentClosing,
    limit,
    summary: {
      total: roundMoney(totals.total),
      open: roundMoney(totals.open),
      paid: roundMoney(amountPaid),
      payment_difference: paymentDifference,
      discount_received: paymentDifference < 0 ? roundMoney(Math.abs(paymentDifference)) : 0,
      extra_paid: paymentDifference > 0 ? paymentDifference : 0,
      count: totals.count,
      days: totals.days.size,
      daily_average: roundMoney(totals.days.size ? totals.total / totals.days.size : 0),
      status: monthPaid ? "paid" : "open",
      limit_value: limitValue,
      limit_remaining: roundMoney(limitValue - totals.total),
      limit_percent: limitValue ? Math.round((totals.total / limitValue) * 100) : 0,
      limit_exceeded: limitValue > 0 && totals.total > limitValue
    },
    charts: {
      by_month: monthlyRows,
      by_product: Object.entries(totals.products).map(([label, total]) => ({ label, total: roundMoney(total) })).sort((a, b) => b.total - a.total),
      by_day: Object.entries(totals.daily).map(([date, total]) => ({ date, total: roundMoney(total) })).sort((a, b) => b.total - a.total).slice(0, 8),
      comparison: {
        current: roundMoney(totals.total),
        previous: roundMoney(Number(get("SELECT COALESCE(SUM(total_value), 0) AS total FROM vendinha_consumptions WHERE user_id = ? AND substr(date, 1, 7) = ?", [userId, previousMonth(month)])?.total || 0))
      }
    }
  };
}

function previousMonth(month) {
  const [year, monthNumber] = String(month || currentMonth()).split("-").map(Number);
  const date = new Date(year, monthNumber - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function vendinhaPayload(payload, current = {}) {
  const productId = Number(payload.product_id ?? current.product_id ?? 0) || null;
  const product = productId ? get("SELECT * FROM vendinha_products WHERE id = ?", [productId]) : null;
  const quantity = Math.max(0.01, Number(payload.quantity ?? current.quantity ?? 1) || 1);
  const unitValue = Math.max(0, Number(payload.unit_value ?? product?.default_value ?? current.unit_value ?? 0) || 0);
  const productName = String(payload.product_name || product?.name || current.product_name || "").trim();
  if (!productName) {
    const error = new Error("Informe o produto consumido.");
    error.statusCode = 400;
    throw error;
  }
  const date = String(payload.date || current.date || currentDateTime().slice(0, 10)).slice(0, 10);
  return {
    establishment_id: vendinhaEstablishmentFilter(payload.establishment_id ?? current.establishment_id) || null,
    product_id: productId,
    date,
    product_name: productName,
    quantity,
    unit_value: unitValue,
    total_value: roundMoney(quantity * unitValue),
    notes: String(payload.notes ?? current.notes ?? "").trim(),
    status: vendinhaStatus(payload.status ?? current.status),
    payment_date: vendinhaStatus(payload.status ?? current.status) === "paid" ? String(payload.payment_date || current.payment_date || currentDateTime().slice(0, 10)).slice(0, 10) : ""
  };
}

function createVendinhaConsumption(userId, payload) {
  vendinhaEnsureDefaults(userId);
  const clean = vendinhaPayload(payload);
  vendinhaRequireChangeAllowed(userId, clean.date, clean.establishment_id, payload);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO vendinha_consumptions (user_id, establishment_id, product_id, date, product_name, quantity, unit_value, total_value, notes, status, payment_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, clean.establishment_id, clean.product_id, clean.date, clean.product_name, clean.quantity, clean.unit_value, clean.total_value, clean.notes, clean.status, clean.payment_date, now, now]);
  recordTimeline("Consumo na vendinha", `${clean.product_name} - ${moneyText(clean.total_value)}`, "vendinha");
  return get("SELECT * FROM vendinha_consumptions WHERE id = ?", [result.lastInsertRowid]);
}

function moneyText(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

function updateVendinhaConsumption(userId, id, payload) {
  const current = get("SELECT * FROM vendinha_consumptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Lancamento nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
  const clean = vendinhaPayload(payload, current);
  vendinhaRequireChangeAllowed(userId, current.date, current.establishment_id, payload);
  vendinhaRequireChangeAllowed(userId, clean.date, clean.establishment_id, payload);
  run(`
    UPDATE vendinha_consumptions
    SET establishment_id = ?, product_id = ?, date = ?, product_name = ?, quantity = ?, unit_value = ?, total_value = ?, notes = ?, status = ?, payment_date = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [clean.establishment_id, clean.product_id, clean.date, clean.product_name, clean.quantity, clean.unit_value, clean.total_value, clean.notes, clean.status, clean.payment_date, currentDateTime(), id, userId]);
  return get("SELECT * FROM vendinha_consumptions WHERE id = ?", [id]);
}

function deleteVendinhaConsumption(userId, id, payload = {}) {
  const current = get("SELECT * FROM vendinha_consumptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Lancamento nao encontrado.");
    error.statusCode = 404;
    throw error;
  }
  vendinhaRequireChangeAllowed(userId, current.date, current.establishment_id, payload);
  run("DELETE FROM vendinha_consumptions WHERE id = ? AND user_id = ?", [id, userId]);
  return { ok: true };
}

function closeVendinhaMonth(userId, payload) {
  const month = vendinhaMonth(payload.month);
  const establishmentId = vendinhaEstablishmentFilter(payload.establishment_id);
  const where = ["user_id = ?", "substr(date, 1, 7) = ?"];
  const values = [userId, month];
  if (establishmentId) {
    where.push("establishment_id = ?");
    values.push(establishmentId);
  }
  const total = Number(get(`SELECT COALESCE(SUM(total_value), 0) AS total FROM vendinha_consumptions WHERE ${where.join(" AND ")}`, values)?.total || 0);
  const hasTotalPaid = payload.total_paid !== undefined && payload.total_paid !== null && String(payload.total_paid).trim() !== "";
  const totalPaid = hasTotalPaid ? Number(payload.total_paid) : total;
  if (!Number.isFinite(totalPaid) || totalPaid < 0) {
    const error = new Error("Informe um valor pago valido, igual ou maior que zero.");
    error.statusCode = 400;
    throw error;
  }
  const paidDate = String(payload.payment_date || currentDateTime().slice(0, 10)).slice(0, 10);
  run(`UPDATE vendinha_consumptions SET status = 'paid', payment_date = ?, updated_at = ? WHERE ${where.join(" AND ")}`, [paidDate, currentDateTime(), ...values]);
  run(
    `DELETE FROM vendinha_month_closings WHERE user_id = ? AND month = ? AND ${establishmentId ? "establishment_id = ?" : "establishment_id IS NULL"}`,
    establishmentId ? [userId, month, establishmentId] : [userId, month]
  );
  run(`
    INSERT INTO vendinha_month_closings (user_id, month, establishment_id, total_consumed, total_paid, status, payment_date, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)
  `, [userId, month, establishmentId, roundMoney(total), roundMoney(totalPaid), paidDate, String(payload.notes || "").trim(), currentDateTime(), currentDateTime()]);
  const difference = roundMoney(totalPaid - total);
  const adjustment = difference < 0 ? `desconto de ${moneyText(Math.abs(difference))}` : difference > 0 ? `acrescimo de ${moneyText(difference)}` : "valor exato da conta";
  recordTimeline("Mes da vendinha pago", `${month} - ${moneyText(totalPaid)} (${adjustment})`, "vendinha");
  return { ok: true, month, total_consumed: roundMoney(total), total_paid: roundMoney(totalPaid), payment_difference: difference, payment_date: paidDate };
}

function reopenVendinhaMonth(userId, payload) {
  const month = vendinhaMonth(payload.month);
  const establishmentId = vendinhaEstablishmentFilter(payload.establishment_id);
  const consumptionWhere = ["user_id = ?", "substr(date, 1, 7) = ?"];
  const consumptionValues = [userId, month];
  if (establishmentId) {
    consumptionWhere.push("establishment_id = ?");
    consumptionValues.push(establishmentId);
  }
  const closingWhere = `user_id = ? AND month = ? AND ${establishmentId ? "establishment_id = ?" : "establishment_id IS NULL"}`;
  const closingValues = establishmentId ? [userId, month, establishmentId] : [userId, month];
  const closing = get(`SELECT * FROM vendinha_month_closings WHERE ${closingWhere} ORDER BY id DESC LIMIT 1`, closingValues);
  const paidCount = Number(get(`SELECT COUNT(*) AS count FROM vendinha_consumptions WHERE ${consumptionWhere.join(" AND ")} AND status = 'paid'`, consumptionValues)?.count || 0);
  if (!closing && !paidCount) {
    const error = new Error("Nao existe pagamento para estornar nesse mes.");
    error.statusCode = 404;
    throw error;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    run(`UPDATE vendinha_consumptions SET status = 'open', payment_date = NULL, updated_at = ? WHERE ${consumptionWhere.join(" AND ")}`, [currentDateTime(), ...consumptionValues]);
    run(`DELETE FROM vendinha_month_closings WHERE ${closingWhere}`, closingValues);
    recordTimeline("Pagamento da vendinha estornado", `${month} - ${moneyText(closing?.total_paid || 0)}`, "vendinha");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, month, reopened: paidCount, previous_total_paid: roundMoney(Number(closing?.total_paid || 0)) };
}

function saveVendinhaLimit(userId, payload) {
  const month = vendinhaMonth(payload.month);
  const establishmentId = vendinhaEstablishmentFilter(payload.establishment_id);
  const value = Math.max(0, Number(payload.limit_value || 0) || 0);
  run(
    `DELETE FROM vendinha_month_limits WHERE user_id = ? AND month = ? AND ${establishmentId ? "establishment_id = ?" : "establishment_id IS NULL"}`,
    establishmentId ? [userId, month, establishmentId] : [userId, month]
  );
  run(`
    INSERT INTO vendinha_month_limits (user_id, month, establishment_id, limit_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [userId, month, establishmentId, value, currentDateTime(), currentDateTime()]);
  return { ok: true, month, establishment_id: establishmentId, limit_value: value };
}

const subscriptionCategories = ["Streaming", "Musica", "Musica/Streaming", "Cloud/Armazenamento", "Jogos", "Estudos", "Aplicativos", "Seguranca", "Trabalho", "Outros"];
const subscriptionStatuses = ["Ativa", "Pausada", "Cancelada"];
const subscriptionWorthOptions = ["Sim", "Nao", "Em analise"];
const subscriptionFrequencies = ["semanal", "mensal", "bimestral", "trimestral", "semestral", "anual"];

function subscriptionMonth(value = "") {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : currentMonth();
}

function subscriptionMonthlyFactor(frequency = "mensal") {
  return {
    semanal: 52 / 12,
    mensal: 1,
    bimestral: 1 / 2,
    trimestral: 1 / 3,
    semestral: 1 / 6,
    anual: 1 / 12
  }[String(frequency || "mensal").toLowerCase()] || 1;
}

function subscriptionNextChargeDate(dateText, frequency = "mensal", fixedDay = null) {
  const frequencyText = String(frequency || "mensal").toLowerCase();
  if (frequencyText === "semanal") return addDays(dateText || todayDate(), 7);
  const months = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12 }[frequencyText] || 1;
  let next = addMonths(dateText || todayDate(), months);
  const day = Math.max(1, Math.min(31, Number(fixedDay || 0) || 0));
  if (day) {
    const [year, month] = next.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    next = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  }
  return next;
}

function subscriptionDueInfo(item) {
  if (item.status === "Cancelada") return { tone: "gray", text: "Cancelada" };
  if (!item.next_charge_date) return { tone: "gray", text: "Sem data" };
  const diff = Math.ceil((new Date(`${item.next_charge_date}T00:00:00`) - new Date(`${todayDate()}T00:00:00`)) / 86400000);
  if (diff < 0) return { tone: "red", text: `Vencida ha ${Math.abs(diff)} dia(s)`, days: diff };
  if (diff === 0) return { tone: "orange", text: "Cobra hoje", days: diff };
  if (diff === 1) return { tone: "orange", text: "Cobra amanha", days: diff };
  if (diff <= 3) return { tone: "orange", text: `Cobra em ${diff} dias`, days: diff };
  if (diff <= 7) return { tone: "yellow", text: `Cobra em ${diff} dias`, days: diff };
  return { tone: "green", text: `Proxima cobranca em ${diff} dias`, days: diff };
}

function normalizeSubscriptionPayload(payload = {}, current = {}) {
  const amount = Math.max(0, Number(payload.amount ?? current.amount ?? 0) || 0);
  const totalValue = Math.max(0, Number(payload.total_value ?? current.total_value ?? amount) || amount);
  const myShare = Math.max(0, Number(payload.my_share ?? current.my_share ?? amount) || amount);
  const status = subscriptionStatuses.includes(String(payload.status ?? current.status ?? "")) ? String(payload.status ?? current.status) : "Ativa";
  const worth = subscriptionWorthOptions.includes(String(payload.worth_it ?? current.worth_it ?? "")) ? String(payload.worth_it ?? current.worth_it) : "Em analise";
  const frequency = subscriptionFrequencies.includes(String(payload.frequency ?? current.frequency ?? "").toLowerCase()) ? String(payload.frequency ?? current.frequency).toLowerCase() : "mensal";
  const name = String(payload.name ?? current.name ?? "").trim();
  if (!name) {
    const error = new Error("Informe o nome da assinatura.");
    error.statusCode = 400;
    throw error;
  }
  return {
    name,
    provider: String(payload.provider ?? current.provider ?? "").trim(),
    category: String(payload.category ?? current.category ?? "Outros").trim() || "Outros",
    description: String(payload.description ?? current.description ?? "").trim(),
    status,
    worth_it: worth,
    amount: roundMoney(amount),
    currency: String(payload.currency ?? current.currency ?? "BRL").trim() || "BRL",
    payment_method: String(payload.payment_method ?? current.payment_method ?? "").trim(),
    card_name: String(payload.card_name ?? current.card_name ?? "").trim(),
    card_last_four: String(payload.card_last_four ?? current.card_last_four ?? "").replace(/\D/g, "").slice(-4),
    payer: String(payload.payer ?? current.payer ?? "").trim(),
    shared: Number(payload.shared ?? current.shared ?? 0) ? 1 : 0,
    total_value: roundMoney(totalValue),
    my_share: roundMoney(myShare),
    shared_people: String(payload.shared_people ?? current.shared_people ?? "").trim(),
    frequency,
    first_payment_date: String(payload.first_payment_date ?? current.first_payment_date ?? "").slice(0, 10),
    next_charge_date: String(payload.next_charge_date ?? current.next_charge_date ?? "").slice(0, 10),
    fixed_charge_day: Math.max(0, Math.min(31, Number(payload.fixed_charge_day ?? current.fixed_charge_day ?? 0) || 0)),
    auto_generate: Number(payload.auto_generate ?? current.auto_generate ?? 1) ? 1 : 0,
    notes: String(payload.notes ?? current.notes ?? "").trim()
  };
}

function subscriptionEnsureDefaults(userId) {
  const existing = get("SELECT COUNT(*) AS count FROM recurring_subscriptions WHERE user_id = ?", [userId]).count;
  if (existing) return;
  const now = currentDateTime();
  const seeds = [
    {
      name: "Google One",
      provider: "Google",
      category: "Cloud/Armazenamento",
      amount: 9.99,
      payment_method: "Cartao final 1156",
      card_last_four: "1156",
      payer: "Dauan",
      first_payment_date: "2026-05-28",
      next_charge_date: "2026-06-28",
      fixed_charge_day: 28,
      notes: "Armazenamento em nuvem.",
      payment_date: "2026-05-28"
    },
    {
      name: "YouTube Premium / YouTube Music Estudante",
      provider: "YouTube",
      category: "Musica/Streaming",
      amount: 16.9,
      payment_method: "Cartao final 1156",
      card_last_four: "1156",
      payer: "Dauan",
      first_payment_date: "2026-06-02",
      next_charge_date: "2026-07-02",
      fixed_charge_day: 2,
      notes: "O estatuto de estudante expira em 01/04/2027.",
      payment_date: "2026-06-02"
    }
  ];
  for (const item of seeds) {
    const result = run(`
      INSERT INTO recurring_subscriptions (user_id, name, provider, category, description, status, worth_it, amount, currency, payment_method, card_name, card_last_four, payer, shared, total_value, my_share, shared_people, frequency, first_payment_date, next_charge_date, fixed_charge_day, auto_generate, notes, last_paid_value, finance_integration_ready, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'Ativa', 'Em analise', ?, 'BRL', ?, '', ?, ?, 0, ?, ?, '', 'mensal', ?, ?, ?, 1, ?, ?, 1, ?, ?)
    `, [userId, item.name, item.provider, item.category, item.amount, item.payment_method, item.card_last_four, item.payer, item.amount, item.amount, item.first_payment_date, item.next_charge_date, item.fixed_charge_day, item.notes, item.amount, now, now]);
    run(`
      INSERT INTO subscription_payments (subscription_id, user_id, payment_date, due_date, amount_paid, payment_method, status, notes, finance_payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Pago', 'Pagamento inicial importado da planilha.', ?, ?, ?)
    `, [result.lastInsertRowid, userId, item.payment_date, item.payment_date, item.amount, item.payment_method, JSON.stringify({ module: "subscriptions", ready: true, status: "Pago", category: item.category }), now, now]);
  }
}

function subscriptionList(userId, query) {
  subscriptionEnsureDefaults(userId);
  const month = subscriptionMonth(query.get("month"));
  const where = ["user_id = ?"];
  const values = [userId];
  const search = String(query.get("search") || "").trim();
  if (search) {
    where.push("(name LIKE ? OR provider LIKE ? OR category LIKE ? OR notes LIKE ? OR payment_method LIKE ? OR card_last_four LIKE ?)");
    values.push(...Array(6).fill(`%${search}%`));
  }
  for (const field of ["status", "category", "payment_method", "payer", "worth_it"]) {
    const value = String(query.get(field) || "").trim();
    if (value) {
      where.push(`${field} = ?`);
      values.push(value);
    }
  }
  const shared = String(query.get("shared") || "").trim();
  if (shared) {
    where.push("shared = ?");
    values.push(shared === "sim" ? 1 : 0);
  }
  const subscriptions = all(`SELECT * FROM recurring_subscriptions WHERE ${where.join(" AND ")} ORDER BY status ASC, next_charge_date ASC, amount DESC`, values)
    .map((item) => ({ ...item, due: subscriptionDueInfo(item) }));
  const allSubscriptions = all("SELECT * FROM recurring_subscriptions WHERE user_id = ?", [userId]);
  const active = allSubscriptions.filter((item) => item.status === "Ativa");
  const canceled = allSubscriptions.filter((item) => item.status === "Cancelada");
  const paidRows = all("SELECT * FROM subscription_payments WHERE user_id = ? AND substr(payment_date, 1, 7) = ? ORDER BY payment_date DESC", [userId, month]);
  const paidMonth = paidRows.reduce((sum, item) => sum + Number(item.amount_paid || 0), 0);
  const pendingMonth = active.filter((item) => String(item.next_charge_date || "").slice(0, 7) === month).reduce((sum, item) => sum + Number(item.my_share || item.amount || 0), 0);
  const monthlyTotal = active.reduce((sum, item) => sum + Number(item.my_share || item.amount || 0) * subscriptionMonthlyFactor(item.frequency), 0);
  const nextCharge = active.filter((item) => item.next_charge_date).sort((a, b) => String(a.next_charge_date).localeCompare(String(b.next_charge_date)))[0] || null;
  const upcoming7 = active.filter((item) => {
    const info = subscriptionDueInfo(item);
    return Number(info.days) >= 0 && Number(info.days) <= 7;
  });
  const payments = all(`
    SELECT p.*, s.name AS subscription_name
    FROM subscription_payments p
    LEFT JOIN recurring_subscriptions s ON s.id = p.subscription_id
    WHERE p.user_id = ?
    ORDER BY p.payment_date DESC, p.id DESC
    LIMIT 80
  `, [userId]);
  const adjustments = all(`
    SELECT a.*, s.name AS subscription_name
    FROM subscription_adjustments a
    LEFT JOIN recurring_subscriptions s ON s.id = a.subscription_id
    WHERE a.user_id = ?
    ORDER BY a.adjustment_date DESC, a.id DESC
    LIMIT 80
  `, [userId]);
  const byCategory = {};
  const byPayment = {};
  const byMonth = {};
  active.forEach((item) => {
    const monthly = Number(item.my_share || item.amount || 0) * subscriptionMonthlyFactor(item.frequency);
    byCategory[item.category || "Outros"] = (byCategory[item.category || "Outros"] || 0) + monthly;
    byPayment[item.payment_method || "Sem forma"] = (byPayment[item.payment_method || "Sem forma"] || 0) + monthly;
  });
  allSubscriptions.forEach((item) => {
    if (item.status !== "Cancelada" && item.next_charge_date) {
      const key = String(item.next_charge_date).slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + Number(item.my_share || item.amount || 0);
    }
  });
  const calendar = allSubscriptions
    .filter((item) => item.next_charge_date)
    .map((item) => ({ id: item.id, name: item.name, category: item.category, amount: item.my_share || item.amount, date: item.next_charge_date, month: String(item.next_charge_date).slice(0, 7), status: item.status, due: subscriptionDueInfo(item) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    month,
    subscriptions,
    payments,
    adjustments,
    categories: [...new Set([...subscriptionCategories, ...allSubscriptions.map((item) => item.category).filter(Boolean)])],
    payment_methods: [...new Set(allSubscriptions.map((item) => item.payment_method).filter(Boolean))],
    payers: [...new Set(allSubscriptions.map((item) => item.payer).filter(Boolean))],
    summary: {
      monthly_total: roundMoney(monthlyTotal),
      annual_estimate: roundMoney(monthlyTotal * 12),
      active_count: active.length,
      canceled_count: canceled.length,
      next_charge: nextCharge,
      upcoming_7_count: upcoming7.length,
      paid_month: roundMoney(paidMonth),
      pending_month: roundMoney(Math.max(0, pendingMonth - paidMonth))
    },
    charts: {
      by_category: Object.entries(byCategory).map(([label, total]) => ({ label, total: roundMoney(total) })).sort((a, b) => b.total - a.total),
      by_payment: Object.entries(byPayment).map(([label, total]) => ({ label, total: roundMoney(total) })).sort((a, b) => b.total - a.total),
      by_month: Object.entries(byMonth).map(([label, total]) => ({ label, total: roundMoney(total) })).sort((a, b) => a.label.localeCompare(b.label)).slice(-12),
      most_expensive: active.map((item) => ({ label: item.name, total: Number(item.my_share || item.amount || 0) })).sort((a, b) => b.total - a.total).slice(0, 8),
      status: [{ label: "Ativas", total: active.length }, { label: "Canceladas", total: canceled.length }, { label: "Pausadas", total: allSubscriptions.filter((item) => item.status === "Pausada").length }]
    },
    calendar
  };
}

function subscriptionDetail(userId, id) {
  const record = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!record) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return {
    ...record,
    due: subscriptionDueInfo(record),
    payments: all("SELECT * FROM subscription_payments WHERE subscription_id = ? AND user_id = ? ORDER BY payment_date DESC, id DESC", [id, userId]),
    adjustments: all("SELECT * FROM subscription_adjustments WHERE subscription_id = ? AND user_id = ? ORDER BY adjustment_date DESC, id DESC", [id, userId]),
    shares: all("SELECT * FROM subscription_shares WHERE subscription_id = ? AND user_id = ? ORDER BY person_name ASC", [id, userId])
  };
}

function saveSubscriptionShares(userId, subscriptionId, sharedPeople = "", total = 0, myShare = 0) {
  run("DELETE FROM subscription_shares WHERE subscription_id = ? AND user_id = ?", [subscriptionId, userId]);
  String(sharedPeople || "").split(",").map((name) => name.trim()).filter(Boolean).forEach((name) => {
    run("INSERT INTO subscription_shares (subscription_id, user_id, person_name, amount, notes, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)", [subscriptionId, userId, name, roundMoney(Math.max(0, (Number(total || 0) - Number(myShare || 0)) / Math.max(1, String(sharedPeople).split(",").filter(Boolean).length))), currentDateTime(), currentDateTime()]);
  });
}

function createSubscription(userId, payload) {
  const clean = normalizeSubscriptionPayload(payload);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO recurring_subscriptions (user_id, name, provider, category, description, status, worth_it, amount, currency, payment_method, card_name, card_last_four, payer, shared, total_value, my_share, shared_people, frequency, first_payment_date, next_charge_date, fixed_charge_day, auto_generate, notes, finance_integration_ready, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `, [userId, clean.name, clean.provider, clean.category, clean.description, clean.status, clean.worth_it, clean.amount, clean.currency, clean.payment_method, clean.card_name, clean.card_last_four, clean.payer, clean.shared, clean.total_value, clean.my_share, clean.shared_people, clean.frequency, clean.first_payment_date, clean.next_charge_date, clean.fixed_charge_day, clean.auto_generate, clean.notes, now, now]);
  saveSubscriptionShares(userId, result.lastInsertRowid, clean.shared_people, clean.total_value, clean.my_share);
  recordTimeline("Assinatura criada", `${clean.name} - ${moneyText(clean.my_share)}`, "subscriptions");
  return subscriptionDetail(userId, result.lastInsertRowid);
}

function updateSubscription(userId, id, payload) {
  const current = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const clean = normalizeSubscriptionPayload(payload, current);
  if (Number(clean.amount) !== Number(current.amount)) {
    run("INSERT INTO subscription_adjustments (subscription_id, user_id, adjustment_date, old_value, new_value, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, userId, todayDate(), Number(current.amount || 0), clean.amount, String(payload.adjustment_notes || "Valor alterado no cadastro.").trim(), currentDateTime()]);
  }
  run(`
    UPDATE recurring_subscriptions
    SET name = ?, provider = ?, category = ?, description = ?, status = ?, worth_it = ?, amount = ?, currency = ?, payment_method = ?, card_name = ?, card_last_four = ?, payer = ?, shared = ?, total_value = ?, my_share = ?, shared_people = ?, frequency = ?, first_payment_date = ?, next_charge_date = ?, fixed_charge_day = ?, auto_generate = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [clean.name, clean.provider, clean.category, clean.description, clean.status, clean.worth_it, clean.amount, clean.currency, clean.payment_method, clean.card_name, clean.card_last_four, clean.payer, clean.shared, clean.total_value, clean.my_share, clean.shared_people, clean.frequency, clean.first_payment_date, clean.next_charge_date, clean.fixed_charge_day, clean.auto_generate, clean.notes, currentDateTime(), id, userId]);
  saveSubscriptionShares(userId, id, clean.shared_people, clean.total_value, clean.my_share);
  recordTimeline("Assinatura atualizada", clean.name, "subscriptions");
  return subscriptionDetail(userId, id);
}

function markSubscriptionPaid(userId, id, payload = {}) {
  const current = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const amount = roundMoney(Number(payload.amount_paid ?? current.my_share ?? current.amount ?? 0) || 0);
  const paymentDate = String(payload.payment_date || todayDate()).slice(0, 10);
  const dueDate = String(payload.due_date || current.next_charge_date || paymentDate).slice(0, 10);
  const method = String(payload.payment_method || current.payment_method || "").trim();
  const financePayload = JSON.stringify({ module: "subscriptions", ready: true, name: current.name, amount, category: current.category, due_date: dueDate, payment_method: method, status: "Pago" });
  run(`
    INSERT INTO subscription_payments (subscription_id, user_id, payment_date, due_date, amount_paid, payment_method, status, notes, finance_payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Pago', ?, ?, ?, ?)
  `, [id, userId, paymentDate, dueDate, amount, method, String(payload.notes || "").trim(), financePayload, currentDateTime(), currentDateTime()]);
  const nextCharge = Number(current.auto_generate) ? subscriptionNextChargeDate(dueDate, current.frequency, current.fixed_charge_day) : current.next_charge_date;
  run("UPDATE recurring_subscriptions SET next_charge_date = ?, last_paid_value = ?, updated_at = ? WHERE id = ? AND user_id = ?", [nextCharge, amount, currentDateTime(), id, userId]);
  recordTimeline("Assinatura paga", `${current.name} - ${moneyText(amount)}`, "subscriptions");
  return subscriptionDetail(userId, id);
}

function pauseSubscription(userId, id) {
  const current = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const nextStatus = current.status === "Pausada" ? "Ativa" : "Pausada";
  run("UPDATE recurring_subscriptions SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?", [nextStatus, currentDateTime(), id, userId]);
  recordTimeline(nextStatus === "Pausada" ? "Assinatura pausada" : "Assinatura reativada", current.name, "subscriptions");
  return subscriptionDetail(userId, id);
}

function cancelSubscription(userId, id, payload = {}) {
  const current = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  run("UPDATE recurring_subscriptions SET status = 'Cancelada', canceled_at = ?, cancel_reason = ?, last_paid_value = ?, updated_at = ? WHERE id = ? AND user_id = ?", [todayDate(), String(payload.reason || payload.cancel_reason || "").trim(), Number(current.last_paid_value || current.my_share || current.amount || 0), currentDateTime(), id, userId]);
  recordTimeline("Assinatura cancelada", current.name, "subscriptions");
  return subscriptionDetail(userId, id);
}

function deleteSubscription(userId, id) {
  const current = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  run("DELETE FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  recordTimeline("Assinatura removida", current.name, "subscriptions");
  return { ok: true };
}

function createSubscriptionAdjustment(userId, id, payload = {}) {
  const current = get("SELECT * FROM recurring_subscriptions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Assinatura nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const oldValue = roundMoney(Number(payload.old_value ?? current.amount ?? 0) || 0);
  const newValue = roundMoney(Number(payload.new_value ?? current.amount ?? 0) || 0);
  run("INSERT INTO subscription_adjustments (subscription_id, user_id, adjustment_date, old_value, new_value, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, userId, String(payload.adjustment_date || todayDate()).slice(0, 10), oldValue, newValue, String(payload.notes || "").trim(), currentDateTime()]);
  run("UPDATE recurring_subscriptions SET amount = ?, my_share = ?, total_value = ?, updated_at = ? WHERE id = ? AND user_id = ?", [newValue, newValue, newValue, currentDateTime(), id, userId]);
  return subscriptionDetail(userId, id);
}

const codexPlans = ["Free", "Plus", "Plus Permanente"];
const codexResetTypes = ["5 horas", "Semanal", "Manual"];

function addHoursDateTime(dateText, hours) {
  const source = normalizeDateTime(dateText || currentDateTime()).replace(" ", "T");
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return currentDateTime(new Date(Date.now() + Number(hours || 0) * 60 * 60 * 1000));
  date.setHours(date.getHours() + Number(hours || 0));
  return currentDateTime(date);
}

function codexNextWeeklyReset(weeklyResetAt = "", fromDate = new Date()) {
  const match = String(weeklyResetAt || "").match(/^([0-6])\s+(\d{2}):(\d{2})$/);
  if (!match) return "";
  const [, dayText, hourText, minuteText] = match;
  const targetDay = Number(dayText);
  const date = new Date(fromDate);
  date.setSeconds(0, 0);
  const diff = (targetDay - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + diff);
  date.setHours(Number(hourText), Number(minuteText), 0, 0);
  if (date <= fromDate) date.setDate(date.getDate() + 7);
  return currentDateTime(date);
}

function codexAccountStatus(account, nowText = currentDateTime()) {
  if (!account) return "Sem informacao";
  if (String(account.manual_status || "") === "Vencido") return "Vencido";
  if (account.plan_expires_at && String(account.plan_expires_at).slice(0, 10) < todayDate()) return "Vencido";
  if (!account.next_available_at) return account.last_used_at ? "Sem informacao" : "Disponivel";
  const next = normalizeDateTime(account.next_available_at);
  const now = normalizeDateTime(nowText);
  if (next <= now) return "Disponivel";
  const minutes = Math.ceil((new Date(next.replace(" ", "T")) - new Date(now.replace(" ", "T"))) / 60000);
  if (minutes <= 30) return "Liberando em breve";
  return "Em espera";
}

function codexCountdown(account, nowText = currentDateTime()) {
  if (!account?.next_available_at) return "";
  const diff = new Date(normalizeDateTime(account.next_available_at).replace(" ", "T")) - new Date(normalizeDateTime(nowText).replace(" ", "T"));
  if (!Number.isFinite(diff) || diff <= 0) return "Agora";
  const minutes = Math.ceil(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest} min`;
  return `${hours}h ${String(rest).padStart(2, "0")}min`;
}

function normalizeCodexPayload(payload = {}, current = {}) {
  const email = String(payload.email ?? current.email ?? "").trim().toLowerCase();
  if (!email) {
    const error = new Error("Informe o e-mail da conta Codex.");
    error.statusCode = 400;
    throw error;
  }
  const plan = codexPlans.includes(String(payload.plan ?? current.plan ?? "")) ? String(payload.plan ?? current.plan) : "Free";
  const resetType = codexResetTypes.includes(String(payload.reset_type ?? current.reset_type ?? "")) ? String(payload.reset_type ?? current.reset_type) : "Manual";
  const manualStatus = ["", "Vencido"].includes(String(payload.manual_status ?? current.manual_status ?? "")) ? String(payload.manual_status ?? current.manual_status ?? "") : "";
  return {
    email,
    plan,
    reset_type: resetType,
    last_used_at: normalizeOptionalDateTime(payload.last_used_at ?? current.last_used_at),
    next_available_at: normalizeOptionalDateTime(payload.next_available_at ?? current.next_available_at),
    weekly_reset_at: String(payload.weekly_reset_at ?? current.weekly_reset_at ?? "").trim(),
    phone_linked: Number(payload.phone_linked ?? current.phone_linked ?? 0) ? 1 : 0,
    phone_notes: String(payload.phone_notes ?? current.phone_notes ?? "").trim(),
    notes: String(payload.notes ?? current.notes ?? "").trim(),
    tags: String(payload.tags ?? current.tags ?? "").trim(),
    manual_status: manualStatus,
    plan_expires_at: String(payload.plan_expires_at ?? current.plan_expires_at ?? "").slice(0, 10)
  };
}

function normalizeOptionalDateTime(value) {
  const text = String(value || "").trim();
  return text ? normalizeDateTime(text) : "";
}

function codexDecorate(account, now = currentDateTime()) {
  const status = codexAccountStatus(account, now);
  return {
    ...account,
    status,
    countdown: codexCountdown(account, now),
    tags_list: String(account.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean)
  };
}

function codexEnsureDefaults(userId) {
  const existing = get("SELECT COUNT(*) AS count FROM codex_accounts WHERE user_id = ?", [userId]).count;
  if (existing) return;
  const now = currentDateTime();
  const seeds = [
    ["infraestrutura.ti@hospitalhr.com.br", "Plus Permanente", "5 horas", "", "", "", 1, "telefone vinculado ao TI", "Conta permanente do TI", "ti,permanente"],
    ["dauanrs99@gmail.com", "Free", "Manual", "", "2026-07-11 00:00:00", "", 1, "telefone vinculado ao TI", "", "free"],
    ["dauan.ribeiro.hr@gmail.com", "Plus", "5 horas", "", "", "3 22:50", 0, "", "Valido ate 03/07/2026.", "plus,reset-semanal"],
    ["dauanribeirosilva2019@gmail.com", "Free", "Manual", "", "2026-07-11 00:00:00", "", 0, "", "", "free"],
    ["dauanrs2022@gmail.com", "Free", "Manual", "", "2026-07-11 00:00:00", "", 0, "", "", "free"],
    ["midauanrs@gmail.com", "Free", "Manual", "", "2026-07-11 00:00:00", "", 0, "", "", "free"],
    ["dauanrs2002@gmail.com", "Free", "Manual", "", "2026-07-11 00:00:00", "", 1, "telefone da Geo", "Coloquei o telefone da Geo.", "free,geo"],
    ["dauanrs6@gmail.com", "Free", "Manual", "", "2026-07-02 00:00:00", "", 0, "", "", "free"]
  ];
  seeds.forEach((item) => {
    run(`
      INSERT OR IGNORE INTO codex_accounts (user_id, email, plan, reset_type, last_used_at, next_available_at, weekly_reset_at, phone_linked, phone_notes, notes, tags, manual_status, plan_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
    `, [userId, ...item, now, now]);
  });
}

function codexList(userId, query) {
  codexEnsureDefaults(userId);
  const where = ["user_id = ?"];
  const values = [userId];
  const search = String(query.get("search") || "").trim();
  if (search) {
    where.push("(email LIKE ? OR notes LIKE ? OR tags LIKE ? OR phone_notes LIKE ?)");
    values.push(...Array(4).fill(`%${search}%`));
  }
  for (const field of ["plan", "reset_type"]) {
    const value = String(query.get(field) || "").trim();
    if (value) {
      where.push(`${field} = ?`);
      values.push(value);
    }
  }
  const phone = String(query.get("phone_linked") || "").trim();
  if (phone) {
    where.push("phone_linked = ?");
    values.push(phone === "sim" ? 1 : 0);
  }
  const now = currentDateTime();
  let accounts = all(`SELECT * FROM codex_accounts WHERE ${where.join(" AND ")} ORDER BY COALESCE(next_available_at, '1900-01-01') ASC, email ASC`, values)
    .map((account) => codexDecorate(account, now));
  const status = String(query.get("status") || "").trim();
  if (status) accounts = accounts.filter((account) => account.status === status);
  const allAccounts = all("SELECT * FROM codex_accounts WHERE user_id = ?", [userId]).map((account) => codexDecorate(account, now));
  const upcoming = allAccounts.filter((account) => ["Em espera", "Liberando em breve"].includes(account.status)).sort((a, b) => String(a.next_available_at || "").localeCompare(String(b.next_available_at || "")));
  const alerts = {
    soon: allAccounts.filter((account) => account.status === "Liberando em breve"),
    expired: allAccounts.filter((account) => account.status === "Vencido"),
    no_phone: allAccounts.filter((account) => !account.phone_linked),
    no_notes: allAccounts.filter((account) => !String(account.notes || "").trim()),
    weekly_plus: allAccounts.filter((account) => account.plan.includes("Plus") && account.weekly_reset_at)
  };
  return {
    accounts,
    plans: codexPlans,
    reset_types: codexResetTypes,
    statuses: ["Disponivel", "Em espera", "Liberando em breve", "Vencido", "Sem informacao"],
    summary: {
      total: allAccounts.length,
      plus: allAccounts.filter((account) => account.plan === "Plus").length,
      free: allAccounts.filter((account) => account.plan === "Free").length,
      permanent: allAccounts.filter((account) => account.plan === "Plus Permanente").length,
      available: allAccounts.filter((account) => account.status === "Disponivel").length,
      waiting: allAccounts.filter((account) => ["Em espera", "Liberando em breve"].includes(account.status)).length,
      upcoming: upcoming.slice(0, 3),
      phone_linked: allAccounts.filter((account) => account.phone_linked).length
    },
    alerts
  };
}

function codexDetail(userId, id) {
  const account = get("SELECT * FROM codex_accounts WHERE id = ? AND user_id = ?", [id, userId]);
  if (!account) {
    const error = new Error("Conta Codex nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return codexDecorate(account);
}

function createCodexAccount(userId, payload) {
  const clean = normalizeCodexPayload(payload);
  const now = currentDateTime();
  const result = run(`
    INSERT INTO codex_accounts (user_id, email, plan, reset_type, last_used_at, next_available_at, weekly_reset_at, phone_linked, phone_notes, notes, tags, manual_status, plan_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, clean.email, clean.plan, clean.reset_type, clean.last_used_at, clean.next_available_at, clean.weekly_reset_at, clean.phone_linked, clean.phone_notes, clean.notes, clean.tags, clean.manual_status, clean.plan_expires_at, now, now]);
  recordTimeline("Conta Codex cadastrada", clean.email, "codex-manager");
  return codexDetail(userId, result.lastInsertRowid);
}

function updateCodexAccount(userId, id, payload) {
  const current = get("SELECT * FROM codex_accounts WHERE id = ? AND user_id = ?", [id, userId]);
  if (!current) {
    const error = new Error("Conta Codex nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  const clean = normalizeCodexPayload(payload, current);
  run(`
    UPDATE codex_accounts
    SET email = ?, plan = ?, reset_type = ?, last_used_at = ?, next_available_at = ?, weekly_reset_at = ?, phone_linked = ?, phone_notes = ?, notes = ?, tags = ?, manual_status = ?, plan_expires_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [clean.email, clean.plan, clean.reset_type, clean.last_used_at, clean.next_available_at, clean.weekly_reset_at, clean.phone_linked, clean.phone_notes, clean.notes, clean.tags, clean.manual_status, clean.plan_expires_at, currentDateTime(), id, userId]);
  recordTimeline("Conta Codex atualizada", clean.email, "codex-manager");
  return codexDetail(userId, id);
}

function deleteCodexAccount(userId, id) {
  const current = codexDetail(userId, id);
  run("DELETE FROM codex_accounts WHERE id = ? AND user_id = ?", [id, userId]);
  recordTimeline("Conta Codex removida", current.email, "codex-manager");
  return { ok: true };
}

function useCodexAccountNow(userId, id) {
  const current = codexDetail(userId, id);
  const now = currentDateTime();
  let next = current.next_available_at || "";
  if (current.reset_type === "5 horas") next = addHoursDateTime(now, 5);
  if (current.reset_type === "Semanal") next = codexNextWeeklyReset(current.weekly_reset_at) || next;
  run("UPDATE codex_accounts SET last_used_at = ?, next_available_at = ?, manual_status = '', updated_at = ? WHERE id = ? AND user_id = ?", [now, next, now, id, userId]);
  recordTimeline("Conta Codex usada", current.email, "codex-manager");
  return codexDetail(userId, id);
}

function markCodexAccountAvailable(userId, id) {
  const now = currentDateTime();
  run("UPDATE codex_accounts SET next_available_at = ?, manual_status = '', updated_at = ? WHERE id = ? AND user_id = ?", [now, now, id, userId]);
  return codexDetail(userId, id);
}

function quickNoteCodexAccount(userId, id, payload = {}) {
  const current = codexDetail(userId, id);
  const note = String(payload.note || payload.notes || "").trim();
  if (!note) return current;
  const stamp = formatDateTimeBR(currentDateTime());
  const notes = [current.notes, `[${stamp}] ${note}`].filter(Boolean).join("\n");
  run("UPDATE codex_accounts SET notes = ?, updated_at = ? WHERE id = ? AND user_id = ?", [notes, currentDateTime(), id, userId]);
  return codexDetail(userId, id);
}

function formatDateTimeBR(value) {
  const text = normalizeDateTime(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}` : text;
}

function formatDateOnlyBR(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
}

const drsoAiSystemPrompt = `Voce e o DRSO AI Core, assistente inteligente do DRSOSystem. Seu papel e ajudar Dauan em perguntas gerais, tecnologia, textos, ideias, estudos, vida pessoal, financeiro, projetos, servidores, tarefas, Codex, Steam, documentos e metas. Responda de forma clara, direta e util. Para perguntas gerais fora do DRSOSystem, responda normalmente com seu conhecimento. Para perguntas sobre dados do DRSOSystem, use o contexto seguro das tools internas e nao invente registros, valores, prazos, senhas, tokens ou credenciais. Se faltar informacao do sistema, diga que nao encontrou no sistema. Para acoes que alteram dados, peca confirmacao antes de executar.`;
const aiSensitivePattern = /(password|senha|token|apikey|api_key|secret|privatekey|private_key|credential|credencial|documento sensivel|encrypted|hash|chave)/i;
const aiRateLimit = new Map();

async function aiReadOpenAiSettings() {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(openAiSettingsPath, "utf8"));
  } catch {
    saved = {};
  }
  const envKey = String(runtimeProcess?.env?.OPENAI_API_KEY || localEnv.OPENAI_API_KEY || "").trim();
  const savedKey = decryptVaultText(saved.encrypted_api_key || "");
  const envModel = String(runtimeProcess?.env?.OPENAI_MODEL || localEnv.OPENAI_MODEL || "").trim();
  const savedModel = String(saved.model || "").trim();
  return {
    apiKey: envKey || savedKey,
    model: envModel || savedModel || "gpt-5.5",
    source: envKey ? "env" : savedKey ? "saved" : "none",
    hasKey: Boolean(envKey || savedKey),
    savedHasKey: Boolean(savedKey)
  };
}

async function aiPublicConfig() {
  return {
    has_key: false,
    key_source: "local",
    model: "local",
    can_answer_general: false,
    message: "IA local ativa. Respondo usando os dados e ferramentas do DRSOSystem, sem custo de API."
  };
}

async function aiSaveOpenAiSettings(payload = {}) {
  void payload;
  return aiPublicConfig();
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeContext(value, depth = 0) {
  if (depth > 5) return "[limite]";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeContext(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (aiSensitivePattern.test(key)) continue;
    clean[key] = sanitizeContext(item, depth + 1);
  }
  return clean;
}

function aiCheckRateLimit(userId) {
  const now = Date.now();
  const bucket = aiRateLimit.get(userId) || [];
  const recent = bucket.filter((time) => now - time < 60_000);
  if (recent.length >= 20) {
    const error = new Error("Muitas mensagens em pouco tempo. Aguarde um minuto.");
    error.statusCode = 429;
    throw error;
  }
  recent.push(now);
  aiRateLimit.set(userId, recent);
}

function aiConversation(userId, conversationId = null, title = "Nova conversa") {
  if (conversationId) {
    const current = get("SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?", [Number(conversationId), userId]);
    if (current) return current;
  }
  const now = currentDateTime();
  const result = run("INSERT INTO ai_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [userId, title, now, now]);
  return get("SELECT * FROM ai_conversations WHERE id = ?", [result.lastInsertRowid]);
}

function aiConversationTitle(message) {
  const text = compactText(message, 52);
  return text || "Nova conversa";
}

function aiMessageRow(row) {
  return {
    ...row,
    sources: safeJsonParse(row.sources, []),
    actions: safeJsonParse(row.actions, [])
  };
}

function aiConversationDetail(userId, id) {
  const conversation = get("SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?", [Number(id), userId]);
  if (!conversation) {
    const error = new Error("Conversa nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return {
    ...conversation,
    messages: all("SELECT * FROM ai_messages WHERE conversation_id = ? AND user_id = ? ORDER BY id ASC", [conversation.id, userId]).map(aiMessageRow)
  };
}

function aiConversations(userId) {
  return all(`
    SELECT c.*, (
      SELECT content FROM ai_messages m WHERE m.conversation_id = c.id AND m.user_id = c.user_id ORDER BY m.id DESC LIMIT 1
    ) AS last_message
    FROM ai_conversations c
    WHERE c.user_id = ?
    ORDER BY c.favorite DESC, c.updated_at DESC, c.id DESC
  `, [userId]);
}

function aiSaveMessage(userId, conversationId, role, content, sources = [], actions = []) {
  const now = currentDateTime();
  run("INSERT INTO ai_messages (user_id, conversation_id, role, content, sources, actions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    userId,
    conversationId,
    role,
    String(content || ""),
    JSON.stringify(sources || []),
    JSON.stringify(actions || []),
    now
  ]);
  run("UPDATE ai_conversations SET updated_at = ? WHERE id = ? AND user_id = ?", [now, conversationId, userId]);
}

function aiMemories(userId) {
  return all("SELECT id, content, category, created_at, updated_at FROM ai_memories WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 30", [userId]);
}

function aiSeedMemories(userId) {
  const existing = get("SELECT COUNT(*) AS count FROM ai_memories WHERE user_id = ?", [userId]).count;
  if (existing) return;
  const now = currentDateTime();
  [
    ["Usuario prefere respostas curtas, diretas e acionaveis.", "preferencia"],
    ["Usuario costuma trabalhar com infraestrutura, servidores Linux e Windows.", "perfil"],
    ["Usuario quer foco em financeiro, infraestrutura, projetos e Codex.", "prioridade"]
  ].forEach(([content, category]) => run("INSERT INTO ai_memories (user_id, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [userId, content, category, now, now]));
}

function aiUpsertMemory(userId, payload = {}) {
  const content = String(payload.content || "").trim();
  if (!content) {
    const error = new Error("Informe a memoria.");
    error.statusCode = 400;
    throw error;
  }
  if (aiSensitivePattern.test(content)) {
    const error = new Error("Nao salvei essa memoria porque parece conter dado sensivel.");
    error.statusCode = 400;
    throw error;
  }
  const now = currentDateTime();
  const result = run("INSERT INTO ai_memories (user_id, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [userId, content, String(payload.category || "preferencia").trim() || "preferencia", now, now]);
  return get("SELECT * FROM ai_memories WHERE id = ?", [result.lastInsertRowid]);
}

function aiIntent(message = "") {
  const text = normalizeGlobalSearchText(message);
  const intent = new Set();
  if (/finance|gasto|saldo|conta|fatura|venc|pagar|patrimonio|comprar|ssd|mercado/.test(text)) intent.add("financeiro");
  if (/codex|conta codex|reset|libera/.test(text)) intent.add("codex");
  if (/tarefa|pendente|hoje|priori|agenda|compromisso|dia/.test(text)) intent.add("tarefas");
  if (/projeto|atrasad|parado|prazo/.test(text)) intent.add("projetos");
  if (/servidor|server|backup|disco|postgres|linux|windows|infra/.test(text)) intent.add("infraestrutura");
  if (/steam|jogo|skin|inventario/.test(text)) intent.add("steam");
  if (/aposta|banca|bet|roi/.test(text)) intent.add("apostas");
  if (/document|wiki|anotac|nota|notas|bloco|arquivo|discord|postgres/.test(text)) intent.add("documentos");
  if (/meta|objetivo|habito|vida|curso|estudo/.test(text)) intent.add("metas");
  if (/aten[cç][aã]o|resum|priori|jarvis|geral|status/.test(text)) ["financeiro", "codex", "tarefas", "projetos", "infraestrutura", "metas"].forEach((item) => intent.add(item));
  if (/site|sistema|drsosystem|modulo|modulos|pagina|tela|painel|dashboard|funcao|recurso|local|ia/.test(text)) ["financeiro", "codex", "tarefas", "projetos", "infraestrutura", "documentos", "metas", "steam", "apostas"].forEach((item) => intent.add(item));
  if (!intent.size) intent.add("global");
  return [...intent];
}

function rowsSafe(sql, values = [], fallback = []) {
  try {
    return all(sql, values);
  } catch {
    return fallback;
  }
}

function oneSafe(sql, values = [], fallback = {}) {
  try {
    return get(sql, values) || fallback;
  } catch {
    return fallback;
  }
}

function financeTool(userId) {
  const month = currentMonth();
  const transactions = rowsSafe("SELECT type, category, description, amount, date, payment_method, notes FROM financial_transactions WHERE substr(date, 1, 7) = ? ORDER BY date DESC LIMIT 80", [month]);
  const totals = transactions.reduce((acc, item) => {
    const amount = Number(item.amount || 0);
    if (item.type === "entrada") acc.income += amount;
    if (item.type === "saida") acc.expenses += amount;
    acc.by_category[item.category || "Sem categoria"] = (acc.by_category[item.category || "Sem categoria"] || 0) + (item.type === "saida" ? amount : 0);
    return acc;
  }, { income: 0, expenses: 0, by_category: {} });
  const upcomingBills = rowsSafe("SELECT title, person, category, due_date, amount, status FROM planning_items WHERE due_date BETWEEN ? AND ? AND status NOT IN ('paid','canceled') ORDER BY due_date ASC LIMIT 12", [todayDate(), addDays(todayDate(), 7)]);
  const cards = rowsSafe("SELECT name, bank, total_limit, status FROM credit_cards WHERE user_id = ? ORDER BY name LIMIT 10", [userId]);
  return {
    source: "financeiro",
    summary: {
      month,
      income: roundMoney(totals.income),
      expenses: roundMoney(totals.expenses),
      balance: roundMoney(totals.income - totals.expenses),
      by_category: Object.entries(totals.by_category).map(([label, total]) => ({ label, total: roundMoney(total) })).sort((a, b) => b.total - a.total).slice(0, 8)
    },
    upcomingBills,
    cards
  };
}

function taskTool(userId) {
  const today = todayDate();
  const upcoming = rowsSafe("SELECT id, title, person, category, due_date, amount, status, notes FROM planning_items WHERE due_date BETWEEN ? AND ? AND status NOT IN ('paid','canceled') ORDER BY due_date ASC LIMIT 20", [today, addDays(today, 7)]);
  const overdue = rowsSafe("SELECT id, title, person, category, due_date, amount, status FROM planning_items WHERE due_date < ? AND status NOT IN ('paid','canceled') ORDER BY due_date ASC LIMIT 20", [today]);
  const agenda = rowsSafe("SELECT title, start_at, end_at, calendar_name, location FROM agenda_events WHERE user_id = ? AND substr(start_at, 1, 10) = ? ORDER BY start_at ASC LIMIT 12", [userId, today]);
  return { source: "tarefas", today, upcoming, overdue, agenda };
}

function projectTool() {
  const today = todayDate();
  const projects = rowsSafe("SELECT id, name, status, deadline, priority, notes FROM projects ORDER BY COALESCE(deadline, updated_at) ASC LIMIT 20");
  return {
    source: "projetos",
    total: projects.length,
    overdue: projects.filter((item) => item.deadline && item.deadline < today && !/conclu|final/i.test(item.status || "")),
    active: projects.filter((item) => !/conclu|final/i.test(item.status || "")).slice(0, 12)
  };
}

function codexTool(userId) {
  const data = codexList(userId, new URLSearchParams());
  return {
    source: "codex",
    summary: data.summary,
    available: data.accounts.filter((item) => item.status === "Disponivel").slice(0, 8).map(({ email, plan, reset_type, next_available_at, status }) => ({ email, plan, reset_type, next_available_at, status })),
    waiting: data.accounts.filter((item) => ["Em espera", "Liberando em breve"].includes(item.status)).slice(0, 8).map(({ email, plan, status, countdown, next_available_at }) => ({ email, plan, status, countdown, next_available_at })),
    releasingSoon: data.alerts.soon.map(({ email, plan, countdown }) => ({ email, plan, countdown }))
  };
}

function infraTool(userId) {
  const backups = rowsSafe("SELECT id, created_at, file_path, size FROM backups ORDER BY created_at DESC LIMIT 8");
  const serverHits = globalSearch(userId, "servidor").concat(globalSearch(userId, "backup")).filter((item) => item.section !== "passwords").slice(0, 10);
  return {
    source: "infraestrutura",
    backups: backups.map((item) => ({ id: item.id, created_at: item.created_at, size: item.size })),
    searchHits: serverHits,
    note: serverHits.length ? "" : "Nao encontrei tabela especifica de servidores; usei backups e busca global."
  };
}

function steamTool(userId) {
  return {
    source: "steam",
    accounts: rowsSafe("SELECT nickname, persona_name, is_active, sync_status, last_sync_at FROM steam_accounts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10", [userId]),
    favoriteGames: rowsSafe("SELECT name, playtime_minutes, is_favorite FROM steam_games WHERE is_favorite = 1 ORDER BY playtime_minutes DESC LIMIT 10")
  };
}

function bettingTool() {
  const month = currentMonth();
  const rows = rowsSafe("SELECT betting_house, sport, event, stake, profit_loss, status, date FROM bets WHERE month = ? OR substr(date, 1, 7) = ? ORDER BY date DESC LIMIT 40", [month, month]);
  return {
    source: "apostas",
    month,
    totalStake: roundMoney(rows.reduce((sum, item) => sum + Number(item.stake || 0), 0)),
    profitLoss: roundMoney(rows.reduce((sum, item) => sum + Number(item.profit_loss || 0), 0)),
    recent: rows.slice(0, 10)
  };
}

function documentTool(userId, message = "") {
  const query = normalizeGlobalSearchText(message).split(/\s+/).find((part) => part.length > 3) || "documento";
  return {
    source: "documentos",
    recent: rowsSafe("SELECT id, name, original_name, category, uploaded_at, updated_at, notes FROM documents ORDER BY COALESCE(uploaded_at, updated_at) DESC LIMIT 12"),
    search: globalSearch(userId, query).filter((item) => ["Documentos", "Anotacoes", "Modulos proprios"].includes(item.module)).slice(0, 10)
  };
}

function goalTool(userId) {
  const today = todayDate();
  const goals = rowsSafe("SELECT title, category, status, progress, due_date, priority, notes FROM personal_goals WHERE user_id = ? ORDER BY COALESCE(due_date, updated_at) ASC LIMIT 20", [userId]);
  return {
    source: "metas",
    active: goals.filter((item) => !/conclu|feito|cancel/i.test(item.status || "")).slice(0, 12),
    overdue: goals.filter((item) => item.due_date && item.due_date < today && !/conclu|feito|cancel/i.test(item.status || "")),
    habits: rowsSafe("SELECT name, category, frequency, status, current_streak, best_streak, last_done_at FROM personal_habits WHERE user_id = ? ORDER BY updated_at DESC LIMIT 12", [userId])
  };
}

function globalSearchTool(userId, message = "") {
  const ignored = new Set(["qual", "quais", "como", "para", "hoje", "minha", "meu", "meus", "esta", "estao", "acha", "ache", "procura", "procurar", "encontra", "encontrar", "busca", "buscar", "bloco", "nota", "notas", "ai", "por", "favor"]);
  const words = normalizeGlobalSearchText(message)
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9._-]/g, ""))
    .filter((word) => word.length > 2 && !ignored.has(word));
  const queries = [...new Set([
    words.join(" "),
    ...words.slice(-3).reverse(),
    String(message || "").trim()
  ].filter((query) => normalizeGlobalSearchText(query).length >= 2))];
  const seen = new Set();
  const results = [];
  for (const query of queries) {
    for (const item of globalSearch(userId, query).filter((row) => row.section !== "passwords")) {
      const key = `${item.section}:${item.module}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
    if (results.length >= 16) break;
  }
  return { source: "busca-global", query: words.join(" ") || message, searched_terms: queries.slice(0, 6), results: results.slice(0, 16) };
}

function aiInsights(userId) {
  const finance = financeTool(userId);
  const tasks = taskTool(userId);
  const projects = projectTool();
  const codex = codexTool(userId);
  const infra = infraTool(userId);
  const goals = goalTool(userId);
  const insights = [];
  const push = (type, title, description, severity, sourceModule, details = {}) => insights.push({ id: `${type}-${insights.length + 1}`, type, title, description, severity, sourceModule, details, created_at: currentDateTime() });
  if (tasks.overdue.length) push("tarefas-atrasadas", "Tarefas atrasadas", `${tasks.overdue.length} compromisso(s) financeiro(s) ou tarefa(s) passaram do prazo.`, "critical", "tarefas", { rows: tasks.overdue.slice(0, 5) });
  if (finance.upcomingBills.length) push("contas-semana", "Contas vencendo", `${finance.upcomingBills.length} conta(s) vencem nos proximos 7 dias.`, "warning", "financeiro", { rows: finance.upcomingBills.slice(0, 5) });
  if (finance.summary.expenses > finance.summary.income && finance.summary.income > 0) push("financeiro-alerta", "Gastos acima da entrada", `No mes, saidas (${formatMoneyBR(finance.summary.expenses)}) superam entradas (${formatMoneyBR(finance.summary.income)}).`, "critical", "financeiro", finance.summary);
  if (projects.overdue.length) push("projetos-atrasados", "Projetos atrasados", `${projects.overdue.length} projeto(s) com prazo vencido.`, "warning", "projetos", { rows: projects.overdue.slice(0, 5) });
  if (codex.summary.available) push("codex-disponivel", "Contas Codex disponiveis", `${codex.summary.available} conta(s) podem ser usadas agora.`, "success", "codex", { rows: codex.available });
  if (codex.releasingSoon.length) push("codex-breve", "Codex liberando em breve", `${codex.releasingSoon.length} conta(s) liberam em menos de 30 minutos.`, "warning", "codex", { rows: codex.releasingSoon });
  if (!infra.backups.length) push("backup-pendente", "Backups sem historico", "Nao encontrei backups registrados no sistema.", "warning", "infraestrutura");
  if (goals.overdue.length) push("metas-atrasadas", "Metas atrasadas", `${goals.overdue.length} meta(s) passaram do prazo.`, "warning", "metas", { rows: goals.overdue.slice(0, 5) });
  if (!insights.length) push("sistema-ok", "Nada urgente agora", "Nao encontrei alertas criticos nos resumos seguros.", "success", "geral");
  return {
    generated_at: currentDateTime(),
    cards: [
      { key: "attention", title: "Atencao hoje", severity: insights.some((item) => item.severity === "critical") ? "critical" : insights.some((item) => item.severity === "warning") ? "warning" : "success", summary: `${insights.filter((item) => item.severity !== "success").length} ponto(s) de atencao`, prompt: "O que precisa da minha atencao hoje?" },
      { key: "finance", title: "Financeiro", severity: finance.summary.expenses > finance.summary.income && finance.summary.income > 0 ? "critical" : "info", summary: `${formatMoneyBR(finance.summary.balance)} de saldo no mes`, prompt: "Resumo financeiro do mes" },
      { key: "infra", title: "Infraestrutura", severity: infra.backups.length ? "success" : "warning", summary: infra.backups.length ? `Ultimo backup em ${formatDateTimeBR(infra.backups[0].created_at)}` : "Sem backup registrado", prompt: "Quais servidores ou backups precisam de atencao?" },
      { key: "projects", title: "Projetos", severity: projects.overdue.length ? "warning" : "info", summary: `${projects.active.length} projeto(s) ativo(s)`, prompt: "Quais projetos estao atrasados?" },
      { key: "codex", title: "Codex", severity: codex.releasingSoon.length ? "warning" : "success", summary: `${codex.summary.available || 0} disponivel(is) agora`, prompt: "Quais contas Codex estao disponiveis?" },
      { key: "goals", title: "Metas", severity: goals.overdue.length ? "warning" : "info", summary: `${goals.active.length} meta(s) ativa(s)`, prompt: "Como estao minhas metas?" }
    ],
    insights
  };
}

function aiBuildContext(userId, message) {
  aiSeedMemories(userId);
  const intent = aiIntent(message);
  const context = { now: currentDateTime(), memories: aiMemories(userId), tools: {}, insights: aiInsights(userId).insights.slice(0, 10) };
  if (intent.includes("financeiro")) context.tools.financeiro = financeTool(userId);
  if (intent.includes("tarefas")) context.tools.tarefas = taskTool(userId);
  if (intent.includes("projetos")) context.tools.projetos = projectTool();
  if (intent.includes("codex")) context.tools.codex = codexTool(userId);
  if (intent.includes("infraestrutura")) context.tools.infraestrutura = infraTool(userId);
  if (intent.includes("steam")) context.tools.steam = steamTool(userId);
  if (intent.includes("apostas")) context.tools.apostas = bettingTool();
  if (intent.includes("documentos")) context.tools.documentos = documentTool(userId, message);
  if (intent.includes("metas")) context.tools.metas = goalTool(userId);
  context.tools.busca_global = globalSearchTool(userId, message);
  return sanitizeContext(context);
}

function aiSourcesFromContext(context) {
  return Object.values(context.tools || {}).map((tool) => tool.source).filter(Boolean);
}

function aiCreatePendingAction(userId, conversationId, type, payload) {
  const result = run("INSERT INTO ai_actions (user_id, conversation_id, type, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)", [userId, conversationId, type, JSON.stringify(sanitizeContext(payload || {})), currentDateTime(), currentDateTime()]);
  return get("SELECT * FROM ai_actions WHERE id = ?", [result.lastInsertRowid]);
}

function aiActionLabel(action) {
  const payload = safeJsonParse(action.payload, {});
  if (action.type === "create_codex_account") return `Cadastrar conta Codex ${payload.email || ""}`.trim();
  if (action.type === "create_planning_item") return `Criar tarefa/conta "${payload.title || ""}"`.trim();
  if (action.type === "create_project") return `Criar projeto "${payload.name || ""}"`.trim();
  if (action.type === "create_expense") return `Cadastrar gasto "${payload.description || ""}"`.trim();
  if (action.type === "create_goal") return `Adicionar meta "${payload.title || ""}"`.trim();
  return action.type;
}

function aiParseRequestedAction(message = "") {
  const text = String(message || "").trim();
  const lower = normalizeGlobalSearchText(text);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase();
  if (lower.startsWith("/nova conta codex") || (lower.includes("nova conta codex") && email)) {
    return { type: "create_codex_account", payload: { email, plan: /plus permanente/i.test(text) ? "Plus Permanente" : /plus/i.test(text) ? "Plus" : "Free", reset_type: /5h|5 horas/i.test(text) ? "5 horas" : /seman/i.test(text) ? "Semanal" : "Manual", notes: "Criada via DRSO AI Core." } };
  }
  if (lower.startsWith("/criar tarefa") || lower.includes("crie uma tarefa")) {
    const title = text.replace(/^\/criar tarefa/i, "").replace(/crie uma tarefa(?: para)?/i, "").trim() || "Nova tarefa";
    return { type: "create_planning_item", payload: { title, category: "Tarefa", due_date: lower.includes("amanha") ? addDays(todayDate(), 1) : todayDate(), amount: 0, status: "pending", notes: "Criada via DRSO AI Core.", month: currentMonth(), person: "Dauan" } };
  }
  if (lower.startsWith("/novo projeto")) {
    return { type: "create_project", payload: { name: text.replace(/^\/novo projeto/i, "").trim() || "Novo projeto", status: "Ativo", priority: "Media", notes: "Criado via DRSO AI Core." } };
  }
  if (lower.startsWith("/cadastrar gasto")) {
    const amount = parseLooseServerMoney(text);
    return { type: "create_expense", payload: { type: "saida", category: lower.includes("aliment") ? "Alimentacao" : "Outros", description: text.replace(/^\/cadastrar gasto/i, "").trim() || "Gasto cadastrado pela IA", amount, date: currentDateTime(), payment_method: "", notes: "Criado via DRSO AI Core." } };
  }
  if (lower.startsWith("/adicionar meta")) {
    return { type: "create_goal", payload: { title: text.replace(/^\/adicionar meta/i, "").trim() || "Nova meta", category: "Pessoal", status: "em andamento", priority: "media", progress: 0, notes: "Criada via DRSO AI Core." } };
  }
  return null;
}

function parseLooseServerMoney(value) {
  const text = String(value || "").replace(/\s/g, "");
  const match = text.match(/R?\$?(-?\d+(?:[.,]\d{1,2})?)/i);
  if (!match) return 0;
  return Number(match[1].replace(",", ".")) || 0;
}

function parseServerCurrencyInput(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim().replace(/\s/g, "").replace(/[R$]/g, "");
  if (!text) return 0;
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(/[^0-9.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aiPushRows(lines, title, rows, formatter, limit = 6) {
  const list = Array.isArray(rows) ? rows.filter(Boolean).slice(0, limit) : [];
  if (!list.length) return false;
  lines.push(title);
  list.forEach((item, index) => lines.push(`${index + 1}. ${formatter(item)}`));
  return true;
}

function aiSystemQuestion(lower = "") {
  return /site|sistema|drsosystem|modulo|modulos|pagina|tela|painel|dashboard|funcao|recurso|local|ia|finance|codex|projeto|tarefa|agenda|backup|document|nota|arquivo|meta|steam|jogo|aposta|banca|servidor|conta|venc/.test(lower);
}

function aiActionHelp() {
  return [
    "Acoes que eu consigo preparar com confirmacao:",
    "- /criar tarefa pagar conta amanha",
    "- /novo projeto Nome do projeto",
    "- /cadastrar gasto mercado R$ 50",
    "- /adicionar meta estudar 30 minutos por dia",
    "- /nova conta codex email@exemplo.com plus"
  ].join("\n");
}

function aiLocalOverview(context) {
  const lines = [
    "Modo local ativo, sem API paga.",
    "Eu respondo usando os dados do DRSOSystem: financeiro, contas do mes, agenda, projetos, Codex, documentos, backups, metas, Steam, apostas e busca geral."
  ];
  const attention = (context.insights || []).filter((item) => item.severity !== "success");
  if (attention.length) {
    lines.push("");
    lines.push(`Agora encontrei ${attention.length} ponto(s) de atencao:`);
    attention.slice(0, 6).forEach((item, index) => lines.push(`${index + 1}. ${item.title}: ${item.description}`));
  } else {
    lines.push("");
    lines.push("Nao encontrei alerta critico no radar local agora.");
  }
  lines.push("");
  lines.push(aiActionHelp());
  return lines.join("\n");
}

function aiGlobalResultsAnswer(context) {
  const found = context.tools?.busca_global?.results || [];
  if (!found.length) return "";
  const lines = ["Encontrei estes pontos no DRSOSystem:"];
  found.slice(0, 8).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.module}: ${item.title}${item.detail ? ` - ${item.detail}` : ""}${item.snippet ? ` | ${item.snippet}` : ""}`);
  });
  return lines.join("\n");
}

function aiLocalAnswer(message, context, pendingAction = null) {
  if (pendingAction) return `Preciso da sua confirmacao antes de executar: ${aiActionLabel(pendingAction)}.`;
  const lower = normalizeGlobalSearchText(message);
  const lines = [];
  const tools = context.tools || {};
  const wantsOverview = /o que voce consegue|o que consegue|ajuda|comandos|modo local|ia local|meu site|meu sistema|drsosystem|site|sistema/.test(lower);
  if (wantsOverview) return aiLocalOverview(context);
  const wantsAttention = /(aten[cç][aã]o|o que precisa|priori|resumir meu dia|meu dia|status geral)/.test(lower) && !/(finance|codex|projeto|document|nota|arquivo|meta|steam|jogo|aposta|banca)/.test(lower);
  if (wantsAttention && context.insights?.length) {
    const attention = context.insights.filter((item) => item.severity !== "success");
    if (!attention.length) return "Nao encontrei nada urgente agora nos resumos locais do sistema.";
    lines.push(`Hoje encontrei ${attention.length} ponto(s) de atencao:`);
    attention.slice(0, 6).forEach((item, index) => lines.push(`${index + 1}. ${item.title}: ${item.description}`));
    return lines.join("\n");
  }
  if (lower.includes("codex") && context.tools?.codex) {
    const available = context.tools.codex.available || [];
    const waiting = context.tools.codex.waiting || [];
    const soon = context.tools.codex.releasingSoon || [];
    if (!available.length && !waiting.length && !soon.length) return "Nao encontrei contas Codex cadastradas ou disponiveis agora no Codex Manager.";
    if (available.length) {
      lines.push("Contas Codex disponiveis agora:");
      available.forEach((item) => lines.push(`- ${item.email} - ${item.plan}`));
    } else {
      lines.push("Nao encontrei contas Codex disponiveis agora.");
    }
    if (soon.length) {
      lines.push("");
      lines.push("Liberando em breve:");
      soon.forEach((item) => lines.push(`- ${item.email} - ${item.countdown || "em breve"}`));
    }
    if (waiting.length) {
      lines.push("");
      lines.push("Em espera:");
      waiting.slice(0, 6).forEach((item) => lines.push(`- ${item.email} - ${item.status}${item.countdown ? ` (${item.countdown})` : ""}`));
    }
    return lines.join("\n");
  }
  if (/(finance|gasto|saldo|conta|fatura|venc|pagar|patrimonio|comprar|mercado|mes)/.test(lower) && tools.financeiro) {
    const summary = tools.financeiro.summary;
    lines.push(`Resumo financeiro de ${summary.month}: entradas ${formatMoneyBR(summary.income)}, saidas ${formatMoneyBR(summary.expenses)} e saldo ${formatMoneyBR(summary.balance)}.`);
    aiPushRows(lines, "", summary.by_category || [], (item) => `${item.label}: ${formatMoneyBR(item.total)}`, 5);
    aiPushRows(lines, "", tools.financeiro.upcomingBills || [], (item) => `${item.title} vence em ${formatDateOnlyBR(item.due_date)} - ${formatMoneyBR(item.amount)}${item.person ? ` (${item.person})` : ""}`, 6);
    return lines.filter((line, index) => line || lines[index + 1]).join("\n");
  }
  if ((lower.includes("tarefa") || lower.includes("agenda") || lower.includes("hoje") || lower.includes("pendente") || lower.includes("venc")) && tools.tarefas) {
    const tasks = tools.tarefas;
    aiPushRows(lines, `Agenda e tarefas de ${formatDateOnlyBR(tasks.today)}:`, tasks.agenda || [], (item) => `${item.title} - ${formatDateTimeBR(item.start_at)}${item.location ? ` em ${item.location}` : ""}`, 8);
    aiPushRows(lines, lines.length ? "" : "Tarefas atrasadas:", tasks.overdue || [], (item) => `${item.title} - venceu em ${formatDateOnlyBR(item.due_date)}${Number(item.amount || 0) ? ` - ${formatMoneyBR(item.amount)}` : ""}`, 8);
    aiPushRows(lines, lines.length ? "" : "Proximos 7 dias:", tasks.upcoming || [], (item) => `${item.title} - ${formatDateOnlyBR(item.due_date)}${Number(item.amount || 0) ? ` - ${formatMoneyBR(item.amount)}` : ""}`, 8);
    return lines.length ? lines.filter((line, index) => line || lines[index + 1]).join("\n") : "Nao encontrei agenda ou tarefas pendentes para hoje/proximos dias.";
  }
  if ((lower.includes("projeto") || lower.includes("atrasad") || lower.includes("parado")) && context.tools?.projetos) {
    const projects = context.tools.projetos;
    if (projects.overdue?.length) {
      lines.push(`Encontrei ${projects.overdue.length} projeto(s) atrasado(s):`);
      projects.overdue.slice(0, 8).forEach((item, index) => lines.push(`${index + 1}. ${item.name} - prazo ${formatDateOnlyBR(item.deadline)}${item.priority ? `, prioridade ${item.priority}` : ""}.`));
      return lines.join("\n");
    }
    if (projects.active?.length) {
      lines.push("Nao encontrei projetos atrasados agora.");
      lines.push(`Projetos ativos no radar: ${projects.active.length}.`);
      projects.active.slice(0, 8).forEach((item) => lines.push(`- ${item.name}${item.deadline ? ` - prazo ${formatDateOnlyBR(item.deadline)}` : ""}${item.status ? ` - ${item.status}` : ""}`));
      return lines.join("\n");
    }
    return "Nao encontrei projetos cadastrados para avaliar atraso.";
  }
  if ((lower.includes("backup") || lower.includes("servidor") || lower.includes("infra") || lower.includes("disco")) && tools.infraestrutura) {
    const infra = tools.infraestrutura;
    aiPushRows(lines, "Backups recentes:", infra.backups || [], (item) => `${formatDateTimeBR(item.created_at)}${Number(item.size || 0) ? ` - ${Math.round(Number(item.size || 0) / 1024 / 1024)} MB` : ""}`, 6);
    aiPushRows(lines, lines.length ? "" : "Registros de infraestrutura encontrados:", infra.searchHits || [], (item) => `${item.module}: ${item.title}${item.snippet ? ` - ${item.snippet}` : ""}`, 6);
    if (infra.note) lines.push(infra.note);
    return lines.length ? lines.filter((line, index) => line || lines[index + 1]).join("\n") : "Nao encontrei backups ou registros de infraestrutura cadastrados.";
  }
  if ((lower.includes("document") || lower.includes("nota") || lower.includes("arquivo") || lower.includes("discord") || lower.includes("bloco")) && tools.documentos) {
    const docs = tools.documentos;
    aiPushRows(lines, "Documentos/notas encontrados:", docs.search || [], (item) => `${item.module}: ${item.title}${item.snippet ? ` - ${item.snippet}` : ""}`, 8);
    if (!lines.length) aiPushRows(lines, "Documentos recentes:", docs.recent || [], (item) => `${item.name || item.original_name}${item.category ? ` - ${item.category}` : ""}${item.updated_at ? ` - ${formatDateTimeBR(item.updated_at)}` : ""}`, 8);
    return lines.length ? lines.join("\n") : "Nao encontrei documentos ou notas relacionados a essa pergunta.";
  }
  if ((lower.includes("meta") || lower.includes("objetivo") || lower.includes("habito") || lower.includes("estudo")) && tools.metas) {
    const goals = tools.metas;
    aiPushRows(lines, "Metas atrasadas:", goals.overdue || [], (item) => `${item.title} - prazo ${formatDateOnlyBR(item.due_date)} - ${item.progress || 0}%`, 6);
    aiPushRows(lines, lines.length ? "" : "Metas ativas:", goals.active || [], (item) => `${item.title} - ${item.status || "ativa"} - ${item.progress || 0}%${item.due_date ? ` - prazo ${formatDateOnlyBR(item.due_date)}` : ""}`, 8);
    aiPushRows(lines, "", goals.habits || [], (item) => `${item.name} - sequencia ${item.current_streak || 0}${item.frequency ? ` - ${item.frequency}` : ""}`, 6);
    return lines.length ? lines.filter((line, index) => line || lines[index + 1]).join("\n") : "Nao encontrei metas ou habitos cadastrados.";
  }
  if ((lower.includes("steam") || lower.includes("jogo") || lower.includes("skin") || lower.includes("inventario")) && tools.steam) {
    const steam = tools.steam;
    aiPushRows(lines, "Contas Steam:", steam.accounts || [], (item) => `${item.nickname || item.persona_name || "Steam"} - ${item.sync_status || "sem status"}${item.last_sync_at ? ` - sync ${formatDateTimeBR(item.last_sync_at)}` : ""}`, 6);
    aiPushRows(lines, "", steam.favoriteGames || [], (item) => `${item.name} - ${Math.round(Number(item.playtime_minutes || 0) / 60)}h`, 8);
    return lines.length ? lines.filter((line, index) => line || lines[index + 1]).join("\n") : "Nao encontrei dados Steam cadastrados.";
  }
  if ((lower.includes("aposta") || lower.includes("banca") || lower.includes("bet") || lower.includes("roi")) && tools.apostas) {
    const bets = tools.apostas;
    lines.push(`Apostas de ${bets.month}: stake total ${formatMoneyBR(bets.totalStake)} e resultado ${formatMoneyBR(bets.profitLoss)}.`);
    aiPushRows(lines, "", bets.recent || [], (item) => `${item.betting_house || "Casa"} - ${item.event || item.sport || "evento"} - ${formatMoneyBR(item.stake)} - ${item.status || "status pendente"}`, 6);
    return lines.filter((line, index) => line || lines[index + 1]).join("\n");
  }
  if ((lower.includes("atencao") || lower.includes("priori") || lower.includes("resum")) && context.insights?.length) {
    const attention = context.insights.filter((item) => item.severity !== "success");
    if (!attention.length) return "Nao encontrei nada urgente agora nos resumos seguros do sistema.";
    lines.push(`Hoje encontrei ${attention.length} ponto(s) de atencao:`);
    attention.slice(0, 6).forEach((item, index) => lines.push(`${index + 1}. ${item.title}: ${item.description}`));
    return lines.join("\n");
  }
  const globalAnswer = aiGlobalResultsAnswer(context);
  if (globalAnswer) return globalAnswer;
  if (aiSystemQuestion(lower)) {
    const searched = context.tools?.busca_global?.searched_terms?.join(", ");
    return `Procurei nos modulos locais${searched ? ` por: ${searched}` : ""}, mas nao encontrei registro relacionado. O que estiver fora do DRSOSystem, ou em arquivo ainda nao importado, eu nao consigo enxergar.`;
  }
  return "Estou em modo local e foco no DRSOSystem. Pergunte sobre financeiro, contas, Codex, projetos, agenda, documentos, metas, backups, Steam, apostas ou registros salvos no sistema.";
}

async function aiOpenAiAnswer(message, context, history = []) {
  const settings = await aiReadOpenAiSettings();
  if (!settings.apiKey) return "";
  const input = [
    ...history.slice(-8).map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content })),
    { role: "user", content: `Pergunta: ${message}\n\nContexto seguro opcional do DRSOSystem:\n${JSON.stringify(context, null, 2)}` }
  ];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      instructions: drsoAiSystemPrompt,
      input
    })
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI indisponivel: ${response.status} ${compactText(errorBody, 180)}`);
  }
  const payload = await response.json();
  return payload.output_text || payload.output?.flatMap((item) => item.content || []).map((part) => part.text || "").join("\n").trim();
}

async function aiChat(userId, payload = {}) {
  aiCheckRateLimit(userId);
  const message = String(payload.message || "").trim();
  if (!message) {
    const error = new Error("Digite uma mensagem para o DRSO AI.");
    error.statusCode = 400;
    throw error;
  }
  const conversation = aiConversation(userId, payload.conversationId, aiConversationTitle(message));
  aiSaveMessage(userId, conversation.id, "user", message);
  const context = aiBuildContext(userId, message);
  const requestedAction = aiParseRequestedAction(message);
  const pendingAction = requestedAction ? aiCreatePendingAction(userId, conversation.id, requestedAction.type, requestedAction.payload) : null;
  const actions = pendingAction ? [{ id: pendingAction.id, type: pendingAction.type, label: aiActionLabel(pendingAction), payload: safeJsonParse(pendingAction.payload, {}), status: pendingAction.status }] : [];
  let answer = pendingAction ? "" : aiLocalAnswer(message, context);
  if (!answer) answer = aiLocalAnswer(message, context, pendingAction);
  const sources = aiSourcesFromContext(context);
  aiSaveMessage(userId, conversation.id, "assistant", answer, sources, actions);
  return { answer, conversationId: conversation.id, sources, actions, needsConfirmation: actions.length > 0 };
}

function aiExecuteAction(userId, action) {
  const payload = safeJsonParse(action.payload, {});
  if (action.type === "create_codex_account") return createCodexAccount(userId, payload);
  if (action.type === "create_planning_item") return insertPlanningItem({ ...payload, month: payload.month || monthKeyFromDueDate(payload.due_date, currentMonth()) });
  if (action.type === "create_project") {
    const result = insertByFields("projects", fields.projects, payload);
    return get("SELECT * FROM projects WHERE id = ?", [result.lastInsertRowid]);
  }
  if (action.type === "create_expense") {
    const data = { ...payload, type: "saida", date: normalizeDateTime(payload.date || currentDateTime()), amount: Number(payload.amount || 0) };
    const result = insertByFields("financial_transactions", fields.finance, data);
    return get("SELECT * FROM financial_transactions WHERE id = ?", [result.lastInsertRowid]);
  }
  if (action.type === "create_goal") {
    const now = currentDateTime();
    const result = run("INSERT INTO personal_goals (user_id, title, description, category, priority, start_date, due_date, status, progress, importance_reason, reward, notes, tasks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      userId,
      String(payload.title || "Nova meta"),
      String(payload.description || ""),
      String(payload.category || "Pessoal"),
      String(payload.priority || "media"),
      String(payload.start_date || todayDate()),
      String(payload.due_date || ""),
      String(payload.status || "em andamento"),
      Number(payload.progress || 0),
      String(payload.importance_reason || ""),
      String(payload.reward || ""),
      String(payload.notes || ""),
      String(payload.tasks || ""),
      now,
      now
    ]);
    return get("SELECT * FROM personal_goals WHERE id = ?", [result.lastInsertRowid]);
  }
  const error = new Error("Tipo de acao ainda nao executavel.");
  error.statusCode = 400;
  throw error;
}

function aiConfirmAction(userId, payload = {}) {
  const action = get("SELECT * FROM ai_actions WHERE id = ? AND user_id = ?", [Number(payload.actionId || payload.id), userId]);
  if (!action) {
    const error = new Error("Acao nao encontrada.");
    error.statusCode = 404;
    throw error;
  }
  if (action.status !== "pending") return { ...action, payload: safeJsonParse(action.payload, {}), result: safeJsonParse(action.result, null) };
  const decision = String(payload.decision || payload.status || "confirmed").toLowerCase();
  if (["cancel", "cancelled", "cancelado", "nao", "não"].includes(decision)) {
    run("UPDATE ai_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ?", [currentDateTime(), action.id, userId]);
    return { ...action, status: "cancelled", payload: safeJsonParse(action.payload, {}) };
  }
  try {
    const result = aiExecuteAction(userId, action);
    run("UPDATE ai_actions SET status = 'executed', result = ?, executed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?", [JSON.stringify(sanitizeContext(result)), currentDateTime(), currentDateTime(), action.id, userId]);
    if (action.conversation_id) aiSaveMessage(userId, action.conversation_id, "assistant", `Acao executada: ${aiActionLabel(action)}.`, ["acoes"], []);
    return { ...action, status: "executed", payload: safeJsonParse(action.payload, {}), result };
  } catch (error) {
    run("UPDATE ai_actions SET status = 'error', result = ?, updated_at = ? WHERE id = ? AND user_id = ?", [JSON.stringify({ error: error.message }), currentDateTime(), action.id, userId]);
    throw error;
  }
}

function upsertVendinhaSimple(userId, table, fields, payload, id = null) {
  const now = currentDateTime();
  if (id) {
    const current = get(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`, [id, userId]);
    if (!current) {
      const error = new Error("Registro nao encontrado.");
      error.statusCode = 404;
      throw error;
    }
    const values = fields.map((field) => field === "default_value" ? Number(payload[field] ?? current[field] ?? 0) || 0 : String(payload[field] ?? current[field] ?? "").trim());
    run(`UPDATE ${table} SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND user_id = ?`, [...values, now, id, userId]);
    return get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  }
  const values = fields.map((field) => field === "default_value" ? Number(payload[field] || 0) || 0 : String(payload[field] || "").trim());
  if (!values[0]) {
    const error = new Error("Informe o nome.");
    error.statusCode = 400;
    throw error;
  }
  const result = run(`INSERT INTO ${table} (user_id, ${fields.join(", ")}, created_at, updated_at) VALUES (?, ${fields.map(() => "?").join(", ")}, ?, ?)`, [userId, ...values, now, now]);
  return get(`SELECT * FROM ${table} WHERE id = ?`, [result.lastInsertRowid]);
}

function agendaSettings(userId) {
  return get("SELECT * FROM google_calendar_settings WHERE user_id = ?", [userId]);
}

function safeAgendaSettings(row) {
  if (!row) {
    return {
      client_id: "",
      calendar_id: "all",
      connected_email: "",
      sync_enabled: 0,
      last_sync_at: "",
      connected: false,
      has_client_secret: false
    };
  }
  return {
    id: row.id,
    client_id: row.client_id || "",
    calendar_id: row.calendar_id || "all",
    connected_email: row.connected_email || "",
    sync_enabled: Number(row.sync_enabled || 0),
    last_sync_at: row.last_sync_at || "",
    connected: Boolean(row.encrypted_refresh_token),
    has_client_secret: Boolean(row.encrypted_client_secret)
  };
}

function agendaRows(userId, query) {
  const from = normalizeDateTime(query.get("from") || `${currentMonth()}-01 00:00:00`);
  const to = normalizeDateTime(query.get("to") || `${addMonths(`${currentMonth()}-01`, 2)} 23:59:59`);
  const search = String(query.get("search") || "").trim();
  const source = String(query.get("source") || "").trim();
  const where = ["user_id = ?", "start_at >= ?", "start_at <= ?"];
  const values = [userId, from, to];
  if (source) {
    where.push("source = ?");
    values.push(source);
  }
  if (search) {
    where.push("(title LIKE ? OR description LIKE ? OR location LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  return all(`SELECT * FROM agenda_events WHERE ${where.join(" AND ")} ORDER BY start_at ASC, id ASC`, values);
}

function saveAgendaSettings(userId, payload = {}) {
  const existing = agendaSettings(userId);
  const clientId = String(payload.client_id ?? existing?.client_id ?? "").trim();
  const calendarId = String(payload.calendar_id ?? existing?.calendar_id ?? "all").trim() || "all";
  const secret = String(payload.client_secret || "").trim();
  const encryptedSecret = secret ? encryptVaultText(secret) : existing?.encrypted_client_secret || "";
  const now = currentDateTime();
  if (existing) {
    run(`UPDATE google_calendar_settings
      SET client_id = ?, encrypted_client_secret = ?, calendar_id = ?, updated_at = ?
      WHERE user_id = ?`, [clientId, encryptedSecret, calendarId, now, userId]);
  } else {
    run(`INSERT INTO google_calendar_settings
      (user_id, client_id, encrypted_client_secret, calendar_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [userId, clientId, encryptedSecret, calendarId, now, now]);
  }
  return safeAgendaSettings(agendaSettings(userId));
}

function googleRedirectUri(req) {
  return `http://${req.headers.host}/api/agenda/google/callback`;
}

function googleAuthUrl(req, userId) {
  const settings = agendaSettings(userId);
  if (!settings?.client_id || !settings?.encrypted_client_secret) throw new Error("Cadastre Client ID e Client Secret antes de conectar.");
  const params = new URLSearchParams({
    client_id: settings.client_id,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline",
    prompt: "consent",
    state: String(userId)
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function googleTokenRequest(settings, params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: settings.client_id,
      client_secret: decryptVaultText(settings.encrypted_client_secret),
      ...params
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Google nao autorizou a conexao.");
  return data;
}

async function googleAccessTokenFromRefresh(settings) {
  const refreshToken = decryptVaultText(settings.encrypted_refresh_token);
  if (!refreshToken) throw new Error("Conta Google ainda nao conectada.");
  const data = await googleTokenRequest(settings, {
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  return data.access_token;
}

async function googleProfile(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return {};
  return response.json();
}

async function googleCalendarList(accessToken) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&showHidden=false&maxResults=250", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || "Nao foi possivel listar as agendas do Google.");
  return (data.items || [])
    .filter((item) => item?.id)
    .map((item) => ({
      id: item.id,
      name: item.summaryOverride || item.summary || item.id,
      color: item.backgroundColor || item.foregroundColor || "#2dd4bf"
    }));
}

function agendaGoogleDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && String(value).includes("T")) {
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 19).replace("T", " ");
  }
  return normalizeDateTime(`${String(value).slice(0, 10)} 00:00:00`);
}

async function finishGoogleConnection(req, userId, code) {
  const settings = agendaSettings(userId);
  if (!settings?.client_id || !settings?.encrypted_client_secret) throw new Error("Configuracao do Google Agenda nao encontrada.");
  const token = await googleTokenRequest(settings, {
    code,
    redirect_uri: googleRedirectUri(req),
    grant_type: "authorization_code"
  });
  const refreshToken = token.refresh_token || decryptVaultText(settings.encrypted_refresh_token);
  if (!refreshToken) throw new Error("O Google nao retornou token permanente. Tente conectar novamente.");
  const profile = token.access_token ? await googleProfile(token.access_token) : {};
  run(`UPDATE google_calendar_settings
    SET encrypted_refresh_token = ?, connected_email = ?, sync_enabled = 1, updated_at = ?
    WHERE user_id = ?`, [encryptVaultText(refreshToken), profile.email || settings.connected_email || "", currentDateTime(), userId]);
  recordTimeline("Google Agenda conectado", profile.email || "Conta Google autorizada", "agenda");
  return syncGoogleCalendar(userId);
}

async function syncGoogleCalendar(userId) {
  const settings = agendaSettings(userId);
  if (!settings?.encrypted_refresh_token) throw new Error("Conecte sua conta Google antes de sincronizar.");
  const accessToken = await googleAccessTokenFromRefresh(settings);
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 180);
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500"
  });
  const selectedCalendar = settings.calendar_id || "all";
  const calendars = selectedCalendar === "all"
    ? await googleCalendarList(accessToken)
    : [{ id: selectedCalendar, name: selectedCalendar, color: "#2dd4bf" }];
  const now = currentDateTime();
  let imported = 0;
  const failures = [];
  run("DELETE FROM agenda_events WHERE user_id = ? AND source = 'google'", [userId]);
  for (const calendar of calendars) {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      failures.push(calendar.name || calendar.id);
      continue;
    }
    for (const item of data.items || []) {
      const rawSourceId = item.id || item.iCalUID;
      if (!rawSourceId) continue;
      const startAt = agendaGoogleDate(item.start?.dateTime || item.start?.date);
      if (!startAt) continue;
      const endAt = agendaGoogleDate(item.end?.dateTime || item.end?.date);
      const sourceId = `${calendar.id}:${rawSourceId}`;
      run(`INSERT INTO agenda_events
        (user_id, title, description, location, start_at, end_at, source, source_id, calendar_id, calendar_name, calendar_color, html_link, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source, source_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          location = excluded.location,
          start_at = excluded.start_at,
          end_at = excluded.end_at,
          calendar_id = excluded.calendar_id,
          calendar_name = excluded.calendar_name,
          calendar_color = excluded.calendar_color,
          html_link = excluded.html_link,
          status = excluded.status,
          updated_at = excluded.updated_at`, [
        userId,
        item.summary || "Sem titulo",
        item.description || "",
        item.location || "",
        startAt,
        endAt,
        sourceId,
        calendar.id,
        calendar.name,
        calendar.color,
        item.htmlLink || "",
        item.status || "confirmed",
        now,
        now
      ]);
      imported += 1;
    }
  }
  run("UPDATE google_calendar_settings SET last_sync_at = ?, sync_enabled = 1, updated_at = ? WHERE user_id = ?", [now, now, userId]);
  recordTimeline("Google Agenda sincronizado", `${imported} evento(s) recebidos de ${calendars.length} agenda(s)`, "agenda");
  return { imported, calendars: calendars.length, failures, google: safeAgendaSettings(agendaSettings(userId)) };
}

function createAgendaEvent(userId, payload = {}) {
  const title = String(payload.title || "").trim();
  if (!title) throw new Error("Informe o titulo do evento.");
  const startAt = normalizeDateTime(payload.start_at || payload.date || currentDateTime());
  const now = currentDateTime();
  const result = run(`INSERT INTO agenda_events
    (user_id, title, description, location, start_at, end_at, source, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'local', 'confirmed', ?, ?)`, [
    userId,
    title,
    String(payload.description || ""),
    String(payload.location || ""),
    startAt,
    payload.end_at ? normalizeDateTime(payload.end_at) : "",
    now,
    now
  ]);
  recordTimeline("Evento criado na agenda", title, "agenda");
  return get("SELECT * FROM agenda_events WHERE id = ?", [result.lastInsertRowid]);
}

function updateAgendaEvent(userId, id, payload = {}) {
  const record = get("SELECT * FROM agenda_events WHERE id = ? AND user_id = ?", [id, userId]);
  if (!record) throw new Error("Evento nao encontrado.");
  if (record.source !== "local") throw new Error("Eventos do Google devem ser alterados no Google Agenda.");
  const title = String(payload.title ?? record.title).trim();
  if (!title) throw new Error("Informe o titulo do evento.");
  run(`UPDATE agenda_events
    SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`, [
    title,
    String(payload.description ?? record.description ?? ""),
    String(payload.location ?? record.location ?? ""),
    normalizeDateTime(payload.start_at || record.start_at),
    payload.end_at ? normalizeDateTime(payload.end_at) : "",
    currentDateTime(),
    id,
    userId
  ]);
  recordTimeline("Evento alterado na agenda", title, "agenda");
  return get("SELECT * FROM agenda_events WHERE id = ?", [id]);
}

function deleteAgendaEvent(userId, id) {
  const record = get("SELECT * FROM agenda_events WHERE id = ? AND user_id = ?", [id, userId]);
  if (!record) throw new Error("Evento nao encontrado.");
  if (record.source !== "local") throw new Error("Eventos do Google devem ser removidos no Google Agenda.");
  run("DELETE FROM agenda_events WHERE id = ? AND user_id = ?", [id, userId]);
  recordTimeline("Evento removido da agenda", record.title, "agenda");
  return { ok: true };
}

function dashboard() {
  const finance = get(`SELECT
    COALESCE(SUM(CASE WHEN type='entrada' THEN amount ELSE 0 END),0) AS income,
    COALESCE(SUM(CASE WHEN type='saida' THEN amount ELSE 0 END),0) AS expense
    FROM financial_transactions`);
  const bets = get(`SELECT
    COALESCE(SUM(CASE WHEN status='settled' THEN profit_loss ELSE 0 END),0) AS profit,
    COALESCE(SUM(CASE WHEN status='settled' THEN stake ELSE 0 END),0) AS stake,
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status='settled' AND result='green' THEN 1 ELSE 0 END),0) AS wins,
    COALESCE(SUM(CASE WHEN status='settled' AND result='red' THEN 1 ELSE 0 END),0) AS losses,
    COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending
    FROM bets`);
  return {
    finance: { ...finance, balance: finance.income - finance.expense },
    bets: { ...bets, roi: bets.stake ? (bets.profit / bets.stake) * 100 : 0, hitRate: (bets.wins + bets.losses) ? (bets.wins / (bets.wins + bets.losses)) * 100 : 0 },
    pendingTasks: all("SELECT * FROM projects WHERE status NOT IN ('concluido') ORDER BY deadline ASC LIMIT 5"),
    recentIdeas: all("SELECT * FROM notes WHERE type='ideia' ORDER BY created_at DESC LIMIT 5"),
    latest: all("SELECT * FROM timeline_events ORDER BY date DESC, id DESC LIMIT 8"),
    upcomingPlanning: all("SELECT * FROM planning_items WHERE status NOT IN ('paid','canceled') AND due_date >= date('now','localtime') ORDER BY due_date ASC LIMIT 8"),
    upcomingDocuments: all("SELECT * FROM documents WHERE due_date IS NOT NULL AND due_date >= date('now','localtime') ORDER BY due_date ASC LIMIT 6"),
    agendaEvents: all("SELECT * FROM agenda_events WHERE start_at >= datetime('now','localtime') ORDER BY start_at ASC LIMIT 80"),
    calendarEvents: [
      ...all("SELECT due_date AS date, title, 'planning' AS kind FROM planning_items WHERE due_date IS NOT NULL AND status NOT IN ('paid','canceled') ORDER BY due_date ASC LIMIT 80"),
      ...all("SELECT due_date AS date, name AS title, 'document' AS kind FROM documents WHERE due_date IS NOT NULL ORDER BY due_date ASC LIMIT 40"),
      ...all("SELECT start_at AS date, title, source AS kind FROM agenda_events WHERE start_at IS NOT NULL ORDER BY start_at ASC LIMIT 120")
    ],
    attention: {
      overduePlanning: get("SELECT COUNT(*) AS count FROM planning_items WHERE status NOT IN ('paid','canceled') AND due_date < date('now','localtime')").count,
      dueToday: get("SELECT COUNT(*) AS count FROM planning_items WHERE status NOT IN ('paid','canceled') AND due_date = date('now','localtime')").count,
      pendingBets: bets.pending
    },
    counts: {
      documents: get("SELECT COUNT(*) AS count FROM documents").count,
      projects: get("SELECT COUNT(*) AS count FROM projects").count,
      notes: get("SELECT COUNT(*) AS count FROM notes").count,
      modules: get("SELECT COUNT(*) AS count FROM custom_modules").count
    }
  };
}

async function backup(userId = null) {
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folderStamp = stamp.replace("T", "_").replace(/-\d{3}Z$/, "");
  const backupFolder = path.join(backupDir, `backup-${folderStamp}`);
  await mkdir(backupFolder, { recursive: true });
  const fileName = `drsosystem-backup-completo-${stamp}.zip`;
  const target = path.join(backupFolder, fileName);
  const entries = await collectBackupEntries(dataRootDir);
  await writeFile(target, createZip(entries));
  const result = run("INSERT INTO backups (file_name, file_path) VALUES (?, ?)", [fileName, target]);
  if (userId) {
    createNotification({
      userId,
      title: "Backup concluido",
      message: `${fileName} foi salvo com sucesso.`,
      category: "BACKUP",
      severity: "SUCCESS",
      sourceModule: "Backup",
      sourceEntityType: "backup",
      sourceEntityId: result.lastInsertRowid,
      actionUrl: "#settings",
      primaryActionLabel: "Ver backups",
      dedupeKey: `backup:${result.lastInsertRowid}:created`
    });
  }
  return { fileName, filePath: target, folderPath: backupFolder };
}

function zipDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function zipHeader(signature, size) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(signature, 0);
  return buffer;
}

function createZip(entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const content = entry.content;
    const compressed = deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const { dosTime, dosDate } = zipDateTime(entry.modifiedAt);

    const local = zipHeader(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    fileParts.push(local, name, compressed);

    const central = zipHeader(0x02014b50, 46);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = zipHeader(0x06054b50, 22);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...fileParts, ...centralParts, end]);
}

async function collectBackupEntries(baseDir) {
  const entries = [];
  const ignoredNames = new Set(["backups"]);
  const ignoredFilePattern = /\.(log|err\.log)$/i;

  async function walk(currentDir) {
    const items = await readdir(currentDir, { withFileTypes: true });
    for (const item of items) {
      if (ignoredNames.has(item.name)) continue;
      const fullPath = path.join(currentDir, item.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile() && !ignoredFilePattern.test(item.name)) {
        const info = await stat(fullPath);
        entries.push({
          name: relativePath,
          content: await readFile(fullPath),
          modifiedAt: info.mtime
        });
      }
    }
  }

  await walk(baseDir);
  return entries;
}

function modules() {
  return all("SELECT * FROM custom_modules ORDER BY name").map((module) => ({
    ...module,
    fields: all("SELECT * FROM custom_module_fields WHERE module_id = ? ORDER BY sort_order, id", [module.id]),
    records: all("SELECT * FROM custom_module_records WHERE module_id = ? ORDER BY created_at DESC", [module.id]).map((record) => ({ ...record, data: JSON.parse(record.data) }))
  }));
}

const motorcycleResources = {
  motorcycles: {
    table: "motorcycles",
    fields: ["user_id", "vehicle_type", "name", "brand", "model", "year", "plate", "color", "initial_mileage", "purchase_date", "purchase_value", "notes"],
    money: ["purchase_value"],
    numbers: ["initial_mileage", "purchase_value"],
    order: "name ASC, id DESC"
  },
  fuel: {
    table: "motorcycle_fuel_logs",
    fields: ["user_id", "motorcycle_id", "date", "station", "fuel_type", "total_value", "liters", "price_per_liter", "mileage", "payment_method", "notes"],
    money: ["total_value", "price_per_liter"],
    numbers: ["motorcycle_id", "total_value", "liters", "price_per_liter", "mileage"],
    order: "date DESC, id DESC"
  },
  oil: {
    table: "motorcycle_oil_changes",
    fields: ["user_id", "motorcycle_id", "date", "mileage", "oil_type", "oil_value", "labor_value", "place", "next_mileage", "next_date", "notes"],
    money: ["oil_value", "labor_value"],
    numbers: ["motorcycle_id", "mileage", "oil_value", "labor_value", "next_mileage"],
    order: "date DESC, id DESC"
  },
  maintenance: {
    table: "motorcycle_maintenance_logs",
    fields: ["user_id", "motorcycle_id", "date", "category", "service_type", "item", "workshop", "parts_value", "labor_value", "mileage", "warranty_until", "next_mileage", "next_date", "notes"],
    money: ["parts_value", "labor_value"],
    numbers: ["motorcycle_id", "parts_value", "labor_value", "mileage", "next_mileage"],
    order: "date DESC, id DESC"
  },
  tires: {
    table: "motorcycle_tire_logs",
    fields: ["user_id", "motorcycle_id", "date", "tire_position", "brand_model", "value", "mileage", "next_mileage", "notes"],
    money: ["value"],
    numbers: ["motorcycle_id", "value", "mileage", "next_mileage"],
    order: "date DESC, id DESC"
  },
  documents: {
    table: "motorcycle_documents",
    fields: ["user_id", "motorcycle_id", "type", "description", "due_date", "amount", "status", "paid_date", "installments", "attachment_name", "notes"],
    money: ["amount"],
    numbers: ["motorcycle_id", "amount"],
    order: "due_date ASC, id DESC"
  },
  mileage: {
    table: "motorcycle_mileage_logs",
    fields: ["user_id", "motorcycle_id", "date", "mileage", "source", "notes"],
    money: [],
    numbers: ["motorcycle_id", "mileage"],
    order: "date DESC, id DESC"
  },
  expenses: {
    table: "motorcycle_expenses",
    fields: ["user_id", "motorcycle_id", "date", "category", "description", "amount", "payment_method", "notes"],
    money: ["amount"],
    numbers: ["motorcycle_id", "amount"],
    order: "date DESC, id DESC"
  }
};

function motorcyclePayload(resource, payload, userId) {
  const config = motorcycleResources[resource];
  const clean = { ...payload, user_id: userId };
  if (resource !== "motorcycles" && !clean.motorcycle_id) {
    const first = get("SELECT id FROM motorcycles WHERE user_id = ? ORDER BY id LIMIT 1", [userId]);
    if (first) clean.motorcycle_id = first.id;
  }
  for (const key of config.numbers) clean[key] = Number(clean[key] || 0);
  if (resource === "fuel" && !Number(clean.price_per_liter || 0) && Number(clean.total_value || 0) && Number(clean.liters || 0)) {
    clean.price_per_liter = roundMoney(Number(clean.total_value) / Number(clean.liters));
  }
  if (resource === "documents") clean.status = clean.status || "pending";
  if (resource === "mileage") clean.source = clean.source || "manual";
  if (resource === "motorcycles") clean.vehicle_type = clean.vehicle_type || "Moto";
  if (resource === "motorcycles") clean.name = clean.name || [clean.brand, clean.model].filter(Boolean).join(" ") || "Minha moto";
  return clean;
}

function calculateFuelConsumptionRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.motorcycle_id || "sem-veiculo");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  for (const group of grouped.values()) {
    const chronological = [...group].sort((a, b) => {
      const mileageDiff = Number(a.mileage || 0) - Number(b.mileage || 0);
      if (mileageDiff) return mileageDiff;
      const dateDiff = String(a.date || "").localeCompare(String(b.date || ""));
      return dateDiff || Number(a.id || 0) - Number(b.id || 0);
    });
    for (let index = 0; index < chronological.length; index += 1) {
      const current = chronological[index];
      const previous = chronological[index - 1];
      current.previous_mileage = previous?.mileage ?? null;
      current.consumption_distance = null;
      current.average_consumption = null;
      if (!previous) continue;
      const currentMileage = Number(current.mileage);
      const previousMileage = Number(previous.mileage);
      const previousLiters = Number(previous.liters);
      if (!Number.isFinite(currentMileage) || !Number.isFinite(previousMileage) || !Number.isFinite(previousLiters) || currentMileage <= 0 || previousMileage <= 0 || previousLiters <= 0) continue;
      const distance = currentMileage - previousMileage;
      if (!Number.isFinite(distance) || distance < 0) continue;
      current.consumption_distance = roundMoney(distance);
      current.average_consumption = Math.round((distance / previousLiters) * 10) / 10;
    }
  }
  return rows;
}

function motorcycleRows(resource, userId, query = new URLSearchParams()) {
  const config = motorcycleResources[resource];
  const where = [`${config.table}.user_id = ?`];
  const values = [userId];
  const motorcycleId = query.get("motorcycle_id");
  if (motorcycleId && resource !== "motorcycles") {
    where.push(`${config.table}.motorcycle_id = ?`);
    values.push(Number(motorcycleId));
  }
  const month = query.get("month");
  if (month && ["fuel", "oil", "maintenance", "tires", "mileage", "expenses"].includes(resource)) {
    where.push(`${config.table}.date LIKE ?`);
    values.push(`${month}%`);
  }
  const status = query.get("status");
  if (status && resource === "documents") {
    where.push(`${config.table}.status = ?`);
    values.push(status);
  }
  const sql = resource === "motorcycles"
    ? `SELECT * FROM motorcycles WHERE ${where.join(" AND ")} ORDER BY ${config.order}`
    : `SELECT ${config.table}.*, motorcycles.name AS motorcycle_name FROM ${config.table} LEFT JOIN motorcycles ON motorcycles.id = ${config.table}.motorcycle_id WHERE ${where.join(" AND ")} ORDER BY ${config.order}`;
  const rows = all(sql, values);
  return resource === "fuel" ? calculateFuelConsumptionRows(rows) : rows;
}

function createMotorcycleResource(resource, payload, userId) {
  const config = motorcycleResources[resource];
  const clean = motorcyclePayload(resource, payload, userId);
  const result = insertByFields(config.table, config.fields, clean);
  const id = Number(result.lastInsertRowid);
  if (["fuel", "oil", "maintenance", "tires"].includes(resource) && Number(clean.mileage || 0)) {
    const source = resource === "fuel" ? "abastecimento" : resource === "oil" ? "oleo" : resource === "tires" ? "pneu" : "manutencao";
    run("INSERT INTO motorcycle_mileage_logs (user_id, motorcycle_id, date, mileage, source, notes) VALUES (?, ?, ?, ?, ?, ?)", [
      userId,
      clean.motorcycle_id,
      clean.date || todayDate(),
      Number(clean.mileage || 0),
      source,
      clean.notes || ""
    ]);
  }
  return get(`SELECT * FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId]);
}

function updateMotorcycleResource(resource, id, payload, userId) {
  const config = motorcycleResources[resource];
  if (!get(`SELECT id FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId])) throw new Error("Registro nao encontrado.");
  const clean = motorcyclePayload(resource, payload, userId);
  updateByFields(config.table, config.fields, id, clean);
  return get(`SELECT * FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId]);
}

function deleteMotorcycleResource(resource, id, userId) {
  const config = motorcycleResources[resource];
  run(`DELETE FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId]);
  return { ok: true };
}

function motorcycleOverview(userId) {
  const month = currentMonth();
  const year = todayDate().slice(0, 4);
  const motorcycles = motorcycleRows("motorcycles", userId);
  const fuel = motorcycleRows("fuel", userId);
  const oil = motorcycleRows("oil", userId);
  const maintenance = motorcycleRows("maintenance", userId);
  const tires = motorcycleRows("tires", userId);
  const documents = motorcycleRows("documents", userId);
  const mileage = motorcycleRows("mileage", userId);
  const expenses = motorcycleRows("expenses", userId);
  const spentInMonth = (rows, field, dateField = "date") => rows.filter((row) => String(row[dateField] || "").startsWith(month)).reduce((sum, row) => sum + Number(row[field] || 0), 0);
  const spentInYear = (rows, field, dateField = "date") => rows.filter((row) => String(row[dateField] || "").startsWith(year)).reduce((sum, row) => sum + Number(row[field] || 0), 0);
  const fuelMonth = spentInMonth(fuel, "total_value");
  const totalMonth = fuelMonth + spentInMonth(oil, "oil_value") + spentInMonth(oil, "labor_value") + spentInMonth(maintenance, "parts_value") + spentInMonth(maintenance, "labor_value") + spentInMonth(tires, "value") + spentInMonth(expenses, "amount") + spentInMonth(documents, "amount", "due_date");
  const totalYear = spentInYear(fuel, "total_value") + spentInYear(oil, "oil_value") + spentInYear(oil, "labor_value") + spentInYear(maintenance, "parts_value") + spentInYear(maintenance, "labor_value") + spentInYear(tires, "value") + spentInYear(expenses, "amount") + spentInYear(documents, "amount", "due_date");
  const latestMileage = [...mileage, ...fuel, ...oil, ...maintenance, ...tires].map((row) => Number(row.mileage || 0)).filter(Boolean).sort((a, b) => b - a)[0] || motorcycles[0]?.initial_mileage || 0;
  const firstMileage = motorcycles[0]?.initial_mileage || [...mileage].sort((a, b) => Number(a.mileage || 0) - Number(b.mileage || 0))[0]?.mileage || latestMileage;
  const kmDriven = Math.max(0, Number(latestMileage || 0) - Number(firstMileage || 0));
  const alerts = [];
  const today = todayDate();
  const soon = addDays(today, 30);
  const lastOil = oil[0] || null;
  if (lastOil?.next_date && lastOil.next_date <= soon) alerts.push({ tone: lastOil.next_date < today ? "danger" : "warn", title: "Troca de oleo", message: `Proxima troca em ${lastOil.next_date}` });
  if (lastOil?.next_mileage && latestMileage && Number(lastOil.next_mileage) - latestMileage <= 300) alerts.push({ tone: "warn", title: "Oleo por km", message: `Faltam ${Math.max(0, Number(lastOil.next_mileage) - latestMileage)} km` });
  for (const doc of documents.filter((item) => item.status !== "paid" && item.due_date && item.due_date <= soon).slice(0, 5)) {
    alerts.push({ tone: doc.due_date < today ? "danger" : "warn", title: doc.type, message: `Vence em ${doc.due_date}` });
  }
  const monthly = {};
  const addMonthly = (rows, field, label) => rows.forEach((row) => {
    const key = String(row.date || row.due_date || "").slice(0, 7);
    if (!key) return;
    monthly[key] ||= { month: key, fuel: 0, maintenance: 0, documents: 0, expenses: 0, total: 0 };
    monthly[key][label] += Number(row[field] || 0);
    monthly[key].total += Number(row[field] || 0);
  });
  addMonthly(fuel, "total_value", "fuel");
  oil.forEach((row) => { addMonthly([{ ...row, total: Number(row.oil_value || 0) + Number(row.labor_value || 0) }], "total", "maintenance"); });
  maintenance.forEach((row) => { addMonthly([{ ...row, total: Number(row.parts_value || 0) + Number(row.labor_value || 0) }], "total", "maintenance"); });
  addMonthly(tires, "value", "maintenance");
  addMonthly(documents, "amount", "documents");
  addMonthly(expenses, "amount", "expenses");
  const categoryTotals = {};
  const addCategory = (name, value) => {
    categoryTotals[name] = roundMoney(Number(categoryTotals[name] || 0) + Number(value || 0));
  };
  fuel.forEach((row) => addCategory("Combustivel", row.total_value));
  oil.forEach((row) => addCategory("Oleo", Number(row.oil_value || 0) + Number(row.labor_value || 0)));
  maintenance.forEach((row) => addCategory(row.category || "Manutencao", Number(row.parts_value || 0) + Number(row.labor_value || 0)));
  tires.forEach((row) => addCategory("Pneus", row.value));
  documents.forEach((row) => addCategory(row.type || "Documento", row.amount));
  expenses.forEach((row) => addCategory(row.category || "Gastos gerais", row.amount));
  return {
    motorcycles,
    stats: {
      total_month: roundMoney(totalMonth),
      total_year: roundMoney(totalYear),
      last_fuel: fuel[0] || null,
      monthly_fuel_average: roundMoney(fuelMonth),
      next_oil: lastOil || null,
      next_maintenance: maintenance.find((item) => item.next_date || item.next_mileage) || null,
      documents_due: documents.filter((item) => item.status !== "paid" && item.due_date && item.due_date <= soon).length,
      current_mileage: Number(latestMileage || 0),
      cost_per_km: kmDriven ? roundMoney(totalYear / kmDriven) : 0,
      km_driven: kmDriven
    },
    alerts,
    charts: {
      monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)).slice(-12),
      categories: Object.entries(categoryTotals).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total).slice(0, 10)
    },
    records: { fuel, oil, maintenance, tires, documents, mileage, expenses }
  };
}

function motorcycleOptions(userId) {
  return {
    motorcycles: motorcycleRows("motorcycles", userId),
    maintenanceCategories: ["Revisao geral", "Pneus", "Freios", "Relacao/corrente", "Bateria", "Suspensao", "Lampadas", "Eletrica", "Motor", "Outros"],
    documentTypes: ["IPVA", "Licenciamento", "Seguro", "Rastreador", "Multa", "Financiamento", "Parcela", "Outro"],
    expenseCategories: ["Lavagem", "Acessorios", "Suporte de celular", "Capa de chuva", "Capacete", "Bau", "Ferramentas", "Estacionamento", "Pedagio", "Outros"],
    fuelTypes: ["Gasolina comum", "Gasolina aditivada", "Etanol", "Outro"],
    paymentMethods: ["Pix", "Debito", "Credito", "Dinheiro", "Outro"],
    tirePositions: ["Dianteiro", "Traseiro", "Par", "Outro"],
    documentStatus: ["pending", "paid", "canceled"]
  };
}

const personalResources = {
  resume: {
    table: "personal_resume",
    fields: ["user_id", "full_name", "professional_title", "summary", "phone", "email", "location", "linkedin", "github", "portfolio", "website", "objective", "visible_sections"],
    numbers: [],
    order: "id DESC"
  },
  courses: {
    table: "personal_courses",
    fields: ["user_id", "name", "institution", "category", "status", "start_date", "expected_end_date", "end_date", "hours", "certificate", "link", "paid_value", "progress", "priority", "notes", "modules"],
    numbers: ["hours", "paid_value", "progress"],
    order: "updated_at DESC, id DESC"
  },
  futureStudies: {
    table: "personal_future_studies",
    fields: ["user_id", "name", "reason", "priority", "start_goal", "finish_goal", "estimated_cost", "link", "status", "notes"],
    numbers: ["estimated_cost"],
    order: "start_goal ASC, priority DESC, id DESC"
  },
  experiences: {
    table: "personal_experiences",
    fields: ["user_id", "company", "role", "type", "start_date", "end_date", "current_job", "description", "learnings", "achievements", "income", "leaving_reason", "reference_contact", "resume_visible", "highlight", "notes"],
    numbers: ["income", "resume_visible", "highlight"],
    order: "COALESCE(end_date, '2999-12-31') DESC, start_date DESC, id DESC"
  },
  skills: {
    table: "personal_skills",
    fields: ["user_id", "name", "category", "current_level", "desired_level", "score", "status", "last_practice", "notes"],
    numbers: ["score"],
    order: "score DESC, name ASC"
  },
  goals: {
    table: "personal_goals",
    fields: ["user_id", "title", "description", "category", "priority", "start_date", "due_date", "status", "progress", "importance_reason", "reward", "notes", "tasks"],
    numbers: ["progress"],
    order: "due_date ASC, priority DESC, id DESC"
  },
  checklist: {
    table: "personal_life_checklist",
    fields: ["user_id", "title", "category", "status", "due_date", "priority", "steps", "notes"],
    numbers: [],
    order: "due_date ASC, priority DESC, id DESC"
  },
  achievements: {
    table: "personal_achievements",
    fields: ["user_id", "title", "description", "date", "category", "importance", "related_goal", "attachment_name", "notes"],
    numbers: [],
    order: "date DESC, id DESC"
  },
  personalProjects: {
    table: "personal_projects",
    fields: ["user_id", "name", "description", "category", "status", "start_date", "expected_end_date", "progress", "tools", "tasks", "link", "notes"],
    numbers: ["progress"],
    order: "updated_at DESC, id DESC"
  },
  habits: {
    table: "personal_habits",
    fields: ["user_id", "name", "category", "frequency", "target", "status", "done_days", "current_streak", "best_streak", "last_done_at", "notes"],
    numbers: ["done_days", "current_streak", "best_streak"],
    order: "status ASC, name ASC"
  }
};

function personalPayload(resource, payload, userId) {
  const config = personalResources[resource];
  const clean = { ...payload, user_id: userId };
  for (const key of config.numbers) clean[key] = Number(clean[key] || 0);
  if (resource === "resume") clean.visible_sections = clean.visible_sections || "experiencias,formacao,cursos,habilidades,idiomas,conquistas,projetos";
  if (resource === "courses") {
    clean.status ||= "em andamento";
    clean.priority ||= "media";
    clean.progress = Math.max(0, Math.min(100, Number(clean.progress || 0)));
  }
  if (resource === "goals" || resource === "personalProjects") clean.progress = Math.max(0, Math.min(100, Number(clean.progress || 0)));
  return clean;
}

function personalRows(resource, userId, query = new URLSearchParams()) {
  const config = personalResources[resource];
  const where = [`user_id = ?`];
  const values = [userId];
  const search = String(query.get("search") || "").trim();
  const status = String(query.get("status") || "").trim();
  const category = String(query.get("category") || "").trim();
  const priority = String(query.get("priority") || "").trim();
  if (status && config.fields.includes("status")) {
    where.push("status = ?");
    values.push(status);
  }
  if (category && config.fields.includes("category")) {
    where.push("category = ?");
    values.push(category);
  }
  if (priority && config.fields.includes("priority")) {
    where.push("priority = ?");
    values.push(priority);
  }
  if (search) {
    const searchable = config.fields.filter((field) => !["user_id"].includes(field)).slice(0, 8);
    where.push(`(${searchable.map((field) => `CAST(${field} AS TEXT) LIKE ?`).join(" OR ")})`);
    searchable.forEach(() => values.push(`%${search}%`));
  }
  return all(`SELECT * FROM ${config.table} WHERE ${where.join(" AND ")} ORDER BY ${config.order}`, values);
}

function createPersonalResource(resource, payload, userId) {
  const config = personalResources[resource];
  const clean = personalPayload(resource, payload, userId);
  if (resource === "resume") {
    const existing = get("SELECT id FROM personal_resume WHERE user_id = ? ORDER BY id LIMIT 1", [userId]);
    if (existing) return updatePersonalResource(resource, existing.id, clean, userId);
  }
  const result = insertByFields(config.table, config.fields, clean);
  return get(`SELECT * FROM ${config.table} WHERE id = ? AND user_id = ?`, [Number(result.lastInsertRowid), userId]);
}

function updatePersonalResource(resource, id, payload, userId) {
  const config = personalResources[resource];
  if (!get(`SELECT id FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId])) throw new Error("Registro nao encontrado.");
  const clean = personalPayload(resource, payload, userId);
  updateByFields(config.table, config.fields, id, clean);
  return get(`SELECT * FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId]);
}

function deletePersonalResource(resource, id, userId) {
  const config = personalResources[resource];
  run(`DELETE FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, userId]);
  return { ok: true };
}

function personalOptions() {
  return {
    courseCategories: ["Programacao", "Ingles", "Financas", "Carreira", "Design", "Marketing", "Vendas", "Desenvolvimento pessoal", "Esportes", "Outros"],
    courseStatus: ["quero fazer", "em andamento", "pausado", "concluido", "desistido"],
    priorities: ["baixa", "media", "alta"],
    workTypes: ["emprego", "freela", "bico", "projeto pessoal", "autonomo", "entrega", "outro"],
    skillCategories: ["Tecnologia", "Comunicacao", "Idiomas", "Esportes", "Financas", "Trabalho", "Criatividade", "Vida pessoal", "Outros"],
    skillLevels: ["iniciante", "basico", "intermediario", "avancado", "especialista"],
    skillStatus: ["aprendendo", "praticando", "dominado", "parado"],
    goalCategories: ["Carreira", "Estudos", "Dinheiro", "Saude", "Familia", "Documentos", "Bens materiais", "Esportes", "Viagens", "Habitos", "Pessoal", "Outros"],
    goalStatus: ["nao iniciada", "em andamento", "pausada", "concluida", "cancelada"],
    checklistStatus: ["pendente", "em andamento", "concluido", "cancelado"],
    projectStatus: ["ideia", "planejando", "em desenvolvimento", "pausado", "concluido", "cancelado"],
    habitFrequency: ["diario", "semanal", "mensal"],
    habitStatus: ["ativo", "pausado", "concluido"]
  };
}

function personalOverview(userId) {
  const today = todayDate();
  const soon = addDays(today, 30);
  const resume = personalRows("resume", userId)[0] || null;
  const courses = personalRows("courses", userId);
  const futureStudies = personalRows("futureStudies", userId);
  const experiences = personalRows("experiences", userId);
  const skills = personalRows("skills", userId);
  const goals = personalRows("goals", userId);
  const checklist = personalRows("checklist", userId);
  const achievements = personalRows("achievements", userId);
  const personalProjects = personalRows("personalProjects", userId);
  const habits = personalRows("habits", userId);
  const activeGoals = goals.filter((item) => ["nao iniciada", "em andamento"].includes(item.status));
  const completedGoals = goals.filter((item) => item.status === "concluida");
  const completedCourses = courses.filter((item) => item.status === "concluido");
  const progressItems = [...goals, ...courses, ...personalProjects].map((item) => Number(item.progress || 0));
  const generalProgress = progressItems.length ? roundMoney(progressItems.reduce((sum, value) => sum + value, 0) / progressItems.length) : 0;
  const alerts = [];
  goals.filter((item) => item.status !== "concluida" && item.due_date && item.due_date <= soon).slice(0, 8).forEach((item) => {
    alerts.push({ tone: item.due_date < today ? "danger" : "warn", title: item.title, message: item.due_date < today ? "Meta atrasada" : `Vence em ${item.due_date}` });
  });
  courses.filter((item) => item.status === "em andamento" && item.updated_at && item.updated_at < addDays(today, -30)).slice(0, 5).forEach((item) => alerts.push({ tone: "warn", title: item.name, message: "Curso parado ha mais de 30 dias" }));
  habits.filter((item) => item.status === "ativo" && (!item.last_done_at || item.last_done_at < addDays(today, -7))).slice(0, 5).forEach((item) => alerts.push({ tone: "warn", title: item.name, message: "Habito sem registro recente" }));
  const timeline = [
    ...completedCourses.map((item) => ({ date: item.end_date || item.updated_at, type: "Curso", title: item.name, text: item.institution || item.category })),
    ...completedGoals.map((item) => ({ date: item.due_date || item.updated_at, type: "Meta", title: item.title, text: item.category })),
    ...experiences.map((item) => ({ date: item.start_date || item.created_at, type: "Trabalho", title: item.company, text: item.role })),
    ...achievements.map((item) => ({ date: item.date || item.created_at, type: "Conquista", title: item.title, text: item.category })),
    ...personalProjects.filter((item) => item.status === "concluido").map((item) => ({ date: item.expected_end_date || item.updated_at, type: "Projeto", title: item.name, text: item.category }))
  ].filter((item) => item.date).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 30);
  const categoryTotals = {};
  const addCategory = (category) => {
    const key = category || "Sem categoria";
    categoryTotals[key] = Number(categoryTotals[key] || 0) + 1;
  };
  [...goals, ...courses, ...skills, ...achievements, ...personalProjects, ...habits].forEach((item) => addCategory(item.category));
  return {
    resume,
    stats: {
      active_goals: activeGoals.length,
      completed_goals: completedGoals.length,
      active_courses: courses.filter((item) => item.status === "em andamento").length,
      completed_courses: completedCourses.length,
      experiences: experiences.length,
      achievements: achievements.length,
      skills: skills.length,
      general_progress: generalProgress,
      overdue_goals: goals.filter((item) => item.status !== "concluida" && item.due_date && item.due_date < today).length,
      active_habits: habits.filter((item) => item.status === "ativo").length
    },
    alerts,
    nextGoals: activeGoals.filter((item) => item.due_date).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))).slice(0, 6),
    timeline,
    charts: {
      categories: Object.entries(categoryTotals).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total).slice(0, 10),
      goalsByStatus: Object.entries(goals.reduce((acc, item) => ({ ...acc, [item.status]: Number(acc[item.status] || 0) + 1 }), {})).map(([status, total]) => ({ status, total })),
      coursesByStatus: Object.entries(courses.reduce((acc, item) => ({ ...acc, [item.status]: Number(acc[item.status] || 0) + 1 }), {})).map(([status, total]) => ({ status, total }))
    },
    records: { courses, futureStudies, experiences, skills, goals, checklist, achievements, personalProjects, habits }
  };
}

async function api(req, res, pathname, query) {
  if (pathname === "/api/auth/status") {
    const session = currentSession(req);
    const user = session ? get("SELECT * FROM users WHERE id = ?", [session.userId]) : null;
    return json(res, 200, { authenticated: Boolean(user), user: publicUser(user), session: session ? { keepConnected: Boolean(session.keepConnected) } : null });
  }
  if (pathname === "/api/auth/login" && req.method === "POST") {
    const payload = await body(req);
    const user = get("SELECT * FROM users WHERE lower(username) = lower(?)", [payload.username?.trim() || ""]);
    if (!user || !verifyPassword(payload.password || "", user.password_hash)) return json(res, 401, { error: "Usuario ou senha invalidos" });
    setSession(res, user.id, Boolean(payload.keepConnected));
    try {
      createNotification({
        userId: user.id,
        title: "Nova sessao iniciada",
        message: "Um acesso ao DRSOSystem foi realizado neste dispositivo.",
        category: "SECURITY",
        severity: "INFO",
        sourceModule: "Seguranca",
        actionUrl: "#profile",
        primaryActionLabel: "Ver perfil",
        dedupeKey: `security:login:${todayDate()}`
      });
    } catch {}
    return json(res, 200, { user: publicUser(user), session: { keepConnected: Boolean(payload.keepConnected) } });
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    clearSession(req, res);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/agenda/google/callback" && req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      const stateUserId = Number(query.get("state") || 0);
      const callbackUser = currentUser(req) || (stateUserId ? get("SELECT * FROM users WHERE id = ?", [stateUserId]) : null);
      if (!callbackUser) throw new Error("Nao foi possivel identificar o usuario do DRSOSystem para salvar a agenda.");
      await finishGoogleConnection(req, callbackUser.id, query.get("code") || "");
      res.writeHead(200);
      res.end("<!doctype html><meta charset=\"utf-8\"><title>Google Agenda conectado</title><body style=\"font-family:Arial;background:#0f1720;color:#eafdfb;padding:32px\"><h1>Google Agenda conectado</h1><p>Conexao concluida. Pode voltar para o DRSOSystem e clicar em sincronizar.</p><script>setTimeout(()=>window.close(),2200)</script></body>");
    } catch (error) {
      res.writeHead(400);
      res.end(`<!doctype html><meta charset="utf-8"><title>Falha Google Agenda</title><body style="font-family:Arial;background:#0f1720;color:#ffe4e6;padding:32px"><h1>Falha ao conectar</h1><p>${String(error.message || "Erro desconhecido").replace(/[<>&]/g, "")}</p></body>`);
    }
    return;
  }

  const user = currentUser(req);
  if (!user) return json(res, 401, { error: "Login necessario" });

  if (pathname === "/api/notifications" && req.method === "GET") {
    return json(res, 200, listNotifications(user.id, query));
  }
  if (pathname === "/api/notifications/count" && req.method === "GET") {
    return json(res, 200, { unreadCount: unreadNotificationCount(user.id) });
  }
  if (pathname === "/api/notifications/preferences" && req.method === "GET") {
    return json(res, 200, { preferences: notificationPreferences(user.id), severities: NOTIFICATION_SEVERITIES });
  }
  if (pathname === "/api/notifications/preferences" && req.method === "PUT") {
    return json(res, 200, { preferences: updateNotificationPreferences(user.id, await body(req)), severities: NOTIFICATION_SEVERITIES });
  }
  if (pathname === "/api/notifications/read-all" && req.method === "POST") {
    return json(res, 200, markAllNotificationsRead(user.id));
  }
  if (pathname === "/api/notifications/dev-seed" && req.method === "POST") {
    return json(res, 201, { items: seedDemoNotifications(user.id), unreadCount: unreadNotificationCount(user.id) });
  }
  const notificationMatch = pathname.match(/^\/api\/notifications\/(\d+)$/);
  if (notificationMatch && req.method === "PATCH") {
    try {
      return json(res, 200, { notification: updateNotification(user.id, Number(notificationMatch[1]), await body(req)), unreadCount: unreadNotificationCount(user.id) });
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message || "Nao foi possivel atualizar a notificacao." });
    }
  }

  if (pathname === "/api/bi/overview" && req.method === "GET") {
    return json(res, 200, biOverview(user.id, query.get("month") || currentMonth()));
  }

  if (pathname === "/api/bi/usage" && req.method === "POST") {
    return json(res, 200, biUsageTrack(user.id, await body(req)));
  }

  if (pathname === "/api/galeria" && req.method === "GET") {
    return json(res, 200, await galleryList(user.id, query));
  }

  if (pathname === "/api/galeria/upload" && req.method === "POST") {
    const payload = await body(req);
    const files = Array.isArray(payload.files) ? payload.files : [payload];
    try {
      const media = [];
      for (const file of files) {
        media.push(await saveGalleryMedia(user.id, { ...payload, ...file }));
      }
      return json(res, 201, { media });
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message || "Nao foi possivel salvar a midia." });
    }
  }

  if (pathname === "/api/galeria/albums" && req.method === "GET") {
    return json(res, 200, galleryAlbumRows(user.id));
  }

  if (pathname === "/api/galeria/albums" && req.method === "POST") {
    const payload = await body(req);
    const name = String(payload.nome || "").trim();
    if (!name) return json(res, 400, { error: "Informe o nome do album." });
    const now = currentDateTime();
    const passwordHash = String(payload.senha || "").trim() ? hashPassword(String(payload.senha || "")) : null;
    const result = run("INSERT INTO gallery_albums (user_id, nome, descricao, capa_media_id, password_hash, data_criacao, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [user.id, name, payload.descricao || "", payload.capa_media_id ? Number(payload.capa_media_id) : null, passwordHash, now, now, now]);
    return json(res, 201, galleryAlbumPublic(get("SELECT * FROM gallery_albums WHERE id = ? AND user_id = ?", [result.lastInsertRowid, user.id])));
  }

  const galleryAlbumUnlockMatch = pathname.match(/^\/api\/galeria\/albums\/(\d+)\/unlock$/);
  if (galleryAlbumUnlockMatch && req.method === "POST") {
    const albumId = Number(galleryAlbumUnlockMatch[1]);
    const album = get("SELECT * FROM gallery_albums WHERE id = ? AND user_id = ?", [albumId, user.id]);
    if (!album) return json(res, 404, { error: "Album nao encontrado." });
    if (!album.password_hash) return json(res, 200, { token: createGalleryAlbumToken(user.id, albumId), album: galleryAlbumPublic(album) });
    const payload = await body(req);
    if (!verifyPassword(payload.senha || "", album.password_hash)) return json(res, 401, { error: "Senha do album incorreta." });
    return json(res, 200, { token: createGalleryAlbumToken(user.id, albumId), album: galleryAlbumPublic(album) });
  }

  const galleryAlbumMatch = pathname.match(/^\/api\/galeria\/albums\/(\d+)$/);
  if (galleryAlbumMatch) {
    const albumId = Number(galleryAlbumMatch[1]);
    const album = get("SELECT * FROM gallery_albums WHERE id = ? AND user_id = ?", [albumId, user.id]);
    if (!album) return json(res, 404, { error: "Album nao encontrado." });
    if (req.method === "PUT") {
      const payload = await body(req);
      let passwordHash = album.password_hash;
      if (payload.remove_password) passwordHash = null;
      if (String(payload.senha || "").trim()) passwordHash = hashPassword(String(payload.senha || ""));
      run("UPDATE gallery_albums SET nome = ?, descricao = ?, capa_media_id = ?, password_hash = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
        String(payload.nome || album.nome).trim() || album.nome,
        payload.descricao || "",
        payload.capa_media_id ? Number(payload.capa_media_id) : album.capa_media_id,
        passwordHash,
        currentDateTime(),
        albumId,
        user.id
      ]);
      return json(res, 200, galleryAlbumPublic(get("SELECT * FROM gallery_albums WHERE id = ? AND user_id = ?", [albumId, user.id])));
    }
    if (req.method === "DELETE") {
      run("UPDATE gallery_media SET album_id = NULL, updated_at = ? WHERE album_id = ? AND user_id = ?", [currentDateTime(), albumId, user.id]);
      run("DELETE FROM gallery_albums WHERE id = ? AND user_id = ?", [albumId, user.id]);
      return json(res, 200, { ok: true });
    }
  }

  const galleryMediaMatch = pathname.match(/^\/api\/galeria\/media\/(\d+)$/);
  if (galleryMediaMatch) {
    const id = Number(galleryMediaMatch[1]);
    const media = get("SELECT * FROM gallery_media WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!media) return json(res, 404, { error: "Midia nao encontrada." });
    if (req.method === "GET") return json(res, 200, galleryPublicMedia(media));
    if (req.method === "PUT") {
      const payload = await body(req);
      run("UPDATE gallery_media SET album_id = ?, categoria = ?, tags = ?, descricao = ?, favorito = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
        payload.album_id ? Number(payload.album_id) : null,
        payload.categoria || "",
        payload.tags || "",
        payload.descricao || "",
        Number(payload.favorito || 0),
        currentDateTime(),
        id,
        user.id
      ]);
      return json(res, 200, galleryPublicMedia(get("SELECT * FROM gallery_media WHERE id = ?", [id])));
    }
    if (req.method === "DELETE") {
      for (const filePath of [media.caminho_arquivo, media.caminho_thumbnail].filter(Boolean)) {
        try {
          const resolved = resolveGalleryStoredPath(filePath);
          if (existsSync(resolved)) await unlink(resolved);
        } catch {}
      }
      run("DELETE FROM gallery_media WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/galeria/bulk" && req.method === "POST") {
    const payload = await body(req);
    const ids = (payload.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return json(res, 400, { error: "Selecione ao menos um arquivo." });
    const marks = ids.map(() => "?").join(",");
    if (payload.action === "favorite") {
      run(`UPDATE gallery_media SET favorito = ?, updated_at = ? WHERE user_id = ? AND id IN (${marks})`, [payload.favorito ? 1 : 0, currentDateTime(), user.id, ...ids]);
      return json(res, 200, { ok: true });
    }
    if (payload.action === "move") {
      run(`UPDATE gallery_media SET album_id = ?, updated_at = ? WHERE user_id = ? AND id IN (${marks})`, [payload.album_id ? Number(payload.album_id) : null, currentDateTime(), user.id, ...ids]);
      return json(res, 200, { ok: true });
    }
    if (payload.action === "delete") {
      const rows = all(`SELECT * FROM gallery_media WHERE user_id = ? AND id IN (${marks})`, [user.id, ...ids]);
      for (const row of rows) {
        for (const filePath of [row.caminho_arquivo, row.caminho_thumbnail].filter(Boolean)) {
          try {
            const resolved = resolveGalleryStoredPath(filePath);
            if (existsSync(resolved)) await unlink(resolved);
          } catch {}
        }
      }
      run(`DELETE FROM gallery_media WHERE user_id = ? AND id IN (${marks})`, [user.id, ...ids]);
      return json(res, 200, { ok: true });
    }
  }

  const galleryFileMatch = pathname.match(/^\/api\/galeria\/(file|thumbnail|download)\/(\d+)$/);
  if (galleryFileMatch && req.method === "GET") {
    const file = await galleryMediaFile(user.id, Number(galleryFileMatch[2]), galleryFileMatch[1] === "thumbnail", query.get("album_token") || "");
    if (!file) return json(res, 404, { error: "Arquivo nao encontrado." });
    // A miniatura pode ser WebP mesmo quando a foto original e PNG/JPEG.
    const ext = path.extname(file.filePath).toLowerCase() || `.${file.row.extensao}`;
    const type = ({
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska"
    })[ext] || "application/octet-stream";
    const range = req.headers.range && galleryFileMatch[1] !== "download" ? String(req.headers.range) : "";
    const rangeMatch = range.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), file.size - 1) : file.size - 1;
      if (start <= end && start < file.size) {
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${file.size}`,
          "Accept-Ranges": "bytes",
          "Content-Disposition": "inline",
          "Cache-Control": "private, max-age=3600"
        });
        return createReadStream(file.filePath, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": file.size,
      "Content-Disposition": galleryFileMatch[1] === "download" ? `attachment; filename="${encodeURIComponent(galleryDownloadName(file.row))}"` : "inline",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    });
    return createReadStream(file.filePath).pipe(res);
  }

  const galleryZipAlbumMatch = pathname.match(/^\/api\/galeria\/albums\/(\d+)\/download$/);
  if (galleryZipAlbumMatch && req.method === "GET") {
    const albumId = Number(galleryZipAlbumMatch[1]);
    const album = get("SELECT * FROM gallery_albums WHERE id = ? AND user_id = ?", [albumId, user.id]);
    if (!album) return json(res, 404, { error: "Album nao encontrado." });
    if (album.password_hash && !galleryAlbumTokenValid(user.id, albumId, query.get("album_token") || "")) return json(res, 403, { error: "Desbloqueie o album antes de baixar." });
    const rows = all("SELECT * FROM gallery_media WHERE album_id = ? AND user_id = ? ORDER BY id", [albumId, user.id]);
    const entries = [];
    for (const row of rows) {
      const filePath = resolveGalleryStoredPath(row.caminho_arquivo);
      if (existsSync(filePath)) entries.push({ name: galleryDownloadName(row), content: await readFile(filePath), modifiedAt: new Date(row.updated_at || row.created_at || Date.now()) });
    }
    const zip = createZip(entries);
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${encodeURIComponent(album.nome)}.zip"`, "Content-Length": zip.length });
    return res.end(zip);
  }

  if (pathname === "/api/galeria/download-selected" && req.method === "POST") {
    const payload = await body(req);
    const ids = (payload.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return json(res, 400, { error: "Selecione ao menos um arquivo." });
    const marks = ids.map(() => "?").join(",");
    const rows = all(`SELECT * FROM gallery_media WHERE user_id = ? AND id IN (${marks}) ORDER BY id`, [user.id, ...ids]);
    const entries = [];
    for (const row of rows) {
      const filePath = resolveGalleryStoredPath(row.caminho_arquivo);
      if (existsSync(filePath)) entries.push({ name: galleryDownloadName(row), content: await readFile(filePath), modifiedAt: new Date(row.updated_at || row.created_at || Date.now()) });
    }
    const zip = createZip(entries);
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=\"galeria-selecionados.zip\"", "Content-Length": zip.length });
    return res.end(zip);
  }

  if (pathname === "/api/search" && req.method === "GET") {
    const search = String(query.get("q") || query.get("search") || "").trim();
    const results = globalSearch(user.id, search);
    return json(res, 200, { query: search, total: results.length, results });
  }

  if (pathname === "/api/database/auth" && req.method === "POST") {
    const payload = await body(req);
    if (String(payload.username || "").trim().toLocaleLowerCase("pt-BR") !== String(user.username || "").toLocaleLowerCase("pt-BR") || !verifyPassword(payload.password || "", user.password_hash)) {
      return json(res, 401, { error: "Usuario ou senha invalidos para acessar o banco." });
    }
    const token = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000;
    databaseTokens.set(token, { userId: user.id, expiresAt });
    return json(res, 200, { token, expires_at: new Date(expiresAt).toISOString() });
  }

  if (pathname === "/api/passwords/auth" && req.method === "POST") {
    const payload = await body(req);
    if (!verifyPassword(payload.password || "", user.password_hash)) {
      return json(res, 401, { error: "Senha do sistema invalida para abrir o cofre." });
    }
    const token = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    passwordVaultTokens.set(token, { userId: user.id, expiresAt });
    return json(res, 200, { token, expires_at: new Date(expiresAt).toISOString() });
  }

  if (pathname.startsWith("/api/passwords") && pathname !== "/api/passwords/auth" && !validatePasswordVaultToken(req, user)) {
    return json(res, 401, { error: "Confirme a senha do sistema para abrir o cofre." });
  }

  if (pathname === "/api/passwords" && req.method === "GET") {
    const search = String(query.get("search") || "").trim().toLocaleLowerCase("pt-BR");
    const searchId = Number(search.replace(/^#/, ""));
    const rows = all("SELECT * FROM password_vault_items ORDER BY updated_at DESC, id DESC").map((row) => safePasswordVaultItem(row));
    const filteredRows = search ? rows.filter((item) => {
      if (Number.isFinite(searchId) && searchId > 0 && Number(item.id) === searchId) return true;
      return [item.name, item.username, item.uri, item.folder, item.tags].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
    }) : rows;
    return json(res, 200, {
      items: filteredRows,
      totals: {
        total: filteredRows.length,
        with_uri: filteredRows.filter((item) => item.uri).length,
        favorites: filteredRows.filter((item) => item.favorite).length,
        empty_password: filteredRows.filter((item) => !item.password).length
      }
    });
  }

  if (pathname === "/api/passwords" && req.method === "POST") {
    const item = insertPasswordVaultItem(await body(req));
    recordTimeline("Senha cadastrada no cofre", item.name, "passwords");
    return json(res, 201, item);
  }

  if (pathname === "/api/passwords/import" && req.method === "POST") {
    const payload = await body(req);
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 5000) : [];
    if (!items.length) return json(res, 400, { error: "Nenhuma senha valida encontrada para importar." });
    const imported = items.map((item) => insertPasswordVaultItem({ ...item, source: payload.source || item.source || "importado" }));
    recordTimeline("Senhas importadas para o cofre", `${imported.length} item(ns) importados`, "passwords");
    return json(res, 201, { imported: imported.length, items: imported });
  }

  const passwordMatch = pathname.match(/^\/api\/passwords\/(\d+)$/);
  if (passwordMatch) {
    const id = Number(passwordMatch[1]);
    const record = get("SELECT * FROM password_vault_items WHERE id = ?", [id]);
    if (!record) return json(res, 404, { error: "Senha nao encontrada." });
    if (req.method === "GET") return json(res, 200, safePasswordVaultItem(record));
    if (req.method === "PUT") {
      const item = normalizePasswordVaultPayload(await body(req));
      const now = currentDateTime();
      run(`
        UPDATE password_vault_items
        SET name = ?, username = ?, uri = ?, folder = ?, notes = ?, tags = ?, source = ?, favorite = ?,
            encrypted_password = ?, encrypted_totp = ?, raw_encrypted = ?, updated_at = ?
        WHERE id = ?
      `, [
        encryptVaultText(item.name),
        encryptVaultText(item.username),
        encryptVaultText(item.uri),
        encryptVaultText(item.folder),
        encryptVaultText(item.notes),
        encryptVaultText(item.tags),
        item.source,
        item.favorite,
        encryptVaultText(item.password),
        encryptVaultText(item.totp),
        encryptVaultText(item.raw),
        now,
        id
      ]);
      const updated = safePasswordVaultItem(get("SELECT * FROM password_vault_items WHERE id = ?", [id]));
      recordTimeline("Senha alterada no cofre", updated.name, "passwords");
      return json(res, 200, updated);
    }
    if (req.method === "DELETE") {
      const removed = safePasswordVaultItem(record);
      run("DELETE FROM password_vault_items WHERE id = ?", [id]);
      recordTimeline("Senha removida do cofre", removed.name, "passwords");
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/instagram-accounts" && req.method === "GET") {
    return json(res, 200, listInstagramAccounts(user.id, query));
  }
  if (pathname === "/api/instagram-accounts" && req.method === "POST") {
    try {
      const item = createInstagramAccount(user.id, await body(req));
      recordTimeline("Conta Instagram cadastrada", `@${item.usuario}`, "instagram");
      return json(res, 201, item);
    } catch (error) {
      const message = String(error.message || "");
      return json(res, Number(error.statusCode || (message.includes("UNIQUE") ? 409 : 400)), { error: message.includes("UNIQUE") ? "Esse usuario do Instagram ja esta cadastrado." : message });
    }
  }
  if (pathname === "/api/instagram-accounts/import" && req.method === "POST") {
    const payload = await body(req);
    const records = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    if (!records.length) return json(res, 400, { error: "Nenhuma conta valida foi encontrada no arquivo." });
    if (records.length > 500) return json(res, 400, { error: "Importe no maximo 500 contas por vez." });
    const imported = [];
    const errors = [];
    records.forEach((record, index) => {
      try {
        imported.push(createInstagramAccount(user.id, record));
      } catch (error) {
        errors.push({ row: index + 1, error: String(error.message || "Falha ao importar") });
      }
    });
    if (imported.length) recordTimeline("Contas Instagram importadas", `${imported.length} conta(s)`, "instagram");
    return json(res, imported.length ? 200 : 400, { imported: imported.length, errors });
  }

  const instagramMatch = pathname.match(/^\/api\/instagram-accounts\/(\d+)(?:\/(secret|archive))?$/);
  if (instagramMatch) {
    const id = Number(instagramMatch[1]);
    const action = instagramMatch[2] || "";
    try {
      const row = instagramAccountById(user.id, id);
      if (!action && req.method === "GET") return json(res, 200, safeInstagramAccount(row));
      if (!action && req.method === "PUT") {
        const updated = updateInstagramAccount(user.id, id, await body(req));
        recordTimeline("Conta Instagram atualizada", `@${updated.usuario}`, "instagram");
        return json(res, 200, updated);
      }
      if (!action && req.method === "DELETE") {
        run("DELETE FROM instagram_accounts WHERE user_id = ? AND id = ?", [user.id, id]);
        recordTimeline("Conta Instagram removida", `@${row.usuario}`, "instagram");
        return json(res, 200, { ok: true });
      }
      if (action === "secret" && req.method === "GET") {
        return json(res, 200, {
          id,
          password: decryptVaultText(row.senha_criptografada),
          codigo_2fa: decryptVaultText(row.codigo_2fa)
        });
      }
      if (action === "archive" && req.method === "POST") {
        const archived = row.status === "Arquivada";
        run("UPDATE instagram_accounts SET status = ?, atualizado_em = ? WHERE user_id = ? AND id = ?", [
          archived ? "Ativa" : "Arquivada",
          currentDateTime(),
          user.id,
          id
        ]);
        const updated = safeInstagramAccount(instagramAccountById(user.id, id));
        recordTimeline(archived ? "Conta Instagram reativada" : "Conta Instagram arquivada", `@${updated.usuario}`, "instagram");
        return json(res, 200, updated);
      }
    } catch (error) {
      const message = String(error.message || "");
      return json(res, Number(error.statusCode || (message.includes("UNIQUE") ? 409 : 400)), { error: message.includes("UNIQUE") ? "Esse usuario do Instagram ja esta cadastrado." : message });
    }
  }

  if (pathname === "/api/google-accounts" && req.method === "GET") {
    return json(res, 200, listGoogleAccounts(user.id, query));
  }
  if (pathname === "/api/google-accounts" && req.method === "POST") {
    try {
      const item = createGoogleAccount(user.id, await body(req));
      recordTimeline("Conta Google cadastrada", item.email, "google");
      return json(res, 201, item);
    } catch (error) {
      const message = String(error.message || "");
      return json(res, Number(error.statusCode || (message.includes("UNIQUE") ? 409 : 400)), { error: message.includes("UNIQUE") ? "Essa conta Google ja esta cadastrada." : message });
    }
  }

  const googleMatch = pathname.match(/^\/api\/google-accounts\/(\d+)(?:\/(secret|archive|review))?$/);
  if (googleMatch) {
    const id = Number(googleMatch[1]);
    const action = googleMatch[2] || "";
    try {
      const row = googleAccountById(user.id, id);
      if (!action && req.method === "GET") return json(res, 200, safeGoogleAccount(row));
      if (!action && req.method === "PUT") {
        const updated = updateGoogleAccount(user.id, id, await body(req));
        recordTimeline("Conta Google atualizada", updated.email, "google");
        return json(res, 200, updated);
      }
      if (!action && req.method === "DELETE") {
        run("DELETE FROM google_accounts WHERE user_id = ? AND id = ?", [user.id, id]);
        recordTimeline("Conta Google removida", row.email, "google");
        return json(res, 200, { ok: true });
      }
      if (action === "secret" && req.method === "GET") {
        return json(res, 200, {
          id,
          password: decryptVaultText(row.senha_criptografada),
          backup_codes: decryptVaultText(row.codigos_backup_criptografados)
        });
      }
      if (action === "archive" && req.method === "POST") {
        const archived = Number(row.arquivado || 0) ? 0 : 1;
        run("UPDATE google_accounts SET arquivado = ?, status = ?, atualizado_em = ? WHERE user_id = ? AND id = ?", [
          archived,
          archived ? "Arquivada" : "Ativa",
          currentDateTime(),
          user.id,
          id
        ]);
        const updated = safeGoogleAccount(googleAccountById(user.id, id));
        recordTimeline(archived ? "Conta Google arquivada" : "Conta Google reativada", updated.email, "google");
        return json(res, 200, updated);
      }
      if (action === "review" && req.method === "POST") {
        run("UPDATE google_accounts SET ultima_revisao = ?, atualizado_em = ? WHERE user_id = ? AND id = ?", [
          currentDateTime().slice(0, 10),
          currentDateTime(),
          user.id,
          id
        ]);
        const updated = safeGoogleAccount(googleAccountById(user.id, id));
        recordTimeline("Conta Google revisada", updated.email, "google");
        return json(res, 200, updated);
      }
    } catch (error) {
      const message = String(error.message || "");
      return json(res, Number(error.statusCode || (message.includes("UNIQUE") ? 409 : 400)), { error: message.includes("UNIQUE") ? "Essa conta Google ja esta cadastrada." : message });
    }
  }

  if (pathname === "/api/2fa/status" && req.method === "GET") {
    const settings = twofaSettings(user.id);
    const unlocked = Boolean(twofaAccess(req, user));
    return json(res, 200, { configured: Boolean(settings), unlocked, expires_in: unlocked ? Math.max(0, Math.floor((twofaAccess(req, user).expiresAt - Date.now()) / 1000)) : 0 });
  }

  if (pathname === "/api/2fa/setup" && req.method === "POST") {
    const existing = twofaSettings(user.id);
    if (existing) return json(res, 409, { error: "Senha mestre do Cofre 2FA ja configurada." });
    const payload = await body(req);
    const masterPassword = String(payload.master_password || "");
    if (masterPassword.length < 6) return json(res, 400, { error: "A senha mestre precisa ter pelo menos 6 caracteres." });
    const salt = randomBytes(16).toString("hex");
    run("INSERT INTO twofa_vault_settings (user_id, master_password_hash, encryption_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      user.id,
      hashPassword(masterPassword),
      salt,
      currentDateTime(),
      currentDateTime()
    ]);
    recordTimeline("Cofre 2FA configurado", "Senha mestre criada", "2fa");
    return json(res, 201, { configured: true });
  }

  if (pathname === "/api/2fa/unlock" && req.method === "POST") {
    const settings = twofaSettings(user.id);
    if (!settings) return json(res, 400, { error: "Configure a senha mestre do Cofre 2FA primeiro." });
    const payload = await body(req);
    const masterPassword = String(payload.master_password || "");
    if (!verifyPassword(masterPassword, settings.master_password_hash)) return json(res, 401, { error: "Senha mestre invalida." });
    const token = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    twofaVaultTokens.set(token, { userId: user.id, expiresAt, key: deriveTwofaKey(masterPassword, settings.encryption_salt) });
    return json(res, 200, { token, expires_at: new Date(expiresAt).toISOString() });
  }

  if (pathname === "/api/2fa/lock" && req.method === "POST") {
    const token = twofaVaultToken(req);
    if (token) twofaVaultTokens.delete(token);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/2fa/steam" && req.method === "GET") {
    try {
      requireTwofaAccess(req, user);
      return json(res, 200, listTwofaSteam(user.id, query));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/2fa/steam" && req.method === "POST") {
    try {
      const access = requireTwofaAccess(req, user);
      const item = createTwofaSteam(user.id, await body(req), access.key);
      recordTimeline("Conta Steam adicionada ao Cofre 2FA", item.name, "2fa");
      return json(res, 201, item);
    } catch (error) {
      const message = String(error.message || "");
      return json(res, Number(error.statusCode || (message.includes("UNIQUE") ? 409 : 400)), { error: message.includes("UNIQUE") ? "Essa conta Steam ja existe no sistema." : message });
    }
  }

  const twofaSteamMatch = pathname.match(/^\/api\/2fa\/steam\/(\d+)(?:\/(secret|code))?$/);
  if (twofaSteamMatch) {
    const id = Number(twofaSteamMatch[1]);
    const action = twofaSteamMatch[2] || "";
    try {
      const access = requireTwofaAccess(req, user);
      const row = twofaSteamById(user.id, id);
      if (!action && req.method === "GET") return json(res, 200, safeTwofaSteamAccount(row));
      if (!action && req.method === "PUT") {
        const updated = updateTwofaSteam(user.id, id, await body(req), access.key);
        recordTimeline("Conta Steam alterada no Cofre 2FA", updated.name, "2fa");
        return json(res, 200, updated);
      }
      if (!action && req.method === "DELETE") {
        run("DELETE FROM steam_accounts WHERE user_id = ? AND id = ?", [user.id, id]);
        recordTimeline("Conta Steam removida do Cofre 2FA", row.nickname || row.steam_login || String(id), "2fa");
        return json(res, 200, { ok: true });
      }
      if (action === "secret" && req.method === "GET") return json(res, 200, twofaSteamSecrets(row, access.key));
      if (action === "code" && req.method === "GET") {
        const sharedSecret = decryptTwofaText(row.encrypted_shared_secret, access.key);
        if (!sharedSecret) return json(res, 400, { error: "Shared Secret nao cadastrado para esta conta." });
        return json(res, 200, steamGuardCode(sharedSecret));
      }
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/2fa/totp" && req.method === "GET") {
    try {
      requireTwofaAccess(req, user);
      return json(res, 200, listTotpItems(user.id, String(query.get("provider") || "google")));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/2fa/totp" && req.method === "POST") {
    try {
      const access = requireTwofaAccess(req, user);
      const item = createTotpItem(user.id, await body(req), access.key);
      recordTimeline("Autenticador TOTP adicionado", `${item.service_name} ${item.account_label}`.trim(), "2fa");
      return json(res, 201, item);
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  const twofaTotpMatch = pathname.match(/^\/api\/2fa\/totp\/(\d+)(?:\/(code))?$/);
  if (twofaTotpMatch) {
    const id = Number(twofaTotpMatch[1]);
    const action = twofaTotpMatch[2] || "";
    try {
      const access = requireTwofaAccess(req, user);
      const row = totpById(user.id, id);
      if (!action && req.method === "PUT") {
        const updated = updateTotpItem(user.id, id, await body(req), access.key);
        recordTimeline("Autenticador TOTP alterado", `${updated.service_name} ${updated.account_label}`.trim(), "2fa");
        return json(res, 200, updated);
      }
      if (!action && req.method === "DELETE") {
        run("DELETE FROM twofa_totp_items WHERE user_id = ? AND id = ?", [user.id, id]);
        recordTimeline("Autenticador TOTP removido", `${row.service_name} ${row.account_label || ""}`.trim(), "2fa");
        return json(res, 200, { ok: true });
      }
      if (action === "code" && req.method === "GET") {
        const secret = decryptTwofaText(row.encrypted_secret, access.key);
        return json(res, 200, totpCode(secret, row));
      }
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname.startsWith("/api/database/") && !validateDatabaseToken(req, user)) {
    return json(res, 401, { error: "Confirme usuario e senha para consultar o banco." });
  }

  if (pathname === "/api/database/overview" && req.method === "GET") {
    const existingTables = all("SELECT name FROM sqlite_master WHERE type = 'table'").map((item) => item.name);
    const tablesInfo = databaseTables
      .filter((tableName) => existingTables.includes(tableName))
      .map(databaseTableInfo);
    return json(res, 200, {
      tables: tablesInfo,
      totals: {
        table_count: tablesInfo.length,
        record_count: tablesInfo.reduce((sum, table) => sum + Number(table.count || 0), 0)
      }
    });
  }

  const databaseTableMatch = pathname.match(/^\/api\/database\/tables\/([^/]+)$/);
  if (databaseTableMatch && req.method === "GET") {
    const tableName = decodeURIComponent(databaseTableMatch[1]);
    if (!databaseTables.includes(tableName)) return json(res, 404, { error: "Tabela nao liberada para consulta." });
    const info = databaseTableInfo(tableName);
    const limit = Math.min(200, Math.max(1, Number(query.get("limit") || 50)));
    const offset = Math.max(0, Number(query.get("offset") || 0));
    const search = String(query.get("search") || "").trim();
    const searchableColumns = info.columns.map((column) => column.name).filter((name) => !["password_hash", "data"].includes(name));
    const where = search && searchableColumns.length
      ? `WHERE ${searchableColumns.map((name) => `CAST(${quoteIdentifier(name)} AS TEXT) LIKE ?`).join(" OR ")}`
      : "";
    const searchValues = where ? searchableColumns.map(() => `%${search}%`) : [];
    const orderColumn = info.columns.some((column) => column.name === info.updatedColumn) ? info.updatedColumn : info.columns[0]?.name;
    const rows = all(
      `SELECT * FROM ${quoteIdentifier(tableName)} ${where} ${orderColumn ? `ORDER BY ${quoteIdentifier(orderColumn)} DESC` : ""} LIMIT ? OFFSET ?`,
      [...searchValues, limit, offset]
    ).map(safeDatabaseRow);
    const filteredCount = where
      ? get(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)} ${where}`, searchValues).count
      : info.count;
    return json(res, 200, { table: info, rows, limit, offset, filtered_count: filteredCount });
  }

  if (pathname === "/api/database/query" && req.method === "POST") {
    const payload = await body(req);
    const sql = selectOnlySql(payload.sql);
    if (!sql) return json(res, 400, { error: "A consulta precisa ser apenas SELECT, sem ponto e virgula ou comandos de alteracao." });
    const limitedSql = /\blimit\s+\d+/i.test(sql) ? sql : `${sql} LIMIT 200`;
    try {
      const rows = all(limitedSql).map(safeDatabaseRow);
      const columns = rows[0] ? Object.keys(rows[0]) : [];
      return json(res, 200, { sql: limitedSql, columns, rows, count: rows.length });
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel executar o SELECT." });
    }
  }

  if (pathname === "/api/agenda" && req.method === "GET") {
    return json(res, 200, {
      events: agendaRows(user.id, query),
      google: safeAgendaSettings(agendaSettings(user.id))
    });
  }

  if (pathname === "/api/agenda" && req.method === "POST") {
    try {
      return json(res, 201, createAgendaEvent(user.id, await body(req)));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel criar o evento." });
    }
  }

  const agendaMatch = pathname.match(/^\/api\/agenda\/events\/(\d+)$/);
  if (agendaMatch && req.method === "PUT") {
    try {
      return json(res, 200, updateAgendaEvent(user.id, Number(agendaMatch[1]), await body(req)));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel alterar o evento." });
    }
  }

  if (agendaMatch && req.method === "DELETE") {
    try {
      return json(res, 200, deleteAgendaEvent(user.id, Number(agendaMatch[1])));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel remover o evento." });
    }
  }

  const agendaDeleteMatch = pathname.match(/^\/api\/agenda\/events\/(\d+)\/delete$/);
  if (agendaDeleteMatch && req.method === "POST") {
    try {
      return json(res, 200, deleteAgendaEvent(user.id, Number(agendaDeleteMatch[1])));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel remover o evento." });
    }
  }

  if (pathname === "/api/agenda/google/status" && req.method === "GET") {
    return json(res, 200, safeAgendaSettings(agendaSettings(user.id)));
  }

  if (pathname === "/api/agenda/google/settings" && req.method === "PUT") {
    try {
      return json(res, 200, saveAgendaSettings(user.id, await body(req)));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel salvar a configuracao do Google." });
    }
  }

  if (pathname === "/api/life-kanban" && req.method === "GET") {
    return json(res, 200, listLifeObjectives(user.id));
  }

  if (pathname === "/api/life-kanban" && req.method === "POST") {
    try {
      return json(res, 201, createLifeObjective(user.id, await body(req)));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel criar o objetivo." });
    }
  }

  if (pathname === "/api/life-kanban/reorder" && req.method === "POST") {
    try {
      const payload = await body(req);
      return json(res, 200, reorderLifeObjectives(user.id, payload.items || []));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel mover os objetivos." });
    }
  }

  const lifeObjectiveMatch = pathname.match(/^\/api\/life-kanban\/(\d+)$/);
  if (lifeObjectiveMatch) {
    const id = Number(lifeObjectiveMatch[1]);
    if (req.method === "GET") {
      const item = lifeObjectiveById(user.id, id, true);
      if (!item) return json(res, 404, { error: "Objetivo nao encontrado." });
      return json(res, 200, item);
    }
    if (req.method === "PUT") {
      try {
        return json(res, 200, updateLifeObjective(user.id, id, await body(req)));
      } catch (error) {
        return json(res, 400, { error: error.message || "Nao foi possivel salvar o objetivo." });
      }
    }
    if (req.method === "DELETE") {
      try {
        return json(res, 200, deleteLifeObjective(user.id, id));
      } catch (error) {
        return json(res, 400, { error: error.message || "Nao foi possivel excluir o objetivo." });
      }
    }
  }

  const lifeStepCreateMatch = pathname.match(/^\/api\/life-kanban\/(\d+)\/steps$/);
  if (lifeStepCreateMatch && req.method === "POST") {
    try {
      return json(res, 201, createLifeStep(user.id, Number(lifeStepCreateMatch[1]), await body(req)));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel criar o passo." });
    }
  }

  const lifeStepMatch = pathname.match(/^\/api\/life-kanban\/(\d+)\/steps\/(\d+)$/);
  if (lifeStepMatch) {
    const objectiveId = Number(lifeStepMatch[1]);
    const stepId = Number(lifeStepMatch[2]);
    if (req.method === "PUT") {
      try {
        return json(res, 200, updateLifeStep(user.id, objectiveId, stepId, await body(req)));
      } catch (error) {
        return json(res, 400, { error: error.message || "Nao foi possivel salvar o passo." });
      }
    }
    if (req.method === "DELETE") {
      try {
        return json(res, 200, deleteLifeStep(user.id, objectiveId, stepId));
      } catch (error) {
        return json(res, 400, { error: error.message || "Nao foi possivel excluir o passo." });
      }
    }
  }

  if (pathname === "/api/agenda/google/auth-url" && req.method === "GET") {
    try {
      return json(res, 200, { url: googleAuthUrl(req, user.id), redirect_uri: googleRedirectUri(req) });
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel iniciar a conexao Google." });
    }
  }

  if (pathname === "/api/agenda/google/callback" && req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      const stateUserId = Number(query.get("state") || user.id);
      if (stateUserId !== user.id) throw new Error("Sessao diferente da autorizacao iniciada.");
      await finishGoogleConnection(req, user.id, query.get("code") || "");
      res.writeHead(200);
      res.end("<!doctype html><meta charset=\"utf-8\"><title>Google Agenda conectado</title><body style=\"font-family:Arial;background:#0f1720;color:#eafdfb;padding:32px\"><h1>Google Agenda conectado</h1><p>Pode voltar para o DRSOSystem e clicar em sincronizar.</p><script>setTimeout(()=>window.close(),1800)</script></body>");
    } catch (error) {
      res.writeHead(400);
      res.end(`<!doctype html><meta charset="utf-8"><title>Falha Google Agenda</title><body style="font-family:Arial;background:#0f1720;color:#ffe4e6;padding:32px"><h1>Falha ao conectar</h1><p>${String(error.message || "Erro desconhecido")}</p></body>`);
    }
    return;
  }

  if (pathname === "/api/agenda/google/sync" && req.method === "POST") {
    try {
      return json(res, 200, await syncGoogleCalendar(user.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel sincronizar o Google Agenda." });
    }
  }

  if (pathname === "/api/agenda/google/disconnect" && req.method === "POST") {
    const now = currentDateTime();
    run(`UPDATE google_calendar_settings
      SET encrypted_refresh_token = '', connected_email = '', sync_enabled = 0, updated_at = ?
      WHERE user_id = ?`, [now, user.id]);
    recordTimeline("Google Agenda desconectado", "Token removido do sistema", "agenda");
    return json(res, 200, safeAgendaSettings(agendaSettings(user.id)));
  }

  if (pathname === "/api/dashboard") return json(res, 200, dashboard());

  if (pathname === "/api/moto/overview" && req.method === "GET") {
    return json(res, 200, motorcycleOverview(user.id));
  }

  if (pathname === "/api/moto/options" && req.method === "GET") {
    return json(res, 200, motorcycleOptions(user.id));
  }

  const motoMatch = pathname.match(/^\/api\/moto\/(motorcycles|fuel|oil|maintenance|tires|documents|mileage|expenses)(?:\/(\d+))?$/);
  if (motoMatch) {
    const resource = motoMatch[1];
    const id = motoMatch[2] ? Number(motoMatch[2]) : null;
    try {
      if (req.method === "GET") {
        if (id) {
          const config = motorcycleResources[resource];
          const record = get(`SELECT * FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, user.id]);
          if (!record) return json(res, 404, { error: "Registro nao encontrado." });
          return json(res, 200, record);
        }
        return json(res, 200, motorcycleRows(resource, user.id, query));
      }
      if (req.method === "POST") {
        const created = createMotorcycleResource(resource, await body(req), user.id);
          recordTimeline("Registro do veiculo criado", `${resource} #${created.id}`, "moto");
        return json(res, 201, created);
      }
      if (req.method === "PUT" && id) {
        const updated = updateMotorcycleResource(resource, id, await body(req), user.id);
          recordTimeline("Registro do veiculo alterado", `${resource} #${id}`, "moto");
        return json(res, 200, updated);
      }
      if (req.method === "DELETE" && id) {
        deleteMotorcycleResource(resource, id, user.id);
          recordTimeline("Registro do veiculo removido", `${resource} #${id}`, "moto");
        return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel salvar o registro do veiculo." });
    }
  }

  if (pathname === "/api/personal/overview" && req.method === "GET") {
    return json(res, 200, personalOverview(user.id));
  }

  if (pathname === "/api/personal/options" && req.method === "GET") {
    return json(res, 200, personalOptions());
  }

  const personalMatch = pathname.match(/^\/api\/personal\/(resume|courses|futureStudies|experiences|skills|goals|checklist|achievements|personalProjects|habits)(?:\/(\d+))?$/);
  if (personalMatch) {
    const resource = personalMatch[1];
    const id = personalMatch[2] ? Number(personalMatch[2]) : null;
    try {
      if (req.method === "GET") {
        if (id) {
          const config = personalResources[resource];
          const record = get(`SELECT * FROM ${config.table} WHERE id = ? AND user_id = ?`, [id, user.id]);
          if (!record) return json(res, 404, { error: "Registro nao encontrado." });
          return json(res, 200, record);
        }
        return json(res, 200, personalRows(resource, user.id, query));
      }
      if (req.method === "POST") {
        const created = createPersonalResource(resource, await body(req), user.id);
        recordTimeline("Registro pessoal criado", `${resource} #${created.id}`, "personal");
        return json(res, 201, created);
      }
      if (req.method === "PUT" && id) {
        const updated = updatePersonalResource(resource, id, await body(req), user.id);
        recordTimeline("Registro pessoal alterado", `${resource} #${id}`, "personal");
        return json(res, 200, updated);
      }
      if (req.method === "DELETE" && id) {
        deletePersonalResource(resource, id, user.id);
        recordTimeline("Registro pessoal removido", `${resource} #${id}`, "personal");
        return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, 400, { error: error.message || "Nao foi possivel salvar o registro pessoal." });
    }
  }

  if (pathname === "/api/documents/upload" && req.method === "POST") {
    const payload = await body(req);
    if (!payload.name || !payload.data) return json(res, 400, { error: "Selecione um arquivo valido." });
    const originalName = path.basename(String(payload.name)).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    const storedName = `${randomBytes(24).toString("hex")}.drso`;
    const encoded = String(payload.data).includes(",") ? String(payload.data).split(",").pop() : String(payload.data);
    const content = Buffer.from(encoded, "base64");
    if (!content.length) return json(res, 400, { error: "O arquivo selecionado esta vazio." });
    if (content.length > 25 * 1024 * 1024) return json(res, 400, { error: "O arquivo deve ter no maximo 25 MB." });
    await writeFile(path.join(documentUploadsDir, storedName), encryptDocument(content));
    return json(res, 201, {
      name: originalName,
      file_path: `drso-secure://${storedName}`,
      storage_label: "Arquivo protegido no sistema",
      size: content.length,
      mime_type: payload.mime_type || "application/octet-stream",
      source_modified_at: payload.source_modified_at ? normalizeDateTime(payload.source_modified_at) : null,
      uploaded_at: currentDateTime()
    });
  }
  const documentFileMatch = pathname.match(/^\/api\/documents\/(\d+)\/(download|preview)$/);
  if (documentFileMatch && req.method === "GET") {
    const record = get("SELECT * FROM documents WHERE id = ?", [Number(documentFileMatch[1])]);
    if (!record) return json(res, 404, { error: "Documento nao encontrado" });
    const storagePath = documentStoragePath(record);
    if (!storagePath || !existsSync(storagePath)) return json(res, 404, { error: "Arquivo protegido nao encontrado" });
    const content = decryptDocument(await readFile(storagePath));
    const fileName = record.original_name || record.name || `documento-${record.id}`;
    if (documentFileMatch[2] === "preview") {
      const text = previewDocumentText(record, content);
      return json(res, 200, {
        id: record.id,
        name: record.name,
        original_name: fileName,
        category: record.category,
        created_at: record.created_at,
        uploaded_at: record.uploaded_at || record.created_at,
        source_modified_at: record.source_modified_at,
        preview_text: text,
        preview_available: Boolean(text)
      });
    }
    res.writeHead(200, {
      "Content-Type": record.mime_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    });
    return res.end(content);
  }
  const documentContentMatch = pathname.match(/^\/api\/documents\/(\d+)\/content$/);
  if (documentContentMatch && req.method === "PUT") {
    const record = get("SELECT * FROM documents WHERE id = ?", [Number(documentContentMatch[1])]);
    if (!record) return json(res, 404, { error: "Documento nao encontrado" });
    const payload = await body(req);
    const storagePath = documentStoragePath(record);
    if (!storagePath || !existsSync(storagePath)) return json(res, 404, { error: "Arquivo protegido nao encontrado" });
    const content = decryptDocument(await readFile(storagePath));
    const updated = updateDocxText(content, payload.text || "");
    if (!updated) return json(res, 400, { error: "Edicao interna disponivel apenas para arquivos Word .docx." });
    await writeFile(storagePath, encryptDocument(updated));
    const now = currentDateTime();
    run("UPDATE documents SET source_modified_at = ?, updated_at = ? WHERE id = ?", [now, now, record.id]);
    return json(res, 200, get("SELECT * FROM documents WHERE id = ?", [record.id]));
  }
  if (pathname === "/api/settings" && req.method === "GET") return json(res, 200, { user: publicUser(user), dbPath, backups: all("SELECT * FROM backups ORDER BY created_at DESC LIMIT 20") });
  if (pathname === "/api/settings" && req.method === "PUT") {
    const payload = await body(req);
    const profile = normalizeUserProfilePayload(payload, user);
    run(`UPDATE users
      SET name = ?, first_name = ?, last_name = ?, avatar_url = ?, bio = ?, slogan = ?, city = ?, birth_date = ?,
          date_format = ?, accent_color = ?, theme = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`, [
      profile.name,
      profile.first_name,
      profile.last_name,
      profile.avatar_url,
      profile.bio,
      profile.slogan,
      profile.city,
      profile.birth_date,
      profile.date_format,
      profile.accent_color,
      profile.theme,
      user.id
    ]);
    return json(res, 200, publicUser(get("SELECT * FROM users WHERE id = ?", [user.id])));
  }
  if (pathname === "/api/csgo-skins/overview" && req.method === "GET") return json(res, 200, csgoSkinsOverview(user.id));
  if (pathname === "/api/csgo-skins/accounts") {
    if (req.method === "GET") return json(res, 200, listCsgoSkinsAccounts(user.id));
    if (req.method === "POST") {
      const payload = await body(req);
      const authInput = parseCsgoSkinsAuthInput(payload.token || payload.cookie || "");
      const token = authInput.secret;
      const record = {
        user_id: user.id,
        nickname: String(payload.nickname || "").trim(),
        notes: String(payload.notes || ""),
        is_active: payload.is_active === false ? 0 : 1,
        connection_status: token ? "precisa testar" : "precisa reconectar",
        encrypted_token: token ? encryptVaultText(token) : "",
        token_hint: token ? csgoTokenHint(token) : "",
        user_agent: authInput.user_agent || String(payload.user_agent || ""),
        accept_language: authInput.accept_language || String(payload.accept_language || "")
      };
      if (!record.nickname) return json(res, 400, { error: "Informe um apelido para a conta." });
      const result = insertByFields("csgo_skins_accounts", csgoSkinsAccountFields, record);
      recordTimeline("Conta CSGO-SKINS cadastrada", record.nickname, "csgo-skins");
      return json(res, 201, cleanCsgoAccount(get("SELECT * FROM csgo_skins_accounts WHERE id = ?", [result.lastInsertRowid])));
    }
  }
  const csgoAccountMatch = pathname.match(/^\/api\/csgo-skins\/accounts\/(\d+)(?:\/(test|sync|sync-inventory|sync-transactions|toggle|manual-inventory))?$/);
  if (csgoAccountMatch) {
    const id = Number(csgoAccountMatch[1]);
    const action = csgoAccountMatch[2];
    const account = get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!account) return json(res, 404, { error: "Conta CSGO-SKINS nao encontrada." });
    if (req.method === "PUT" && !action) {
      const payload = await body(req);
      const update = {
        nickname: String(payload.nickname || "").trim(),
        notes: String(payload.notes || ""),
        is_active: payload.is_active === false ? 0 : 1
      };
      const authInput = parseCsgoSkinsAuthInput(payload.token || payload.cookie || "");
      const token = authInput.secret;
      if (token) {
        update.encrypted_token = encryptVaultText(token);
        update.token_hint = csgoTokenHint(token);
        update.connection_status = "precisa testar";
        update.user_agent = authInput.user_agent || String(payload.user_agent || account.user_agent || "");
        update.accept_language = authInput.accept_language || String(payload.accept_language || account.accept_language || "");
      }
      if (!update.nickname) return json(res, 400, { error: "Informe um apelido para a conta." });
      updateByFields("csgo_skins_accounts", csgoSkinsAccountFields, id, update);
      return json(res, 200, cleanCsgoAccount(get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [id, user.id])));
    }
    if (req.method === "POST" && action === "toggle") {
      run("UPDATE csgo_skins_accounts SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [account.is_active ? 0 : 1, id]);
      return json(res, 200, cleanCsgoAccount(get("SELECT * FROM csgo_skins_accounts WHERE id = ?", [id])));
    }
    if (req.method === "POST" && action === "manual-inventory") {
      const payload = await body(req);
      const enabled = payload.enabled === false || payload.enabled === "false" || payload.enabled === 0 || payload.enabled === "0" ? 0 : 1;
      const value = enabled ? Math.max(0, roundMoney(parseServerCurrencyInput(payload.value ?? payload.inventory_value_brl ?? payload.manual_inventory_value_brl))) : 0;
      const status = enabled
        ? `Saldo manual definido em ${value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`
        : "Saldo manual removido. Valor sincronizado em uso.";
      run(
        "UPDATE csgo_skins_accounts SET manual_inventory_enabled = ?, manual_inventory_value_brl = ?, sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
        [enabled, value, status, id, user.id]
      );
      recordTimeline(enabled ? "Saldo manual CSGO-SKINS atualizado" : "Saldo manual CSGO-SKINS removido", account.nickname, "csgo-skins");
      const updated = listCsgoSkinsAccounts(user.id).find((item) => Number(item.id) === id);
      return json(res, 200, updated || cleanCsgoAccount(get("SELECT * FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [id, user.id])));
    }
    if (req.method === "POST" && action === "test") {
      try {
        return json(res, 200, await csgoSkinsService.testAccountConnection(id, user.id));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && action === "sync") {
      try {
        return json(res, 200, await csgoSkinsService.syncAccount(id, user.id));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && action === "sync-inventory") {
      try {
        return json(res, 200, await syncCsgoSkinsInventory(id, user.id));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && action === "sync-transactions") {
      try {
        return json(res, 200, await syncCsgoSkinsTransactions(id, user.id));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "DELETE" && !action) {
      run("DELETE FROM csgo_skins_accounts WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/csgo-skins/sync" && req.method === "POST") return json(res, 200, { results: await csgoSkinsService.syncAllAccounts(user.id) });
  if (pathname === "/api/csgo-skins/transactions" && req.method === "GET") return json(res, 200, listCsgoSkinsTransactions(user.id, query));
  if (pathname === "/api/csgo-skins/inventory" && req.method === "GET") return json(res, 200, listCsgoSkinsInventory(user.id, query));
  if (pathname === "/api/csgo-skins/cases") {
    if (req.method === "GET") return json(res, 200, all("SELECT * FROM csgo_skins_cases ORDER BY category_name, position, name"));
    if (req.method === "POST") {
      try {
        return json(res, 200, await syncCsgoSkinsCases(user.id, Number((await body(req)).account_id || 0)));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
  }
  if (pathname === "/api/csgo-skins/reports" && req.method === "GET") return json(res, 200, csgoSkinsReports(user.id));
  if (pathname === "/api/csgo-skins/logs" && req.method === "GET") {
    return json(res, 200, all(`
      SELECT csgo_skins_sync_logs.*, csgo_skins_accounts.nickname AS account_nickname
      FROM csgo_skins_sync_logs
      LEFT JOIN csgo_skins_accounts ON csgo_skins_accounts.id = csgo_skins_sync_logs.account_id
      WHERE csgo_skins_accounts.user_id = ? OR csgo_skins_sync_logs.account_id IS NULL
      ORDER BY started_at DESC LIMIT 80
    `, [user.id]));
  }
  if (pathname === "/api/steam/overview" && req.method === "GET") return json(res, 200, steamOverview(user.id));
  if (pathname === "/api/steam/accounts" && req.method === "GET") return json(res, 200, listSteamAccounts(user.id));
  if (pathname === "/api/steam/accounts" && req.method === "POST") {
    const payload = steamAccountPayload(await body(req), user.id);
    if (!payload.steam_id || payload.steam_id.length < 16) return json(res, 400, { error: "Informe um SteamID64 valido." });
    const result = insertByFields("steam_accounts", steamAccountFields, payload);
    if (payload.is_primary) setPrimarySteamAccount(Number(result.lastInsertRowid), user.id);
    recordTimeline("Conta Steam cadastrada", payload.nickname, "steam");
    return json(res, 201, get("SELECT * FROM steam_accounts WHERE id = ?", [result.lastInsertRowid]));
  }
  const steamAccountMatch = pathname.match(/^\/api\/steam\/accounts\/(\d+)(?:\/(sync|toggle|inventory-sync))?$/);
  if (steamAccountMatch) {
    const id = Number(steamAccountMatch[1]);
    const action = steamAccountMatch[2];
    if (req.method === "PUT" && !action) {
      const payload = steamAccountPayload(await body(req), user.id);
      if (!payload.steam_id || payload.steam_id.length < 16) return json(res, 400, { error: "Informe um SteamID64 valido." });
      updateByFields("steam_accounts", steamAccountFields, id, payload);
      if (payload.is_primary) setPrimarySteamAccount(id, user.id);
      return json(res, 200, get("SELECT * FROM steam_accounts WHERE id = ? AND user_id = ?", [id, user.id]));
    }
    if (req.method === "POST" && action === "toggle") {
      const account = get("SELECT * FROM steam_accounts WHERE id = ? AND user_id = ?", [id, user.id]);
      if (!account) return json(res, 404, { error: "Conta Steam nao encontrada." });
      run("UPDATE steam_accounts SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [account.is_active ? 0 : 1, id]);
      return json(res, 200, get("SELECT * FROM steam_accounts WHERE id = ?", [id]));
    }
    if (req.method === "POST" && action === "sync") {
      try {
        return json(res, 200, await syncSteamAccount(id, user.id));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && action === "inventory-sync") {
      try {
        return json(res, 200, await syncSteamInventoryOnly(id, user.id));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "DELETE" && !action) {
      run("DELETE FROM steam_accounts WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/steam/sync" && req.method === "POST") {
    const accounts = all("SELECT * FROM steam_accounts WHERE user_id = ? AND is_active = 1", [user.id]);
    const results = [];
    for (const [index, account] of accounts.entries()) {
      if (index > 0) await sleep(3000);
      try {
        results.push({ id: account.id, ok: true, account: await syncSteamAccount(account.id, user.id) });
      } catch (error) {
        results.push({ id: account.id, ok: false, error: error.message });
      }
    }
    return json(res, 200, { results });
  }
  if (pathname === "/api/steam/games" && req.method === "GET") {
    const clauses = ["steam_accounts.user_id = ?"];
    const values = [user.id];
    if (query.get("account")) {
      clauses.push("steam_games.steam_account_id = ?");
      values.push(Number(query.get("account")));
    }
    if (query.get("filter") === "favorites") clauses.push("steam_games.is_favorite = 1");
    if (query.get("filter") === "never") clauses.push("steam_games.playtime_forever = 0");
    if (query.get("filter") === "recent") clauses.push("steam_games.playtime_2weeks > 0");
    const order = query.get("filter") === "less" ? "steam_games.playtime_forever ASC" : "steam_games.playtime_forever DESC";
    return json(res, 200, all(`SELECT steam_games.*, steam_accounts.nickname AS account_nickname FROM steam_games JOIN steam_accounts ON steam_accounts.id = steam_games.steam_account_id WHERE ${clauses.join(" AND ")} ORDER BY ${order}, steam_games.name`, values));
  }
  const steamGameFavoriteMatch = pathname.match(/^\/api\/steam\/games\/(\d+)\/favorite$/);
  if (steamGameFavoriteMatch && req.method === "POST") {
    const id = Number(steamGameFavoriteMatch[1]);
    const game = get("SELECT steam_games.* FROM steam_games JOIN steam_accounts ON steam_accounts.id = steam_games.steam_account_id WHERE steam_games.id = ? AND steam_accounts.user_id = ?", [id, user.id]);
    if (!game) return json(res, 404, { error: "Jogo nao encontrado." });
    run("UPDATE steam_games SET is_favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [game.is_favorite ? 0 : 1, id]);
    return json(res, 200, get("SELECT * FROM steam_games WHERE id = ?", [id]));
  }
  if (pathname === "/api/steam/achievements" && req.method === "GET") {
    return json(res, 200, all(`SELECT steam_achievements.*, steam_accounts.nickname AS account_nickname FROM steam_achievements JOIN steam_accounts ON steam_accounts.id = steam_achievements.steam_account_id WHERE steam_accounts.user_id = ? ORDER BY appid, unlocked DESC, display_name`, [user.id]));
  }
  if (pathname === "/api/steam/friends" && req.method === "GET") {
    return json(res, 200, all(`SELECT steam_friends.*, steam_accounts.nickname AS account_nickname FROM steam_friends JOIN steam_accounts ON steam_accounts.id = steam_friends.steam_account_id WHERE steam_accounts.user_id = ? ORDER BY person_state DESC, persona_name`, [user.id]));
  }
  if (pathname === "/api/steam/inventory" && req.method === "GET") {
    return json(res, 200, all(`SELECT steam_inventory_items.*, steam_accounts.nickname AS account_nickname FROM steam_inventory_items JOIN steam_accounts ON steam_accounts.id = steam_inventory_items.steam_account_id WHERE steam_accounts.user_id = ? ORDER BY steam_accounts.nickname, steam_inventory_items.appid, steam_inventory_items.item_name`, [user.id]));
  }
  const steamInventoryMatch = pathname.match(/^\/api\/steam\/inventory\/(\d+)$/);
  if (steamInventoryMatch && req.method === "PUT") {
    const payload = await body(req);
    const id = Number(steamInventoryMatch[1]);
    const item = get("SELECT steam_inventory_items.id FROM steam_inventory_items JOIN steam_accounts ON steam_accounts.id = steam_inventory_items.steam_account_id WHERE steam_inventory_items.id = ? AND steam_accounts.user_id = ?", [id, user.id]);
    if (!item) return json(res, 404, { error: "Item nao encontrado." });
    run("UPDATE steam_inventory_items SET estimated_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(payload.estimated_price || 0), id]);
    return json(res, 200, get("SELECT * FROM steam_inventory_items WHERE id = ?", [id]));
  }
  if (pathname === "/api/steam/logs" && req.method === "GET") {
    return json(res, 200, all("SELECT steam_sync_logs.*, steam_accounts.nickname AS account_nickname FROM steam_sync_logs LEFT JOIN steam_accounts ON steam_accounts.id = steam_sync_logs.steam_account_id WHERE steam_accounts.user_id = ? OR steam_sync_logs.steam_account_id IS NULL ORDER BY steam_sync_logs.started_at DESC LIMIT 80", [user.id]));
  }
  if (pathname === "/api/users/password" && req.method === "PUT") {
    const payload = await body(req);
    if (!verifyPassword(payload.currentPassword || "", user.password_hash)) return json(res, 401, { error: "Senha atual incorreta" });
    if (!payload.newPassword || payload.newPassword.length < 6) return json(res, 400, { error: "A nova senha precisa ter pelo menos 6 caracteres" });
    run("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [hashPassword(payload.newPassword), user.id]);
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/finance/catalog" && req.method === "GET") {
    return json(res, 200, {
      type: listCatalog("type"),
      category: listCatalog("category"),
      payment_method: listCatalog("payment_method")
    });
  }
  if (pathname === "/api/finance/catalog" && req.method === "POST") {
    const payload = await body(req);
    const kind = normalizeKind(payload.kind);
    if (!["type", "category", "payment_method"].includes(kind)) return json(res, 400, { error: "Tipo de cadastro invalido" });
    if (!payload.name) return json(res, 400, { error: "Informe o nome" });
    run("DELETE FROM finance_catalog_deleted_items WHERE kind = ? AND lower(name) = lower(?)", [kind, payload.name.trim()]);
    const result = run("INSERT INTO finance_catalog_items (kind, name, color, notes) VALUES (?, ?, ?, ?)", [
      kind,
      payload.name.trim(),
      payload.color || "#2dd4bf",
      payload.notes || ""
    ]);
    recordTimeline(`Cadastro financeiro: ${catalogLabel(kind)}`, payload.name, "finance");
    return json(res, 201, get("SELECT * FROM finance_catalog_items WHERE id = ?", [result.lastInsertRowid]));
  }
  const catalogMatch = pathname.match(/^\/api\/finance\/catalog\/(type|category|payment_method)\/(\d+)$/);
  if (catalogMatch) {
    const [, kind, id] = catalogMatch;
    if (req.method === "PUT") {
      const payload = await body(req);
      run("UPDATE finance_catalog_items SET name = ?, color = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kind = ?", [
        payload.name?.trim() || "",
        payload.color || "#2dd4bf",
        payload.notes || "",
        Number(id),
        kind
      ]);
      return json(res, 200, get("SELECT * FROM finance_catalog_items WHERE id = ?", [Number(id)]));
    }
    if (req.method === "DELETE") {
      const record = get("SELECT * FROM finance_catalog_items WHERE id = ? AND kind = ?", [Number(id), kind]);
      if (!record) return json(res, 404, { error: "Cadastro nao encontrado" });
      run("INSERT OR REPLACE INTO finance_catalog_deleted_items (kind, name, deleted_at) VALUES (?, ?, ?)", [kind, record.name, currentDateTime()]);
      run("DELETE FROM finance_catalog_items WHERE id = ? AND kind = ?", [Number(id), kind]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/finance/accounts" && req.method === "GET") return json(res, 200, accountBalances());
  if (pathname === "/api/finance/accounts" && req.method === "POST") {
    const payload = await body(req);
    if (!payload.name || !payload.bank) return json(res, 400, { error: "Informe nome da conta e banco" });
    const result = run("INSERT INTO bank_accounts (name, bank, account_type, color, initial_balance, notes) VALUES (?, ?, ?, ?, ?, ?)", [
      payload.name.trim(),
      payload.bank.trim(),
      payload.account_type || "conta corrente",
      payload.color || "#2dd4bf",
      Number(payload.initial_balance || 0),
      payload.notes || ""
    ]);
    recordTimeline("Conta financeira criada", `${payload.bank} - ${payload.name}`, "finance");
    return json(res, 201, get("SELECT * FROM bank_accounts WHERE id = ?", [result.lastInsertRowid]));
  }
  const accountMatch = pathname.match(/^\/api\/finance\/accounts\/(\d+)$/);
  if (accountMatch) {
    const accountId = Number(accountMatch[1]);
    if (req.method === "PUT") {
      const payload = await body(req);
      run("UPDATE bank_accounts SET name = ?, bank = ?, account_type = ?, color = ?, initial_balance = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        payload.name?.trim() || "Conta",
        payload.bank?.trim() || "Banco",
        payload.account_type || "conta corrente",
        payload.color || "#2dd4bf",
        Number(payload.initial_balance || 0),
        payload.notes || "",
        accountId
      ]);
      return json(res, 200, get("SELECT * FROM bank_accounts WHERE id = ?", [accountId]));
    }
    if (req.method === "DELETE") {
      const total = get("SELECT COUNT(*) AS count FROM financial_transactions WHERE account_id = ? OR destination_account_id = ?", [accountId, accountId]).count;
      if (total > 0) return json(res, 409, { error: "Esta conta tem movimentacoes. Exclua ou mova as transacoes primeiro." });
      run("DELETE FROM bank_accounts WHERE id = ?", [accountId]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/finance/pockets" && req.method === "POST") {
    const payload = await body(req);
    const accountId = Number(payload.account_id || 0);
    const account = get("SELECT * FROM bank_accounts WHERE id = ?", [accountId]);
    if (!account) return json(res, 404, { error: "Conta nao encontrada." });
    const name = String(payload.name || "").trim();
    if (!name) return json(res, 400, { error: "Informe o nome da caixinha." });
    const result = run("INSERT INTO finance_account_pockets (account_id, name, kind, initial_balance, color, notes) VALUES (?, ?, ?, ?, ?, ?)", [
      accountId,
      name,
      ["caixinha", "investimento", "cripto"].includes(payload.kind) ? payload.kind : "caixinha",
      Number(payload.initial_balance || 0),
      payload.color || account.color || "#2dd4bf",
      payload.notes || ""
    ]);
    recordTimeline("Caixinha financeira criada", `${account.bank} - ${name}`, "finance");
    return json(res, 201, get("SELECT * FROM finance_account_pockets WHERE id = ?", [result.lastInsertRowid]));
  }
  const pocketMatch = pathname.match(/^\/api\/finance\/pockets\/(\d+)(?:\/movement)?$/);
  if (pocketMatch) {
    const pocketId = Number(pocketMatch[1]);
    const pocket = get("SELECT * FROM finance_account_pockets WHERE id = ?", [pocketId]);
    if (!pocket) return json(res, 404, { error: "Caixinha nao encontrada." });
    if (pathname.endsWith("/movement") && req.method === "POST") {
      const payload = await body(req);
      const amount = Number(payload.amount || 0);
      if (amount <= 0) return json(res, 400, { error: "Informe um valor maior que zero." });
      run("INSERT INTO finance_account_pocket_movements (pocket_id, type, amount, date, notes) VALUES (?, ?, ?, ?, ?)", [
        pocketId,
        payload.type === "saida" ? "saida" : "entrada",
        amount,
        payload.date || currentDateTime(),
        payload.notes || ""
      ]);
      return json(res, 201, { ok: true });
    }
    if (req.method === "PUT") {
      const payload = await body(req);
      run("UPDATE finance_account_pockets SET name = ?, kind = ?, initial_balance = ?, color = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        String(payload.name || "").trim() || "Caixinha",
        ["caixinha", "investimento", "cripto"].includes(payload.kind) ? payload.kind : "caixinha",
        Number(payload.initial_balance || 0),
        payload.color || "#2dd4bf",
        payload.notes || "",
        pocketId
      ]);
      return json(res, 200, get("SELECT * FROM finance_account_pockets WHERE id = ?", [pocketId]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM finance_account_pockets WHERE id = ?", [pocketId]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/finance/credit-cards/dashboard" && req.method === "GET") {
    return json(res, 200, creditCardSummary(user.id, query.get("month") || currentMonth()));
  }
  if (pathname === "/api/finance/credit-cards/categories" && req.method === "GET") return json(res, 200, listCreditCardCategories(user.id));
  if (pathname === "/api/finance/credit-cards/categories" && req.method === "POST") {
    const payload = await body(req);
    const name = String(payload.name || "").trim();
    if (!name) return json(res, 400, { error: "Informe o nome da categoria." });
    const result = run("INSERT OR IGNORE INTO credit_card_categories (user_id, name, color, icon, notes) VALUES (?, ?, ?, ?, ?)", [
      user.id,
      name,
      payload.color || "#2dd4bf",
      payload.icon || "",
      payload.notes || ""
    ]);
    if (result.changes === 0) return json(res, 409, { error: "Essa categoria ja existe." });
    recordTimeline("Categoria de cartao criada", name, "finance");
    return json(res, 201, get("SELECT * FROM credit_card_categories WHERE id = ?", [result.lastInsertRowid]));
  }
  const creditCardCategoryMatch = pathname.match(/^\/api\/finance\/credit-cards\/categories\/(\d+)$/);
  if (creditCardCategoryMatch) {
    const id = Number(creditCardCategoryMatch[1]);
    const category = get("SELECT * FROM credit_card_categories WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!category) return json(res, 404, { error: "Categoria nao encontrada." });
    if (req.method === "PUT") {
      const payload = await body(req);
      const name = String(payload.name || "").trim();
      if (!name) return json(res, 400, { error: "Informe o nome da categoria." });
      run("UPDATE credit_card_categories SET name = ?, color = ?, icon = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", [
        name,
        payload.color || "#2dd4bf",
        payload.icon || "",
        payload.notes || "",
        id,
        user.id
      ]);
      return json(res, 200, get("SELECT * FROM credit_card_categories WHERE id = ?", [id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM credit_card_categories WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  const creditCardCategoryDeleteMatch = pathname.match(/^\/api\/finance\/credit-cards\/categories\/(\d+)\/delete$/);
  if (creditCardCategoryDeleteMatch && req.method === "POST") {
    const id = Number(creditCardCategoryDeleteMatch[1]);
    run("DELETE FROM credit_card_categories WHERE id = ? AND user_id = ?", [id, user.id]);
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/finance/credit-cards" && req.method === "GET") {
    return json(res, 200, creditCardSummary(user.id, query.get("month") || currentMonth()).cards);
  }
  if (pathname === "/api/finance/credit-cards" && req.method === "POST") {
    const clean = normalizeCreditCardPayload(await body(req), user.id);
    if (!clean.name) return json(res, 400, { error: "Informe o nome do cartao." });
    const result = insertByFields("credit_cards", creditCardFields, clean);
    recordTimeline("Cartao de credito criado", `${clean.bank || ""} ${clean.name}`.trim(), "finance");
    return json(res, 201, get("SELECT * FROM credit_cards WHERE id = ?", [result.lastInsertRowid]));
  }
  const creditCardMatch = pathname.match(/^\/api\/finance\/credit-cards\/(\d+)$/);
  if (creditCardMatch) {
    const cardId = Number(creditCardMatch[1]);
    const card = get("SELECT * FROM credit_cards WHERE id = ? AND user_id = ?", [cardId, user.id]);
    if (!card) return json(res, 404, { error: "Cartao nao encontrado." });
    if (req.method === "PUT") {
      const clean = normalizeCreditCardPayload(await body(req), user.id);
      if (!clean.name) return json(res, 400, { error: "Informe o nome do cartao." });
      updateByFields("credit_cards", creditCardFields, cardId, clean);
      recalculateCreditCardInvoicesForCard(user.id, cardId);
      return json(res, 200, get("SELECT * FROM credit_cards WHERE id = ?", [cardId]));
    }
    if (req.method === "DELETE") {
      const total = get("SELECT COUNT(*) AS count FROM credit_card_expenses WHERE card_id = ? AND user_id = ?", [cardId, user.id]).count;
      if (total > 0) return json(res, 409, { error: "Este cartao tem gastos. Exclua os gastos antes de remover o cartao." });
      run("DELETE FROM credit_cards WHERE id = ? AND user_id = ?", [cardId, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  const creditCardDeleteMatch = pathname.match(/^\/api\/finance\/credit-cards\/(\d+)\/delete$/);
  if (creditCardDeleteMatch && req.method === "POST") {
    const cardId = Number(creditCardDeleteMatch[1]);
    const total = get("SELECT COUNT(*) AS count FROM credit_card_expenses WHERE card_id = ? AND user_id = ?", [cardId, user.id]).count;
    if (total > 0) return json(res, 409, { error: "Este cartao tem gastos. Exclua os gastos antes de remover o cartao." });
    run("DELETE FROM credit_cards WHERE id = ? AND user_id = ?", [cardId, user.id]);
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/finance/credit-cards/expenses" && req.method === "GET") {
    const where = ["credit_card_expenses.user_id = ?"];
    const values = [user.id];
    if (query.get("month")) {
      where.push(`EXISTS (
        SELECT 1 FROM credit_card_installments
        WHERE credit_card_installments.expense_id = credit_card_expenses.id
          AND credit_card_installments.billing_month = ?
      )`);
      values.push(query.get("month"));
    }
    if (query.get("card_id")) {
      where.push("credit_card_expenses.card_id = ?");
      values.push(Number(query.get("card_id")));
    }
    return json(res, 200, all(`
      SELECT credit_card_expenses.*, credit_cards.name AS card_name, credit_cards.color AS card_color
      FROM credit_card_expenses
      JOIN credit_cards ON credit_cards.id = credit_card_expenses.card_id
      WHERE ${where.join(" AND ")}
      ORDER BY credit_card_expenses.date DESC, credit_card_expenses.time DESC, credit_card_expenses.id DESC
    `, values));
  }
  if (pathname === "/api/finance/credit-cards/expenses" && req.method === "POST") {
    try {
      return json(res, 201, createCreditCardExpense(user.id, await body(req)));
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  const creditExpenseMatch = pathname.match(/^\/api\/finance\/credit-cards\/expenses\/(\d+)$/);
  if (creditExpenseMatch) {
    const expenseId = Number(creditExpenseMatch[1]);
    const current = get("SELECT * FROM credit_card_expenses WHERE id = ? AND user_id = ?", [expenseId, user.id]);
    if (!current) return json(res, 404, { error: "Gasto nao encontrado." });
    if (req.method === "PUT") {
      try {
        const clean = normalizeCreditCardExpensePayload(await body(req), user.id);
        if (!clean.card_id) clean.card_id = current.card_id;
        if (!clean.description) return json(res, 400, { error: "Informe a descricao." });
        updateByFields("credit_card_expenses", creditCardExpenseFields, expenseId, clean);
        const updated = get("SELECT * FROM credit_card_expenses WHERE id = ?", [expenseId]);
        generateCreditCardInstallments(updated);
        recalculateCreditCardInvoicesForCard(user.id, current.card_id);
        if (current.card_id !== updated.card_id) recalculateCreditCardInvoicesForCard(user.id, updated.card_id);
        return json(res, 200, updated);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === "DELETE") {
      const cardId = current.card_id;
      run("DELETE FROM credit_card_expenses WHERE id = ? AND user_id = ?", [expenseId, user.id]);
      recalculateCreditCardInvoicesForCard(user.id, cardId);
      return json(res, 200, { ok: true });
    }
  }
  const creditExpenseDeleteMatch = pathname.match(/^\/api\/finance\/credit-cards\/expenses\/(\d+)\/delete$/);
  if (creditExpenseDeleteMatch && req.method === "POST") {
    const expenseId = Number(creditExpenseDeleteMatch[1]);
    const current = get("SELECT * FROM credit_card_expenses WHERE id = ? AND user_id = ?", [expenseId, user.id]);
    if (!current) return json(res, 404, { error: "Gasto nao encontrado." });
    run("DELETE FROM credit_card_expenses WHERE id = ? AND user_id = ?", [expenseId, user.id]);
    recalculateCreditCardInvoicesForCard(user.id, current.card_id);
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/finance/credit-cards/invoices" && req.method === "GET") {
    if (query.get("card_id")) recalculateCreditCardInvoicesForCard(user.id, Number(query.get("card_id")));
    return json(res, 200, all(`
      SELECT credit_card_invoices.*, credit_cards.name AS card_name, credit_cards.color AS card_color
      FROM credit_card_invoices
      JOIN credit_cards ON credit_cards.id = credit_card_invoices.card_id
      WHERE credit_card_invoices.user_id = ?
        ${query.get("card_id") ? "AND credit_card_invoices.card_id = ?" : ""}
        ${query.get("month") ? "AND credit_card_invoices.billing_month = ?" : ""}
      ORDER BY credit_card_invoices.billing_month DESC, credit_cards.name
    `, [user.id, ...(query.get("card_id") ? [Number(query.get("card_id"))] : []), ...(query.get("month") ? [query.get("month")] : [])]));
  }
  const creditInvoicePayMatch = pathname.match(/^\/api\/finance\/credit-cards\/invoices\/(\d+)\/pay$/);
  if (creditInvoicePayMatch && req.method === "POST") {
    const invoiceId = Number(creditInvoicePayMatch[1]);
    const invoice = get("SELECT * FROM credit_card_invoices WHERE id = ? AND user_id = ?", [invoiceId, user.id]);
    if (!invoice) return json(res, 404, { error: "Fatura nao encontrada." });
    const payload = await body(req);
    const type = payload.payment_type || payload.tipo_pagamento || "Parcial";
    const amount = type === "Total" ? Number(invoice.remaining_value || invoice.total_value || 0) : roundMoney(payload.amount ?? payload.valor ?? 0);
    if (amount <= 0) return json(res, 400, { error: "Informe um valor de pagamento maior que zero." });
    run(`INSERT INTO credit_card_payments (user_id, invoice_id, card_id, payment_date, amount, payment_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      user.id,
      invoice.id,
      invoice.card_id,
      normalizeDateTime(payload.payment_date || payload.data_pagamento || currentDateTime()),
      amount,
      type,
      payload.notes || ""
    ]);
    const updated = recalculateCreditCardInvoice(user.id, invoice.card_id, invoice.billing_month);
    recordTimeline("Pagamento de fatura registrado", `${updated.card_id} - ${formatMoneyBR(amount)}`, "finance");
    return json(res, 201, updated);
  }
  const creditInvoiceRevertMatch = pathname.match(/^\/api\/finance\/credit-cards\/invoices\/(\d+)\/revert-payment$/);
  if (creditInvoiceRevertMatch && req.method === "POST") {
    const invoiceId = Number(creditInvoiceRevertMatch[1]);
    const invoice = get("SELECT * FROM credit_card_invoices WHERE id = ? AND user_id = ?", [invoiceId, user.id]);
    if (!invoice) return json(res, 404, { error: "Fatura nao encontrada." });
    const paid = get("SELECT COALESCE(SUM(amount), 0) AS total FROM credit_card_payments WHERE invoice_id = ? AND user_id = ?", [invoice.id, user.id]).total || 0;
    if (Number(paid || 0) <= 0) return json(res, 400, { error: "Essa fatura nao possui pagamento para reverter." });
    run("DELETE FROM credit_card_payments WHERE invoice_id = ? AND user_id = ?", [invoice.id, user.id]);
    const updated = recalculateCreditCardInvoice(user.id, invoice.card_id, invoice.billing_month);
    recordTimeline("Pagamento de fatura revertido", `${updated.card_id} - ${formatMoneyBR(paid)}`, "finance");
    return json(res, 200, updated);
  }
  if (pathname === "/api/finance/credit-cards/payments" && req.method === "GET") {
    return json(res, 200, all(`
      SELECT credit_card_payments.*, credit_card_invoices.billing_month, credit_cards.name AS card_name
      FROM credit_card_payments
      JOIN credit_card_invoices ON credit_card_invoices.id = credit_card_payments.invoice_id
      JOIN credit_cards ON credit_cards.id = credit_card_payments.card_id
      WHERE credit_card_payments.user_id = ?
      ORDER BY credit_card_payments.payment_date DESC, credit_card_payments.id DESC
    `, [user.id]));
  }
  if (pathname === "/api/backup" && req.method === "POST") return json(res, 201, await backup(user.id));
  if (pathname === "/api/deliveries" && req.method === "GET") return json(res, 200, listDeliveries(user.id, query));
  if (pathname === "/api/deliveries/entries" && req.method === "POST") {
    const payload = normalizeDeliveryEntryPayload(await body(req), user.id);
    const result = insertByFields("delivery_entries", deliveryEntryFields, payload);
    recordTimeline("Entrega registrada", `${payload.platform} - ${payload.trips} corrida(s) - ${formatMoneyBR(payload.earned_amount)}`, "deliveries");
    return json(res, 201, get("SELECT * FROM delivery_entries WHERE id = ? AND user_id = ?", [result.lastInsertRowid, user.id]));
  }
  const deliveryEntryMatch = pathname.match(/^\/api\/deliveries\/entries\/(\d+)$/);
  if (deliveryEntryMatch) {
    const id = Number(deliveryEntryMatch[1]);
    const current = get("SELECT * FROM delivery_entries WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!current) return json(res, 404, { error: "Lancamento de entrega nao encontrado." });
    if (req.method === "PUT") {
      const payload = normalizeDeliveryEntryPayload(await body(req), user.id);
      updateByFields("delivery_entries", deliveryEntryFields, id, payload);
      return json(res, 200, get("SELECT * FROM delivery_entries WHERE id = ? AND user_id = ?", [id, user.id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM delivery_entries WHERE id = ? AND user_id = ?", [id, user.id]);
      recordTimeline("Entrega excluida", `${current.platform} - ${formatMoneyBR(current.earned_amount)}`, "deliveries");
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/deliveries/withdrawals" && req.method === "POST") {
    const payload = normalizeDeliveryWithdrawalPayload(await body(req), user.id);
    const result = insertByFields("delivery_withdrawals", deliveryWithdrawalFields, payload);
    recordTimeline("Saque de entregas registrado", `${payload.platform} - ${formatMoneyBR(payload.amount)}`, "deliveries");
    return json(res, 201, get("SELECT * FROM delivery_withdrawals WHERE id = ? AND user_id = ?", [result.lastInsertRowid, user.id]));
  }
  const deliveryWithdrawalMatch = pathname.match(/^\/api\/deliveries\/withdrawals\/(\d+)$/);
  if (deliveryWithdrawalMatch) {
    const id = Number(deliveryWithdrawalMatch[1]);
    const current = get("SELECT * FROM delivery_withdrawals WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!current) return json(res, 404, { error: "Saque nao encontrado." });
    if (req.method === "PUT") {
      const payload = normalizeDeliveryWithdrawalPayload(await body(req), user.id);
      updateByFields("delivery_withdrawals", deliveryWithdrawalFields, id, payload);
      return json(res, 200, get("SELECT * FROM delivery_withdrawals WHERE id = ? AND user_id = ?", [id, user.id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM delivery_withdrawals WHERE id = ? AND user_id = ?", [id, user.id]);
      recordTimeline("Saque de entregas excluido", `${current.platform} - ${formatMoneyBR(current.amount)}`, "deliveries");
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/deliveries/goals" && req.method === "POST") {
    const payload = normalizeDeliveryGoalPayload(await body(req), user.id);
    run(`
      INSERT INTO delivery_goals (user_id, month, platform, daily_goal, weekly_goal, monthly_goal, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, month, platform) DO UPDATE SET
        daily_goal = excluded.daily_goal,
        weekly_goal = excluded.weekly_goal,
        monthly_goal = excluded.monthly_goal,
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `, [payload.user_id, payload.month, payload.platform, payload.daily_goal, payload.weekly_goal, payload.monthly_goal, payload.notes]);
    recordTimeline("Meta de entregas salva", `${payload.platform} - ${payload.month}`, "deliveries");
    return json(res, 200, get("SELECT * FROM delivery_goals WHERE user_id = ? AND month = ? AND platform = ?", [user.id, payload.month, payload.platform]));
  }
  const deliveryGoalMatch = pathname.match(/^\/api\/deliveries\/goals\/(\d+)$/);
  if (deliveryGoalMatch) {
    const id = Number(deliveryGoalMatch[1]);
    const current = get("SELECT * FROM delivery_goals WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!current) return json(res, 404, { error: "Meta nao encontrada." });
    if (req.method === "DELETE") {
      run("DELETE FROM delivery_goals WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/bets/dashboard" && req.method === "GET") return json(res, 200, bettingDashboard());
  if (pathname === "/api/bets/analyses" && req.method === "GET") return json(res, 200, bettingAnalyses());
  if (pathname === "/api/bets/options" && req.method === "GET") return json(res, 200, {
    houses: listBettingHouses(),
    sports: defaultSports,
    bonusTypes: defaultBonusTypes
  });
  if (pathname === "/api/betting-houses" && req.method === "GET") return json(res, 200, listBettingHouses());
  if (pathname === "/api/betting-houses" && req.method === "POST") {
    const payload = await body(req);
    payload.initial_balance = Number(payload.initial_balance || 0);
    payload.monthly_goal = Number(payload.monthly_goal || 0);
    payload.monthly_loss_limit = Number(payload.monthly_loss_limit || 0);
    const result = insertByFields("betting_houses", bettingHouseFields, payload);
    recordTimeline("Casa de aposta cadastrada", payload.name || "", "bets");
    return json(res, 201, get("SELECT * FROM betting_houses WHERE id = ?", [result.lastInsertRowid]));
  }
  const houseMatch = pathname.match(/^\/api\/betting-houses\/(\d+)$/);
  if (houseMatch) {
    const id = Number(houseMatch[1]);
    if (req.method === "PUT") {
      const payload = await body(req);
      payload.initial_balance = Number(payload.initial_balance || 0);
      payload.monthly_goal = Number(payload.monthly_goal || 0);
      payload.monthly_loss_limit = Number(payload.monthly_loss_limit || 0);
      updateByFields("betting_houses", bettingHouseFields, id, payload);
      return json(res, 200, get("SELECT * FROM betting_houses WHERE id = ?", [id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM betting_houses WHERE id = ?", [id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/bets/bonuses" && req.method === "GET") return json(res, 200, all("SELECT * FROM betting_bonuses ORDER BY date DESC, id DESC"));
  if (pathname === "/api/bets/bonuses" && req.method === "POST") {
    const payload = prepareBonusPayload(await body(req));
    upsertBettingHouseName(payload.betting_house);
    const result = insertByFields("betting_bonuses", bettingBonusFields, payload);
    recordTimeline("Bonus ou freebet registrado", payload.description || payload.type || "", "bets");
    return json(res, 201, get("SELECT * FROM betting_bonuses WHERE id = ?", [result.lastInsertRowid]));
  }
  const bonusMatch = pathname.match(/^\/api\/bets\/bonuses\/(\d+)$/);
  if (bonusMatch) {
    const id = Number(bonusMatch[1]);
    if (req.method === "PUT") {
      const payload = prepareBonusPayload(await body(req));
      upsertBettingHouseName(payload.betting_house);
      updateByFields("betting_bonuses", bettingBonusFields, id, payload);
      return json(res, 200, get("SELECT * FROM betting_bonuses WHERE id = ?", [id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM betting_bonuses WHERE id = ?", [id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/bets/movements" && req.method === "GET") return json(res, 200, all("SELECT * FROM betting_movements ORDER BY date DESC, id DESC"));
  if (pathname === "/api/bets/movements" && req.method === "POST") {
    const payload = prepareMovementPayload(await body(req));
    upsertBettingHouseName(payload.betting_house);
    const result = insertByFields("betting_movements", bettingMovementFields, payload);
    recordTimeline("Movimentacao de banca registrada", `${payload.type || ""} ${payload.betting_house || ""}`, "bets");
    return json(res, 201, get("SELECT * FROM betting_movements WHERE id = ?", [result.lastInsertRowid]));
  }
  const movementMatch = pathname.match(/^\/api\/bets\/movements\/(\d+)$/);
  if (movementMatch) {
    const id = Number(movementMatch[1]);
    if (req.method === "PUT") {
      const payload = prepareMovementPayload(await body(req));
      upsertBettingHouseName(payload.betting_house);
      updateByFields("betting_movements", bettingMovementFields, id, payload);
      return json(res, 200, get("SELECT * FROM betting_movements WHERE id = ?", [id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM betting_movements WHERE id = ?", [id]);
      return json(res, 200, { ok: true });
    }
  }
  const betCashoutMatch = pathname.match(/^\/api\/bets\/(\d+)\/cashout$/);
  if (betCashoutMatch && req.method === "POST") {
    try {
      return json(res, 200, cashOutBet(Number(betCashoutMatch[1]), await body(req)));
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || "Nao foi possivel realizar o Cash Out." });
    }
  }
  const betCashoutRevertMatch = pathname.match(/^\/api\/bets\/(\d+)\/cashout\/revert$/);
  if (betCashoutRevertMatch && req.method === "POST") {
    try {
      return json(res, 200, revertCashOutBet(Number(betCashoutRevertMatch[1])));
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || "Nao foi possivel reverter o Cash Out." });
    }
  }
  const betDeleteMatch = pathname.match(/^\/api\/bets\/(\d+)\/delete$/);
  if (betDeleteMatch && req.method === "POST") {
    const id = Number(betDeleteMatch[1]);
    const record = get("SELECT id, betting_house, event FROM bets WHERE id = ?", [id]);
    if (!record) return json(res, 404, { error: "Aposta nao encontrada." });
    run("DELETE FROM bets WHERE id = ?", [id]);
    recordTimeline("Aposta excluida", `${record.betting_house || "Casa"} - ${record.event || `#${id}`}`, "bets");
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/planning" && req.method === "GET") return json(res, 200, listPlanning(query));
  if (pathname === "/api/planning" && req.method === "POST") {
    const payload = await body(req);
    const record = insertPlanningItem(payload);
    recordTimeline("Compromisso financeiro criado", `${payload.person || ""} - ${payload.title || ""}`, "planning");
    createNotification({
      userId: user.id,
      title: "Compromisso financeiro criado",
      message: `${record.title || "Novo compromisso"}${record.due_date ? ` vence em ${formatBRDateTimeServer(`${record.due_date} 00:00:00`).slice(0, 10)}` : ""}.`,
      category: "FINANCE",
      severity: "INFO",
      sourceModule: "Meu mes",
      sourceEntityType: "planning_item",
      sourceEntityId: record.id,
      actionUrl: "#planning",
      primaryActionLabel: "Ver compromisso",
      dedupeKey: `planning:${record.id}:created`
    });
    return json(res, 201, record);
  }
  if (pathname === "/api/planning/categories" && req.method === "GET") return json(res, 200, listPlanningCategories());
  if (pathname === "/api/planning/people" && req.method === "GET") return json(res, 200, listPlanningPeople());
  if (pathname === "/api/planning/categories" && req.method === "POST") {
    const payload = await body(req);
    const name = payload.name?.trim();
    if (!name) return json(res, 400, { error: "Informe o nome da categoria" });
    const result = run("INSERT OR IGNORE INTO planning_categories (name, color, icon, notes) VALUES (?, ?, ?, ?)", [name, payload.color || "#2dd4bf", payload.icon || "", payload.notes || ""]);
    if (result.changes === 0) {
      return json(res, 409, { error: "Essa categoria ja existe" });
    }
    recordTimeline("Categoria de planejamento criada", name, "planning");
    return json(res, 201, get("SELECT * FROM planning_categories WHERE id = ?", [result.lastInsertRowid]));
  }
  const planningCategoryMatch = pathname.match(/^\/api\/planning\/categories\/(\d+)$/);
  if (planningCategoryMatch) {
    const id = Number(planningCategoryMatch[1]);
    if (req.method === "PUT") {
      const payload = await body(req);
      const name = payload.name?.trim();
      if (!name) return json(res, 400, { error: "Informe o nome da categoria" });
      run("UPDATE planning_categories SET name = ?, color = ?, icon = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [name, payload.color || "#2dd4bf", payload.icon || "", payload.notes || "", id]);
      return json(res, 200, get("SELECT * FROM planning_categories WHERE id = ?", [id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM planning_categories WHERE id = ?", [id]);
      return json(res, 200, { ok: true });
    }
  }
  const planningMatch = pathname.match(/^\/api\/planning\/(\d+)$/);
  if (planningMatch) {
    const id = Number(planningMatch[1]);
    if (req.method === "PUT") {
      const payload = normalizePlanningPayload(await body(req), get("SELECT * FROM planning_items WHERE id = ?", [id]) || {});
      updateByFields("planning_items", planningFields, id, payload);
      if (Number(payload.recurring || 0) === 1 || Number(payload.installment_total || 1) > 1) {
        generatePlanningFutureItems(get("SELECT * FROM planning_items WHERE id = ?", [id]));
      }
      return json(res, 200, get("SELECT * FROM planning_items WHERE id = ?", [id]));
    }
    if (req.method === "DELETE") {
      run("DELETE FROM planning_items WHERE id = ?", [id]);
      return json(res, 200, { ok: true });
    }
  }
  const planningActionMatch = pathname.match(/^\/api\/planning\/(\d+)\/(partial|postpone|duplicate|recurring|split)$/);
  if (planningActionMatch && req.method === "POST") {
    const id = Number(planningActionMatch[1]);
    const action = planningActionMatch[2];
    const record = get("SELECT * FROM planning_items WHERE id = ?", [id]);
    if (!record) return json(res, 404, { error: "Compromisso nao encontrado" });
    const payload = await body(req);
    if (action === "partial") {
      const amount = Math.max(0, Number(payload.amount_paid || payload.paid_amount || 0));
      const paidAmount = Math.min(Number(record.amount || 0), Number(record.paid_amount || 0) + amount);
      const status = paidAmount >= Number(record.amount || 0) ? "paid" : "partial";
      const paymentDate = payload.payment_date || todayDate();
      run("INSERT INTO planning_partial_payments (planning_item_id, amount_paid, payment_date, notes) VALUES (?, ?, ?, ?)", [id, amount, paymentDate, payload.notes || ""]);
      run("UPDATE planning_items SET status = ?, paid_amount = ?, paid_date = ?, updated_at = ? WHERE id = ?", [status, paidAmount, status === "paid" ? paymentDate : "", currentDateTime(), id]);
      const updatedPlanning = get("SELECT * FROM planning_items WHERE id = ?", [id]);
      createNotification({
        userId: user.id,
        title: status === "paid" ? "Conta marcada como paga" : "Pagamento parcial registrado",
        message: `${updatedPlanning.title || "Compromisso"} recebeu ${formatMoneyBR(amount)}. Total pago: ${formatMoneyBR(paidAmount)}.`,
        category: "FINANCE",
        severity: "SUCCESS",
        sourceModule: "Meu mes",
        sourceEntityType: "planning_item",
        sourceEntityId: id,
        actionUrl: "#planning",
        primaryActionLabel: "Ver meu mes",
        dedupeKey: `planning:${id}:payment:${paymentDate}:${paidAmount}`
      });
      return json(res, 200, updatedPlanning);
    }
    if (action === "postpone") {
      const due = payload.due_date || addDays(record.due_date || todayDate(), Number(payload.days || 7));
      run("UPDATE planning_items SET due_date = ?, month = ?, updated_at = ? WHERE id = ?", [due, monthKeyFromDueDate(due, record.month), currentDateTime(), id]);
      return json(res, 200, get("SELECT * FROM planning_items WHERE id = ?", [id]));
    }
    if (action === "duplicate") {
      return json(res, 201, duplicatePlanningToNextMonth(record));
    }
    if (action === "recurring") {
      const recurrenceType = payload.recurrence_type || record.recurrence_type || "monthly";
      run("UPDATE planning_items SET recurring = 1, recurrence_type = ?, updated_at = ? WHERE id = ?", [recurrenceType, currentDateTime(), id]);
      const updated = get("SELECT * FROM planning_items WHERE id = ?", [id]);
      generatePlanningFutureItems(updated);
      return json(res, 200, updated);
    }
    if (action === "split") {
      const splits = Array.isArray(payload.splits) ? payload.splits : [];
      if (!splits.length) return json(res, 400, { error: "Informe as divisoes" });
      run("DELETE FROM planning_items WHERE parent_item_id = ? AND title LIKE ?", [id, `${record.title} - %`]);
      for (const split of splits) {
        insertPlanningItem({
          ...record,
          id: undefined,
          person: split.person || record.person,
          title: `${record.title} - ${split.person || record.person}`,
          amount: Number(split.amount || 0),
          status: "pending",
          paid_amount: 0,
          paid_date: "",
          split_details: JSON.stringify(splits),
          parent_item_id: id
        });
      }
      run("UPDATE planning_items SET status = 'canceled', split_details = ?, updated_at = ? WHERE id = ?", [JSON.stringify(splits), currentDateTime(), id]);
      return json(res, 200, { ok: true, splits });
    }
  }

  const noteAttachmentsMatch = pathname.match(/^\/api\/notes\/(\d+)\/attachments(?:\/(\d+))?$/);
  if (noteAttachmentsMatch) {
    const noteId = Number(noteAttachmentsMatch[1]);
    const attachmentId = noteAttachmentsMatch[2] ? Number(noteAttachmentsMatch[2]) : null;
    if (!get("SELECT id FROM notes WHERE id = ?", [noteId])) return json(res, 404, { error: "Anotacao nao encontrada" });
    if (req.method === "GET") {
      return json(res, 200, all("SELECT id, note_id, name, mime_type, size, created_at FROM note_attachments WHERE note_id = ? ORDER BY id DESC", [noteId]));
    }
    if (req.method === "POST" && !attachmentId) {
      const payload = await body(req);
      if (!payload.name || !payload.data) return json(res, 400, { error: "Arquivo invalido" });
      const result = run("INSERT INTO note_attachments (note_id, name, mime_type, size, data) VALUES (?, ?, ?, ?, ?)", [
        noteId,
        payload.name,
        payload.mime_type || "application/octet-stream",
        Number(payload.size || 0),
        payload.data
      ]);
      return json(res, 201, get("SELECT id, note_id, name, mime_type, size, created_at FROM note_attachments WHERE id = ?", [result.lastInsertRowid]));
    }
    if (req.method === "DELETE" && attachmentId) {
      run("DELETE FROM note_attachments WHERE id = ? AND note_id = ?", [attachmentId, noteId]);
      return json(res, 200, { ok: true });
    }
  }
  const noteAttachmentDownloadMatch = pathname.match(/^\/api\/notes\/(\d+)\/attachments\/(\d+)\/download$/);
  if (noteAttachmentDownloadMatch && req.method === "GET") {
    const attachment = get("SELECT * FROM note_attachments WHERE id = ? AND note_id = ?", [Number(noteAttachmentDownloadMatch[2]), Number(noteAttachmentDownloadMatch[1])]);
    if (!attachment) return json(res, 404, { error: "Anexo nao encontrado" });
    return json(res, 200, attachment);
  }

  if (pathname === "/api/music/audio-upload" && req.method === "POST") {
    try {
      return json(res, 201, await saveMusicAudio(await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/music/radio-stream" && req.method === "GET") {
    try {
      return proxyRadioStream(query.get("url"), req, res);
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const musicAudioMatch = pathname.match(/^\/api\/music\/audio\/([^/]+)$/);
  if (musicAudioMatch && req.method === "GET") {
    const fileName = path.basename(decodeURIComponent(musicAudioMatch[1]));
    const filePath = path.resolve(musicUploadsDir, fileName);
    const relativePath = path.relative(musicUploadsDir, filePath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath) || !existsSync(filePath)) return json(res, 404, { error: "Audio nao encontrado." });
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": musicAudioMime(fileName),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    });
    return res.end(content);
  }

  if (pathname === "/api/music/playlists" && req.method === "GET") return json(res, 200, musicPlaylistList());
  if (pathname === "/api/music/playlists" && req.method === "POST") {
    try {
      return json(res, 201, createMusicPlaylist(await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const musicPlaylistMatch = pathname.match(/^\/api\/music\/playlists\/(\d+)$/);
  if (musicPlaylistMatch) {
    const playlistId = Number(musicPlaylistMatch[1]);
    try {
      if (req.method === "GET") {
        const detail = musicPlaylistDetail(playlistId);
        if (!detail) return json(res, 404, { error: "Playlist nao encontrada." });
        return json(res, 200, detail);
      }
      if (req.method === "PUT") return json(res, 200, updateMusicPlaylist(playlistId, await body(req)));
      if (req.method === "DELETE") return json(res, 200, deleteMusicPlaylist(playlistId));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const musicPlaylistSongsMatch = pathname.match(/^\/api\/music\/playlists\/(\d+)\/musicas$/);
  if (musicPlaylistSongsMatch && req.method === "POST") {
    try {
      return json(res, 201, addMusicToPlaylist(Number(musicPlaylistSongsMatch[1]), await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const musicPlaylistReorderMatch = pathname.match(/^\/api\/music\/playlists\/(\d+)\/reorder$/);
  if (musicPlaylistReorderMatch && req.method === "POST") {
    try {
      const payload = await body(req);
      return json(res, 200, reorderPlaylistMusic(Number(musicPlaylistReorderMatch[1]), payload.ids || []));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const musicSongMatch = pathname.match(/^\/api\/music\/musicas\/(\d+)$/);
  if (musicSongMatch) {
    const musicId = Number(musicSongMatch[1]);
    try {
      if (req.method === "PUT") return json(res, 200, updatePlaylistMusic(musicId, await body(req)));
      if (req.method === "DELETE") return json(res, 200, deletePlaylistMusic(musicId));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/vendinha" && req.method === "GET") return json(res, 200, vendinhaList(user.id, query));
  if (pathname === "/api/vendinha/establishments" && req.method === "POST") {
    try {
      return json(res, 201, upsertVendinhaSimple(user.id, "vendinha_establishments", ["name", "notes", "status"], await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const vendinhaStoreMatch = pathname.match(/^\/api\/vendinha\/establishments\/(\d+)$/);
  if (vendinhaStoreMatch) {
    const id = Number(vendinhaStoreMatch[1]);
    try {
      if (req.method === "PUT") return json(res, 200, upsertVendinhaSimple(user.id, "vendinha_establishments", ["name", "notes", "status"], await body(req), id));
      if (req.method === "DELETE") {
        run("DELETE FROM vendinha_establishments WHERE id = ? AND user_id = ?", [id, user.id]);
        return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/vendinha/products" && req.method === "POST") {
    try {
      return json(res, 201, upsertVendinhaSimple(user.id, "vendinha_products", ["name", "default_value", "category", "status"], await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const vendinhaProductMatch = pathname.match(/^\/api\/vendinha\/products\/(\d+)$/);
  if (vendinhaProductMatch) {
    const id = Number(vendinhaProductMatch[1]);
    try {
      if (req.method === "PUT") return json(res, 200, upsertVendinhaSimple(user.id, "vendinha_products", ["name", "default_value", "category", "status"], await body(req), id));
      if (req.method === "DELETE") {
        run("DELETE FROM vendinha_products WHERE id = ? AND user_id = ?", [id, user.id]);
        return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/vendinha/consumptions" && req.method === "POST") {
    try {
      return json(res, 201, createVendinhaConsumption(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const vendinhaConsumptionMatch = pathname.match(/^\/api\/vendinha\/consumptions\/(\d+)(?:\/(duplicate|delete))?$/);
  if (vendinhaConsumptionMatch) {
    const id = Number(vendinhaConsumptionMatch[1]);
    const action = vendinhaConsumptionMatch[2] || "";
    try {
      if (action === "duplicate" && req.method === "POST") {
        const current = get("SELECT * FROM vendinha_consumptions WHERE id = ? AND user_id = ?", [id, user.id]);
        if (!current) return json(res, 404, { error: "Lancamento nao encontrado." });
        return json(res, 201, createVendinhaConsumption(user.id, { ...current, date: currentDateTime().slice(0, 10), status: "open", payment_date: "", force_paid_month: true }));
      }
      if (action === "delete" && req.method === "POST") return json(res, 200, deleteVendinhaConsumption(user.id, id, await body(req)));
      if (req.method === "PUT") return json(res, 200, updateVendinhaConsumption(user.id, id, await body(req)));
      if (req.method === "DELETE") return json(res, 200, deleteVendinhaConsumption(user.id, id));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/vendinha/close-month" && req.method === "POST") {
    try {
      return json(res, 200, closeVendinhaMonth(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/vendinha/reopen-month" && req.method === "POST") {
    try {
      return json(res, 200, reopenVendinhaMonth(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/vendinha/limit" && req.method === "PUT") {
    try {
      return json(res, 200, saveVendinhaLimit(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/codex-manager" && req.method === "GET") {
    try {
      return json(res, 200, codexList(user.id, query));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/codex-manager" && req.method === "POST") {
    try {
      return json(res, 201, createCodexAccount(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const codexAccountMatch = pathname.match(/^\/api\/codex-manager\/(\d+)(?:\/(use-now|available|quick-note))?$/);
  if (codexAccountMatch) {
    const id = Number(codexAccountMatch[1]);
    const action = codexAccountMatch[2] || "";
    try {
      if (!action && req.method === "GET") return json(res, 200, codexDetail(user.id, id));
      if (!action && req.method === "PUT") return json(res, 200, updateCodexAccount(user.id, id, await body(req)));
      if (!action && req.method === "DELETE") return json(res, 200, deleteCodexAccount(user.id, id));
      if (action === "use-now" && req.method === "POST") return json(res, 200, useCodexAccountNow(user.id, id));
      if (action === "available" && req.method === "POST") return json(res, 200, markCodexAccountAvailable(user.id, id));
      if (action === "quick-note" && req.method === "POST") return json(res, 200, quickNoteCodexAccount(user.id, id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/drso-ai/conversations" && req.method === "GET") {
    try {
      return json(res, 200, aiConversations(user.id));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const aiConversationMatch = pathname.match(/^\/api\/drso-ai\/conversations\/(\d+)$/);
  if (aiConversationMatch) {
    const id = Number(aiConversationMatch[1]);
    try {
      if (req.method === "GET") return json(res, 200, aiConversationDetail(user.id, id));
      if (req.method === "PUT") {
        const payload = await body(req);
        run("UPDATE ai_conversations SET title = ?, favorite = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
          String(payload.title || "Nova conversa").trim() || "Nova conversa",
          Number(payload.favorite || 0) ? 1 : 0,
          currentDateTime(),
          id,
          user.id
        ]);
        return json(res, 200, aiConversationDetail(user.id, id));
      }
      if (req.method === "DELETE") {
        run("DELETE FROM ai_conversations WHERE id = ? AND user_id = ?", [id, user.id]);
        return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/chat" && req.method === "POST") {
    try {
      return json(res, 200, await aiChat(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/confirm-action" && req.method === "POST") {
    try {
      return json(res, 200, aiConfirmAction(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/insights" && req.method === "GET") {
    try {
      return json(res, 200, aiInsights(user.id));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/config" && req.method === "GET") {
    try {
      return json(res, 200, await aiPublicConfig());
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/config" && req.method === "PUT") {
    try {
      return json(res, 200, await aiSaveOpenAiSettings(await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/memories" && req.method === "GET") {
    try {
      aiSeedMemories(user.id);
      return json(res, 200, aiMemories(user.id));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/drso-ai/memories" && req.method === "POST") {
    try {
      return json(res, 201, aiUpsertMemory(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const aiMemoryMatch = pathname.match(/^\/api\/drso-ai\/memories\/(\d+)$/);
  if (aiMemoryMatch && req.method === "DELETE") {
    run("DELETE FROM ai_memories WHERE id = ? AND user_id = ?", [Number(aiMemoryMatch[1]), user.id]);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/subscriptions" && req.method === "GET") {
    try {
      return json(res, 200, subscriptionList(user.id, query));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/subscriptions" && req.method === "POST") {
    try {
      return json(res, 201, createSubscription(user.id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  const subscriptionMatch = pathname.match(/^\/api\/subscriptions\/(\d+)(?:\/(pay|pause|cancel|adjustments))?$/);
  if (subscriptionMatch) {
    const id = Number(subscriptionMatch[1]);
    const action = subscriptionMatch[2] || "";
    try {
      if (!action && req.method === "GET") return json(res, 200, subscriptionDetail(user.id, id));
      if (!action && req.method === "PUT") return json(res, 200, updateSubscription(user.id, id, await body(req)));
      if (!action && req.method === "DELETE") return json(res, 200, deleteSubscription(user.id, id));
      if (action === "pay" && req.method === "POST") return json(res, 200, markSubscriptionPaid(user.id, id, await body(req)));
      if (action === "pause" && req.method === "POST") return json(res, 200, pauseSubscription(user.id, id));
      if (action === "cancel" && req.method === "POST") return json(res, 200, cancelSubscription(user.id, id, await body(req)));
      if (action === "adjustments" && req.method === "POST") return json(res, 201, createSubscriptionAdjustment(user.id, id, await body(req)));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }

  if (pathname === "/api/wishlist" && req.method === "GET") return json(res, 200, wishlistOverview(user.id, query));
  if (pathname === "/api/wishlist/metadata" && req.method === "POST") {
    try {
      return json(res, 200, await wishlistFetchMetadata((await body(req)).url));
    } catch (error) {
      return json(res, Number(error.statusCode || 400), { error: error.message });
    }
  }
  if (pathname === "/api/wishlist/folders" && req.method === "POST") {
    const payload = wishlistNormalizeFolder(await body(req), user.id);
    const result = insertByFields("wishlist_pastas", wishlistFolderFields, payload);
    recordTimeline("Pasta da wishlist criada", payload.nome, "wishlist");
    return json(res, 201, get("SELECT * FROM wishlist_pastas WHERE id = ? AND user_id = ?", [result.lastInsertRowid, user.id]));
  }
  const wishlistFolderMatch = pathname.match(/^\/api\/wishlist\/folders\/(\d+)$/);
  if (wishlistFolderMatch) {
    const id = Number(wishlistFolderMatch[1]);
    const folder = get("SELECT * FROM wishlist_pastas WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!folder) return json(res, 404, { error: "Pasta nao encontrada." });
    if (req.method === "PUT") {
      const payload = wishlistNormalizeFolder(await body(req), user.id);
      run("UPDATE wishlist_pastas SET nome = ?, descricao = ?, icone = ?, cor = ?, pasta_pai_id = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", [payload.nome, payload.descricao, payload.icone, payload.cor, payload.pasta_pai_id, id, user.id]);
      return json(res, 200, get("SELECT * FROM wishlist_pastas WHERE id = ? AND user_id = ?", [id, user.id]));
    }
    if (req.method === "DELETE") {
      run("UPDATE wishlist_pastas SET pasta_pai_id = ? WHERE pasta_pai_id = ? AND user_id = ?", [folder.pasta_pai_id || null, id, user.id]);
      run("UPDATE produtos_wishlist SET pasta_id = ? WHERE pasta_id = ? AND user_id = ?", [folder.pasta_pai_id || null, id, user.id]);
      run("DELETE FROM wishlist_pastas WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/wishlist/products" && req.method === "POST") {
    const incoming = await body(req);
    let metadata = {};
    if (incoming.link_original || incoming.url) metadata = await wishlistFetchMetadata(incoming.link_original || incoming.url);
    const payload = wishlistNormalizeProduct({ ...metadata, ...incoming, observacoes: incoming.observacoes || metadata.descricao || "" }, user.id);
    if ((incoming.link_original || incoming.url) && !payload.link_original) return json(res, 400, { error: "Link invalido. Use http:// ou https://." });
    const result = insertByFields("produtos_wishlist", wishlistProductFields, payload);
    if (payload.preco_atual > 0) {
      run("INSERT INTO historico_precos_wishlist (user_id, produto_id, preco_antigo, preco_novo, loja, criado_em) VALUES (?, ?, 0, ?, ?, ?)", [user.id, result.lastInsertRowid, payload.preco_atual, payload.loja || "", currentDateTime()]);
    }
    recordTimeline("Produto adicionado na wishlist", payload.nome, "wishlist");
    return json(res, 201, wishlistProductPublic(get("SELECT * FROM produtos_wishlist WHERE id = ? AND user_id = ?", [result.lastInsertRowid, user.id])));
  }
  const wishlistProductMatch = pathname.match(/^\/api\/wishlist\/products\/(\d+)(?:\/(refresh|bought|history))?$/);
  if (wishlistProductMatch) {
    const id = Number(wishlistProductMatch[1]);
    const action = wishlistProductMatch[2] || "";
    const product = get("SELECT * FROM produtos_wishlist WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!product) return json(res, 404, { error: "Produto nao encontrado." });
    if (action === "history" && req.method === "GET") return json(res, 200, wishlistHistory(user.id, id));
    if (action === "refresh" && req.method === "POST") return json(res, 200, await wishlistRefreshProductPrice(user.id, product));
    if (action === "bought" && req.method === "POST") {
      const nextStatus = product.comprado ? "Quero comprar" : "Comprado";
      run("UPDATE produtos_wishlist SET comprado = ?, status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", [product.comprado ? 0 : 1, nextStatus, id, user.id]);
      return json(res, 200, wishlistProductPublic(get("SELECT * FROM produtos_wishlist WHERE id = ? AND user_id = ?", [id, user.id])));
    }
    if (!action && req.method === "PUT") {
      const incoming = await body(req);
      const payload = wishlistNormalizeProduct(incoming, user.id);
      if (payload.link_original === "" && incoming.link_original) return json(res, 400, { error: "Link invalido. Use http:// ou https://." });
      const oldPrice = Number(product.preco_atual || 0);
      run(`UPDATE produtos_wishlist
        SET pasta_id = ?, nome = ?, link_original = ?, imagem_url = ?, preco_atual = ?, preco_desejado = ?, loja = ?, categoria = ?, prioridade = ?, status = ?, observacoes = ?, comprado = ?, ultima_atualizacao_preco = ?, atualizado_em = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`, [payload.pasta_id, payload.nome, payload.link_original, payload.imagem_url, payload.preco_atual, payload.preco_desejado, payload.loja, payload.categoria, payload.prioridade, payload.status, payload.observacoes, payload.comprado, payload.ultima_atualizacao_preco, id, user.id]);
      if (payload.preco_atual !== oldPrice) run("INSERT INTO historico_precos_wishlist (user_id, produto_id, preco_antigo, preco_novo, loja, criado_em) VALUES (?, ?, ?, ?, ?, ?)", [user.id, id, oldPrice, payload.preco_atual, payload.loja || product.loja || "", currentDateTime()]);
      return json(res, 200, wishlistProductPublic(get("SELECT * FROM produtos_wishlist WHERE id = ? AND user_id = ?", [id, user.id])));
    }
    if (!action && req.method === "DELETE") {
      run("DELETE FROM produtos_wishlist WHERE id = ? AND user_id = ?", [id, user.id]);
      return json(res, 200, { ok: true });
    }
  }
  if (pathname === "/api/wishlist/refresh-folder" && req.method === "POST") {
    const payload = await body(req);
    const folderId = payload.pasta_id ? Number(payload.pasta_id) : null;
    const rows = all(`SELECT * FROM produtos_wishlist WHERE user_id = ? ${folderId ? "AND pasta_id = ?" : "AND pasta_id IS NULL"}`, folderId ? [user.id, folderId] : [user.id]);
    const refreshed = [];
    for (const product of rows) refreshed.push(await wishlistRefreshProductPrice(user.id, product));
    return json(res, 200, { ok: true, refreshed });
  }

  const resourceMatch = pathname.match(/^\/api\/(finance|bets|documents|projects|notes|timeline)(?:\/(\d+))?$/);
  if (resourceMatch) {
    const [, resource, id] = resourceMatch;
    if (req.method === "GET") return json(res, 200, id ? get(`SELECT * FROM ${tables[resource]} WHERE id = ?`, [id]) : listResource(resource, query));
    if (req.method === "POST") return json(res, 201, createResource(resource, await body(req)));
    if (req.method === "PUT" && id) return json(res, 200, updateResource(resource, Number(id), await body(req)));
    if (req.method === "DELETE" && id) return json(res, 200, deleteResource(resource, Number(id)));
  }

  if (pathname === "/api/modules" && req.method === "GET") return json(res, 200, modules());
  if (pathname === "/api/modules" && req.method === "POST") {
    const payload = await body(req);
    const result = run("INSERT INTO custom_modules (name, description) VALUES (?, ?)", [payload.name, payload.description || ""]);
    for (const [index, field] of (payload.fields || []).entries()) {
      run("INSERT INTO custom_module_fields (module_id, name, type, required, sort_order) VALUES (?, ?, ?, ?, ?)", [result.lastInsertRowid, field.name, field.type || "text", field.required ? 1 : 0, index]);
    }
    recordTimeline("Modulo personalizado criado", payload.name, "modules");
    return json(res, 201, modules().find((item) => item.id === result.lastInsertRowid));
  }
  const moduleRecordMatch = pathname.match(/^\/api\/modules\/(\d+)\/records(?:\/(\d+))?$/);
  if (moduleRecordMatch) {
    const [, moduleId, recordId] = moduleRecordMatch.map(Number);
    if (req.method === "POST") {
      const payload = await body(req);
      const result = run("INSERT INTO custom_module_records (module_id, data) VALUES (?, ?)", [moduleId, JSON.stringify(payload.data || {})]);
      return json(res, 201, get("SELECT * FROM custom_module_records WHERE id = ?", [result.lastInsertRowid]));
    }
    if (req.method === "DELETE" && recordId) {
      run("DELETE FROM custom_module_records WHERE id = ?", [recordId]);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Rota nao encontrada" });
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const staticFileCache = new Map();

function staticCacheHeader(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".html", ".css", ".js"].includes(ext)) return "no-store";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2"].includes(ext)) {
    return "public, max-age=604800, stale-while-revalidate=86400";
  }
  return "public, max-age=3600";
}

function shouldGzipStatic(req, filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  if (![".html", ".css", ".js", ".json", ".svg"].includes(ext)) return false;
  if (content.length < 1024) return false;
  return String(req.headers["accept-encoding"] || "").includes("gzip");
}

async function readStaticFile(filePath) {
  const fileStat = await stat(filePath);
  const cacheKey = `${filePath}:${fileStat.mtimeMs}:${fileStat.size}`;
  const cached = staticFileCache.get(cacheKey);
  if (cached) return cached;
  const content = await readFile(filePath);
  const entry = { content, gzip: null };
  staticFileCache.clear();
  staticFileCache.set(cacheKey, entry);
  return entry;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname, url.searchParams);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.normalize(path.join(publicDir, requested));
    if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "Acesso negado" });
    const finalPath = existsSync(filePath) ? filePath : path.join(publicDir, "index.html");
    const cachedFile = await readStaticFile(finalPath);
    const content = cachedFile.content;
    const headers = {
      "Content-Type": mime[path.extname(finalPath)] || "application/octet-stream",
      "Cache-Control": staticCacheHeader(finalPath)
    };
    if (shouldGzipStatic(req, finalPath, content)) {
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
      res.writeHead(200, headers);
      cachedFile.gzip ||= gzipSync(content);
      return res.end(cachedFile.gzip);
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch (error) {
    json(res, Number(error.statusCode || 500), { error: error.message });
  }
});

if (runtimeProcess?.argv?.[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, () => {
    console.log(`DRSOSystem rodando em http://localhost:${port}`);
    console.log(`Banco local: ${dbPath}`);
    console.log(`[Storage] Caminho permanente: ${dataRootDir}`);
    console.log(`[Galeria] Caminho base configurado: ${galleryRootDir}`);
  });
}

export { server, dbPath };

