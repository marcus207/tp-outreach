/**
 * SEC-13 CSRF (ASVS V4.2.2 / V3.4.3).
 *
 * The session cookie is SameSite=Lax, which stops classic cross-SITE form posts
 * in modern browsers. It does NOT stop same-site attackers (any *.tp.finance
 * host, e.g. a compromised www/marketing/subdomain page) and offers nothing for
 * legacy clients. Defence in depth = server-side Origin / Sec-Fetch-Site check
 * (or a CSRF token) on state-changing authenticated routes. These tests assert
 * that check exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, loginCookie } from './helpers';

let app: Express;
let cookie = '';
beforeAll(async () => { await resetAll(); installFakeGmail(); app = await getApp(); cookie = await loginCookie(app); });
afterAll(async () => { await closeAll(); });

const contact = async (email: string) => (await query(`SELECT 1 FROM contacts WHERE email = $1`, [email])).rows.length > 0;
const authed = (r: request.Test) => r.set('Cookie', cookie).set(viaNginx(freshIp()));

describe('SEC-13 CSRF on authenticated state-changing routes', () => {
  it('control: same-origin JSON POST works', async () => {
    const r = await authed(request(app).post('/api/contacts')).set('Origin', 'https://tp.finance').send({ email: 'csrf-control@example.test' });
    expect(r.status).toBeLessThan(300);
    expect(await contact('csrf-control@example.test')).toBe(true);
  });

  it('cross-site Origin is rejected (403) and nothing is written', async () => {
    const r = await authed(request(app).post('/api/contacts'))
      .set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'cross-site')
      .send({ email: 'csrf-cross@example.test' });
    expect(r.status, 'POST with Origin: https://evil.example was accepted').toBe(403);
    expect(await contact('csrf-cross@example.test')).toBe(false);
  });

  it('same-site-but-cross-origin (sibling subdomain) is rejected', async () => {
    const r = await authed(request(app).post('/api/contacts'))
      .set('Origin', 'https://go.tp.finance').set('Sec-Fetch-Site', 'same-site')
      .send({ email: 'csrf-sibling@example.test' });
    expect(r.status, 'POST from https://go.tp.finance (same-site, SameSite=Lax sends cookies) was accepted').toBe(403);
    expect(await contact('csrf-sibling@example.test')).toBe(false);
  });

  it('HTML-form-style (urlencoded, no preflight) cross-origin POST is rejected', async () => {
    const r = await authed(request(app).post('/api/contacts')).set('Origin', 'https://evil.example')
      .type('form').send('email=csrf-form%40example.test');
    expect(r.status, 'urlencoded simple-request POST accepted on a JSON API').toBe(403);
    expect(await contact('csrf-form@example.test')).toBe(false);
  });

  it('text/plain JSON smuggling (no preflight) is not parsed as a body', async () => {
    const r = await authed(request(app).post('/api/contacts')).set('Origin', 'https://evil.example')
      .set('Content-Type', 'text/plain').send('{"email":"csrf-plain@example.test"}');
    expect(r.status).not.toBe(200);
    expect(await contact('csrf-plain@example.test')).toBe(false);
  });

  it('other verbs (PUT/PATCH/DELETE) from a foreign Origin are rejected', async () => {
    const fails: string[] = [];
    for (const [m, u] of [['put', '/api/dripify/alerts/read-all'], ['delete', '/api/contacts/00000000-0000-4000-8000-000000000000'], ['patch', '/api/draft-reviews/00000000-0000-4000-8000-000000000000']] as const) {
      const r = await authed(request(app)[m](u)).set('Origin', 'https://evil.example').send({});
      if (r.status !== 403) fails.push(`${m.toUpperCase()} ${u} -> ${r.status}`);
    }
    expect(fails, fails.join('\n')).toEqual([]);
  });

  it('logout CSRF: a foreign Origin cannot end the session', async () => {
    const c = await loginCookie(app);
    await request(app).post('/api/auth/logout').set('Cookie', c).set(viaNginx(freshIp())).set('Origin', 'https://evil.example');
    const me = await request(app).get('/api/auth/me').set('Cookie', c).set(viaNginx(freshIp()));
    expect(me.body.authenticated).toBe(true);
  });
});
