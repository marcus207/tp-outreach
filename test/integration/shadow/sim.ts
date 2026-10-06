/**
 * Simulation driver for the `shadow` lane (load test + shadow run).
 *
 * Two clocks problem (see test/README.md): the harness can fake JS Date, but
 * Postgres NOW() is the real clock. For multi-day simulations that is not good
 * enough (planner due checks, sent_at, last_send_at, stale-queued windows all
 * use NOW()). This module makes the LANE DATABASE follow the simulated clock:
 *
 *   - public.sim_clock(t) holds the simulated instant.
 *   - public.now() returns sim_clock.t (falls back to pg_catalog.now()).
 *   - ALTER DATABASE <lane db> SET search_path = public, pg_catalog, so an
 *     unqualified NOW() in src/ SQL resolves to public.now() (pg_catalog only
 *     wins when it is NOT listed explicitly).
 *   - Every column DEFAULT now() is re-pointed to public.now() so created_at
 *     etc. are also simulated.
 *
 * Only ever applied to tpca_outreach_test_shadow (asserted). CURRENT_DATE /
 * CURRENT_TIMESTAMP stay real; src/ only uses CURRENT_DATE for the
 * daily_send_plans log row, which nothing here reads.
 *
 * The JS clock is injected (vitest uses vi.setSystemTime, the standalone
 * shadow-run script installs its own Date shim), so this file has no vitest
 * import.
 */
import { Client } from 'pg';
import { Queue } from 'bullmq';
import { performance } from 'perf_hooks';
import { pool, query, BULL_PREFIX } from '../../../src/db/connection';
import { getRedisConnection } from '../../../src/db/redis';
import { sendQueue, EmailSendJobData } from '../../../src/services/send-queue';
import { dailyPlanner } from '../../../src/services/daily-planner';
import { canSend, isWithinSendWindow } from '../../../src/services/send-gate';
import { gmailClient } from '../../../src/services/gmail-client';
import { requeueStuckSends } from '../../../src/services/requeue-stuck';

export const SHADOW_DB = 'tpca_outreach_test_shadow';

export function assertShadowDb(url = process.env.DATABASE_URL || ''): void {
  const name = (url.split('/').pop() || '').split('?')[0];
  if (name !== SHADOW_DB) throw new Error(`[shadow] REFUSING: target database is '${name}', must be ${SHADOW_DB}`);
}

// ── Simulated DB clock ─────────────────────────────────────────────────

export async function installSimDbClock(): Promise<void> {
  assertShadowDb();
  // Separate client so ALTER DATABASE happens before the shared pool opens
  // connections; the pool hook covers any connection opened earlier.
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const db = (await c.query('SELECT current_database() AS d')).rows[0].d;
    if (db !== SHADOW_DB) throw new Error(`[shadow] installSimDbClock refused: connected to ${db}`);
    await c.query(`ALTER DATABASE ${SHADOW_DB} SET search_path = public, pg_catalog`);
    await c.query(`CREATE TABLE IF NOT EXISTS public.sim_clock (id int PRIMARY KEY DEFAULT 1, t timestamptz)`);
    await c.query(`
      CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS
      $$ SELECT COALESCE((SELECT t FROM public.sim_clock WHERE id = 1), pg_catalog.now()) $$`);
    const cols = await c.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default ILIKE '%now()%' AND table_name <> 'sim_clock'`);
    for (const r of cols.rows) {
      await c.query(`ALTER TABLE public."${r.table_name}" ALTER COLUMN "${r.column_name}" SET DEFAULT public.now()`);
    }
  } finally {
    await c.end();
  }
  // Connections opened from now on pick up the ALTER DATABASE default. Idle
  // clients opened earlier (e.g. by resetAll) keep the old search_path: fix them.
  const open: Array<import('pg').PoolClient> = [];
  for (let i = 0; i < pool.idleCount; i++) open.push(await pool.connect());
  for (const cl of open) { await cl.query('SET search_path TO public, pg_catalog'); cl.release(); }
}

export async function setSimTime(at: Date, setJsClock: (d: Date) => void): Promise<void> {
  setJsClock(at);
  await query(
    `INSERT INTO public.sim_clock (id, t) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET t = EXCLUDED.t`, [at.toISOString()]);
}

export async function assertSimClockWorks(): Promise<void> {
  const r = await query<{ n: Date; t: Date }>(`SELECT NOW() AS n, (SELECT t FROM sim_clock WHERE id = 1) AS t`);
  if (!r.rows[0]?.t || new Date(r.rows[0].n).getTime() !== new Date(r.rows[0].t).getTime()) {
    throw new Error(`[shadow] sim clock not active: NOW()=${r.rows[0]?.n} sim=${r.rows[0]?.t}`);
  }
}

// ── London time helpers ────────────────────────────────────────────────

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', weekday: 'short', hourCycle: 'h23',
});
export function londonParts(d: Date) {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}

// ── Queue driver ───────────────────────────────────────────────────────

export interface SimStats {
  plannerPasses: Array<{ at: string; ms: number; planned: number; overflow: number; skipped: number; alreadySent: number }>;
  gateMs: number[];
  hourly: Array<{ at: string; queuedRows: number; redisJobs: number; sentSoFar: number }>;
  maxQueuedRows: number;
  maxRedisJobs: number;
  processed: number;
}

export function newStats(): SimStats {
  return { plannerPasses: [], gateMs: [], hourly: [], maxQueuedRows: 0, maxRedisJobs: 0, processed: 0 };
}

function sendsQueue(): Queue<EmailSendJobData> {
  return new Queue<EmailSendJobData>('email-sends', { connection: getRedisConnection(), prefix: BULL_PREFIX });
}

/** Process only the jobs whose fire time (timestamp + delay, both on the JS clock) has passed. */
async function drainDue(q: Queue<EmailSendJobData>, stats: SimStats): Promise<number> {
  const now = Date.now();
  const jobs = (await q.getJobs(['delayed', 'waiting', 'prioritized', 'paused']))
    .filter(j => j && j.timestamp + (j.opts.delay || 0) <= now)
    .sort((a, b) => (a.timestamp + (a.opts.delay || 0)) - (b.timestamp + (b.opts.delay || 0)));
  for (const job of jobs) {
    await job.remove();
    const t0 = performance.now();
    await canSend(job.data.emailSendId); // timed, read-only; processEmailSend re-runs it
    stats.gateMs.push(performance.now() - t0);
    await sendQueue.processEmailSend(job.data);
    stats.processed++;
  }
  return jobs.length;
}

export interface SimulateOptions {
  from: Date;           // inclusive, should be on an hour boundary
  to: Date;             // exclusive
  tickMinutes?: number; // JS/DB clock step inside each hour (default 5)
  setJsClock: (d: Date) => void;
  stats: SimStats;
  quiet?: boolean;      // silence console.log from src/ during the run
  onHourEnd?: (hourStart: Date) => Promise<void> | void;
}

/**
 * Mirrors the worker crons that matter for sequence sending:
 *   :00 resetHourlyCounts (00:00 UTC also resetDailyCounts)
 *   :05 dailyPlanner.plan()            (cron '5 * * * 1-5'; plan() gates on the window itself)
 *   every tick requeueStuckSends()     (cron is every 3 min)
 *   every tick: send every BullMQ job whose fire time has passed (worker)
 */
export async function simulate(o: SimulateOptions): Promise<void> {
  const tick = (o.tickMinutes ?? 5) * 60000;
  const q = sendsQueue();
  const origLog = console.log;
  if (o.quiet) console.log = () => undefined;
  try {
    for (let t = o.from.getTime(); t < o.to.getTime(); t += tick) {
      const at = new Date(t);
      await setSimTime(at, o.setJsClock);
      const m = at.getUTCMinutes();
      if (m === 0) {
        if (at.getUTCHours() === 0) await gmailClient.resetDailyCounts();
        await gmailClient.resetHourlyCounts();
      }
      if (m === 5 && at.getUTCDay() >= 1 && at.getUTCDay() <= 5) {
        const t0 = performance.now();
        const r = await dailyPlanner.plan();
        const ms = performance.now() - t0;
        if (isWithinSendWindow(at)) {
          o.stats.plannerPasses.push({ at: at.toISOString(), ms, planned: r.planned, overflow: r.overflow, skipped: r.skipped, alreadySent: r.alreadySent });
        }
      }
      await requeueStuckSends();
      await drainDue(q, o.stats);

      if ((t + tick) % 3600000 === 0) {
        const queued = Number((await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM email_sends WHERE status = 'queued'`)).rows[0].n);
        const sent = Number((await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM test_outbox`)).rows[0].n);
        const jobs = (await q.getJobs(['delayed', 'waiting', 'prioritized', 'paused'])).length;
        o.stats.hourly.push({ at: new Date(t + tick - 3600000).toISOString(), queuedRows: queued, redisJobs: jobs, sentSoFar: sent });
        o.stats.maxQueuedRows = Math.max(o.stats.maxQueuedRows, queued);
        o.stats.maxRedisJobs = Math.max(o.stats.maxRedisJobs, jobs);
        if (o.onHourEnd) await o.onHourEnd(new Date(t + tick - 3600000));
      }
    }
  } finally {
    console.log = origLog;
    await q.close();
  }
}

export function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
