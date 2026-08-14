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

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '32kb' })); // plan 9, point 2 — reject oversized bodies early
  app.use(handleBadJson);
  app.use(requireProjectApiKey);
  app.use(router);
  return app;
}
