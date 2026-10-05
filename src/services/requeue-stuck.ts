/**
 * Re-queue stuck email sends whose BullMQ jobs were lost.
 *
 * Extracted from worker.ts for testability. Called by the cron job in
 * worker.ts (currently every 3 minutes).
 *
 * Key rules:
 *   - Only runs inside the send window (Mon-Fri 08:00-17:00 Europe/London)
 *   - A queued row is only "stuck" once its scheduled fire time
 *     (last_enqueued_at = enqueue time + delay) is > 30 min in the past AND it
 *     has no job in Redis
 *   - Re-queued sends are spaced by max(send_gap_minutes, 2-5 min random)
 *   - Re-queued jobs carry the full payload (threadId, fromName) like the planner
 *   - 'sending' rows (claimed, Gmail call in flight) are never re-sent. Rows
 *     stuck 'sending' > 1 hour are a crash with unknown outcome: marked failed
 *     and the enrollment moves on to the next step (no duplicate)
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { canSend, isWithinSendWindow, msUntilSendWindowCloses } from './send-gate';
import { dailyPlanner, buildSendJobData } from './daily-planner';

const MIN_SPACING_MS = 2 * 60 * 1000;
const MAX_SPACING_MS = 5 * 60 * 1000;

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

interface StuckSendRow {
  id: string;
  enrollment_id: string | null;
  display_name: string | null;
  thread_id: string | null;
}

/** Rows claimed 'sending' > 1h ago: crashed mid-send, outcome unknown. Never re-send. */
async function resolveCrashedSends(): Promise<void> {
  const crashed = await query<{ id: string; enrollment_id: string | null }>(
    `UPDATE email_sends SET status = 'failed', error_message = 'unknown outcome (crash)'
     WHERE tenant = $1 AND status = 'sending'
       AND COALESCE(last_enqueued_at, created_at) < NOW() - INTERVAL '1 hour'
     RETURNING id, enrollment_id`,
    [TENANT]
  );
  for (const row of crashed.rows || []) {
    console.warn(`[Re-Queue] ${row.id} stuck 'sending' > 1h, marked failed (unknown outcome)`);
    if (!row.enrollment_id) continue;
    try {
      // Probably delivered — advance rather than risk a duplicate
      await dailyPlanner.scheduleNextStep(row.id);
    } catch (err) {
      console.error(`[Re-Queue] Error advancing enrollment for crashed send ${row.id}:`, (err as Error).message);
    }
  }
}

export async function requeueStuckSends(): Promise<number> {
  if (!isWithinSendWindow(new Date())) {
    return 0;
  }

  await resolveCrashedSends();

  // Find email_sends that are 'queued' and whose Bull job is likely lost.
  // Skip broadcast emails — those are managed by broadcast-planner.ts.
  // last_enqueued_at is the scheduled fire time; only rows > 30 min past it
  // (or never enqueued and > 30 min old) are candidates.
  const result = await query<StuckSendRow>(
    `SELECT es.id, es.enrollment_id, ea.display_name,
            (SELECT p.gmail_thread_id FROM email_sends p
             WHERE es.enrollment_id IS NOT NULL AND p.enrollment_id = es.enrollment_id
               AND p.gmail_thread_id IS NOT NULL AND p.tenant = es.tenant
             ORDER BY p.created_at ASC LIMIT 1) AS thread_id
     FROM email_sends es
     LEFT JOIN email_accounts ea ON ea.id = es.email_account_id
     WHERE es.tenant = $1
       AND es.status = 'queued'
       AND es.gmail_message_id IS NULL
       AND es.broadcast_id IS NULL
       AND COALESCE(es.last_enqueued_at, es.created_at) < NOW() - INTERVAL '30 minutes'
     ORDER BY es.created_at ASC`,
    [TENANT]
  );

  if (result.rows.length === 0) return 0;

  const sq = new Queue('email-sends', { connection: getRedisConnection(), prefix: BULL_PREFIX, defaultJobOptions: { removeOnComplete: 200, removeOnFail: 100 } });

  let requeued = 0;
  try {
    // Sends that still have a live job in Redis are not stuck
    const inRedis = new Set<string>();
    const jobs = await sq.getJobs(['delayed', 'waiting', 'active', 'paused', 'prioritized']);
    for (const job of jobs || []) {
      const id = job?.data?.emailSendId;
      if (id) inRedis.add(String(id));
    }

    const gapResult = await query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'send_gap_minutes'`
    );
    const gapMs = (Number(gapResult.rows[0]?.value) || 0) * 60 * 1000;
    const windowRemainingMs = msUntilSendWindowCloses(new Date());

    let delay = 0;
    for (const send of result.rows) {
      if (inRedis.has(send.id)) continue;

      const decision = await canSend(send.id, { checkWindow: false });

      if (decision.action === 'fail') {
        await query(
          `UPDATE email_sends SET status = 'failed', error_message = $1
           WHERE id = $2 AND tenant = $3 AND status = 'queued'`,
          [decision.reason, send.id, TENANT]
        );
        try {
          await dailyPlanner.handleFailedSend(send.id, decision.reason, decision.permanent === true);
        } catch (err) {
          console.error(`[Re-Queue] Error updating enrollment for ${send.id}:`, (err as Error).message);
        }
        continue;
      }

      if (decision.action === 'skip') {
        continue;
      }

      // Space jobs out: first one after a short random delay, then
      // max(send gap, 2-5 min random) between each
      const spacing = Math.max(gapMs, MIN_SPACING_MS + Math.floor(Math.random() * (MAX_SPACING_MS - MIN_SPACING_MS)));
      delay += requeued === 0 ? Math.floor(Math.random() * 60000) + 30000 : spacing;
      if (delay >= windowRemainingMs) break; // rest waits for the next window

      await sq.add('send-email', buildSendJobData(send.id, send.thread_id, send.display_name), { delay });
      await query(
        `UPDATE email_sends SET last_enqueued_at = NOW() + ($1::int * INTERVAL '1 millisecond') WHERE id = $2`,
        [delay, send.id]
      );
      requeued++;
    }
  } finally {
    await sq.close();
  }

  if (requeued > 0) {
    console.log(`[Re-Queue] Re-queued ${requeued} stuck email sends`);
  }
  return requeued;
}
