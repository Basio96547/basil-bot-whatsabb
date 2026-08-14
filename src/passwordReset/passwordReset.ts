import crypto from 'node:crypto';
import { db } from '../db.ts';
import { toSqliteUtc } from '../utils.ts';

const RESET_TOKEN_EXPIRY_MINUTES = 10;

function hashToken(token: string): string {
  // 32 random bytes (256-bit entropy) make a keyed hash unnecessary —
  // plain SHA-256 provides equivalent preimage resistance at this token length.
  return crypto.createHash('sha256').update(token).digest('hex');
}

const insertToken = db.prepare(`
  INSERT INTO reset_tokens (project, phone, token_hash, expires_at)
  VALUES (?, ?, ?, ?)
`);

// Atomically claims the token in a single statement: finds a valid (unused,
// unexpired) row, marks it used, and returns the phone — all within one SQLite
// operation so two concurrent callers cannot both succeed with the same token.
const claimToken = db.prepare(`
  UPDATE reset_tokens
  SET used_at = datetime('now')
  WHERE id = (
    SELECT id FROM reset_tokens
    WHERE project = ? AND token_hash = ?
      AND used_at IS NULL
      AND expires_at > datetime('now')
  )
  RETURNING phone
`);

export function issueResetToken(project: string, phone: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = toSqliteUtc(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60_000);
  insertToken.run(project, phone, hashToken(token), expiresAt);
  return token;
}

export type ValidateTokenResult =
  | { ok: true; phone: string }
  | { ok: false; reason: 'not_found_or_expired' };

export function validateResetToken(project: string, token: string): ValidateTokenResult {
  const row = claimToken.get(project, hashToken(token)) as { phone: string } | undefined;
  if (!row) return { ok: false, reason: 'not_found_or_expired' };
  return { ok: true, phone: row.phone };
}
