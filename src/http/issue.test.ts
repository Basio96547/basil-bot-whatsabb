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
function issue(phone: string): 'queued' | 'rejected' {
  return issueAndQueue(store, phone, 'otp', store.otpExpiryMinutes).kind;
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
