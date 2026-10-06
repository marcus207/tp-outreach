/**
 * SEC-02 Session management (ASVS V3.2 / V3.3 / V3.4).
 * Cookie flags, session fixation, logout invalidation.
 * (Secure flag under NODE_ENV=production is asserted in 10-production-mode.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import type { Express } from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signature = require('cookie-signature') as { sign(v: string, s: string): string };
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, loginCookie, freshIp, viaNginx, sidFrom, TEST_EMAIL, TEST_PASSWORD } from './helpers';

let app: Express;

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
});
afterAll(async () => { await closeAll(); });

function rawSid(cookiePair: string): string {
  const v = decodeURIComponent(cookiePair.split('=')[1]);
  return v.slice(2, v.lastIndexOf('.'));
}

/** Plant a pre-authentication session in the store (attacker-known sid), return its cookie. */
async function plantSession(): Promise<{ sid: string; cookie: string }> {
  const sid = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + 3600_000);
  await query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)`,
    [sid, JSON.stringify({ cookie: { originalMaxAge: 3600_000, expires: expires.toISOString(), httpOnly: true, path: '/', sameSite: 'lax', secure: false } }), expires]
  );
  const signed = 's:' + signature.sign(sid, process.env.SESSION_SECRET as string);
  return { sid, cookie: `connect.sid=${encodeURIComponent(signed)}` };
}

describe('SEC-02 session cookie flags', () => {
  it('login sets connect.sid with HttpOnly, SameSite=Lax, Path=/ and a bounded lifetime', async () => {
    const res = await request(app).post('/api/auth/login').set(viaNginx(freshIp()))
      .send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
    expect(res.status).toBe(200);
    const c = (res.headers['set-cookie'] as unknown as string[]).find(s => s.startsWith('connect.sid='))!;
    expect(c).toBeTruthy();
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=Lax/i);
    expect(c).toMatch(/;\s*Path=\//i);
    const exp = c.match(/Expires=([^;]+)/i);
    expect(exp).toBeTruthy();
    const days = (new Date(exp![1]).getTime() - Date.now()) / 86400_000;
    expect(days).toBeLessThanOrEqual(7.01);
    // Session id must carry >= 128 bits of entropy
    expect(rawSid(sidFrom(res)!).length).toBeGreaterThanOrEqual(22);
  });

  it('no session cookie is issued to anonymous visitors (saveUninitialized=false)', async () => {
    for (const p of ['/api/auth/me', '/api/health', '/api/contacts']) {
      const res = await request(app).get(p).set(viaNginx(freshIp()));
      expect(sidFrom(res), p).toBeNull();
    }
    const bad = await request(app).post('/api/auth/login').set(viaNginx(freshIp())).send({ email: 'x@y.z', password: 'nope' });
    expect(sidFrom(bad)).toBeNull();
  });
});

describe('SEC-02 session fixation', () => {
  it('a pre-login session id planted by an attacker is NOT the one that becomes authenticated', async () => {
    const planted = await plantSession();
    // sanity: the store honours the planted cookie (anonymous)
    const me0 = await request(app).get('/api/auth/me').set('Cookie', planted.cookie).set(viaNginx(freshIp()));
    expect(me0.body.authenticated).toBe(false);

    const res = await request(app).post('/api/auth/login').set('Cookie', planted.cookie).set(viaNginx(freshIp()))
      .send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
    expect(res.status).toBe(200);

    // The attacker's cookie must not now be authenticated
    const meAttacker = await request(app).get('/api/auth/me').set('Cookie', planted.cookie).set(viaNginx(freshIp()));
    expect(meAttacker.body.authenticated, 'planted sid became authenticated: session fixation').toBe(false);
    const newSid = sidFrom(res);
    expect(newSid, 'login must issue a fresh session id').not.toBeNull();
    expect(rawSid(newSid!)).not.toBe(planted.sid);
  });

  it('logging in again rotates the session id', async () => {
    const first = await loginCookie(app);
    const res = await request(app).post('/api/auth/login').set('Cookie', first).set(viaNginx(freshIp()))
      .send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });
    expect(res.status).toBe(200);
    const second = sidFrom(res);
    expect(second, 'no new Set-Cookie on re-login (session id not regenerated)').not.toBeNull();
    expect(rawSid(second!)).not.toBe(rawSid(first));
  });
});

describe('SEC-02 logout', () => {
  it('logout destroys the server-side session: old cookie no longer authenticates', async () => {
    const cookie = await loginCookie(app);
    const ok = await request(app).get('/api/contacts').set('Cookie', cookie).set(viaNginx(freshIp()));
    expect(ok.status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).set(viaNginx(freshIp()));
    expect(out.status).toBe(200);

    const after = await request(app).get('/api/contacts').set('Cookie', cookie).set(viaNginx(freshIp()));
    expect(after.status).toBe(401);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie).set(viaNginx(freshIp()));
    expect(me.body.authenticated).toBe(false);

    const row = await query(`SELECT 1 FROM session WHERE sid = $1`, [rawSid(cookie)]);
    expect(row.rows).toHaveLength(0);
  });

  it('logout clears the cookie in the browser (Set-Cookie expiring connect.sid)', async () => {
    const cookie = await loginCookie(app);
    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).set(viaNginx(freshIp()));
    const sc = ((out.headers['set-cookie'] as unknown as string[]) || []).find(s => s.startsWith('connect.sid='));
    expect(sc, 'logout should send connect.sid=; Expires=Thu, 01 Jan 1970 (res.clearCookie)').toBeTruthy();
    expect(sc!).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('sessions are bound server-side: tampering with the signature is rejected', async () => {
    const cookie = await loginCookie(app);
    const tampered = cookie.slice(0, -3) + (cookie.endsWith('A') ? 'B' : 'A') + cookie.slice(-2);
    const res = await request(app).get('/api/contacts').set('Cookie', tampered).set(viaNginx(freshIp()));
    expect(res.status).toBe(401);
  });
});
