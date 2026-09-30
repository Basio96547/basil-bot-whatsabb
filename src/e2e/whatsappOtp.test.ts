// End to end: an activation code requested over HTTP, through the real queue
// and worker, out of the real WhatsApp send path (JID, ack, retries), into a
// customer's chat — and back in through /otp/verify. Same for password reset.
//
// The ONLY stand-in is the Baileys socket itself (client.ts's
// setSocketFactoryForTest): it records every message that would have gone to
// WhatsApp and answers the way WhatsApp's servers do (an ack, an error ack,
// no ack, "not on WhatsApp", a dropped connection). Everything above it —
// express, auth, OTP issue/verify, SQLite queue, worker loop, connection
// handling, reconnects, restriction handling — is the production code.
//
// Nothing here may reach the outside world: no WhatsApp server, no SMS
// provider, no R2 bucket, no real phone number. Two layers make sure of it:
// every outbound connection that is not loopback throws (installed before any
// application module loads), and the SMS/R2 settings are blanked before
// config.ts can read a real .env.
//
// Time: there is no injectable clock — the code reads Date.now() in JS and
// datetime('now') in SQLite. Elapsed time is simulated the way the other
// tests here do it, by moving a number's stored timestamps back (`elapse`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// ---- 1. no connection may leave this machine -------------------------------

const blockedConnections: string[] = [];

function guardOutbound(module: Record<string, unknown>, name: string): void {
  const original = module[name] as (...args: unknown[]) => unknown;
  module[name] = function guarded(this: unknown, ...args: unknown[]) {
    const [first, second] = args;
    let host: string | undefined;
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; hostname?: string; path?: string };
      host = options.path ? undefined : (options.host ?? options.hostname ?? 'localhost');
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      host = typeof second === 'string' ? second : 'localhost';
    }
    if (host !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      blockedConnections.push(`${name} → ${host}`);
      throw new Error(`e2e test: outbound connection to ${host} blocked — nothing here may leave this machine`);
    }
    return original.apply(this, args);
  };
}
guardOutbound(net as unknown as Record<string, unknown>, 'connect');
guardOutbound(net as unknown as Record<string, unknown>, 'createConnection');
guardOutbound(tls as unknown as Record<string, unknown>, 'connect');

// ---- 2. configuration, before config.ts reads it ---------------------------

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-e2e-'));
process.env.PROJECT_API_KEY_STORE = 'e2e-store-key-not-real';
process.env.PROJECT_API_KEY_QAREEB = 'e2e-qareeb-key-not-real';
process.env.PROJECT_API_KEY_FIREWORKS = 'e2e-fireworks-key-not-real';
process.env.OTP_HASH_SECRET = 'e2e-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY = 'e2e-backup-passphrase';
// Blank, and set before config.ts runs: dotenv never overrides a variable that
// already exists, so a real .env on this machine cannot switch on a real SMS
// provider or a real R2 bucket for this test.
for (const name of ['SMS_PROVIDER', 'SMS_API_URL', 'SMS_API_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  process.env[name] = '';
}
// The 3–9 s human pacing between sends is anti-ban behaviour, not what this
// test is about — at full length the file would take minutes.
process.env.SEND_MIN_DELAY_MS = '0';
process.env.SEND_MAX_DELAY_MS = '0';

// A linked (already QR-paired) identity on disk, so the service logs in rather
// than asking for a QR. Obviously fake: country code 999 does not exist.
const FAKE_SENDER_JID = '999000000001:1@s.whatsapp.net';
const AUTH_DIR = path.join(process.env.DATA_DIR, 'auth-session');
{
  const { initAuthCreds, BufferJSON } = await import('@whiskeysockets/baileys');
  const creds = { ...initAuthCreds(), me: { id: FAKE_SENDER_JID, name: 'e2e stand-in' }, account: { details: Buffer.from('e2e') } };
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
}

const { config, getProjectById, repoRoot } = await import('../config.ts');
const { db } = await import('../db.ts');
const { createServer } = await import('../http/server.ts');
const { startWorker, stopWorker } = await import('../queue/worker.ts');
const { notifyWork } = await import('../queue/wakeup.ts');
const { startWhatsApp, getConnectionState, setSocketFactoryForTest } = await import('../whatsapp/client.ts');
const { variantsFor } = await import('../templates/templates.ts');
type WASocket = import('@whiskeysockets/baileys').WASocket;

const store = getProjectById('store')!;
const qareeb = getProjectById('qareeb')!;
const KEYS = { store: store.apiKey, qareeb: qareeb.apiKey };

// ---- 3. the stand-in WhatsApp ----------------------------------------------

/** How WhatsApp's server answers the next message: accepted, refused with an error code, or never acknowledged. */
type ServerAnswer = 'ack' | 'no_ack' | { errorAck: string };

interface Stanza {
  jid: string;
  text: string;
  messageId: string;
  answer: ServerAnswer;
}

function connectionClosed(): Error {
  // Baileys' own shape: a Boom whose output.statusCode is 428.
  return Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
}

class FakeWhatsApp {
  readonly sockets: FakeSocket[] = [];
  /** Every message handed to WhatsApp, in order, with how the server answered it. */
  readonly stanzas: Stanza[] = [];
  /** Every number asked about via onWhatsApp. */
  readonly lookups: string[] = [];
  readonly notOnWhatsApp = new Set<string>();
  /** Numbers whose existence query WhatsApp never answers. */
  readonly unanswered = new Set<string>();
  /** Answers for the next sends, in order; afterwards every send is acknowledged. */
  readonly nextAnswers: ServerAnswer[] = [];
  accountLockQueries = 0;
  readonly socketOptions: unknown[] = [];

  get current(): FakeSocket {
    const socket = this.sockets.at(-1);
    assert.ok(socket, 'the service has not opened a WhatsApp socket');
    return socket;
  }

  /** What actually reached the customer: messages the server accepted. */
  delivered(jid: string): Stanza[] {
    return this.stanzas.filter((s) => s.jid === jid && s.answer === 'ack');
  }

  handedOver(jid: string): Stanza[] {
    return this.stanzas.filter((s) => s.jid === jid);
  }
}

class FakeSocket {
  readonly ev = new EventEmitter();
  readonly ws = new EventEmitter();
  readonly user = { id: FAKE_SENDER_JID };
  closed = true; // until WhatsApp reports the connection open
  ended = false;
  private readonly acks = new Map<string, (node: unknown) => void>();

  constructor(private readonly wa: FakeWhatsApp) {}

  // -- the surface client.ts / existence.ts use --

  async onWhatsApp(...numbers: string[]): Promise<Array<{ jid: string; exists: boolean }> | undefined> {
    if (this.closed) throw connectionClosed();
    const asked = numbers.map((n) => n.replace('+', '').split('@')[0]);
    this.wa.lookups.push(...asked);
    // Baileys (rc14) does not throw when WhatsApp leaves its query unanswered:
    // waitForMessage swallows the timeout, and onWhatsApp resolves undefined.
    if (asked.some((digits) => this.wa.unanswered.has(digits))) return undefined;
    // Numbers that are not on WhatsApp are dropped from the list entirely.
    return asked.flatMap((digits) => (this.wa.notOnWhatsApp.has(digits) ? [] : [{ jid: `${digits}@s.whatsapp.net`, exists: true }]));
  }

  waitForMessage<T>(messageId: string): Promise<T | undefined> {
    return new Promise((resolve) => this.acks.set(messageId, resolve as (node: unknown) => void));
  }

  async sendMessage(jid: string, content: { text: string }, options: { messageId: string }): Promise<undefined> {
    if (this.closed) throw connectionClosed();
    const answer = this.wa.nextAnswers.shift() ?? 'ack';
    this.wa.stanzas.push({ jid, text: content.text, messageId: options.messageId, answer });
    setImmediate(() => {
      const reply = this.acks.get(options.messageId);
      this.acks.delete(options.messageId);
      if (answer === 'no_ack') reply?.(undefined); // Baileys' wait gives up with undefined
      else if (answer === 'ack') reply?.({ tag: 'ack', attrs: { id: options.messageId, class: 'message' } });
      else reply?.({ tag: 'ack', attrs: { id: options.messageId, class: 'message', error: answer.errorAck } });
    });
    return undefined;
  }

  async fetchAccountReachoutTimelock(): Promise<void> {
    this.wa.accountLockQueries += 1;
  }

  end(): void {
    this.ended = true;
    this.closed = true;
  }

  // -- driving it, the way Baileys reports connection changes --

  open(): void {
    this.closed = false;
    this.ev.emit('connection.update', { connection: 'open' });
  }

  drop(statusCode: number): void {
    this.closed = true;
    this.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: Object.assign(new Error('closed'), { output: { statusCode } }), date: new Date() },
    });
  }

  reportAccountLock(lock: { isActive: boolean; enforcementType?: string; timeEnforcementEnds?: Date }): void {
    this.ev.emit('connection.update', { reachoutTimeLock: lock });
  }
}

const wa = new FakeWhatsApp();
setSocketFactoryForTest(async (options) => {
  wa.socketOptions.push(options);
  const socket = new FakeSocket(wa);
  wa.sockets.push(socket);
  return socket as unknown as WASocket;
});

// ---- 4. boot, as src/index.ts does ------------------------------------------
// (without the daily retention sweep: its setInterval would keep this test
// process alive forever, and retention is not what is under test here)

// The sending account paired long ago, like the live one: the warm-up ceiling
// for a freshly paired number is not what this test is about.
db.prepare(`INSERT INTO session_state (me_id, paired_at) VALUES (?, datetime('now', '-30 days'))`).run(FAKE_SENDER_JID);

const server = http.createServer(createServer());
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
startWorker();
startWhatsApp();

test.after(async () => {
  await stopWorker();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---- helpers -----------------------------------------------------------------

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets the worker run whatever it would run now. */
async function settle(): Promise<void> {
  notifyWork();
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function call(
  method: string,
  urlPath: string,
  opts: { apiKey?: string | null; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = opts.apiKey === undefined ? KEYS.store : opts.apiKey;
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const jidOf = (digits: string) => `${digits}@s.whatsapp.net`;

function messageRow(id: number) {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as {
    status: string;
    attempts: number;
    last_error: string | null;
    channel: string | null;
    payload: string;
    updated_at: string;
    next_attempt_at: string | null;
    dropped_unsent: number;
  };
}

function count(table: string, where: string, ...params: Array<string | number>): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

/** As if `seconds` had passed for everything stored about `phone`. */
function elapse(phone: string, seconds: number): void {
  const back = `-${seconds} seconds`;
  db.prepare(
    `UPDATE otp_codes SET created_at = datetime(created_at, ?1), expires_at = datetime(expires_at, ?1),
       verified_at = datetime(verified_at, ?1), matched_at = datetime(matched_at, ?1) WHERE phone = ?2`,
  ).run(back, phone);
  db.prepare(
    `UPDATE messages SET created_at = datetime(created_at, ?1), updated_at = datetime(updated_at, ?1),
       expires_at = datetime(expires_at, ?1), next_attempt_at = datetime(next_attempt_at, ?1) WHERE recipient = ?2`,
  ).run(back, phone);
  db.prepare(`UPDATE otp_send_log SET created_at = datetime(created_at, ?1) WHERE phone = ?2`).run(back, phone);
  db.prepare(`UPDATE whatsapp_status_cache SET checked_at = datetime(checked_at, ?1) WHERE phone = ?2`).run(back, phone);
  db.prepare(
    `UPDATE reset_tokens SET created_at = datetime(created_at, ?1), expires_at = datetime(expires_at, ?1),
       used_at = datetime(used_at, ?1) WHERE phone = ?2`,
  ).run(back, phone);
}

const RAW_PROJECTS = JSON.parse(readFileSync(path.join(repoRoot, 'config', 'projects.json'), 'utf-8')) as Array<{
  id: string;
  templates?: Record<string, string[]>;
}>;

/**
 * The texts a customer may legitimately receive: every configured variant
 * (the project's own from config/projects.json, else the shared defaults),
 * with brand, code and validity filled in.
 */
function expectedTexts(project: typeof store, event: 'otp' | 'password_reset', code: string): string[] {
  const own = RAW_PROJECTS.find((p) => p.id === project.id)?.templates?.[event];
  const variants = own ?? variantsFor(event)!;
  return variants.map((v) =>
    v
      .replaceAll('{brand}', project.brandName)
      .replaceAll('{code}', code)
      .replaceAll('{expiryMinutes}', String(project.otpExpiryMinutes)),
  );
}

/** Pulls the code out of a delivered message, checking the message on the way. */
function codeFrom(project: typeof store, event: 'otp' | 'password_reset', text: string): string {
  assert.doesNotMatch(text, /\{\w+\}/, `a placeholder reached the customer: ${text}`);
  const sixes = (text.match(/\d+/g) ?? []).filter((group) => group.length === 6);
  assert.equal(sixes.length, 1, `expected exactly one 6-digit code in: ${text}`);
  const code = sixes[0];
  assert.ok(
    expectedTexts(project, event, code).includes(text),
    `not one of ${project.id}'s configured ${event} variants: ${JSON.stringify(text)}`,
  );
  return code;
}

/** Requests a code and returns it as the customer reads it in WhatsApp. */
async function requestAndReceive(
  project: typeof store,
  to: string,
  flow: 'otp' | 'password-reset' = 'otp',
): Promise<{ id: number; code: string; text: string }> {
  const before = wa.delivered(jidOf(to)).length;
  const res = await call('POST', `/${flow}/request`, { apiKey: project.apiKey, body: { to } });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.status, 'queued');
  const id = res.json.id as number;
  const stanza = await waitFor(`message ${id} delivered to ${to}`, () => wa.delivered(jidOf(to))[before]);
  const event = flow === 'otp' ? 'otp' : 'password_reset';
  await waitFor(`message ${id} recorded as sent`, () => messageRow(id).status === 'sent');
  return { id, code: codeFrom(project, event, stanza.text), text: stanza.text };
}

const wrongCodeFor = (code: string) => (code === '000000' ? '111111' : '000000');

// ---- the tests -----------------------------------------------------------------

test('boot: the service logs in over the stand-in socket and reports WhatsApp connected', async () => {
  await waitFor('the service to open its WhatsApp socket', () => wa.sockets.length === 1);
  const options = wa.socketOptions[0] as { markOnlineOnConnect?: boolean; auth?: { creds?: { me?: { id?: string } } } };
  assert.equal(options.markOnlineOnConnect, false, 'the anti-ban socket options still reach the socket');
  assert.equal(options.auth?.creds?.me?.id, FAKE_SENDER_JID, 'logged in with the paired identity, not a fresh QR one');

  wa.current.open();
  await waitFor('connected', () => getConnectionState().connected);
  const health = await call('GET', '/health');
  assert.equal(health.status, 200, JSON.stringify(health.json));
  assert.deepEqual(health.json.reasons, []);
});

test('Saudi number (9665…): the code reaches the right JID in a configured variant, verifies, and cannot be replayed once the grace window is over', async () => {
  const to = '966500000101';
  const { id, code, text } = await requestAndReceive(store, to);

  assert.equal(wa.delivered(jidOf(to)).length, 1);
  assert.equal(wa.handedOver(jidOf(to))[0].jid, '966500000101@s.whatsapp.net');
  assert.ok(text.includes(store.brandName), text);
  assert.ok(wa.lookups.includes(to), 'the number was checked for WhatsApp before sending');

  const status = await call('GET', `/status/${id}`);
  assert.deepEqual(
    { status: status.json.status, channel: status.json.channel, event: status.json.event, recipient: status.json.recipient },
    { status: 'sent', channel: 'whatsapp', event: 'otp', recipient: to },
  );

  const ok = await call('POST', '/otp/verify', { body: { to, code } });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);

  // README: the same correct code stays accepted for two minutes after use
  // (a verification whose answer was lost) — then never again.
  const retry = await call('POST', '/otp/verify', { body: { to, code } });
  assert.equal(retry.status, 200, 'lost-response retry within the grace window');
  elapse(to, 121);
  const replay = await call('POST', '/otp/verify', { body: { to, code } });
  assert.deepEqual([replay.status, replay.json.error], [400, 'not_found_or_expired']);
});

test("Syrian number (9639…) on a project with its own templates: the text is exactly one of that project's configured variants", async () => {
  assert.ok(RAW_PROJECTS.find((p) => p.id === 'qareeb')?.templates?.otp?.length, 'premise: qareeb configures its own otp wording');
  const to = '963900000102';
  const { code, text } = await requestAndReceive(qareeb, to);
  assert.equal(wa.handedOver(jidOf(to))[0].jid, '963900000102@s.whatsapp.net');
  assert.ok(text.includes(qareeb.brandName), text);

  const ok = await call('POST', '/otp/verify', { apiKey: KEYS.qareeb, body: { to, code } });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
});

test('the code is accepted as the customer types or pastes it: Arabic-Indic digits, or the whole WhatsApp message', async () => {
  const toA = '966500000131';
  const a = await requestAndReceive(store, toA);
  const arabic = a.code.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const typed = await call('POST', '/otp/verify', { body: { to: toA, code: arabic } });
  assert.equal(typed.status, 200, JSON.stringify(typed.json));

  const toB = '963900000132';
  const b = await requestAndReceive(qareeb, toB);
  const pasted = await call('POST', '/otp/verify', { apiKey: KEYS.qareeb, body: { to: toB, code: b.text } });
  assert.equal(pasted.status, 200, JSON.stringify(pasted.json));
});

test('numbers outside the documented format (+, local 0…, 00…, Arabic-Indic digits, spaces) are refused and nothing is issued or sent', async () => {
  const before = { codes: count('otp_codes', '1'), messages: count('messages', '1'), stanzas: wa.stanzas.length };
  for (const to of ['+966500000103', '0500000103', '00966500000103', '٩٦٦٥٠٠٠٠٠٠١٠٣', '966 500 000 103', '+963900000103', '0900000103']) {
    for (const flow of ['otp', 'password-reset']) {
      const res = await call('POST', `/${flow}/request`, { body: { to } });
      assert.deepEqual([res.status, res.json.error], [400, 'invalid_recipient_format'], `${flow} ${to}`);
    }
  }
  await settle();
  assert.deepEqual({ codes: count('otp_codes', '1'), messages: count('messages', '1'), stanzas: wa.stanzas.length }, before);
});

test('a wrong code is invalid_code with the attempts left; the attempt cap locks the code even for the right one; a new request then sends a fresh code', async () => {
  const to = '966500000104';
  const { code } = await requestAndReceive(store, to);
  const wrong = wrongCodeFor(code);

  for (let left = store.otpMaxAttempts - 1; left >= 0; left--) {
    const res = await call('POST', '/otp/verify', { body: { to, code: wrong } });
    assert.deepEqual([res.status, res.json], [400, { error: 'invalid_code', attemptsRemaining: left }]);
  }
  const locked = await call('POST', '/otp/verify', { body: { to, code } });
  assert.deepEqual([locked.status, locked.json.error], [400, 'too_many_attempts']);

  // Still inside the resend cooldown: the dead code is not pointed at again.
  const fresh = await requestAndReceive(store, to);
  assert.notEqual(fresh.code, undefined);
  assert.equal(wa.delivered(jidOf(to)).length, 2);
  const ok = await call('POST', '/otp/verify', { body: { to, code: fresh.code } });
  assert.equal(ok.status, 200);
});

test('a second request inside the cooldown answers alreadySent with expiresInSeconds — and no second message goes out; once the code is spent it is a plain cooldown', async () => {
  const to = '963900000105';
  const { code } = await requestAndReceive(store, to);

  const again = await call('POST', '/otp/request', { body: { to } });
  assert.equal(again.status, 202);
  assert.equal(again.json.alreadySent, true);
  const expiresIn = again.json.expiresInSeconds as number;
  assert.ok(expiresIn > 0 && expiresIn <= store.otpExpiryMinutes * 60, `expiresInSeconds ${expiresIn}`);
  await settle();
  assert.equal(count('messages', 'recipient = ?', to), 1, 'nothing new was queued');
  assert.equal(wa.handedOver(jidOf(to)).length, 1, 'nothing new was sent');

  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
  const cooldown = await call('POST', '/otp/request', { body: { to } });
  assert.equal(cooldown.status, 429);
  assert.equal(cooldown.json.error, 'cooldown');
  const retryAfter = cooldown.json.retryAfterSeconds as number;
  assert.ok(retryAfter > 0 && retryAfter <= store.resendCooldownMinutes * 60, `retryAfterSeconds ${retryAfter}`);
  await settle();
  assert.equal(wa.handedOver(jidOf(to)).length, 1);
});

test('a code lives exactly the configured minutes: accepted just before, refused just after', async () => {
  const lifetime = store.otpExpiryMinutes * 60;
  const early = '966500000106';
  const late = '966500000107';
  const a = await requestAndReceive(store, early);
  const b = await requestAndReceive(store, late);

  const stored = db
    .prepare(`SELECT CAST(round((julianday(expires_at) - julianday(created_at)) * 86400) AS INTEGER) AS s FROM otp_codes WHERE phone = ?`)
    .get(late) as { s: number };
  assert.ok(stored.s === lifetime || stored.s === lifetime + 1, `stored lifetime ${stored.s}s`);

  elapse(early, lifetime - 5);
  assert.equal((await call('POST', '/otp/verify', { body: { to: early, code: a.code } })).status, 200);

  elapse(late, lifetime + 2);
  const expired = await call('POST', '/otp/verify', { body: { to: late, code: b.code } });
  assert.deepEqual([expired.status, expired.json.error], [400, 'not_found_or_expired']);
});

test('no key, an unknown key, or a malformed Authorization header is refused before anything is issued or sent', async () => {
  const to = '966500000108';
  const before = { codes: count('otp_codes', '1'), messages: count('messages', '1'), stanzas: wa.stanzas.length };
  const cases: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['unknown key', { authorization: 'Bearer not-a-real-key' }],
    ['key without Bearer', { authorization: KEYS.store }],
    ['empty bearer', { authorization: 'Bearer ' }],
  ];
  for (const flow of ['otp', 'password-reset']) {
    for (const [label, auth] of cases) {
      const res = await fetch(`${BASE}/${flow}/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ to }),
      });
      assert.equal(res.status, 401, `${flow}: ${label}`);
      assert.deepEqual(await res.json(), { error: 'invalid_or_missing_api_key' });
    }
  }
  const verify = await call('POST', '/otp/verify', { apiKey: null, body: { to, code: '123456' } });
  assert.equal(verify.status, 401);
  await settle();
  assert.deepEqual({ codes: count('otp_codes', '1'), messages: count('messages', '1'), stanzas: wa.stanzas.length }, before);
});

test("projects are isolated: another project's key can neither verify the code nor see its message, and the code still works for its own project", async () => {
  const to = '963900000109';
  const { id, code } = await requestAndReceive(store, to);

  const foreign = await call('POST', '/otp/verify', { apiKey: KEYS.qareeb, body: { to, code } });
  assert.deepEqual([foreign.status, foreign.json.error], [400, 'not_found_or_expired']);
  assert.equal((await call('GET', `/status/${id}`, { apiKey: KEYS.qareeb })).status, 404);

  // The other project has its own bucket for the same number: a fresh code, not "already sent".
  const other = await requestAndReceive(qareeb, to);
  assert.notEqual(other.id, id);

  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
  const qareebStill = await call('POST', '/otp/verify', { apiKey: KEYS.qareeb, body: { to, code: other.code } });
  assert.equal(qareebStill.status, 200, "one project's success does not spend the other's code");
});

test('WhatsApp drops: the code waits pending without spending an attempt, then goes out exactly once after the reconnect', async () => {
  const to = '966500000110';
  const first = wa.current;
  first.drop(428); // connectionClosed — an ordinary network drop
  await waitFor('disconnected', () => !getConnectionState().connected);

  const health = await call('GET', '/health');
  assert.equal(health.status, 503);
  assert.ok((health.json.reasons as string[]).includes('whatsapp_disconnected'));

  const res = await call('POST', '/otp/request', { body: { to } });
  assert.equal(res.status, 202, 'a plain drop usually heals in seconds — the request is accepted');
  const id = res.json.id as number;
  await settle();
  assert.deepEqual({ status: messageRow(id).status, attempts: messageRow(id).attempts }, { status: 'pending', attempts: 0 });
  assert.equal(wa.handedOver(jidOf(to)).length, 0);

  // The service reconnects on its own (5 s on the first step of its backoff).
  await waitFor('a reconnect attempt', () => wa.sockets.length === 2, 10_000);
  assert.equal(first.ended, true, 'the dead socket is closed, not leaked');
  wa.current.open();

  const stanza = await waitFor('delivery after the reconnect', () => wa.delivered(jidOf(to))[0]);
  await waitFor('recorded as sent', () => messageRow(id).status === 'sent');
  assert.equal(wa.handedOver(jidOf(to)).length, 1, 'sent once — nothing was attempted while the socket was down');
  const code = codeFrom(store, 'otp', stanza.text);
  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
});

test('a message WhatsApp does not accept (no ack, then an error ack) is never recorded as sent: it is retried on the documented delays, then delivered', async () => {
  const to = '963900000111';
  wa.nextAnswers.push('no_ack', { errorAck: '479' });
  const res = await call('POST', '/otp/request', { body: { to } });
  const id = res.json.id as number;

  await waitFor('first attempt', () => messageRow(id).attempts === 1);
  let row = messageRow(id);
  assert.deepEqual({ status: row.status, last_error: row.last_error }, { status: 'pending', last_error: 'no_server_ack' });
  const firstDelay = db.prepare(`SELECT CAST(round((julianday(next_attempt_at) - julianday(updated_at)) * 86400) AS INTEGER) AS s FROM messages WHERE id = ?`);
  const d1 = (firstDelay.get(id) as { s: number }).s;
  assert.ok(d1 >= 30 && d1 <= 31, `first retry after ${d1}s (README: 30 s)`);
  assert.equal((await call('GET', `/status/${id}`)).json.status, 'pending');

  await settle();
  assert.equal(wa.handedOver(jidOf(to)).length, 1, 'not retried before its time');

  elapse(to, 31);
  notifyWork();
  await waitFor('second attempt', () => messageRow(id).attempts === 2);
  row = messageRow(id);
  assert.deepEqual({ status: row.status, last_error: row.last_error }, { status: 'pending', last_error: 'whatsapp_rejected_479' });
  const d2 = (firstDelay.get(id) as { s: number }).s;
  assert.ok(d2 >= 60 && d2 <= 61, `second retry after ${d2}s (README: 1 min)`);

  elapse(to, 61);
  notifyWork();
  await waitFor('delivered on the third attempt', () => messageRow(id).status === 'sent');
  assert.equal(wa.delivered(jidOf(to)).length, 1);
  // Each attempt is rendered afresh, so the wording may differ; the code may not.
  const codes = wa.handedOver(jidOf(to)).map((s) => codeFrom(store, 'otp', s.text));
  assert.equal(codes.length, 3);
  assert.equal(new Set(codes).size, 1, `every attempt carries the same code: ${codes.join(', ')}`);
  const code = codes[2];
  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
});

test('WhatsApp refusing the account (463) fails the message at once and asks for the account lock; while locked, /otp/request is 503 and issues nothing; after the lift codes flow again', async () => {
  const to = '966500000112';
  wa.nextAnswers.push({ errorAck: '463' });
  const res = await call('POST', '/otp/request', { body: { to } });
  const id = res.json.id as number;
  await waitFor('permanent failure', () => messageRow(id).status === 'failed');
  const row = messageRow(id);
  assert.deepEqual({ attempts: row.attempts, last_error: row.last_error }, { attempts: 1, last_error: 'whatsapp_rejected_463' });
  assert.equal(wa.accountLockQueries, 1);
  assert.equal((await call('GET', `/status/${id}`)).json.last_error, 'whatsapp_rejected_463');

  elapse(to, 300);
  await settle();
  assert.equal(wa.handedOver(jidOf(to)).length, 1, 'never retried — every retry deepens the restriction');

  // WhatsApp's answer to the query: the whole account is restricted for hours.
  wa.current.reportAccountLock({ isActive: true, enforcementType: 'RESTRICT_ALL_COMPANIONS', timeEnforcementEnds: new Date(Date.now() + 6 * 3600_000) });
  const health = await call('GET', '/health');
  assert.ok((health.json.reasons as string[]).includes('account_restricted'));

  const blockedTo = '966500000113';
  const before = { codes: count('otp_codes', '1'), messages: count('messages', '1') };
  const refused = await call('POST', '/otp/request', { body: { to: blockedTo } });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error, 'delivery_unavailable');
  assert.ok((refused.json.retryAfterSeconds as number) > 5 * 3600);
  assert.deepEqual({ codes: count('otp_codes', '1'), messages: count('messages', '1') }, before, 'no code issued, no quota spent');

  wa.current.reportAccountLock({ isActive: false });
  const after = await requestAndReceive(store, '966500000114');
  assert.equal((await call('POST', '/otp/verify', { body: { to: '966500000114', code: after.code } })).status, 200);
});

test('a number that is not on WhatsApp (no SMS provider configured): nothing is sent, /status says no_channel_available, the daily allowance is not charged, and the number is re-checked after an hour', async () => {
  const to = '963900000115';
  wa.notOnWhatsApp.add(to);
  const first = await call('POST', '/otp/request', { body: { to } });
  const id = first.json.id as number;
  await waitFor('dropped', () => messageRow(id).status === 'failed');
  assert.deepEqual(
    { last_error: messageRow(id).last_error, dropped_unsent: messageRow(id).dropped_unsent },
    { last_error: 'no_channel_available', dropped_unsent: 1 },
  );
  assert.equal((await call('GET', `/status/${id}`)).json.last_error, 'no_channel_available');
  assert.equal(wa.handedOver(jidOf(to)).length, 0);

  // Inside the cooldown, but the first code can never arrive: a fresh one, not "already sent".
  const second = await call('POST', '/otp/request', { body: { to } });
  assert.equal(second.status, 202);
  assert.equal(second.json.status, 'queued');
  await waitFor('dropped too', () => messageRow(second.json.id as number).status === 'failed');
  assert.equal(wa.lookups.filter((n) => n === to).length, 1, 'a negative answer is cached, not asked again at once');

  // The customer installs WhatsApp; an hour later the number is checked again.
  wa.notOnWhatsApp.delete(to);
  elapse(to, 3601);
  const { code } = await requestAndReceive(store, to);
  assert.equal(wa.lookups.filter((n) => n === to).length, 2);
  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
});

// Plan 4.6: when the existence check itself fails, WhatsApp is tried anyway.
// On this phone's stalling link the check's usual way of failing is no answer
// at all — Baileys' 60 s query timeout comes before a dead socket is noticed.
test('an existence check WhatsApp never answers is not taken for "not on WhatsApp": the code still goes out, and no verdict is cached against the number', async () => {
  const to = '963900000124';
  wa.unanswered.add(to);
  const res = await call('POST', '/otp/request', { body: { to } });
  const id = res.json.id as number;
  await waitFor(`message ${id} to leave the queue`, () => messageRow(id).status !== 'pending');
  assert.deepEqual({ status: messageRow(id).status, last_error: messageRow(id).last_error }, { status: 'sent', last_error: null });
  assert.equal(wa.lookups.filter((n) => n === to).length, 1, 'it was asked');
  assert.equal(count('whatsapp_status_cache', 'phone = ?', to), 0, 'an unanswered question is not an answer');

  const code = codeFrom(store, 'otp', wa.delivered(jidOf(to))[0].text);
  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
});

test('password reset: delivered with the reset wording, verifies into a single-use token, and the code cannot mint another after the reset', async () => {
  for (const [project, to] of [[store, '966500000116'], [qareeb, '963900000117']] as const) {
    const { code } = await requestAndReceive(project, to, 'password-reset');
    assert.equal(wa.delivered(jidOf(to))[0].jid, `${to}@s.whatsapp.net`);

    const loginVerify = await call('POST', '/otp/verify', { apiKey: project.apiKey, body: { to, code } });
    assert.equal(loginVerify.status, 400, 'a reset code is not a login code');

    const verified = await call('POST', '/password-reset/verify', { apiKey: project.apiKey, body: { to, code } });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    const token = verified.json.resetToken as string;
    assert.match(token, /^[0-9a-f]{64}$/);

    const foreignToken = await call('POST', '/password-reset/validate-token', {
      apiKey: project === store ? KEYS.qareeb : KEYS.store,
      body: { token },
    });
    assert.equal(foreignToken.status, 400, "another project's key cannot spend the token");

    const claimed = await call('POST', '/password-reset/validate-token', { apiKey: project.apiKey, body: { token } });
    assert.deepEqual([claimed.status, claimed.json], [200, { ok: true, phone: to }]);
    const again = await call('POST', '/password-reset/validate-token', { apiKey: project.apiKey, body: { token } });
    assert.deepEqual([again.status, again.json.error], [400, 'not_found_or_expired']);
    const replay = await call('POST', '/password-reset/verify', { apiKey: project.apiKey, body: { to, code } });
    assert.deepEqual([replay.status, replay.json.error], [400, 'not_found_or_expired']);
  }
});

test('password reset: wrong codes, the attempt cap, the cooldown (alreadySent, nothing sent), expiry, and cross-project isolation', async () => {
  const to = '966500000118';
  const { code } = await requestAndReceive(store, to, 'password-reset');

  const again = await call('POST', '/password-reset/request', { body: { to } });
  assert.deepEqual([again.status, again.json.alreadySent], [202, true]);
  assert.ok((again.json.expiresInSeconds as number) > 0);
  await settle();
  assert.equal(wa.handedOver(jidOf(to)).length, 1, 'no second message');

  const foreign = await call('POST', '/password-reset/verify', { apiKey: KEYS.qareeb, body: { to, code } });
  assert.deepEqual([foreign.status, foreign.json.error], [400, 'not_found_or_expired']);

  const wrong = wrongCodeFor(code);
  for (let left = store.otpMaxAttempts - 1; left >= 0; left--) {
    const res = await call('POST', '/password-reset/verify', { body: { to, code: wrong } });
    assert.deepEqual([res.status, res.json], [400, { error: 'invalid_code', attemptsRemaining: left }]);
  }
  const locked = await call('POST', '/password-reset/verify', { body: { to, code } });
  assert.deepEqual([locked.status, locked.json.error], [400, 'too_many_attempts']);

  const late = '963900000119';
  const expiring = await requestAndReceive(store, late, 'password-reset');
  elapse(late, store.otpExpiryMinutes * 60 + 2);
  const expired = await call('POST', '/password-reset/verify', { body: { to: late, code: expiring.code } });
  assert.deepEqual([expired.status, expired.json.error], [400, 'not_found_or_expired']);

  const noKey = await call('POST', '/password-reset/verify', { apiKey: null, body: { to, code } });
  assert.equal(noKey.status, 401);
});

test('five codes actually delivered to one number in a day is the cap: the sixth request is 429 daily_limit and sends nothing', async () => {
  const to = '966500000120';
  let last = '';
  for (let i = 0; i < store.otpMaxPerDay; i++) {
    ({ code: last } = await requestAndReceive(store, to));
    elapse(to, store.resendCooldownMinutes * 60 + 1);
  }
  const capped = await call('POST', '/otp/request', { body: { to } });
  assert.deepEqual([capped.status, capped.json.error], [429, 'daily_limit']);
  assert.ok((capped.json.retryAfterSeconds as number) > 23 * 3600);
  await settle();
  assert.equal(wa.handedOver(jidOf(to)).length, store.otpMaxPerDay);
  assert.equal((await call('POST', '/otp/verify', { body: { to, code: last } })).status, 200);
});

// Plan 4.3: codes are stored only as a hash, so that someone holding the
// database cannot read a live code and use it. Plan 10: a code is not kept
// once it is used or expired. The queued message is the one place the code
// must exist in the clear — until it has been delivered.
test('a delivered code is not left readable in the database — the sent message keeps no copy, while the customer\'s still works', async () => {
  const to = '966500000123';
  const { id, code } = await requestAndReceive(store, to);
  const { payload } = messageRow(id);
  assert.ok(!payload.includes(code), `the sent message still stores the live code: ${payload}`);
  assert.equal((await call('POST', '/otp/verify', { body: { to, code } })).status, 200);
});

// Runs late on purpose: five consecutive failures trip the circuit breaker,
// which then pauses WhatsApp for every later test in this file.
test('a message that keeps failing is tried five times on the documented delays, then marked failed — never sent', async () => {
  const to = '963900000121';
  for (let i = 0; i < 5; i++) wa.nextAnswers.push({ errorAck: '479' });
  const res = await call('POST', '/otp/request', { body: { to } });
  const id = res.json.id as number;

  const delay = db.prepare(`SELECT CAST(round((julianday(next_attempt_at) - julianday(updated_at)) * 86400) AS INTEGER) AS s FROM messages WHERE id = ?`);
  for (const [attempt, seconds] of [[1, 30], [2, 60], [3, 120], [4, 240]] as const) {
    await waitFor(`attempt ${attempt}`, () => messageRow(id).attempts === attempt);
    const s = (delay.get(id) as { s: number }).s;
    assert.ok(s >= seconds && s <= seconds + 1, `retry ${attempt} after ${s}s, expected ${seconds}s`);
    assert.equal(messageRow(id).status, 'pending');
    elapse(to, seconds + 1);
    notifyWork();
  }
  await waitFor('given up', () => messageRow(id).status === 'failed');
  assert.deepEqual(
    { attempts: messageRow(id).attempts, last_error: messageRow(id).last_error },
    { attempts: 5, last_error: 'whatsapp_rejected_479' },
  );
  assert.equal(wa.handedOver(jidOf(to)).length, 5);
  assert.equal(wa.delivered(jidOf(to)).length, 0);
  // Five failures in a row also pause the channel — visible to the monitor.
  const health = await call('GET', '/health');
  assert.ok((health.json.reasons as string[]).includes('channel_paused'), JSON.stringify(health.json.reasons));
});

test('no message that has left the queue in this whole run — sent, failed, refused, dropped — still holds a code', () => {
  const leftovers = db
    .prepare(`SELECT id, status, last_error FROM messages WHERE status != 'pending' AND json_extract(payload, '$.code') IS NOT NULL`)
    .all();
  assert.deepEqual(leftovers.map((row) => ({ ...row })), []);
});

test('logged out (the device was unlinked): /health asks for a QR and /otp/request is 503 without issuing a code', async () => {
  wa.current.drop(401);
  await waitFor('needs reauth', () => getConnectionState().needsReauth);
  const health = await call('GET', '/health');
  assert.ok((health.json.reasons as string[]).includes('whatsapp_needs_reauth'));

  const before = { codes: count('otp_codes', '1'), messages: count('messages', '1'), stanzas: wa.stanzas.length };
  for (const flow of ['otp', 'password-reset']) {
    const res = await call('POST', `/${flow}/request`, { body: { to: '966500000122' } });
    assert.deepEqual([res.status, res.json.error], [503, 'delivery_unavailable'], flow);
  }
  assert.deepEqual({ codes: count('otp_codes', '1'), messages: count('messages', '1'), stanzas: wa.stanzas.length }, before);
});

test('nothing in this file tried to leave the machine, and the guard really blocks', () => {
  assert.deepEqual(blockedConnections, [], 'some code path tried to reach a real server');
  assert.throws(() => net.connect({ host: '192.0.2.1', port: 443 }), /blocked/); // TEST-NET-1
  assert.throws(() => tls.connect({ host: 'web.whatsapp.com', port: 443 }), /blocked/);
  blockedConnections.length = 0;
  assert.equal(config.sms.enabled, false);
  assert.equal(config.sessionBackup.enabled, false);
});
