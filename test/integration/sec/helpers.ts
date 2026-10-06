/**
 * Helpers for the `sec` lane: security regression tests (OWASP ASVS L2 style).
 *
 * Everything runs in-process against the exported Express `app` via supertest,
 * against the lane's isolated test DB (tpca_outreach_test_sec). Nothing here
 * talks to production.
 *
 * DASHBOARD_EMAIL / DASHBOARD_PASSWORD come from vitest.integration.config.ts
 * (test-only values). index.ts reads them per request from process.env.
 */
import request from 'supertest';
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';

export const ROOT = path.resolve(__dirname, '../../..');

// Defensive: never let these tests run with the prod credentials or DB.
if (!process.env.DASHBOARD_EMAIL) process.env.DASHBOARD_EMAIL = 'test@tp.finance';
if (!process.env.DASHBOARD_PASSWORD) process.env.DASHBOARD_PASSWORD = 'test-password';
if (!/\/tpca_outreach_test(_[a-z0-9]+)?$/.test(process.env.DATABASE_URL || '')) {
  throw new Error('[sec] refusing to run: DATABASE_URL is not a test database');
}

export const TEST_EMAIL = () => process.env.DASHBOARD_EMAIL as string;
export const TEST_PASSWORD = () => process.env.DASHBOARD_PASSWORD as string;

export async function getApp(): Promise<Express> {
  const mod = await import('../../../src/index');
  return mod.app as unknown as Express;
}

// ── Client IPs ─────────────────────────────────────────────────────────
// index.ts sets `trust proxy` = 1, so req.ip is the LAST X-Forwarded-For hop
// (what nginx appends via $proxy_add_x_forwarded_for). Every test uses its own
// IP so the module-level in-memory rate limiters do not bleed between tests.
let ipSeq = 0;
export function freshIp(): string {
  ipSeq++;
  return `198.18.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

/** X-Forwarded-For as nginx would forward it: client-supplied chain + real peer last. */
export function viaNginx(realIp: string, spoofed?: string): Record<string, string> {
  return { 'X-Forwarded-For': spoofed ? `${spoofed}, ${realIp}` : realIp };
}

// ── Auth ───────────────────────────────────────────────────────────────

export function sidFrom(res: request.Response): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return null;
  const c = raw.find(s => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}

/** Log in with the test credentials; returns the `connect.sid=...` cookie pair. */
export async function loginCookie(app: Express, ip = freshIp(), existingCookie?: string): Promise<string> {
  let r = request(app).post('/api/auth/login').set(viaNginx(ip));
  if (existingCookie) r = r.set('Cookie', existingCookie);
  const res = await r.send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const sid = sidFrom(res);
  if (!sid) throw new Error('login returned no session cookie');
  return sid;
}

// ── Route enumeration ──────────────────────────────────────────────────

export interface RouteInfo {
  method: string;     // GET, POST, ...
  path: string;       // full path incl. mount prefix, e.g. /api/contacts/:id
  staticAuth: boolean; // requireAuth found in the middleware chain for this route
}

interface Layer {
  name: string;
  handle: ((...a: unknown[]) => unknown) & { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
}

function mountPath(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\(\?=\\\/\|\$\)$/, '');
  src = src.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
  if (/[()[\]*+?|$]/.test(src)) throw new Error(`[sec] cannot derive mount path from regexp ${layer.regexp}`);
  return src;
}

function isAuthLayer(l: Layer): boolean {
  return l.name === 'requireAuth';
}

/**
 * Walk app._router.stack (Express 4) including nested routers. A route is
 * statically "auth-guarded" if a requireAuth layer precedes it at any level of
 * its mount chain whose path covers it, or sits in its own route stack.
 */
export function listRoutes(app: Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  const root = (app as unknown as { _router: { stack: Layer[] } })._router;
  if (!root) throw new Error('[sec] app._router missing (Express 5? update walker)');

  const norm = (p: string) => p.replace(/\/+/g, '/');
  // A requireAuth mounted at an absolute path guards every later route at or
  // below that path, including routes inside routers mounted at a shorter
  // prefix (e.g. app.use('/api/webhooks/apollo/test', requireAuth) before
  // app.use('/api/webhooks', router)).
  const coversAbs = (mounts: string[], full: string) =>
    mounts.some(m => m === '' || full === m || full.startsWith(m + '/'));
  const walk = (stack: Layer[], prefix: string, inheritedAuth: boolean, outerMounts: string[]) => {
    // requireAuth layers seen so far at this level, keyed by their mount path
    const authMounts: string[] = [];
    const absMounts: string[] = [...outerMounts];
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        const routeAuth = layer.route.stack.some(isAuthLayer);
        for (const p of paths) {
          const full = norm(prefix + p);
          const covered = authMounts.some(m => m === '' || p === m || p.startsWith(m + '/')) || coversAbs(absMounts, full);
          for (const m of Object.keys(layer.route.methods)) {
            if (m === '_all') continue;
            out.push({ method: m.toUpperCase(), path: full, staticAuth: inheritedAuth || routeAuth || covered });
          }
        }
        continue;
      }
      const mp = mountPath(layer);
      if (isAuthLayer(layer)) { authMounts.push(mp); absMounts.push(norm(prefix + mp)); continue; }
      if (layer.name === 'router' && layer.handle.stack) {
        const covered = authMounts.some(m => m === '' || mp === m || mp.startsWith(m + '/'));
        walk(layer.handle.stack, prefix + mp, inheritedAuth || covered, absMounts);
      }
    }
  };
  walk(root.stack, '', false, []);
  return out;
}

export function fillParams(p: string, value = '00000000-0000-4000-8000-000000000000'): string {
  return p.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, value).replace(/\*/g, 'x');
}

// ── Payloads + detectors ───────────────────────────────────────────────

export const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg/onload=alert(1)>",
  'javascript:alert(1)',
  '%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '</title><script>alert(1)</script>',
  '<script>alert(1)</script>',
  '" autofocus onfocus="alert(1)',
];

export const SQLI_PAYLOADS = [
  "' OR 1=1--",
  "' OR '1'='1",
  '1;DROP TABLE contacts',
  "1); DROP TABLE contacts;--",
  "' UNION SELECT NULL,version()--",
  "1' AND pg_sleep(2)--",
  '-1',
  '0',
  '99999999999999999999',
  'abc',
  "email; DROP TABLE contacts",
  'created_at DESC; SELECT 1',
];

/** Strings that indicate a DB/stack leak in a response body. */
const LEAK_RE = new RegExp([
  'syntax error', 'invalid input syntax', 'invalid input value', 'relation "', 'column "', 'does not exist',
  'pg_', 'SQLSTATE', 'violates', 'duplicate key', 'out of range for type', 'LIMIT must not be negative',
  'OFFSET must not be negative', 'node_modules', '\\.ts:\\d+', '\\.js:\\d+:\\d+', '\\bat [A-Za-z_.<>]+ \\(',
  'Error: ', 'QueryFailedError', 'ECONNREFUSED',
].join('|'), 'i');

export function leaks(body: unknown): string | null {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const m = s.match(LEAK_RE);
  return m ? m[0] : null;
}

export function bodyText(res: request.Response): string {
  if (typeof res.text === 'string' && res.text.length) return res.text;
  return JSON.stringify(res.body ?? '');
}

/** All tracked files (git ls-files), as absolute paths. */
export function trackedFiles(): string[] {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
  return out.split('\0').filter(Boolean).map(f => path.join(ROOT, f)).filter(f => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Poll until fn() is truthy or timeout; returns last value. */
export async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 1500, stepMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!v && Date.now() < end) { await sleep(stepMs); v = await fn(); }
  return v;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
