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
        `UPDATE email_sends SET status = 'failed', error_message = $1
         WHERE id = $2 AND tenant = $3 AND status = 'queued'`,
        [decision.reason, emailSendId, TENANT]
      );
      await this.handleEnrollmentAfterFailure(emailSendId, decision.reason, decision.permanent === true);
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
    const send = sendResult.rows[0];
    if (!send) return;

    const accountResult = await query<EmailAccount>(
      `SELECT * FROM email_accounts WHERE id = $1 AND is_active = true AND tenant = $2`,
      [send.email_account_id, TENANT]
    );
    const account = accountResult.rows[0];
    if (!account) {
      // Deactivated between gate and now — transient for the enrollment
      await query(
        `UPDATE email_sends SET status = 'failed', error_message = 'Email account inactive'
         WHERE id = $1 AND tenant = $2 AND status = 'queued'`,
        [emailSendId, TENANT]
      );
      await this.handleEnrollmentAfterFailure(emailSendId, 'Email account inactive', false);
      return;
    }

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
          // Too soon after this account's last send — push the job back rather
          // than dropping it (which left it for the re-queue cron).
          const retryDelay = gapMs - elapsed + Math.floor(Math.random() * 60000) + 30000;
          await this.add(data, retryDelay);
          await query(
            `UPDATE email_sends SET last_enqueued_at = NOW() + ($1::int * INTERVAL '1 millisecond') WHERE id = $2`,
            [retryDelay, emailSendId]
          );
          return;
        }
      }
    }

    // Claim the row atomically BEFORE calling Gmail. If we crash after Gmail
    // accepts the message, the row stays 'sending' and is never re-sent
    // (requeueStuckSends marks old 'sending' rows failed: unknown outcome).
    // last_enqueued_at doubles as the claim timestamp for that check.
    const claim = await query<{ id: string }>(
      `UPDATE email_sends SET status = 'sending', last_enqueued_at = NOW()
       WHERE id = $1 AND tenant = $2 AND status = 'queued'
       RETURNING id`,
      [emailSendId, TENANT]
    );
    if (claim.rows.length === 0) {
      console.log(`[Send Queue] ${emailSendId} already claimed by another job, skipping`);
      return;
    }

    let result: { messageId: string; threadId: string };
    try {
      const sendThreadId = threadId;
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
    } catch (err) {
      // Gmail did NOT accept the message — safe to mark failed and retry later
      const error = err as Error;
      console.error(`[Send Queue] Failed to send email ${emailSendId}:`, error.message);

      await query(
        `UPDATE email_sends SET status = 'failed', error_message = $1 WHERE id = $2 AND tenant = $3`,
        [error.message, emailSendId, TENANT]
      );
      // Gmail/auth/transient errors: enrollment retried in ~1 day
      await this.handleEnrollmentAfterFailure(emailSendId, error.message, false);

      throw err; // Re-throw so BullMQ logs it (a retry is a no-op: status is no longer 'queued')
    }

    // ── Gmail accepted the message. Nothing below may flip it to 'failed'. ──

    try {
      await query(
        `UPDATE email_sends
         SET status = 'sent', gmail_message_id = $1, gmail_thread_id = $2,
             sent_at = NOW()
         WHERE id = $3 AND tenant = $4`,
        [result.messageId, result.threadId, emailSendId, TENANT]
      );
    } catch (err) {
      // Row stays 'sending' → never re-sent; the re-queue cron resolves it.
      console.error(`[Send Queue] CRITICAL: ${emailSendId} delivered (gmail ${result.messageId}) but status update failed:`, (err as Error).message);
      return;
    }

    // Increment send counts — unless the sequence engine already reserved
    // the slot atomically at queue time (avoids double-counting the cap).
    if (!data.preCounted) {
      try {
        await gmailClient.incrementSendCounts(account.id);
      } catch (err) {
        console.error(`[Send Queue] Sent ${emailSendId} but failed to increment counters for ${account.email}:`, (err as Error).message);
      }
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
  }

  /** Never let enrollment bookkeeping errors mask the send outcome. */
  private async handleEnrollmentAfterFailure(emailSendId: string, reason: string, permanent: boolean): Promise<void> {
    try {
      await dailyPlanner.handleFailedSend(emailSendId, reason, permanent);
    } catch (err) {
      console.error(`[Send Queue] Error updating enrollment after failed send ${emailSendId}:`, (err as Error).message);
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
