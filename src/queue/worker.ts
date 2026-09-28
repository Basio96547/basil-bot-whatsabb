import { config, getProjectById } from '../config.ts';
import {
  getPendingBatch,
  markSent,
  markSentIfStillPending,
  markFailedPermanently,
  dropUnsent,
  isStillPending,
  recordFailedAttempt,
  deferMessage,
  expireOverdue,
  type MessageRow,
} from './queue.ts';
import { resolveChannel, type Channel } from '../whatsapp/existence.ts';
import { sendWhatsAppText, getConnectionState, WhatsAppRejectedError } from '../whatsapp/client.ts';
import { sendSms } from '../sms/provider.ts';
import { renderTemplate } from '../templates/templates.ts';
import { isPaused, recordSuccess, recordFailure } from './circuitBreaker.ts';
import { sleepUnlessWoken, notifyWork, workSignals } from './wakeup.ts';
import { checkSendRate } from './sendRate.ts';
import { activeEnforcement, type Enforcement } from '../whatsapp/enforcement.ts';

const MAX_SEND_ATTEMPTS = 5;
const SEND_TIMEOUT_MS = 15_000; // plan 9, point 5

// How long a message waits after its Nth failed attempt before it is tried
// again. Without any spacing the same oldest row came straight back on the
// next tick: a lone message hitting a fast transient error ("Connection
// Closed" a moment before the close event lands) spent all five attempts in
// about twelve seconds — and the circuit breaker, which trips at the same
// count, paused WhatsApp for every project on the very failure that had
// already killed the message instead of buying it time.
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
// A WhatsApp lookup that timed out says nothing about the message — it is
// put back without spending an attempt (see deferMessage).
const LOOKUP_RETRY_DELAY_MS = 60_000;

// Sends that outlived SEND_TIMEOUT_MS and have not settled yet, with when
// they started. withTimeout stops WAITING; it cannot cancel the call. The row
// stays pending, and the next tick used to pick it straight back up and send
// it again while the first call was still running — any send slower than
// about 20 s went out twice. A row in here is skipped until its call settles
// (or, should it never settle, until UNSETTLED_GIVE_UP_MS has passed).
const unsettled = new Map<number, number>();
const UNSETTLED_GIVE_UP_MS = 5 * 60_000;

// Sends that reached the recipient but whose 'sent' could not be written (a
// full disk). The row stayed pending, so it was sent AGAIN on every tick until
// its deadline — up to one copy a minute for a day — and, being unrecorded,
// none of those copies counted toward the hourly ceiling either. Kept here and
// written as soon as the database accepts it; never re-sent meanwhile.
const unrecorded = new Map<number, { channel: Channel; variantIndex: number }>();

function recordSentOrRemember(id: number, channel: Channel, variantIndex: number, onlyIfPending: boolean): boolean {
  try {
    const recorded = onlyIfPending ? markSentIfStillPending(id, channel, variantIndex) : (markSent(id, channel, variantIndex), true);
    unrecorded.delete(id);
    return recorded;
  } catch (err) {
    unrecorded.set(id, { channel, variantIndex });
    console.error(`[worker] رسالة ${id} أُرسلت لكن تعذّر تسجيلها — لن تُعاد، وسيُعاد التسجيل لاحقاً`, err);
    return false;
  }
}

/** Writes the 'sent' of any delivered message the database refused earlier. */
export function flushUnrecorded(): void {
  for (const [id, sent] of unrecorded) {
    try {
      markSentIfStillPending(id, sent.channel, sent.variantIndex);
      unrecorded.delete(id);
    } catch {
      return; // the database still refuses writes — try again next tick
    }
  }
}

/** Rows whose outcome is still unknown, so nothing may decide it for them. */
function rowsInFlight(): number[] {
  const now = Date.now();
  const ids = [...unrecorded.keys()];
  for (const [id, since] of unsettled) {
    if (now - since < UNSETTLED_GIVE_UP_MS) ids.push(id);
    else unsettled.delete(id);
  }
  return ids;
}

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
  resolveChannel: (phone: string, forced?: Channel) => Promise<Channel>;
  send: (channel: Channel, phone: string, text: string) => Promise<void>;
  /** SEND_TIMEOUT_MS; shorter only in tests, which cannot wait 15 s per case. */
  sendTimeoutMs?: number;
}

export const defaultGateDeps: WhatsAppGateDeps = {
  isConnected: () => getConnectionState().connected,
  pairedAtMs: () => getConnectionState().pairedAtMs,
  activeEnforcement,
  checkSendRate,
  resolveChannel,
  send: sendViaChannel,
};

/**
 * ترجع `true` إذا خرجت محاولة إرسال فعلية إلى الشبكة، و`false` إذا انتهت
 * الرسالة بقرار محلي (مشروع مجهول، انتهت صلاحيتها، القناة موقوفة، واتساب
 * مقطوع). الفرق ليس تجميلياً: مهلة المباعدة البشرية بين الرسائل تُدفع فقط
 * مقابل إرسال حقيقي — كانت تُدفع حتى للصفوف المتخطّاة، فتقضي الحلقة دقيقتين
 * في المؤقّتات لكل دفعة أثناء أي انقطاع دون أن تُرسل حرفاً واحداً.
 */
export async function processMessage(msg: MessageRow, gateDeps: WhatsAppGateDeps = defaultGateDeps): Promise<boolean> {
  // A send for this row is still in flight, or went out and is waiting to be
  // recorded — either way, sending it now would be a second copy.
  const inFlightSince = unsettled.get(msg.id);
  if (inFlightSince !== undefined && Date.now() - inFlightSince < UNSETTLED_GIVE_UP_MS) return false;
  if (unrecorded.has(msg.id)) return false;

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
      channel = await withTimeout(gateDeps.resolveChannel(msg.recipient, forcedChannel), gateDeps.sendTimeoutMs ?? SEND_TIMEOUT_MS);
    } catch {
      deferMessage(msg.id, 'channel_resolution_error', LOOKUP_RETRY_DELAY_MS);
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
  //
  // A circuit-breaker pause is one more such reason: an auto-routed message
  // used to wait out the whole pause (up to ten minutes) even with SMS ready.
  if (channel === 'whatsapp') {
    const whatsappBlocked =
      !gateDeps.isConnected() ||
      isPaused('whatsapp') ||
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
  // WhatsApp itself refused the message in a way retrying only worsens (463:
  // the account may not start new chats right now — each retry is one more
  // "reach out" counted against it). See WhatsAppRejectedError.
  let permanent = false;

  const firstChannel = channel;
  const sendTimeoutMs = gateDeps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const firstSend = gateDeps.send(firstChannel, msg.recipient, text);
  try {
    await withTimeout(firstSend, sendTimeoutMs);
    success = true;
  } catch (err) {
    lastError = describeError(err);
    permanent = err instanceof WhatsAppRejectedError && err.permanent;
    recordFailure(channel);
    if (lastError === 'timeout') {
      // withTimeout stops waiting; it cannot cancel the call. Until that call
      // settles the row is held back (see `unsettled`) — and when it does
      // complete, the message WAS delivered: recording it keeps a later
      // retry from delivering it a second time.
      unsettled.set(msg.id, Date.now());
      firstSend.then(
        () => {
          unsettled.delete(msg.id);
          if (recordSentOrRemember(msg.id, firstChannel, variantIndex, true)) {
            recordSuccess(firstChannel);
            console.warn(`[worker] رسالة ${msg.id} وصلت بعد انتهاء المهلة — سُجّلت مُرسَلة بدل إعادة إرسالها`);
          }
        },
        () => {
          unsettled.delete(msg.id);
          notifyWork(); // it is retryable again — no need to wait out a long idle sleep
        },
      );
    }
  }

  // Plan 6: auto-routed WhatsApp send failed — try SMS in the same cycle
  // before giving up. Skipped for caller-forced channels (they asked for a
  // specific one) and when SMS itself is currently paused.
  if (!success && channel === 'whatsapp' && !forcedChannel && config.sms.enabled && !isPaused('sms')) {
    try {
      await withTimeout(gateDeps.send('sms', msg.recipient, text), sendTimeoutMs);
      success = true;
      channel = 'sms';
    } catch (err) {
      lastError = describeError(err);
      recordFailure('sms');
    }
  }

  if (success) {
    recordSuccess(channel);
    recordSentOrRemember(msg.id, channel, variantIndex, false);
    return true;
  }

  const attemptsNow = msg.attempts + 1;
  if (permanent || attemptsNow >= MAX_SEND_ATTEMPTS) {
    markFailedPermanently(msg.id, lastError ?? 'unknown_error');
  } else {
    const retryInMs = RETRY_DELAYS_MS[Math.min(attemptsNow, RETRY_DELAYS_MS.length) - 1];
    recordFailedAttempt(msg.id, channel, lastError ?? 'unknown_error', retryInMs);
  }
  return true; // خرجت إلى الشبكة وفشلت — تستحق المباعدة مثل الناجحة تماماً
}

let stopping = false;
let running: Promise<void> | null = null;
let current: Promise<unknown> = Promise.resolve();

export function startWorker(): void {
  stopping = false;
  running = loop();
}

/**
 * Stops taking new messages and resolves once the one being sent right now
 * (if any) has finished — so a restart does not cut a send off halfway and
 * leave a delivered message pending, to be sent again after the restart.
 */
export async function stopWorker(): Promise<void> {
  stopping = true;
  notifyWork(); // cut an idle sleep short
  await current.catch(() => {});
  await running;
}

async function loop(): Promise<void> {
  let idleDelay = IDLE_MIN_DELAY_MS;
  let signalAtTickStart = workSignals();
  const backOff = async (): Promise<void> => {
    // Work arrived while this tick was busy — its wake-up found nobody
    // sleeping. Look again now instead of sleeping through it.
    if (workSignals() !== signalAtTickStart) return;
    await sleepUnlessWoken(idleDelay);
    idleDelay = Math.min(idleDelay * 2, IDLE_MAX_DELAY_MS);
  };

  while (!stopping) {
    signalAtTickStart = workSignals();
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
    flushUnrecorded();
    // Before anything that can skip the tick: rows nobody will fetch (pinned
    // to a blocked channel) must still expire — see expireOverdue.
    expireOverdue(rowsInFlight());

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
    //
    // SMS counts as blocked only while PAUSED. With no provider at all, a row
    // forced onto SMS can never go out, and fetching it is what lets
    // processMessage drop it (no_channel_available) instead of leaving it
    // pending forever.
    const blockedForced: Channel[] = [];
    if (!getConnectionState().connected || enforcement || !rateAllowed || isPaused('whatsapp')) blockedForced.push('whatsapp');
    if (config.sms.enabled && isPaused('sms')) blockedForced.push('sms');

    const batch = getPendingBatch(config.queue.sendBatchSize, blockedForced); // plan 9, point 3
    if (batch.length === 0) {
      await backOff();
      return;
    }

    let sentAnything = false;
    for (const msg of batch) {
      if (stopping) return;
      let attempted = false;
      try {
        const work = processMessage(msg);
        current = work;
        attempted = await work;
      } catch (err) {
        console.error(`[worker] unexpected error processing message ${msg.id}`, err);
      }
      if (attempted) {
        sentAnything = true;
        if (stopping) return;
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
