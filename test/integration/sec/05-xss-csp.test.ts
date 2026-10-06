/**
 * SEC-05 Reflected XSS + CSP on every public HTML-returning route (ASVS V5.3.3, V14.4.3).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll, createAccount } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, XSS_PAYLOADS, loginCookie } from './helpers';

let app: Express;
let trackingId = '';
let digest: { id: string; token: string };
let draft: { id: string; approval: string; skip: string };

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
  const acct = await createAccount();
  const s = await query<{ tracking_id: string }>(
    `INSERT INTO email_sends (email_account_id, to_email, from_email, subject, body_html, status)
     VALUES ($1, 'victim@example.test', $2, 's', '<p>hi</p>', 'sent') RETURNING tracking_id`, [acct.id, acct.email]);
  trackingId = s.rows[0].tracking_id;
  const d = await query<{ id: string; approval_token: string }>(
    `INSERT INTO daily_digest (digest_date, status, contacts) VALUES (CURRENT_DATE, 'pending', '[]') RETURNING id, approval_token`);
  digest = { id: d.rows[0].id, token: d.rows[0].approval_token };
  // Theme is attacker-influenced in the worst case (LLM output); seed a payload to prove it is escaped
  const r = await query<{ id: string; approval_token: string; skip_token: string }>(
    `INSERT INTO template_draft_reviews (theme, season, week_start, email_subject, email_html, status)
     VALUES ($1, 'autumn', CURRENT_DATE, 'subj', '<p>x</p>', 'awaiting_approval') RETURNING id, approval_token, skip_token`,
    ['<script>alert("theme")</script>"><img src=x onerror=alert(2)>']);
  draft = { id: r.rows[0].id, approval: r.rows[0].approval_token, skip: r.rows[0].skip_token };
});
afterAll(async () => { await closeAll(); });

const enc = encodeURIComponent;

/** Every public HTML surface, parameterised by an injected string. */
function surfaces(p: string): Array<{ name: string; method: 'get' | 'post'; url: string; body?: Record<string, string> }> {
  return [
    { name: 'unsubscribe page (path)', method: 'get', url: `/t/${enc(p)}/unsubscribe` },
    { name: 'unsubscribe page (query)', method: 'get', url: `/t/${trackingId}/unsubscribe?x=${enc(p)}` },
    { name: 'unsubscribe confirm (unknown id)', method: 'get', url: `/t/${enc(p)}/unsubscribe?confirm=1` },
    { name: 'one-click unsubscribe', method: 'post', url: `/t/${enc(p)}/unsubscribe`, body: { 'List-Unsubscribe': p } },
    { name: 't/* 404', method: 'get', url: `/t/${enc(p)}/${enc(p)}` },
    { name: 'click (unknown id)', method: 'get', url: `/t/${enc(p)}/click?url=${enc(p)}` },
    { name: 'click (known id)', method: 'get', url: `/t/${trackingId}/click?url=${enc(p)}` },
    { name: 'digest approve page (id)', method: 'get', url: `/api/digest/${enc(p)}/approve?token=${digest.token}` },
    { name: 'digest approve page (token)', method: 'get', url: `/api/digest/${digest.id}/approve?token=${enc(p)}` },
    { name: 'digest confirm (token)', method: 'post', url: `/api/digest/${digest.id}/approve/confirm`, body: { token: p } },
    { name: 'draft approve page (token)', method: 'get', url: `/api/draft-reviews/${draft.id}/approve?token=${enc(p)}` },
    { name: 'draft approve page (id)', method: 'get', url: `/api/draft-reviews/${enc(p)}/approve?token=${draft.approval}` },
    { name: 'draft skip page (token)', method: 'get', url: `/api/draft-reviews/${draft.id}/skip?token=${enc(p)}` },
    { name: 'draft approve POST (token)', method: 'post', url: `/api/draft-reviews/${draft.id}/approve`, body: { token: p } },
    { name: 'draft skip POST (token)', method: 'post', url: `/api/draft-reviews/${draft.id}/skip`, body: { token: p } },
    { name: 'SPA fallback', method: 'get', url: `/${enc(p)}?q=${enc(p)}` },
    { name: 'unknown api', method: 'get', url: `/api/${enc(p)}?q=${enc(p)}` },
  ];
}

function dangerous(body: string, payload: string): string | null {
  if (/[<>"']/.test(payload) && body.includes(payload)) return 'raw payload reflected';
  const decoded = decodeURIComponent(payload.replace(/%(?![0-9a-f]{2})/gi, '%25'));
  if (/[<>"']/.test(decoded) && body.includes(decoded)) return 'decoded payload reflected';
  if (/(href|src|action)\s*=\s*["']?\s*javascript:/i.test(body)) return 'javascript: URL in attribute';
  if (/<script>alert\(|onerror=alert|onload=alert|onfocus="alert/i.test(body)) return 'executable handler in body';
  return null;
}

describe('SEC-05 reflected XSS', () => {
  it('no public HTML surface reflects any payload unescaped', async () => {
    const hits: string[] = [];
    for (const p of XSS_PAYLOADS) {
      for (const s of surfaces(p)) {
        const r = s.method === 'get'
          ? await request(app).get(s.url).set(viaNginx(freshIp())).redirects(0)
          : await request(app).post(s.url).set(viaNginx(freshIp())).type('form').send(s.body || {}).redirects(0);
        const why = dangerous(r.text || '', p);
        if (why) hits.push(`${s.name} [${r.status}] ${why}: ${p}`);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('stored theme with markup is escaped on the confirm pages (valid tokens)', async () => {
    const a = await request(app).get(`/api/draft-reviews/${draft.id}/approve?token=${draft.approval}`).set(viaNginx(freshIp()));
    expect(a.status).toBe(200);
    expect(a.text).toContain('&lt;script&gt;alert(&quot;theme&quot;)&lt;/script&gt;');
    expect(a.text).not.toContain('<script>alert("theme")');
    expect(a.text).not.toContain('<img src=x');
    const s = await request(app).get(`/api/draft-reviews/${draft.id}/skip?token=${draft.skip}`).set(viaNginx(freshIp()));
    expect(s.status).toBe(200);
    expect(s.text).not.toContain('<script>alert("theme")');
  });

  it('JSON API errors are served as application/json, never text/html (no content sniffing XSS)', async () => {
    const cookie = await loginCookie(app);
    for (const u of ['/api/contacts/%3Cscript%3E', '/api/templates/%3Cscript%3E', '/api/nope%3Cscript%3E']) {
      const r = await request(app).get(u).set('Cookie', cookie).set(viaNginx(freshIp()));
      expect(r.headers['content-type'], u).toMatch(/application\/json/);
    }
  });

  it('X-Content-Type-Options: nosniff on every response', async () => {
    for (const u of ['/api/health', `/t/${trackingId}/unsubscribe`, '/t/x/open', '/']) {
      const r = await request(app).get(u).set(viaNginx(freshIp()));
      expect(r.headers['x-content-type-options'], u).toBe('nosniff');
    }
  });
});

describe('SEC-05 Content-Security-Policy on HTML responses', () => {
  const htmlUrls = () => [
    `/t/${trackingId}/unsubscribe`,
    `/t/${trackingId}/unsubscribe?confirm=1`,
    '/',
    `/api/digest/${digest.id}/approve?token=${digest.token}`,
    `/api/digest/${digest.id}/approve?token=bad`,
    `/api/draft-reviews/${draft.id}/approve?token=${draft.approval}`,
    `/api/draft-reviews/${draft.id}/skip?token=${draft.skip}`,
    `/api/draft-reviews/not-a-uuid/approve?token=x`,
  ];

  it('every public HTML response carries a CSP with script-src \'self\' and no unsafe-eval / unsafe-inline scripts', async () => {
    const problems: string[] = [];
    for (const u of htmlUrls()) {
      const r = await request(app).get(u).set(viaNginx(freshIp()));
      if (!/text\/html/.test(String(r.headers['content-type']))) continue;
      const csp = String(r.headers['content-security-policy'] || '');
      if (!csp) { problems.push(`${u}: no CSP header`); continue; }
      const script = (csp.match(/script-src([^;]*)/) || csp.match(/default-src([^;]*)/) || [])[1] || '';
      if (!/'self'/.test(script)) problems.push(`${u}: script-src lacks 'self'`);
      if (/unsafe-eval/.test(csp)) problems.push(`${u}: unsafe-eval`);
      if (/'unsafe-inline'/.test(script)) problems.push(`${u}: script unsafe-inline`);
      if (!/frame-ancestors/.test(csp) && !r.headers['x-frame-options']) problems.push(`${u}: clickjacking unprotected`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('public approve/skip confirm pages cannot be framed (clickjacking on one-click approve)', async () => {
    const r = await request(app).get(`/api/draft-reviews/${draft.id}/approve?token=${draft.approval}`).set(viaNginx(freshIp()));
    const xfo = String(r.headers['x-frame-options'] || '');
    const csp = String(r.headers['content-security-policy'] || '');
    expect(/SAMEORIGIN|DENY/i.test(xfo) || /frame-ancestors\s+('none'|'self')/.test(csp)).toBe(true);
  });

  it('HSTS is sent (app-level helmet; nginx forwards it)', async () => {
    const r = await request(app).get('/').set(viaNginx(freshIp()));
    expect(String(r.headers['strict-transport-security'])).toMatch(/max-age=(\d{8,})/);
  });
});
