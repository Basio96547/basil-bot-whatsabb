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
// config.ts requires one of these per project in config/projects.json at
// import time, unrelated to anything this file actually tests — on a fresh
// checkout with no .env yet, this file failed before a single test ran.
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { enqueue, getPendingBatch, supersedePending, markSentIfStillPending, markSent } = await import('./queue.ts');
const { processMessage, defaultGateDeps, withTimeout } = await import('./worker.ts');
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

test('a WhatsApp message stays pending — and is not charged an attempt — while disconnected and unforced', async () => {
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

  // Regression: resolveChannel() used to run unconditionally, calling
  // Baileys' onWhatsApp() (needs a live socket) even while disconnected.
  // getSocket() would throw synchronously here (no test socket exists),
  // which the old code counted as a channel_resolution_error attempt — so a
  // reconnect flap could burn all 5 tries before the socket ever came back.
  const disconnected = { ...alwaysOpen, isConnected: () => false };
  const attempted = await processMessage(msg, disconnected);

  assert.equal(attempted, false);
  const row = rowOf(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, 'a disconnect must not spend one of the 5 attempts');
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

test('a message superseded after its batch was read is not sent', async () => {
  // The batch is read up to a whole round of pacing delays before a row's
  // turn comes; a newer code for the same number can supersede it meanwhile.
  clear();
  enqueue({ project: 'store', event: 'otp', recipient: '963900000100', payload: { code: '111111' }, channel: 'whatsapp' });
  const [msg] = getPendingBatch(1);
  supersedePending('store', '963900000100', 'otp');

  const attempted = await processMessage(msg, alwaysOpen);
  assert.equal(attempted, false, 'must not go out');
  assert.equal(rowOf(msg.id).status, 'failed');
  assert.equal(rowOf(msg.id).last_error, 'superseded');
});

test('a message that expires before it is sent is marked as never sent, so the daily cap can refund it', async () => {
  clear();
  enqueue({ project: 'store', event: 'delivered', recipient: '963900000101', payload: { order: '1' }, ttlMinutes: 1 });
  db.exec(`UPDATE messages SET expires_at = datetime('now', '-1 minutes')`);
  const [msg] = getPendingBatch(1);
  await processMessage(msg, alwaysOpen);
  const row = db.prepare('SELECT status, last_error, dropped_unsent FROM messages WHERE id = ?').get(msg.id) as {
    status: string;
    last_error: string;
    dropped_unsent: number;
  };
  assert.deepEqual({ ...row }, { status: 'failed', last_error: 'expired_before_send', dropped_unsent: 1 });
});

test('rows forced onto a blocked channel do not fill the batch and hide the rows behind them', () => {
  clear();
  for (let i = 0; i < 3; i++) {
    enqueue({ project: 'store', event: 'delivered', recipient: `96390000020${i}`, payload: { order: '1' }, channel: 'whatsapp' });
  }
  const free = enqueue({ project: 'store', event: 'delivered', recipient: '963900000209', payload: { order: '1' } });
  assert.equal(getPendingBatch(3).length, 3);
  assert.deepEqual(
    getPendingBatch(3, ['whatsapp']).map((m) => m.id),
    [(free as { id: number }).id],
    'only the auto-routed row is fetched while WhatsApp is blocked',
  );
});

test('a send that completes after its timeout is recorded as sent — once — instead of being retried into a duplicate', () => {
  clear();
  const queued = enqueue({ project: 'store', event: 'delivered', recipient: '963900000300', payload: { order: '1' } });
  const id = (queued as { id: number }).id;
  assert.equal(markSentIfStillPending(id, 'whatsapp', 0), true);
  assert.equal(rowOf(id).status, 'sent');
  assert.equal(markSentIfStillPending(id, 'whatsapp', 0), false, 'already recorded — a no-op');

  const other = enqueue({ project: 'store', event: 'delivered', recipient: '963900000301', payload: { order: '1' } });
  const otherId = (other as { id: number }).id;
  markSent(otherId, 'whatsapp', 0); // a retry got there first
  assert.equal(markSentIfStillPending(otherId, 'whatsapp', 1), false);
});

// resolveChannel() routes to Baileys' onWhatsApp(), which has no timeout of
// its own — a hung lookup used to block a whole batch of messages
// indefinitely, unlike every other outbound call on this path. The real
// SEND_TIMEOUT_MS is 15s (too slow to exercise directly here), so this pins
// the shared withTimeout() mechanism itself with a short ms value instead.
test('withTimeout rejects a promise that never settles, instead of hanging forever', async () => {
  const neverSettles = new Promise<void>(() => {});
  await assert.rejects(() => withTimeout(neverSettles, 50), /timeout/);
});

test('withTimeout resolves normally when the underlying promise settles first', async () => {
  const fast = Promise.resolve('ok');
  assert.equal(await withTimeout(fast, 50), 'ok');
});
