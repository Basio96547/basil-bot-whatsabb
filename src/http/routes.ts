import { Router, type Response } from 'express';
import { enqueue, getStatus, countPending, oldestPendingAgeSeconds, supersedePending } from '../queue/queue.ts';
import { generateOtp, verifyOtp, linkOtpMessage } from '../otp/otp.ts';
import { issueResetToken, validateResetToken } from '../passwordReset/passwordReset.ts';
import { getConnectionState } from '../whatsapp/client.ts';
import { knownEvents, missingPlaceholders } from '../templates/templates.ts';
import { config, type ProjectConfig } from '../config.ts';
import { inTransaction } from '../db.ts';
import { checkSendRate } from '../queue/sendRate.ts';
import { pausedChannels } from '../queue/circuitBreaker.ts';
import { activeEnforcement } from '../whatsapp/enforcement.ts';

export const router = Router();

// digits-only, international format — no '+', no leading 0 (plan 4.2).
//
// `[1-9]` first, not `\d`: the old `^\d{8,15}$` said "no leading 0" in its
// comment and accepted one anyway. A Syrian caller passing the local form
// `0958436703` sailed through, and the damage came later — the number was
// queued, resolved to WhatsApp, and every send attempt hung until the 15s
// timeout, five times over, holding the worker each time. A malformed
// recipient is cheap to reject here and expensive everywhere after.
export const PHONE_RE = /^[1-9]\d{7,14}$/;

router.post('/notify', (req, res) => {
  const project = req.project!;
  const { event, to, payload, channel } = req.body ?? {};

  if (typeof event !== 'string' || !knownEvents().includes(event)) {
    res.status(400).json({ error: 'unknown_event', knownEvents: knownEvents() });
    return;
  }
  if (typeof to !== 'string' || !PHONE_RE.test(to)) {
    res.status(400).json({ error: 'invalid_recipient_format' });
    return;
  }
  if (channel !== undefined && channel !== 'whatsapp' && channel !== 'sms') {
    res.status(400).json({ error: 'invalid_channel' });
    return;
  }
  // Forcing a channel that does not exist here used to be accepted with a 202
  // and then failed by the worker as no_channel_available on its first look —
  // a certain failure reported to the caller as success.
  if (channel === 'sms' && !config.sms.enabled) {
    res.status(400).json({ error: 'channel_unavailable' });
    return;
  }

  // Every value ends up in a customer's message through String(): an object
  // arrived as "طلبك #[object Object]", a boolean as "true". Same defect
  // class as the null/missing placeholders below, caught at the boundary
  // instead of in the customer's chat. null stays allowed — it means "absent"
  // (a nullable DB column serialised straight through) and is treated as such.
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }
  const safePayload = (payload ?? {}) as Record<string, unknown>;
  const badFields = Object.entries(safePayload)
    .filter(([, value]) => !(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))))
    .map(([key]) => key);
  if (badFields.length > 0) {
    res.status(400).json({ error: 'invalid_payload', invalid: badFields });
    return;
  }

  // Refuse an incomplete payload here rather than delivering the placeholder.
  // talisham.com types `name` and `amount` as optional and posts the payload
  // straight through, so a call omitting one used to reach the customer as
  // "المبلغ المطلوب: {amount}" — intermittently, because the variant is
  // chosen at random and only some of them use each field.
  const missing = missingPlaceholders(event, safePayload, project.templates);
  if (missing.length > 0) {
    res.status(400).json({ error: 'missing_placeholders', missing });
    return;
  }

  const result = enqueue({
    project: project.id,
    event,
    recipient: to,
    payload: safePayload as Record<string, string | number>,
    channel,
  });

  if (!result.ok) {
    res.status(429).json({ error: result.reason }); // plan 9, point 2 — backpressure
    return;
  }
  res.status(202).json({ id: result.id, status: 'queued' });
});

router.post('/otp/request', (req, res) => {
  const project = req.project!;
  const { to } = req.body ?? {};

  if (typeof to !== 'string' || !PHONE_RE.test(to)) {
    res.status(400).json({ error: 'invalid_recipient_format' });
    return;
  }

  // Issuing the code and queueing its message are one step: see inTransaction.
  // Anything short of both succeeding must leave no trace, or the caller is
  // told "try later" while holding a code they never received and a cooldown
  // that blocks the retry.
  const outcome = issueAndQueue(project, to, 'otp', project.otpExpiryMinutes);
  respondToIssue(res, outcome);
});

type IssueOutcome =
  | { kind: 'queued'; id: number }
  | { kind: 'already_sent'; retryAfterSeconds: number; expiresInSeconds: number }
  | { kind: 'unavailable'; retryAfterSeconds?: number }
  | { kind: 'rejected'; error: string; retryAfterSeconds?: number };

// A code is only worth sending while there is time left to type it in: a
// message delivered in the last minute or two of the code's life arrives as a
// code that dies before the customer can use it. The message is dropped
// unsent a little before the code itself expires.
const OTP_DELIVERY_MARGIN_MINUTES = 2;

/**
 * Seconds until WhatsApp can send again when that is provably longer than a
 * code lives, or `undefined` for "not known to be blocked".
 *
 * Accepting a verification request while the only channel is known to be
 * dead for hours (logged out and waiting for a human to scan a QR, or under
 * a restriction WhatsApp announced) answered 202 — the site told the customer
 * "code sent", nothing arrived, and each retry spent more of their day. A
 * plain disconnect is NOT treated this way: it usually heals within seconds.
 */
function deliveryBlockedSeconds(ttlMinutes: number): number | null | undefined {
  if (config.sms.enabled) return undefined;
  const wa = getConnectionState();
  if (wa.needsReauth) return null; // until a human acts — no honest estimate
  const enforcement = activeEnforcement();
  if (enforcement) {
    const remainingMs = enforcement.endsAtMs - Date.now();
    if (remainingMs > ttlMinutes * 60_000) return Math.ceil(remainingMs / 1000);
  }
  return undefined;
}

export function issueAndQueue(
  project: ProjectConfig,
  to: string,
  event: 'otp' | 'password_reset',
  ttlMinutes: number,
): IssueOutcome {
  const blocked = deliveryBlockedSeconds(ttlMinutes);
  if (blocked !== undefined) return { kind: 'unavailable', retryAfterSeconds: blocked ?? undefined };

  let rejection: IssueOutcome | null = null;

  const queued = inTransaction<{ id: number }>(() => {
    const purpose = event === 'otp' ? 'login' : 'password_reset';
    const generated = generateOtp(project, to, purpose);
    if (!generated.ok) {
      rejection =
        generated.reason === 'already_sent'
          ? {
              kind: 'already_sent',
              retryAfterSeconds: generated.retryAfterSeconds,
              expiresInSeconds: generated.expiresInSeconds,
            }
          : { kind: 'rejected', error: generated.reason, retryAfterSeconds: generated.retryAfterSeconds };
      return null; // rolls back
    }

    // The new code makes any earlier one still waiting in the queue for this
    // number worthless — see supersedePending.
    supersedePending(project.id, to, event);

    const enqueued = enqueue({
      project: project.id,
      event,
      recipient: to,
      payload: { code: generated.code },
      ttlMinutes: Math.max(1, ttlMinutes - OTP_DELIVERY_MARGIN_MINUTES),
    });
    if (!enqueued.ok) {
      rejection = { kind: 'rejected', error: enqueued.reason };
      return null; // rolls back the code row, its daily-quota row, and the supersede
    }
    // So a later repeat request can tell "the message that would deliver this
    // code already failed" apart from "assume it's fine" — see the
    // already_sent branch in generateOtp — and so the daily cap can refund
    // the send if the message is dropped without going out.
    linkOtpMessage(generated, enqueued.id);
    return { id: enqueued.id };
  });

  if (queued) return { kind: 'queued', id: queued.id };
  return rejection ?? { kind: 'rejected', error: 'unknown_error' };
}

function respondToIssue(res: Response, outcome: IssueOutcome): void {
  if (outcome.kind === 'queued') {
    res.status(202).json({ id: outcome.id, status: 'queued' });
    return;
  }
  // No code issued, no quota spent — every client already maps a non-202 it
  // does not recognise to "try again later", which is the truth here.
  if (outcome.kind === 'unavailable') {
    res.status(503).json({ error: 'delivery_unavailable', retryAfterSeconds: outcome.retryAfterSeconds });
    return;
  }
  // 202, like a fresh send — because from the caller's point of view the thing
  // they asked for is true: this customer has a code on the way. Answering 429
  // here was actively harmful (see generateOtp's `already_sent` branch): a
  // request that succeeded but timed out at the caller left the site insisting
  // nothing was sent while the code was arriving.
  //
  // Deliberately the SAME status a fresh send returns, so the existing clients
  // — which treat only 202 as success — do the right thing before they are
  // updated to read `alreadySent`. The body still says `alreadySent: true`, so
  // a caller that relays it verbatim tells whoever sees it that this number
  // asked for a code recently — keep it server-side.
  if (outcome.kind === 'already_sent') {
    res.status(202).json({
      status: 'already_sent',
      alreadySent: true,
      retryAfterSeconds: outcome.retryAfterSeconds,
      expiresInSeconds: outcome.expiresInSeconds,
    });
    return;
  }
  res.status(429).json({ error: outcome.error, retryAfterSeconds: outcome.retryAfterSeconds });
}

router.post('/otp/verify', (req, res) => {
  const project = req.project!;
  const { to, code } = req.body ?? {};

  if (typeof to !== 'string' || !PHONE_RE.test(to) || typeof code !== 'string') {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const result = verifyOtp(project, to, code, 'login');
  if (!result.ok) {
    res.status(400).json({ error: result.reason, attemptsRemaining: result.attemptsRemaining });
    return;
  }
  res.status(200).json({ ok: true });
});

router.post('/password-reset/request', (req, res) => {
  const project = req.project!;
  const { to } = req.body ?? {};

  if (typeof to !== 'string' || !PHONE_RE.test(to)) {
    res.status(400).json({ error: 'invalid_recipient_format' });
    return;
  }

  respondToIssue(res, issueAndQueue(project, to, 'password_reset', project.otpExpiryMinutes));
});

router.post('/password-reset/verify', (req, res) => {
  const project = req.project!;
  const { to, code } = req.body ?? {};

  if (typeof to !== 'string' || !PHONE_RE.test(to) || typeof code !== 'string') {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const result = verifyOtp(project, to, code, 'password_reset');
  if (!result.ok) {
    res.status(400).json({ error: result.reason, attemptsRemaining: result.attemptsRemaining });
    return;
  }

  const resetToken = issueResetToken(project.id, to);
  res.status(200).json({ ok: true, resetToken });
});

// الـ Talisham backend يستدعي هذا الـ endpoint للتحقق من الـ resetToken قبل تغيير كلمة المرور
router.post('/password-reset/validate-token', (req, res) => {
  const project = req.project!;
  const { token } = req.body ?? {};

  if (typeof token !== 'string') {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const result = validateResetToken(project.id, token);
  if (!result.ok) {
    res.status(400).json({ error: result.reason });
    return;
  }
  res.status(200).json({ ok: true, phone: result.phone });
});

router.get('/status/:id', (req, res) => {
  const project = req.project!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const row = getStatus(id, project.id);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(row);
});

// Plan 9, point 7: reflects load, not just up/down, so a monitor catches
// pressure building before anything actually crashes.
// A queue that stops draining is the only reliable evidence that delivery is
// broken. Sized well above the worker's own pacing (3-9s per message, batches
// of 20) plus a reconnect cycle, so ordinary bursts and brief drops don't trip
// it — but a stall does, within minutes.
const QUEUE_STALL_SECONDS = 10 * 60;

router.get('/health', (_req, res) => {
  const pending = countPending();
  const oldestPendingSeconds = oldestPendingAgeSeconds();
  const wa = getConnectionState();

  // Named reasons rather than a bare boolean: the monitor polling this turns
  // them straight into the alert text, so "needs a QR scan" and "the phone
  // dropped off the network" don't arrive as the same useless "degraded".
  const reasons: string[] = [];
  if (wa.needsReauth) reasons.push('whatsapp_needs_reauth');
  else if (!wa.connected) reasons.push('whatsapp_disconnected');
  if (wa.sessionOrigin === 'restored') reasons.push('session_restored_from_backup');
  if (pending > config.queue.maxPending * 0.8) reasons.push('queue_near_capacity');
  // Capacity alone was never going to catch a stall: at real volume the queue
  // never gets near 4000 rows, so sends could be failing for hours with
  // /health still answering `ok`.
  if (oldestPendingSeconds > QUEUE_STALL_SECONDS) reasons.push('queue_stalled');

  // A restriction WhatsApp announced itself. The most actionable state there
  // is — it names its own end time, and re-pairing before then is the one
  // thing that can extend it — so it must reach the monitor, not just a log.
  const enforcement = activeEnforcement();
  if (enforcement) reasons.push('account_restricted');

  const rate = checkSendRate(wa.pairedAtMs);
  if (!rate.allowed) reasons.push('send_rate_ceiling');

  // A paused channel is a live reason nothing is going out, and it was
  // previously invisible here — the pause state existed but nothing read it.
  const paused = pausedChannels();
  if (paused.length > 0) reasons.push('channel_paused');

  const degraded = reasons.length > 0 && !(reasons.length === 1 && reasons[0] === 'session_restored_from_backup');

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    reasons,
    whatsapp: wa,
    queue: { pending, maxPending: config.queue.maxPending, oldestPendingSeconds },
    sendRate: { used: rate.used, limit: rate.limit, warmingUp: rate.warmingUp },
    pausedChannels: paused,
    enforcement: enforcement
      ? { type: enforcement.type, endsAt: new Date(enforcement.endsAtMs).toISOString() }
      : null,
  });
});
