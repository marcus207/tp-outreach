/**
 * Shared security helpers: constant-time compare, input validation, CSRF
 * (Origin / Sec-Fetch-Site) check, generic error bodies, CSP for the public
 * HTML pages served under /api.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// ---- Comparison ----

/** Constant-time string comparison (hash both sides so buffers are equal length). */
export function safeEqual(provided: unknown, expected: unknown): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- Validation ----

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** For router.param(): rejects non-UUID path params with a 400 before any DB call. */
export function uuidParam(req: Request, res: Response, next: NextFunction, value: string): void {
  if (isUuid(value)) { next(); return; }
  res.status(400).json({ error: 'Invalid id' });
}

/** Parse an integer query/body value; malformed => default, out of range => clamped. */
export function intParam(raw: unknown, def: number, min: number, max: number): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== 'string' && typeof s !== 'number') return def;
  const str = String(s).trim();
  if (!/^-?\d{1,15}$/.test(str)) return def;
  const n = parseInt(str, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// Common pagination/window query params: bounds applied globally on /api so a
// malformed value can never reach SQL (LIMIT -1, int overflow, NaN intervals).
const NUMERIC_QUERY_BOUNDS: Record<string, [number, number]> = {
  page: [1, 100000],
  limit: [1, 1000],
  per_page: [1, 1000],
  offset: [0, 10000000],
  days: [1, 3650],
  weeks: [1, 520],
  hours: [1, 87600],
};

export function sanitizeNumericQuery(req: Request, _res: Response, next: NextFunction): void {
  const q = req.query as Record<string, unknown>;
  for (const [key, [min, max]] of Object.entries(NUMERIC_QUERY_BOUNDS)) {
    if (!(key in q)) continue;
    const raw = Array.isArray(q[key]) ? (q[key] as unknown[])[0] : q[key];
    const str = typeof raw === 'string' ? raw.trim() : '';
    if (!/^-?\d{1,15}$/.test(str)) { delete q[key]; continue; } // route default applies
    q[key] = String(Math.min(Math.max(parseInt(str, 10), min), max));
  }
  next();
}

// ---- Error bodies ----

const DB_LEAK_RE = /syntax error|invalid input (syntax|value)|relation "|column "|does not exist|violates|duplicate key|out of range for type|must not be negative|SQLSTATE|ECONNREFUSED|node_modules|\bat [A-Za-z_.<>]+ \(/i;

/** True for node-postgres DatabaseError (SQLSTATE code + severity) or driver/connection errors. */
export function isDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; severity?: unknown; constructor?: { name?: string }; message?: unknown };
  if (e.constructor?.name === 'DatabaseError') return true;
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string') return true;
  if (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) return true; // ECONNREFUSED etc.
  return typeof e.message === 'string' && DB_LEAK_RE.test(e.message);
}

/** Message safe to return to a client: business errors pass through, DB/internal errors do not. */
export function publicError(err: unknown, fallback: string): string {
  if (isDbError(err)) return fallback;
  const msg = err instanceof Error ? err.message : '';
  return msg && msg.length <= 300 ? msg : fallback;
}

/**
 * Defence in depth for routes that still echo err.message: any JSON response
 * whose `error` field looks like DB/stack text is replaced with a generic one.
 */
export function scrubErrorResponses(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      for (const k of ['error', 'message', 'details']) {
        if (typeof b[k] === 'string' && DB_LEAK_RE.test(b[k] as string)) {
          console.error(`[Security] Suppressed internal error text in ${res.statusCode} response: ${String(b[k]).slice(0, 300)}`);
          b[k] = res.statusCode >= 500 ? 'Internal server error' : 'Invalid request';
        }
      }
    }
    return json(body);
  }) as Response['json'];
  next();
}

// ---- CSP for public HTML pages under /api ----

export const PUBLIC_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function sendPublicHtml(res: Response, status: number, html: string): void {
  res.setHeader('Content-Security-Policy', PUBLIC_PAGE_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).type('html').send(html);
}

// ---- CSRF ----

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedHosts(): Set<string> {
  const brand = (process.env.BRAND_DOMAIN || 'tp.finance').toLowerCase();
  const hosts = new Set<string>(['tp.finance', 'www.tp.finance', brand, `www.${brand}`]);
  for (const h of (process.env.CSRF_ALLOWED_HOSTS || '').split(',')) if (h.trim()) hosts.add(h.trim().toLowerCase());
  if (process.env.NODE_ENV !== 'production') { hosts.add('localhost'); hosts.add('127.0.0.1'); }
  return hosts;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface CsrfOptions {
  /** Paths (relative to the mount, i.e. req.path) exempt from the Origin check. */
  exempt: RegExp[];
  /** Paths that may receive form-encoded bodies (HTML forms on our own pages). */
  formAllowed: RegExp[];
}

/**
 * Origin / Sec-Fetch-Site check on state-changing requests. Browsers always send
 * Origin on cross-origin (and modern ones on same-origin) non-GET requests, so:
 *  - Origin present  => its host must be ours (tp.finance / www.tp.finance [/ localhost in dev])
 *  - else Referer    => same rule
 *  - else Sec-Fetch-Site present => must be same-origin (or none: user-initiated)
 *  - no browser headers at all => non-browser client (no ambient cookies to abuse), allowed
 * Also rejects simple-request body types (form/text) on JSON routes.
 */
export function csrfProtection(opts: CsrfOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!STATE_CHANGING.has(req.method)) { next(); return; }
    const p = req.path;
    if (opts.exempt.some(re => re.test(p))) { next(); return; }

    const hosts = allowedHosts();
    const origin = req.get('origin');
    const referer = req.get('referer');
    const fetchSite = (req.get('sec-fetch-site') || '').toLowerCase();
    let ok: boolean;
    if (origin !== undefined) {
      const h = origin === 'null' ? null : hostOf(origin);
      ok = !!h && hosts.has(h);
    } else if (referer) {
      const h = hostOf(referer);
      ok = !!h && hosts.has(h);
    } else if (fetchSite) {
      ok = fetchSite === 'same-origin' || fetchSite === 'none';
    } else {
      ok = true;
    }
    if (!ok) {
      console.warn(`[CSRF] Blocked ${req.method} ${req.originalUrl.slice(0, 200)} origin=${String(origin).slice(0, 100)} site=${fetchSite || '-'}`);
      res.status(403).json({ error: 'Cross-origin request blocked' });
      return;
    }

    // JSON API: refuse form/text bodies (the only content types a cross-site
    // HTML form can produce without a CORS preflight) unless explicitly allowed.
    if (req.headers['content-type'] && !opts.formAllowed.some(re => re.test(p))) {
      if (req.is('application/x-www-form-urlencoded') || req.is('text/plain')) {
        res.status(415).json({ error: 'Unsupported content type: send application/json' });
        return;
      }
    }
    next();
  };
}
