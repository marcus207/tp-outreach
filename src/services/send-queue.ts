import { Queue, Worker, Job } from 'bullmq';
import { query } from '../db/connection';
import { gmailClient } from './gmail-client';
import { EmailAccount } from '../types';

interface EmailSendJobData {
  emailSendId: string;
  threadId?: string;
  fromName?: string;
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
  contact_id: string;
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
        concurrency: 2,
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

    // Fetch email send record
    const sendResult = await query<EmailSendRecord>(
      `SELECT * FROM email_sends WHERE id = $1`,
      [emailSendId]
    );

    if (!sendResult.rows[0]) {
      throw new Error(`Email send record ${emailSendId} not found`);
    }

    const send = sendResult.rows[0];

    if (send.enrollment_id) {
      // Check if enrollment is still active
      const enrollmentResult = await query<{ status: string }>(
        `SELECT status FROM sequence_enrollments WHERE id = $1`,
        [send.enrollment_id]
      );

      if (enrollmentResult.rows[0]?.status !== 'active') {
        console.log(`[Send Queue] Enrollment ${send.enrollment_id} is no longer active, skipping send`);
        await query(
          `UPDATE email_sends SET status = 'failed', error_message = 'Enrollment cancelled', created_at = created_at WHERE id = $1`,
          [emailSendId]
        );
        return;
      }
    }

    // Check if contact has unsubscribed
    const contactCheck = await query<{ tags: string[] }>(
      `SELECT tags FROM contacts WHERE id = $1`,
      [send.contact_id]
    );
    if (contactCheck.rows[0]?.tags?.includes('unsubscribed')) {
      await query(`UPDATE email_sends SET status = 'failed', error_message = 'Unsubscribed' WHERE id = $1`, [emailSendId]);
      return;
    }

    // Fetch email account
    const accountResult = await query<EmailAccount>(
      `SELECT * FROM email_accounts WHERE id = $1 AND is_active = true`,
      [send.email_account_id]
    );

    if (!accountResult.rows[0]) {
      throw new Error(`Email account ${send.email_account_id} not found or inactive`);
    }

    const account = accountResult.rows[0];

    // Check limits
    if (account.sends_today >= account.daily_limit) {
      throw new Error(`Daily limit reached for account ${account.email}`);
    }

    if (account.sends_this_hour >= account.hourly_limit) {
      throw new Error(`Hourly limit reached for account ${account.email}`);
    }

    try {
      const result = await gmailClient.sendEmail(account, {
        to: send.to_email,
        from: send.from_email,
        fromName,
        subject: send.subject,
        htmlBody: send.body_html,
        threadId,
        trackingId: send.tracking_id,
      });

      // Update success
      await query(
        `UPDATE email_sends
         SET status = 'sent', gmail_message_id = $1, gmail_thread_id = $2,
             sent_at = NOW()
         WHERE id = $3`,
        [result.messageId, result.threadId, emailSendId]
      );

      // Increment send counts
      await gmailClient.incrementSendCounts(account.id);

      console.log(`[Send Queue] Email sent successfully: ${send.to_email} via ${send.from_email}`);
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
