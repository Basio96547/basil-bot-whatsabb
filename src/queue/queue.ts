import { db } from '../db.ts';
import { config } from '../config.ts';
import { toSqliteUtc } from '../utils.ts';
import { notifyWork } from './wakeup.ts';
import type { Channel } from '../whatsapp/existence.ts';

// A notification that shows up a day late is noise, not service — but unlike
// an OTP it isn't actively misleading, so it gets a generous ceiling rather
// than a tight one. Callers with a real deadline (OTP, password reset) pass
// their own ttlMinutes.
const DEFAULT_TTL_MINUTES = 24 * 60;

export interface EnqueueInput {
  project: string;
  event: string;
  recipient: string; // digits-only, international format
  payload: Record<string, string | number>;
  channel?: Channel; // explicit override — skips auto-routing (plan 4.1, 4.6)
  ttlMinutes?: number; // how long this message is still worth delivering
}

export type EnqueueResult = { ok: true; id: number } | { ok: false; reason: 'queue_full' | 'project_queue_full' };

const countPendingStmt = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'`);
const countPendingByProjectStmt = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending' AND project = ?`);
const insertStmt = db.prepare(`
  INSERT INTO messages (project, channel, channel_forced, event, recipient, payload, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Plan 9, point 2: backpressure — refuse new work past a sane cap instead of
// growing the queue (and the phone's storage/memory) without bound.
export function enqueue(input: EnqueueInput): EnqueueResult {
  const pending = (countPendingStmt.get() as { n: number }).n;
  if (pending >= config.queue.maxPending) return { ok: false, reason: 'queue_full' };

  // The cap above bounds the AGGREGATE queue, shared by every project on this
  // WhatsApp number. This bounds what any single one of them may occupy in
  // it, so one project flooding /notify or /otp/request cannot starve the
  // others' delivery — they were previously free to fill the entire shared
  // queue on their own.
  const projectPending = (countPendingByProjectStmt.get(input.project) as { n: number }).n;
  if (projectPending >= config.queue.maxPendingPerProject) return { ok: false, reason: 'project_queue_full' };

  const ttlMinutes = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const result = insertStmt.run(
    input.project,
    input.channel ?? null,
    input.channel ? 1 : 0,
    input.event,
    input.recipient,
    JSON.stringify(input.payload),
    toSqliteUtc(Date.now() + ttlMinutes * 60_000),
  );
  // العامل نائم نوماً طويلاً عند الخمول (راجع wakeup.ts) — بدون هذا السطر
  // ستنتظر رسالة عاجلة دورةَ الخمول كاملة قبل أن يراها أحد.
  notifyWork();
  return { ok: true, id: Number(result.lastInsertRowid) };
}

export interface MessageRow {
  id: number;
  project: string;
  channel: Channel | null;
  channel_forced: number;
  event: string;
  recipient: string;
  payload: string;
  template_variant: number | null;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  expires_at: string | null;
}

// A row pinned by its caller to a channel that cannot send right now can only
// be skipped — and the batch is the 20 OLDEST pending rows, so 20 such rows at
// the head used to hide every message behind them, including ones that could
// have gone out on the other channel. Excluding them at the query keeps the
// batch made of rows that can actually move. One statement per exclusion
// shape (there are only four), prepared once.
const pendingBatchStmts = new Map<string, ReturnType<typeof db.prepare>>();
function pendingBatchStmt(excluded: Channel[]): ReturnType<typeof db.prepare> {
  const key = [...excluded].sort().join(',');
  let stmt = pendingBatchStmts.get(key);
  if (!stmt) {
    const exclusion = excluded.length
      ? `AND NOT (channel_forced = 1 AND channel IN (${excluded.map(() => '?').join(', ')}))`
      : '';
    stmt = db.prepare(`
      SELECT * FROM messages WHERE status = 'pending' ${exclusion}
      ORDER BY created_at ASC, id ASC LIMIT ?
    `);
    pendingBatchStmts.set(key, stmt);
  }
  return stmt;
}

// Plan 9, point 3: small batches only — never load the whole queue into memory.
// `blockedForcedChannels`: channels that cannot send this tick — rows a caller
// forced onto one of them are left out of the batch (auto-routed rows are not:
// they can still fall back).
export function getPendingBatch(limit: number, blockedForcedChannels: Channel[] = []): MessageRow[] {
  const excluded = [...new Set(blockedForcedChannels)].sort();
  return pendingBatchStmt(excluded).all(...excluded, limit) as unknown as MessageRow[];
}

// `dropped_unsent = 0` because a send that lands always counts — including one
// that completes AFTER the row was superseded or timed out (see
// markSentIfStillPending): the recipient received it either way.
const markSentStmt = db.prepare(
  `UPDATE messages SET status = 'sent', channel = ?, template_variant = ?, dropped_unsent = 0, updated_at = datetime('now') WHERE id = ?`,
);
const markSentIfPendingStmt = db.prepare(
  `UPDATE messages SET status = 'sent', channel = ?, template_variant = ?, dropped_unsent = 0, updated_at = datetime('now')
   WHERE id = ? AND status = 'pending'`,
);
const markFailedStmt = db.prepare(
  `UPDATE messages SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?`,
);
// `attempts = 0` is what makes "never left" true: a row with earlier network
// attempts behind it may have been delivered by a send that timed out on our
// side, so it keeps counting.
const dropUnsentStmt = db.prepare(
  `UPDATE messages SET status = 'failed', last_error = ?, dropped_unsent = (attempts = 0), updated_at = datetime('now')
   WHERE id = ? AND status = 'pending'`,
);
const recordAttemptStmt = db.prepare(
  `UPDATE messages SET attempts = attempts + 1, channel = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
);
const statusOfStmt = db.prepare(`SELECT status FROM messages WHERE id = ?`);

export function markSent(id: number, channel: Channel, templateVariant: number): void {
  markSentStmt.run(channel, templateVariant, id);
}

/**
 * For a send that completed after we stopped waiting for it (the 15 s timeout
 * gave up, the call itself did not). Recording it stops the next retry from
 * delivering the same message a second time. A no-op if the row has already
 * moved on — a retry that got there first, or a permanent failure.
 */
export function markSentIfStillPending(id: number, channel: Channel, templateVariant: number): boolean {
  return Number(markSentIfPendingStmt.run(channel, templateVariant, id).changes) === 1;
}

export function markFailedPermanently(id: number, error: string): void {
  markFailedStmt.run(error, id);
}

/**
 * Fails a message that is being given up WITHOUT a network attempt of its own
 * (expired, no channel, unrenderable, superseded). Distinct from
 * markFailedPermanently so the daily OTP cap can refund it — see
 * db.ts's dropped_unsent.
 */
export function dropUnsent(id: number, reason: string): void {
  dropUnsentStmt.run(reason, id);
}

/** The row may have been superseded or finished since the batch was read. */
export function isStillPending(id: number): boolean {
  return (statusOfStmt.get(id) as { status: string } | undefined)?.status === 'pending';
}

const supersedeStmt = db.prepare(`
  UPDATE messages SET status = 'failed', last_error = 'superseded', dropped_unsent = (attempts = 0), updated_at = datetime('now')
  WHERE project = ? AND recipient = ? AND event = ? AND status = 'pending'
`);

/**
 * A fresh verification code makes every still-unsent earlier one for the same
 * number worthless. Left pending, they all went out together the moment
 * WhatsApp came back — a burst of stale codes to one person, each charged to
 * their daily allowance. Called inside the same transaction that issues the
 * new code, so a rolled-back issue un-supersedes them too.
 */
export function supersedePending(project: string, recipient: string, event: string): number {
  return Number(supersedeStmt.run(project, recipient, event).changes);
}

export function recordFailedAttempt(id: number, channel: Channel, error: string): void {
  recordAttemptStmt.run(channel, error, id);
}

const statusStmt = db.prepare(`SELECT id, event, recipient, channel, status, attempts, last_error, created_at, updated_at FROM messages WHERE id = ? AND project = ?`);

export function getStatus(id: number, project: string) {
  return statusStmt.get(id, project);
}

export function countPending(): number {
  return (countPendingStmt.get() as { n: number }).n;
}

const oldestPendingStmt = db.prepare(
  `SELECT MIN(created_at) AS oldest FROM messages WHERE status = 'pending'`,
);

/**
 * Age in seconds of the oldest message still waiting, or 0 when the queue is
 * empty.
 *
 * This is the signal /health was missing. WhatsApp reporting `connected` says
 * only that the socket is up — it says nothing about whether anything is
 * actually going out. With sends failing (a paused circuit breaker, a channel
 * with no provider, a recipient the socket won't accept) messages simply sat
 * pending, the queue never approached its 80%-of-5000 threshold at real
 * volume, and /health answered `ok` indefinitely while not one customer
 * received a code. A backlog that stops draining is visible here immediately.
 */
export function oldestPendingAgeSeconds(): number {
  const row = oldestPendingStmt.get() as { oldest: string | null };
  if (!row.oldest) return 0;
  const ageMs = Date.now() - new Date(`${row.oldest}Z`).getTime();
  return Math.max(0, Math.round(ageMs / 1000));
}
