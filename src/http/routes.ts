import { Router, type Response } from 'express';
import { enqueue, getStatus, countPending, oldestPendingAgeSeconds } from '../queue/queue.ts';
import { generateOtp, verifyOtp } from '../otp/otp.ts';
import { issueResetToken, validateResetToken } from '../passwordReset/passwordReset.ts';
import { getConnectionState } from '../whatsapp/client.ts';
import { knownEvents } from '../templates/templates.ts';
import { config, type ProjectConfig } from '../config.ts';
import { inTransaction } from '../db.ts';

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

  const result = enqueue({
    project: project.id,
    event,
    recipient: to,
    payload: payload && typeof payload === 'object' ? payload : {},
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
  | { kind: 'rejected'; error: string; retryAfterSeconds?: number };

export function issueAndQueue(
  project: ProjectConfig,
  to: string,
  event: 'otp' | 'password_reset',
  ttlMinutes: number,
): IssueOutcome {
  let rejection: IssueOutcome | null = null;

  const queued = inTransaction<{ id: number }>(() => {
    const purpose = event === 'otp' ? 'login' : 'password_reset';
    const generated = generateOtp(project, to, purpose);
    if (!generated.ok) {
      rejection = { kind: 'rejected', error: generated.reason, retryAfterSeconds: generated.retryAfterSeconds };
      return null; // rolls back
    }

    // Past its own validity window the code is worse than no message at all —
    // the recipient types in a number the server already rejects.
    const enqueued = enqueue({
      project: project.id,
      event,
      recipient: to,
      payload: { code: generated.code },
      ttlMinutes,
    });
    if (!enqueued.ok) {
      rejection = { kind: 'rejected', error: enqueued.reason };
      return null; // rolls back the code row AND its daily-quota row
    }
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

  const degraded = reasons.length > 0 && !(reasons.length === 1 && reasons[0] === 'session_restored_from_backup');

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    reasons,
    whatsapp: wa,
    queue: { pending, maxPending: config.queue.maxPending, oldestPendingSeconds },
  });
});
