// المراقب يُحكم عليه بشيئين: أن ينبّه حين يجب، وألا ينبّه حين لا يجب. الثاني
// ليس أقل أهمية: هذا الجوال يفقد الشبكة لثوانٍ باستمرار، ومراقب يرنّ على كل
// ارتعاشة يُكتم في يومه الأول.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, decide, stateAfterFailedDelivery, REMIND_EVERY_MS, type MonitorState, type Observation } from './health.ts';
import { runCheck, type Env } from './index.ts';

const MIN = 60_000;
const ok: Observation = { status: 'ok', reasons: [], detail: null };
const down: Observation = { status: 'bad', reasons: ['unreachable'], detail: null };
const waDisconnected: Observation = { status: 'bad', reasons: ['whatsapp_disconnected'], detail: null };
const needsQr: Observation = { status: 'bad', reasons: ['whatsapp_needs_reauth'], detail: null };

/** Runs a sequence of observations 5 minutes apart; returns the alert kinds in order. */
function run(observations: Observation[], start: MonitorState | null = null): Array<string | null> {
  let state = start;
  const kinds: Array<string | null> = [];
  observations.forEach((obs, i) => {
    const { next, alert } = decide(state, obs, 1_000_000_000_000 + i * 5 * MIN);
    kinds.push(alert?.kind ?? null);
    state = next;
  });
  return kinds;
}

// ---- classify ----

test('the service\'s own 200 and 503 answers are read, reasons and all', () => {
  assert.deepEqual(classify(200, '{"status":"ok","reasons":[]}'), ok);
  assert.deepEqual(
    classify(503, '{"status":"degraded","reasons":["account_restricted"],"enforcement":{"endsAt":"2026-10-01T00:00:00.000Z"}}'),
    { status: 'bad', reasons: ['account_restricted'], detail: 'القيد ينتهي 2026-10-01T00:00:00.000Z' },
  );
});

test('a backup-restored session that has not connected yet is not, by itself, a problem', () => {
  assert.equal(classify(200, '{"status":"ok","reasons":["session_restored_from_backup"]}').status, 'ok');
});

test('no answer at all, a Cloudflare edge error, and a rejected key are told apart', () => {
  assert.deepEqual(classify(null, '', 'The operation was aborted due to timeout').reasons, ['unreachable']);
  assert.deepEqual(classify(530, 'error code: 1033').reasons, ['tunnel_down']);
  assert.deepEqual(classify(401, '{"error":"invalid_or_missing_api_key"}').reasons, ['auth_failed']);
});

// ---- decide ----

test('the first check announces that monitoring has started', () => {
  assert.deepEqual(run([ok]), ['started']);
});

test('a single failed check — a network blip — alerts nobody, and its end is silent too', () => {
  assert.deepEqual(run([ok, down, ok, ok]), ['started', null, null, null]);
});

test('a problem that persists across two checks alerts once, then its recovery alerts once', () => {
  assert.deepEqual(run([ok, down, down, down, down, ok, ok]), ['started', null, 'problem', null, null, 'recovered', null]);
});

test('a problem no retry can fix (a QR scan is needed) alerts on the first sighting', () => {
  assert.deepEqual(run([ok, needsQr]), ['started', 'problem']);
});

test('a NEW reason during an announced problem alerts again; one clearing does not', () => {
  const both: Observation = { status: 'bad', reasons: ['whatsapp_disconnected', 'queue_stalled'], detail: null };
  assert.deepEqual(run([ok, waDisconnected, waDisconnected, both, waDisconnected, both]), [
    'started',
    null,
    'problem',
    'changed',
    null, // queue_stalled cleared — progress, not news
    null, // and its return was already announced once
  ]);
});

test('a problem still there after six hours is repeated, not forgotten', () => {
  const t0 = 1_000_000_000_000;
  let { next } = decide(null, ok, t0);
  ({ next } = decide(next, down, t0 + 5 * MIN));
  const announced = decide(next, down, t0 + 10 * MIN);
  assert.equal(announced.alert?.kind, 'problem');
  assert.equal(decide(announced.next, down, t0 + 10 * MIN + REMIND_EVERY_MS - MIN).alert, null);
  assert.equal(decide(announced.next, down, t0 + 10 * MIN + REMIND_EVERY_MS).alert?.kind, 'reminder');
});

test('an alert that no channel delivered is sent again on the next check', () => {
  const t0 = 1_000_000_000_000;
  let { next } = decide(null, ok, t0);
  ({ next } = decide(next, down, t0 + 5 * MIN));
  const lost = decide(next, down, t0 + 10 * MIN);
  assert.equal(lost.alert?.kind, 'problem');
  const saved = stateAfterFailedDelivery(next, { next: lost.next, alert: lost.alert! });
  assert.equal(decide(saved, down, t0 + 15 * MIN).alert?.kind, 'problem', 'retried, not believed seen');

  const recovered = decide(lost.next, ok, t0 + 20 * MIN);
  assert.equal(recovered.alert?.kind, 'recovered');
  const kept = stateAfterFailedDelivery(lost.next, { next: recovered.next, alert: recovered.alert! });
  assert.equal(decide(kept, ok, t0 + 25 * MIN).alert?.kind, 'recovered');
});

// ---- the Worker's run, with the network and KV replaced ----

function fakeEnv(overrides: Partial<Env> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env: Env = {
    HEALTH_URL: 'https://sms-api.example/health',
    SMS_API_KEY: 'k',
    NTFY_TOPIC: 'topic',
    STATE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) },
    ...overrides,
  };
  return { env, store };
}

function fakeFetch(health: () => Response, ntfyStatus = 200) {
  const sent: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      sent.push({ url, body: null, auth: new Headers(init?.headers).get('Authorization') });
      return health();
    }
    sent.push({ url, body: JSON.parse(String(init?.body)), auth: null });
    return new Response('{}', { status: ntfyStatus });
  }) as typeof fetch;
  return { fetcher, sent };
}

test('a run checks /health with the key, and publishes the alert to ntfy as JSON', async () => {
  const { env, store } = fakeEnv();
  const { fetcher, sent } = fakeFetch(() => new Response('{"status":"ok","reasons":[]}', { status: 200 }));
  await runCheck(env, Date.now(), fetcher);
  assert.equal(sent[0].auth, 'Bearer k');
  assert.equal(sent[1].url, 'https://ntfy.sh');
  assert.deepEqual((sent[1].body as { topic: string }).topic, 'topic');
  assert.ok(store.get('state'), 'state saved after a delivered alert');
});

test('when ntfy refuses the alert, nothing is recorded as announced', async () => {
  const { env, store } = fakeEnv();
  const { fetcher } = fakeFetch(() => new Response('{"status":"ok","reasons":[]}', { status: 200 }), 500);
  await runCheck(env, Date.now(), fetcher);
  assert.equal(store.get('state'), undefined, 'the "started" message will be sent again next time');
});

test('a quiet, healthy check writes nothing to KV', async () => {
  const { env, store } = fakeEnv();
  const { fetcher } = fakeFetch(() => new Response('{"status":"ok","reasons":[]}', { status: 200 }));
  const now = Date.now();
  await runCheck(env, now, fetcher);
  const first = store.get('state');
  let writes = 0;
  const put = env.STATE.put;
  env.STATE.put = async (k, v) => {
    writes += 1;
    await put(k, v);
  };
  await runCheck(env, now + 5 * MIN, fetcher);
  assert.equal(writes, 0);
  assert.equal(store.get('state'), first);
});
