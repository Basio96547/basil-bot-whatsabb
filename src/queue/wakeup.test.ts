import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyWork, sleepUnlessWoken } from './wakeup.ts';

// كل الاختبارات هنا تقيس زمناً، فالحدود متسامحة عمداً: المطلوب إثبات أن
// الإيقاظ يقطع الانتظار (وليس أنه يقطعه خلال ميلي ثانية بعينها).

test('الإيقاظ يقطع انتظاراً طويلاً بدل أن ينتظره حتى نهايته', async () => {
  const started = Date.now();
  const waiting = sleepUnlessWoken(60_000);
  setTimeout(notifyWork, 20);
  await waiting;
  assert.ok(Date.now() - started < 1_000, 'كان يفترض أن يستيقظ فوراً لا بعد دقيقة');
});

test('بلا إيقاظ ينتهي الانتظار بمهلته هو', async () => {
  const started = Date.now();
  await sleepUnlessWoken(50);
  assert.ok(Date.now() - started >= 45, 'انتهى قبل مهلته');
});

test('إيقاظ بلا منتظِر لا يرمي، ولا يُصرَف على الانتظار التالي', async () => {
  notifyWork(); // لا أحد ينتظر — يجب أن يمرّ بهدوء
  const started = Date.now();
  // لو "خُزِّنت" الإشارة أعلاه لعادت هذه فوراً، وهو ما يجعل العامل يدور
  // بلا مهلة عند أول رسالة تصل قبل أن ينام.
  await sleepUnlessWoken(50);
  assert.ok(Date.now() - started >= 45, 'استُهلكت إشارة قديمة على انتظار جديد');
});

test('الإيقاظ مرتين لا يجعل الانتظار يُحسم مرتين', async () => {
  const waiting = sleepUnlessWoken(60_000);
  notifyWork();
  notifyWork(); // الثانية يجب ألا تجد منتظِراً ولا أن ترمي
  await waiting;
});
