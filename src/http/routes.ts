import { Router } from 'express';
import { enqueue, getStatus, countPending } from '../queue/queue.ts';
import { generateOtp, verifyOtp } from '../otp/otp.ts';
import { issueResetToken, validateResetToken } from '../passwordReset/passwordReset.ts';
import { getConnectionState } from '../whatsapp/client.ts';
import { knownEvents } from '../templates/templates.ts';
import { config } from '../config.ts';

export const router = Router();

const PHONE_RE = /^\d{8,15}$/; // digits-only, international format — no '+', no leading 0 (plan 4.2)

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

  const generated = generateOtp(project, to);
  if (!generated.ok) {
    res.status(429).json({ error: generated.reason, retryAfterSeconds: generated.retryAfterSeconds });
    return;
  }

  // Past its own validity window the code is worse than no message at all —
  // the recipient types in a number the server already rejects.
  const enqueued = enqueue({
    project: project.id,
    event: 'otp',
    recipient: to,
    payload: { code: generated.code },
    ttlMinutes: project.otpExpiryMinutes,
  });
  if (!enqueued.ok) {
    res.status(429).json({ error: enqueued.reason });
    return;
  }
  res.status(202).json({ id: enqueued.id, status: 'queued' });
});

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

  const generated = generateOtp(project, to, 'password_reset');
  if (!generated.ok) {
    res.status(429).json({ error: generated.reason, retryAfterSeconds: generated.retryAfterSeconds });
    return;
  }

  const enqueued = enqueue({
    project: project.id,
    event: 'password_reset',
    recipient: to,
    payload: { code: generated.code },
    ttlMinutes: project.otpExpiryMinutes,
  });
  if (!enqueued.ok) {
    res.status(429).json({ error: enqueued.reason });
    return;
  }
  res.status(202).json({ id: enqueued.id, status: 'queued' });
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
router.get('/health', (_req, res) => {
  const pending = countPending();
  const wa = getConnectionState();

  // Named reasons rather than a bare boolean: the monitor polling this turns
  // them straight into the alert text, so "needs a QR scan" and "the phone
  // dropped off the network" don't arrive as the same useless "degraded".
  const reasons: string[] = [];
  if (wa.needsReauth) reasons.push('whatsapp_needs_reauth');
  else if (!wa.connected) reasons.push('whatsapp_disconnected');
  if (wa.sessionOrigin === 'restored') reasons.push('session_restored_from_backup');
  if (pending > config.queue.maxPending * 0.8) reasons.push('queue_near_capacity');

  const degraded = reasons.length > 0 && !(reasons.length === 1 && reasons[0] === 'session_restored_from_backup');

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    reasons,
    whatsapp: wa,
    queue: { pending, maxPending: config.queue.maxPending },
  });
});
