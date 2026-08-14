import { db } from '../db.ts';
import { config } from '../config.ts';
import type { Channel } from '../whatsapp/existence.ts';

export interface EnqueueInput {
  project: string;
  event: string;
  recipient: string; // digits-only, international format
  payload: Record<string, string | number>;
  channel?: Channel; // explicit override — skips auto-routing (plan 4.1, 4.6)
}

export type EnqueueResult = { ok: true; id: number } | { ok: false; reason: 'queue_full' };

const countPendingStmt = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'`);
const insertStmt = db.prepare(`
  INSERT INTO messages (project, channel, channel_forced, event, recipient, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Plan 9, point 2: backpressure — refuse new work past a sane cap instead of
// growing the queue (and the phone's storage/memory) without bound.
export function enqueue(input: EnqueueInput): EnqueueResult {
  const pending = (countPendingStmt.get() as { n: number }).n;
  if (pending >= config.queue.maxPending) return { ok: false, reason: 'queue_full' };

  const result = insertStmt.run(
    input.project,
    input.channel ?? null,
    input.channel ? 1 : 0,
    input.event,
    input.recipient,
    JSON.stringify(input.payload),
  );
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
