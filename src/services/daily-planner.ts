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
  isInternalAddress, isBulkOrRoleAddress, COLD_SENDER_DOMAIN,
} from './send-gate';
import { EmailAccount, Sequence, SequenceStep, Contact, Template } from '../types';

/** Max failed attempts at one step before the enrollment is cancelled. */
const MAX_FAILED_ATTEMPTS_PER_STEP = 5;

/** Queued sends older than this are treated as lost and no longer block planning. */
const STALE_QUEUED_INTERVAL = '2 days';

/** Planned fire times never go past this offset (spread across the hour). */
const PLAN_HORIZON_MS = 55 * 60 * 1000;

/** Fire times stay at least this far before the window closes (17:00 London). */
const WINDOW_CLOSE_SAFETY_MS = 2000;

/** Due enrollments fetched per pass = budget * factor (min budget + floor). */
const DUE_FETCH_FACTOR = 4;
const DUE_FETCH_FLOOR = 100;

/** Stranded rows (active, no due date, nothing in flight) untouched this long are made due again. */
const STRANDED_GRACE_INTERVAL = '5 minutes';

interface DueEnrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
  next_step_number: number;
  next_step_due_at: Date;
  never_emailed: boolean;
}

interface PlanResult {
  planned: number;
  skipped: number;
  overflow: number;
  alreadySent: number;
  distribution: Record<string, number>;
}

interface PlannedItem {
  enrollment: DueEnrollment;
  step: SequenceStep;
  contact: Contact;
  template: Template;
  abVariant: 'A' | 'B' | null;
  account: EmailAccount;
  offsetMs: number;
}

type AccountRow = EmailAccount & { pending: number; last_fire_offset_ms: number | null };

/**
 * Fire-time offsets (ms from now) for `n` sends on one account in
 * [startMs, horizonMs): one slot each, evenly spread, with jitter inside the
 * slot that keeps consecutive sends >= gapMs apart. Exported for tests.
 */
export function spreadFireOffsets(n: number, startMs: number, horizonMs: number, gapMs: number): number[] {
  if (n <= 0 || horizonMs <= startMs) return [];
  const slot = (horizonMs - startMs) / n;
  const jitterRange = Math.max(0, slot - gapMs);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = startMs + i * slot + Math.random() * jitterRange;
    out.push(Math.max(0, Math.min(Math.floor(t), horizonMs - 1)));
  }
  return out;
}

/** How many sends fit in [startMs, horizonMs) with >= gapMs between them. */
export function sendsThatFit(startMs: number, horizonMs: number, gapMs: number): number {
  const room = horizonMs - startMs;
  if (room <= 0) return 0;
  if (gapMs <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(room / gapMs));
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

    // 0. Never plan outside the send window (weekends / out of hours), and
    // never plan a fire time at/after the close: if there is no time left in
    // this window the work waits for the next one.
    const now = new Date();
    if (!isWithinSendWindow(now)) {
      console.log(`[Planner] Outside send window (Mon-Fri 08:00-17:00 Europe/London) for ${TENANT}, not planning`);
      return result;
    }
    const horizonMs = Math.min(PLAN_HORIZON_MS, msUntilSendWindowCloses(now) - WINDOW_CLOSE_SAFETY_MS);
    if (horizonMs <= 0) {
      console.log(`[Planner] Send window about to close for ${TENANT}, not planning`);
      return result;
    }

    // 1. Set-based housekeeping (one statement each per pass).
    // a) Queued sequence sends whose fire time is > 2 days old are lost (no job
    //    will ever send them): retire them so they neither block planning nor
    //    get re-sent alongside a replacement.
    await query(
      `UPDATE email_sends SET status = 'failed', error_message = 'superseded (stale queued)'
       WHERE tenant = $1 AND status = 'queued' AND enrollment_id IS NOT NULL
         AND COALESCE(last_enqueued_at, created_at) < NOW() - INTERVAL '${STALE_QUEUED_INTERVAL}'`,
      [TENANT]
    );
    // b) Stranded enrollments: active, no due date, nothing queued/sending
    //    (e.g. the send was cancelled by an admin, or a bookkeeping error).
    //    Make them due again. next_step_number = the current step: if it was
    //    actually sent, the idempotency check below advances to the next step
    //    with its proper delay; otherwise the same step is retried.
    await query(
      `UPDATE sequence_enrollments se
       SET next_step_due_at = NOW(),
           next_step_number = COALESCE(se.next_step_number, GREATEST(se.current_step, 1)),
           updated_at = NOW()
       WHERE se.tenant = $1 AND se.status = 'active' AND se.next_step_due_at IS NULL
         AND se.updated_at < NOW() - INTERVAL '${STRANDED_GRACE_INTERVAL}'
         AND NOT EXISTS (
           SELECT 1 FROM email_sends es
           WHERE es.enrollment_id = se.id AND es.tenant = se.tenant
             AND es.status IN ('queued', 'sending')
         )`,
      [TENANT]
    );

    // 2. Healthy accounts + what they already have queued but not yet sent.
    // Queued-unsent sends are not in sends_this_hour/sends_today yet (the gate
    // counts at send time), so without this a second pass in the same hour
    // would plan the whole budget again.
    const accounts = await query<AccountRow>(
      `WITH p AS (
         SELECT email_account_id, COUNT(*)::int AS pending, MAX(last_enqueued_at) AS last_fire
         FROM email_sends
         WHERE tenant = $1 AND status = 'queued' AND last_enqueued_at > NOW() - INTERVAL '1 hour'
         GROUP BY email_account_id
       )
       SELECT ea.*, COALESCE(p.pending, 0)::int AS pending,
              CASE WHEN p.last_fire > NOW()
                   THEN (EXTRACT(EPOCH FROM (p.last_fire - NOW())) * 1000)::float8
                   ELSE NULL END AS last_fire_offset_ms
       FROM email_accounts ea
       LEFT JOIN p ON p.email_account_id = ea.id
       WHERE ea.tenant = $1 AND ea.is_active = true AND LOWER(ea.email) LIKE $2
       ORDER BY ea.email`,
      [TENANT, '%@' + COLD_SENDER_DOMAIN]
    );

    if (accounts.rows.length === 0) {
      console.error(`[Planner] No active accounts for ${TENANT}`);
      return result;
    }

    const gapMs = await this.sendGapMs();

    // 3. Per-account budget for this pass:
    //    min(remaining hourly, remaining daily) - already queued, capped by how
    //    many sends fit before the horizon at >= send_gap_minutes spacing
    //    (starting after the account's latest already-queued fire time).
    const budget = new Map<string, number>();
    const startOffset = new Map<string, number>();
    for (const acct of accounts.rows) {
      result.distribution[acct.email] = 0;
      const hourlyLimit = Number(acct.hourly_limit) || 0;
      const dailyLimit = Number(acct.daily_limit) || 0;
      if (hourlyLimit <= 0 || dailyLimit <= 0) {
        budget.set(acct.id, 0);
        continue;
      }
      const pending = Number(acct.pending) || 0;
      const remainingHour = hourlyLimit - (Number(acct.sends_this_hour) || 0) - pending;
      const remainingDay = dailyLimit - (Number(acct.sends_today) || 0) - pending;
      const lastFire = acct.last_fire_offset_ms == null ? null : Number(acct.last_fire_offset_ms);
      const start = lastFire == null ? 0 : lastFire + gapMs;
      startOffset.set(acct.id, start);
      budget.set(acct.id, Math.max(0, Math.min(remainingHour, remainingDay, sendsThatFit(start, horizonMs, gapMs))));
    }

    const totalBudget = Array.from(budget.values()).reduce((a, b) => a + b, 0);
    if (totalBudget === 0) {
      result.overflow = await this.countDue();
      console.log(`[Planner] ${TENANT}: no account has budget left this hour (due=${result.overflow}), not planning`);
      return result;
    }

    // 4. Fetch only as many due enrollments as the budget can use, in priority
    // order: never-emailed contacts first, then round-robin across sequences
    // (rn = position within its sequence) so one big sequence with old due
    // items cannot take the whole budget, then oldest due first.
    // Enrollments with a send in flight, on hold, or in a non-active sequence
    // are filtered out in SQL so they do not consume the fetch.
    const fetchLimit = Math.max(totalBudget * DUE_FETCH_FACTOR, totalBudget + DUE_FETCH_FLOOR);
    const due = await query<DueEnrollment>(
      `WITH due AS (
         SELECT se.id, se.sequence_id, se.contact_id, se.current_step, se.next_step_number, se.next_step_due_at,
                NOT EXISTS (
                  SELECT 1 FROM email_sends x
                  WHERE x.contact_id = se.contact_id AND x.tenant = se.tenant AND x.status = 'sent'
                ) AS never_emailed
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id AND s.tenant = se.tenant AND s.status = 'active'
         WHERE se.tenant = $1
           AND se.status = 'active'
           AND se.next_step_due_at IS NOT NULL
           AND se.next_step_due_at <= NOW()
           AND NOT EXISTS (
             SELECT 1 FROM email_sends p
             WHERE p.enrollment_id = se.id AND p.tenant = se.tenant
               AND (p.status = 'sending'
                    OR (p.status = 'queued'
                        AND COALESCE(p.last_enqueued_at, p.created_at) >= NOW() - INTERVAL '${STALE_QUEUED_INTERVAL}'))
           )
           AND NOT EXISTS (
             SELECT 1 FROM contacts hc
             WHERE hc.id = se.contact_id AND hc.tenant = se.tenant
               AND 'hold' = ANY(COALESCE(hc.tags, ARRAY[]::text[]))
               AND LOWER(hc.email) NOT LIKE '%@tp.finance' AND LOWER(hc.email) NOT LIKE '%@go.tp.finance'
           )
       ), ranked AS (
         SELECT due.*,
                ROW_NUMBER() OVER (PARTITION BY sequence_id, never_emailed ORDER BY next_step_due_at, id) AS rn
         FROM due
       )
       SELECT id, sequence_id, contact_id, current_step, next_step_number, next_step_due_at, never_emailed
       FROM ranked
       ORDER BY never_emailed DESC, rn ASC, next_step_due_at ASC, id ASC
       LIMIT $2`,
      [TENANT, fetchLimit]
    );

    if (due.rows.length === 0) {
      console.log(`[Planner] No due enrollments for ${TENANT}`);
      return result;
    }
    if (due.rows.length >= fetchLimit) {
      // Everything beyond the fetch is overflow for this pass
      result.overflow += Math.max(0, (await this.countDue()) - due.rows.length);
    }

    console.log(`[Planner] ${due.rows.length} due enrollments fetched for ${TENANT} (budget ${totalBudget})`);

    // 5. Batch-load everything the per-enrollment decisions need.
    const seqIds = [...new Set(due.rows.map(e => e.sequence_id))];
    const contactIds = [...new Set(due.rows.map(e => e.contact_id))];
    const enrollmentIds = due.rows.map(e => e.id);

    const [seqRes, stepRes, contactRes, sentRes] = await Promise.all([
      query<Sequence>(`SELECT * FROM sequences WHERE id = ANY($1::uuid[]) AND tenant = $2`, [seqIds, TENANT]),
      query<SequenceStep>(`SELECT * FROM sequence_steps WHERE sequence_id = ANY($1::uuid[])`, [seqIds]),
      query<Contact & { contact_type?: string | null }>(
        `SELECT * FROM contacts WHERE id = ANY($1::uuid[]) AND tenant = $2`, [contactIds, TENANT]
      ),
      query<{ enrollment_id: string; sequence_step_id: string }>(
        `SELECT DISTINCT enrollment_id, sequence_step_id FROM email_sends
         WHERE enrollment_id = ANY($1::uuid[]) AND tenant = $2 AND status = 'sent'`,
        [enrollmentIds, TENANT]
      ),
    ]);
    const seqMap = new Map(seqRes.rows.map(r => [r.id, r]));
    const stepMap = new Map(stepRes.rows.map(r => [`${r.sequence_id}:${r.step_number}`, r]));
    const contactMap = new Map(contactRes.rows.map(r => [r.id, r]));
    const sentSteps = new Set(sentRes.rows.map(r => `${r.enrollment_id}:${r.sequence_step_id}`));

    const suppressedSet = await this.suppressedAddresses(contactRes.rows.map(c => c.email));

    const templateIds = [...new Set(stepRes.rows.flatMap(st => [st.template_id, st.variant_template_id]).filter((x): x is string => !!x))];
    const templateRes = templateIds.length
      ? await query<Template>(`SELECT * FROM templates WHERE id = ANY($1::uuid[]) AND tenant = $2`, [templateIds, TENANT])
      : { rows: [] as Template[] };
    const templateMap = new Map(templateRes.rows.map(t => [t.id, t]));

    // 6. Decide + assign accounts (no writes per enrollment except rare paths).
    const toComplete: string[] = [];
    const toCancel: string[] = [];
    const toClear: string[] = [];
    const plannedItems: PlannedItem[] = [];
    const seqCursor = new Map<string, number>();

    for (const enrollment of due.rows) {
      const sequence = seqMap.get(enrollment.sequence_id);
      if (!sequence || sequence.status !== 'active') {
        result.skipped++;
        continue;
      }

      const step = stepMap.get(`${enrollment.sequence_id}:${enrollment.next_step_number}`);
      if (!step) {
        // No more steps — complete the enrollment
        toComplete.push(enrollment.id);
        result.skipped++;
        continue;
      }

      if (sentSteps.has(`${enrollment.id}:${step.id}`)) {
        // Already sent — schedule next step instead.
        result.alreadySent++;
        await this.scheduleNextStepOnEnrollment(enrollment.id, step);
        continue;
      }

      const contact = contactMap.get(enrollment.contact_id);
      if (!contact) {
        result.skipped++;
        toClear.push(enrollment.id);
        continue;
      }
      const email = (contact.email || '').trim().toLowerCase();
      const internal = isInternalAddress(email);
      const isLender = !internal && (contact.contact_type || '').toLowerCase() === 'lender';
      if (
        isLender ||
        contact.tags?.includes('unsubscribed') ||
        contact.tags?.includes('bounced') ||
        this.isSuppressedLocal(email, suppressedSet) ||
        isBulkOrRoleAddress(email)
      ) {
        toCancel.push(enrollment.id);
        result.skipped++;
        continue;
      }
      if (!internal && contact.tags?.includes('hold')) {
        // On hold: leave next_step_due_at as-is, re-checked next run
        result.skipped++;
        continue;
      }

      // Resolve template (A/B testing) before taking a budget slot
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
      const template = templateId ? templateMap.get(templateId) : undefined;
      if (!template) {
        result.skipped++;
        continue;
      }

      // Eligible accounts for this sequence
      const seqAccountIds = sequence.sending_account_ids || [];
      const eligible = seqAccountIds.length > 0
        ? accounts.rows.filter(a => seqAccountIds.includes(a.id))
        : accounts.rows;
      if (eligible.length === 0) {
        result.skipped++;
        continue;
      }

      // Find an account with budget (round-robin across eligible, per sequence)
      let cursor = seqCursor.get(sequence.id) || 0;
      let assigned: AccountRow | null = null;
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
      seqCursor.set(sequence.id, cursor);

      if (!assigned) {
        // All eligible accounts at capacity for this hour — overflow
        result.overflow++;
        continue;
      }

      plannedItems.push({ enrollment, step, contact, template, abVariant, account: assigned, offsetMs: 0 });
    }

    // Batched enrollment bookkeeping
    if (toComplete.length) {
      await query(
        `UPDATE sequence_enrollments
         SET status = 'completed', completed_at = NOW(),
             next_step_due_at = NULL, next_step_number = NULL,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND tenant = $2`,
        [toComplete, TENANT]
      );
    }
    if (toCancel.length) {
      await query(
        `UPDATE sequence_enrollments
         SET status = 'cancelled', updated_at = NOW(),
             next_step_due_at = NULL, next_step_number = NULL
         WHERE id = ANY($1::uuid[]) AND tenant = $2 AND status = 'active'`,
        [toCancel, TENANT]
      );
    }
    if (toClear.length) {
      await query(
        `UPDATE sequence_enrollments
         SET next_step_due_at = NULL, next_step_number = NULL, updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND tenant = $2`,
        [toClear, TENANT]
      );
    }

    // 7. Fire times: per account, spread evenly across [start, horizon) with
    // >= send_gap_minutes between consecutive sends; never at/after close.
    const byAccount = new Map<string, PlannedItem[]>();
    for (const item of plannedItems) {
      const arr = byAccount.get(item.account.id) || [];
      arr.push(item);
      byAccount.set(item.account.id, arr);
    }
    for (const [acctId, items] of byAccount) {
      const offsets = spreadFireOffsets(items.length, startOffset.get(acctId) || 0, horizonMs, gapMs);
      items.forEach((item, i) => { item.offsetMs = offsets[i]; });
    }

    // 8. Create sends + jobs
    if (plannedItems.length > 0) {
      const threadRes = await query<{ enrollment_id: string; gmail_thread_id: string }>(
        `SELECT DISTINCT ON (enrollment_id) enrollment_id, gmail_thread_id
         FROM email_sends
         WHERE enrollment_id = ANY($1::uuid[]) AND gmail_thread_id IS NOT NULL AND tenant = $2
         ORDER BY enrollment_id, created_at ASC`,
        [plannedItems.map(p => p.enrollment.id), TENANT]
      );
      const threadMap = new Map(threadRes.rows.map(r => [r.enrollment_id, r.gmail_thread_id]));

      const sendQueue = new Queue('email-sends', {
        connection: getRedisConnection(),
        prefix: BULL_PREFIX,
        defaultJobOptions: { removeOnComplete: 200, removeOnFail: 100 },
      });

      try {
        for (const item of plannedItems) {
          const { enrollment, step, contact, template, abVariant, account } = item;
          const rendered = templateEngine.renderTemplate(template, contact);
          const threadId = threadMap.get(enrollment.id);

          // last_enqueued_at = when the job is due to fire (now + delay), so
          // requeueStuckSends only treats it as lost well after that time.
          const sendResult = await query<{ id: string }>(
            `INSERT INTO email_sends (
              enrollment_id, sequence_step_id, contact_id, email_account_id, template_id,
              to_email, from_email, subject, body_html, status, ab_variant, tenant, last_enqueued_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11, NOW() + ($12::int * INTERVAL '1 millisecond'))
            RETURNING id`,
            [
              enrollment.id, step.id, contact.id, account.id, template.id,
              contact.email, account.email, rendered.subject, rendered.bodyHtml,
              abVariant, TENANT, item.offsetMs,
            ]
          );
          const emailSendId = sendResult.rows[0].id;

          await query(
            `UPDATE sequence_enrollments
             SET current_step = $1, updated_at = NOW(),
                 next_step_due_at = NULL, next_step_number = NULL
             WHERE id = $2`,
            [enrollment.next_step_number, enrollment.id]
          );

          await sendQueue.add(
            'send-email',
            buildSendJobData(emailSendId, threadId, account.display_name),
            { delay: item.offsetMs }
          );

          result.distribution[account.email] = (result.distribution[account.email] || 0) + 1;
          result.planned++;
        }
      } finally {
        await sendQueue.close();
      }
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

  /** settings.send_gap_minutes in ms (0 when unset, like the re-queue cron). */
  private async sendGapMs(): Promise<number> {
    const r = await query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'send_gap_minutes'`);
    const minutes = Number(r.rows[0]?.value);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 0;
  }

  /** Cheap count of due enrollments (planner index), for overflow reporting. */
  private async countDue(): Promise<number> {
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sequence_enrollments
       WHERE tenant = $1 AND status = 'active' AND next_step_due_at IS NOT NULL AND next_step_due_at <= NOW()`,
      [TENANT]
    );
    return parseInt(r.rows[0]?.n || '0', 10);
  }

  /**
   * One query for the whole batch, same rules as send-gate isSuppressed():
   * exact email on any row; domain only on source='manual' rows with a domain.
   * Returns a set of 'e:<email>' and 'd:<domain>' keys.
   */
  private async suppressedAddresses(emails: Array<string | null | undefined>): Promise<Set<string>> {
    const ems = [...new Set(emails.map(e => (e || '').trim().toLowerCase()).filter(Boolean))];
    if (ems.length === 0) return new Set();
    const doms = [...new Set(ems.map(e => e.split('@')[1] || '').filter(Boolean))];
    const r = await query<{ email: string | null; domain: string | null; manual_domain: boolean }>(
      `SELECT LOWER(email) AS email, LOWER(domain) AS domain,
              (source = 'manual' AND domain IS NOT NULL AND domain <> '') AS manual_domain
       FROM suppressed_emails
       WHERE tenant = $1
         AND (LOWER(email) = ANY($2::text[])
              OR (source = 'manual' AND domain IS NOT NULL AND domain <> '' AND LOWER(domain) = ANY($3::text[])))`,
      [TENANT, ems, doms]
    );
    const out = new Set<string>();
    for (const row of r.rows) {
      if (row.email) out.add('e:' + row.email);
      if (row.manual_domain && row.domain) out.add('d:' + row.domain);
    }
    return out;
  }

  private isSuppressedLocal(email: string, set: Set<string>): boolean {
    if (!email) return false;
    return set.has('e:' + email) || set.has('d:' + (email.split('@')[1] || ''));
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
         WHERE enrollment_id = $1 AND sequence_step_id = $2 AND tenant = $3 AND status IN ('failed', 'cancelled')`,
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
