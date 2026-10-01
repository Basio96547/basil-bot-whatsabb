// The WhatsApp existence lookup (plan 4.6) with Baileys' real timing.
//
// Baileys does not fail a usync query WhatsApp leaves unanswered: it waits
// out its own defaultQueryTimeoutMs (60 s — client.ts does not change it) and
// then resolves onWhatsApp() with undefined. The worker stops waiting for the
// lookup long before that (SEND_TIMEOUT_MS, 15 s) and defers the message as
// channel_resolution_error — so before the lookup had a deadline of its own,
// an unanswered number was never tried on WhatsApp at all: the message was
// deferred and asked about again every ~75 s until it expired.
//
// The socket is a stand-in installed through client.ts's test seam; nothing
// here can reach WhatsApp. Waits are scaled down through the worker's own
// sendTimeoutMs, which is what the lookup's deadline is derived from.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONNECTION_CONFIG, initAuthCreds, BufferJSON, type WASocket } from '@whiskeysockets/baileys';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-existence-'));
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';
for (const name of ['SMS_PROVIDER', 'SMS_API_URL', 'SMS_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  process.env[name] = '';
}

// A linked identity on disk, so connectWhatsApp() logs in instead of asking for a QR.
const SENDER = '999000000001:1@s.whatsapp.net';
{
  const dir = path.join(process.env.DATA_DIR, 'auth-session');
  mkdirSync(dir, { recursive: true });
  const creds = { ...initAuthCreds(), me: { id: SENDER }, account: { details: Buffer.from('test') } };
  writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
}

const { db } = await import('../db.ts');
const { checkWhatsAppExists } = await import('./existence.ts');
const { connectWhatsApp, setSocketFactoryForTest } = await import('./client.ts');
const { enqueue, getPendingBatch } = await import('../queue/queue.ts');
const { processMessage, defaultGateDeps } = await import('../queue/worker.ts');

/** How the stand-in WhatsApp answers an existence query for a number. */
type Answer = 'exists' | 'absent' | 'never' | 'undefined_now' | 'throws';
const answers = new Map<string, Answer>();
const lookups: string[] = [];
const sends: string[] = [];

// What Baileys does with a query nobody answers: nothing until its own query
// timeout, then undefined. Settled early once the tests are done, so the file
// does not sit out the minute.
const BAILEYS_QUERY_TIMEOUT_MS = DEFAULT_CONNECTION_CONFIG.defaultQueryTimeoutMs!;
const openQueries = new Set<() => void>();
function unansweredQuery(): Promise<undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(settle, BAILEYS_QUERY_TIMEOUT_MS);
    function settle() {
      clearTimeout(timer);
      openQueries.delete(settle);
      resolve(undefined);
    }
    openQueries.add(settle);
  });
}
test.after(() => {
  for (const settle of [...openQueries]) settle();
});

setSocketFactoryForTest(async () => {
  const acks = new Map<string, (node: unknown) => void>();
  return {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    user: { id: SENDER },
    end() {},
    async onWhatsApp(phone: string) {
      lookups.push(phone);
      switch (answers.get(phone) ?? 'exists') {
        case 'exists':
          return [{ jid: `${phone}@s.whatsapp.net`, exists: true }];
        case 'absent':
          return [];
        case 'never':
          return unansweredQuery();
        case 'undefined_now':
          return undefined;
        case 'throws':
          throw new Error('Connection Closed');
      }
    },
    waitForMessage: (id: string) => new Promise((resolve) => acks.set(id, resolve)),
    async sendMessage(jid: string, _content: unknown, options: { messageId: string }) {
      sends.push(jid);
      setImmediate(() => acks.get(options.messageId)?.({ tag: 'ack', attrs: { id: options.messageId } }));
    },
    async fetchAccountReachoutTimelock() {},
  } as unknown as WASocket;
});
await connectWhatsApp();

const cached = (phone: string) => db.prepare('SELECT has_whatsapp FROM whatsapp_status_cache WHERE phone = ?').get(phone);

test('a lookup WhatsApp never answers is "unknown" by its own deadline — not after Baileys gives up a minute later — and is not cached', { timeout: 5_000 }, async () => {
  const phone = '963911000001';
  answers.set(phone, 'never');
  const started = Date.now();
  assert.equal(await checkWhatsAppExists(phone, 100), 'unknown');
  const took = Date.now() - started;
  assert.ok(took >= 90 && took < 2_000, `answered after ${took} ms`);
  assert.equal(cached(phone), undefined, 'no answer is not an answer');
});

test('Baileys resolving undefined straight away is "unknown" too, and not cached', async () => {
  const phone = '963911000002';
  answers.set(phone, 'undefined_now');
  assert.equal(await checkWhatsAppExists(phone, 100), 'unknown');
  assert.equal(cached(phone), undefined);
});

test('a lookup that throws is "unknown"; real answers are cached either way', async () => {
  answers.set('963911000003', 'throws');
  assert.equal(await checkWhatsAppExists('963911000003', 100), 'unknown');
  assert.equal(cached('963911000003'), undefined);

  answers.set('963911000004', 'exists');
  assert.equal(await checkWhatsAppExists('963911000004', 100), 'yes');
  assert.deepEqual({ ...(cached('963911000004') as object) }, { has_whatsapp: 1 });

  answers.set('963911000005', 'absent');
  assert.equal(await checkWhatsAppExists('963911000005', 100), 'no');
  assert.deepEqual({ ...(cached('963911000005') as object) }, { has_whatsapp: 0 });
});

// The reviewer's reproduction, kept: before the fix every pass below deferred
// the message (channel_resolution_error) and asked WhatsApp again, and nothing
// was ever sent.
test('the worker sends a message whose lookup goes unanswered on its first pass — no deferral, and no second lookup', { timeout: 5_000 }, async () => {
  const phone = '963911000006';
  answers.set(phone, 'never');
  const queued = enqueue({ project: 'store', event: 'delivered', recipient: phone, payload: { order: '7' } });
  assert.ok(queued.ok);
  // The real gate, send path and lookup; only the socket's connection state is
  // given (opening it would also start the 30 s session-backup timer), and the
  // worker's wait is scaled down from 15 s.
  const deps = { ...defaultGateDeps, isConnected: () => true, sendTimeoutMs: 300 };

  for (let pass = 1; pass <= 3; pass++) {
    db.exec(`UPDATE messages SET next_attempt_at = NULL WHERE status = 'pending'`);
    const [msg] = getPendingBatch(10).filter((m) => m.recipient === phone);
    if (!msg) break; // nothing left to send
    await processMessage(msg, deps);
  }

  const row = { ...(db.prepare('SELECT status, attempts, last_error, next_attempt_at FROM messages WHERE id = ?').get(queued.id) as object) };
  assert.deepEqual(row, { status: 'sent', attempts: 0, last_error: null, next_attempt_at: null });
  assert.deepEqual(sends, [`${phone}@s.whatsapp.net`], 'tried on WhatsApp, as plan 4.6 says for a lookup that fails');
  assert.equal(lookups.filter((n) => n === phone).length, 1, 'asked once');
  assert.equal(cached(phone), undefined);
});
