// منطق المراقب كله، بلا أي شيء خاص بـ Cloudflare — فيُختبر بـ node:test
// مثل بقية المشروع (monitor/src/health.test.ts).
//
// ثلاثة أسئلة في كل فحص: ما حال الخدمة الآن؟ هل يستحق ذلك تنبيهاً؟ وماذا
// نقول فيه؟ القاعدة: تنبيه عند مشكلة ثابتة وعند التعافي منها — لا عند كل
// ارتعاشة. هذا الجوال يفقد الشبكة لثوانٍ باستمرار، وواتساب ينقطع ويعود وحده
// كل بضع دقائق؛ مراقب ينبّه على كل ذلك يُكتم صوته في يومه الأول، ثم لا يُسمع
// حين تقع المشكلة الحقيقية.

export type Status = 'ok' | 'bad';

export interface Observation {
  status: Status;
  /** Machine names, e.g. whatsapp_needs_reauth — the service's own, or unreachable / tunnel_down / auth_failed. */
  reasons: string[];
  /** Extra facts worth showing (an enforcement end time, the HTTP code). */
  detail: string | null;
  /**
   * The monitor has no API key, so "ok" only means the service answered at
   * all — the phone, the tunnel and the Node process are up. WhatsApp's own
   * state stays unseen until SMS_API_KEY is set.
   */
  limited?: boolean;
}

export interface MonitorState {
  status: Status;
  reasons: string[];
  /** When the current status began — for a problem, its first failed check. */
  since: number;
  /** Consecutive failed checks in the current problem. */
  badChecks: number;
  /** Whether this problem has been announced (so its recovery must be too). */
  alerted: boolean;
  /** The reasons the last alert named — a NEW one is worth another alert. */
  announced: string[];
  lastAlertAt: number;
}

export type AlertKind = 'started' | 'problem' | 'changed' | 'reminder' | 'recovered';

export interface Alert {
  kind: AlertKind;
  title: string;
  message: string;
  /** ntfy scale: 5 = urgent (bypasses Do Not Disturb on most phones), 3 = default. */
  priority: 1 | 2 | 3 | 4 | 5;
}

// These never heal on their own — a human must act — so one sighting is
// enough. Everything else must persist across two checks (~5 minutes) first.
const IMMEDIATE = new Set(['whatsapp_needs_reauth', 'account_restricted', 'auth_failed']);
const CHECKS_BEFORE_ALERT = 2;
// A problem that is still there is repeated this often, so it is not
// forgotten after the first notification scrolled away.
export const REMIND_EVERY_MS = 6 * 60 * 60_000;

const REASON_TEXT: Record<string, string> = {
  unreachable: 'الخدمة لا تردّ إطلاقاً — الجوال مطفأ أو بلا إنترنت',
  tunnel_down: 'Cloudflare لا يجد النفق — cloudflared متوقف على الجوال أو الجوال بلا شبكة',
  gateway_error: 'Cloudflare لم يتلقَّ ردّاً من الخدمة — sms-api متوقفة أو تنهار وتعيد التشغيل على الجوال (pm2 status)، أو الشبكة تنقطع',
  auth_failed: 'مفتاح المراقب مرفوض — حدّث السر SMS_API_KEY للمراقب',
  whatsapp_needs_reauth: 'جلسة واتساب انتهت — يحتاج مسح QR جديد',
  whatsapp_disconnected: 'واتساب مقطوع — يعيد المحاولة وحده',
  queue_near_capacity: 'الطابور تجاوز 80% من سعته',
  queue_stalled: 'أقدم رسالة تنتظر أكثر من 10 دقائق — الإرسال متوقف فعلاً',
  account_restricted: 'واتساب قيّد الحساب — لا تمسح QR قبل انتهاء القيد',
  send_rate_ceiling: 'بلغ سقف الإرسال بالساعة — الرسائل تنتظر ولا تُسقَط',
  channel_paused: 'قناة إرسال موقوفة مؤقتاً بعد فشل متتالٍ',
};

function describe(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

interface HealthBody {
  status?: unknown;
  error?: unknown;
  reasons?: unknown;
  enforcement?: { endsAt?: unknown } | null;
}

function parseJson(text: string): HealthBody | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as HealthBody) : null;
  } catch {
    return null;
  }
}

/**
 * What one request to /health says. `httpStatus` is null when the request
 * itself failed (no route to the phone, a timeout). `keyConfigured` is false
 * while the monitor has no SMS_API_KEY to send.
 */
export function classify(httpStatus: number | null, bodyText: string, fetchError?: string, keyConfigured = true): Observation {
  if (httpStatus === null) {
    return { status: 'bad', reasons: ['unreachable'], detail: fetchError ?? null };
  }
  const body = parseJson(bodyText);

  // The service's own answer: 200 ok, or 503 with named reasons.
  if (body && (body.status === 'ok' || body.status === 'degraded') && Array.isArray(body.reasons)) {
    const reasons = body.reasons.filter((r): r is string => typeof r === 'string');
    if (body.status === 'ok') return { status: 'ok', reasons, detail: null };
    const endsAt = typeof body.enforcement?.endsAt === 'string' ? body.enforcement.endsAt : null;
    return {
      status: 'bad',
      reasons: reasons.filter((r) => r !== 'session_restored_from_backup'),
      detail: endsAt ? `القيد ينتهي ${endsAt}` : null,
    };
  }
  if (httpStatus === 401) {
    // Without a key the service's own refusal is still an answer: it proves
    // the phone is on, the tunnel is up and Node is serving — which is most
    // of what this monitor exists to catch. The key lives only on the phone,
    // so this is how the monitor runs until someone copies it over.
    if (!keyConfigured && body?.error === 'invalid_or_missing_api_key') {
      return { status: 'ok', reasons: [], detail: null, limited: true };
    }
    return { status: 'bad', reasons: ['auth_failed'], detail: null };
  }
  // Anything else in the 5xx range is Cloudflare speaking, not the service.
  // 530 (error 1033) is "no tunnel connector": cloudflared is not connected.
  // The rest — 502 above all — is what cloudflared answers when nothing
  // listens on 127.0.0.1:3000: the tunnel is fine and sms-api is not. Telling
  // them apart says which pm2 app to look at.
  if (httpStatus === 530) return { status: 'bad', reasons: ['tunnel_down'], detail: `HTTP ${httpStatus}` };
  if (httpStatus >= 500) return { status: 'bad', reasons: ['gateway_error'], detail: `HTTP ${httpStatus}` };
  return { status: 'bad', reasons: [`unexpected_http_${httpStatus}`], detail: bodyText.slice(0, 120) || null };
}

function minutesSince(from: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - from) / 60_000));
  if (minutes < 90) return `${minutes} دقيقة`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} ساعة`;
}

function riyadhTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' }).format(ms);
}

function reasonLines(obs: Observation): string {
  const lines = obs.reasons.map((r) => `• ${describe(r)}`);
  if (obs.detail) lines.push(`(${obs.detail})`);
  return lines.join('\n');
}

function makeAlert(kind: AlertKind, obs: Observation, since: number, now: number): Alert {
  switch (kind) {
    case 'started':
      if (obs.status === 'ok' && obs.limited) {
        return {
          kind,
          priority: 3,
          title: 'مراقب sms-api يعمل (وضع محدود)',
          message:
            'الفحص كل 5 دقائق بدأ، والخدمة تردّ الآن. بلا مفتاح API يكشف المراقب انطفاء الجوال وسقوط النفق وتوقف الخدمة، لا حالة واتساب. لإكماله: شغّل monitor/setup.ps1 من الكمبيوتر والجوال موصول.',
        };
      }
      return obs.status === 'ok'
        ? { kind, priority: 3, title: 'مراقب sms-api يعمل', message: 'الفحص كل 5 دقائق بدأ، والخدمة سليمة الآن. ستصلك رسالة عند أي مشكلة ثابتة وعند التعافي منها.' }
        : { kind, priority: 5, title: 'مراقب sms-api يعمل — والخدمة فيها مشكلة الآن', message: reasonLines(obs) };
    case 'problem':
      return { kind, priority: 5, title: 'sms-api: مشكلة', message: `${reasonLines(obs)}\nمنذ ${riyadhTime(since)} (توقيت الرياض)` };
    case 'changed':
      return { kind, priority: 5, title: 'sms-api: المشكلة تغيّرت', message: `${reasonLines(obs)}\nالمشكلة قائمة منذ ${minutesSince(since, now)}` };
    case 'reminder':
      return { kind, priority: 4, title: 'sms-api: المشكلة ما زالت قائمة', message: `${reasonLines(obs)}\nمنذ ${minutesSince(since, now)}` };
    case 'recovered':
      return { kind, priority: 3, title: 'sms-api: عادت سليمة', message: `انتهت المشكلة بعد ${minutesSince(since, now)}.` };
  }
}

function hasNewReason(reasons: string[], announced: string[]): boolean {
  return reasons.some((r) => !announced.includes(r));
}

/** The next state, and the alert this check calls for (if any). */
export function decide(prev: MonitorState | null, obs: Observation, now: number): { next: MonitorState; alert: Alert | null } {
  const bad = obs.status === 'bad';

  if (!prev) {
    return {
      next: { status: obs.status, reasons: obs.reasons, since: now, badChecks: bad ? 1 : 0, alerted: bad, announced: bad ? obs.reasons : [], lastAlertAt: now },
      alert: makeAlert('started', obs, now, now),
    };
  }

  if (!bad) {
    const next: MonitorState = {
      status: 'ok',
      reasons: obs.reasons,
      since: prev.status === 'ok' ? prev.since : now,
      badChecks: 0,
      alerted: false,
      announced: [],
      lastAlertAt: prev.lastAlertAt,
    };
    // A blip nobody was told about ends as quietly as it began.
    return { next, alert: prev.status === 'bad' && prev.alerted ? makeAlert('recovered', obs, prev.since, now) : null };
  }

  const wasBad = prev.status === 'bad';
  const since = wasBad ? prev.since : now;
  const badChecks = wasBad ? prev.badChecks + 1 : 1;
  const next: MonitorState = {
    status: 'bad',
    reasons: obs.reasons,
    since,
    badChecks,
    alerted: wasBad && prev.alerted,
    announced: wasBad ? prev.announced : [],
    lastAlertAt: prev.lastAlertAt,
  };

  let kind: AlertKind | null = null;
  if (!next.alerted) {
    const needed = obs.reasons.some((r) => IMMEDIATE.has(r)) ? 1 : CHECKS_BEFORE_ALERT;
    if (badChecks >= needed) kind = 'problem';
  } else if (hasNewReason(obs.reasons, next.announced)) {
    // Only a reason not yet announced: one clearing while others stay is
    // progress, not news — and reasons that come and go must not page twice.
    kind = 'changed';
  } else if (now - next.lastAlertAt >= REMIND_EVERY_MS) {
    kind = 'reminder';
  }

  if (!kind) return { next, alert: null };
  return {
    next: { ...next, alerted: true, announced: [...new Set([...next.announced, ...obs.reasons])], lastAlertAt: now },
    alert: makeAlert(kind, obs, since, now),
  };
}

/**
 * The state to save when an alert could not be delivered by any channel — so
 * the next check sends it again instead of believing it was seen.
 */
export function stateAfterFailedDelivery(prev: MonitorState | null, decided: { next: MonitorState; alert: Alert }): MonitorState | null {
  const { next, alert } = decided;
  switch (alert.kind) {
    case 'started':
      return null; // nothing saved: the next check is a first check again
    case 'recovered':
      return prev; // still "an announced problem", so its recovery is re-sent
    case 'problem':
      return { ...next, alerted: false, announced: prev?.status === 'bad' ? prev.announced : [], lastAlertAt: prev?.lastAlertAt ?? 0 };
    case 'changed':
    case 'reminder':
      return { ...next, announced: prev?.announced ?? [], lastAlertAt: prev?.lastAlertAt ?? 0 };
  }
}
