/**
 * Re-queue stuck email sends whose BullMQ jobs were lost.
 *
 * Extracted from worker.ts for testability. Called by the cron job
 * every 30 minutes.
 *
 * Key rules:
 *   - Only runs during 09:00-17:00 UTC Mon-Fri (the send window)
 *   - Staggers re-queued sends ~4 minutes apart to avoid Gmail spam detection
 *   - Checks enrollment is still active before re-queuing
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { canSend } from './send-gate';

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

export async function requeueStuckSends(): Promise<number> {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const windowSettings = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN ('send_window_start', 'send_window_end', 'skip_weekends')`
  );
  const settingsMap: Record<string, string> = {};
  for (const s of windowSettings.rows) settingsMap[s.key] = s.value;

  const [startH, startM] = (settingsMap.send_window_start || '09:00').split(':').map(Number);
  const [endH, endM] = (settingsMap.send_window_end || '17:00').split(':').map(Number);
  const skipWeekends = settingsMap.skip_weekends !== 'false';
  const windowStart = startH * 60 + startM;
  const windowEnd = endH * 60 + endM;
  const isWeekend = skipWeekends && (dayOfWeek === 0 || dayOfWeek === 6);

  if (isWeekend || currentMinutes < windowStart || currentMinutes >= windowEnd) {
    return 0;
  }

  // Find email_sends that are 'queued' and whose Bull job is likely lost.
  // Skip broadcast emails — those are managed by broadcast-planner.ts.
  // Only pick up emails where last_enqueued_at is NULL (never queued to Bull)
  // or older than 30 minutes (Bull job was lost/expired).
  const result = await query<{ id: string }>(
    `SELECT es.id FROM email_sends es
     WHERE es.tenant = $1
       AND es.status = 'queued'
       AND es.gmail_message_id IS NULL
       AND es.broadcast_id IS NULL
       AND es.created_at < NOW() - INTERVAL '3 minutes'
       AND (es.last_enqueued_at IS NULL OR es.last_enqueued_at < NOW() - INTERVAL '30 minutes')`,
    [TENANT]
  );

  if (result.rows.length === 0) return 0;

  const sq = new Queue('email-sends', { connection: getRedisConnection(), prefix: BULL_PREFIX, defaultJobOptions: { removeOnComplete: 200, removeOnFail: 100 } });

  let requeued = 0;
  const ids: string[] = [];
  for (const send of result.rows) {
    const decision = await canSend(send.id, { checkWindow: false });

    if (decision.action === 'fail') {
      await query(
        `UPDATE email_sends SET status = 'failed', error_message = $1 WHERE id = $2`,
        [decision.reason, send.id]
      );
      continue;
    }

    if (decision.action === 'skip') {
      continue;
    }

    const delay = requeued * 1000 + Math.floor(Math.random() * 2000);
    await sq.add('send-email', { emailSendId: send.id }, { delay });
    ids.push(send.id);
    requeued++;
  }

  if (ids.length > 0) {
    await query(
      `UPDATE email_sends SET last_enqueued_at = NOW() WHERE id = ANY($1::uuid[])`,
      [ids]
    );
  }

  await sq.close();
  if (requeued > 0) {
    console.log(`[Re-Queue] Re-queued ${requeued} stuck email sends`);
  }
  return requeued;
}
