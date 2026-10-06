/**
 * SEC-09 Machine-to-machine endpoints: Apollo webhook + Dripify ingest (ASVS V13.1, V2.10).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, sleep, ROOT, median } from './helpers';

let app: Express;
const SECRET = 'whsec-test-' + crypto.randomBytes(8).toString('hex');

beforeAll(async () => { await resetAll(); installFakeGmail(); app = await getApp(); });
afterAll(async () => { await closeAll(); });
afterEach(() => {
  process.env.APOLLO_WEBHOOK_ENABLED = 'false';
  process.env.APOLLO_WEBHOOK_SECRET = '';
  process.env.DRIPIFY_INGEST_KEY = 'test-dripify-key';
});

const contactExists = async (email: string) =>
  (await query(`SELECT 1 FROM contacts WHERE LOWER(email) = LOWER($1)`, [email])).rows.length > 0;

function apolloBody(email: string): string {
  return JSON.stringify({ event_type: 'contact_updated', data: { id: 'ap1', email, first_name: 'Web', last_name: 'Hook' } });
}
const sign = (body: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const postApollo = (body: string, headers: Record<string, string> = {}) =>
  request(app).post('/api/webhooks/apollo').set(viaNginx(freshIp())).set('Content-Type', 'application/json').set(headers).send(body);

describe('SEC-09 Apollo webhook', () => {
  it('disabled by default: even a correctly signed payload is ignored', async () => {
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    const body = apolloBody('apollo-disabled@example.test');
    const r = await postApollo(body, { 'X-Apollo-Signature': sign(body) });
    expect(r.status).toBe(200);
    await sleep(200);
    expect(await contactExists('apollo-disabled@example.test')).toBe(false);
  });

  it('enabled without a secret: fails closed', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    const body = apolloBody('apollo-nosecret@example.test');
    await postApollo(body, { 'X-Apollo-Signature': sign(body, '') });
    await sleep(200);
    expect(await contactExists('apollo-nosecret@example.test')).toBe(false);
  });

  it('enabled: missing / wrong / truncated / wrong-algo signatures are dropped; valid one accepted', async () => {
    process.env.APOLLO_WEBHOOK_ENABLED = 'true';
    process.env.APOLLO_WEBHOOK_SECRET = SECRET;
    const cases: Array<[string, Record<string, string>]> = [];
    const mk = (tag: string) => { const e = `apollo-${tag}@example.test`; return { e, b: apolloBody(e) }; };
    const none = mk('none'); cases.push([none.b, {}]);
    const wrong = mk('wrong'); cases.push([wrong.b, { 'X-Apollo-Signature': sign(wrong.b, 'other-secret') }]);
    const trunc = mk('trunc'); cases.push([trunc.b, { 'X-Apollo-Signature': sign(trunc.b).slice(0, 20) }]);
    const bare = mk('bare'); cases.push([bare.b, { 'X-Apollo-Signature': sign(bare.b).replace('sha256=', '') }]);
    const md5 = mk('md5'); cases.push([md5.b, { 'X-Apollo-Signature': 'md5=' + crypto.createHmac('md5', SECRET).update(md5.b).digest('hex') }]);
    const tamper = mk('tamper'); cases.push([tamper.b.replace('Web', 'Evil'), { 'X-Apollo-Signature': sign(tamper.b) }]);
    for (const [b, h] of cases) expect((await postApollo(b, h)).status).toBe(200);
    const good = mk('good');
    await postApollo(good.b, { 'X-Apollo-Signature': sign(good.b) });
    await sleep(400);
    for (const t of ['none', 'wrong', 'trunc', 'bare', 'md5', 'tamper']) expect(await contactExists(`apollo-${t}@example.test`), t).toBe(false);
    expect(await contactExists('apollo-good@example.test')).toBe(true);
  });

  it('signature comparison is constant-time (crypto.timingSafeEqual over the HMAC)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/webhooks.ts'), 'utf8');
    const fn = src.slice(src.indexOf('function verifyApolloSignature'), src.indexOf('async function upsertContact'));
    expect(fn).toMatch(/createHmac\('sha256'/);
    expect(fn).toMatch(/timingSafeEqual/);
    expect(fn).not.toMatch(/===|!==|==\s/);
  });

  it('webhook body limit is 1mb (raw parser)', async () => {
    const r = await postApollo('x'.repeat(1024 * 1024 + 10));
    expect(r.status).toBe(413);
  });
});

describe('SEC-09 Dripify ingest', () => {
  const payload = (email: string) => ({ email, firstName: 'Drip', lastName: 'Ify', company: 'X' });
  const ingest = (email: string) => request(app).post('/api/dripify/ingest').set(viaNginx(freshIp()));

  it('accepts the key in X-Ingest-Key and X-Api-Key headers', async () => {
    expect((await ingest('').set('X-Ingest-Key', 'test-dripify-key').send(payload('d1@example.test'))).status).toBe(200);
    expect((await ingest('').set('X-Api-Key', 'test-dripify-key').send(payload('d2@example.test'))).status).toBe(200);
    expect(await contactExists('d1@example.test')).toBe(true);
  });

  it('query-string key still works but is flagged deprecated (logged once)', async () => {
    const warn = vi.spyOn(console, 'warn');
    const r = await request(app).post('/api/dripify/ingest?api_key=test-dripify-key').set(viaNginx(freshIp())).send(payload('d3@example.test'));
    expect(r.status).toBe(200);
    // logged at most once per process; either now or by an earlier call
    const src = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    expect(src).toMatch(/DEPRECATED: ingest key passed in query string/);
    warn.mockRestore();
  });

  it('wrong, missing, empty, array and case-variant keys are rejected with 403 and no write', async () => {
    const tries: Array<(r: request.Test) => request.Test> = [
      r => r,
      r => r.set('X-Ingest-Key', ''),
      r => r.set('X-Ingest-Key', 'TEST-DRIPIFY-KEY'),
      r => r.set('X-Ingest-Key', 'test_dripify-key'),
      r => r.set('X-Ingest-Key', 'test-dripify-ke'),
      r => r.set('X-Ingest-Key', 'test-dripify-keyX'),
    ];
    for (const t of tries) expect((await t(ingest('')).send(payload('bad@example.test'))).status).toBe(403);
    expect((await request(app).post('/api/dripify/ingest?api_key[]=test-dripify-key').set(viaNginx(freshIp())).send(payload('bad@example.test'))).status).toBe(403);
    expect(await contactExists('bad@example.test')).toBe(false);
  });

  it('unset DRIPIFY_INGEST_KEY fails closed (no key matches empty)', async () => {
    process.env.DRIPIFY_INGEST_KEY = '';
    const r = await ingest('').set('X-Ingest-Key', '').send(payload('unset@example.test'));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await contactExists('unset@example.test')).toBe(false);
  });

  it('key comparison is constant-time (safeEqual: sha256 + timingSafeEqual)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    const mw = src.slice(src.indexOf('function requireIngestKey'), src.indexOf("app.post('/api/dripify/ingest'"));
    expect(mw).toMatch(/safeEqual\(key, expectedKey\)/);
    const se = src.slice(src.indexOf('function safeEqual'), src.indexOf('function createRateLimiter'));
    expect(se).toMatch(/timingSafeEqual/);
  });

  it('timing: wrong-prefix and wrong-suffix keys are indistinguishable', async () => {
    const t = async (k: string) => {
      const s = process.hrtime.bigint();
      await ingest('').set('X-Ingest-Key', k).send({});
      return Number(process.hrtime.bigint() - s) / 1e6;
    };
    const a: number[] = []; const b: number[] = [];
    for (let i = 0; i < 20; i++) { a.push(await t('Xest-dripify-key')); b.push(await t('test-dripify-keX')); }
    expect(Math.abs(median(a) - median(b))).toBeLessThan(10);
  });

  it('the legacy requireApiKey helper (non-constant-time, accepts query key) is not used by any route', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src/routes')).map(f => path.join(ROOT, 'src/routes', f)).concat(path.join(ROOT, 'src/index.ts'));
    const users = files.filter(f => /requireApiKey/.test(fs.readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
});
