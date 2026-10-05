const { Queue } = require('bullmq');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const REDIS_CONN = { host: '127.0.0.1', port: 6379 };

async function enqueueAll(tenant, prefix) {
  const queueOpts = prefix
    ? { connection: REDIS_CONN, prefix }
    : { connection: REDIS_CONN };

  const stepQueue = new Queue('sequence-steps', queueOpts);

  const { rows } = await pool.query(
    `SELECT se.id as enrollment_id, se.current_step
     FROM sequence_enrollments se
     JOIN sequences s ON s.id = se.sequence_id
     WHERE se.status = 'active' AND s.status = 'active' AND se.tenant = $1`,
    [tenant]
  );

  console.log(`[${tenant}] Found ${rows.length} active enrollments to re-enqueue`);

  let count = 0;
  for (const row of rows) {
    const nextStep = row.current_step + 1;
    await stepQueue.add(
      'process-step',
      { enrollmentId: row.enrollment_id, stepNumber: nextStep },
      { delay: 0, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
    );
    count++;
    if (count % 1000 === 0) console.log(`[${tenant}] Enqueued ${count}/${rows.length}`);
  }

  console.log(`[${tenant}] Done — enqueued ${count} jobs`);
  await stepQueue.close();
}

(async () => {
  try {
    await enqueueAll('tp', 'bull-tp');
    await enqueueAll('loan-intel', 'bull-loan-intel');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
})();
