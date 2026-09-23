import express, { type ErrorRequestHandler } from 'express';
import { requireProjectApiKey } from './auth.ts';
import { router } from './routes.ts';

// body-parser's own failures (malformed JSON, too large, unsupported charset
// or encoding) carry a `type` and a 4xx `status`. They used to fall through
// to handleUnexpected below and come back as 500 internal_error, with a full
// stack trace written to the phone's log for every oversized request.
const BODY_ERRORS: Record<string, string> = {
  'entity.parse.failed': 'invalid_json_body',
  'entity.too.large': 'payload_too_large',
  'charset.unsupported': 'unsupported_charset',
  'encoding.unsupported': 'unsupported_encoding',
  'request.aborted': 'request_aborted',
  'request.size.invalid': 'invalid_request_size',
};

const handleBodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  const type = (err as { type?: unknown })?.type;
  const status = (err as { status?: unknown })?.status;
  if (typeof type === 'string' && type in BODY_ERRORS && typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: BODY_ERRORS[type] });
    return;
  }
  next(err);
};

// Every route in this service is synchronous and touches SQLite, so a locked
// database, a full disk or a corrupt row throws straight out of the handler.
// Without this, Express's default handler answers with an HTML error page —
// and both clients (talisham.com, khidam.com) parse the body as JSON and fall
// back to a generic "unreachable", so the real cause reached nobody in a
// usable form. Registered LAST: error middleware only catches what precedes it.
const handleUnexpected: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[http] خطأ غير متوقع في المعالجة', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
};

export function createServer() {
  const app = express();
  // The key is checked BEFORE the body is read: it lives in a header, and
  // parsing up to 32 KB of JSON for a caller who is about to get a 401 was
  // work — and log lines — spent on anyone who can reach the tunnel.
  app.use(requireProjectApiKey);
  app.use(express.json({ limit: '32kb' })); // plan 9, point 2 — reject oversized bodies early
  app.use(handleBodyErrors);
  app.use(router);
  app.use(handleUnexpected);
  return app;
}
