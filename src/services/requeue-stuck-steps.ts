import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

interface StuckEnrollment {
  id: string;
  current_step: number;
  updated_at: Date;
  next_delay_days: number;
  next_delay_hours: number;
}

export async function requeueStuckSteps(): Promise<number> {
  const sq = new Queue('sequence-steps', { connection: getRedisConnection(), prefix: BULL_PREFIX });

  try {
    const existingJobs = await sq.getJobs(['delayed', 'waiting', 'active']);
    const enrollmentsWithJobs = new Set(
      existingJobs.map(j => `${j.data.enrollmentId}:${j.data.stepNumber}`)
    );

    const result = await query<StuckEnrollment>(
      `SELECT se.id, se.current_step, se.updated_at,
              COALESCE(ns.delay_days, 0) as next_delay_days,
              COALESCE(ns.delay_hours, 0) as next_delay_hours
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       LEFT JOIN sequence_steps ns
         ON ns.sequence_id = se.sequence_id AND ns.step_number = se.current_step + 1
       WHERE se.tenant = $1
         AND se.status = 'active'
         AND s.status = 'active'
         AND ns.id IS NOT NULL
         AND se.updated_at < NOW() - INTERVAL '30 minutes'`,
      [TENANT]
    );

    let requeued = 0;
    for (const row of result.rows) {
      const nextStep = row.current_step + 1;
      const key = `${row.id}:${nextStep}`;

      if (enrollmentsWithJobs.has(key)) continue;

      const alreadySent = await query<{ id: string }>(
        `SELECT es.id FROM email_sends es
         JOIN sequence_steps ss ON ss.id = es.sequence_step_id
         WHERE es.enrollment_id = $1 AND ss.step_number = $2 LIMIT 1`,
        [row.id, nextStep]
      );
      if (alreadySent.rows.length > 0) continue;

      const stepDelayMs = (row.next_delay_days * 86400000) + (row.next_delay_hours * 3600000);
      const dueAt = new Date(row.updated_at).getTime() + stepDelayMs;
      const delayMs = Math.max(0, dueAt - Date.now());

      await sq.add('process-step', { enrollmentId: row.id, stepNumber: nextStep }, {
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      requeued++;
    }

    if (requeued > 0) {
      console.log(`[Re-Queue Steps] Re-queued ${requeued} stuck sequence steps`);
    }
    return requeued;
  } finally {
    await sq.close();
  }
}
