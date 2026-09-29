// Plan 9 point 2 bounded the AGGREGATE queue, shared by every project on this
// WhatsApp number; nothing bounded what ONE project could occupy inside it —
// a leaked or misbehaving API key for a single project could fill the shared
// queue and starve every other tenant's delivery. These pin both the
// pre-existing aggregate cap and the per-project cap that closes that gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestEnv } from '../testEnv.ts';

useTestEnv('queue');
process.env.QUEUE_MAX_PENDING = '5';
process.env.QUEUE_MAX_PENDING_PER_PROJECT = '3';

const { enqueue, recordFailedAttempt, markFailedPermanently, markSentIfStillPending } = await import('./queue.ts');
const { db } = await import('../db.ts');

function clear(): void {
  db.exec('DELETE FROM messages;');
}

function fill(project: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const result = enqueue({ project, event: 'order_created', recipient: '963900000000', payload: {} });
    assert.equal(result.ok, true, `expected fill() call ${i} for "${project}" to succeed`);
  }
}

test('a project is refused once it hits its OWN cap, well under the aggregate cap', () => {
  clear();
  fill('tenant-a', 3); // QUEUE_MAX_PENDING_PER_PROJECT
  const result = enqueue({ project: 'tenant-a', event: 'order_created', recipient: '963900000001', payload: {} });
  assert.deepEqual(result, { ok: false, reason: 'project_queue_full' });
});

test('one project hitting its own cap does not block a different project', () => {
  clear();
  fill('tenant-a', 3);
  const result = enqueue({ project: 'tenant-b', event: 'order_created', recipient: '963900000002', payload: {} });
  assert.equal(result.ok, true, 'tenant-b must be unaffected by tenant-a exhausting its own share');
});

test('the aggregate cap still applies across projects combined', () => {
  clear();
  fill('tenant-a', 3);
  fill('tenant-b', 2); // 3 + 2 = 5 = QUEUE_MAX_PENDING, each under its own per-project cap
  const result = enqueue({ project: 'tenant-c', event: 'order_created', recipient: '963900000003', payload: {} });
  assert.deepEqual(result, { ok: false, reason: 'queue_full' });
});

test('a message queues normally while under both caps', () => {
  clear();
  const result = enqueue({ project: 'tenant-a', event: 'order_created', recipient: '963900000004', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(typeof (result as { id: number }).id, 'number');
});

function queued(): number {
  const result = enqueue({ project: 'tenant-a', event: 'order_created', recipient: '963900000005', payload: {} });
  assert.equal(result.ok, true);
  return (result as { id: number }).id;
}

// Spread: node:sqlite rows have a null prototype, which deepEqual tells apart.
function rowOf(id: number): { status: string; attempts: number; channel: string | null; last_error: string | null } {
  return { ...db.prepare('SELECT status, attempts, channel, last_error FROM messages WHERE id = ?').get(id) } as {
    status: string;
    attempts: number;
    channel: string | null;
    last_error: string | null;
  };
}

// Found by driving a message through the real worker loop against a socket
// whose every send throws: five sends went out, /status said `attempts: 4`.
test('the attempt that ends in a permanent failure is counted like every one before it', () => {
  clear();
  const id = queued();
  for (let i = 0; i < 4; i++) recordFailedAttempt(id, 'whatsapp', 'send_failed');
  markFailedPermanently(id, 'whatsapp', 'send_failed');
  assert.deepEqual(rowOf(id), { status: 'failed', attempts: 5, channel: 'whatsapp', last_error: 'send_failed' });
});

test('a permanent failure does not overwrite a row an earlier, late-landing send already marked sent', () => {
  clear();
  const id = queued();
  recordFailedAttempt(id, 'whatsapp', 'timeout');
  // attempt 1 timed out on our side and lands now, while attempt 2 is in flight
  assert.equal(markSentIfStillPending(id, 'whatsapp', 0), true);
  markFailedPermanently(id, 'whatsapp', 'send_failed');
  assert.equal(rowOf(id).status, 'sent', 'a delivered message was rewritten as failed');
});
