/**
 * SEC-04 Password reset (ASVS V2.5).
 *
 * SAFETY: a successful reset makes index.ts rewrite `${process.cwd()}/.env`.
 * The repo root holds the PROD .env, so this file chdir()s into a throwaway
 * temp dir with a dummy .env before any request that could succeed, and
 * asserts at the end that the real .env is byte-identical.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, TEST_EMAIL, ROOT } from './helpers';

let app: Express;
const origCwd = process.cwd();
const origPassword = process.env.DASHBOARD_PASSWORD;
const prodEnv = path.join(ROOT, '.env');
const prodEnvHash = fs.existsSync(prodEnv) ? crypto.createHash('sha256').update(fs.readFileSync(prodEnv)).digest('hex') : null;
let tmp = '';

function assertSandboxed(): void {
  const target = path.resolve(process.cwd(), '.env');
  if (target === path.resolve(prodEnv) || !target.startsWith(os.tmpdir())) {
    throw new Error(`[sec-04] refusing: reset would write ${target}`);
  }
}

async function storeToken(token: string, expiresAt: Date | string) {
  await query(
    `INSERT INTO settings (key, value) VALUES ('pw_reset_token', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ token, expires_at: typeof expiresAt === 'string' ? expiresAt : expiresAt.toISOString() })]
  );
}
async function storedToken(): Promise<{ token: string; expires_at: string } | null> {
  const r = await query<{ value: { token: string; expires_at: string } }>(`SELECT value FROM settings WHERE key = 'pw_reset_token'`);
  return r.rows[0]?.value ?? null;
}
const reset = (token: unknown, new_password: unknown, ip = freshIp()) =>
  request(app).post('/api/auth/reset-password').set(viaNginx(ip)).send({ token, new_password });

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec04-'));
  fs.writeFileSync(path.join(tmp, '.env'), 'DASHBOARD_PASSWORD=sandbox-original\n');
  process.chdir(tmp);
  assertSandboxed();
  app = await getApp();
});

function restoreOrigPassword(): void {
  // A successful reset swaps the plaintext credential for a bcrypt hash
  process.env.DASHBOARD_PASSWORD = origPassword;
  delete process.env.DASHBOARD_PASSWORD_HASH;
}

afterAll(async () => {
  process.chdir(origCwd);
  restoreOrigPassword();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  await closeAll();
});

describe('SEC-04 forgot-password never discloses the link', () => {
  it('response body and headers contain neither the token nor a reset URL', async () => {
    const res = await request(app).post('/api/auth/forgot-password').set(viaNginx(freshIp())).send({ email: TEST_EMAIL() });
    expect(res.status).toBe(200);
    const stored = await storedToken();
    expect(stored?.token).toMatch(/^[0-9a-f]{64}$/); // 256-bit token
    const all = res.text + JSON.stringify(res.headers);
    expect(all).not.toContain(stored!.token);
    expect(all).not.toMatch(/reset-password\?token=|token=/i);
  });

  it('token expiry is set to <= 1 hour', async () => {
    await request(app).post('/api/auth/forgot-password').set(viaNginx(freshIp())).send({});
    const stored = await storedToken();
    const mins = (new Date(stored!.expires_at).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(55);
    expect(mins).toBeLessThanOrEqual(60.1);
  });
});

describe('SEC-04 reset-password token handling', () => {
  it('wrong token rejected, nothing changes', async () => {
    await storeToken('a'.repeat(64), new Date(Date.now() + 30 * 60000));
    const r = await reset('b'.repeat(64), 'NewPassw0rd!');
    expect(r.status).toBe(400);
    expect(process.env.DASHBOARD_PASSWORD).toBe(origPassword);
    expect(await storedToken()).not.toBeNull();
  });

  it('expired token (> 1h old) rejected', async () => {
    await storeToken('c'.repeat(64), new Date(Date.now() - 1000));
    const r = await reset('c'.repeat(64), 'NewPassw0rd!');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/expired/i);
    expect(process.env.DASHBOARD_PASSWORD).toBe(origPassword);
  });

  it('stored expiry further than 1h out (tampered/legacy) is not honoured', async () => {
    await storeToken('d'.repeat(64), new Date(Date.now() + 5 * 3600_000));
    const r = await reset('d'.repeat(64), 'NewPassw0rd!');
    expect(r.status).toBe(400);
    expect(process.env.DASHBOARD_PASSWORD).toBe(origPassword);
  });

  it('newline / CR injection in the new password is rejected (would inject .env lines)', async () => {
    await storeToken('e'.repeat(64), new Date(Date.now() + 30 * 60000));
    for (const pw of ['goodpass\nSESSION_SECRET=x', 'goodpass\rX=1', 'goodpass\r\nSEND_MODE=live']) {
      const r = await reset('e'.repeat(64), pw);
      expect(r.status).toBe(400);
    }
    expect(process.env.DASHBOARD_PASSWORD).toBe(origPassword);
    expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).toBe('DASHBOARD_PASSWORD=sandbox-original\n');
  });

  it('weak / malformed inputs rejected (short password, non-string token, array token)', async () => {
    await storeToken('f'.repeat(64), new Date(Date.now() + 30 * 60000));
    expect((await reset('f'.repeat(64), 'short')).status).toBe(400);
    expect((await reset(['f'.repeat(64)], 'NewPassw0rd!')).status).toBe(400);
    expect((await reset({ $ne: '' }, 'NewPassw0rd!')).status).toBe(400);
    expect((await reset('f'.repeat(64), 12345678)).status).toBe(400);
    expect(process.env.DASHBOARD_PASSWORD).toBe(origPassword);
  });

  it('valid token works exactly once; replay after success is rejected', async () => {
    assertSandboxed();
    const token = crypto.randomBytes(32).toString('hex');
    await storeToken(token, new Date(Date.now() + 30 * 60000));
    const ok = await reset(token, 'Sandbox-NewPassw0rd');
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('Sandbox-NewPassw0rd');
    expect(await storedToken()).toBeNull();

    const replay = await reset(token, 'Another-Passw0rd');
    expect(replay.status).toBe(400);
    // Only a bcrypt hash is kept (memory and .env); the plaintext is gone
    expect(process.env.DASHBOARD_PASSWORD).toBeUndefined();
    expect(process.env.DASHBOARD_PASSWORD_HASH).toMatch(/^\$2[aby]\$\d{2}\$/);
    const env = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(env).not.toContain('Sandbox-NewPassw0rd');
    expect(env).not.toMatch(/^DASHBOARD_PASSWORD=/m);
    expect(env).toMatch(/^DASHBOARD_PASSWORD_HASH='\$2[aby]\$/m);

    // New password logs in, old one does not
    const lo = await request(app).post('/api/auth/login').set(viaNginx(freshIp())).send({ email: TEST_EMAIL(), password: origPassword });
    expect(lo.status).toBe(401);
    const ln = await request(app).post('/api/auth/login').set(viaNginx(freshIp())).send({ email: TEST_EMAIL(), password: 'Sandbox-NewPassw0rd' });
    expect(ln.status).toBe(200);
    restoreOrigPassword();
  });

  it('a password reset invalidates existing sessions (ASVS 3.3.3)', async () => {
    assertSandboxed();
    const login = await request(app).post('/api/auth/login').set(viaNginx(freshIp())).send({ email: TEST_EMAIL(), password: origPassword });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const token = crypto.randomBytes(32).toString('hex');
    await storeToken(token, new Date(Date.now() + 30 * 60000));
    expect((await reset(token, 'Sandbox-Rotated-1')).status).toBe(200);
    restoreOrigPassword();
    const res = await request(app).get('/api/contacts').set('Cookie', cookie).set(viaNginx(freshIp()));
    expect(res.status, 'session minted before the reset is still valid after it').toBe(401);
  });

  it('the production .env was never touched', () => {
    if (!prodEnvHash) return;
    expect(crypto.createHash('sha256').update(fs.readFileSync(prodEnv)).digest('hex')).toBe(prodEnvHash);
  });
});
