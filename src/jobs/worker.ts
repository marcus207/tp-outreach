import { Worker, Job } from 'bullmq';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config({ override: true });

import { sequenceEngine } from '../services/sequence-engine';
import { sendQueue } from '../services/send-queue';
import { replyWatcher } from '../services/reply-watcher';
import { apolloSyncService } from '../services/apollo-sync';
import { gmailClient } from '../services/gmail-client';
import { digestService } from '../services/digest';
import { healthCheckService } from '../services/health-check';
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
    concurrency: 5,
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

// Every day at 8am UTC: generate digest + send to marcus@tp.finance
cron.schedule('0 8 * * *', async () => {
  console.log('[Worker Cron] Generating daily digest...');
  try {
    const digest = await digestService.generate();
    await digestService.sendDigestEmail(digest.id);
    console.log(`[Worker Cron] Digest sent — ${digest.id}`);
  } catch (err) {
    console.error('[Worker Cron] Digest error:', (err as Error).message);
  }
});

// Every 5 minutes: reply polling (sequence replies)
cron.schedule('*/5 * * * *', async () => {
  console.log('[Worker Cron] Polling for replies...');
  try {
    await replyWatcher.pollAllAccounts();
  } catch (err) {
    console.error('[Worker Cron] Error polling replies:', err);
  }
});

// Every 5 minutes: check for digest edit replies from marcus@tp.finance
cron.schedule('*/5 * * * *', async () => {
  try {
    await digestService.checkForReplies();
  } catch (err) {
    console.error('[Worker Cron] Error checking digest replies:', (err as Error).message);
  }
});

console.log('[Worker] All workers and cron jobs started');

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
