import { Worker, Job } from 'bullmq';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

import { sequenceEngine } from '../services/sequence-engine';
import { sendQueue } from '../services/send-queue';
import { replyWatcher } from '../services/reply-watcher';
import { apolloSyncService } from '../services/apollo-sync';
import { gmailClient } from '../services/gmail-client';
import { gmailScanner } from '../services/gmail-scanner';
import { campaignEngine } from '../services/campaign-engine';
import { digestService } from '../services/digest';
import { draftReviewService } from '../services/draft-review';
import { healthCheckService } from '../services/health-check';
import { requeueStuckSends } from '../services/requeue-stuck';
import { contactClassifier } from '../services/contact-classifier';
import { dailyPlanner } from '../services/daily-planner';
import { broadcastPlanner } from '../services/broadcast-planner';
import { processScheduledArticles } from '../services/article-scheduler';
import { dmarcScanner } from '../services/dmarc-scanner';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { SequenceStepJobData, ApolloSyncJobData } from '../types';

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

const redisConnection = getRedisConnection();

// ---- Sequence Steps Worker ----
const sequenceStepsWorker = new Worker<SequenceStepJobData>(
  'sequence-steps',
  async (job: Job<SequenceStepJobData>) => {
    console.log(`[Worker] Processing sequence step job: enrollment=${job.data.enrollmentId} step=${job.data.stepNumber}`);
    await sequenceEngine.processStep(job.data.enrollmentId, job.data.stepNumber);
  },
  {
    connection: redisConnection,
    prefix: BULL_PREFIX,
    concurrency: 1, // Must be 1: stagger count query reads queued email count,
                    // concurrency > 1 causes race where multiple jobs read same count
  }
);

sequenceStepsWorker.on('completed', (job) => {
  console.log(`[Worker] Sequence step job ${job.id} completed`);
});

sequenceStepsWorker.on('failed', (job, err) => {
  console.error(`[Worker] Sequence step job ${job?.id} failed:`, err.message);
});

// ---- Email Sends Worker ----
sendQueue.startWorker();

// ---- Reply Poll Worker ----
const replyPollWorker = new Worker(
  'reply-poll',
  async (job: Job) => {
    console.log(`[Worker] Running reply poll job ${job.id}`);
    await replyWatcher.pollAllAccounts();
  },
  {
    connection: redisConnection,
    prefix: BULL_PREFIX,
    concurrency: 1,
  }
);

replyPollWorker.on('failed', (job, err) => {
  console.error(`[Worker] Reply poll job ${job?.id} failed:`, err.message);
});

// ---- Apollo Sync Worker ----
const apolloSyncWorker = new Worker<ApolloSyncJobData>(
  'apollo-sync',
  async (job: Job<ApolloSyncJobData>) => {
    console.log(`[Worker] Running Apollo sync job: type=${job.data.syncType}`);
    await apolloSyncService.syncContacts(job.data.syncType || 'incremental');
  },
  {
    connection: redisConnection,
    prefix: BULL_PREFIX,
    concurrency: 1,
  }
);

apolloSyncWorker.on('failed', (job, err) => {
  console.error(`[Worker] Apollo sync job ${job?.id} failed:`, err.message);
});

// ---- Cron Jobs ----

// Every hour: reset hourly send counts
cron.schedule('0 * * * *', async () => {
  console.log('[Worker Cron] Resetting hourly send counts...');
  try {
    await gmailClient.resetHourlyCounts();
  } catch (err) {
    console.error('[Worker Cron] Error resetting hourly counts:', err);
  }
});

// Every day at midnight UTC: reset daily send counts
cron.schedule('0 0 * * *', async () => {
  console.log('[Worker Cron] Resetting daily send counts...');
  try {
    await gmailClient.resetDailyCounts();
  } catch (err) {
    console.error('[Worker Cron] Error resetting daily counts:', err);
  }
});

// Every 6 hours: Apollo incremental sync
cron.schedule('0 */6 * * *', async () => {
  if (!process.env.APOLLO_API_KEY) {
    return;
  }
  console.log('[Worker Cron] Triggering Apollo incremental sync...');
  try {
    await apolloSyncService.syncContacts('incremental');
  } catch (err) {
    console.error('[Worker Cron] Error during Apollo sync:', err);
  }
});

// Every day at 7:30am UTC: health check + daily report
cron.schedule('30 7 * * *', async () => {
  console.log('[Worker Cron] Running daily health check...');
  try {
    await healthCheckService.runAndReport();
  } catch (err) {
    console.error('[Worker Cron] Health check error:', (err as Error).message);
  }
});

// DISABLED: Daily digest email — outreach now runs automatically via sequences
// cron.schedule('0 8 * * *', async () => {
//   console.log('[Worker Cron] Generating daily digest...');
//   try {
//     const digest = await digestService.generate();
//     await digestService.sendDigestEmail(digest.id);
//     console.log(`[Worker Cron] Digest sent — ${digest.id}`);
//   } catch (err) {
//     console.error('[Worker Cron] Digest error:', (err as Error).message);
//   }
// });

// Every 5 minutes: reply polling (sequence replies)
cron.schedule('*/5 * * * *', async () => {
  console.log('[Worker Cron] Polling for replies...');
  try {
    await replyWatcher.pollAllAccounts();
  } catch (err) {
    console.error('[Worker Cron] Error polling replies:', err);
  }
});

// DISABLED: Digest reply checking — no longer sending digest emails
// cron.schedule('*/5 * * * *', async () => {
//   try {
//     await digestService.checkForReplies();
//   } catch (err) {
//     console.error('[Worker Cron] Error checking digest replies:', (err as Error).message);
//   }
// });

// DISABLED: Draft review approval flow — sequences handle all outreach automatically now
// cron.schedule('0 8 * * 1', async () => { ... draftReviewService.generateDraft() ... });
// cron.schedule('*/5 * * * *', async () => { ... draftReviewService.checkForReplies() ... });

// Every hour: auto-enrol new contacts into sequences (LI-only, no-op for TP)
cron.schedule('15 * * * *', async () => {
  try {
    await autoEnrolNewContacts();
  } catch (err) {
    console.error('[Worker Cron] Auto-enrol error:', (err as Error).message);
  }
});

// Every hour at :15: campaign engine tick (controlled by is_active in DB)
cron.schedule('15 * * * *', async () => {
  console.log('[Worker Cron] Campaign engine tick...');
  try {
    const result = await campaignEngine.tick();
    if (result.ran) {
      console.log(`[Worker Cron] Campaign engine: ${result.contacts_queued} queued, ${result.contacts_skipped} skipped`);
    } else {
      console.log(`[Worker Cron] Campaign engine skipped: ${result.reason}`);
    }
  } catch (err) {
    console.error('[Worker Cron] Campaign engine error:', (err as Error).message);
  }
});

// Every 3 minutes: re-queue stuck email_sends that lost their BullMQ jobs
cron.schedule('*/3 * * * *', async () => {
  try {
    await requeueStuckSends();
  } catch (err) {
    console.error('[Worker Cron] Re-queue stuck sends error:', (err as Error).message);
  }
});

// Hourly planner: runs at :05 past each hour during the send window (08-17 UTC, 7 days/week).
// Picks up enrollments whose next_step_due_at <= NOW(), fair-distributes across accounts.
cron.schedule('5 8-17 * * *', async () => {
  console.log(`[Worker Cron] Running hourly planner for ${TENANT}...`);
  try {
    const result = await dailyPlanner.plan();
    console.log(`[Worker Cron] Planner done: planned=${result.planned}, overflow=${result.overflow}`);
  } catch (err) {
    console.error('[Worker Cron] Planner error:', (err as Error).message);
  }
});

// Broadcast planner: runs at :10 past each hour during the send window (08-17 UTC, 7 days/week).
// Picks queued broadcast emails and distributes at 15/hr/account, separate from sequence budget.
cron.schedule('10 8-17 * * *', async () => {
  console.log(`[Worker Cron] Running broadcast planner for ${TENANT}...`);
  try {
    const result = await broadcastPlanner.plan();
    console.log(`[Worker Cron] Broadcast planner done: planned=${result.planned}`);
  } catch (err) {
    console.error('[Worker Cron] Broadcast planner error:', (err as Error).message);
  }
});

// Daily at 7:00 AM UTC: scan marcus@tp.finance sent+inbox (24hr lookback), then classify
cron.schedule('0 7 * * *', async () => {
  try {
    await gmailScanner.scanAllAccounts();
  } catch (err) {
    console.error('[Worker Cron] Error in Gmail scanner:', (err as Error).message);
  }
});

// Daily at 6:00 AM UTC: scan Gmail for DMARC reports, parse them, archive from inbox
cron.schedule('0 6 * * *', async () => {
  if (TENANT !== 'tp') return;
  console.log('[Worker Cron] Scanning for DMARC reports...');
  try {
    const result = await dmarcScanner.scanAndArchive();
    if (result.processed > 0 || result.archived > 0) {
      console.log(`[Worker Cron] DMARC: ${result.processed} parsed, ${result.archived} archived`);
    }
  } catch (err) {
    console.error('[Worker Cron] DMARC scan error:', (err as Error).message);
  }
});

// Weekly deliverability report - Monday 8:00 AM UTC
cron.schedule('0 8 * * 1', async () => {
  console.log('[Worker Cron] Running weekly deliverability check...');
  try {
    const { execSync } = require('child_process');
    execSync('python3 /root/tp-outreach/scripts/deliverability_check.py', { timeout: 60000 });
    console.log('[Worker Cron] Deliverability report sent');
  } catch (err) {
    console.error('[Worker Cron] Deliverability check error:', (err as Error).message);
  }
});

console.log(`[Worker] All workers and cron jobs started (tenant: ${TENANT}, prefix: ${BULL_PREFIX})`);

// ---- Sync TP lenders into loan-intel tenant ----

async function syncTpLendersToLoanIntel(): Promise<void> {
  // Find TP lender contacts that don't yet exist in loan-intel tenant
  const result = await query<{
    email: string; first_name: string | null; last_name: string | null;
    title: string | null; company: string | null; company_domain: string | null;
    linkedin_url: string | null; phone: string | null; city: string | null;
    country: string | null; tags: string[]; custom_fields: unknown;
  }>(
    `SELECT tp.email, tp.first_name, tp.last_name, tp.title, tp.company,
            tp.company_domain, tp.linkedin_url, tp.phone, tp.city, tp.country,
            tp.tags, tp.custom_fields
     FROM contacts tp
     WHERE tp.tenant = 'tp'
       AND tp.contact_type = 'lender'
       AND tp.email IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM contacts li
         WHERE LOWER(li.email) = LOWER(tp.email) AND li.tenant = 'loan-intel'
       )
     LIMIT 200`
  );

  if (result.rows.length === 0) return;

  console.log(`[Lender Sync] Copying ${result.rows.length} TP lenders to loan-intel tenant...`);
  let copied = 0;

  for (const c of result.rows) {
    try {
      await query(
        `INSERT INTO contacts (email, first_name, last_name, title, company,
          company_domain, linkedin_url, phone, city, country, tags,
          custom_fields, contact_type, source, tenant)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'lender','tp-classifier','loan-intel')
         ON CONFLICT DO NOTHING`,
        [c.email, c.first_name, c.last_name, c.title, c.company,
         c.company_domain, c.linkedin_url, c.phone, c.city, c.country,
         c.tags || '{}', JSON.stringify(c.custom_fields || {})]
      );
      copied++;
    } catch (err) {
      console.error(`[Lender Sync] Failed to copy ${c.email}: ${(err as Error).message}`);
    }
  }

  console.log(`[Lender Sync] Done — copied ${copied} lenders to loan-intel`);
}

// ---- Auto-enrol new loan-intel contacts into Intro Series ----
const LOAN_INTEL_INTRO_SEQUENCE_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

async function autoEnrolNewContacts(): Promise<void> {
  if (TENANT !== 'loan-intel') return;

  // First: sync any new TP lenders into loan-intel tenant
  await syncTpLendersToLoanIntel();

  // Find all loan-intel contacts not yet enrolled (or previously cancelled/completed)
  // in the Loan Intel Platform Series — excludes unsubscribed contacts
  const result = await query<{ id: string; email: string }>(
    `SELECT c.id, c.email
     FROM contacts c
     WHERE c.tenant = 'loan-intel'
       AND NOT ('unsubscribed' = ANY(c.tags))
       AND NOT ('bounced' = ANY(c.tags))
       AND NOT EXISTS (
         SELECT 1 FROM sequence_enrollments se
         WHERE se.contact_id = c.id
           AND se.sequence_id = $1
           AND se.tenant = 'loan-intel'
           AND se.status = 'active'
       )`,
    [LOAN_INTEL_INTRO_SEQUENCE_ID]
  );

  const contacts = result.rows;
  if (contacts.length === 0) {
    console.log('[Auto-Enrol] No new contacts to enrol');
    return;
  }

  console.log(`[Auto-Enrol] Enrolling ${contacts.length} contact(s) in Loan Intel Platform Series...`);
  let enrolled = 0;
  let failed = 0;

  for (const contact of contacts) {
    try {
      await sequenceEngine.enrollContact(LOAN_INTEL_INTRO_SEQUENCE_ID, contact.id);
      enrolled++;
    } catch (err) {
      // 'already actively enrolled' is expected if a race occurs — not an error
      const msg = (err as Error).message;
      if (!msg.includes('already actively enrolled')) {
        console.error(`[Auto-Enrol] Failed to enrol ${contact.email}: ${msg}`);
        failed++;
      }
    }
  }

  console.log(`[Auto-Enrol] Done — enrolled: ${enrolled}, failed: ${failed}`);
}

// ---- Subsector backfill (runs on TP worker only) ----
// Every 20 minutes: backfill subsectors for already-classified contacts missing them
cron.schedule('*/20 * * * *', async () => {
  if (TENANT !== 'tp') return;
  try {
    await contactClassifier.backfillSubsectors(50);
  } catch (err) {
    console.error('[Worker Cron] Subsector backfill error:', (err as Error).message);
  }
});

// ---- Auto-enrol TP introducers/clients into subsector sequences ----

const TP_SEQUENCE_MAP: Record<string, Record<string, string>> = {
  introducer: {
    accountant:        '12b7cdc0-fcca-43e2-a51d-d7c6ac593673',
    advisory:          '6cc1ad69-d942-4324-8913-20dc87d954e0',
    agent:             'fcd69481-0eea-4d10-803b-821ff41cb0c8',
    construction:      'ffb8d42d-eded-4ce8-a761-5a2bb2c07f15',
    lawyer:            '3789f37d-496f-41f0-a080-c90e504eff4e',
    planning_architect:'860e34fc-1b6e-404f-968f-c87103daf37a',
    surveyor:          '41f73c02-1042-4660-93c0-4952c01837a3',
    wealth:            '300f555b-0c4e-4a87-a4ab-bdde935f40f1',
  },
  developer: {
    btr:         '1755561a-a5f7-419d-af36-4f92b6ffaba2',
    care:        '59b3452e-9494-452a-a878-efb340e5e82b',
    hospitality: '987aef9e-ef24-444a-a2c3-224d2b0e6fb3',
    leisure:     '80e16a3a-f31c-4cbc-a7ac-83b4584fcd10',
    living:      '787f2894-e1bf-4c3b-a056-fd4d9f4a9a61',
    logistics:   'ed20c449-1225-4396-97d1-005e351f417e',
    office:      'bbc4b97b-3249-4bf9-beb5-818a7f6194f5',
    pbsa:        '7621fdf5-b945-458f-b4af-d1452157ded9',
    retail:      '66939bf5-6838-45ec-a8f4-11f852c85ed3',
    sfh:         '7cf3a985-725d-4339-bd23-c70973da055f',
  },
};

async function autoEnrolTpContacts(): Promise<void> {
  if (TENANT !== 'tp') return;

  // Only enrol into sequences that are active — draft sequences are skipped
  const activeSeqs = await query<{ id: string }>(
    `SELECT id FROM sequences WHERE tenant = 'tp' AND status = 'active' AND type = 'drip'
       AND (name LIKE 'Introducers%' OR name LIKE 'Clients%')`
  );
  const activeSeqIds = new Set(activeSeqs.rows.map(r => r.id));
  if (activeSeqIds.size === 0) return;

  // Find TP contacts with contact_type + subsector that aren't enrolled in their matching sequence
  const contacts = await query<{
    id: string; email: string; contact_type: string; subsector: string;
  }>(
    `SELECT c.id, c.email, c.contact_type, c.subsector
     FROM contacts c
     WHERE c.tenant = 'tp'
       AND c.contact_type IN ('introducer', 'developer')
       AND c.subsector IS NOT NULL
       AND NOT ('unsubscribed' = ANY(c.tags))
       AND NOT ('bounced' = ANY(c.tags))
       -- Never sequence lenders from tp.finance (even if also tagged introducer/developer)
       AND NOT EXISTS (
         SELECT 1 FROM contact_list_members clm
         JOIN contact_lists cl ON cl.id = clm.list_id
         WHERE clm.contact_id = c.id AND cl.name = 'Lenders'
       )
       AND NOT EXISTS (
         SELECT 1 FROM sequence_enrollments se
         WHERE se.contact_id = c.id
           AND se.tenant = 'tp'
           AND se.status = 'active'
       )
     LIMIT 100`
  );

  if (contacts.rows.length === 0) return;

  console.log(`[TP Auto-Enrol] ${contacts.rows.length} contacts ready for sequence enrollment...`);
  let enrolled = 0;
  let skipped = 0;

  for (const c of contacts.rows) {
    const seqMap = TP_SEQUENCE_MAP[c.contact_type];
    const sequenceId = seqMap?.[c.subsector];
    if (!sequenceId || !activeSeqIds.has(sequenceId)) {
      skipped++;
      continue;
    }

    try {
      await sequenceEngine.enrollContact(sequenceId, c.id);
      enrolled++;
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('already actively enrolled')) {
        console.error(`[TP Auto-Enrol] Failed ${c.email} → ${c.contact_type}/${c.subsector}: ${msg}`);
      }
    }
  }

  if (enrolled > 0 || skipped > 0) {
    console.log(`[TP Auto-Enrol] Done — enrolled: ${enrolled}, skipped: ${skipped}`);
  }
}

// Every hour at :45: auto-enrol TP contacts into subsector sequences
cron.schedule('45 * * * *', async () => {
  try {
    await autoEnrolTpContacts();
  } catch (err) {
    console.error('[Worker Cron] TP auto-enrol error:', (err as Error).message);
  }
});

// ---- Article Scheduler (publish + broadcast on schedule) ----
cron.schedule('*/5 * * * *', async () => {
  try {
    await processScheduledArticles();
  } catch (err) {
    console.error('[Worker Cron] Article scheduler error:', (err as Error).message);
  }
});

// Graceful shutdown
async function shutdown() {
  console.log('[Worker] Shutting down...');
  await Promise.all([
    sequenceStepsWorker.close(),
    replyPollWorker.close(),
    apolloSyncWorker.close(),
    sendQueue.close(),
    sequenceEngine.close(),
  ]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
