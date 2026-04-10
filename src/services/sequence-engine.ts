import { Queue } from 'bullmq';
import { query } from '../db/connection';
import { gmailClient } from './gmail-client';
import { templateEngine } from './template-engine';
import { Sequence, SequenceStep, SequenceEnrollment, Contact, Template, EmailAccount } from '../types';
import { SequenceStepJobData } from '../types';

const SEQUENCE_QUEUE_NAME = 'sequence-steps';

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

export class SequenceEngine {
  private stepQueue: Queue<SequenceStepJobData>;

  constructor() {
    this.stepQueue = new Queue<SequenceStepJobData>(SEQUENCE_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });
  }

  async enrollContact(sequenceId: string, contactId: string): Promise<string> {
    console.log(`[Sequence Engine] Enrolling contact ${contactId} in sequence ${sequenceId}`);

    // Check if contact has unsubscribed
    const contactCheck = await query<{ tags: string[] }>(
      `SELECT tags FROM contacts WHERE id = $1`,
      [contactId]
    );
    if (contactCheck.rows[0]?.tags?.includes('unsubscribed')) {
      throw new Error('Contact has unsubscribed');
    }

    // Check if already enrolled
    const existing = await query<{ id: string; status: string }>(
      `SELECT id, status FROM sequence_enrollments WHERE sequence_id = $1 AND contact_id = $2`,
      [sequenceId, contactId]
    );

    if (existing.rows.length > 0) {
      const enrollment = existing.rows[0];
      if (enrollment.status === 'active') {
        throw new Error('Contact is already actively enrolled in this sequence');
      }
      // Re-enroll if previously cancelled/completed
      await query(
        `UPDATE sequence_enrollments
         SET status = 'active', current_step = 0, enrolled_at = NOW(),
             completed_at = NULL, replied_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [enrollment.id]
      );
      await this.scheduleStep(enrollment.id, 1, 0);
      return enrollment.id;
    }

    // Create enrollment
    const result = await query<{ id: string }>(
      `INSERT INTO sequence_enrollments (sequence_id, contact_id, status, current_step)
       VALUES ($1, $2, 'active', 0)
       RETURNING id`,
      [sequenceId, contactId]
    );

    const enrollmentId = result.rows[0].id;

    // Schedule first step immediately (step_number = 1)
    await this.scheduleStep(enrollmentId, 1, 0);

    console.log(`[Sequence Engine] Enrolled ${contactId} with enrollment ${enrollmentId}`);
    return enrollmentId;
  }

  async processStep(enrollmentId: string, stepNumber: number): Promise<void> {
    console.log(`[Sequence Engine] Processing step ${stepNumber} for enrollment ${enrollmentId}`);

    // Fetch enrollment
    const enrollmentResult = await query<SequenceEnrollment>(
      `SELECT * FROM sequence_enrollments WHERE id = $1`,
      [enrollmentId]
    );

    if (!enrollmentResult.rows[0]) {
      console.error(`[Sequence Engine] Enrollment ${enrollmentId} not found`);
      return;
    }

    const enrollment = enrollmentResult.rows[0];

    if (enrollment.status !== 'active') {
      console.log(`[Sequence Engine] Enrollment ${enrollmentId} is ${enrollment.status}, skipping`);
      return;
    }

    // Fetch sequence
    const seqResult = await query<Sequence>(
      `SELECT * FROM sequences WHERE id = $1`,
      [enrollment.sequence_id]
    );

    if (!seqResult.rows[0] || seqResult.rows[0].status !== 'active') {
      console.log(`[Sequence Engine] Sequence not active for enrollment ${enrollmentId}`);
      return;
    }

    const sequence = seqResult.rows[0];

    // Fetch step
    const stepResult = await query<SequenceStep>(
      `SELECT * FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
      [enrollment.sequence_id, stepNumber]
    );

    if (!stepResult.rows[0]) {
      // No more steps — enrollment complete
      await query(
        `UPDATE sequence_enrollments
         SET status = 'completed', completed_at = NOW(), current_step = $1, updated_at = NOW()
         WHERE id = $2`,
        [stepNumber - 1, enrollmentId]
      );
      console.log(`[Sequence Engine] Enrollment ${enrollmentId} completed all steps`);
      return;
    }

    const step = stepResult.rows[0];

    // Fetch contact
    const contactResult = await query<Contact>(
      `SELECT * FROM contacts WHERE id = $1`,
      [enrollment.contact_id]
    );

    if (!contactResult.rows[0]) {
      console.error(`[Sequence Engine] Contact not found for enrollment ${enrollmentId}`);
      return;
    }

    const contact = contactResult.rows[0];

    // Determine which template to use (A/B testing)
    let templateId = step.template_id;
    let abVariant: 'A' | 'B' | null = null;

    if (step.variant_template_id && step.variant_split) {
      const rand = Math.random() * 100;
      if (rand < step.variant_split) {
        abVariant = 'B';
        templateId = step.variant_template_id;
      } else {
        abVariant = 'A';
      }
    }

    if (!templateId) {
      console.error(`[Sequence Engine] No template for step ${stepNumber} in enrollment ${enrollmentId}`);
      return;
    }

    // Fetch template
    const templateResult = await query<Template>(
      `SELECT * FROM templates WHERE id = $1`,
      [templateId]
    );

    if (!templateResult.rows[0]) {
      console.error(`[Sequence Engine] Template ${templateId} not found`);
      return;
    }

    const template = templateResult.rows[0];

    // Get sending account
    const account = await gmailClient.getBestSendingAccount(
      sequence.sending_account_ids || []
    );

    if (!account) {
      console.error(`[Sequence Engine] No available sending account for enrollment ${enrollmentId}`);
      // Retry in 1 hour
      await this.scheduleStep(enrollmentId, stepNumber, 60 * 60 * 1000);
      return;
    }

    // Render template
    const rendered = templateEngine.renderTemplate(template, contact);

    // Get previous send's thread ID for reply threading
    const prevSend = await query<{ gmail_thread_id: string }>(
      `SELECT gmail_thread_id FROM email_sends
       WHERE enrollment_id = $1 AND gmail_thread_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 1`,
      [enrollmentId]
    );

    const threadId = prevSend.rows[0]?.gmail_thread_id;

    // Create email_sends record
    const sendResult = await query<{ id: string }>(
      `INSERT INTO email_sends (
        enrollment_id, sequence_step_id, contact_id, email_account_id, template_id,
        to_email, from_email, subject, body_html, status, ab_variant
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10)
      RETURNING id`,
      [
        enrollmentId,
        step.id,
        contact.id,
        account.id,
        template.id,
        contact.email,
        account.email,
        rendered.subject,
        rendered.bodyHtml,
        abVariant,
      ]
    );

    const emailSendId = sendResult.rows[0].id;

    // Update enrollment current step
    await query(
      `UPDATE sequence_enrollments SET current_step = $1, updated_at = NOW() WHERE id = $2`,
      [stepNumber, enrollmentId]
    );

    // Add to email send queue (with random delay)
    const { Queue: BullQueue } = await import('bullmq');
    const sendQueue = new BullQueue('email-sends', {
      connection: getRedisConnection(),
    });

    const minDelay = parseInt(process.env.SEND_DELAY_MIN_SECONDS || '30', 10) * 1000;
    const maxDelay = parseInt(process.env.SEND_DELAY_MAX_SECONDS || '120', 10) * 1000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    await sendQueue.add(
      'send-email',
      { emailSendId, threadId, fromName: account.display_name || undefined },
      { delay }
    );

    await sendQueue.close();

    // Schedule next step
    const nextStepResult = await query<SequenceStep>(
      `SELECT * FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
      [enrollment.sequence_id, stepNumber + 1]
    );

    if (nextStepResult.rows[0]) {
      const nextStep = nextStepResult.rows[0];
      const delayMs =
        (nextStep.delay_days * 24 * 60 * 60 * 1000) +
        (nextStep.delay_hours * 60 * 60 * 1000);
      const scheduledTime = this.adjustForWindow(
        new Date(Date.now() + delayMs),
        sequence
      );
      const adjustedDelayMs = scheduledTime.getTime() - Date.now();
      await this.scheduleStep(enrollmentId, stepNumber + 1, Math.max(0, adjustedDelayMs));
    }

    console.log(`[Sequence Engine] Step ${stepNumber} queued for enrollment ${enrollmentId}`);
  }

  async cancelEnrollment(enrollmentId: string, reason: string): Promise<void> {
    console.log(`[Sequence Engine] Cancelling enrollment ${enrollmentId}: ${reason}`);

    const status = reason === 'replied' ? 'replied' : 'cancelled';
    const updates: Record<string, unknown> = {
      status,
      updated_at: new Date(),
    };

    if (reason === 'replied') {
      updates.replied_at = new Date();
    }

    await query(
      `UPDATE sequence_enrollments
       SET status = $1, ${reason === 'replied' ? 'replied_at = NOW(),' : ''} updated_at = NOW()
       WHERE id = $2`,
      [status, enrollmentId]
    );

    // Remove pending BullMQ jobs for this enrollment
    try {
      const jobs = await this.stepQueue.getJobs(['delayed', 'waiting']);
      for (const job of jobs) {
        if (job.data.enrollmentId === enrollmentId) {
          await job.remove();
          console.log(`[Sequence Engine] Removed pending job for enrollment ${enrollmentId}`);
        }
      }
    } catch (err) {
      console.error(`[Sequence Engine] Error removing jobs for enrollment ${enrollmentId}:`, err);
    }
  }

  async scheduleStep(enrollmentId: string, stepNumber: number, delayMs: number): Promise<void> {
    await this.stepQueue.add(
      'process-step',
      { enrollmentId, stepNumber },
      {
        delay: delayMs,
        jobId: `enrollment-${enrollmentId}-step-${stepNumber}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );
    console.log(
      `[Sequence Engine] Scheduled step ${stepNumber} for enrollment ${enrollmentId} (delay: ${Math.round(delayMs / 1000)}s)`
    );
  }

  /**
   * Adjust a scheduled time to fall within the sequence's send window.
   * Respects skip_weekends and send_window_start/end (treated as UTC).
   */
  private adjustForWindow(scheduledTime: Date, sequence: Sequence): Date {
    let dt = new Date(scheduledTime);

    const [startH, startM] = (sequence.send_window_start || '08:00').split(':').map(Number);
    const [endH, endM] = (sequence.send_window_end || '18:00').split(':').map(Number);

    const windowStartMinutes = startH * 60 + startM;
    const windowEndMinutes = endH * 60 + endM;

    // Try up to 7 iterations to find a valid window slot
    for (let i = 0; i < 7; i++) {
      const dayOfWeek = dt.getUTCDay(); // 0=Sun, 6=Sat

      // Skip weekends
      if (sequence.skip_weekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
        // Move to Monday 9am UTC
        const daysToAdd = dayOfWeek === 6 ? 2 : 1;
        dt = new Date(dt);
        dt.setUTCDate(dt.getUTCDate() + daysToAdd);
        dt.setUTCHours(startH, startM, 0, 0);
        continue;
      }

      const currentMinutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();

      if (currentMinutes < windowStartMinutes) {
        // Before window: move to window start
        dt.setUTCHours(startH, startM, 0, 0);
        break;
      } else if (currentMinutes >= windowEndMinutes) {
        // After window: move to next day window start
        dt.setUTCDate(dt.getUTCDate() + 1);
        dt.setUTCHours(startH, startM, 0, 0);
        continue;
      } else {
        // Within window
        break;
      }
    }

    return dt;
  }

  async close(): Promise<void> {
    await this.stepQueue.close();
  }
}

export const sequenceEngine = new SequenceEngine();
