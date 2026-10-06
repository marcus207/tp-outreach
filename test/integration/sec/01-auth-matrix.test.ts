/**
 * SEC-01 Auth matrix (ASVS V4.1.1 / V4.1.5: deny by default).
 *
 * Enumerates EVERY route registered on the app (app._router.stack + nested
 * routers) and asserts each one rejects an unauthenticated request with 401,
 * except an explicit allowlist. Adding a new public route without updating the
 * allowlist below makes this suite fail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { getApp, listRoutes, fillParams, freshIp, viaNginx, loginCookie, RouteInfo } from './helpers';

/**
 * Explicit public allowlist: "METHOD path" -> why it is public.
 * Derived from src/index.ts + src/routes/*.ts on 5 Oct 2026.
 */
export const PUBLIC_ALLOWLIST: Record<string, string> = {
  'POST /api/auth/login': 'login',
  'POST /api/auth/logout': 'logout (idempotent)',
  'GET /api/auth/me': 'session probe (returns authenticated:false)',
  'POST /api/auth/forgot-password': 'rate limited, constant response',
  'POST /api/auth/reset-password': 'token-gated, rate limited',
  'GET /api/health': 'uptime probe (no data)',
  'GET /t/:trackingId/open': 'tracking pixel',
  'GET /t/:trackingId/click': 'click redirect (allowlisted targets)',
  'GET /t/:trackingId/unsubscribe': 'unsubscribe confirm page',
  'POST /t/:trackingId/unsubscribe': 'RFC 8058 one-click unsubscribe',
  'POST /api/dripify/ingest': 'ingest key (X-Ingest-Key)',
  'GET /api/digest/:id/approve': 'digest approval confirm page (UUID token)',
  'POST /api/digest/:id/approve/confirm': 'digest approval action (UUID token)',
  'GET /api/draft-reviews/:id/approve': 'draft approval confirm page (UUID token)',
  'POST /api/draft-reviews/:id/approve': 'draft approval action (UUID token)',
  'GET /api/draft-reviews/:id/skip': 'draft skip confirm page (UUID token)',
  'POST /api/draft-reviews/:id/skip': 'draft skip action (UUID token)',
  'POST /api/webhooks/apollo': 'Apollo webhook (disabled by default, HMAC when enabled)',
  'GET *': 'SPA shell (index.html) / 404 for /t/*',
};

let app: Express;
let routes: RouteInfo[];

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
  routes = listRoutes(app);
});

afterAll(async () => {
  await closeAll();
});

const key = (r: RouteInfo) => `${r.method} ${r.path}`;

describe('SEC-01 auth matrix', () => {
  it('route walker finds the expected surface (sanity)', () => {
    expect(routes.length).toBeGreaterThan(100);
    const keys = new Set(routes.map(key));
    for (const k of ['POST /api/auth/login', 'GET /api/contacts/', 'GET /api/draft-reviews/:id/approve', 'POST /api/webhooks/apollo']) {
      expect(keys, k).toContain(k);
    }
    // Print the derived surface for the report
    const pub = routes.filter(r => PUBLIC_ALLOWLIST[key(r)]).map(key);
    console.log(`[sec-01] ${routes.length} routes; ${pub.length} public:\n  ${pub.join('\n  ')}`);
  });

  it('every allowlisted route still exists (allowlist does not rot)', () => {
    const keys = new Set(routes.map(key));
    const stale = Object.keys(PUBLIC_ALLOWLIST).filter(k => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it('statically: every non-allowlisted route has requireAuth in its middleware chain', () => {
    const unguarded = routes.filter(r => !PUBLIC_ALLOWLIST[key(r)] && !r.staticAuth).map(key);
    expect(unguarded, `routes with no requireAuth in chain:\n${unguarded.join('\n')}`).toEqual([]);
  });

  it('dynamically: every non-allowlisted route answers 401 without a session', async () => {
    const failures: string[] = [];
    for (const r of routes) {
      if (PUBLIC_ALLOWLIST[key(r)]) continue;
      const url = fillParams(r.path);
      const m = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const res = await request(app)[m](url).set(viaNginx(freshIp())).send({}).timeout({ response: 10000 });
      if (res.status !== 401) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures, `unauthenticated access not rejected:\n${failures.join('\n')}`).toEqual([]);
  });

  it('a forged / unsigned session cookie is not accepted', async () => {
    for (const cookie of ['connect.sid=s%3Aforged.abc', 'connect.sid=forged', 'connect.sid=s%3A' + 'a'.repeat(32) + '.' + 'b'.repeat(43)]) {
      const res = await request(app).get('/api/contacts').set('Cookie', cookie).set(viaNginx(freshIp()));
      expect(res.status).toBe(401);
    }
  });

  it('a valid session reaches protected routes (control)', async () => {
    const cookie = await loginCookie(app);
    const res = await request(app).get('/api/contacts').set('Cookie', cookie).set(viaNginx(freshIp()));
    expect(res.status).toBe(200);
  });

  it('public info endpoints disclose nothing sensitive', async () => {
    const h = await request(app).get('/api/health').set(viaNginx(freshIp()));
    expect(Object.keys(h.body).sort()).toEqual(['ok', 'tenant', 'ts']);
    const me = await request(app).get('/api/auth/me').set(viaNginx(freshIp()));
    expect(me.body).toEqual({ authenticated: false });
  });
});
