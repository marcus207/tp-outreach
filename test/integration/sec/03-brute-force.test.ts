/**
 * SEC-03 Anti-automation and enumeration (ASVS V2.2.1, V2.5.x, V11.1.4).
 * Login lockout 5/IP/15min, X-Forwarded-For spoofing, forgot-password 3/h,
 * reset-password attempt limit, constant responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { getApp, freshIp, viaNginx, TEST_EMAIL, TEST_PASSWORD, median, ROOT } from './helpers';

let app: Express;

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
});
afterAll(async () => { await closeAll(); });

const bad = (ip: string, spoof?: string, email = TEST_EMAIL()) =>
  request(app).post('/api/auth/login').set(viaNginx(ip, spoof)).send({ email, password: 'wrong-password' });
const good = (ip: string, spoof?: string) =>
  request(app).post('/api/auth/login').set(viaNginx(ip, spoof)).send({ email: TEST_EMAIL(), password: TEST_PASSWORD() });

describe('SEC-03 login lockout', () => {
  it('locks an IP after 5 failures; the 6th attempt (even with the right password) gets 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await bad(ip)).status).toBe(401);
    expect((await bad(ip)).status).toBe(429);
    const g = await good(ip);
    expect(g.status).toBe(429);
    expect(g.headers['set-cookie']).toBeUndefined();
  });

  it('lockout is per client IP: another IP is unaffected', async () => {
    const a = freshIp();
    for (let i = 0; i < 5; i++) await bad(a);
    expect((await bad(a)).status).toBe(429);
    expect((await good(freshIp())).status).toBe(200);
  });

  it('client-supplied X-Forwarded-For entries cannot rotate the key behind nginx (trust proxy = 1)', async () => {
    // nginx appends the real peer with $proxy_add_x_forwarded_for, so only the last hop counts.
    const real = freshIp();
    for (let i = 0; i < 5; i++) expect((await bad(real, `10.0.0.${i + 1}`)).status).toBe(401);
    expect((await bad(real, '10.9.9.9')).status).toBe(429);
    expect((await bad(real, '1.1.1.1, 2.2.2.2, 3.3.3.3')).status).toBe(429);
    expect((await good(real, '127.0.0.1')).status).toBe(429);
  });

  it('a successful login resets the failure counter for that IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await bad(ip);
    expect((await good(ip)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await bad(ip)).status).toBe(401);
  });

  it('trust-proxy XFF keying is only safe if the app port is not reachable directly: server must bind loopback', () => {
    // With trust proxy = 1, a client talking straight to :3105 picks its own req.ip via XFF and
    // bypasses every limiter. Defence in depth: listen on 127.0.0.1 so only nginx can connect.
    const src = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    const bindsLoopback = /app\.listen\(\s*PORT\s*,\s*['"](127\.0\.0\.1|localhost|::1)['"]/.test(src);
    expect(bindsLoopback, 'src/index.ts app.listen(PORT, ...) binds all interfaces; use app.listen(PORT, "127.0.0.1", ...)').toBe(true);
  });
});

describe('SEC-03 no user enumeration on login', () => {
  it('unknown email and wrong password give byte-identical responses', async () => {
    const a = await bad(freshIp(), undefined, 'nobody-here@example.test');
    const b = await bad(freshIp(), undefined, TEST_EMAIL());
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.text).toBe(b.text);
  });

  it('unknown email and wrong password are in the same timing class', async () => {
    const t = async (email: string) => {
      const s = process.hrtime.bigint();
      await bad(freshIp(), undefined, email);
      return Number(process.hrtime.bigint() - s) / 1e6;
    };
    const unknown: number[] = []; const known: number[] = [];
    for (let i = 0; i < 15; i++) { unknown.push(await t(`u${i}@example.test`)); known.push(await t(TEST_EMAIL())); }
    expect(Math.abs(median(unknown) - median(known))).toBeLessThan(25);
  });

  it('non-string credentials are rejected without a 500', async () => {
    for (const body of [{ email: ['a'], password: { $ne: 1 } }, { email: null, password: null }, {}, { email: 1, password: 2 }]) {
      const res = await request(app).post('/api/auth/login').set(viaNginx(freshIp())).send(body);
      expect(res.status).toBe(401);
    }
  });
});

describe('SEC-03 forgot-password', () => {
  it('3 requests per IP per hour, then 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) expect((await request(app).post('/api/auth/forgot-password').set(viaNginx(ip)).send({})).status).toBe(200);
    expect((await request(app).post('/api/auth/forgot-password').set(viaNginx(ip)).send({})).status).toBe(429);
  });

  it('identical response for known, unknown and missing email (no enumeration)', async () => {
    const r1 = await request(app).post('/api/auth/forgot-password').set(viaNginx(freshIp())).send({ email: TEST_EMAIL() });
    const r2 = await request(app).post('/api/auth/forgot-password').set(viaNginx(freshIp())).send({ email: 'nobody@example.test' });
    const r3 = await request(app).post('/api/auth/forgot-password').set(viaNginx(freshIp())).send({});
    expect(r1.status).toBe(200);
    expect(r1.text).toBe(r2.text);
    expect(r2.text).toBe(r3.text);
  });
});

describe('SEC-03 reset-password attempt limit', () => {
  it('10 attempts per IP per hour, then 429 (token guessing throttled)', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/api/auth/reset-password').set(viaNginx(ip)).send({ token: 'f'.repeat(64), new_password: 'abcdefgh1' });
      expect(r.status).toBe(400);
    }
    const r = await request(app).post('/api/auth/reset-password').set(viaNginx(ip)).send({ token: 'f'.repeat(64), new_password: 'abcdefgh1' });
    expect(r.status).toBe(429);
  });
});
