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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-queue-'));
process.env.QUEUE_MAX_PENDING = '5';
process.env.QUEUE_MAX_PENDING_PER_PROJECT = '3';
// config.ts requires one of these per project in config/projects.json at
// import time, unrelated to anything this file actually tests — on a fresh
// checkout with no .env yet, this file failed before a single test ran.
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const {
  enqueue,
  markSent,
  markSentLate,
  markFailedPermanently,
  dropUnsent,
  supersedePending,
  expireOverdue,
  recordFailedAttempt,
  deferMessage,
} = await import('./queue.ts');
const { db, scrubCodesFromFinishedMessages, truncateWal } = await import('../db.ts');

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

// ---- a verification code lives in the queue only until its message is done ----
//
// Plan 4.3 stores codes only as a hash so that a copy of the database cannot
// hand out live codes; plan 10 keeps no code after it is used or expired. The
// queued message is the one place a code has to exist in the clear — for as
// long as it may still be sent.

function queueCode(event: 'otp' | 'password_reset' = 'otp', recipient = '963900000050'): number {
  const result = enqueue({ project: 'store', event, recipient, payload: { code: '482913' } });
  assert.equal(result.ok, true);
  return (result as { id: number }).id;
}

function storedPayload(id: number): Record<string, unknown> {
  return JSON.parse((db.prepare('SELECT payload FROM messages WHERE id = ?').get(id) as { payload: string }).payload);
}

test('every way a code message leaves the queue — sent, failed, dropped, superseded, expired — takes the code with it', () => {
  const finish: Array<[string, (id: number) => void]> = [
    ['sent', (id) => markSent(id, 'whatsapp', 0)],
    ['sent after a late ack', (id) => assert.equal(markSentLate(id, 'whatsapp', 0), true)],
    ['failed for good', (id) => markFailedPermanently(id, 'whatsapp_rejected_463')],
    ['dropped unsent', (id) => dropUnsent(id, 'no_channel_available')],
    ['superseded', () => assert.equal(supersedePending('store', '963900000050', 'otp'), 1)],
    ['expired', (id) => {
      db.prepare(`UPDATE messages SET expires_at = datetime('now', '-1 minutes') WHERE id = ?`).run(id);
      assert.equal(expireOverdue(), 1);
    }],
  ];
  for (const [how, done] of finish) {
    clear();
    const id = queueCode();
    done(id);
    assert.notEqual((db.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string }).status, 'pending', how);
    assert.deepEqual(storedPayload(id), {}, `${how}: the code is still stored`);
  }

  clear();
  const reset = queueCode('password_reset');
  markSent(reset, 'whatsapp', 0);
  assert.deepEqual(storedPayload(reset), {}, 'password-reset codes too');
});

// The row forgetting its code is not enough: the file must not keep a copy.
// A row that changes size is rewritten elsewhere in its page, and the slot it
// left keeps the old bytes — code included — unless something reuses it, which
// a newer row below it in the page prevents. db.ts's secure_delete zeroes the
// slot; truncateWal empties the WAL that held the row while it waited.
test('a finished code leaves no copy in the database files, also when a newer message sits after it in the page', () => {
  const dbFile = path.join(process.env.DATA_DIR!, 'sms-api.db');
  const onDisk = (code: string) =>
    [dbFile, `${dbFile}-wal`].some((file) => existsSync(file) && readFileSync(file).includes(Buffer.from(`"code":"${code}"`)));
  const finish: Array<[string, string, (id: number) => void]> = [
    ['sent', '615203', (id) => markSent(id, 'whatsapp', 0)],
    ['failed for good', '615204', (id) => markFailedPermanently(id, 'whatsapp_rejected_463')],
    ['dropped unsent', '615205', (id) => dropUnsent(id, 'template_render_failed: no variant fits the payload')],
  ];
  for (const [how, code, done] of finish) {
    clear();
    const queued = enqueue({ project: 'store', event: 'otp', recipient: '963900000056', payload: { code } });
    assert.equal(queued.ok, true);
    enqueue({ project: 'store', event: 'order_created', recipient: '963900000057', payload: { order: '1', amount: '2' } });
    truncateWal(); // as after any checkpoint: the waiting row is in the database file itself
    assert.equal(onDisk(code), true, `${how}: premise — a waiting code is stored`);

    done((queued as { id: number }).id);
    truncateWal();
    assert.equal(onDisk(code), false, `${how}: the code is still readable in the database files`);
  }
});

test('a code message that is still waiting keeps its code — a retry has to render it again', () => {
  clear();
  const failedOnce = queueCode('otp', '963900000051');
  recordFailedAttempt(failedOnce, 'whatsapp', 'no_server_ack', 30_000);
  const deferred = queueCode('otp', '963900000052');
  deferMessage(deferred, 'channel_resolution_error', 60_000);
  assert.deepEqual(storedPayload(failedOnce), { code: '482913' });
  assert.deepEqual(storedPayload(deferred), { code: '482913' });
});

test('codes an older version left in finished messages are removed, and nothing else in those payloads is touched', () => {
  clear();
  // Rows exactly as the previous version left them: finished, code still inside.
  const insert = db.prepare(
    `INSERT INTO messages (project, event, recipient, payload, status) VALUES ('store', ?, '963900000053', ?, ?)`,
  );
  const sent = Number(insert.run('otp', '{"code":"482913"}', 'sent').lastInsertRowid);
  const failed = Number(insert.run('password_reset', '{"code":"482913"}', 'failed').lastInsertRowid);
  const waiting = Number(insert.run('otp', '{"code":"482913"}', 'pending').lastInsertRowid);
  const order = Number(insert.run('order_created', '{"order":"7","amount":"5"}', 'sent').lastInsertRowid);

  scrubCodesFromFinishedMessages();

  assert.deepEqual(storedPayload(sent), {});
  assert.deepEqual(storedPayload(failed), {});
  assert.deepEqual(storedPayload(waiting), { code: '482913' }, 'still to be sent');
  assert.deepEqual(storedPayload(order), { order: '7', amount: '5' });
});

test('a row whose payload is not JSON still changes status, and the cleanup passes over it instead of failing the boot', () => {
  clear();
  const id = Number(
    db.prepare(`INSERT INTO messages (project, event, recipient, payload) VALUES ('store', 'otp', '963900000054', 'not json')`).run()
      .lastInsertRowid,
  );
  dropUnsent(id, 'template_render_failed');
  assert.equal((db.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string }).status, 'failed');
  assert.equal(scrubCodesFromFinishedMessages(), 0);
});

test('a message sent after failed attempts keeps no error from them', () => {
  clear();
  const id = queueCode('otp', '963900000055');
  recordFailedAttempt(id, 'whatsapp', 'no_server_ack', 0);
  markSent(id, 'whatsapp', 0);
  const row = db.prepare('SELECT status, attempts, last_error FROM messages WHERE id = ?').get(id);
  assert.deepEqual({ ...(row as object) }, { status: 'sent', attempts: 1, last_error: null });
});
