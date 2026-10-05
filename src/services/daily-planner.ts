/**
 * Hourly planner: runs each hour during the send window (09-16 UTC).
 * Picks up enrollments whose next_step_due_at <= NOW(), fair-distributes
 * across accounts respecting hourly_limit, creates email_sends + BullMQ jobs.
 *
 * Replaces the thundering-herd-prone processStep → getBestSendingAccount flow.
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { templateEngine } from './template-engine';
import { EmailAccount, Sequence, SequenceStep, Contact, Template } from '../types';

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

interface DueEnrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
  next_step_number: number;
  next_step_due_at: Date;
}

interface PlanResult {
  planned: number;
  skipped: number;
  overflow: number;
  alreadySent: number;
  distribution: Record<string, number>;
}

export class DailyPlanner {
  async plan(): Promise<PlanResult> {
    const result: PlanResult = {
      planned: 0,
      skipped: 0,
      overflow: 0,
      alreadySent: 0,
      distribution: {},
    };

    // 1. Get due enrollments
    const due = await query<DueEnrollment>(
      `SELECT id, sequence_id, contact_id, current_step, next_step_number, next_step_due_at
       FROM sequence_enrollments
       WHERE tenant = $1
         AND status = 'active'
         AND next_step_due_at IS NOT NULL
         AND next_step_due_at <= NOW()
       ORDER BY next_step_due_at ASC`,
      [TENANT]
    );

    if (due.rows.length === 0) {
      console.log(`[Planner] No due enrollments for ${TENANT}`);
      return result;
    }

    console.log(`[Planner] ${due.rows.length} due enrollments for ${TENANT}`);

    // 2. Get healthy accounts for this tenant
    const accounts = await query<EmailAccount>(
      `SELECT * FROM email_accounts
       WHERE tenant = $1 AND is_active = true
       ORDER BY email`,
      [TENANT]
    );

    if (accounts.rows.length === 0) {
      console.error(`[Planner] No active accounts for ${TENANT}`);
      return result;
    }

    // 3. Build per-account budget for this hour
    const budget: Map<string, number> = new Map();
    for (const acct of accounts.rows) {
      const remaining = Math.max(0, acct.hourly_limit - acct.sends_this_hour);
      budget.set(acct.id, remaining);
      result.distribution[acct.email] = 0;
    }

    // 4. Cache sequences + steps to avoid repeated queries
    const seqCache = new Map<string, Sequence>();
    const stepCache = new Map<string, SequenceStep>();
    const templateCache = new Map<string, Template>();

    // 5. Group enrollments by sequence for round-robin within each
    const bySequence = new Map<string, DueEnrollment[]>();
    for (const e of due.rows) {
      const arr = bySequence.get(e.sequence_id) || [];
      arr.push(e);
      bySequence.set(e.sequence_id, arr);
    }

    // 6. Open BullMQ send queue
    const sendQueue = new Queue('email-sends', {
      connection: getRedisConnection(),
      prefix: BULL_PREFIX,
      defaultJobOptions: { removeOnComplete: 200, removeOnFail: 100 },
    });

    try {
      for (const [sequenceId, enrollments] of bySequence) {
        // Fetch sequence (cached)
        let sequence = seqCache.get(sequenceId);
        if (!sequence) {
          const r = await query<Sequence>(
            `SELECT * FROM sequences WHERE id = $1 AND tenant = $2`,
            [sequenceId, TENANT]
          );
          if (!r.rows[0] || r.rows[0].status !== 'active') {
            result.skipped += enrollments.length;
            continue;
          }
          sequence = r.rows[0];
          seqCache.set(sequenceId, sequence);
        }

        // Get eligible accounts for this sequence
        const seqAccountIds = sequence.sending_account_ids || [];
        const eligible = seqAccountIds.length > 0
          ? accounts.rows.filter(a => seqAccountIds.includes(a.id))
          : accounts.rows;

        if (eligible.length === 0) {
          result.skipped += enrollments.length;
          continue;
        }

        // Round-robin cursor for this sequence
        let cursor = 0;

        for (const enrollment of enrollments) {
          // Fetch step definition (cached)
          const stepKey = `${sequenceId}:${enrollment.next_step_number}`;
          let step = stepCache.get(stepKey);
          if (!step) {
            const r = await query<SequenceStep>(
              `SELECT * FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
              [sequenceId, enrollment.next_step_number]
            );
            if (!r.rows[0]) {
              // No more steps — complete the enrollment
              await query(
                `UPDATE sequence_enrollments
                 SET status = 'completed', completed_at = NOW(),
                     next_step_due_at = NULL, next_step_number = NULL,
                     updated_at = NOW()
                 WHERE id = $1`,
                [enrollment.id]
              );
              result.skipped++;
              continue;
            }
            step = r.rows[0];
            stepCache.set(stepKey, step);
          }

          // Guard: if this enrollment has ANY queued send (for any step), skip —
          // the send queue will process it and the post-send hook schedules next.
          const pendingSend = await query<{ id: string }>(
            `SELECT id FROM email_sends
             WHERE enrollment_id = $1 AND tenant = $2 AND status = 'queued'
             LIMIT 1`,
            [enrollment.id, TENANT]
          );
          if (pendingSend.rows.length > 0) {
            result.alreadySent++;
            continue;
          }

          // Idempotency: check if email already exists for this specific step
          const existing = await query<{ id: string; status: string }>(
            `SELECT id, status FROM email_sends
             WHERE enrollment_id = $1 AND sequence_step_id = $2 AND tenant = $3
             LIMIT 1`,
            [enrollment.id, step.id, TENANT]
          );

          if (existing.rows.length > 0) {
            const s = existing.rows[0].status;
            if (s === 'sent') {
              // Already sent — schedule next step instead.
              result.alreadySent++;
              await this.scheduleNextStepOnEnrollment(enrollment.id, step, sequence);
              continue;
            }
            if (s === 'queued') {
              result.alreadySent++;
              continue;
            }
            // 'failed' — we'll re-attempt with a new email_send below
          }

          // Find an account with budget (round-robin across eligible)
          let assigned: EmailAccount | null = null;
          for (let i = 0; i < eligible.length; i++) {
            const candidate = eligible[(cursor + i) % eligible.length];
            const remaining = budget.get(candidate.id) || 0;
            if (remaining > 0) {
              assigned = candidate;
              budget.set(candidate.id, remaining - 1);
              cursor = (cursor + i + 1) % eligible.length;
              break;
            }
          }

          if (!assigned) {
            // All accounts at capacity for this hour — overflow
            result.overflow++;
            continue;
          }

          // Check contact is valid
          const contactResult = await query<Contact>(
            `SELECT * FROM contacts WHERE id = $1 AND tenant = $2`,
            [enrollment.contact_id, TENANT]
          );
          const contact = contactResult.rows[0];
          if (!contact) {
            result.skipped++;
            await this.clearEnrollmentSchedule(enrollment.id);
            continue;
          }
          if (contact.tags?.includes('unsubscribed') || contact.tags?.includes('bounced')) {
            await query(
              `UPDATE sequence_enrollments
               SET status = 'cancelled', updated_at = NOW(),
                   next_step_due_at = NULL, next_step_number = NULL
               WHERE id = $1`,
              [enrollment.id]
            );
            result.skipped++;
            continue;
          }
          // Skip suppressed emails (unsubscribed / bounced / manual) BEFORE creating a
          // send — otherwise the send-gate rejects it and it burns a daily-budget slot.
          const supp = await query<{ id: string }>(
            `SELECT id FROM suppressed_emails WHERE LOWER(email) = LOWER($1) AND tenant = $2 LIMIT 1`,
            [contact.email, TENANT]
          );
          if (supp.rows.length > 0) {
            await query(
              `UPDATE sequence_enrollments
               SET status = 'cancelled', updated_at = NOW(),
                   next_step_due_at = NULL, next_step_number = NULL
               WHERE id = $1`,
              [enrollment.id]
            );
            result.skipped++;
            continue;
          }

          // Resolve template (A/B testing)
          let templateId = step.template_id;
          let abVariant: 'A' | 'B' | null = null;
          if (step.variant_template_id && step.variant_split) {
            if (Math.random() * 100 < step.variant_split) {
              abVariant = 'B';
              templateId = step.variant_template_id;
            } else {
              abVariant = 'A';
            }
          }

          if (!templateId) {
            result.skipped++;
            continue;
          }

          // Fetch template (cached)
          let template = templateCache.get(templateId);
          if (!template) {
            const r = await query<Template>(
              `SELECT * FROM templates WHERE id = $1 AND tenant = $2`,
              [templateId, TENANT]
            );
            if (!r.rows[0]) {
              result.skipped++;
              continue;
            }
            template = r.rows[0];
            templateCache.set(templateId, template);
          }

          // Render
          const rendered = templateEngine.renderTemplate(template, contact);

          // Thread continuity
          const prevSend = await query<{ gmail_thread_id: string }>(
            `SELECT gmail_thread_id FROM email_sends
             WHERE enrollment_id = $1 AND gmail_thread_id IS NOT NULL AND tenant = $2
             ORDER BY created_at ASC LIMIT 1`,
            [enrollment.id, TENANT]
          );
          const threadId = prevSend.rows[0]?.gmail_thread_id;

          // Create email_sends record
          const sendResult = await query<{ id: string }>(
            `INSERT INTO email_sends (
              enrollment_id, sequence_step_id, contact_id, email_account_id, template_id,
              to_email, from_email, subject, body_html, status, ab_variant, tenant
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11)
            RETURNING id`,
            [
              enrollment.id, step.id, contact.id, assigned.id, template.id,
              contact.email, assigned.email, rendered.subject, rendered.bodyHtml,
              abVariant, TENANT,
            ]
          );
          const emailSendId = sendResult.rows[0].id;

          // Update enrollment current_step
          await query(
            `UPDATE sequence_enrollments
             SET current_step = $1, updated_at = NOW(),
                 next_step_due_at = NULL, next_step_number = NULL
             WHERE id = $2`,
            [enrollment.next_step_number, enrollment.id]
          );

          // Enqueue with jitter (spread across the hour: 0-3300s = 0-55min)
          const jitterMs = Math.floor(Math.random() * 3300000);
          await sendQueue.add(
            'send-email',
            { emailSendId, threadId, fromName: assigned.display_name || undefined },
            { delay: jitterMs }
          );

          result.distribution[assigned.email] = (result.distribution[assigned.email] || 0) + 1;
          result.planned++;
        }
      }
    } finally {
      await sendQueue.close();
    }

    // Log plan
    await query(
      `INSERT INTO daily_send_plans (tenant, plan_date, plan_hour, total_planned, total_skipped, overflow_count, account_distribution)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)`,
      [
        TENANT,
        new Date().getUTCHours(),
        result.planned,
        result.skipped,
        result.overflow,
        JSON.stringify(result.distribution),
      ]
    );

    console.log(
      `[Planner] ${TENANT}: planned=${result.planned}, skipped=${result.skipped}, ` +
      `overflow=${result.overflow}, alreadySent=${result.alreadySent}, ` +
      `distribution=${JSON.stringify(result.distribution)}`
    );

    return result;
  }

  /**
   * After a send succeeds, schedule the next step on the enrollment.
   * Called from processEmailSend (post-send hook).
   */
  async scheduleNextStep(emailSendId: string): Promise<void> {
    const sendResult = await query<{
      enrollment_id: string | null;
      sequence_step_id: string;
    }>(
      `SELECT enrollment_id, sequence_step_id FROM email_sends WHERE id = $1 AND tenant = $2`,
      [emailSendId, TENANT]
    );
    const send = sendResult.rows[0];
    if (!send?.enrollment_id) return;

    // Get current step number
    const stepResult = await query<{ step_number: number; sequence_id: string }>(
      `SELECT step_number, sequence_id FROM sequence_steps WHERE id = $1`,
      [send.sequence_step_id]
    );
    if (!stepResult.rows[0]) return;
    const { step_number, sequence_id } = stepResult.rows[0];

    // Get next step
    const nextStep = await query<SequenceStep>(
      `SELECT * FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
      [sequence_id, step_number + 1]
    );

    if (!nextStep.rows[0]) {
      // No more steps — complete enrollment
      await query(
        `UPDATE sequence_enrollments
         SET status = 'completed', completed_at = NOW(),
             next_step_due_at = NULL, next_step_number = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [send.enrollment_id]
      );
      return;
    }

    // Get sequence for window adjustment
    const seqResult = await query<Sequence>(
      `SELECT * FROM sequences WHERE id = $1`,
      [sequence_id]
    );
    const sequence = seqResult.rows[0];
    if (!sequence) return;

    await this.scheduleNextStepOnEnrollment(send.enrollment_id, nextStep.rows[0], sequence);
  }

  private async scheduleNextStepOnEnrollment(
    enrollmentId: string,
    currentStep: SequenceStep,
    sequence: Sequence,
  ): Promise<void> {
    const nextStepResult = await query<SequenceStep>(
      `SELECT * FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
      [currentStep.sequence_id, currentStep.step_number + 1]
    );

    if (!nextStepResult.rows[0]) {
      await query(
        `UPDATE sequence_enrollments
         SET status = 'completed', completed_at = NOW(),
             next_step_due_at = NULL, next_step_number = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [enrollmentId]
      );
      return;
    }

    const nextStep = nextStepResult.rows[0];
    const delayMs = (nextStep.delay_days * 86400000) + (nextStep.delay_hours * 3600000);
    const rawDue = new Date(Date.now() + delayMs);
    const adjustedDue = this.adjustForWindow(rawDue, sequence);

    await query(
      `UPDATE sequence_enrollments
       SET next_step_number = $1, next_step_due_at = $2, updated_at = NOW()
       WHERE id = $3`,
      [nextStep.step_number, adjustedDue, enrollmentId]
    );
  }

  private adjustForWindow(scheduledTime: Date, sequence: Sequence): Date {
    let dt = new Date(scheduledTime);
    const [startH, startM] = (sequence.send_window_start || '09:00').split(':').map(Number);
    const [endH, endM] = (sequence.send_window_end || '17:00').split(':').map(Number);
    const windowStartMin = startH * 60 + startM;
    const windowEndMin = endH * 60 + endM;

    for (let i = 0; i < 7; i++) {
      const dow = dt.getUTCDay();
      if (sequence.skip_weekends && (dow === 0 || dow === 6)) {
        const daysToAdd = dow === 6 ? 2 : 1;
        dt.setUTCDate(dt.getUTCDate() + daysToAdd);
        dt.setUTCHours(startH, startM, 0, 0);
        continue;
      }
      const curMin = dt.getUTCHours() * 60 + dt.getUTCMinutes();
      if (curMin < windowStartMin) {
        dt.setUTCHours(startH, startM, 0, 0);
        break;
      } else if (curMin >= windowEndMin) {
        dt.setUTCDate(dt.getUTCDate() + 1);
        dt.setUTCHours(startH, startM, 0, 0);
        continue;
      } else {
        break;
      }
    }
    return dt;
  }

  private async clearEnrollmentSchedule(enrollmentId: string): Promise<void> {
    await query(
      `UPDATE sequence_enrollments
       SET next_step_due_at = NULL, next_step_number = NULL, updated_at = NOW()
       WHERE id = $1`,
      [enrollmentId]
    );
  }
}

export const dailyPlanner = new DailyPlanner();
