/**
 * SEC-11 Behaviour under NODE_ENV=production (as prod runs it).
 *
 * The app reads NODE_ENV at import time (cookie.secure, CORS, Express env), so
 * this file imports a SECOND copy of src/index.ts with NODE_ENV=production set
 * only for the duration of the import, then restores NODE_ENV=test. The DB/Redis
 * env is untouched (still the sec lane DB / Redis DB 15), and Server.listen is
 * stubbed during the import so nothing binds a port.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import http from 'http';
import type { Express } from 'express';
import { resetAll, closeAll } from '../factories';
import { freshIp, viaNginx, TEST_EMAIL, TEST_PASSWORD, leaks } from './helpers';

let app: Express;
const closers: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  await resetAll();
  if (!/\/tpca_outreach_test_[a-z0-9]+$|\/tpca_outreach_test$/.test(process.env.DATABASE_URL || '')) throw new Error('not a test DB');
  vi.resetModules();
  const origListen = http.Server.prototype.listen;
  (http.Server.prototype as unknown as { listen: unknown }).listen = function (this: http.Server) { return this; };
  process.env.NODE_ENV = 'production';
  try {
    const mod = await import('../../../src/index');
    app = mod.app as unknown as Express;
    const conn = await import('../../../src/db/connection');
    const se = await import('../../../src/services/sequence-engine');
    const sq = await import('../../../src/services/send-queue');
    closers.push(() => se.sequenceEngine.close(), () => sq.sendQueue.close(), () => conn.pool.end());
  } finally {
    process.env.NODE_ENV = 'test';
    http.Server.prototype.listen = origListen;
  }
  expect(app.get('env')).toBe('production');
});

afterAll(async () => {
  for (const c of closers) { try { await c(); } catch { /* ignore */ } }
  await closeAll();
});

const httpsVia = (ipAddr = freshIp()) => ({ ...viaNginx(ipAddr), 'X-Forwarded-Proto': 'https' });

describe('SEC-11 production cookie', () => {
  it('session cookie is Secure + HttpOnly + SameSite=Lax over HTTPS (via nginx)', async () => {
    const r = await request(app).post('/api/auth/login').set(httpsVia()).send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
    expect(r.status).toBe(200);
    const c = ((r.headers['set-cookie'] as unknown as string[]) || []).find(s => s.startsWith('connect.sid='));
    expect(c).toBeTruthy();
    expect(c!).toMatch(/;\s*Secure/i);
    expect(c!).toMatch(/;\s*HttpOnly/i);
    expect(c!).toMatch(/;\s*SameSite=Lax/i);
  });

  it('no session cookie is ever sent over plain HTTP', async () => {
    const r = await request(app).post('/api/auth/login').set(viaNginx(freshIp())).send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
    expect(((r.headers['set-cookie'] as unknown as string[]) || []).some(s => s.startsWith('connect.sid='))).toBe(false);
  });

  it('a session cookie obtained over HTTPS works (control)', async () => {
    const r = await request(app).post('/api/auth/login').set(httpsVia()).send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
    const sid = ((r.headers['set-cookie'] as unknown as string[]) || []).find(s => s.startsWith('connect.sid='))!.split(';')[0];
    const me = await request(app).get('/api/auth/me').set(httpsVia()).set('Cookie', sid);
    expect(me.body.authenticated).toBe(true);
  });
});

describe('SEC-11 production error handling', () => {
  it('malformed JSON => 400 with no stack trace or file paths', async () => {
    for (const u of ['/api/auth/login', '/api/dripify/ingest', '/api/auth/forgot-password']) {
      const r = await request(app).post(u).set(httpsVia()).set('Content-Type', 'application/json').send('{"a":');
      expect(r.status).toBe(400);
      expect(leaks(r.text), `${u}: ${r.text.slice(0, 200)}`).toBeNull();
      expect(r.text).not.toMatch(/SyntaxError|body-parser|at JSON\.parse/);
    }
  });

  it('malformed URI encoding => 400 with no stack trace', async () => {
    const r = await request(app).get('/t/%E0%A4%A/unsubscribe').set(httpsVia());
    expect(r.status).toBeLessThan(500);
    expect(leaks(r.text)).toBeNull();
  });

  it('oversized body => 413 with no stack trace', async () => {
    const r = await request(app).post('/api/auth/login').set(httpsVia()).set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(11 * 1024 * 1024) }));
    expect(r.status).toBe(413);
    expect(leaks(r.text)).toBeNull();
    expect(r.text).not.toMatch(/PayloadTooLargeError|raw-body/);
  });
});

describe('SEC-11 production CORS', () => {
  it('no Access-Control-Allow-Origin for foreign origins (incl. preflight) and never "*" with credentials', async () => {
    for (const o of ['https://evil.example', 'null', 'http://localhost:5173', 'https://tp.finance.evil.example']) {
      const g = await request(app).get('/api/auth/me').set(httpsVia()).set('Origin', o);
      expect(g.headers['access-control-allow-origin'], o).toBeUndefined();
      const p = await request(app).options('/api/contacts').set(httpsVia()).set('Origin', o)
        .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
      expect(p.headers['access-control-allow-origin'], o).toBeUndefined();
    }
  });
});
