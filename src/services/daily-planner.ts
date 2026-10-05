/**
 * Hourly planner: runs each hour, but only plans inside the single send window
 * (Mon-Fri 08:00-17:00 Europe/London, see send-gate.ts).
 * Picks up enrollments whose next_step_due_at <= NOW(), fair-distributes
 * across accounts respecting hourly_limit AND daily_limit, creates
 * email_sends + BullMQ jobs.
 *
 * Replaces the thundering-herd-prone processStep → getBestSendingAccount flow.
 */
import { Queue } from 'bullmq';
import { query, TENANT, BULL_PREFIX } from '../db/connection';
import { getRedisConnection } from '../db/redis';
import { templateEngine } from './template-engine';
import {
  isWithinSendWindow, nextSendWindowStart, msUntilSendWindowCloses,
  isSuppressed, isInternalAddress, COLD_SENDER_DOMAIN,
} from './send-gate';
import { EmailAccount, Sequence, SequenceStep, Contact, Template } from '../types';

/** Max failed attempts at one step before the enrollment is cancelled. */
const MAX_FAILED_ATTEMPTS_PER_STEP = 5;

/** Queued sends older than this are treated as lost and no longer block planning. */
const STALE_QUEUED_INTERVAL = '2 days';

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

    // 0. Never plan outside the send window (weekends / out of hours)
    if (!isWithinSendWindow(new Date())) {
      console.log(`[Planner] Outside send window (Mon-Fri 08:00-17:00 Europe/London) for ${TENANT}, not planning`);
      return result;
    }

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
       WHERE tenant = $1 AND is_active = true AND LOWER(email) LIKE $2
       ORDER BY email`,
      [TENANT, '%@' + COLD_SENDER_DOMAIN]
    );

    if (accounts.rows.length === 0) {
      console.error(`[Planner] No active accounts for ${TENANT}`);
      return result;
    }

    // 3. Build per-account budget for this hour: min(remaining hourly, remaining daily).
    // Accounts with a 0 limit get no budget.
    const budget: Map<string, number> = new Map();
    for (const acct of accounts.rows) {
      const hourlyLimit = Number(acct.hourly_limit) || 0;
      const dailyLimit = Number(acct.daily_limit) || 0;
      if (hourlyLimit <= 0 || dailyLimit <= 0) {
        budget.set(acct.id, 0);
        continue;
      }
      const remainingHour = Math.max(0, hourlyLimit - (Number(acct.sends_this_hour) || 0));
      const remainingDay = Math.max(0, dailyLimit - (Number(acct.sends_today) || 0));
      budget.set(acct.id, Math.min(remainingHour, remainingDay));
      result.distribution[acct.email] = 0;
    }

    // Jitter spreads sends across the hour, but never past the window close
    const maxJitterMs = Math.max(60000, Math.min(3300000, msUntilSendWindowCloses(new Date()) - 60000));

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

          // Queued sends older than 2 days are lost (no job will ever send them).
          // Retire them so they neither block planning nor get re-sent later
          // alongside the replacement we're about to create.
          await query(
            `UPDATE email_sends SET status = 'failed', error_message = 'superseded (stale queued)'
             WHERE enrollment_id = $1 AND tenant = $2 AND status = 'queued'
               AND created_at < NOW() - INTERVAL '${STALE_QUEUED_INTERVAL}'`,
            [enrollment.id, TENANT]
          );

          // Guard: if this enrollment has a recent queued (or in-flight) send for any
          // step, skip — the send queue will process it and the post-send hook
          // schedules next.
          const pendingSend = await query<{ id: string }>(
            `SELECT id FROM email_sends
             WHERE enrollment_id = $1 AND tenant = $2
               AND (status = 'sending'
                    OR (status = 'queued' AND created_at >= NOW() - INTERVAL '${STALE_QUEUED_INTERVAL}'))
             LIMIT 1`,
            [enrollment.id, TENANT]
          );
          if (pendingSend.rows.length > 0) {
            result.alreadySent++;
            continue;
          }

          // Idempotency: check if email already sent for this specific step
          const existing = await query<{ id: string; status: string }>(
            `SELECT id, status FROM email_sends
             WHERE enrollment_id = $1 AND sequence_step_id = $2 AND tenant = $3
               AND status = 'sent'
             LIMIT 1`,
            [enrollment.id, step.id, TENANT]
          );

          if (existing.rows.length > 0) {
            // Already sent — schedule next step instead.
            result.alreadySent++;
            await this.scheduleNextStepOnEnrollment(enrollment.id, step);
            continue;
          }
          // Only 'failed' rows (or none) — create a new email_send below

          // Check contact is valid BEFORE taking a budget slot
          const contactResult = await query<Contact & { contact_type?: string | null }>(
            `SELECT * FROM contacts WHERE id = $1 AND tenant = $2`,
            [enrollment.contact_id, TENANT]
          );
          const contact = contactResult.rows[0];
          if (!contact) {
            result.skipped++;
            await this.clearEnrollmentSchedule(enrollment.id);
            continue;
          }
          const internal = isInternalAddress(contact.email);
          const isLender = !internal && (contact.contact_type || '').toLowerCase() === 'lender';
          if (
            isLender ||
            contact.tags?.includes('unsubscribed') ||
            contact.tags?.includes('bounced') ||
            // Skip suppressed emails BEFORE creating a send — otherwise the
            // send-gate rejects it and it burns a budget slot.
            await isSuppressed(contact.email)
          ) {
            await this.cancelEnrollment(enrollment.id);
            result.skipped++;
            continue;
          }
          if (!internal && contact.tags?.includes('hold')) {
            // On hold: leave next_step_due_at as-is, re-checked next run
            result.skipped++;
            continue;
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

          // Enqueue with jitter (spread across the hour: 0-55min, capped at window close)
          const jitterMs = Math.floor(Math.random() * maxJitterMs);
          await sendQueue.add(
            'send-email',
            buildSendJobData(emailSendId, threadId, assigned.display_name),
            { delay: jitterMs }
          );
          // last_enqueued_at = when the job is due to fire (enqueue time + delay),
          // so requeueStuckSends only treats it as lost well after that time.
          await query(
            `UPDATE email_sends SET last_enqueued_at = NOW() + ($1::int * INTERVAL '1 millisecond') WHERE id = $2`,
            [jitterMs, emailSendId]
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

    // Current (just-sent) step. scheduleNextStepOnEnrollment looks up step+1
    // itself — previously this passed the NEXT step, which skipped a step.
    const stepResult = await query<SequenceStep>(
      `SELECT * FROM sequence_steps WHERE id = $1`,
      [send.sequence_step_id]
    );
    if (!stepResult.rows[0]) return;

    await this.scheduleNextStepOnEnrollment(send.enrollment_id, stepResult.rows[0]);
  }

  private async scheduleNextStepOnEnrollment(
    enrollmentId: string,
    currentStep: SequenceStep,
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
    const adjustedDue = nextSendWindowStart(rawDue);

    await query(
      `UPDATE sequence_enrollments
       SET next_step_number = $1, next_step_due_at = $2, updated_at = NOW()
       WHERE id = $3`,
      [nextStep.step_number, adjustedDue, enrollmentId]
    );
  }

  /**
   * A sequence send ended 'failed'. Called by the send worker and the re-queue
   * cron so the enrollment is never left stranded with next_step_due_at = NULL
   * (the planner clears it when it queues a send).
   *
   *   permanent=true  → recipient must not be emailed: cancel the enrollment.
   *   permanent=false → transient (Gmail/auth/account/etc): retry the same step
   *                     in ~1 day (inside the send window). After
   *                     MAX_FAILED_ATTEMPTS_PER_STEP failures the enrollment is cancelled.
   */
  async handleFailedSend(emailSendId: string, reason: string, permanent: boolean): Promise<void> {
    const r = await query<{ enrollment_id: string | null; sequence_step_id: string | null; step_number: number | null }>(
      `SELECT es.enrollment_id, es.sequence_step_id, ss.step_number
       FROM email_sends es
       LEFT JOIN sequence_steps ss ON ss.id = es.sequence_step_id
       WHERE es.id = $1 AND es.tenant = $2`,
      [emailSendId, TENANT]
    );
    const send = r.rows[0];
    if (!send?.enrollment_id) return;

    if (permanent) {
      console.log(`[Planner] Cancelling enrollment ${send.enrollment_id} after permanent failure: ${reason}`);
      await this.cancelEnrollment(send.enrollment_id);
      return;
    }

    if (send.sequence_step_id) {
      const attempts = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM email_sends
         WHERE enrollment_id = $1 AND sequence_step_id = $2 AND tenant = $3 AND status = 'failed'`,
        [send.enrollment_id, send.sequence_step_id, TENANT]
      );
      if (parseInt(attempts.rows[0]?.count || '0', 10) >= MAX_FAILED_ATTEMPTS_PER_STEP) {
        console.log(`[Planner] Cancelling enrollment ${send.enrollment_id}: ${MAX_FAILED_ATTEMPTS_PER_STEP}+ failed attempts at this step (last: ${reason})`);
        await this.cancelEnrollment(send.enrollment_id);
        return;
      }
    }

    const retryAt = nextSendWindowStart(new Date(Date.now() + 86400000));
    await query(
      `UPDATE sequence_enrollments
       SET next_step_number = COALESCE($1, next_step_number, current_step),
           next_step_due_at = $2, updated_at = NOW()
       WHERE id = $3 AND tenant = $4 AND status = 'active' AND next_step_due_at IS NULL`,
      [send.step_number, retryAt, send.enrollment_id, TENANT]
    );
  }

  private async cancelEnrollment(enrollmentId: string): Promise<void> {
    await query(
      `UPDATE sequence_enrollments
       SET status = 'cancelled', updated_at = NOW(),
           next_step_due_at = NULL, next_step_number = NULL
       WHERE id = $1 AND tenant = $2 AND status = 'active'`,
      [enrollmentId, TENANT]
    );
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

/**
 * Job payload for the email-sends queue. The planner and requeueStuckSends both
 * build it here so re-queued jobs keep threading + display name.
 */
export function buildSendJobData(
  emailSendId: string,
  threadId: string | null | undefined,
  displayName: string | null | undefined,
): { emailSendId: string; threadId?: string; fromName?: string } {
  return {
    emailSendId,
    threadId: threadId || undefined,
    fromName: displayName || undefined,
  };
}

export const dailyPlanner = new DailyPlanner();
