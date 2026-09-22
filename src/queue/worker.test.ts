// Two failures this pins:
//
// 1. A message whose payload cannot satisfy any template variant used to
//    throw uncaught out of processMessage, reach the loop's outer catch
//    (which only logs), and leave the row's status/attempts untouched — so
//    getPendingBatch (oldest first) re-selected and re-threw on the exact
//    same row forever, a poison pill occupying a queue slot with no way out.
//
// 2. The WhatsApp-specific "can we even send?" checks (connection, an active
//    restriction, the hourly send-rate ceiling) used to be read once per
//    BATCH at the top of the outer loop, so a restriction or ceiling crossed
//    mid-batch still let the rest of an already-fetched batch go out, and
//    the check blocked fetching the batch AT ALL — including SMS-bound
//    messages, which have nothing to do with either check. They are now
//    read per message, right before a WhatsApp attempt.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-worker-'));

const { enqueue, getPendingBatch } = await import('./queue.ts');
const { processMessage, defaultGateDeps } = await import('./worker.ts');
const { db } = await import('../db.ts');

function clear(): void {
  db.exec('DELETE FROM messages;');
}

function rowOf(id: number): { status: string; attempts: number; last_error: string | null } {
  return db.prepare('SELECT status, attempts, last_error FROM messages WHERE id = ?').get(id) as {
    status: string;
    attempts: number;
    last_error: string | null;
  };
}

// A WhatsApp send would need a real Baileys socket, which none of these tests
// have — every scenario below is decided before sendViaChannel is ever
// reached, so getConnectionState()'s real (always-disconnected-in-tests)
// state never has to be consulted. Built on the module's own exported
// default deps rather than a from-scratch object, so a future field added to
// WhatsAppGateDeps shows up here for free instead of needing a second copy
// kept in sync by hand.
const alwaysOpen = {
  ...defaultGateDeps,
  isConnected: () => true,
  activeEnforcement: () => null,
  checkSendRate: () => ({ allowed: true }),
};

test('a message whose payload satisfies no template variant is marked failed, not left stuck pending forever', async () => {
  clear();
  // Every order_created variant requires {amount}; this payload has none.
  const result = enqueue({
    project: 'store',
    event: 'order_created',
    recipient: '963900000000',
    payload: { order: '1' },
    channel: 'whatsapp',
  });
  assert.equal(result.ok, true);
  const id = (result as { id: number }).id;
  const [msg] = getPendingBatch(1);

  const attempted = await processMessage(msg, alwaysOpen);

  assert.equal(attempted, false, 'a local decision, not a network attempt — no pacing delay owed');
  const row = rowOf(id);
  assert.equal(row.status, 'failed');
  assert.ok(row.last_error?.startsWith('template_render_failed'), `unexpected last_error: ${row.last_error}`);
  assert.deepEqual(getPendingBatch(10), [], 'must not still be sitting pending for the next tick to re-throw on');
});

test('a WhatsApp message stays pending — not sent, not failed — while an active restriction is in force', async () => {
  clear();
  const result = enqueue({
    project: 'store',
    event: 'delivered',
    recipient: '963900000000',
    payload: { order: '1' },
    channel: 'whatsapp',
  });
  const id = (result as { id: number }).id;
  const [msg] = getPendingBatch(1);

  const restricted = {
    ...alwaysOpen,
    activeEnforcement: () => ({ type: 'RESTRICT_ALL_COMPANIONS' as const, endsAtMs: Date.now() + 60_000 }),
  };
  const attempted = await processMessage(msg, restricted);

  assert.equal(attempted, false);
  assert.deepEqual(
    getPendingBatch(10).map((m) => m.id),
    [id],
    'left pending for the next tick — this is the check that used to run only once per batch',
  );
});

test('a WhatsApp message stays pending while the hourly send-rate ceiling is exceeded', async () => {
  clear();
  enqueue({ project: 'store', event: 'delivered', recipient: '963900000000', payload: { order: '1' }, channel: 'whatsapp' });
  const [msg] = getPendingBatch(1);

  const overCeiling = { ...alwaysOpen, checkSendRate: () => ({ allowed: false }) };
  const attempted = await processMessage(msg, overCeiling);

  assert.equal(attempted, false);
  assert.equal(getPendingBatch(10).length, 1, 'still pending, not failed');
});

test('a WhatsApp message is attempted (not blocked) once connected, unrestricted, and under the ceiling', async () => {
  clear();
  enqueue({ project: 'store', event: 'delivered', recipient: '963900000000', payload: { order: '1' }, channel: 'whatsapp' });
  const [msg] = getPendingBatch(1);

  // No real Baileys socket exists in this test process, so the send itself
  // fails — but the point here is that it was ATTEMPTED (returns true, and
  // is no longer sitting untouched), proving the gate did not block it.
  const attempted = await processMessage(msg, alwaysOpen);
  assert.equal(attempted, true, 'the gate must not block a healthy, unrestricted, under-ceiling connection');
});
