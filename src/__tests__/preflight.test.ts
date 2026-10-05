/**
 * Tests for scripts/preflight.ts check functions (DNS, accounts/identity,
 * limits + warm-up, hygiene, config, templates). DB and DNS are mocked.
 *
 * scripts/ lives outside tsconfig rootDir (src), so the module is loaded via a
 * non-literal dynamic import and typed loosely here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  pool: { end: vi.fn() },
  TENANT: 'tp',
  BRAND_NAME: 'Turning Point Capital Advisory',
  BRAND_EMAIL: 'marcus@tp.finance',
}));
vi.mock('googleapis', () => ({ google: {} }));

type Result = { section: string; name: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pf: any;

beforeAll(async () => {
  const modPath = '../../scripts/preflight';
  pf = await import(/* @vite-ignore */ modPath);
});
beforeEach(() => { mockQuery.mockReset(); });

const byName = (rs: Result[], name: string) => rs.find(x => x.name === name)!;

function resolver(map: { mx?: string[]; txt?: Record<string, string[]> }) {
  return {
    resolveMx: async (_h: string) => {
      if (!map.mx?.length) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return map.mx.map(exchange => ({ exchange, priority: 1 }));
    },
    resolveTxt: async (h: string) => {
      const v = map.txt?.[h];
      if (!v) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return v.map(s => [s]);
    },
  };
}

describe('checkDns', () => {
  it('passes a fully configured domain, warns on p=none', async () => {
    const rs: Result[] = await pf.checkDns(resolver({
      mx: ['smtp.google.com'],
      txt: {
        'go.tp.finance': ['v=spf1 include:_spf.google.com ~all'],
        '_dmarc.go.tp.finance': ['v=DMARC1; p=none; rua=mailto:x@tp.finance'],
        'google._domainkey.go.tp.finance': ['v=DKIM1; k=rsa; p=ABC'],
        '_dmarc.tp.finance': ['v=DMARC1; p=quarantine;'],
      },
    }), 'go.tp.finance', 'tp.finance');
    const cold = rs.filter(x => x.section.includes('go.tp.finance'));
    expect(byName(cold, 'MX present').status).toBe('PASS');
    expect(byName(cold, 'SPF').status).toBe('PASS');
    expect(byName(cold, 'DMARC').status).toBe('WARN');
    expect(byName(cold, 'DKIM google._domainkey').status).toBe('PASS');
    const root = rs.filter(x => x.section.startsWith('b.'));
    expect(byName(root, 'DMARC').status).toBe('PASS');
    expect(byName(root, 'DKIM s2026._domainkey').status).toBe('WARN');
  });

  it('fails missing MX, SPF without google include, missing DKIM/DMARC', async () => {
    const rs: Result[] = await pf.checkDns(resolver({ txt: { 'go.tp.finance': ['v=spf1 mx ~all'] } }), 'go.tp.finance', 'tp.finance');
    expect(rs.filter(x => x.status === 'FAIL').map(x => x.name).sort())
      .toEqual(['DKIM google._domainkey', 'DMARC', 'DMARC', 'MX present', 'SPF'].sort());
  });
});

describe('checkAccounts', () => {
  const acc = (o: object = {}) => ({ id: '1', email: 'marcus@go.tp.finance', daily_limit: 10, hourly_limit: 2, created_at: new Date(), oauth_tokens: { refresh_token: 'r' }, ...o });

  it('passes a cold-domain account whose token identity matches', async () => {
    const rs: Result[] = await pf.checkAccounts([acc()], async () => ({ emailAddress: 'Marcus@go.tp.finance' }), 'go.tp.finance');
    expect(rs.every(x => x.status === 'PASS')).toBe(true);
  });

  it('fails on identity mismatch (the loredana@ bug)', async () => {
    const rs: Result[] = await pf.checkAccounts([acc({ email: 'loredana@go.tp.finance' })], async () => ({ emailAddress: 'marcus@go.tp.finance' }), 'go.tp.finance');
    const oauth = byName(rs, 'loredana@go.tp.finance OAuth');
    expect(oauth.status).toBe('FAIL');
    expect(oauth.detail).toContain('mismatch');
    expect(byName(rs, 'active go.tp.finance sender').status).toBe('FAIL');
  });

  it('fails on invalid_grant', async () => {
    const rs: Result[] = await pf.checkAccounts([acc()], async () => ({ emailAddress: null, error: 'invalid_grant' }), 'go.tp.finance');
    expect(byName(rs, 'marcus@go.tp.finance OAuth').status).toBe('FAIL');
  });

  it('root-domain accounts must have zero limits', async () => {
    const ok = async () => ({ emailAddress: 'marcus@tp.finance' });
    const zero: Result[] = await pf.checkAccounts([acc({ email: 'marcus@tp.finance', daily_limit: 0, hourly_limit: 0 })], ok, 'go.tp.finance');
    expect(byName(zero, 'marcus@tp.finance domain').status).toBe('PASS');
    const live: Result[] = await pf.checkAccounts([acc({ email: 'marcus@tp.finance', daily_limit: 5, hourly_limit: 1 })], ok, 'go.tp.finance');
    expect(byName(live, 'marcus@tp.finance domain').status).toBe('FAIL');
  });
});

describe('checkLimits', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000);
  const a = (o: object) => ({ id: '1', email: 'x@go.tp.finance', daily_limit: 10, hourly_limit: 2, created_at: daysAgo(100), oauth_tokens: null, ...o });

  it('caps at 50/day and 10/hr unless allowed', () => {
    expect(pf.checkLimits([a({ daily_limit: 51 })], now, false)[0].status).toBe('FAIL');
    expect(pf.checkLimits([a({ hourly_limit: 11 })], now, false)[0].status).toBe('FAIL');
    expect(pf.checkLimits([a({ daily_limit: 51, hourly_limit: 11 })], now, true)[0].status).toBe('PASS');
  });

  it('enforces warm-up 10*(weeks+1) within 28 days', () => {
    expect(pf.checkLimits([a({ created_at: daysAgo(3), daily_limit: 10 })], now, false)[0].status).toBe('PASS');
    expect(pf.checkLimits([a({ created_at: daysAgo(3), daily_limit: 11 })], now, false)[0].status).toBe('FAIL');
    expect(pf.checkLimits([a({ created_at: daysAgo(15), daily_limit: 30 })], now, false)[0].status).toBe('PASS');
    expect(pf.checkLimits([a({ created_at: daysAgo(15), daily_limit: 31 })], now, false)[0].status).toBe('FAIL');
    expect(pf.checkLimits([a({ created_at: daysAgo(29), daily_limit: 50 })], now, false)[0].status).toBe('PASS');
  });
});

describe('checkHygiene', () => {
  it('passes on zero counts and fails on non-zero; read-only SELECTs only', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: [{ n: sql.includes("contact_type = 'lender'") && !sql.includes('sequence_enrollments') ? 3 : 0 }] }));
    const rs: Result[] = await pf.checkHygiene();
    expect(byName(rs, 'no lender contacts').status).toBe('FAIL');
    expect(rs.filter(x => x.status === 'PASS')).toHaveLength(4);
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0]).trim()).toMatch(/^SELECT/i);
      expect(call[1]).toEqual(['tp']);
    }
  });
});

describe('checkConfig', () => {
  it('warns on enabled Apollo/auto-enrol flags and missing SEND_MODE', () => {
    const rs: Result[] = pf.checkConfig({ APOLLO_SYNC_ENABLED: 'true', APOLLO_WEBHOOK_ENABLED: 'false' });
    expect(byName(rs, 'APOLLO_SYNC_ENABLED').status).toBe('WARN');
    expect(byName(rs, 'TP_AUTO_ENROL_ENABLED').status).toBe('PASS');
    expect(byName(rs, 'SEND_MODE').status).toBe('WARN');
    expect(byName(rs, 'CIRCUIT_BREAKER_ENABLED').status).toBe('PASS');
  });
  it('fails webhook enabled without secret, and disabled breaker', () => {
    const rs: Result[] = pf.checkConfig({ APOLLO_WEBHOOK_ENABLED: 'true', CIRCUIT_BREAKER_ENABLED: 'false', SEND_MODE: 'live' });
    expect(byName(rs, 'APOLLO_WEBHOOK_SECRET').status).toBe('FAIL');
    expect(byName(rs, 'CIRCUIT_BREAKER_ENABLED').status).toBe('FAIL');
    expect(byName(rs, 'SEND_MODE').status).toBe('PASS');
  });
});

describe('checkTemplates', () => {
  const t = (o: object) => ({ id: '1', name: 'T', subject: 'Hi', body_html: '<p>Hi</p>', body_text: null, ...o });
  const src = 'const hasUnsubscribe = x; `List-Unsubscribe: <...>`; `<a href="u">Unsubscribe</a>`';

  it('passes unsubscribe when the system always appends it', () => {
    expect(byName(pf.checkTemplates([t({})], src), 'unsubscribe link').status).toBe('PASS');
  });
  it('requires {{unsubscribe_url}} when the system does not append it', () => {
    expect(byName(pf.checkTemplates([t({})], ''), 'unsubscribe link').status).toBe('FAIL');
    expect(byName(pf.checkTemplates([t({ body_html: '<a href="{{unsubscribe_url}}">x</a>' })], ''), 'unsubscribe link').status).toBe('PASS');
  });
  it('fails base64 images', () => {
    expect(byName(pf.checkTemplates([t({ body_html: '<img src="data:image/png;base64,AAA">' })], src), 'no base64 images').status).toBe('FAIL');
  });
  it('fails bare brand name but allows the full name', () => {
    const name = "no bare 'Turning Point Capital'";
    expect(byName(pf.checkTemplates([t({ body_html: 'Turning Point Capital Advisory' })], src), name).status).toBe('PASS');
    expect(byName(pf.checkTemplates([t({ body_html: 'Regards, Turning Point Capital.' })], src), name).status).toBe('FAIL');
    expect(byName(pf.checkTemplates([t({ subject: 'Turning Point Capital update' })], src), name).status).toBe('FAIL');
  });
});

describe('summary', () => {
  it('ok only when there are no FAILs', () => {
    expect(pf.summarise([{ status: 'PASS' }, { status: 'WARN' }]).ok).toBe(true);
    expect(pf.summarise([{ status: 'PASS' }, { status: 'FAIL' }]).ok).toBe(false);
  });
});
