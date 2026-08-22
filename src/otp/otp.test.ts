// The daily cap is the last line of defence for the sending WhatsApp number:
// the cooldown alone still permits a message every few minutes forever. These
// tests pin the two things that make it a real cap — that it counts sends
// which outlive the codes themselves, and that it isolates projects.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-otp-'));

const { generateOtp, verifyOtp } = await import('./otp.ts');
const { db } = await import('../db.ts');
const { getProjectById } = await import('../config.ts');

const store = getProjectById('store')!;
const qareeb = getProjectById('qareeb')!;

function clear(): void {
  db.exec('DELETE FROM otp_codes; DELETE FROM otp_send_log;');
}

// Requests bypassing the resend cooldown, to isolate the daily cap from it.
function requestIgnoringCooldown(project: typeof store, phone: string, times: number): void {
  for (let i = 0; i < times; i++) {
    const result = generateOtp(project, phone);
    assert.equal(result.ok, true, `request ${i + 1} should have been allowed`);
    db.exec('DELETE FROM otp_codes'); // clears the cooldown's "latest" row, not the send log
  }
}

test('every project ships a daily cap — an absent one would silently mean unlimited', () => {
  assert.ok(store.otpMaxPerDay > 0);
  assert.ok(qareeb.otpMaxPerDay > 0);
});

test('the cap blocks the request after the allowance is used up', () => {
  clear();
  requestIgnoringCooldown(store, '963900000001', store.otpMaxPerDay);

  const blocked = generateOtp(store, '963900000001');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, 'daily_limit');
});

test('the cap survives the codes being purged — otherwise retention resets it', () => {
  clear();
  requestIgnoringCooldown(store, '963900000002', store.otpMaxPerDay);

  // retention.ts purges spent/expired codes an hour later. Counting those rows
  // would hand the abuser a fresh allowance every hour.
  db.exec('DELETE FROM otp_codes');

  const blocked = generateOtp(store, '963900000002');
  assert.equal(blocked.ok === false && blocked.reason, 'daily_limit');
});

test('the retry delay points at when the window frees up, not a flat guess', () => {
  clear();
  requestIgnoringCooldown(store, '963900000003', store.otpMaxPerDay);

  const blocked = generateOtp(store, '963900000003');
  assert.equal(blocked.ok, false);
  if (blocked.ok === false) {
    // Close to a full day, since the oldest send just happened.
    assert.ok(blocked.retryAfterSeconds > 23 * 3600, `got ${blocked.retryAfterSeconds}`);
    assert.ok(blocked.retryAfterSeconds <= 24 * 3600);
  }
});

test('one project exhausting its cap does not block another', () => {
  clear();
  requestIgnoringCooldown(store, '963900000004', store.otpMaxPerDay);
  assert.equal(generateOtp(store, '963900000004').ok, false);

  // Same number, different tenant — a shared counter would let one store's
  // traffic lock customers out of the other.
  assert.equal(generateOtp(qareeb, '963900000004').ok, true);
});

test('the cap is per number', () => {
  clear();
  requestIgnoringCooldown(store, '963900000005', store.otpMaxPerDay);
  assert.equal(generateOtp(store, '963900000005').ok, false);
  assert.equal(generateOtp(store, '963900000006').ok, true);
});

test('a code still verifies normally under the cap, and only once', () => {
  clear();
  const generated = generateOtp(store, '963900000007');
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  assert.deepEqual(verifyOtp(store, '963900000007', generated.code), { ok: true });
  // Replaying a spent code must not pass.
  assert.equal(verifyOtp(store, '963900000007', generated.code).ok, false);
});

test('a wrong code is rejected and counts against the attempt limit', () => {
  clear();
  const generated = generateOtp(store, '963900000008');
  assert.equal(generated.ok, true);

  const wrong = verifyOtp(store, '963900000008', '000000');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.reason, 'invalid_code');
  assert.equal(wrong.ok === false && wrong.attemptsRemaining, store.otpMaxAttempts - 1);
});

test("a code issued for one project is not accepted by another", () => {
  clear();
  const generated = generateOtp(qareeb, '963900000009');
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  // Tenant isolation: the store must not be able to spend Qareeb's code.
  assert.equal(verifyOtp(store, '963900000009', generated.code).ok, false);
  assert.equal(verifyOtp(qareeb, '963900000009', generated.code).ok, true);
});
