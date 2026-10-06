/**
 * Requirement 10: outreach circuit breaker (src/services/circuit-breaker.ts),
 * evaluated against real rows in the test DB with the real alert path (Gmail
 * seam -> FakeGmail). Alerts are internal mail sent via the Gmail API (not the
 * outreach send path), so they are captured in fakeGmail.sent, not test_outbox.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll, createAccount, fakeGmail, outbox,
  createContact, createSequence, enroll, runPlannerPass, drainSendQueue,
} from '../factories';
import { query } from '../../../src/db/connection';
import { evaluate } from '../../../src/services/circuit-breaker';
import { T0, COLD_A, COLD_B, account, getSetting, seedOutcomes, setSetting } from './helpers';

const LIMITS = { daily: 120, hourly: 12 };

function alertsTo(email: string) {
  return fakeGmail.sent.filter(m => (m.headers.To || '').toLowerCase() === email);
}

afterAll(async () => { await closeAll(); });

describe('circuit breaker: trips', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('bounce rate > 2% with sample >= 20: limits zeroed, previous limits stored, one alert to marcus@, not repeated', async () => {
    const bad = await createAccount({ email: COLD_A, limits: LIMITS });
    const good = await createAccount({ email: COLD_B, limits: LIMITS });
    await seedOutcomes(bad.id, COLD_A, { sent: 30, bounced: 1 });   // 1/31 = 3.2%
    await seedOutcomes(good.id, COLD_B, { sent: 100 });             // overall 1/131 = 0.8%

    const r1 = await evaluate();
    expect(r1.trips.map(t => [t.accountEmail, t.metric])).toContainEqual([COLD_A, 'bounce_rate']);
    const acc = await account(bad.id);
    expect([acc.daily_limit, acc.hourly_limit, acc.broadcast_hourly_limit]).toEqual([0, 0, 0]);
    expect(await getSetting(`circuit_breaker_prev_limits:${bad.id}`)).toMatchObject({ daily_limit: 120, hourly_limit: 12 });
    const g = await account(good.id);
    expect([g.daily_limit, g.hourly_limit]).toEqual([120, 12]);

    expect(alertsTo('marcus@tp.finance')).toHaveLength(1);
    expect(alertsTo('marcus@tp.finance')[0].headers.Subject).toMatch(/CIRCUIT BREAKER TRIPPED/);
    expect(await outbox()).toHaveLength(0); // the alert never goes through the outreach path

    const r2 = await evaluate();
    expect(r2.alertsSent).toEqual([]);
    expect(alertsTo('marcus@tp.finance')).toHaveLength(1);
  });

  it('unsubscribe rate > 1% with sample >= 20 trips the account', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    await createAccount({ email: COLD_B, limits: LIMITS });
    await seedOutcomes(a.id, COLD_A, { sent: 50, unsubscribes: 1 }); // 2%
    const r = await evaluate();
    expect(r.trips.map(t => t.metric)).toContain('unsubscribe_rate');
    expect((await account(a.id)).daily_limit).toBe(0);
  });

  it('infrastructure failure rate > 5% with sample >= 20 trips the account', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    await createAccount({ email: COLD_B, limits: LIMITS });
    await seedOutcomes(a.id, COLD_A, { sent: 19, failed: ['socket hang up', 'Gmail API 500'] }); // 2/21 = 9.5%
    const r = await evaluate();
    expect(r.trips.map(t => t.metric)).toContain('infra_failure_rate');
    expect((await account(a.id)).hourly_limit).toBe(0);
  });

  it('policy refusals (suppressed, hold, outside window) are not counted as infrastructure failures', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    await seedOutcomes(a.id, COLD_A, {
      sent: 19,
      failed: ['Permanently suppressed', 'Contact on hold', 'Outside send window (Mon-Fri 08:00-17:00 Europe/London)', 'Enrollment cancelled', 'superseded (stale queued)'],
    });
    const r = await evaluate();
    expect(r.trips).toEqual([]);
    expect((await account(a.id)).daily_limit).toBe(120);
  });

  it('below the minimum sample (bad rates on < 20 sends) does not trip', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    await seedOutcomes(a.id, COLD_A, { sent: 10, bounced: 5, unsubscribes: 3, failed: ['socket hang up'] }); // 15 delivered, 16 attempted
    const r = await evaluate();
    expect(r.trips).toEqual([]);
    expect((await account(a.id)).daily_limit).toBe(120);
    expect(fakeGmail.sent).toHaveLength(0);
  });

  it('an invalid_grant error trips only that account; the alert is sent from a healthy account', async () => {
    const broken = await createAccount({ email: COLD_A, limits: LIMITS });
    const healthy = await createAccount({ email: COLD_B, limits: LIMITS });
    await seedOutcomes(broken.id, COLD_A, { failed: ['invalid_grant'] });
    const r = await evaluate();
    expect(r.trips.map(t => [t.accountEmail, t.metric])).toEqual([[COLD_A, 'auth_error']]);
    expect((await account(broken.id)).daily_limit).toBe(0);
    expect((await account(healthy.id)).daily_limit).toBe(120);
    expect(alertsTo('marcus@tp.finance')).toHaveLength(1);
    expect(alertsTo('marcus@tp.finance')[0].mailbox).toBe(COLD_B);
  });

  it('a tripped account stops sending: queued sequence sends are not delivered after the trip', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    await createAccount({ email: COLD_B, limits: { daily: 0, hourly: 0 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enroll(seq.id, (await createContact({ email: 'cb@example-dev.test' })).id);
    await runPlannerPass();
    await seedOutcomes(a.id, COLD_A, { failed: ['invalid_grant'] });
    await evaluate();
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });
});

describe('circuit breaker: never raises limits', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('a second trip on an already-zeroed account keeps the original saved limits (never overwrites them with 0)', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    await createAccount({ email: COLD_B, limits: LIMITS });
    await seedOutcomes(a.id, COLD_A, { failed: ['invalid_grant'] });
    await evaluate();
    setClock(new Date(T0.getTime() + 25 * 3600000)); // past the 24h alert interval
    await evaluate();
    expect(await getSetting(`circuit_breaker_prev_limits:${a.id}`)).toMatchObject({ daily_limit: 120, hourly_limit: 12 });
    const acc = await account(a.id);
    expect([acc.daily_limit, acc.hourly_limit]).toEqual([0, 0]);
  });

  it('a healthy evaluation never raises a manually lowered or zeroed limit', async () => {
    const low = await createAccount({ email: COLD_A, limits: { daily: 5, hourly: 1 } });
    const zero = await createAccount({ email: COLD_B, limits: { daily: 0, hourly: 0 } });
    await setSetting(`circuit_breaker_prev_limits:${zero.id}`, { daily_limit: 500, hourly_limit: 50 });
    await seedOutcomes(low.id, COLD_A, { sent: 40 });
    const r = await evaluate();
    expect(r.trips).toEqual([]);
    expect((await account(low.id)).daily_limit).toBe(5);
    const z = await account(zero.id);
    expect([z.daily_limit, z.hourly_limit]).toEqual([0, 0]);
  });

  it('every limit after evaluation is <= its value before (across a mixed set of trips)', async () => {
    const a = await createAccount({ email: COLD_A, limits: LIMITS });
    const b = await createAccount({ email: COLD_B, limits: { daily: 7, hourly: 2 } });
    await seedOutcomes(a.id, COLD_A, { sent: 30, bounced: 3 });
    await seedOutcomes(b.id, COLD_B, { sent: 5 });
    const before = (await query<{ id: string; daily_limit: number; hourly_limit: number; broadcast_hourly_limit: number }>(`SELECT id, daily_limit, hourly_limit, broadcast_hourly_limit FROM email_accounts`)).rows;
    await evaluate();
    for (const prev of before) {
      const now = await account(prev.id);
      expect(now.daily_limit).toBeLessThanOrEqual(prev.daily_limit);
      expect(now.hourly_limit).toBeLessThanOrEqual(prev.hourly_limit);
      expect(now.broadcast_hourly_limit).toBeLessThanOrEqual(prev.broadcast_hourly_limit);
    }
  });
});
