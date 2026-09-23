// The failure this pins: issuing a code and queueing its message used to be
// two separate commits. When the queue refused the message, the code row and
// the daily-quota row were already written — so the caller got "try later"
// while holding a code that was never sent, one of its few daily codes gone,
// and an unexpired code blocking every retry for the whole resend cooldown.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-issue-'));
// config.ts requires one of these per project in config/projects.json at
// import time, unrelated to anything this file actually tests — on a fresh
// checkout with no .env yet, this file failed before a single test ran.
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { db, inTransaction } = await import('../db.ts');
const { generateOtp } = await import('../otp/otp.ts');
const { issueAndQueue } = await import('./routes.ts');
const { getProjectById, config } = await import('../config.ts');

const store = getProjectById('store')!;

function clear(): void {
  db.exec('DELETE FROM otp_codes; DELETE FROM otp_send_log; DELETE FROM messages;');
}

function counts(): { codes: number; sendLog: number; messages: number } {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    codes: one('SELECT COUNT(*) AS n FROM otp_codes'),
    sendLog: one('SELECT COUNT(*) AS n FROM otp_send_log'),
    messages: one('SELECT COUNT(*) AS n FROM messages'),
  };
}

/** Exercises the real route helper, not a copy of it. */
function issue(phone: string): 'queued' | 'already_sent' | 'unavailable' | 'rejected' {
  return issueAndQueue(store, phone, 'otp', store.otpExpiryMinutes).kind;
}

/** Moves every code and message for the test past the resend cooldown. */
function pastCooldown(): void {
  const seconds = store.resendCooldownMinutes * 60 + 1;
  db.exec(`UPDATE otp_codes SET created_at = datetime(created_at, '-${seconds} seconds')`);
  db.exec(`UPDATE messages SET created_at = datetime(created_at, '-${seconds} seconds')`);
}

test('a successful issue leaves exactly one code, one quota row and one queued message', () => {
  clear();
  assert.equal(issue('963900001001'), 'queued');
  assert.deepEqual(counts(), { codes: 1, sendLog: 1, messages: 1 });
});

test('a refused queue leaves NO code and NO quota row behind', () => {
  clear();

  // Fill the queue past its cap so enqueue() refuses the next message.
  const filler = db.prepare(
    `INSERT INTO messages (project, event, recipient, payload, status) VALUES (?, 'otp', ?, '{}', 'pending')`,
  );
  for (let i = 0; i < config.queue.maxPending; i++) filler.run(store.id, `96390000${2000 + i}`);

  const before = counts();
  assert.equal(issue('963900001002'), 'rejected');
  const after = counts();

  assert.equal(after.codes, before.codes, 'لا يجوز أن يبقى رمز لم يُرسل');
  assert.equal(after.sendLog, before.sendLog, 'لا يجوز أن تُحرق خانة من الحصة اليومية');
  assert.equal(after.messages, before.messages, 'لا رسالة جديدة');
});

test('after a refused queue the customer can still request a code once there is room', () => {
  // The real damage was here: the leftover unexpired code made generateOtp
  // answer `cooldown` on every retry, so the customer was locked out for the
  // full resend window having received nothing.
  clear();
  const filler = db.prepare(
    `INSERT INTO messages (project, event, recipient, payload, status) VALUES (?, 'otp', ?, '{}', 'pending')`,
  );
  for (let i = 0; i < config.queue.maxPending; i++) filler.run(store.id, `96390000${3000 + i}`);

  assert.equal(issue('963900001003'), 'rejected');

  // Queue drains (the worker sends what was pending).
  db.exec("UPDATE messages SET status = 'sent'");

  assert.equal(issue('963900001003'), 'queued', 'يجب أن يستطيع طلب رمز جديد فوراً');
});

test('a repeat request while a live code exists reports already_sent, not a cooldown error', () => {
  // The recovery path for a request that SUCCEEDED but timed out at the
  // caller: the clients give up after 8s and this phone's network is
  // documented to stall for minutes, so the site can report failure while the
  // code is on its way. The retry must say "you already have one", not
  // "you asked recently, wait" — and must not send a second message or spend
  // another of the day's codes.
  clear();
  assert.equal(issue('963900001010'), 'queued');
  const before = counts();

  const outcome = issueAndQueue(store, '963900001010', 'otp', store.otpExpiryMinutes);
  assert.equal(outcome.kind, 'already_sent');
  assert.ok(outcome.kind === 'already_sent' && outcome.expiresInSeconds > 0, 'يخبر بالمدة المتبقية للرمز');

  assert.deepEqual(counts(), before, 'لا رسالة جديدة ولا خانة حصة مستهلكة');
});

test('a spent code falls back to a plain cooldown, not already_sent', () => {
  // Once the code has been used, "you already have one" would be a lie — the
  // customer has nothing usable, and the cooldown is the honest answer.
  clear();
  assert.equal(issue('963900001011'), 'queued');
  db.exec("UPDATE otp_codes SET verified_at = datetime('now')");

  const outcome = issueAndQueue(store, '963900001011', 'otp', store.otpExpiryMinutes);
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.kind === 'rejected' && outcome.error, 'cooldown');
});

test('a repeat request gets a FRESH code when the original message already failed permanently, instead of promising one that is never coming', () => {
  clear();
  assert.equal(issue('963900001020'), 'queued');

  // Simulate the queued message failing permanently before the cooldown ends
  // (no_channel_available, five exhausted attempts, a template render
  // failure...) — generateOtp's already_sent branch used to have no way to
  // know this and would keep telling the customer "check WhatsApp, it's on
  // its way" for the whole cooldown window.
  db.exec("UPDATE messages SET status = 'failed'");

  const before = counts();
  const outcome = issueAndQueue(store, '963900001020', 'otp', store.otpExpiryMinutes);
  assert.equal(outcome.kind, 'queued', 'الرمز السابق لن يصل أبداً، فيجب إصدار رمز جديد فوراً لا انتظار العميل');

  const after = counts();
  assert.equal(after.codes, before.codes + 1, 'رمز جديد فعلاً، لا إعادة تدوير القديم');
  assert.equal(after.sendLog, before.sendLog + 1);
  assert.equal(after.messages, before.messages + 1);
});

test('a repeat request also gets a fresh code when the original message is stuck pending too long — a WhatsApp outage, not a permanent failure, never marks it "failed"', () => {
  clear();
  assert.equal(issue('963900001022'), 'queued');

  // The message never fails during an outage — it just sits 'pending' for as
  // long as WhatsApp is down, an enforcement is active, or the send-rate
  // ceiling holds (see worker.ts's per-message gate). Backdating created_at
  // simulates it having sat there past the "stalled" threshold.
  db.exec("UPDATE messages SET created_at = datetime('now', '-11 minutes')");

  const outcome = issueAndQueue(store, '963900001022', 'otp', store.otpExpiryMinutes);
  assert.equal(outcome.kind, 'queued', 'عالق منذ وقت طويل بلا فشل صريح — يجب ألا يُعامَل كأنه سيصل');
});

test('a message that is merely pending and still recent is left alone — already_sent, not a fresh code', () => {
  clear();
  assert.equal(issue('963900001023'), 'queued');
  // No time has passed and nothing failed — this must behave exactly as
  // before this fix existed.
  const outcome = issueAndQueue(store, '963900001023', 'otp', store.otpExpiryMinutes);
  assert.equal(outcome.kind, 'already_sent');
});

test('the daily cap still applies even when failed messages keep forcing fresh codes', () => {
  clear();
  for (let i = 0; i < store.otpMaxPerDay; i++) {
    assert.equal(issue('963900001021'), 'queued', `send ${i + 1} of the daily allowance`);
    db.exec("UPDATE messages SET status = 'failed' WHERE status = 'pending'");
  }
  const blocked = issueAndQueue(store, '963900001021', 'otp', store.otpExpiryMinutes);
  assert.equal(blocked.kind, 'rejected');
  assert.equal(
    blocked.kind === 'rejected' && blocked.error,
    'daily_limit',
    'الرسائل الفاشلة تُحسب من الحصة اليومية تماماً كالناجحة — تجاوز الانتظار لا يعني تجاوز السقف',
  );
});

test('an expired code also falls back to a plain cooldown', () => {
  clear();
  assert.equal(issue('963900001012'), 'queued');
  db.exec("UPDATE otp_codes SET expires_at = datetime('now', '-1 minutes')");

  const outcome = issueAndQueue(store, '963900001012', 'otp', store.otpExpiryMinutes);
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.kind === 'rejected' && outcome.error, 'cooldown');
});

test('the day\'s last code, still on its way, is reported already_sent — not daily_limit', () => {
  // A request that succeeded but timed out at the caller may be the day's
  // last allowed one. Checking the cap first answered "try again tomorrow"
  // while that very code was arriving.
  clear();
  const phone = '963900001030';
  for (let i = 0; i < store.otpMaxPerDay - 1; i++) {
    assert.equal(issue(phone), 'queued');
    db.exec("UPDATE messages SET status = 'failed' WHERE status = 'pending'");
  }
  assert.equal(issue(phone), 'queued'); // the 5th — pending, fresh
  assert.equal(issue(phone), 'already_sent');
});

test('an outage does not burn the daily allowance: retries supersede each other and only the newest code waits', () => {
  // Before: every retry past the cooldown queued another code AND charged the
  // cap — five retries during a WhatsApp drop left the customer locked out
  // for 24 hours with nothing ever delivered, and when WhatsApp returned all
  // five stale codes went out at once.
  clear();
  const phone = '963900001031';
  const outcomes: string[] = [];
  for (let i = 0; i < store.otpMaxPerDay + 3; i++) {
    outcomes.push(issue(phone));
    pastCooldown(); // WhatsApp is down: nothing is ever sent
  }
  assert.ok(outcomes.every((o) => o === 'queued'), `outcomes: ${outcomes.join(', ')}`);

  const pending = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'`).get() as { n: number };
  assert.equal(pending.n, 1, 'only the newest code is still waiting to go out');
  const superseded = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE last_error = 'superseded' AND dropped_unsent = 1`)
    .get() as { n: number };
  assert.equal(superseded.n, store.otpMaxPerDay + 2);
});

test('a genuine delivery attempt that failed still counts against the cap — only never-sent messages are refunded', () => {
  clear();
  const phone = '963900001032';
  for (let i = 0; i < store.otpMaxPerDay; i++) {
    assert.equal(issue(phone), 'queued');
    // Five real attempts reached the network and failed (maybe delivered late).
    db.exec("UPDATE messages SET status = 'failed', attempts = 4, last_error = 'timeout' WHERE status = 'pending'");
    pastCooldown();
  }
  const blocked = issueAndQueue(store, phone, 'otp', store.otpExpiryMinutes);
  assert.equal(blocked.kind === 'rejected' && blocked.error, 'daily_limit');
});

test('a code message outlives the code by nothing: it is dropped a margin before the code expires', () => {
  clear();
  assert.equal(issue('963900001033'), 'queued');
  const row = db
    .prepare(`SELECT (julianday(expires_at) - julianday(created_at)) * 1440 AS minutes FROM messages`)
    .get() as { minutes: number };
  assert.ok(row.minutes < store.otpExpiryMinutes, `message lives ${row.minutes} min, code lives ${store.otpExpiryMinutes}`);
  assert.ok(row.minutes >= 1);
});

test('during a WhatsApp restriction longer than a code lives, the request is refused honestly and spends nothing', async () => {
  const { recordEnforcement } = await import('../whatsapp/enforcement.ts');
  clear();
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs: Date.now() + 6 * 60 * 60_000 });
  try {
    const outcome = issueAndQueue(store, '963900001034', 'otp', store.otpExpiryMinutes);
    assert.equal(outcome.kind, 'unavailable');
    assert.ok(outcome.kind === 'unavailable' && (outcome.retryAfterSeconds ?? 0) > 5 * 60 * 60);
    assert.deepEqual(counts(), { codes: 0, sendLog: 0, messages: 0 });
  } finally {
    db.exec('DELETE FROM account_enforcement');
  }
});

test('a restriction ending before the code would expire does not refuse the request', async () => {
  const { recordEnforcement } = await import('../whatsapp/enforcement.ts');
  clear();
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs: Date.now() + 60_000 });
  try {
    assert.equal(issue('963900001035'), 'queued');
  } finally {
    db.exec('DELETE FROM account_enforcement');
  }
});

test('a throw inside the transaction rolls back too', () => {
  clear();
  assert.throws(() =>
    inTransaction(() => {
      generateOtp(store, '963900001004', 'login');
      throw new Error('boom');
    }),
  );
  assert.deepEqual(counts(), { codes: 0, sendLog: 0, messages: 0 });
});
