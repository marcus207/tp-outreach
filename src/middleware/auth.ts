import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { query, TENANT } from '../db/connection';
import { safeEqual } from './security';

const EPOCH_KEY = `session_epoch:${TENANT}`;

declare module 'express-session' {
  interface SessionData {
    /** Session version at login; must equal currentSessionEpoch() to stay valid. */
    epoch?: string;
  }
}

// ---- Session versioning ----
// A session is valid only while its stored epoch equals the current epoch, which is
// derived from (a) a random value in settings['session_epoch:<tenant>'], bumped on every
// password reset, and (b) a fingerprint of the configured credential, so changing
// DASHBOARD_PASSWORD(_HASH) in .env also logs every existing session out.

const EPOCH_CACHE_MS = 30_000;
let storedEpoch: { value: string; at: number } | null = null;

async function loadStoredEpoch(): Promise<string> {
  if (storedEpoch && Date.now() - storedEpoch.at < EPOCH_CACHE_MS) return storedEpoch.value;
  const r = await query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [EPOCH_KEY]);
  const v = r.rows[0]?.value;
  const value = typeof v === 'string' && v ? v : '0';
  storedEpoch = { value, at: Date.now() };
  return value;
}

function credentialFingerprint(): string {
  const cred = process.env.DASHBOARD_PASSWORD_HASH || process.env.DASHBOARD_PASSWORD || '';
  return crypto.createHash('sha256').update(`${process.env.DASHBOARD_EMAIL || ''}\0${cred}`).digest('hex').slice(0, 16);
}

export async function currentSessionEpoch(): Promise<string> {
  return `${await loadStoredEpoch()}:${credentialFingerprint()}`;
}

/** Invalidate every existing session (called after a password reset). */
export async function bumpSessionEpoch(): Promise<void> {
  const value = crypto.randomBytes(16).toString('hex');
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [EPOCH_KEY, JSON.stringify(value)]
  );
  storedEpoch = { value, at: Date.now() };
}

export async function isSessionValid(req: Request): Promise<boolean> {
  if (!req.session?.authenticated) return false;
  return safeEqual(req.session.epoch ?? '', await currentSessionEpoch());
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session?.authenticated) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  let valid = false;
  try {
    valid = await isSessionValid(req);
  } catch (err) {
    console.error('[Auth] Session epoch check failed:', (err as Error).message);
    res.status(503).json({ error: 'Service unavailable' });
    return;
  }
  if (!valid) {
    req.session.destroy(() => undefined);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.get('x-api-key');
  const expectedKey = process.env.DRIPIFY_INGEST_KEY;

  if (!expectedKey) {
    res.status(500).json({ error: 'DRIPIFY_INGEST_KEY not configured' });
    return;
  }

  if (!safeEqual(key, expectedKey)) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
}
