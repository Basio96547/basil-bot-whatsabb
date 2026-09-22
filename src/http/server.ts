import express, { type ErrorRequestHandler } from 'express';
import { requireProjectApiKey } from './auth.ts';
import { router } from './routes.ts';

const handleBadJson: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid_json_body' });
    return;
  }
  next(err);
};

// Every route in this service is synchronous and touches SQLite, so a locked
// database, a full disk or a corrupt row throws straight out of the handler.
// Without this, Express's default handler answers with an HTML error page —
// and both clients (talisham.com, qareeb) parse the body as JSON and fall back
// to a generic "unreachable", so the real cause reached nobody in a usable
// form. Registered LAST: error middleware only catches what precedes it.
const handleUnexpected: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[http] خطأ غير متوقع في المعالجة', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
};

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '32kb' })); // plan 9, point 2 — reject oversized bodies early
  app.use(handleBadJson);
  app.use(requireProjectApiKey);
  app.use(router);
  app.use(handleUnexpected);
  return app;
}
