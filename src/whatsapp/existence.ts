import { db } from '../db.ts';
import { getSocket } from './client.ts';

// plan 4.6: ~week per number — but only for a POSITIVE result, which cannot go
// stale in a way that hurts (a number that had WhatsApp keeps having it, and
// if it stops the send itself fails and the worker falls back).
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A negative result is different: it means "route this number to SMS", and
// with no SMS provider configured the worker marks the message
// no_channel_available and permanently fails it on the first attempt. So a
// customer who installs WhatsApp after being checked once could not receive a
// code for a whole WEEK, and /status reported a hard failure that looks like a
// bad number rather than a stale cache. Re-checked hourly instead: one extra
// onWhatsApp call per number per hour, against locking a paying customer out.
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;

const selectCached = db.prepare(`SELECT has_whatsapp, checked_at FROM whatsapp_status_cache WHERE phone = ?`);
const upsertCache = db.prepare(`
  INSERT INTO whatsapp_status_cache (phone, has_whatsapp, checked_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(phone) DO UPDATE SET has_whatsapp = excluded.has_whatsapp, checked_at = excluded.checked_at
`);

export type ExistenceResult = 'yes' | 'no' | 'unknown';

// The question gets this share of however long the caller waits for the
// lookup — the worker's lookup timeout, SEND_TIMEOUT_MS (15 s): 5 s. The rest
// is margin, so 'unknown' always reaches the worker while it is still waiting.
//
// Baileys gives up on a query WhatsApp leaves unanswered only after its own
// defaultQueryTimeoutMs — 60 s, which client.ts does not change — and then
// resolves undefined. Long before that the worker had stopped waiting and
// deferred the message as channel_resolution_error; the next tick asked again,
// and again, every ~75 s until the message expired. The 'unknown' below that
// sends it to WhatsApp (plan 4.6) never reached anyone: a /notify message to
// such a number cost about 1,150 unanswered queries over its day, and was
// never tried at all.
const SHARE_OF_CALLER_WAIT = 1 / 3;

/** How long the existence query may take when the caller waits `callerWaitMs` for the whole lookup. */
export function existenceDeadlineMs(callerWaitMs: number): number {
  return Math.floor(callerWaitMs * SHARE_OF_CALLER_WAIT);
}

export async function checkWhatsAppExists(digitsOnlyPhone: string, deadlineMs: number): Promise<ExistenceResult> {
  const cached = selectCached.get(digitsOnlyPhone) as { has_whatsapp: number; checked_at: string } | undefined;
  if (cached) {
    const age = Date.now() - new Date(`${cached.checked_at}Z`).getTime();
    const ttl = cached.has_whatsapp ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (age < ttl) return cached.has_whatsapp ? 'yes' : 'no';
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const unanswered = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, deadlineMs, undefined);
    });
    const results = await Promise.race([getSocket().onWhatsApp(digitsOnlyPhone), unanswered]);
    // No answer in time, or Baileys' own undefined for a query that timed out
    // on its side: no answer either way, not "no WhatsApp". Read as one, it
    // was cached for an hour and routed the number to SMS — with no provider,
    // every code for it dropped as no_channel_available though the customer
    // has WhatsApp.
    if (!Array.isArray(results)) return 'unknown';
    const exists = Boolean(results[0]?.exists);
    upsertCache.run(digitsOnlyPhone, exists ? 1 : 0);
    return exists ? 'yes' : 'no';
  } catch {
    // Plan 4.6: check itself failed (network hiccup) — caller falls back to
    // try-whatsapp-then-sms-on-failure instead of routing upfront.
    return 'unknown';
  } finally {
    clearTimeout(timer); // a timer left behind per lookup is one more wake-up on the phone
  }
}

export type Channel = 'whatsapp' | 'sms';

// Plan 4.1 + 4.6: caller-specified channel wins outright; otherwise route by
// existence check, and an inconclusive check defaults to trying WhatsApp
// first (the worker's own send-failure fallback covers the rest).
// `callerWaitMs`: how long the caller waits for this answer — see
// existenceDeadlineMs.
export async function resolveChannel(digitsOnlyPhone: string, override: Channel | undefined, callerWaitMs: number): Promise<Channel> {
  if (override) return override;
  const existence = await checkWhatsAppExists(digitsOnlyPhone, existenceDeadlineMs(callerWaitMs));
  if (existence === 'no') return 'sms';
  return 'whatsapp';
}
