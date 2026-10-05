import { Queue, Worker, Job } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { gmailClient } from './gmail-client';
import { canSend } from './send-gate';
import { dailyPlanner } from './daily-planner';
import { EmailAccount } from '../types';

interface EmailSendJobData {
  emailSendId: string;
  threadId?: string;
  fromName?: string;
  // Set by the sequence engine, which now reserves (increments) the account's
  // send counters atomically at queue time. When true, the send worker must
  // NOT increment again or the daily/hourly caps would be double-counted.
  preCounted?: boolean;
}

interface EmailSendRecord {
  id: string;
  to_email: string;
  from_email: string;
  subject: string;
  body_html: string;
  tracking_id: string;
  email_account_id: string;
  enrollment_id: string | null;
  broadcast_id: string | null;
  contact_id: string;
  status: string;
}

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

export class SendQueue {
  private queue: Queue<EmailSendJobData>;
  private worker: Worker<EmailSendJobData> | null = null;

  constructor() {
    this.queue = new Queue<EmailSendJobData>('email-sends', {
      connection: getRedisConnection(),
      prefix: BULL_PREFIX,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 100,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
      },
    });
  }

  async add(jobData: EmailSendJobData, delayMs?: number): Promise<void> {
    const minDelay = parseInt(process.env.SEND_DELAY_MIN_SECONDS || '30', 10) * 1000;
    const maxDelay = parseInt(process.env.SEND_DELAY_MAX_SECONDS || '120', 10) * 1000;
    const delay = delayMs ?? Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    await this.queue.add('send-email', jobData, { delay });
    console.log(`[Send Queue] Added job for email_send ${jobData.emailSendId} (delay: ${Math.round(delay / 1000)}s)`);
  }

  startWorker(): void {
    this.worker = new Worker<EmailSendJobData>(
      'email-sends',
      async (job: Job<EmailSendJobData>) => {
        await this.processEmailSend(job.data);
      },
      {
        connection: getRedisConnection(),
        prefix: BULL_PREFIX,
        concurrency: 1,
      }
    );

    this.worker.on('completed', (job) => {
      console.log(`[Send Queue] Job ${job.id} completed for email_send ${job.data.emailSendId}`);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`[Send Queue] Job ${job?.id} failed for email_send ${job?.data.emailSendId}:`, err.message);
    });

    console.log('[Send Queue] Worker started');
  }

  private async processEmailSend(data: EmailSendJobData): Promise<void> {
    const { emailSendId, threadId, fromName } = data;

    // Centralised pre-send gate — all checks in one place (send-gate.ts)
    const decision = await canSend(emailSendId);

    if (decision.action === 'fail') {
      console.log(`[Send Queue] ${emailSendId} failed gate: ${decision.reason}`);
      await query(
        `UPDATE email_sends SET status = 'failed', error_message = $1 WHERE id = $2`,
        [decision.reason, emailSendId]
      );
      return;
    }

    if (decision.action === 'skip') {
      console.log(`[Send Queue] ${emailSendId} skipped: ${decision.reason}`);
      return;
    }

    // Gate passed — fetch full record and send
    const sendResult = await query<EmailSendRecord>(
      `SELECT * FROM email_sends WHERE id = $1 AND tenant = $2`,
      [emailSendId, TENANT]
    );
    const send = sendResult.rows[0]!;

    const accountResult = await query<EmailAccount>(
      `SELECT * FROM email_accounts WHERE id = $1 AND is_active = true AND tenant = $2`,
      [send.email_account_id, TENANT]
    );
    const account = accountResult.rows[0]!;

    // Enforce minimum gap between sends per account (sequence emails only).
    // Broadcast emails are already rate-limited by the broadcast planner at 15/hr/account.
    if (!send.broadcast_id) {
      const gapResult = await query<{ value: string }>(
        `SELECT value FROM settings WHERE key = 'send_gap_minutes'`
      );
      const gapMinutes = gapResult.rows[0] ? Number(gapResult.rows[0].value) : 3;
      const gapMs = gapMinutes * 60 * 1000;

      if (account.last_send_at) {
        const elapsed = Date.now() - new Date(account.last_send_at).getTime();
        if (elapsed < gapMs) {
          return;
        }
      }
    }

    try {
      let sendThreadId = threadId;
      let result;
      try {
        result = await gmailClient.sendEmail(account, {
          to: send.to_email,
          from: send.from_email,
          fromName,
          subject: send.subject,
          htmlBody: send.body_html,
          threadId: sendThreadId,
          trackingId: send.tracking_id,
        });
      } catch (threadErr) {
        const msg = (threadErr as Error).message || '';
        if (sendThreadId && msg.includes('not found')) {
          console.log(`[Send Queue] Thread not found for ${emailSendId}, retrying without threadId`);
          result = await gmailClient.sendEmail(account, {
            to: send.to_email,
            from: send.from_email,
            fromName,
            subject: send.subject,
            htmlBody: send.body_html,
            trackingId: send.tracking_id,
          });
        } else {
          throw threadErr;
        }
      }

      // Update success
      await query(
        `UPDATE email_sends
         SET status = 'sent', gmail_message_id = $1, gmail_thread_id = $2,
             sent_at = NOW()
         WHERE id = $3`,
        [result.messageId, result.threadId, emailSendId]
      );

      // Increment send counts — unless the sequence engine already reserved
      // the slot atomically at queue time (avoids double-counting the cap).
      if (!data.preCounted) {
        await gmailClient.incrementSendCounts(account.id);
      }

      console.log(`[Send Queue] Email sent successfully: ${send.to_email} via ${send.from_email}`);

      // Schedule next step on the enrollment (DB-based, replaces BullMQ step scheduling)
      if (send.enrollment_id) {
        try {
          await dailyPlanner.scheduleNextStep(emailSendId);
        } catch (nextErr) {
          console.error(`[Send Queue] Error scheduling next step for ${emailSendId}:`, (nextErr as Error).message);
        }
      }
    } catch (err) {
      const error = err as Error;
      console.error(`[Send Queue] Failed to send email ${emailSendId}:`, error.message);

      await query(
        `UPDATE email_sends SET status = 'failed', error_message = $1 WHERE id = $2`,
        [error.message, emailSendId]
      );

      throw err; // Re-throw so BullMQ handles retries
    }
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
  }
}

export const sendQueue = new SendQueue();
