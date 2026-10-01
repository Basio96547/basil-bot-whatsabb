// The failure this pins: a creds.json that is merely UNREADABLE right now
// (EMFILE from the ~7500-file key folder, a permissions hiccup, the OS busy)
// is not the same as a missing session — prepareSession() already knew this
// and correctly skipped restoring a stale backup over it. But
// connectWhatsApp() used to load an auth state right afterward regardless,
// and useAtomicMultiFileAuthState's own creds read swallows every error
// (including this exact transient one) into a blank identity — which the
// very next creds.update then saves over the real session. connectWhatsApp
// must now abort the whole attempt instead, before ever touching Baileys.
//
// DATA_DIR is redirected before config.ts (and everything importing it) is
// loaded so this runs against a throwaway auth folder, never the real one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-client-'));
// config.ts requires one of these per project in config/projects.json at
// import time, unrelated to anything this file actually tests — on a fresh
// checkout with no .env yet, this file failed before a single test ran.
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';
// Blank, and set before config.ts runs: dotenv never overrides a variable that
// already exists. On the phone, .env holds the real R2 credentials, and without
// this the restore paths below reached the real session-backup bucket (and an
// SMS provider, once one is configured) from a plain `npm test`.
for (const name of ['SMS_PROVIDER', 'SMS_API_URL', 'SMS_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  process.env[name] = '';
}

const {
  prepareSession,
  connectWhatsApp,
  getConnectionState,
  isLinkedIdentity,
  getSocket,
  sendTextAwaitingAck,
  WhatsAppRejectedError,
  setSocketFactoryForTest,
} = await import('./client.ts');

// Every connectWhatsApp() in this file must stop before it opens a socket. One
// that got that far — a regression in any of the guards below — used to reach
// Baileys' real makeWASocket, which dials WhatsApp's servers (and GitHub, for
// the protocol version) from a plain test run. It meets this instead.
const socketsOpened: unknown[] = [];
setSocketFactoryForTest(async (options) => {
  socketsOpened.push(options);
  throw new Error('client.test.ts: a test tried to open a WhatsApp socket');
});
test.after(() => {
  assert.equal(socketsOpened.length, 0, 'no test here may open a WhatsApp socket');
});

const AUTH_DIR = path.join(process.env.DATA_DIR, 'auth-session');

test('prepareSession reports "missing" when there is no session and nothing to restore from', async () => {
  assert.equal(await prepareSession(), 'missing');
});

test('prepareSession reports "unreadable" for a creds.json that exists but cannot be read right now, and does not treat it as missing', async () => {
  // A directory in place of the file is a portable, deterministic way to hit
  // a read error that is NOT ENOENT (EISDIR here) — the same "exists but is
  // momentarily unreadable" shape as the real-world EMFILE this guards
  // against, without depending on a platform-specific permission trick.
  mkdirSync(path.join(AUTH_DIR, 'creds.json'), { recursive: true });

  const probe = await prepareSession();
  assert.equal(probe, 'unreadable');
  assert.ok(getConnectionState().sessionNote?.includes('تعذّر قراءة'), 'السبب يجب أن يُسجَّل بوضوح');
});

test('connectWhatsApp aborts BEFORE loading or generating an auth state when creds.json is merely unreadable', async () => {
  // Still the directory-in-place-of-a-file from the previous test. If this
  // guard were missing, connectWhatsApp would proceed to
  // useAtomicMultiFileAuthState and hit the same EISDIR independently. That
  // read now throws on its own too (it used to fall back to a blank
  // identity), but this guard is what stops the attempt before it reaches
  // Baileys at all — asserted here by its own message.
  await assert.rejects(() => connectWhatsApp(), /تعذّرت قراءته مؤقتاً/);
});

// The false "needs a QR scan" at every boot: Baileys sets creds.registered
// only for a pairing-CODE link, so a healthy QR-paired session (this one:
// registered=false, `me` present) was reported as needing re-pairing on every
// connect and reconnect.
test('a QR-paired session counts as linked even though Baileys leaves registered=false', () => {
  const me = { id: '963900000000:12@s.whatsapp.net', name: 'x' };
  const account = {} as NonNullable<Parameters<typeof isLinkedIdentity>[0]['account']>;
  assert.equal(isLinkedIdentity({ me, account }), true);
  assert.equal(isLinkedIdentity({ me: undefined, account: undefined }), false);
  // requestPairingCode() writes `me` before the code is ever entered.
  assert.equal(isLinkedIdentity({ me, account: undefined }), false);
});

test('during an active WhatsApp restriction, an unpaired identity is not even offered a QR', async () => {
  const { rmSync } = await import('node:fs');
  const { recordEnforcement } = await import('./enforcement.ts');
  const { db } = await import('../db.ts');
  rmSync(path.join(AUTH_DIR, 'creds.json'), { recursive: true, force: true });
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs: Date.now() + 60 * 60_000 });
  try {
    await connectWhatsApp(); // must return without opening a socket
    assert.equal(socketsOpened.length, 0);
    assert.throws(() => getSocket(), /not initialized/);
    const state = getConnectionState();
    assert.equal(state.needsReauth, true);
    assert.ok(state.sessionNote?.includes('لن يُعرض QR'), state.sessionNote ?? '');
  } finally {
    db.exec('DELETE FROM account_enforcement');
  }
});

// ---- a send is only a send once WhatsApp's server has acknowledged it ----

/** A stand-in for the two socket methods sendTextAwaitingAck uses. */
function fakeSocket(ack: (id: string) => { attrs: Record<string, string> } | undefined, opts: { ackBeforeSendResolves?: boolean } = {}) {
  const waiters = new Map<string, (node: unknown) => void>();
  const sent: Array<{ jid: string; text: string; messageId: string }> = [];
  const sock = {
    user: { id: '963900000000:1@s.whatsapp.net' },
    waitForMessage: <T>(id: string) =>
      new Promise<T | undefined>((resolve) => waiters.set(id, resolve as (node: unknown) => void)),
    sendMessage: async (jid: string, content: { text: string }, options: { messageId: string }) => {
      sent.push({ jid, text: content.text, messageId: options.messageId });
      const reply = () => waiters.get(options.messageId)?.(ack(options.messageId));
      if (opts.ackBeforeSendResolves) reply();
      else setImmediate(reply);
      return undefined;
    },
  };
  return { sock: sock as unknown as Parameters<typeof sendTextAwaitingAck>[0], sent };
}

test('a send resolves once the server acknowledges that very message id', async () => {
  const { sock, sent } = fakeSocket((id) => ({ attrs: { id, class: 'message' } }));
  await sendTextAwaitingAck(sock, '963900000001@s.whatsapp.net', 'hi');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].messageId, 'the id is chosen up front so the wait can be registered before the send');
});

test('an ack that arrives before sendMessage itself returns is not missed', async () => {
  const { sock } = fakeSocket((id) => ({ attrs: { id } }), { ackBeforeSendResolves: true });
  await sendTextAwaitingAck(sock, '963900000001@s.whatsapp.net', 'hi');
});

test('a 463 error ack (account restricted) is a permanent rejection, not a success', async () => {
  const { sock } = fakeSocket((id) => ({ attrs: { id, error: '463' } }));
  await assert.rejects(
    () => sendTextAwaitingAck(sock, '963900000001@s.whatsapp.net', 'hi'),
    (err: unknown) => err instanceof WhatsAppRejectedError && err.permanent && err.code === '463',
  );
});

test('another error ack is a failure worth retrying, not a success', async () => {
  const { sock } = fakeSocket((id) => ({ attrs: { id, error: '479' } }));
  await assert.rejects(
    () => sendTextAwaitingAck(sock, '963900000001@s.whatsapp.net', 'hi'),
    (err: unknown) => err instanceof WhatsAppRejectedError && !err.permanent,
  );
});

test('no ack at all (a half-open socket swallowed the stanza) is a failure, not a success', async () => {
  const { sock } = fakeSocket(() => undefined);
  await assert.rejects(() => sendTextAwaitingAck(sock, '963900000001@s.whatsapp.net', 'hi'), /no_server_ack/);
});
