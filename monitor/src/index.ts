// مراقب sms-api: Worker على Cloudflare يفحص /health كل ٥ دقائق من الخارج —
// من نفس الطريق الذي تسلكه المواقع — ويرسل تنبيهاً عبر تيليجرام (أو خادم ntfy
// خاص؛ ntfy.sh العام لا يصلح من هنا — السبب عند deliver أدناه).
//
// من خارج الجوال عمداً: أكثر ما يجب أن يُكشف هو أن الجوال نفسه انطفأ، أو فقد
// الشبكة، أو أن النفق سقط — ومراقب يعمل على الجوال يسقط معه في كل ذلك.
//
// الساعة منبّه Durable Object لا Cron: الحساب على خطة Workers المجانية، وحدّها
// ٥ جداول Cron للحساب كله، وكلها مشغولة بمشاريع أخرى (رُفض النشر بالرمز 10072
// في 2026-09-29). المنبّه يعيد تسليح نفسه كل فحص ولا يحتاج خانة Cron.
//
// الإعداد والنشر: README.md، القسم ٩.

import { classify, decide, stateAfterFailedDelivery, type Alert, type MonitorState, type Observation } from './health.ts';

// The two KV calls this uses, declared here so the logic typechecks without
// pulling Cloudflare's type package into the whole repository.
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

// The slice of the Durable Object runtime this uses — declared, like KV above,
// so nothing here imports `cloudflare:workers` and the tests run under Node.
interface AlarmStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

interface SchedulerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface Env {
  HEALTH_URL: string;
  STATE: KV;
  SCHEDULER: SchedulerNamespace;
  /** Secrets (npx wrangler secret put …). */
  SMS_API_KEY?: string;
  NTFY_TOPIC?: string;
  NTFY_SERVER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const STATE_KEY = 'state';
const CHECK_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 10_000;
export const CHECK_EVERY_MS = 5 * 60_000;
// Alarms are at-least-once: a rare duplicate firing seconds after the real one
// would count as a second failed check and halve the "two checks" patience.
const MIN_GAP_MS = 60_000;

export async function observe(env: Env, fetcher: typeof fetch = fetch): Promise<Observation> {
  const key = env.SMS_API_KEY?.trim();
  try {
    const response = await fetcher(env.HEALTH_URL, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    return classify(response.status, await response.text(), undefined, Boolean(key));
  } catch (err) {
    return classify(null, '', err instanceof Error ? err.message : String(err), Boolean(key));
  }
}

/** Sends to every configured channel; true if at least one accepted it. */
export async function deliver(env: Env, alert: Alert, fetcher: typeof fetch = fetch): Promise<boolean> {
  const sends: Array<Promise<Response>> = [];
  if (env.NTFY_TOPIC) {
    // Only with NTFY_SERVER pointing at a server of your own. The public
    // ntfy.sh is unusable from Workers (measured 2026-09-29): connections die
    // with 522, and those that land get 429 "daily message quota reached" —
    // its free quota is per source IP, and Workers' outbound IPs are shared
    // with everyone else on Cloudflare.
    // JSON publishing, not headers: an Arabic title in an HTTP header is not
    // valid ISO-8859-1 and fetch refuses it.
    sends.push(
      fetcher(env.NTFY_SERVER || 'https://ntfy.sh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: env.NTFY_TOPIC,
          title: alert.title,
          message: alert.message,
          priority: alert.priority,
          tags: [alert.kind === 'recovered' ? 'white_check_mark' : alert.kind === 'started' ? 'eyes' : 'rotating_light'],
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }),
    );
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    sends.push(
      fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${alert.title}\n\n${alert.message}`, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }),
    );
  }
  if (sends.length === 0) {
    console.error('[monitor] لا توجد قناة تنبيه — اضبط NTFY_TOPIC أو TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
    return false;
  }
  const results = await Promise.allSettled(sends);
  let delivered = false;
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.ok) delivered = true;
    else console.error('[monitor] فشل إرسال تنبيه', result.status === 'fulfilled' ? `HTTP ${result.value.status}` : result.reason);
  }
  return delivered;
}

export async function runCheck(env: Env, now = Date.now(), fetcher: typeof fetch = fetch): Promise<void> {
  const raw = await env.STATE.get(STATE_KEY);
  const prev = raw ? (JSON.parse(raw) as MonitorState) : null;
  const obs = await observe(env, fetcher);
  const decided = decide(prev, obs, now);
  console.log(`[monitor] ${obs.status} ${obs.reasons.join(',') || '-'}${decided.alert ? ` → ${decided.alert.kind}` : ''}`);

  let toSave: MonitorState | null = decided.next;
  if (decided.alert && !(await deliver(env, decided.alert, fetcher))) {
    toSave = stateAfterFailedDelivery(prev, { next: decided.next, alert: decided.alert });
  }
  // KV's free tier allows 1000 writes a day; a 5-minute check is 288 runs, and
  // most of them change nothing.
  if (toSave && JSON.stringify(toSave) !== raw) await env.STATE.put(STATE_KEY, JSON.stringify(toSave));
}

/**
 * The clock: one Durable Object whose alarm fires every 5 minutes and runs a
 * check. It re-arms itself BEFORE checking and never throws, so neither a
 * failed check nor a failed alert can break the chain.
 */
export class Scheduler {
  constructor(
    private readonly state: { storage: AlarmStorage },
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Arms the chain if it is not armed; a no-op otherwise. */
  async fetch(): Promise<Response> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + 1_000);
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.state.storage.setAlarm(now + CHECK_EVERY_MS);
    const lastRunAt = (await this.state.storage.get<number>('lastRunAt')) ?? 0;
    if (now - lastRunAt < MIN_GAP_MS) return;
    await this.state.storage.put('lastRunAt', now);
    try {
      await runCheck(this.env, now, this.fetcher);
    } catch (err) {
      console.error('[monitor] فشل الفحص', err);
    }
  }
}

export default {
  // The only way to start the chain from outside (no cron slot to do it):
  // any request arms it if it is not armed, and reveals nothing. setup.ps1
  // calls it after every deploy; opening the URL in a browser does the same.
  async fetch(_request: Request, env: Env): Promise<Response> {
    return env.SCHEDULER.get(env.SCHEDULER.idFromName('clock')).fetch('https://scheduler/arm', { method: 'POST' });
  },
};
