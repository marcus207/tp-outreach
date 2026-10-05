/**
 * Tests for the outreach circuit breaker: failure classification, rate
 * decisions (min sample, thresholds), tripping (zero limits, save previous
 * limits, never raise), overall trip and once-per-24h alert idempotency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  TENANT: 'tp',
  BRAND_NAME: 'Turning Point Capital Advisory',
  BRAND_EMAIL: 'marcus@tp.finance',
}));

vi.mock('googleapis', () => ({ google: {} }));

import {
  isPolicyBlock, isAuthError, checkRates, decideTrips, evaluate,
  DEFAULT_THRESHOLDS, isCircuitBreakerEnabled, getThresholds,
  type WindowStats, type AccountRow,
} from '../services/circuit-breaker';

const ws = (o: Partial<WindowStats> = {}): WindowStats =>
  ({ sent: 0, bounced: 0, unsubscribed: 0, infraFailed: 0, authErrors: 0, ...o });

const acct = (o: Partial<AccountRow> = {}): AccountRow => ({
  id: '00000000-0000-0000-0000-000000000001', email: 'a@go.tp.finance',
  daily_limit: 20, hourly_limit: 4, broadcast_hourly_limit: 4, ...o,
});

interface Fake {
  accounts: AccountRow[];
  active: string[];
  sends: Record<'7d' | '24h', { email_account_id: string; status: string; error_message: string | null; n: string }[]>;
  unsubs: Record<'7d' | '24h', { email_account_id: string; n: string }[]>;
  settings: Record<string, { value: unknown; updated_at: Date }>;
  updates: unknown[][];
}

function installFakeDb(f: Fake) {
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
    const win = params[1] === '7 days' ? '7d' : '24h';
    if (sql.includes('WHERE key = ANY')) return rows([]);
    if (sql.includes('SELECT value, updated_at FROM settings')) {
      const s = f.settings[params[0] as string];
      return rows(s ? [s] : []);
    }
    if (sql.includes('INSERT INTO settings')) {
      f.settings[params[0] as string] = { value: JSON.parse(params[1] as string), updated_at: new Date() };
      return rows([]);
    }
    if (sql.includes('UPDATE email_accounts')) {
      f.updates.push(params);
      return rows([]);
    }
    if (sql.includes('SELECT id FROM email_accounts')) return rows(f.active.map(id => ({ id })));
    if (sql.includes('broadcast_hourly_limit') && sql.includes('FROM email_accounts')) return rows(f.accounts);
    if (sql.includes("event_type = 'unsubscribe'")) return rows(f.unsubs[win]);
    if (sql.includes('FROM email_sends')) return rows(f.sends[win]);
    return rows([]);
  });
}

function baseFake(): Fake {
  const a = acct();
  return {
    accounts: [a], active: [a.id],
    sends: { '7d': [], '24h': [] },
    unsubs: { '7d': [], '24h': [] },
    settings: {}, updates: [],
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
  delete process.env.CIRCUIT_BREAKER_BOUNCE_RATE;
});
afterEach(() => { delete process.env.CIRCUIT_BREAKER_ENABLED; });

describe('classification', () => {
  it('treats send-gate policy refusals as policy blocks, not infra', () => {
    for (const m of ['Contact on hold', 'Permanently suppressed', 'Unsubscribed', 'Contact is a lender',
      'Enrollment cancelled', 'Sender x@tp.finance is not on go.tp.finance', 'superseded (stale queued)',
      'Email account inactive', 'Suppressed - bounce']) {
      expect(isPolicyBlock(m)).toBe(true);
    }
  });
  it('treats Gmail/API errors and empty messages as infra', () => {
    for (const m of ['Internal error encountered.', 'invalid_grant', 'Mail service not enabled', '', null, 'unknown outcome (crash)']) {
      expect(isPolicyBlock(m)).toBe(false);
    }
  });
  it('detects auth errors', () => {
    expect(isAuthError('invalid_grant')).toBe(true);
    expect(isAuthError('Invalid Credentials')).toBe(true);
    expect(isAuthError('Contact on hold')).toBe(false);
  });
});

describe('checkRates', () => {
  const base = { scope: 'account' as const, accountId: 'x', accountEmail: 'x', window: '7d' as const };
  it('ignores rates below the minimum sample', () => {
    expect(checkRates(ws({ sent: 10, bounced: 9 }), DEFAULT_THRESHOLDS, base)).toEqual([]);
  });
  it('trips bounce > 2%', () => {
    const t = checkRates(ws({ sent: 97, bounced: 3 }), DEFAULT_THRESHOLDS, base);
    expect(t.map(x => x.metric)).toEqual(['bounce_rate']);
  });
  it('does not trip at exactly 2% bounce', () => {
    expect(checkRates(ws({ sent: 98, bounced: 2 }), DEFAULT_THRESHOLDS, base)).toEqual([]);
  });
  it('trips unsubscribe > 1%', () => {
    const t = checkRates(ws({ sent: 100, unsubscribed: 2 }), DEFAULT_THRESHOLDS, base);
    expect(t.map(x => x.metric)).toEqual(['unsubscribe_rate']);
  });
  it('trips infra failure > 5% of attempts', () => {
    const t = checkRates(ws({ sent: 90, infraFailed: 10 }), DEFAULT_THRESHOLDS, base);
    expect(t.map(x => x.metric)).toEqual(['infra_failure_rate']);
  });
});

describe('decideTrips', () => {
  it('trips an account on any auth error, regardless of sample', () => {
    const a = acct();
    const trips = decideTrips([a], { [a.id]: { '7d': ws(), '24h': ws({ authErrors: 1 }) } },
      { '7d': ws(), '24h': ws() }, DEFAULT_THRESHOLDS);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ scope: 'account', metric: 'auth_error', accountId: a.id });
  });
  it('flags overall trips', () => {
    const trips = decideTrips([], {}, { '7d': ws({ sent: 50, bounced: 5 }), '24h': ws() }, DEFAULT_THRESHOLDS);
    expect(trips[0]).toMatchObject({ scope: 'overall', metric: 'bounce_rate', window: '7d' });
  });
});

describe('thresholds/config', () => {
  it('is enabled unless explicitly false', () => {
    expect(isCircuitBreakerEnabled()).toBe(true);
    process.env.CIRCUIT_BREAKER_ENABLED = 'false';
    expect(isCircuitBreakerEnabled()).toBe(false);
  });
  it('env overrides defaults, settings override env', async () => {
    process.env.CIRCUIT_BREAKER_BOUNCE_RATE = '0.03';
    mockQuery.mockResolvedValueOnce({ rows: [{ key: 'circuit_breaker_unsubscribe_rate', value: 0.005 }] });
    const t = await getThresholds();
    expect(t.bounceRate).toBe(0.03);
    expect(t.unsubscribeRate).toBe(0.005);
    expect(t.minSample).toBe(20);
  });
});

describe('evaluate', () => {
  it('does nothing when disabled', async () => {
    process.env.CIRCUIT_BREAKER_ENABLED = 'false';
    const f = baseFake(); installFakeDb(f);
    const alert = vi.fn();
    const r = await evaluate({ sendAlert: alert });
    expect(r.enabled).toBe(false);
    expect(f.updates).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it('no trips on healthy stats: no writes, no alert', async () => {
    const f = baseFake();
    f.sends['7d'] = [{ email_account_id: f.accounts[0].id, status: 'sent', error_message: null, n: '100' }];
    installFakeDb(f);
    const alert = vi.fn();
    const r = await evaluate({ sendAlert: alert });
    expect(r.trips).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(Object.keys(f.settings)).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it('policy blocks do not count as infra failures', async () => {
    const f = baseFake();
    const id = f.accounts[0].id;
    f.sends['7d'] = [
      { email_account_id: id, status: 'sent', error_message: null, n: '30' },
      { email_account_id: id, status: 'failed', error_message: 'Contact on hold', n: '40' },
    ];
    installFakeDb(f);
    const r = await evaluate({ sendAlert: vi.fn() });
    expect(r.trips).toEqual([]);
  });

  it('trips an account on invalid_grant: zeroes limits, saves previous, alerts', async () => {
    const f = baseFake();
    const id = f.accounts[0].id;
    f.sends['24h'] = [{ email_account_id: id, status: 'failed', error_message: 'invalid_grant', n: '1' }];
    installFakeDb(f);
    const alert = vi.fn().mockResolvedValue(undefined);
    const r = await evaluate({ sendAlert: alert });

    expect(r.accountsZeroed).toEqual(['a@go.tp.finance']);
    expect(f.updates).toHaveLength(1);
    expect(f.settings[`circuit_breaker_prev_limits:${id}`].value).toMatchObject({ daily_limit: 20, hourly_limit: 4 });
    expect(f.settings.circuit_breaker_last_trip.value).toMatchObject({ scope: id });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toContain('CIRCUIT BREAKER');
    // The account with the auth error is excluded as the alert sender
    expect(alert.mock.calls[0][2]).toEqual([id]);
  });

  it('is idempotent: second run within 24h does not re-alert or overwrite previous limits', async () => {
    const f = baseFake();
    const id = f.accounts[0].id;
    f.sends['24h'] = [{ email_account_id: id, status: 'failed', error_message: 'invalid_grant', n: '1' }];
    installFakeDb(f);
    const alert = vi.fn().mockResolvedValue(undefined);
    const t0 = new Date('2026-10-05T10:00:00Z');
    await evaluate({ sendAlert: alert, now: t0 });

    // Account is now at 0 limits
    f.accounts = [{ ...f.accounts[0], daily_limit: 0, hourly_limit: 0, broadcast_hourly_limit: 0 }];
    await evaluate({ sendAlert: alert, now: new Date(t0.getTime() + 15 * 60000) });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(f.updates).toHaveLength(1);
    expect(f.settings[`circuit_breaker_prev_limits:${id}`].value).toMatchObject({ daily_limit: 20 });

    // After 24h, the still-present trip is re-alerted once
    await evaluate({ sendAlert: alert, now: new Date(t0.getTime() + 25 * 3600000) });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(f.updates).toHaveLength(1);
  });

  it('overall trip zeroes every tp account, only ever setting 0', async () => {
    const f = baseFake();
    const a2 = acct({ id: '00000000-0000-0000-0000-000000000002', email: 'b@go.tp.finance', daily_limit: 10, hourly_limit: 2 });
    const inactive = acct({ id: '00000000-0000-0000-0000-000000000003', email: 'c@go.tp.finance', daily_limit: 5, hourly_limit: 1 });
    f.accounts = [f.accounts[0], a2, inactive];
    f.active = [f.accounts[0].id, a2.id];
    // Each account individually below min sample, overall over it with 10% bounce
    f.sends['7d'] = [
      { email_account_id: f.accounts[0].id, status: 'sent', error_message: null, n: '9' },
      { email_account_id: f.accounts[0].id, status: 'bounced', error_message: null, n: '1' },
      { email_account_id: a2.id, status: 'sent', error_message: null, n: '9' },
      { email_account_id: a2.id, status: 'bounced', error_message: null, n: '1' },
    ];
    installFakeDb(f);
    const alert = vi.fn().mockResolvedValue(undefined);
    const r = await evaluate({ sendAlert: alert });
    expect(r.trips.every(t => t.scope === 'overall')).toBe(true);
    expect(r.accountsZeroed.sort()).toEqual(['a@go.tp.finance', 'b@go.tp.finance', 'c@go.tp.finance']);
    for (const u of f.updates) expect(u).toHaveLength(2); // (id, tenant): limits are literal 0 in SQL
    expect(alert).toHaveBeenCalledTimes(1);
    expect(f.settings['circuit_breaker_last_alert:overall']).toBeDefined();
  });

  it('retries the alert next run if sending failed', async () => {
    const f = baseFake();
    const id = f.accounts[0].id;
    f.sends['24h'] = [{ email_account_id: id, status: 'failed', error_message: 'invalid_grant', n: '1' }];
    installFakeDb(f);
    const alert = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    await evaluate({ sendAlert: alert });
    f.accounts = [{ ...f.accounts[0], daily_limit: 0, hourly_limit: 0, broadcast_hourly_limit: 0 }];
    await evaluate({ sendAlert: alert });
    expect(alert).toHaveBeenCalledTimes(2);
  });
});
