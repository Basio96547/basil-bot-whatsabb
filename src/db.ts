import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'sms-api.db'));

// WAL: readers (status endpoint, health check) don't block the writer (worker loop).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project         TEXT NOT NULL,
    channel         TEXT CHECK (channel IN ('whatsapp', 'sms')),
    channel_forced  INTEGER NOT NULL DEFAULT 0,
    event           TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    payload         TEXT NOT NULL,
    template_variant INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient);

  CREATE TABLE IF NOT EXISTS otp_codes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT NOT NULL,
    phone        TEXT NOT NULL,
    code_hash    TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    expires_at   TEXT NOT NULL,
    verified_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_otp_phone_project_created ON otp_codes(phone, project, created_at);

  CREATE TABLE IF NOT EXISTS whatsapp_status_cache (
    phone         TEXT PRIMARY KEY,
    has_whatsapp  INTEGER NOT NULL,
    checked_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reset_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT NOT NULL,
    phone      TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reset_tokens_hash ON reset_tokens(token_hash);
`);

// Migration: add purpose column so login and password-reset OTPs have separate
// cooldowns and cannot be cross-verified. Existing rows get 'login' by default.
try { db.exec(`ALTER TABLE otp_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'`); } catch { /* already exists */ }

// Migration: a queued message is only worth sending for so long. After a long
// outage the queue drains in creation order, and without this an OTP that sat
// there for an hour still went out — arriving as a code that expired 50
// minutes ago. NULL means "no deadline" (rows queued before this column
// existed, and any future event where late is still better than never).
try { db.exec(`ALTER TABLE messages ADD COLUMN expires_at TEXT`); } catch { /* already exists */ }
