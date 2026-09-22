// DATA_DIR is redirected before routes.ts (which pulls in db.ts) is
// imported, so this runs against a throwaway SQLite file, never the real
// data/sms-api.db. PROJECT_API_KEY_*/OTP_HASH_SECRET/
// SESSION_BACKUP_ENCRYPTION_KEY get fallback values for the same reason as
// otp.test.ts and sessionBackup.test.ts: config.ts requires them all at
// import time, unrelated to anything this file actually tests (PHONE_RE is
// a pure regex) — on a fresh checkout with no .env yet, this file failed
// before a single test ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-routes-'));
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { PHONE_RE } = await import('./routes.ts');

// الصفر البادئ هو الحالة التي أوقعت الخدمة فعلاً: التحقق قبله كان `^\d{8,15}$`
// فمرّ الرقم المحلي، ثم علق العامل ١٥ ثانية في كل محاولة إرسال، خمس مرات.
test('الصيغة المحلية بصفر بادئ تُرفض', () => {
  assert.equal(PHONE_RE.test('0958436703'), false);
  assert.equal(PHONE_RE.test('00963958436703'), false);
});

test('الصيغة الدولية بلا + وبلا صفر تُقبل', () => {
  assert.equal(PHONE_RE.test('963958436703'), true);
  assert.equal(PHONE_RE.test('963993223887'), true);
});

test('علامة + مرفوضة — الأرقام فقط', () => {
  assert.equal(PHONE_RE.test('+963958436703'), false);
  assert.equal(PHONE_RE.test('963 958 436 703'), false);
});

test('الطول يبقى ٨ إلى ١٥ خانة', () => {
  assert.equal(PHONE_RE.test('1234567'), false, 'سبع خانات قصيرة');
  assert.equal(PHONE_RE.test('12345678'), true, 'ثماني خانات مقبولة');
  assert.equal(PHONE_RE.test('123456789012345'), true, 'خمس عشرة مقبولة');
  assert.equal(PHONE_RE.test('1234567890123456'), false, 'ست عشرة مرفوضة');
});
