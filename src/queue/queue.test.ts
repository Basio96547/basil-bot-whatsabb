// Plan 9 point 2 bounded the AGGREGATE queue, shared by every project on this
// WhatsApp number; nothing bounded what ONE project could occupy inside it —
// a leaked or misbehaving API key for a single project could fill the shared
// queue and starve every other tenant's delivery. These pin both the
// pre-existing aggregate cap and the per-project cap that closes that gap.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-queue-'));
process.env.QUEUE_MAX_PENDING = '5';
process.env.QUEUE_MAX_PENDING_PER_PROJECT = '3';

const { enqueue } = await import('./queue.ts');
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
