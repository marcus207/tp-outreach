/**
 * recall.ts — "call back" outreach emails that have NOT been sent yet.
 *
 * IMPORTANT: This can only recall emails still sitting in the queue (status
 * 'queued'). Once an email has been dispatched to Gmail it is delivered to the
 * recipient's inbox and CANNOT be recalled — no system can unsend delivered
 * external mail. This tool cancels everything still in the pipe.
 *
 * How it works:
 *   1. Marks matching queued email_sends as status='cancelled' (error_message
 *      'recalled'). The send gate (send-gate.ts) refuses to send anything whose
 *      status is not 'queued', so this alone guarantees it never goes out.
 *   2. Drains the matching delayed/waiting BullMQ jobs from Redis so the worker
 *      never even picks them up.
 *
 * Runs against the tenant of the app it lives in (tp-outreach => tp,
 * li-outreach => loan-intel), read from that app's .env.
 *
 * Usage (from the app dir):
 *   npx tsx scripts/recall.ts --domain beldenn.co.uk        # preview (dry-run)
 *   npx tsx scripts/recall.ts --domain beldenn.co.uk --yes  # actually recall
 *   npx tsx scripts/recall.ts --email jane@acme.com --yes
 *   npx tsx scripts/recall.ts --contact <uuid> --yes
 *   npx tsx scripts/recall.ts --sequence <uuid> --yes
 *   npx tsx scripts/recall.ts --broadcast <uuid> --yes
 *   npx tsx scripts/recall.ts --all --yes                   # cancel EVERYTHING queued
 *
 * Without --yes it only reports what WOULD be recalled (safe preview).
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX, pool } from '../src/db/connection';

interface Args {
  email?: string;
  domain?: string;
  contact?: string;
  sequence?: string;
  broadcast?: string;
  all?: boolean;
  yes?: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '--email': a.email = argv[++i]; break;
      case '--domain': a.domain = argv[++i]; break;
      case '--contact': a.contact = argv[++i]; break;
      case '--sequence': a.sequence = argv[++i]; break;
      case '--broadcast': a.broadcast = argv[++i]; break;
      case '--all': a.all = true; break;
      case '--yes': a.yes = true; break;
      default:
        console.error(`Unknown argument: ${t}`);
        process.exit(1);
    }
  }
  return a;
}

function buildFilter(a: Args): { where: string; params: unknown[]; label: string } {
  const conds: string[] = [`es.tenant = $1`, `es.status = 'queued'`];
  const params: unknown[] = [TENANT];
  const labels: string[] = [];

  const add = (sql: string, val: unknown, label: string) => {
    params.push(val);
    conds.push(sql.replace('$$', `$${params.length}`));
    labels.push(label);
  };

  if (a.email) add(`LOWER(es.to_email) = LOWER($$)`, a.email, `email=${a.email}`);
  if (a.domain) add(`es.to_email ILIKE $$`, `%@${a.domain}`, `domain=${a.domain}`);
  if (a.contact) add(`es.contact_id = $$`, a.contact, `contact=${a.contact}`);
  if (a.sequence) {
    // sequence emails link via enrollment -> sequence
    add(
      `es.enrollment_id IN (SELECT id FROM sequence_enrollments WHERE sequence_id = $$ AND tenant = '${TENANT}')`,
      a.sequence,
      `sequence=${a.sequence}`
    );
  }
  if (a.broadcast) add(`es.broadcast_id = $$`, a.broadcast, `broadcast=${a.broadcast}`);

  if (!a.all && labels.length === 0) {
    console.error('Refusing to run with no filter. Use --all to recall everything queued, or pass a filter (--email/--domain/--contact/--sequence/--broadcast).');
    process.exit(1);
  }

  return {
    where: conds.join(' AND '),
    params,
    label: a.all && labels.length === 0 ? 'ALL queued sends' : labels.join(' AND '),
  };
}

async function drainQueueJobs(ids: Set<string>): Promise<number> {
  if (ids.size === 0) return 0;
  const queue = new Queue('email-sends', {
    connection: (() => {
      const url = process.env.REDIS_URL || 'redis://localhost:6379';
      const parsed = new URL(url);
      return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10), password: parsed.password || undefined };
    })(),
    prefix: BULL_PREFIX,
  });
  let removed = 0;
  // delayed + waiting + prioritized cover everything not yet running
  const jobs = await queue.getJobs(['delayed', 'waiting', 'paused', 'prioritized'], 0, -1, false);
  for (const job of jobs) {
    const esId = (job.data as { emailSendId?: string })?.emailSendId;
    if (esId && ids.has(esId)) {
      await job.remove();
      removed++;
    }
  }
  await queue.close();
  return removed;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const { where, params, label } = buildFilter(a);

  // 1. Find matching queued sends
  const found = await query<{ id: string; to_email: string }>(
    `SELECT es.id, es.to_email FROM email_sends es WHERE ${where}`,
    params
  );

  console.log(`\nTenant: ${TENANT}`);
  console.log(`Filter: ${label}`);
  console.log(`Queued (not-yet-sent) emails matching: ${found.rows.length}`);

  if (found.rows.length === 0) {
    console.log('Nothing to recall.\n');
    await pool.end();
    return;
  }

  const sample = found.rows.slice(0, 15).map((r) => `  - ${r.to_email}`).join('\n');
  console.log(sample + (found.rows.length > 15 ? `\n  ...and ${found.rows.length - 15} more` : ''));

  if (!a.yes) {
    console.log('\nDRY RUN — nothing changed. Re-run with --yes to actually recall these.\n');
    await pool.end();
    return;
  }

  // 2. Cancel in DB (authoritative — send gate will not send non-queued rows)
  const upd = await query(
    `UPDATE email_sends es SET status = 'cancelled', error_message = $${params.length + 1}
     WHERE ${where}`,
    [...params, `recalled: ${label}`]
  );
  console.log(`\nCancelled ${upd.rowCount} email_sends rows.`);

  // 3. Drain the delayed Redis jobs so the worker never runs them
  const ids = new Set(found.rows.map((r) => r.id));
  const removed = await drainQueueJobs(ids);
  console.log(`Removed ${removed} pending queue jobs from Redis.`);
  console.log('Recall complete. These emails will not be sent.\n');

  await pool.end();
}

main().catch((err) => {
  console.error('Recall failed:', err);
  process.exit(1);
});
