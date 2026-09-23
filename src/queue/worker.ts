import { config, getProjectById } from '../config.ts';
import {
  getPendingBatch,
  markSent,
  markSentIfStillPending,
  markFailedPermanently,
  dropUnsent,
  isStillPending,
  recordFailedAttempt,
  type MessageRow,
} from './queue.ts';
import { resolveChannel, type Channel } from '../whatsapp/existence.ts';
import { sendWhatsAppText, getConnectionState } from '../whatsapp/client.ts';
import { sendSms } from '../sms/provider.ts';
import { renderTemplate } from '../templates/templates.ts';
import { isPaused, recordSuccess, recordFailure } from './circuitBreaker.ts';
import { sleepUnlessWoken } from './wakeup.ts';
import { checkSendRate } from './sendRate.ts';
import { activeEnforcement, type Enforcement } from '../whatsapp/enforcement.ts';

const MAX_SEND_ATTEMPTS = 5;
const SEND_TIMEOUT_MS = 15_000; // plan 9, point 5

// نبضة الخمول تتضاعف من ٥ ثوانٍ إلى دقيقة بدل أن تظل ثابتة عند ٥. الثابتة
// كانت تُبقي معالج الجوال مستيقظاً على مدار الساعة (راجع wakeup.ts)، ولا
// تشتري أي سرعة: enqueue() يوقظ الحلقة فوراً، فالرسالة الحقيقية لا تنتظر
// النبضة أصلاً. ما يتأخر هو إعادة محاولة رسالة فاشلة — وتأخيرها دقيقة بدل
// خمس ثوانٍ مطلوب لا مرفوض على عميل واتساب غير رسمي.
const IDLE_MIN_DELAY_MS = 5_000;
const IDLE_MAX_DELAY_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
  const { sendMinDelayMs, sendMaxDelayMs } = config.queue;
  return sendMinDelayMs + Math.random() * (sendMaxDelayMs - sendMinDelayMs);
}

// Unblocks the worker loop after SEND_TIMEOUT_MS even if the underlying call
// never settles — it doesn't cancel the in-flight WhatsApp/SMS call itself,
// just stops one stuck send from freezing every message behind it. Exported
// for testing: resolveChannel()'s own call site below needs the exact same
// guarantee (Baileys' onWhatsApp() has no timeout of its own), and a real
// SEND_TIMEOUT_MS-length test here would be far too slow for this suite.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  // Cleared once the call settles: every message used to leave a 15 s timer
  // behind, each one a wake-up on a phone that should be asleep.
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

async function sendViaChannel(channel: Channel, phone: string, text: string): Promise<void> {
  if (channel === 'whatsapp') {
    await sendWhatsAppText(phone, text);
  } else {
    const result = await sendSms(phone, text);
    if (!result.ok) throw new Error(result.error ?? 'sms_failed');
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Overridable only from tests: getConnectionState()'s `connected`/`pairedAtMs`
// only ever become true/non-null via a real Baileys `connection.update`
// event, so exercising the whatsapp-blocked branches in processMessage below
// without a live socket needs a seam. Production code never passes this.
export interface WhatsAppGateDeps {
  isConnected: () => boolean;
  pairedAtMs: () => number | null;
  activeEnforcement: () => Enforcement | null;
  checkSendRate: (pairedAtMs: number | null) => { allowed: boolean };
}

export const defaultGateDeps: WhatsAppGateDeps = {
  isConnected: () => getConnectionState().connected,
  pairedAtMs: () => getConnectionState().pairedAtMs,
  activeEnforcement,
  checkSendRate,
};

/**
 * ترجع `true` إذا خرجت محاولة إرسال فعلية إلى الشبكة، و`false` إذا انتهت
 * الرسالة بقرار محلي (مشروع مجهول، انتهت صلاحيتها، القناة موقوفة، واتساب
 * مقطوع). الفرق ليس تجميلياً: مهلة المباعدة البشرية بين الرسائل تُدفع فقط
 * مقابل إرسال حقيقي — كانت تُدفع حتى للصفوف المتخطّاة، فتقضي الحلقة دقيقتين
 * في المؤقّتات لكل دفعة أثناء أي انقطاع دون أن تُرسل حرفاً واحداً.
 */
export async function processMessage(msg: MessageRow, gateDeps: WhatsAppGateDeps = defaultGateDeps): Promise<boolean> {
  const project = getProjectById(msg.project);
  if (!project) {
    dropUnsent(msg.id, 'unknown_project');
    return false;
  }

  // Checked before anything else: a message whose deadline passed during an
  // outage is dropped rather than delivered stale (see queue.ts's ttlMinutes).
  if (msg.expires_at && new Date(`${msg.expires_at}Z`).getTime() < Date.now()) {
    dropUnsent(msg.id, 'expired_before_send');
    return false;
  }

  const forcedChannel = msg.channel_forced ? (msg.channel as Channel) : undefined;
  // Read once, used only for this synchronous check. The whatsappBlocked
  // gate below reads gateDeps.isConnected() again rather than reusing this —
  // an await (resolveChannel, in the branch below) sits between the two, so
  // the connection can genuinely change state in between; reusing a stale
  // value there would be a real bug, not just a missed dedup.
  const connected = gateDeps.isConnected();
  let channel: Channel;
  if (!forcedChannel && !connected) {
    // resolveChannel() calls Baileys' onWhatsApp() for any recipient not
    // already in the existence cache, which needs a live socket. During a
    // reconnect flap (frequent on this phone's network — plain
    // "connectionClosed" drops every few minutes) that call either throws
    // right away or hangs until SEND_TIMEOUT_MS, and either way the catch
    // below used to burn one of only 5 attempts on a failure that has
    // nothing to do with this recipient. A handful of those flaps back to
    // back could exhaust all 5 and permanently fail a message the socket
    // would have delivered seconds later. Route straight to SMS if it's
    // configured, otherwise leave the message pending — the same outcome
    // the whatsappBlocked gate below already gives a message whose channel
    // WAS resolved, just reached before resolution wastes an attempt on it.
    if (config.sms.enabled && !isPaused('sms')) {
      channel = 'sms';
    } else {
      return false;
    }
  } else {
    try {
      // resolveChannel() routes to Baileys' onWhatsApp(), whose own query has
      // no timeout of its own and can hang for a long time on a bad
      // connection — unlike every other outbound call on this path
      // (sendViaChannel below), this await had nothing bounding it, so one
      // slow/hung lookup could block this whole batch of up to
      // sendBatchSize messages for minutes.
      channel = await withTimeout(resolveChannel(msg.recipient, forcedChannel), SEND_TIMEOUT_MS);
    } catch {
      recordFailedAttempt(msg.id, msg.channel ?? 'whatsapp', 'channel_resolution_error');
      return false;
    }
  }

  // Plan 4.6: no WhatsApp on this number and no SMS provider wired yet — this
  // recipient is genuinely unreachable right now, not worth burning retries on.
  if (channel === 'sms' && !config.sms.enabled) {
    dropUnsent(msg.id, 'no_channel_available');
    return false;
  }

  // WhatsApp is unavailable for sending right now — down, under an active
  // restriction WhatsApp itself announced, or over this account's own hourly
  // send ceiling. Checked per message, right before the attempt: the previous
  // shape checked enforcement/rate once per BATCH (up to sendBatchSize
  // messages) at the top of the outer loop, so a restriction or ceiling
  // crossed mid-batch still let the rest of that batch go out — directly
  // against the point of either mechanism. Attempting the send anyway would
  // also block for the full 15s timeout AND consume one of the message's 5
  // attempts; a long enough outage used to walk the oldest queued messages
  // all the way to permanently-failed without a single one ever reaching the
  // network. Leave them pending instead.
  if (channel === 'whatsapp') {
    const whatsappBlocked =
      !gateDeps.isConnected() ||
      gateDeps.activeEnforcement() !== null ||
      !gateDeps.checkSendRate(gateDeps.pairedAtMs()).allowed;
    if (whatsappBlocked) {
      if (!forcedChannel && config.sms.enabled && !isPaused('sms')) {
        channel = 'sms';
      } else {
        return false;
      }
    }
  }

  if (isPaused(channel)) return false; // plan 9, point 6 — leave pending, retry next tick

  const payload = JSON.parse(msg.payload) as Record<string, string | number>;
  let text: string;
  let variantIndex: number;
  try {
    ({ text, variantIndex } = renderTemplate(
      msg.event,
      {
        ...payload,
        brand: project.brandName,
        expiryMinutes: project.otpExpiryMinutes,
      },
      project.templates, // per-project wording; falls back per-event to the shared defaults
    ));
  } catch (err) {
    // A payload that reaches here without any variant fully satisfiable is a
    // data/config problem (a payload missing a field, or an override with a
    // placeholder /notify's own check doesn't agree with), not a transient
    // one — retrying it changes nothing. Before this guard the throw reached
    // the loop's outer catch below, which only logs: the row's status and
    // attempts never changed, so getPendingBatch (oldest first) re-selected
    // and re-threw on the exact same row on every single tick, forever —
    // occupying a queue slot with a message that could never succeed or fail.
    dropUnsent(msg.id, `template_render_failed: ${describeError(err)}`);
    return false;
  }

  // The batch was read before this row's turn came — up to a whole batch of
  // 3–9 s pacing delays ago. In that time a newer verification code for the
  // same number may have superseded it (routes.ts), or a late-arriving send
  // may have completed it. Sending it anyway delivered exactly the stale code
  // superseding exists to hold back.
  if (!isStillPending(msg.id)) return false;

  let success = false;
  let lastError: string | undefined;

  const firstChannel = channel;
  const firstSend = sendViaChannel(firstChannel, msg.recipient, text);
  try {
    await withTimeout(firstSend, SEND_TIMEOUT_MS);
    success = true;
  } catch (err) {
    lastError = describeError(err);
    recordFailure(channel);
    if (lastError === 'timeout') {
      // withTimeout stops waiting; it cannot cancel the call. When that call
      // does complete, the message WAS delivered — recording it keeps the
      // next retry from delivering it a second time. Nothing to do if it
      // fails late, or if a retry got there first.
      firstSend.then(
        () => {
          if (markSentIfStillPending(msg.id, firstChannel, variantIndex)) {
            recordSuccess(firstChannel);
            console.warn(`[worker] رسالة ${msg.id} وصلت بعد انتهاء المهلة — سُجّلت مُرسَلة بدل إعادة إرسالها`);
          }
        },
        () => {},
      );
    }
  }

  // Plan 6: auto-routed WhatsApp send failed — try SMS in the same cycle
  // before giving up. Skipped for caller-forced channels (they asked for a
  // specific one) and when SMS itself is currently paused.
  if (!success && channel === 'whatsapp' && !forcedChannel && config.sms.enabled && !isPaused('sms')) {
    try {
      await withTimeout(sendViaChannel('sms', msg.recipient, text), SEND_TIMEOUT_MS);
      success = true;
      channel = 'sms';
    } catch (err) {
      lastError = describeError(err);
      recordFailure('sms');
    }
  }

  if (success) {
    recordSuccess(channel);
    markSent(msg.id, channel, variantIndex);
    return true;
  }

  const attemptsNow = msg.attempts + 1;
  if (attemptsNow >= MAX_SEND_ATTEMPTS) {
    markFailedPermanently(msg.id, lastError ?? 'unknown_error');
  } else {
    recordFailedAttempt(msg.id, channel, lastError ?? 'unknown_error');
  }
  return true; // خرجت إلى الشبكة وفشلت — تستحق المباعدة مثل الناجحة تماماً
}

export function startWorker(): void {
  void loop();
}

async function loop(): Promise<void> {
  let idleDelay = IDLE_MIN_DELAY_MS;
  const backOff = async (): Promise<void> => {
    await sleepUnlessWoken(idleDelay);
    idleDelay = Math.min(idleDelay * 2, IDLE_MAX_DELAY_MS);
  };

  for (;;) {
    // The whole tick is guarded: startWorker() does `void loop()`, so a throw
    // anywhere in here (getPendingBatch()/getConnectionState() hitting a full
    // disk or a locked db, or anything else unanticipated) used to reject
    // this promise with nothing to catch it — an unhandled rejection that
    // took the whole process down, and with it the live WhatsApp socket.
    // Housekeeping failing here is not a reason to drop the service; log it,
    // back off, and let the next tick try again — same philosophy as
    // retention.ts's own sweep guard.
    try {
      await runOneTick();
    } catch (err) {
      console.error('[worker] خطأ غير متوقع في حلقة العامل — سيُعاد المحاولة بعد تراجع', err);
      await backOff();
    }
  }

  async function runOneTick(): Promise<void> {
    // Nothing can go out at all while the only configured channel is down.
    // Without this the loop would still walk the whole batch just to skip
    // every row. عودة واتساب تستدعي notifyWork() فتقطع هذا الانتظار فوراً.
    if (!getConnectionState().connected && !config.sms.enabled) {
      await backOff();
      return;
    }

    // An active restriction from WhatsApp itself, and this account's own
    // hourly send ceiling, both outrank everything for a WHATSAPP send — but
    // are checked per message inside processMessage() now, not once here for
    // the whole batch. A blanket check here (the previous shape) meant a
    // restriction or ceiling crossed mid-batch still let the rest of an
    // already-fetched batch of up to sendBatchSize messages go out, and it
    // blocked fetching the batch AT ALL — including SMS-bound messages, which
    // carry no WhatsApp ban risk and have nothing to do with either check.
    //
    // The two checks below are PURELY informational — logging only, never a
    // `continue` — so operators still see why WhatsApp sends are stalled
    // without that visibility doubling as the (buggy) gate again.
    const enforcement = activeEnforcement();
    let rateAllowed = true;
    if (enforcement) {
      console.warn(
        `[worker] حساب واتساب مقيَّد (${enforcement.type}) حتى ${new Date(enforcement.endsAtMs).toISOString()} — الإرسال عبر واتساب متوقف، وSMS غير متأثر`,
      );
    } else {
      const rate = checkSendRate(getConnectionState().pairedAtMs);
      rateAllowed = rate.allowed;
      if (!rate.allowed) {
        console.warn(
          `[worker] بلغ سقف الإرسال (${rate.used}/${rate.limit} في الساعة${rate.warmingUp ? '، رقم حديث الربط' : ''}) — واتساب متوقف مؤقتاً، وSMS غير متأثر`,
        );
      }
    }

    // Rows a caller pinned to a channel that cannot send this tick are left
    // out of the batch, so they cannot fill it and hide the rows behind them
    // (see getPendingBatch). Only a filter on what is FETCHED — the
    // per-message gate in processMessage stays the authority on what is sent.
    const blockedForced: Channel[] = [];
    if (!getConnectionState().connected || enforcement || !rateAllowed || isPaused('whatsapp')) blockedForced.push('whatsapp');
    if (!config.sms.enabled || isPaused('sms')) blockedForced.push('sms');

    const batch = getPendingBatch(config.queue.sendBatchSize, blockedForced); // plan 9, point 3
    if (batch.length === 0) {
      await backOff();
      return;
    }

    let sentAnything = false;
    for (const msg of batch) {
      let attempted = false;
      try {
        attempted = await processMessage(msg);
      } catch (err) {
        console.error(`[worker] unexpected error processing message ${msg.id}`, err);
      }
      if (attempted) {
        sentAnything = true;
        await sleep(randomDelay()); // plan 5, point 3 — human-like pacing
      }
    }

    if (sentAnything) {
      idleDelay = IDLE_MIN_DELAY_MS; // في نوبة عمل — عُد إلى أسرع نبضة
    } else {
      // الدفعة غير فارغة لكن ولا صف منها خرج (قناة موقوفة، واتساب مقطوع
      // ورسائل مثبَّتة على قناة). بلا هذا التراجع تصير الحلقة حلقةَ ازدحام
      // حقيقية: تقرأ نفس الصفوف بأقصى سرعة يردّ بها SQLite، بلا أي مهلة —
      // وهذا أسوأ من السلوك القديم الذي كانت المباعدة تكبحه بالصدفة.
      await backOff();
    }
  }
}
