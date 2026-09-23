// The daily cap is the last line of defence for the sending WhatsApp number:
// the cooldown alone still permits a message every few minutes forever. These
// tests pin the two things that make it a real cap — that it counts sends
// which outlive the codes themselves, and that it isolates projects.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.
//
// PROJECT_API_KEY_*/OTP_HASH_SECRET are given fallback values (`??=`, so a
// real .env is still respected where present) because config.ts requires
// them for EVERY project in config/projects.json at import time — on a
// fresh checkout with no .env yet (a clean clone, or CI), this file failed
// before a single test ran, unrelated to anything it actually tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-otp-'));
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { generateOtp, verifyOtp, normalizeSubmittedCode } = await import('./otp.ts');
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

test('a code still verifies normally under the cap, and a spent one stops working once the lost-response grace is over', () => {
  clear();
  const generated = generateOtp(store, '963900000007');
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  assert.deepEqual(verifyOtp(store, '963900000007', generated.code), { ok: true });
  db.exec(`UPDATE otp_codes SET matched_at = datetime('now', '-121 seconds')`);
  // Replaying a spent code must not pass.
  assert.equal(verifyOtp(store, '963900000007', generated.code).ok, false);
});

test('a retry whose first answer was lost still verifies — the same code, within two minutes', () => {
  // Seen live on khidam.com: the site gave up after 8 s, sms-api had already
  // spent the code, and the customer's retry of the SAME correct code was
  // told it had expired.
  clear();
  const generated = generateOtp(store, '963900000016');
  assert.ok(generated.ok);
  if (!generated.ok) return;
  assert.equal(verifyOtp(store, '963900000016', generated.code).ok, true); // answer lost in transit
  assert.equal(verifyOtp(store, '963900000016', toArabicDigits(generated.code)).ok, true, 'the retry');
});

test('the grace window accepts only the code that was used, answers everything else like no code, and still counts attempts', () => {
  clear();
  const phone = '963900000017';
  const first = generateOtp(store, phone);
  db.exec(`UPDATE otp_codes SET created_at = datetime('now', '-5 minutes')`);
  const second = generateOtp(store, phone);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;

  assert.equal(verifyOtp(store, phone, second.code).ok, true);
  // The sibling code was spent by that success and is NOT covered by the grace.
  assert.deepEqual(verifyOtp(store, phone, first.code), { ok: false, reason: 'not_found_or_expired' });

  const wrong = ['000000', '111111', '222222'].find((c) => c !== first.code && c !== second.code)!;
  for (let i = 0; i < store.otpMaxAttempts; i++) verifyOtp(store, phone, wrong);
  // Guesses during the grace spend the used code's attempts; once they are
  // gone, not even the right code reopens it.
  assert.equal(verifyOtp(store, phone, second.code).ok, false);
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

const toArabicDigits = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));

test('a code typed in Arabic digits, or pasted with the message text, is accepted', () => {
  clear();
  const generated = generateOtp(store, '963900000010');
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  assert.equal(verifyOtp(store, '963900000010', `كودك: ${toArabicDigits(generated.code)}`).ok, true);
});

test('pasting the whole WhatsApp message verifies — its other numbers (the validity minutes) are not glued onto the code', async () => {
  const { renderTemplate } = await import('../templates/templates.ts');
  clear();
  const generated = generateOtp(store, '963900000014');
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  for (let i = 0; i < 10; i++) {
    // Every variant carries {expiryMinutes}, i.e. a second number in the text.
    const { text } = renderTemplate('otp', { code: generated.code, brand: store.brandName, expiryMinutes: 10 });
    assert.equal(normalizeSubmittedCode(text), generated.code, text);
  }
  const pasted = renderTemplate('otp', { code: generated.code, brand: store.brandName, expiryMinutes: 10 }).text;
  assert.equal(verifyOtp(store, '963900000014', toArabicDigits(pasted)).ok, true);
});

test('spaced-out digits still join into the code', () => {
  assert.equal(normalizeSubmittedCode('12 34 56'), '123456');
  assert.equal(normalizeSubmittedCode('١٢٣ ٤٥٦'), '123456');
});

test('several live codes never give a guesser more than max_attempts tries per code', () => {
  // Every guess is checked against every live code. Charging only the newest
  // multiplied an attacker's chances by the number of live codes (25 → 75 a
  // day per number); each guess is now charged to all of them.
  clear();
  const phone = '963900000015';
  const first = generateOtp(store, phone);
  db.exec(`UPDATE otp_codes SET created_at = datetime('now', '-5 minutes')`);
  const second = generateOtp(store, phone);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;

  const wrong = ['000000', '111111', '222222', '333333', '444444', '555555'].find(
    (c) => c !== first.code && c !== second.code,
  )!;
  for (let i = 0; i < store.otpMaxAttempts; i++) verifyOtp(store, phone, wrong);

  // Both codes absorbed the same five guesses — neither has any left.
  const attempts = db.prepare('SELECT attempts FROM otp_codes ORDER BY id').all() as { attempts: number }[];
  assert.deepEqual(attempts.map((r) => r.attempts), [store.otpMaxAttempts, store.otpMaxAttempts]);
  const after = verifyOtp(store, phone, first.code);
  assert.equal(after.ok === false && after.reason, 'too_many_attempts');
});

test('input that is not six digits is rejected without spending an attempt', () => {
  clear();
  const generated = generateOtp(store, '963900000011');
  assert.equal(generated.ok, true);
  const bad = verifyOtp(store, '963900000011', '12');
  assert.equal(bad.ok === false && bad.reason, 'invalid_code');
  assert.equal(bad.ok === false && bad.attemptsRemaining, store.otpMaxAttempts);
});

test('an older code that is still valid works after a newer one was issued, and spends both', () => {
  clear();
  const first = generateOtp(store, '963900000012');
  assert.equal(first.ok, true);
  // Past the resend cooldown, still inside the code's validity.
  db.exec(`UPDATE otp_codes SET created_at = datetime('now', '-5 minutes')`);
  const second = generateOtp(store, '963900000012');
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(verifyOtp(store, '963900000012', first.code).ok, true);
  // One code used ⇒ the other message in the chat no longer opens the door.
  assert.equal(verifyOtp(store, '963900000012', second.code).ok, false);
});

test('after a lockout a new request issues a fresh code instead of pointing at the dead one', () => {
  clear();
  const first = generateOtp(store, '963900000013');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const wrong = first.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < store.otpMaxAttempts; i++) verifyOtp(store, '963900000013', wrong);
  const locked = verifyOtp(store, '963900000013', first.code);
  assert.equal(locked.ok === false && locked.reason, 'too_many_attempts');

  // Still inside the cooldown — previously this answered already_sent.
  const again = generateOtp(store, '963900000013');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(verifyOtp(store, '963900000013', again.code).ok, true);
});
