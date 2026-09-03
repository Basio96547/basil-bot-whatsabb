// The failure these pin: a variant is chosen at random, so a payload missing a
// field that only SOME variants use produced a message that was correct most
// of the time and garbage the rest — a real customer receiving
// "المبلغ المطلوب: {amount}". talisham.com types `name` and `amount` as
// optional and posts its payload straight through, so this was reachable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, missingPlaceholders, knownEvents } from './templates.ts';

// Injected by the worker for every send, after the API-boundary check runs.
const AMBIENT = { brand: 'Talisham', expiryMinutes: 10 };

test('a full payload renders with no placeholder left behind, whichever variant is drawn', () => {
  const data = { ...AMBIENT, order: '1234', name: 'أحمد', amount: '250,000 ل.س' };
  // Many draws: the variant is random, so one pass proves little.
  for (let i = 0; i < 200; i++) {
    const { text } = renderTemplate('order_created', data);
    assert.doesNotMatch(text, /\{\w+\}/, `left a placeholder: ${text}`);
  }
});

test('a payload missing an optional field never yields a variant that needs it', () => {
  // `name` omitted — two of the three order_created variants do not use it.
  const data = { ...AMBIENT, order: '1234', amount: '250,000 ل.س' };
  for (let i = 0; i < 200; i++) {
    const { text } = renderTemplate('order_created', data);
    assert.doesNotMatch(text, /\{\w+\}/, `left a placeholder: ${text}`);
    assert.ok(!text.includes('{name}'));
  }
});

test('out_for_delivery without amount is refused rather than rendered', () => {
  // Every out_for_delivery variant uses {amount}, so nothing is renderable —
  // better a loud throw than a message quoting a price of "{amount}".
  assert.throws(
    () => renderTemplate('out_for_delivery', { ...AMBIENT, order: '1234' }),
    /No renderable variant/,
  );
});

test('missingPlaceholders names the minimum the caller must add', () => {
  assert.deepEqual(missingPlaceholders('out_for_delivery', { order: '1' }), ['amount']);
  assert.deepEqual(missingPlaceholders('order_created', { order: '1' }), ['amount']);
});

test('missingPlaceholders is empty as soon as ONE variant is satisfiable', () => {
  // `name` is missing but two variants do not need it.
  assert.deepEqual(missingPlaceholders('order_created', { order: '1', amount: '5' }), []);
  assert.deepEqual(missingPlaceholders('delivered', { order: '1' }), []);
});

test('ambient placeholders are not demanded from the caller', () => {
  // brand/expiryMinutes are injected by the worker later, so /notify must not
  // reject a payload for lacking them.
  for (const event of knownEvents()) {
    const missing = missingPlaceholders(event, { order: '1', name: 'x', amount: '5' });
    assert.ok(!missing.includes('brand'), `${event} demanded brand`);
    assert.ok(!missing.includes('expiryMinutes'), `${event} demanded expiryMinutes`);
  }
});

test('every known event is renderable from the payload talisham actually sends', () => {
  // order + name + amount is exactly what notifyService.ts posts.
  const data = { ...AMBIENT, order: '1234', name: 'أحمد', amount: '250,000 ل.س' };
  for (const event of knownEvents()) {
    assert.deepEqual(missingPlaceholders(event, data), [], `${event} not satisfiable`);
    const { text } = renderTemplate(event, data);
    assert.doesNotMatch(text, /\{\w+\}/);
  }
});

test('a per-project override is honoured, and its own placeholders are respected', () => {
  const overrides = { otp: ['كودك: {code} — صالح {expiryMinutes} دقائق'] };
  const { text, variantIndex } = renderTemplate('otp', { ...AMBIENT, code: '123456' }, overrides);
  assert.equal(variantIndex, 0);
  assert.equal(text, 'كودك: 123456 — صالح 10 دقائق');
});

test('variantIndex identifies the variant actually used, not its position among eligible ones', () => {
  // Only the third variant is renderable without {name}; the recorded index
  // must still be 2, or template_variant in the messages table lies.
  const overrides = {
    delivered: ['{name} {order}', '{name} مرة ثانية {order}', 'شكراً لك — طلب #{order}'],
  };
  const { variantIndex } = renderTemplate('delivered', { ...AMBIENT, order: '9' }, overrides);
  assert.equal(variantIndex, 2);
});
