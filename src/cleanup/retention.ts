import { db } from '../db.ts';

// Plan 10: finished message log kept 90 days (enough for a "did my
// confirmation arrive?" dispute); used/expired OTP codes purged within an
// hour — no reason to keep a spent or dead code around even hashed.
const MESSAGE_RETENTION_DAYS = 90;
const OTP_RETENTION_HOURS = 1;
const RESET_TOKEN_RETENTION_HOURS = 1;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const purgeOldMessages = db.prepare(`
  DELETE FROM messages
  WHERE status IN ('sent', 'failed')
    AND updated_at < datetime('now', '-${MESSAGE_RETENTION_DAYS} days')
`);

const purgeSpentOtp = db.prepare(`
  DELETE FROM otp_codes
  WHERE (verified_at IS NOT NULL AND verified_at < datetime('now', '-${OTP_RETENTION_HOURS} hours'))
     OR (expires_at < datetime('now', '-${OTP_RETENTION_HOURS} hours'))
`);

const purgeSpentResetTokens = db.prepare(`
  DELETE FROM reset_tokens
  WHERE (used_at IS NOT NULL AND used_at < datetime('now', '-${RESET_TOKEN_RETENTION_HOURS} hours'))
     OR (expires_at < datetime('now', '-${RESET_TOKEN_RETENTION_HOURS} hours'))
`);

export function runRetentionSweep(): { messagesDeleted: number; otpDeleted: number; resetTokensDeleted: number } {
  const messagesDeleted = purgeOldMessages.run().changes;
  const otpDeleted = purgeSpentOtp.run().changes;
  const resetTokensDeleted = purgeSpentResetTokens.run().changes;
  return { messagesDeleted: Number(messagesDeleted), otpDeleted: Number(otpDeleted), resetTokensDeleted: Number(resetTokensDeleted) };
}

export function scheduleDailyRetention(): void {
  const sweep = () => {
    const result = runRetentionSweep();
    console.log(`[retention] deleted ${result.messagesDeleted} old message(s), ${result.otpDeleted} spent OTP code(s), ${result.resetTokensDeleted} spent reset token(s)`);
  };
  sweep(); // once at boot, then daily — no external cron needed (plan 10)
  setInterval(sweep, SWEEP_INTERVAL_MS);
}
