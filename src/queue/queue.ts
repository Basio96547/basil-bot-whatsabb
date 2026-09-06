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

const pendingBatchStmt = db.prepare(`
  SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
`);

// Plan 9, point 3: small batches only — never load the whole queue into memory.
export function getPendingBatch(limit: number): MessageRow[] {
  return pendingBatchStmt.all(limit) as unknown as MessageRow[];
}

const markSentStmt = db.prepare(
  `UPDATE messages SET status = 'sent', channel = ?, template_variant = ?, updated_at = datetime('now') WHERE id = ?`,
);
const markFailedStmt = db.prepare(
  `UPDATE messages SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?`,
);
const recordAttemptStmt = db.prepare(
  `UPDATE messages SET attempts = attempts + 1, channel = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
);

export function markSent(id: number, channel: Channel, templateVariant: number): void {
  markSentStmt.run(channel, templateVariant, id);
}

export function markFailedPermanently(id: number, error: string): void {
  markFailedStmt.run(error, id);
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
