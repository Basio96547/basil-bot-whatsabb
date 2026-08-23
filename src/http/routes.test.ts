import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_RE } from './routes.ts';

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
