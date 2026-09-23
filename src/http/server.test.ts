// Integration coverage for the actual HTTP surface — issue.test.ts and
// worker.test.ts exercise issueAndQueue()/processMessage() directly, but
// nothing before this file sent a real request through createServer(): the
// auth middleware, the route-level validation (PHONE_RE, unknown_event,
// invalid_channel, missing_placeholders), and the response shapes were only
// ever pinned by hand-reading routes.ts. This drives the four message flows
// talisham.com/khidam.com actually use end to end: registration (/otp/*),
// account creation notices (/notify order_created and its siblings), and
// forgot-password (/password-reset/*) — plus the auth gate every one of them
// sits behind.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-server-'));
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { createServer } = await import('./server.ts');
const { db } = await import('../db.ts');
const { generateOtp } = await import('../otp/otp.ts');
const { getProjectById } = await import('../config.ts');

const server = http.createServer(createServer());
await new Promise<void>((resolve) => server.listen(0, resolve));
const { port } = server.address() as AddressInfo;
test.after(() => server.close());

const STORE_KEY = process.env.PROJECT_API_KEY_STORE!;
const QAREEB_KEY = process.env.PROJECT_API_KEY_QAREEB!;

function clear(): void {
  db.exec('DELETE FROM otp_codes; DELETE FROM otp_send_log; DELETE FROM messages; DELETE FROM reset_tokens;');
}

async function call(
  method: string,
  urlPath: string,
  opts: { apiKey?: string | null; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== null) headers.authorization = `Bearer ${opts.apiKey ?? STORE_KEY}`;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

test('auth: no Authorization header is rejected before any route runs', async () => {
  const { status, json } = await call('GET', '/status/1', { apiKey: null });
  assert.equal(status, 401);
  assert.equal(json.error, 'invalid_or_missing_api_key');
});

test('auth: a well-formed but unknown API key is rejected the same way', async () => {
  const { status, json } = await call('POST', '/otp/request', { apiKey: 'not-a-real-key', body: { to: '963900002001' } });
  assert.equal(status, 401);
  assert.equal(json.error, 'invalid_or_missing_api_key');
});

// تسجيل — registration
test('registration: /otp/request queues a message, and /status reflects it pending', async () => {
  clear();
  const { status, json } = await call('POST', '/otp/request', { body: { to: '963900002010' } });
  assert.equal(status, 202);
  assert.equal(json.status, 'queued');
  const id = json.id as number;

  const { status: statusStatus, json: statusJson } = await call('GET', `/status/${id}`);
  assert.equal(statusStatus, 200);
  assert.equal(statusJson.event, 'otp');
  assert.equal(statusJson.status, 'pending');
  assert.equal(statusJson.recipient, '963900002010');
});

test('registration: /otp/request rejects a local-form (leading-zero) number instead of hanging a send on it later', async () => {
  clear();
  const { status, json } = await call('POST', '/otp/request', { body: { to: '0900002010' } });
  assert.equal(status, 400);
  assert.equal(json.error, 'invalid_recipient_format');
});

test('registration: /otp/verify rejects the wrong code and reports attempts remaining, then accepts the real one', async () => {
  clear();
  const project = getProjectById('store')!;
  const phone = '963900002011';
  const { code } = generateOtp(project, phone, 'login') as { ok: true; code: string; otpId: number };

  const wrong = await call('POST', '/otp/verify', { body: { to: phone, code: '000000' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'invalid_code');
  assert.equal(wrong.json.attemptsRemaining, project.otpMaxAttempts - 1);

  const right = await call('POST', '/otp/verify', { body: { to: phone, code } });
  assert.equal(right.status, 200);
  assert.equal(right.json.ok, true);

  // A retry of the same code right away is the lost-response case — still ok.
  const retry = await call('POST', '/otp/verify', { body: { to: phone, code } });
  assert.equal(retry.status, 200);

  // Spent and past the grace — verifying again must not still say ok.
  db.exec(`UPDATE otp_codes SET matched_at = datetime('now', '-121 seconds')`);
  const again = await call('POST', '/otp/verify', { body: { to: phone, code } });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'not_found_or_expired');
});

// نسيت — forgot password
test('forgot password: /password-reset/request queues a password_reset message distinct from a login otp', async () => {
  clear();
  const phone = '963900002020';
  await call('POST', '/otp/request', { body: { to: phone } }); // a login code for the same number
  const { status, json } = await call('POST', '/password-reset/request', { body: { to: phone } });
  assert.equal(status, 202);
  const id = json.id as number;

  const { json: statusJson } = await call('GET', `/status/${id}`);
  assert.equal(statusJson.event, 'password_reset');
});

test('forgot password: verify then validate-token round-trips to the phone the code was issued for', async () => {
  clear();
  const project = getProjectById('store')!;
  const phone = '963900002021';
  const { code } = generateOtp(project, phone, 'password_reset') as { ok: true; code: string; otpId: number };

  const verify = await call('POST', '/password-reset/verify', { body: { to: phone, code } });
  assert.equal(verify.status, 200);
  const resetToken = verify.json.resetToken as string;
  assert.equal(typeof resetToken, 'string');
  assert.ok(resetToken.length > 0);

  const claim = await call('POST', '/password-reset/validate-token', { body: { token: resetToken } });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.phone, phone);
});

test('forgot password: validate-token rejects a forged token', async () => {
  clear();
  const { status, json } = await call('POST', '/password-reset/validate-token', { body: { token: 'not-a-real-token' } });
  assert.equal(status, 400);
  assert.equal(json.error, 'not_found_or_expired');
});

// انشاء — order creation, and the other notification types alongside it
test('order notifications: /notify queues order_created with a full payload', async () => {
  clear();
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'order_created', to: '963900002030', payload: { order: '100', amount: '5000 ل.س' } },
  });
  assert.equal(status, 202);
  const { json: statusJson } = await call('GET', `/status/${json.id}`);
  assert.equal(statusJson.event, 'order_created');
});

test('order notifications: /notify refuses a payload missing a placeholder every variant needs, instead of delivering it literally', async () => {
  clear();
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'order_created', to: '963900002031', payload: { order: '101' } }, // no amount
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'missing_placeholders');
  assert.ok(Array.isArray(json.missing) && (json.missing as string[]).includes('amount'));
});

for (const [event, payload] of [
  ['order_confirmed', { order: '102' }],
  ['out_for_delivery', { order: '103', amount: '3000 ل.س' }],
  ['delivered', { order: '104' }],
] as const) {
  test(`other message types: /notify queues "${event}"`, async () => {
    clear();
    const { status, json } = await call('POST', '/notify', {
      body: { event, to: '963900002040', payload },
    });
    assert.equal(status, 202);
    const { json: statusJson } = await call('GET', `/status/${json.id}`);
    assert.equal(statusJson.event, event);
  });
}

test('/notify rejects an unknown event name up front, without touching the queue', async () => {
  clear();
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'shipment_lost_forever', to: '963900002050', payload: {} },
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'unknown_event');
});

test('/notify rejects a channel that is neither whatsapp nor sms', async () => {
  clear();
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'delivered', to: '963900002051', payload: { order: '1' }, channel: 'carrier_pigeon' },
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'invalid_channel');
});

test('/notify refuses a payload value that is not text or a number, instead of delivering "[object Object]"', async () => {
  clear();
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'order_confirmed', to: '963900002052', payload: { order: { id: 5 } } },
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'invalid_payload');
  assert.deepEqual(json.invalid, ['order']);
});

test('/notify refuses a payload that is not an object at all', async () => {
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'delivered', to: '963900002053', payload: ['104'] },
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'invalid_payload');
});

test('/notify treats an empty string like a missing field', async () => {
  clear();
  // Every out_for_delivery variant needs {amount}; "" must not satisfy it.
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'out_for_delivery', to: '963900002054', payload: { order: '105', amount: '  ' } },
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'missing_placeholders');
});

test('/notify refuses a forced SMS channel when no SMS provider is configured, instead of a 202 that can only fail', async () => {
  const { status, json } = await call('POST', '/notify', {
    body: { event: 'delivered', to: '963900002055', payload: { order: '106' }, channel: 'sms' },
  });
  assert.equal(status, 400);
  assert.equal(json.error, 'channel_unavailable');
});

test('an oversized body is a 413, not a 500 with a stack trace', async () => {
  const { status, json } = await call('POST', '/notify', { body: { pad: 'x'.repeat(40_000) } });
  assert.equal(status, 413);
  assert.equal(json.error, 'payload_too_large');
});

test('malformed JSON is still a clean 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${STORE_KEY}` },
    body: '{"event":',
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_json_body');
});

test('the API key is checked before the body is even read', async () => {
  const { status, json } = await call('POST', '/notify', { apiKey: null, body: { pad: 'x'.repeat(40_000) } });
  assert.equal(status, 401);
  assert.equal(json.error, 'invalid_or_missing_api_key');
});

// Cross-project isolation
test('/status is scoped to the caller\'s own project — another project\'s key gets 404, not the row', async () => {
  clear();
  const { json } = await call('POST', '/otp/request', { apiKey: STORE_KEY, body: { to: '963900002060' } });
  const { status } = await call('GET', `/status/${json.id}`, { apiKey: QAREEB_KEY });
  assert.equal(status, 404);
});

test('/status 404s a well-formed id that was never issued', async () => {
  const { status, json } = await call('GET', '/status/999999999');
  assert.equal(status, 404);
  assert.equal(json.error, 'not_found');
});
