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

// Every code that could still be typed in — not just the newest. WhatsApp can
// deliver an earlier code after a later one (the "undeliverable" re-issue below
// is exactly that case when the old message recovers), and the customer types
// what they see. How many there can be is bounded by the daily cap, and how
// many GUESSES they can absorb is bounded in verifyOtp: every guess is charged
// to every open code, so no code takes more than its own max_attempts.
const selectLive = db.prepare(`
  SELECT id, code_hash, attempts, max_attempts
  FROM otp_codes
  WHERE project = ? AND phone = ? AND purpose = ? AND verified_at IS NULL AND expires_at > datetime('now')
  ORDER BY created_at DESC, id DESC
`);

const selectMessageStatus = db.prepare(`SELECT status, created_at, expires_at FROM messages WHERE id = ?`);

// Mirrors /health's own definition of "stalled, not just running late" (see
// QUEUE_STALL_SECONDS in routes.ts). A message the worker's per-message
// WhatsApp gate is leaving pending — WhatsApp down, an active enforcement,
// the send-rate ceiling — never becomes 'failed' for as long as the outage
// lasts, so checking status alone would miss the single most common way
// delivery actually breaks: an outage, not a permanent per-message failure.
const STUCK_PENDING_MS = 10 * 60_000;

// True when the message that was queued to deliver this exact code is either
// KNOWN to have failed permanently, is still pending past its own deadline
// (the worker only marks that when it gets to the row, which it does not
// during an outage), or has been sitting undelivered long enough that "it's
// on its way" is no longer an honest thing to tell the customer. A NULL
// message_id (linkage never made, or a pre-migration row) or a 'sent' status
// is treated as "assume fine", matching this function's behavior before this
// check existed.
function linkedMessageUndeliverable(messageId: number | null): boolean {
  if (messageId === null) return false;
  const row = selectMessageStatus.get(messageId) as
    | { status: string; created_at: string; expires_at: string | null }
    | undefined;
  if (!row) return false;
  if (row.status === 'failed') return true;
  if (row.status === 'pending') {
    if (row.expires_at && new Date(`${row.expires_at}Z`).getTime() <= Date.now()) return true;
    return Date.now() - new Date(`${row.created_at}Z`).getTime() > STUCK_PENDING_MS;
  }
  return false;
}

const linkMessageStmt = db.prepare(`UPDATE otp_codes SET message_id = ? WHERE id = ?`);
const linkSendLogStmt = db.prepare(`UPDATE otp_send_log SET message_id = ? WHERE id = ?`);

/** Records which queued message will deliver this code — for the
 * already_sent branch below, and so the daily cap can refund the send if that
 * message is dropped without ever going out. Called by issueAndQueue once
 * enqueue() succeeds, inside the same transaction as the insert. */
export function linkOtpMessage(issued: { otpId: number; sendLogId: number }, messageId: number): void {
  linkMessageStmt.run(messageId, issued.otpId);
  linkSendLogStmt.run(messageId, issued.sendLogId);
}

// Conditional, so the limit holds even if verification ever stops being one
// synchronous call in one process (a second worker, an await added inside):
// a separate read-then-increment would let parallel guesses all read "0".
const bumpAttempts = db.prepare(
  `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < max_attempts AND verified_at IS NULL`,
);
// Using one live code spends them all — an older message still sitting in the
// customer's chat must not open the door a second time.
const markAllVerified = db.prepare(`
  UPDATE otp_codes SET verified_at = datetime('now')
  WHERE project = ? AND phone = ? AND purpose = ? AND verified_at IS NULL
`);

/**
 * What the customer typed, as the six digits it most plausibly means.
 *
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits fold to 0-9 — `\d` matches
 * neither, and these sites render their own numbers in them. Then: a single
 * standalone group of exactly six digits wins, because pasting the whole
 * WhatsApp message brings its other numbers along ("…: 123456. صالح 10
 * دقائق" is 8 digits joined). Otherwise every digit is joined, which keeps
 * "12 34 56" working.
 */
export function normalizeSubmittedCode(raw: string): string {
  const folded = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const groups = folded.match(/\d+/g) ?? [];
  const sixes = groups.filter((group) => group.length === 6);
  if (sixes.length === 1) return sixes[0];
  return groups.join('');
}

const insertSendLog = db.prepare(`INSERT INTO otp_send_log (project, phone, purpose) VALUES (?, ?, ?)`);

// The cap is a rolling 24h window, not a calendar day — a calendar day resets
// at midnight, so an abuser just waits for it and sends the next burst.
//
// A send whose message was dropped without ever leaving (superseded by a
// newer code, expired during an outage — see db.ts's dropped_unsent) is not
// counted: the cap bounds what a number RECEIVES, and those were never
// received by anyone. Rows with no linked message (written before the link
// existed) keep counting.
const DAY_MS = 24 * 60 * 60 * 1000;
const countRecentSends = db.prepare(`
  SELECT COUNT(*) AS n, MIN(l.created_at) AS oldest
  FROM otp_send_log l
  LEFT JOIN messages m ON m.id = l.message_id
  WHERE l.project = ? AND l.phone = ? AND l.purpose = ? AND l.created_at > datetime('now', '-24 hours')
    AND COALESCE(m.dropped_unsent, 0) = 0
`);

export type GenerateResult =
  | { ok: true; code: string; otpId: number; sendLogId: number }
  // A live, unspent code already exists for this number. Distinct from
  // `cooldown` on purpose — see the branch below.
  | { ok: false; reason: 'already_sent'; retryAfterSeconds: number; expiresInSeconds: number }
  | { ok: false; reason: 'cooldown' | 'daily_limit'; retryAfterSeconds: number };

export function generateOtp(project: ProjectConfig, phone: string, purpose = 'login'): GenerateResult {
  const latest = selectLatest.get(project.id, phone, purpose) as
    | {
        created_at: string;
        expires_at: string;
        verified_at: string | null;
        message_id: number | null;
        attempts: number;
        max_attempts: number;
      }
    | undefined;

  // Set when the cooldown would refuse this request — but answered only AFTER
  // the daily cap, which is the more useful thing to tell someone who has hit
  // both ("tomorrow", not "in a minute" followed by "tomorrow").
  let cooldownRetryAfterSeconds: number | null = null;

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
      // below still bounds how many of these a number can trigger.
      const undeliverable = linkedMessageUndeliverable(latest.message_id);
      // Locked by wrong guesses: verifyOtp now refuses this code for good, so
      // answering already_sent ("check WhatsApp") pointed the customer at a
      // dead code, and a plain cooldown left them stuck for the rest of the
      // window. Same reasoning as `undeliverable` — issue a fresh one; the
      // daily cap below still bounds how many codes, and so how many guesses,
      // a number can get.
      const locked = !latest.verified_at && latest.attempts >= latest.max_attempts;

      if (!undeliverable && !locked) {
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
        // Answered BEFORE the daily cap: it spends nothing, and the request
        // that timed out may well have been the day's last allowed one — the
        // cap-first order answered "try again tomorrow" while that very code
        // was arriving.
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
        cooldownRetryAfterSeconds = retryAfterSeconds;
      }
    }
  }

  // The cooldown only spaces requests out, so on its own it still permits a
  // message every few minutes forever — 144 a day to one number at a
  // 10-minute cooldown. That is harassment of whoever owns the number, and the
  // kind of volume that gets the SENDING number banned.
  const recent = countRecentSends.get(project.id, phone, purpose) as { n: number; oldest: string | null };
  if (recent.n >= project.otpMaxPerDay) {
    // Freed when the oldest send in the window ages out, not a flat delay.
    const oldestMs = recent.oldest ? new Date(`${recent.oldest}Z`).getTime() : Date.now();
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestMs + DAY_MS - Date.now()) / 1000));
    return { ok: false, reason: 'daily_limit', retryAfterSeconds };
  }

  if (cooldownRetryAfterSeconds !== null) {
    return { ok: false, reason: 'cooldown', retryAfterSeconds: cooldownRetryAfterSeconds };
  }

  const code = generateSixDigitCode();
  const expiresAt = toSqliteUtc(Date.now() + project.otpExpiryMinutes * 60_000);
  const inserted = insertOtp.run(project.id, phone, hashCode(phone, code), project.otpMaxAttempts, expiresAt, purpose);
  const logged = insertSendLog.run(project.id, phone, purpose);
  return {
    ok: true,
    code,
    otpId: Number(inserted.lastInsertRowid),
    sendLogId: Number(logged.lastInsertRowid),
  };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_found_or_expired' | 'too_many_attempts' | 'invalid_code'; attemptsRemaining?: number };

type LiveCode = { id: number; code_hash: string; attempts: number; max_attempts: number };

export function verifyOtp(project: ProjectConfig, phone: string, submittedCode: string, purpose = 'login'): VerifyResult {
  const live = selectLive.all(project.id, phone, purpose) as LiveCode[];
  if (live.length === 0) return { ok: false, reason: 'not_found_or_expired' };

  // Only codes with guesses left take part. Each guess below is charged to
  // every one of them, so checking one guess against several live codes can
  // never add up to more than max_attempts guesses per code in total —
  // without that, keeping older codes valid multiplied an attacker's chances
  // by the number of live codes.
  const open = live.filter((row) => row.attempts < row.max_attempts);
  if (open.length === 0) return { ok: false, reason: 'too_many_attempts' };
  const newest = open[0];

  // Arabic digits and pasted text ("كودك: ١٢٣٤٥٦") are the customer typing
  // the right code in a different form — not a guess. Anything that still
  // isn't six digits after normalising is rejected WITHOUT spending an
  // attempt: it can't match, so it gives an attacker nothing.
  const code = normalizeSubmittedCode(submittedCode);
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: 'invalid_code', attemptsRemaining: newest.max_attempts - newest.attempts };
  }

  let charged = 0;
  for (const row of open) charged += Number(bumpAttempts.run(row.id).changes);
  if (charged === 0) return { ok: false, reason: 'too_many_attempts' };

  const submittedHash = Buffer.from(hashCode(phone, code));
  const matches = open.some((row) => {
    const storedHash = Buffer.from(row.code_hash);
    return submittedHash.length === storedHash.length && crypto.timingSafeEqual(submittedHash, storedHash);
  });

  if (matches) {
    markAllVerified.run(project.id, phone, purpose);
    return { ok: true };
  }

  return { ok: false, reason: 'invalid_code', attemptsRemaining: newest.max_attempts - newest.attempts - 1 };
}
