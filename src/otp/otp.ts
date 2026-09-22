import crypto from 'node:crypto';
import { db } from '../db.ts';
import { config, type ProjectConfig } from '../config.ts';
import { toSqliteUtc } from '../utils.ts';

function hashCode(phone: string, code: string): string {
  return crypto.createHmac('sha256', config.otpHashSecret).update(`${phone}:${code}`).digest('hex');
}

function generateSixDigitCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// `id DESC` as the tie-break, not just created_at: SQLite's datetime('now')
// has one-second granularity, so two codes issued inside the same second made
// "the latest one" arbitrary — and both the cooldown check and verifyOtp read
// it. Verification could then compare against the sibling row's hash and
// reject the code the customer had just received, burning an attempt each try.
const selectLatest = db.prepare(`
  SELECT id, code_hash, attempts, max_attempts, expires_at, verified_at, created_at, message_id
  FROM otp_codes WHERE project = ? AND phone = ? AND purpose = ?
  ORDER BY created_at DESC, id DESC LIMIT 1
`);

const insertOtp = db.prepare(`
  INSERT INTO otp_codes (project, phone, code_hash, max_attempts, expires_at, purpose)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const selectMessageStatus = db.prepare(`SELECT status, created_at FROM messages WHERE id = ?`);

// Mirrors /health's own definition of "stalled, not just running late" (see
// QUEUE_STALL_SECONDS in routes.ts). A message the worker's per-message
// WhatsApp gate is leaving pending — WhatsApp down, an active enforcement,
// the send-rate ceiling — never becomes 'failed' for as long as the outage
// lasts, so checking status alone would miss the single most common way
// delivery actually breaks: an outage, not a permanent per-message failure.
const STUCK_PENDING_MS = 10 * 60_000;

// True when the message that was queued to deliver this exact code is either
// KNOWN to have failed permanently, or has been sitting undelivered long
// enough that "it's on its way" is no longer an honest thing to tell the
// customer. A NULL message_id (linkage never made, or a pre-migration row)
// or a 'sent' status is treated as "assume fine", matching this function's
// existing behavior before this check existed.
function linkedMessageUndeliverable(messageId: number | null): boolean {
  if (messageId === null) return false;
  const row = selectMessageStatus.get(messageId) as { status: string; created_at: string } | undefined;
  if (!row) return false;
  if (row.status === 'failed') return true;
  if (row.status === 'pending') {
    return Date.now() - new Date(`${row.created_at}Z`).getTime() > STUCK_PENDING_MS;
  }
  return false;
}

const linkMessageStmt = db.prepare(`UPDATE otp_codes SET message_id = ? WHERE id = ?`);

/** Records which queued message will deliver `otpId`'s code — see the
 * already_sent branch below for why this matters. Called by issueAndQueue
 * once enqueue() succeeds, inside the same transaction as the insert. */
export function linkOtpMessage(otpId: number, messageId: number): void {
  linkMessageStmt.run(messageId, otpId);
}

const bumpAttempts = db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`);
const markVerified = db.prepare(`UPDATE otp_codes SET verified_at = datetime('now') WHERE id = ?`);

const insertSendLog = db.prepare(`INSERT INTO otp_send_log (project, phone, purpose) VALUES (?, ?, ?)`);

// The cap is a rolling 24h window, not a calendar day — a calendar day resets
// at midnight, so an abuser just waits for it and sends the next burst.
const DAY_MS = 24 * 60 * 60 * 1000;
const countRecentSends = db.prepare(`
  SELECT COUNT(*) AS n, MIN(created_at) AS oldest
  FROM otp_send_log
  WHERE project = ? AND phone = ? AND purpose = ? AND created_at > datetime('now', '-24 hours')
`);

export type GenerateResult =
  | { ok: true; code: string; otpId: number }
  // A live, unspent code already exists for this number. Distinct from
  // `cooldown` on purpose — see the branch below.
  | { ok: false; reason: 'already_sent'; retryAfterSeconds: number; expiresInSeconds: number }
  | { ok: false; reason: 'cooldown' | 'daily_limit'; retryAfterSeconds: number };

export function generateOtp(project: ProjectConfig, phone: string, purpose = 'login'): GenerateResult {
  // Checked before the cooldown: the cooldown only spaces requests out, so on
  // its own it still permits a message every few minutes forever — 144 a day
  // to one number at a 10-minute cooldown. That is harassment of whoever owns
  // the number, and the kind of volume that gets the SENDING number banned.
  const recent = countRecentSends.get(project.id, phone, purpose) as { n: number; oldest: string | null };
  if (recent.n >= project.otpMaxPerDay) {
    // Freed when the oldest send in the window ages out, not a flat delay.
    const oldestMs = recent.oldest ? new Date(`${recent.oldest}Z`).getTime() : Date.now();
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestMs + DAY_MS - Date.now()) / 1000));
    return { ok: false, reason: 'daily_limit', retryAfterSeconds };
  }

  const latest = selectLatest.get(project.id, phone, purpose) as
    | { created_at: string; expires_at: string; verified_at: string | null; message_id: number | null }
    | undefined;

  if (latest) {
    const elapsedMs = Date.now() - new Date(`${latest.created_at}Z`).getTime();
    const cooldownMs = project.resendCooldownMinutes * 60_000;

    // Once the cooldown has elapsed on its own, a fresh code is issued below
    // regardless of the old message's fate — so the linkage lookup is only
    // ever needed INSIDE the cooldown window, which keeps it off the common
    // path (a customer asking again well after their first code).
    if (elapsedMs < cooldownMs) {
      // The message that would have delivered THIS code already failed
      // permanently (no_channel_available, a template render failure, five
      // exhausted send attempts...) or has been stuck pending long enough
      // that "it's on its way" would be a lie (a WhatsApp outage, an active
      // enforcement, the send-rate ceiling — none of these ever mark a
      // message 'failed', they just leave it pending for as long as they
      // last). Reporting already_sent — or even a plain cooldown — here
      // would make the customer wait out the whole window for a code that is
      // provably never coming, with no way to ask again until it passes.
      // Skipping straight to issuing a fresh code is safe: the daily cap
      // above is keyed off otp_send_log, not this cooldown, so it still
      // bounds how many of these a number can trigger.
      const undeliverable = linkedMessageUndeliverable(latest.message_id);

      if (!undeliverable) {
        const retryAfterSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        const expiresInMs = new Date(`${latest.expires_at}Z`).getTime() - Date.now();

        // A code that is still valid and still unused changes the answer
        // entirely: the caller's real question is "will this customer get a
        // code?", and they already have one.
        //
        // This is what makes a request that SUCCEEDED but timed out at the
        // caller recoverable. The clients give up after 8 seconds, and this
        // phone's network is documented to stall for minutes — so the request
        // lands, the code is issued and queued, the response never arrives,
        // and the site tells the customer it failed. Their retry then hit a
        // bare `cooldown` error, i.e. "you asked recently, wait 10 minutes",
        // while the code was arriving on WhatsApp seconds later with the UI
        // insisting nothing had been sent and no way to ask again.
        //
        // Reported as a distinct reason so the caller can say "check
        // WhatsApp, your code is on its way" and move the customer to the
        // code screen. No new message is sent and no quota is spent, so the
        // cooldown's actual job is untouched — only what we TELL the caller
        // changes.
        if (!latest.verified_at && expiresInMs > 0) {
          return {
            ok: false,
            reason: 'already_sent',
            retryAfterSeconds,
            expiresInSeconds: Math.ceil(expiresInMs / 1000),
          };
        }
        return { ok: false, reason: 'cooldown', retryAfterSeconds };
      }
    }
  }

  const code = generateSixDigitCode();
  const expiresAt = toSqliteUtc(Date.now() + project.otpExpiryMinutes * 60_000);
  const inserted = insertOtp.run(project.id, phone, hashCode(phone, code), project.otpMaxAttempts, expiresAt, purpose);
  insertSendLog.run(project.id, phone, purpose);
  return { ok: true, code, otpId: Number(inserted.lastInsertRowid) };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_found_or_expired' | 'too_many_attempts' | 'invalid_code'; attemptsRemaining?: number };

export function verifyOtp(project: ProjectConfig, phone: string, submittedCode: string, purpose = 'login'): VerifyResult {
  const latest = selectLatest.get(project.id, phone, purpose) as
    | {
        id: number;
        code_hash: string;
        attempts: number;
        max_attempts: number;
        expires_at: string;
        verified_at: string | null;
      }
    | undefined;

  if (!latest || latest.verified_at) return { ok: false, reason: 'not_found_or_expired' };
  if (new Date(`${latest.expires_at}Z`).getTime() < Date.now()) return { ok: false, reason: 'not_found_or_expired' };
  if (latest.attempts >= latest.max_attempts) return { ok: false, reason: 'too_many_attempts' };

  const submittedHash = Buffer.from(hashCode(phone, submittedCode));
  const storedHash = Buffer.from(latest.code_hash);
  const matches = submittedHash.length === storedHash.length && crypto.timingSafeEqual(submittedHash, storedHash);

  if (matches) {
    markVerified.run(latest.id);
    return { ok: true };
  }

  bumpAttempts.run(latest.id);
  return { ok: false, reason: 'invalid_code', attemptsRemaining: latest.max_attempts - latest.attempts - 1 };
}
