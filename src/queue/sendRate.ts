// Global send-rate governor — the aggregate ceiling the per-number caps never
// provided.
//
// otpMaxPerDay and resendCooldownMinutes bound what one RECIPIENT can receive.
// Nothing bounded what the sending ACCOUNT emits in total, and that is the
// dimension WhatsApp actually judges: a few hundred messages an hour from one
// unofficial client looks like a blast regardless of how politely they are
// spread across recipients. This account has already been restricted once
// (RESTRICT_ALL_COMPANIONS, 2026-09-03), so the ceiling is deliberately low —
// far above real traffic (the whole service has sent single digits per day),
// far below anything that reads as bulk.
//
// Over the limit the worker STALLS instead of dropping: messages stay pending
// and go out when the window rolls. Short-lived ones (OTP, password reset)
// expire on their own TTL rather than arriving as a code the server already
// rejects — see worker.ts's expires_at check.

import { db } from '../db.ts';
import { config } from '../config.ts';

// Counted from the messages table rather than an in-memory tally: a pm2
// restart must not reset the budget, or a crash-loop becomes a way to send
// without limit. `updated_at` is when the send actually happened.
const countSentSince = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE status = 'sent' AND updated_at > datetime('now', ?)
`);

/** Sends in the last hour, as recorded by the queue itself. */
export function sentLastHour(): number {
  return (countSentSince.get('-1 hours') as { n: number }).n;
}

const upsertPairedAt = db.prepare(
  `INSERT INTO session_state (me_id) VALUES (?) ON CONFLICT(me_id) DO NOTHING`,
);
const selectPairedAt = db.prepare(`SELECT paired_at FROM session_state WHERE me_id = ?`);

/**
 * Records the first time this identity was seen connected, and returns when
 * that was. Idempotent: later connections of the same JID keep the original
 * timestamp, so a reconnect (or a pm2 restart) does not restart the warm-up.
 */
export function rememberPairing(meId: string): number {
  upsertPairedAt.run(meId);
  const row = selectPairedAt.get(meId) as { paired_at: string } | undefined;
  return row ? new Date(`${row.paired_at}Z`).getTime() : Date.now();
}

export interface RateVerdict {
  allowed: boolean;
  /** Sends already made in the current window. */
  used: number;
  /** The ceiling in force right now (lower during warm-up). */
  limit: number;
  /** True while the warm-up ramp applies. */
  warmingUp: boolean;
}

/**
 * `pairedAtMs` is when the current WhatsApp session first connected. During
 * the warm-up window the ceiling is a fraction of normal, because a
 * newly-paired number is at its most fragile — and a re-pair is precisely what
 * follows an enforcement.
 */
export function checkSendRate(pairedAtMs: number | null): RateVerdict {
  const { maxPerHour, warmupHours, warmupMaxPerHour } = config.sendRate;

  const warmingUp =
    pairedAtMs !== null && Date.now() - pairedAtMs < warmupHours * 60 * 60 * 1000;
  const limit = warmingUp ? Math.min(warmupMaxPerHour, maxPerHour) : maxPerHour;

  const used = sentLastHour();
  return { allowed: used < limit, used, limit, warmingUp };
}
