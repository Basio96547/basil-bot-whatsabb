import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'sms-api.db'));

// WAL: readers (status endpoint, health check) don't block the writer (worker loop).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Runs `fn` inside a single SQLite transaction, rolling back if it throws or
 * signals failure by returning `null`.
 *
 * Used to make "issue a code" and "queue its message" one indivisible step.
 * They were two separate commits, so a queue that refused the message (or any
 * throw in between) left the code row and the daily-quota row already written:
 * the customer got an error, no message, one of their few daily codes gone,
 * and — because an unexpired code blocks a new one — no way to retry for the
 * whole resend cooldown.
 *
 * `fn` MUST be fully synchronous. node:sqlite is synchronous and this process
 * shares one connection with the queue worker, so an `await` inside the
 * transaction would let the worker's own statements join it and be rolled back
 * along with ours.
 */
export function inTransaction<T>(fn: () => T | null): T | null {
  db.exec('BEGIN IMMEDIATE');
  let result: T | null;
  try {
    result = fn();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (result === null) {
    db.exec('ROLLBACK');
    return null;
  }
  db.exec('COMMIT');
  return result;
}

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

  -- Counts OTP sends per number for the daily cap. Separate from otp_codes
  -- because that table is purged an hour after a code is spent or expires
  -- (retention.ts) — counting rows there would reset the cap almost
  -- immediately. Deliberately holds NO code and NO hash: just who was
  -- messaged and when, which the messages table already keeps for longer.
  CREATE TABLE IF NOT EXISTS otp_send_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT NOT NULL,
    phone      TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_otp_send_log_lookup ON otp_send_log(project, phone, purpose, created_at);

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
