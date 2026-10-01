import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { VERIFICATION_EVENTS } from './templates/templates.ts';

mkdirSync(config.dataDir, { recursive: true });
const DB_FILE = path.join(config.dataDir, 'sms-api.db');
export const db = new DatabaseSync(DB_FILE);

// WAL: readers (status endpoint, health check) don't block the writer (worker loop).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// A row rewritten or deleted leaves its old bytes in the page's free space,
// readable in the file — including a verification code just removed from its
// message (see the trigger below). A finished code message with a newer row
// after it in the page kept its code that way, whichever way it finished.
// FAST zeroes those bytes in the page being written anyway: no extra I/O.
db.exec('PRAGMA secure_delete = FAST');

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
    rollbackQuietly();
    throw error;
  }
  if (result === null) {
    db.exec('ROLLBACK');
    return null;
  }
  try {
    db.exec('COMMIT');
  } catch (error) {
    // A COMMIT that fails (a full disk) can leave the transaction open on
    // this one shared connection — and then every later BEGIN throws and
    // every write silently joins a transaction that never commits.
    rollbackQuietly();
    throw error;
  }
  return result;
}

// On some errors (SQLITE_FULL among them) SQLite has already rolled the
// transaction back itself, and an explicit ROLLBACK then throws "no
// transaction is active" — which used to REPLACE the real error on its way
// out, so a full disk was reported as a rollback bug.
function rollbackQuietly(): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    /* already rolled back by SQLite */
  }
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
  -- Covers sendRate.ts's countSentSince (status='sent' AND channel='whatsapp'
  -- AND updated_at > ...), now run once per WhatsApp-channel message instead
  -- of once per batch — without this it is a full table scan on every one.
  CREATE INDEX IF NOT EXISTS idx_messages_status_channel_updated ON messages(status, channel, updated_at);

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

  -- When the CURRENT WhatsApp identity first connected, keyed by its own JID.
  -- Needed by the send-rate warm-up: a freshly paired number must send at a
  -- fraction of the normal ceiling for its first hours, and that clock has to
  -- survive process restarts (otherwise every restart looks like a fresh
  -- pairing, or the warm-up is skipped entirely). A different JID means a
  -- genuine re-pair and starts a new clock.
  CREATE TABLE IF NOT EXISTS session_state (
    me_id     TEXT PRIMARY KEY,
    paired_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// Whether `table` already has `column` — the authoritative check (SQLite's own
// schema introspection), not a guess from an error message. Exported for
// testing alongside addColumnIfMissing below.
//
// `table`/`column` are interpolated directly into the PRAGMA/ALTER TABLE SQL
// below with no escaping — fine as long as every caller passes a hardcoded
// literal (as all of them do, right below), but this pair must never be
// called with a table/column name built from a variable or user input.
export function columnExists(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

// Runs a one-off `ALTER TABLE ... ADD COLUMN` migration. PRAGMA table_info is
// checked FIRST and is what actually decides "already migrated" — it reads
// SQLite's own schema, so it cannot be fooled by a driver's error wording.
// The catch below is now only a defensive fallback for a race against another
// process making the same change, and still tolerates only the one error that
// means "already migrated": a bare `catch {}` here would also swallow a
// genuinely failed migration (disk full, a locked file) — the column would
// then silently not exist, and the failure would only surface later as a
// confusing "no such column" from an unrelated query.
export function addColumnIfMissing(table: string, column: string, definition: string): void {
  if (columnExists(table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('duplicate column name')) return;
    throw error;
  }
}

// Migration: add purpose column so login and password-reset OTPs have separate
// cooldowns and cannot be cross-verified. Existing rows get 'login' by default.
addColumnIfMissing('otp_codes', 'purpose', `TEXT NOT NULL DEFAULT 'login'`);

// Migration: a queued message is only worth sending for so long. After a long
// outage the queue drains in creation order, and without this an OTP that sat
// there for an hour still went out — arriving as a code that expired 50
// minutes ago. NULL means "no deadline" (rows queued before this column
// existed, and any future event where late is still better than never).
addColumnIfMissing('messages', 'expires_at', 'TEXT');

// Migration: links an OTP row to the message that was queued to deliver it, so
// a repeat request can tell "a live code exists" apart from "and the message
// that would deliver it hasn't already failed permanently" — see the
// already_sent branch in otp.ts. NULL for codes issued before this column
// existed, and already_sent treats that exactly like "unknown, assume fine"
// (its pre-existing behavior).
addColumnIfMissing('otp_codes', 'message_id', 'INTEGER');

// Migration: 1 when a message ended 'failed' WITHOUT ever reaching the network
// (expired while WhatsApp was down, superseded by a newer code, no channel,
// a template that could not render). The daily OTP cap exists to bound what a
// number actually RECEIVES; charging it for messages that never left made an
// ordinary outage lock a customer out for 24 hours — five retries during a
// WhatsApp drop spent the whole day's allowance with nothing delivered.
addColumnIfMissing('messages', 'dropped_unsent', 'INTEGER NOT NULL DEFAULT 0');

// Migration: which message a daily-cap row paid for, so the cap can refund
// exactly the rows whose message was dropped unsent (see dropped_unsent above).
// NULL for rows written before this column existed — those keep counting.
addColumnIfMissing('otp_send_log', 'message_id', 'INTEGER');

// Migration: when THIS code was the one typed in. verified_at is set on every
// live code for the number at once (one use spends them all), so it cannot say
// which code was actually used — and only that one may be accepted again
// during the lost-response grace window in otp.ts.
addColumnIfMissing('otp_codes', 'matched_at', 'TEXT');

// Migration: when a message that failed an attempt may be tried again. Without
// it the same oldest row was re-fetched on the very next tick, so a burst of
// fast transient errors spent all five attempts in about twelve seconds — the
// same failure that tripped the circuit breaker also killed the message.
// NULL means "now".
addColumnIfMissing('messages', 'next_attempt_at', 'TEXT');

// A verification code exists in the clear in one place only: the payload of
// the message that delivers it — the worker renders it into the text, after a
// restart too. Everywhere else it is a hash, because a copy of this file must
// not hand out live codes (plan 4.3), and no code is kept once it is used or
// expired (plan 10). The message rows kept theirs anyway, for the 90 days they
// are retained: readable, and still valid for the ten minutes after delivery.
// The code now goes from the row the moment its message stops being pending —
// sent, failed, dropped, superseded, expired — whichever statement does it.
// From the files soon after: secure_delete (above) zeroes the old bytes in the
// page, and truncateWal (below) folds the WAL frames written while the code
// was still pending into the database and empties the WAL.
//
// json_valid first, lazily (CASE): json_extract throws on malformed JSON, and
// one odd row must not make every status change on it — or the boot — fail.
//
// Verification messages only. /notify stores a site's payload as it came, and
// a "code" field there is the site's own data, kept like the rest of the log.
const IS_VERIFICATION = (event: string) => `${event} IN (${VERIFICATION_EVENTS.map((name) => `'${name}'`).join(', ')})`;
const HOLDS_CODE = (payload: string) => `(CASE WHEN json_valid(${payload}) THEN json_extract(${payload}, '$.code') END) IS NOT NULL`;
// Dropped and created again at every boot, in one transaction: CREATE TRIGGER
// IF NOT EXISTS kept whatever definition an earlier version had created under
// this name, so a change to it here would never have reached a phone that ran
// the earlier one.
inTransaction(() => {
  db.exec('DROP TRIGGER IF EXISTS messages_forget_code_when_done');
  db.exec(`
    CREATE TRIGGER messages_forget_code_when_done
    AFTER UPDATE OF status ON messages
    WHEN NEW.status != 'pending' AND ${IS_VERIFICATION('NEW.event')} AND ${HOLDS_CODE('NEW.payload')}
    BEGIN
      UPDATE messages SET payload = json_remove(payload, '$.code') WHERE id = NEW.id;
    END
  `);
  return true;
});

/** Removes the codes finished messages still hold — what versions before the trigger above left behind. */
export function scrubCodesFromFinishedMessages(): number {
  const stmt = db.prepare(
    `UPDATE messages SET payload = json_remove(payload, '$.code')
     WHERE status != 'pending' AND ${IS_VERIFICATION('event')} AND ${HOLDS_CODE('payload')}`,
  );
  return Number(stmt.run().changes);
}

/**
 * Copies whatever the WAL holds into the database file and empties the WAL,
 * when there is anything in it.
 *
 * A code removed from its message is still in the WAL frames written while it
 * was pending. SQLite's own checkpoints copy frames into the database but
 * leave the WAL file as it is, to be overwritten some time later — after
 * 1000 pages of writes, which at this service's volume can take days. This
 * runs at boot, and in the worker after each message it handles and on each
 * pass of its loop (at least once a minute). With nothing in the WAL it is
 * one stat (under 10 µs measured on a PC); after a message, about 0.6 ms and
 * three fsyncs more than the two that sending and recording it already cost.
 */
export function truncateWal(): void {
  const size = statSync(`${DB_FILE}-wal`, { throwIfNoEntry: false })?.size ?? 0;
  if (size > 0) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

scrubCodesFromFinishedMessages();
truncateWal();
