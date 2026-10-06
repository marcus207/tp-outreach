/**
 * SEC-07 Injection (ASVS V5.3.4 parameterised queries, V7.4.1 generic errors).
 *  - SQLi probes on every search/filter/sort/limit query param
 *  - SQLi probes on every authenticated GET route's path params
 *  - Static scan of src for string-interpolated SQL, classified by reachability
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import { resetAll, installFakeGmail, closeAll, createContact } from '../factories';
import { query } from '../../../src/db/connection';
import { getApp, freshIp, viaNginx, loginCookie, SQLI_PAYLOADS, leaks, bodyText, listRoutes, fillParams, ROOT } from './helpers';

let app: Express;
let cookie = '';

const FILTER_ROUTES: Array<{ path: string; params: string[] }> = [
  { path: '/api/contacts', params: ['search', 'tag', 'company', 'source', 'sort', 'dir', 'page', 'limit', 'category', 'subsector'] },
  { path: '/api/analytics/overview', params: ['days'] },
  { path: '/api/analytics/daily', params: ['days'] },
  { path: '/api/analytics/accounts', params: ['days'] },
  { path: '/api/analytics/campaigns', params: ['days'] },
  { path: '/api/analytics/failed-emails', params: ['days'] },
  { path: '/api/analytics/stale-contacts', params: ['days', 'limit'] },
  { path: '/api/analytics/dmarc', params: ['days'] },
  { path: '/api/campaigns', params: ['status', 'search', 'sort', 'limit'] },
  { path: '/api/campaign-planner/schedule', params: ['sector'] },
  { path: '/api/campaign-planner/engine/log', params: ['limit'] },
  { path: '/api/articles', params: ['status', 'sector'] },
  { path: '/api/press-releases', params: ['status', 'announcement'] },
];

beforeAll(async () => {
  await resetAll();
  installFakeGmail();
  app = await getApp();
  cookie = await loginCookie(app);
  await createContact({ email: 'alice@dev-one.test', firstName: 'Alice', company: 'Dev One' });
  await createContact({ email: 'bob@dev-two.test', firstName: 'Bob', company: 'Dev Two' });
  // A contact in another tenant: must never be returned to the tp dashboard
  await createContact({ email: 'secret-lender@li-tenant.test', firstName: 'Secret', company: 'LI Only', tenant: 'li', type: 'lender' });
});
afterAll(async () => { await closeAll(); });

const get = (url: string) => request(app).get(url).set('Cookie', cookie).set(viaNginx(freshIp())).timeout({ response: 15000 });

describe('SEC-07 SQL injection via query params', () => {
  it('no SQL error text / stack leaks and no cross-tenant rows for any payload', async () => {
    const problems: string[] = [];
    for (const r of FILTER_ROUTES) {
      for (const p of r.params) {
        for (const payload of SQLI_PAYLOADS) {
          const url = `${r.path}?${p}=${encodeURIComponent(payload)}`;
          const t0 = Date.now();
          const res = await get(url);
          const text = bodyText(res);
          const leak = leaks(text);
          if (leak) problems.push(`${url} [${res.status}] leaks "${leak}"`);
          if (text.includes('secret-lender@li-tenant.test')) problems.push(`${url} returned another tenant's contact`);
          if (Date.now() - t0 > 1900 && /pg_sleep/.test(payload)) problems.push(`${url} slept (time-based SQLi)`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('numeric/sort params are validated: malformed values never produce a 5xx', async () => {
    const fives: string[] = [];
    for (const r of FILTER_ROUTES) {
      for (const p of r.params) {
        for (const payload of ['abc', '-1', '0', '99999999999999999999', "1' OR '1'='1"]) {
          const res = await get(`${r.path}?${p}=${encodeURIComponent(payload)}`);
          if (res.status >= 500) fives.push(`${r.path}?${p}=${payload} -> ${res.status}`);
        }
      }
    }
    expect(fives, fives.join('\n')).toEqual([]);
  });

  it("contacts search with ' OR 1=1-- matches nothing (treated as a literal)", async () => {
    const res = await get(`/api/contacts?search=${encodeURIComponent("' OR 1=1--")}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    const all = await get('/api/contacts');
    expect(all.body.total).toBe(2); // only tp-tenant rows
  });

  it('sort column injection falls back to the allowlisted default', async () => {
    const res = await get(`/api/contacts?sort=${encodeURIComponent('(SELECT 1)')}&dir=${encodeURIComponent('; DROP TABLE contacts')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('limit is capped (no bulk exfiltration beyond 200 per page)', async () => {
    const res = await get('/api/contacts?limit=100000');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeLessThanOrEqual(200);
  });

  it('tables survive every DROP payload', async () => {
    const r = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM contacts`);
    expect(Number(r.rows[0].n)).toBe(3);
  });
});

describe('SEC-07 path-param injection on every authenticated GET route', () => {
  it('no route leaks DB errors or stack traces for malicious ids', async () => {
    const routes = listRoutes(app).filter(r => r.method === 'GET' && r.staticAuth && /:/.test(r.path));
    expect(routes.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const r of routes) {
      for (const v of ["x' OR '1'='1", '1;DROP TABLE contacts', 'not-a-uuid']) {
        const url = fillParams(r.path, encodeURIComponent(v));
        const res = await get(url);
        const leak = leaks(bodyText(res));
        if (leak) problems.push(`GET ${r.path} [${res.status}] leaks "${leak}"`);
      }
    }
    const uniq = [...new Set(problems)];
    expect(uniq, uniq.join('\n')).toEqual([]);
  });
});

// ── Static scan ────────────────────────────────────────────────────────

interface Interp { file: string; line: number; expr: string }

function scanInterpolatedSql(): Interp[] {
  const out: Interp[] = [];
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []);
  for (const f of walk(path.join(ROOT, 'src'))) {
    const s = fs.readFileSync(f, 'utf8');
    const re = /`([^`]*)`/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const t = m[1];
      if (!/\$\{/.test(t) || !/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|ORDER BY|INTERVAL)\b/.test(t) || /<[a-z]+[\s>]/i.test(t)) continue;
      const line = s.slice(0, m.index).split('\n').length;
      for (const x of t.matchAll(/\$\{([^}]*)\}/g)) {
        out.push({ file: path.relative(ROOT, f), line, expr: x[1].trim() });
      }
    }
  }
  return out;
}

/**
 * Reviewed classification (5 Oct 2026). Every interpolation must be either a
 * constant/env value, a $n placeholder index, or a value built only from
 * allowlisted fragments. Key = expression; value = why it is safe.
 */
const SAFE_EXPR: Array<[RegExp, string]> = [
  [/^TENANT$/, 'env constant'],
  [/^(ENROL|BROADCAST_RECIPIENT|BLAST_RECIPIENT)_EXCLUSIONS$/, 'module constant SQL fragment'],
  [/^(STALE_QUEUED|STRANDED_GRACE)_INTERVAL$/, 'module constant'],
  [/^suppression(Exclusion|Match)Sql\('[\w.$:]+', '[\w.$:]+'\)$/, 'suppression.ts helper called with literal column/placeholder expressions'],
  [/^(emailExpr|tenantExpr)$/, 'suppression.ts: parameters are only ever literal SQL expressions from call sites (checked by the rule above)'],
  [/^interval$/, "analytics /recent: literal '1 hour' | '24 hours' from a const array"],
  [/^params\.length( - 1)?$/, 'placeholder index'],
  [/^paramIdx( - 1)?$/, 'placeholder index'],
  [/^conditions\.join\(' AND '\)$/, 'fragments are fixed strings with $n placeholders'],
  [/^whereClause$/, 'built from fixed fragments with $n placeholders'],
  [/^filter$/, 'gmail-client: fixed fragment with $n placeholder'],
  [/^updates\.join\(', '\)$/, 'fixed column names with $n placeholders'],
  [/^sortCol$/, "contacts: allowlist ['email','first_name','company','title','city','created_at']"],
  [/^sortDir$/, "contacts: 'ASC' | 'DESC'"],
  [/^pubFilter$/, 'fixed fragment with $1'],
  [/^feedbackField$/, "draft-review: 'feedback_1' | 'feedback_2'"],
  [/^reason === 'replied' \? 'replied_at = NOW\(\),' : ''$/, 'ternary of literals'],
];

describe('SEC-07 static: string-interpolated SQL', () => {
  it('every ${} inside SQL text is a reviewed, non-user-controlled value', () => {
    const all = scanInterpolatedSql();
    const report = all.map(i => {
      const safe = SAFE_EXPR.find(([re]) => re.test(i.expr));
      return { ...i, verdict: safe ? `safe: ${safe[1]}` : 'UNREVIEWED' };
    });
    console.log('[sec-07] interpolated SQL inventory:\n' + report.map(r => `  ${r.file}:${r.line}  \${${r.expr}}  -> ${r.verdict}`).join('\n'));
    const unreviewed = report.filter(r => r.verdict === 'UNREVIEWED').map(r => `${r.file}:${r.line} \${${r.expr}}`);
    expect(unreviewed, `new interpolated SQL needs review:\n${unreviewed.join('\n')}`).toEqual([]);
  });

  it('contacts sort column stays allowlisted in source', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/contacts.ts'), 'utf8');
    expect(/const sortCol = \[[^\]]+\]\.includes\(req\.query\.sort/.test(src)).toBe(true);
    expect(/const sortDir = req\.query\.dir === 'asc' \? 'ASC' : 'DESC'/.test(src)).toBe(true);
  });
});
