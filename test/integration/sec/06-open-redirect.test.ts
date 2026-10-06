/**
 * SEC-06 Open redirect via /t/:id/click (ASVS V5.1.5).
 * The Location header must only ever point at tp.finance (and subdomains) or a
 * host that genuinely appears as a link in that send's stored body.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll, createAccount } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx } from './helpers';

let app: Express;
let known = '';       // send whose body links to partner-firm.example
let emptyBody = '';   // send with an empty stored body
const BODY = '<p>Read <a href="https://partner-firm.example/report">our report</a> and <a href="https://www.tp.finance/insights">insights</a>.</p>';

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
  const acct = await createAccount();
  const ins = async (body: string) => (await query<{ tracking_id: string }>(
    `INSERT INTO email_sends (email_account_id, to_email, from_email, subject, body_html, status)
     VALUES ($1, 'r@example.test', $2, 's', $3, 'sent') RETURNING tracking_id`, [acct.id, acct.email, body])).rows[0].tracking_id;
  known = await ins(BODY);
  emptyBody = await ins('');
});
afterAll(async () => { await closeAll(); });

const BRAND = 'tp.finance';
function allowedLocation(loc: string, extraHosts: string[] = []): boolean {
  let u: URL;
  try { u = new URL(loc, 'https://www.tp.finance/outreach/'); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  // Browsers treat backslashes as slashes; reject anything a browser could reinterpret
  if (/[\\\s]/.test(loc) || /^\/\//.test(loc)) return false;
  const h = u.hostname.toLowerCase();
  if (h === BRAND || h.endsWith('.' + BRAND)) return true;
  return extraHosts.includes(h);
}

const click = (id: string, url?: string) => {
  const q = url === undefined ? '' : `?url=${encodeURIComponent(url)}`;
  return request(app).get(`/t/${id}/click${q}`).set(viaNginx(freshIp())).redirects(0);
};

const HOSTILE = [
  'https://evil.example/',
  'http://evil.example',
  '//evil.example',
  '///evil.example',
  '/\\evil.example',
  '\\\\evil.example',
  'https:\\\\evil.example',
  'https:/\\evil.example',
  'https://tp.finance@evil.example',
  'https://www.tp.finance@evil.example/',
  'https://tp.finance:443@evil.example',
  'https://evil.example\\.tp.finance',
  'https://evil.example#.tp.finance',
  'https://evil.example?.tp.finance',
  'https://evil.example/.tp.finance',
  'https://tp.finance.evil.example',
  'https://evil-tp.finance.example',
  'https://eviltp.finance',
  'javascript:alert(document.domain)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'ftp://evil.example',
  'https://%65vil.example',
  'https://evil.example%2F.tp.finance',
  'https://xn--tp-finance-xyz.example',
  'https://0x7f000001/',
  'https://evil.example。tp.finance',
  'https://partner-firm.example.evil.example/', // allowed host as a prefix
  'https://partner-firm.exampl/',                 // allowed host as a substring of the stored link
  'https://partner-firm.ex/',
  'https://firm.example/',                         // suffix of the stored host
];

describe('SEC-06 open redirect', () => {
  it('unknown tracking id: always the fallback, whatever url= says', async () => {
    for (const u of [undefined, ...HOSTILE, 'https://www.tp.finance/x']) {
      const r = await click('0'.repeat(64), u);
      expect(r.status).toBe(302);
      expect(r.headers.location, String(u)).toBe('https://www.tp.finance');
    }
  });

  it('known tracking id: hostile targets never leave the allowlist', async () => {
    const bad: string[] = [];
    for (const u of HOSTILE) {
      const r = await click(known, u);
      const loc = String(r.headers.location || '');
      if (r.status >= 300 && r.status < 400 && !allowedLocation(loc, ['partner-firm.example'])) bad.push(`${u} -> ${loc}`);
      if (/^https?:\/\/partner-firm\.example\.evil|partner-firm\.exampl\/|partner-firm\.ex\/|\/\/firm\.example/.test(loc)) bad.push(`${u} -> ${loc} (substring host match)`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('known id + empty stored body: foreign hosts are still refused', async () => {
    const r = await click(emptyBody, 'https://evil.example/phish');
    expect(String(r.headers.location)).toBe('https://www.tp.finance');
  });

  it('known id: legitimate targets still work (brand + host in body)', async () => {
    expect((await click(known, 'https://www.tp.finance/insights')).headers.location).toBe('https://www.tp.finance/insights');
    expect((await click(known, 'https://partner-firm.example/report')).headers.location).toBe('https://partner-firm.example/report');
  });

  it('Location header never contains CR/LF (header splitting)', async () => {
    const r = await click(known, 'https://www.tp.finance/%0d%0aSet-Cookie:%20x=1');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(String(r.headers.location)).not.toMatch(/[\r\n]/);
  });

  it('redirect body does not reflect the target as live markup', async () => {
    const r = await click(known, 'https://www.tp.finance/"><script>alert(1)</script>');
    expect(r.text || '').not.toContain('<script>alert(1)</script>');
  });
});
