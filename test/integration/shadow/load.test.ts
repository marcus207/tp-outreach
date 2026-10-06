/**
 * LOAD test (lane: shadow). 15,000 synthetic contacts, 18 sequences, two
 * go.tp.finance accounts at warm-up limits + one root tp.finance account with
 * high limits. Drives the real planner + send path hour by hour through a
 * simulated week (Sat 10 Oct 00:00 -> Sat 17 Oct 12:00 Europe/London), with the
 * lane DB's NOW() following the simulated clock (see sim.ts).
 *
 * Run:
 *   cd /root/tp-outreach && TEST_LANE=shadow npx vitest run -c vitest.integration.config.ts test/integration/shadow
 *
 * Safety invariants are hard assertions. Performance budgets (planner < 5 s,
 * gate < 50 ms) are expect.soft so every invariant is still evaluated and the
 * timings land in test/reports/load-<date>.json either way.
 */
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { query } from '../../../src/db/connection';
import { resetAll, installFakeGmail, closeAll, setClock, restoreClock } from '../factories';
import { installSimDbClock, setSimTime, assertSimClockWorks, simulate, newStats, pct, SimStats, assertShadowDb } from './sim';
import { seedLoadDataset, LoadSeed } from './load-seed';

const SIM_FROM = new Date('2026-10-09T23:00:00Z'); // Sat 10 Oct 00:00 BST
const SIM_TO = new Date('2026-10-17T11:00:00Z');   // Sat 17 Oct 12:00 BST
const REPORT_DIR = path.resolve(__dirname, '../../reports');
const jsClock = (d: Date) => { vi.setSystemTime(d); };

interface Invariants {
  totalSends: number;
  perDay: Array<{ day: string; sends: number; budget: number }>;
  perDayAccountOver: number;
  perHourAccountOver: number;
  maxPerHourAccount: number;
  toLenders: number; toSuppressed: number; toHold: number; toUnsubscribed: number; toLoanIntel: number;
  fromRoot: number; fromNonGo: number;
  weekendOrOutOfWindow: number;
  duplicateStepSends: number;
  emptyGreeting: number; leftoverMerge: number;
}

async function invariants(limits: { daily: number; hourly: number }, goAccounts: number): Promise<Invariants> {
  const one = async (sql: string) => Number((await query<{ n: string }>(sql)).rows[0].n);
  const sends = `email_sends es WHERE es.status = 'sent' AND es.subject <> 'historical'`;
  const perDay = (await query<{ day: string; sends: string }>(
    `SELECT to_char(es.sent_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD Dy') AS day, COUNT(*)::text AS sends
     FROM ${sends} GROUP BY 1 ORDER BY 1`)).rows.map(r => ({ day: r.day, sends: Number(r.sends), budget: limits.daily * goAccounts }));
  const perHour = await query<{ n: string }>(
    `SELECT COALESCE(MAX(c), 0)::text AS n FROM (
       SELECT COUNT(*) AS c FROM ${sends}
       GROUP BY es.email_account_id, date_trunc('hour', es.sent_at AT TIME ZONE 'Europe/London')) x`);
  const joinC = `FROM test_outbox o JOIN contacts c ON LOWER(c.email) = LOWER(o.to_email)`;
  return {
    totalSends: await one(`SELECT COUNT(*)::text AS n FROM ${sends}`),
    perDay,
    perDayAccountOver: await one(`SELECT COUNT(*)::text AS n FROM (
        SELECT 1 FROM ${sends} GROUP BY es.email_account_id, (es.sent_at AT TIME ZONE 'Europe/London')::date
        HAVING COUNT(*) > ${limits.daily}) x`),
    perHourAccountOver: await one(`SELECT COUNT(*)::text AS n FROM (
        SELECT 1 FROM ${sends} GROUP BY es.email_account_id, date_trunc('hour', es.sent_at AT TIME ZONE 'Europe/London')
        HAVING COUNT(*) > ${limits.hourly}) x`),
    maxPerHourAccount: Number(perHour.rows[0].n),
    toLenders: await one(`SELECT COUNT(*)::text AS n ${joinC} WHERE c.contact_type = 'lender'`),
    toSuppressed: await one(`SELECT COUNT(*)::text AS n FROM test_outbox o WHERE EXISTS (
        SELECT 1 FROM suppressed_emails s WHERE LOWER(s.email) = LOWER(o.to_email)
           OR (s.source = 'manual' AND s.domain IS NOT NULL AND LOWER(s.domain) = split_part(LOWER(o.to_email), '@', 2)))`),
    toHold: await one(`SELECT COUNT(*)::text AS n ${joinC} WHERE 'hold' = ANY(c.tags)`),
    toUnsubscribed: await one(`SELECT COUNT(*)::text AS n ${joinC} WHERE 'unsubscribed' = ANY(c.tags) OR 'bounced' = ANY(c.tags)`),
    toLoanIntel: await one(`SELECT COUNT(*)::text AS n ${joinC} WHERE c.tenant <> 'tp'`),
    fromRoot: await one(`SELECT COUNT(*)::text AS n FROM test_outbox WHERE LOWER(from_email) = 'marcus@tp.finance'`),
    fromNonGo: await one(`SELECT COUNT(*)::text AS n FROM test_outbox WHERE LOWER(from_email) NOT LIKE '%@go.tp.finance'`),
    weekendOrOutOfWindow: await one(`SELECT COUNT(*)::text AS n FROM ${sends} AND (
        EXTRACT(ISODOW FROM es.sent_at AT TIME ZONE 'Europe/London') IN (6, 7)
        OR EXTRACT(HOUR FROM es.sent_at AT TIME ZONE 'Europe/London') < 8
        OR EXTRACT(HOUR FROM es.sent_at AT TIME ZONE 'Europe/London') >= 17)`),
    duplicateStepSends: await one(`SELECT COUNT(*)::text AS n FROM (
        SELECT 1 FROM email_sends WHERE status = 'sent' GROUP BY enrollment_id, sequence_step_id HAVING COUNT(*) > 1) x`),
    emptyGreeting: await one(`SELECT COUNT(*)::text AS n FROM test_outbox WHERE html_body ~ '(Hi|Hey|Hello|Dear) ,'`),
    leftoverMerge: await one(`SELECT COUNT(*)::text AS n FROM test_outbox WHERE subject LIKE '%{{%' OR html_body LIKE '%{{%'`),
  };
}

function timingSummary(stats: SimStats) {
  const p = stats.plannerPasses.map(x => x.ms);
  return {
    plannerPasses: p.length,
    plannerMsMax: Math.round(Math.max(0, ...p)),
    plannerMsP50: Math.round(pct(p, 50)),
    plannerMsFirst: Math.round(p[0] || 0),
    gateCalls: stats.gateMs.length,
    gateMsMax: +Math.max(0, ...stats.gateMs).toFixed(2),
    gateMsP50: +pct(stats.gateMs, 50).toFixed(2),
    gateMsP99: +pct(stats.gateMs, 99).toFixed(2),
    maxQueuedRows: stats.maxQueuedRows,
    maxRedisJobs: stats.maxRedisJobs,
    totalPlanned: stats.plannerPasses.reduce((s, x) => s + x.planned, 0),
    firstPass: stats.plannerPasses[0],
  };
}

const results: Record<string, unknown> = {};

async function runScenario(name: string, limits: { daily: number; hourly: number }) {
  await resetAll();
  installFakeGmail();
  await installSimDbClock();
  await setSimTime(SIM_FROM, jsClock);
  await assertSimClockWorks();

  const tSeed = performance.now();
  const seed: LoadSeed = await seedLoadDataset({ simStart: SIM_FROM, goLimits: limits });
  const counts = (await query<{ k: string; n: string }>(
    `SELECT 'contacts' AS k, COUNT(*)::text AS n FROM contacts UNION ALL
     SELECT 'enrollments', COUNT(*)::text FROM sequence_enrollments UNION ALL
     SELECT 'due_at_start', COUNT(*)::text FROM sequence_enrollments WHERE next_step_due_at <= NOW()`)).rows;

  const stats = newStats();
  const budget = limits.daily * 2;
  let worstQueuedAtHourEnd = 0;
  await simulate({
    from: SIM_FROM, to: SIM_TO, setJsClock: jsClock, stats, quiet: true,
    onHourEnd: async () => {
      const q = stats.hourly[stats.hourly.length - 1];
      worstQueuedAtHourEnd = Math.max(worstQueuedAtHourEnd, q.queuedRows);
    },
  });

  const inv = await invariants(limits, 2);
  const timing = timingSummary(stats);
  const endQueued = Number((await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM email_sends WHERE status = 'queued'`)).rows[0].n);
  const statusMix = (await query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM sequence_enrollments GROUP BY 1 ORDER BY 1`)).rows;
  const failReasons = (await query<{ error_message: string; n: string }>(
    `SELECT error_message, COUNT(*)::text AS n FROM email_sends WHERE status = 'failed' GROUP BY 1 ORDER BY 2 DESC`)).rows;
  results[name] = { limits, scenarioMs: Math.round(performance.now() - tSeed), counts, invariants: inv, timing, endQueued, statusMix, failReasons, seed: { sequences: seed.sequenceIds.length } };
  return { inv, timing, budget, endQueued, stats };
}

function assertInvariants(r: Awaited<ReturnType<typeof runScenario>>, limits: { daily: number; hourly: number }) {
  const { inv, timing, budget, endQueued } = r;
  expect(inv.totalSends).toBeGreaterThan(0);
  for (const d of inv.perDay) expect(d.sends, `day ${d.day}`).toBeLessThanOrEqual(budget);
  expect(inv.perDayAccountOver).toBe(0);
  expect(inv.perHourAccountOver).toBe(0);
  expect(inv.maxPerHourAccount).toBeLessThanOrEqual(limits.hourly);
  expect(inv.toLenders).toBe(0);
  expect(inv.toSuppressed).toBe(0);
  expect(inv.toHold).toBe(0);
  expect(inv.toUnsubscribed).toBe(0);
  expect(inv.toLoanIntel).toBe(0);
  expect(inv.fromRoot).toBe(0);
  expect(inv.fromNonGo).toBe(0);
  expect(inv.weekendOrOutOfWindow).toBe(0);
  expect(inv.duplicateStepSends).toBe(0);
  expect(inv.leftoverMerge).toBe(0);
  // Unbounded growth: queued rows never exceed one day's budget, and the week
  // ends with at most one hour's worth in flight.
  expect(timing.maxQueuedRows).toBeLessThanOrEqual(budget);
  expect(timing.maxRedisJobs).toBeLessThanOrEqual(budget);
  expect(endQueued).toBeLessThanOrEqual(limits.hourly * 2);
  // Performance budgets (soft: reported, do not mask the safety results)
  expect.soft(timing.plannerMsMax, 'planner pass < 5 s').toBeLessThan(5000);
  expect.soft(timing.gateMsMax, 'gate per send < 50 ms (max)').toBeLessThan(50);
}

describe.skipIf(process.env.TEST_LANE !== 'shadow')('shadow lane: load test (15k contacts, simulated Mon-Fri week)', () => {
  beforeAll(() => {
    assertShadowDb();
    setClock(SIM_FROM);
  });

  afterAll(async () => {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    restoreClock(); // real date for the file name
    const day = new Date().toISOString().slice(0, 10);
    const out = path.join(REPORT_DIR, `load-${day}.json`);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.info(`[shadow load] results -> ${out}`);
    await closeAll();
  });

  it('warm-up limits (10/day, 2/hr per go account): all invariants hold', async () => {
    const limits = { daily: 10, hourly: 2 };
    const r = await runScenario('warmup_10_2', limits);
    console.info('[shadow load] warmup', JSON.stringify({ inv: r.inv, timing: r.timing }));
    assertInvariants(r, limits);
    // 5 weekdays x 2 accounts x 10/day; the dataset has far more due than budget
    expect.soft(r.inv.totalSends, 'warm-up budget fully used').toBe(100);
  }, 3_600_000);

  it('ramp limits (50/day, 10/hr per go account): same invariants', async () => {
    const limits = { daily: 50, hourly: 10 };
    const r = await runScenario('ramp_50_10', limits);
    console.info('[shadow load] ramp', JSON.stringify({ inv: r.inv, timing: r.timing }));
    assertInvariants(r, limits);
    expect.soft(r.inv.totalSends, 'ramp budget fully used').toBe(500);
  }, 3_600_000);
});
