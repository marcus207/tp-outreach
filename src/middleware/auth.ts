import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'] || req.query['api_key'];
  const expectedKey = process.env.DRIPIFY_INGEST_KEY;

  if (!expectedKey) {
    res.status(500).json({ error: 'DRIPIFY_INGEST_KEY not configured' });
    return;
  }

  if (key !== expectedKey) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
}
