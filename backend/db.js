const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    discord_id TEXT UNIQUE NOT NULL,
    discord_username TEXT NOT NULL,
    discord_avatar TEXT,
    access_token TEXT,
    role TEXT DEFAULT 'candidate',
    status TEXT DEFAULT 'active',
    admin_note TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    discord_avatar TEXT,
    prenom TEXT, nom TEXT, phone TEXT, email TEXT,
    tiktok_account TEXT, tiktok_followers TEXT,
    has_live_access TEXT, live_frequency TEXT,
    live_duration TEXT, multi_accounts TEXT,
    voice_type TEXT, money_goal TEXT,
    seriousness TEXT, free_text TEXT,
    score INTEGER DEFAULT 0,
    lead TEXT DEFAULT 'cold',
    status TEXT DEFAULT 'pending',
    submitted_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS tiktok_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    tiktok_handle TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(discord_id),
    UNIQUE(user_id, tiktok_handle)
  );

  CREATE TABLE IF NOT EXISTS affiliate_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    game_name TEXT NOT NULL,
    platform TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, game_name)
  );

  CREATE TABLE IF NOT EXISTS live_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tiktok_handle TEXT NOT NULL,
    user_id TEXT NOT NULL,
    started_at INTEGER DEFAULT (unixepoch()),
    ended_at INTEGER,
    duration_minutes INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS live_status (
    tiktok_handle TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    is_live INTEGER DEFAULT 0,
    last_checked INTEGER DEFAULT (unixepoch()),
    today_minutes INTEGER DEFAULT 0,
    last_reset_date TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    total_minutes INTEGER DEFAULT 0,
    did_live INTEGER DEFAULT 0,
    UNIQUE(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS absence_reasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    discord_username TEXT,
    date TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    count INTEGER NOT NULL,
    date TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS formation_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    cover_url TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS formation_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    video_type TEXT DEFAULT 'youtube',
    duration_minutes INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (module_id) REFERENCES formation_modules(id)
  );

  CREATE TABLE IF NOT EXISTS formation_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chapter_id INTEGER NOT NULL,
    completed_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, chapter_id)
  );

  CREATE TABLE IF NOT EXISTS dm_channels (
    discord_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
  );
`);

module.exports = db;
