import type { Request, Response, NextFunction } from 'express';
import { getProjectByApiKey, type ProjectConfig } from '../config.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      project?: ProjectConfig;
    }
  }
}

// Plan 11: the service is never exposed without authentication — every route
// (including /health and /status) requires a valid per-project key.
export function requireProjectApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('Authorization');
  const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const project = key ? getProjectByApiKey(key) : undefined;

  if (!project) {
    res.status(401).json({ error: 'invalid_or_missing_api_key' });
    return;
  }
  req.project = project;
  next();
}
