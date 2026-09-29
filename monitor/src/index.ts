// مراقب sms-api: Worker على Cloudflare يفحص /health كل ٥ دقائق من الخارج —
// من نفس الطريق الذي تسلكه المواقع — ويرسل تنبيهاً عبر ntfy و/أو تيليجرام.
//
// من خارج الجوال عمداً: أكثر ما يجب أن يُكشف هو أن الجوال نفسه انطفأ، أو فقد
// الشبكة، أو أن النفق سقط — ومراقب يعمل على الجوال يسقط معه في كل ذلك.
//
// الإعداد والنشر: README.md، القسم ٩.

import { classify, decide, stateAfterFailedDelivery, type Alert, type MonitorState, type Observation } from './health.ts';

// The two KV calls this uses, declared here so the logic typechecks without
// pulling Cloudflare's type package into the whole repository.
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  HEALTH_URL: string;
  STATE: KV;
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

export async function observe(env: Env, fetcher: typeof fetch = fetch): Promise<Observation> {
  try {
    const response = await fetcher(env.HEALTH_URL, {
      headers: { Authorization: `Bearer ${env.SMS_API_KEY ?? ''}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    return classify(response.status, await response.text());
  } catch (err) {
    return classify(null, '', err instanceof Error ? err.message : String(err));
  }
}

/** Sends to every configured channel; true if at least one accepted it. */
export async function deliver(env: Env, alert: Alert, fetcher: typeof fetch = fetch): Promise<boolean> {
  const sends: Array<Promise<Response>> = [];
  if (env.NTFY_TOPIC) {
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

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await runCheck(env);
  },
};
