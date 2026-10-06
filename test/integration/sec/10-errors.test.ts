/**
 * SEC-10 Error handling and request limits (ASVS V7.4, V13.1.5 / V12.1.1).
 * Stack-trace suppression under NODE_ENV=production is in 11-production-mode.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { getApp, freshIp, viaNginx, loginCookie, leaks, bodyText } from './helpers';

let app: Express;
let cookie = '';
beforeAll(async () => { await resetAll(); installFakeGmail(); app = await getApp(); cookie = await loginCookie(app); });
afterAll(async () => { await closeAll(); });

const ip = () => viaNginx(freshIp());

describe('SEC-10 unknown routes', () => {
  it('unknown /api paths => fast 404 JSON for every verb (authenticated or not)', async () => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      for (const u of ['/api/nope', '/api/contacts-x', '/api/a/b/c/d', '/api/../api/nope']) {
        for (const c of ['', cookie]) {
          const t0 = Date.now();
          let r = request(app)[m](u).set(ip());
          if (c) r = r.set('Cookie', c);
          const res = await r.timeout({ response: 2000 });
          expect(Date.now() - t0).toBeLessThan(500);
          if (u.startsWith('/api/contacts')) continue; // under an auth-gated mount: 401 unauth
          expect(res.status, `${m} ${u}`).toBe(404);
          expect(res.headers['content-type']).toMatch(/application\/json/);
          expect(res.body).toEqual({ error: 'Not found' });
        }
      }
    }
  });

  it('unknown /t/* => 404 plain, no reflection', async () => {
    const r = await request(app).get('/t/abc/whatever').set(ip());
    expect(r.status).toBe(404);
    expect(r.text).toBe('Not found');
  });

  it('X-Powered-By is not sent', async () => {
    const r = await request(app).get('/api/health').set(ip());
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('SEC-10 body size limits on unauthenticated routes', () => {
  const big = 'a'.repeat(11 * 1024 * 1024);
  const targets = [
    '/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/dripify/ingest',
    '/api/digest/00000000-0000-4000-8000-000000000000/approve/confirm',
    '/api/draft-reviews/00000000-0000-4000-8000-000000000000/approve',
    '/t/abc/unsubscribe',
  ];

  it('11MB JSON => 413 everywhere', async () => {
    for (const u of targets) {
      const r = await request(app).post(u).set(ip()).set('Content-Type', 'application/json').send(JSON.stringify({ x: big }));
      expect(r.status, u).toBe(413);
      // body content under NODE_ENV=production is asserted in 11-production-mode
    }
  });

  it('11MB urlencoded => 413 everywhere', async () => {
    for (const u of targets) {
      const r = await request(app).post(u).set(ip()).type('form').send(`x=${big}`);
      expect(r.status, u).toBe(413);
    }
  });

  it('hardening: pre-auth endpoints reject JSON bodies over 100kb (10mb global limit is an amplification vector)', async () => {
    const medium = JSON.stringify({ email: 'a@b.c', password: 'x', pad: 'a'.repeat(2 * 1024 * 1024) });
    const fails: string[] = [];
    for (const u of ['/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password']) {
      const r = await request(app).post(u).set(ip()).set('Content-Type', 'application/json').send(medium);
      if (r.status !== 413) fails.push(`${u} accepted a 2MB body (${r.status})`);
    }
    expect(fails, fails.join('\n')).toEqual([]);
  });

  it('deeply nested urlencoded input does not crash the parser', async () => {
    const r = await request(app).post('/api/auth/login').set(ip()).type('form').send('a' + '[a]'.repeat(5000) + '=1');
    expect(r.status).toBeLessThan(500);
  });
});

describe('SEC-10 error bodies never leak internals', () => {
  it('malformed JSON => 4xx without stack/SQL (unauthenticated)', async () => {
    for (const u of ['/api/auth/login', '/api/dripify/ingest', '/api/auth/reset-password']) {
      const r = await request(app).post(u).set(ip()).set('Content-Type', 'application/json').send('{"email": ');
      expect(r.status, u).toBe(400);
      // In NODE_ENV=test Express' default handler prints the stack; production behaviour is in 11-production-mode
    }
  });

  it('authenticated 500s return generic messages (no raw DB error text)', async () => {
    // A DB error is forced by a non-UUID id on routes that pass it straight to a uuid column.
    const probes = ['/api/digest/not-a-uuid', '/api/campaigns/not-a-uuid', '/api/templates/not-a-uuid',
      '/api/contacts/not-a-uuid', '/api/articles/not-a-uuid', '/api/press-releases/not-a-uuid',
      '/api/campaign-planner/schedule/not-a-uuid', '/api/draft-reviews/not-a-uuid'];
    const bad: string[] = [];
    for (const u of probes) {
      const r = await request(app).get(u).set('Cookie', cookie).set(ip());
      const l = leaks(bodyText(r));
      if (l) bad.push(`${u} [${r.status}] "${l}": ${bodyText(r).slice(0, 120)}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('public health endpoint does not echo DB error details', async () => {
    // Static guarantee: the 503 branch returns err.message today.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../../src/index.ts'), 'utf8') as string;
    const health = src.slice(src.indexOf("app.get('/api/health'"), src.indexOf('// Authenticated deep health check'));
    expect(/error:\s*\(err as Error\)\.message/.test(health), "/api/health 503 echoes err.message to anonymous callers").toBe(false);
  });
});
