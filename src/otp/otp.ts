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
  SELECT id, code_hash, attempts, max_attempts, expires_at, verified_at, created_at
  FROM otp_codes WHERE project = ? AND phone = ? AND purpose = ?
  ORDER BY created_at DESC, id DESC LIMIT 1
`);

const insertOtp = db.prepare(`
  INSERT INTO otp_codes (project, phone, code_hash, max_attempts, expires_at, purpose)
  VALUES (?, ?, ?, ?, ?, ?)
`);

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
  | { ok: true; code: string }
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
    | { created_at: string }
    | undefined;

  if (latest) {
    const elapsedMs = Date.now() - new Date(`${latest.created_at}Z`).getTime();
    const cooldownMs = project.resendCooldownMinutes * 60_000;
    if (elapsedMs < cooldownMs) {
      return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000) };
    }
  }

  const code = generateSixDigitCode();
  const expiresAt = toSqliteUtc(Date.now() + project.otpExpiryMinutes * 60_000);
  insertOtp.run(project.id, phone, hashCode(phone, code), project.otpMaxAttempts, expiresAt, purpose);
  insertSendLog.run(project.id, phone, purpose);
  return { ok: true, code };
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
