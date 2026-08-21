import { config, getProjectById } from '../config.ts';
import { getPendingBatch, markSent, markFailedPermanently, recordFailedAttempt, type MessageRow } from './queue.ts';
import { resolveChannel, type Channel } from '../whatsapp/existence.ts';
import { sendWhatsAppText, getConnectionState } from '../whatsapp/client.ts';
import { sendSms } from '../sms/provider.ts';
import { renderTemplate } from '../templates/templates.ts';
import { isPaused, recordSuccess, recordFailure } from './circuitBreaker.ts';

const MAX_SEND_ATTEMPTS = 5;
const SEND_TIMEOUT_MS = 15_000; // plan 9, point 5
const EMPTY_QUEUE_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
  const { sendMinDelayMs, sendMaxDelayMs } = config.queue;
  return sendMinDelayMs + Math.random() * (sendMaxDelayMs - sendMinDelayMs);
}

// Unblocks the worker loop after SEND_TIMEOUT_MS even if the underlying call
// never settles — it doesn't cancel the in-flight WhatsApp/SMS call itself,
// just stops one stuck send from freezing every message behind it.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
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

async function processMessage(msg: MessageRow): Promise<void> {
  const project = getProjectById(msg.project);
  if (!project) {
    markFailedPermanently(msg.id, 'unknown_project');
    return;
  }

  // Checked before anything else: a message whose deadline passed during an
  // outage is dropped rather than delivered stale (see queue.ts's ttlMinutes).
  if (msg.expires_at && new Date(`${msg.expires_at}Z`).getTime() < Date.now()) {
    markFailedPermanently(msg.id, 'expired_before_send');
    return;
  }

  const forcedChannel = msg.channel_forced ? (msg.channel as Channel) : undefined;
  let channel: Channel;
  try {
    channel = await resolveChannel(msg.recipient, forcedChannel);
  } catch {
    recordFailedAttempt(msg.id, msg.channel ?? 'whatsapp', 'channel_resolution_error');
    return;
  }

  // Plan 4.6: no WhatsApp on this number and no SMS provider wired yet — this
  // recipient is genuinely unreachable right now, not worth burning retries on.
  if (channel === 'sms' && !config.sms.enabled) {
    markFailedPermanently(msg.id, 'no_channel_available');
    return;
  }

  // WhatsApp is known to be down — an outage, or a session sitting on an
  // unscanned QR. Attempting the send would block for the full 15s timeout
  // AND consume one of the message's 5 attempts; a long enough outage used to
  // walk the oldest queued messages all the way to permanently-failed without
  // a single one ever reaching the network. Leave them pending instead.
  if (channel === 'whatsapp' && !getConnectionState().connected) {
    if (!forcedChannel && config.sms.enabled && !isPaused('sms')) {
      channel = 'sms';
    } else {
      return;
    }
  }

  if (isPaused(channel)) return; // plan 9, point 6 — leave pending, retry next tick

  const payload = JSON.parse(msg.payload) as Record<string, string | number>;
  const { text, variantIndex } = renderTemplate(
    msg.event,
    {
      ...payload,
      brand: project.brandName,
      expiryMinutes: project.otpExpiryMinutes,
    },
    project.templates, // per-project wording; falls back per-event to the shared defaults
  );

  let success = false;
  let lastError: string | undefined;

  try {
    await withTimeout(sendViaChannel(channel, msg.recipient, text), SEND_TIMEOUT_MS);
    success = true;
  } catch (err) {
    lastError = describeError(err);
    recordFailure(channel);
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
    return;
  }

  const attemptsNow = msg.attempts + 1;
  if (attemptsNow >= MAX_SEND_ATTEMPTS) {
    markFailedPermanently(msg.id, lastError ?? 'unknown_error');
  } else {
    recordFailedAttempt(msg.id, channel, lastError ?? 'unknown_error');
  }
}

export function startWorker(): void {
  void loop();
}

async function loop(): Promise<void> {
  for (;;) {
    // Nothing can go out at all while the only configured channel is down.
    // Without this the loop would still walk the whole batch just to skip
    // every row, one 3–9s pace delay at a time.
    if (!getConnectionState().connected && !config.sms.enabled) {
      await sleep(EMPTY_QUEUE_DELAY_MS);
      continue;
    }

    const batch = getPendingBatch(config.queue.sendBatchSize); // plan 9, point 3
    if (batch.length === 0) {
      await sleep(EMPTY_QUEUE_DELAY_MS);
      continue;
    }

    for (const msg of batch) {
      try {
        await processMessage(msg);
      } catch (err) {
        console.error(`[worker] unexpected error processing message ${msg.id}`, err);
      }
      await sleep(randomDelay()); // plan 5, point 3 — human-like pacing
    }
  }
}
