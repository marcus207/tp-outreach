/**
 * Synthetic load dataset for the shadow-lane load test.
 *
 * 15,000 tp contacts:
 *   g 1..2000      lender               (enrolled directly, as if mis-classified after enrolment)
 *   g 2001..2450   suppressed (exact address row in suppressed_emails)
 *   g 2451..2500   suppressed via a source='manual' domain block
 *   g 2501..2800   tagged 'hold'
 *   g 2801..3000   tagged 'unsubscribed'
 *   g 3001..15000  clean developer (even g) / introducer (odd g), mixed subsectors
 * plus 100 loan-intel tenant contacts carrying (corrupt) tp enrolments.
 *
 * Every contact is enrolled in one of 18 sequences (3 steps). Blocked contacts
 * are inserted straight into sequence_enrollments because the production
 * enrollContact() would (correctly) refuse them; the point is to prove the
 * planner + gate stop them if they are already enrolled.
 *
 * Due times: ~90% overdue by 0-119 days, ~10% fall due during the simulated
 * week. Every 7th enrolment is on step 2 with a historical 'sent' step-1 row;
 * every 13th of those still points at step 1 (already-sent idempotency path).
 */
import { query } from '../../../src/db/connection';
import { createAccount, createSequence } from '../factories';

export const SUBSECTORS_DEV = ['residential', 'commercial', 'mixed_use', 'pbsa', 'btr', 'industrial'];
export const SUBSECTORS_INTRO = ['broker', 'accountant', 'ifa', 'solicitor'];

export interface LoadSeed {
  go1: string; go2: string; root: string;
  sequenceIds: string[];
}

export async function seedLoadDataset(o: {
  simStart: Date;
  goLimits: { daily: number; hourly: number };
}): Promise<LoadSeed> {
  const go1 = await createAccount({ email: 'marcus.emadi@go.tp.finance', displayName: 'Marcus Emadi', limits: o.goLimits });
  const go2 = await createAccount({ email: 'marcus@go.tp.finance', displayName: 'Marcus Emadi', limits: o.goLimits });
  const root = await createAccount({ email: 'marcus@tp.finance', displayName: 'Marcus Emadi', limits: { daily: 2000, hourly: 200 } });

  const sequenceIds: string[] = [];
  for (let i = 0; i < 18; i++) {
    // Mix of account configs: some include the ROOT account explicitly, some
    // are empty (= all accounts), some only the go.tp.finance pair.
    const accountIds = i % 3 === 0 ? [go1.id, go2.id, root.id] : i % 3 === 1 ? [] : [go1.id, go2.id];
    const s = await createSequence({
      name: `Load seq ${i + 1}`,
      accountIds,
      steps: [
        { subject: `S${i + 1} intro for {{company}}`, bodyHtml: `<p>Hi {{first_name}},</p><p>Seq ${i + 1} step 1 for {{company}}. Turning Point Capital Advisory.</p>` },
        { subject: `S${i + 1} follow up`, delayDays: 3 },
        { subject: `S${i + 1} last note`, delayDays: 4 },
      ],
    });
    sequenceIds.push(s.id);
  }

  await query(`
    INSERT INTO contacts (email, first_name, last_name, company, contact_type, subsector, tags, tenant, source)
    SELECT
      CASE WHEN g BETWEEN 2451 AND 2500 THEN 'c' || g || '@blocked' || g || '.test'
           ELSE 'c' || g || '@load' || (g % 997) || '.test' END,
      'First' || g, 'Last' || g, 'Company ' || g,
      CASE WHEN g <= 2000 THEN 'lender' WHEN g % 2 = 0 THEN 'developer' ELSE 'introducer' END,
      CASE WHEN g <= 2000 THEN NULL
           WHEN g % 2 = 0 THEN ($1::text[])[1 + (g / 2) % 6]
           ELSE ($2::text[])[1 + (g / 2) % 4] END,
      CASE WHEN g BETWEEN 2501 AND 2800 THEN ARRAY['hold']
           WHEN g BETWEEN 2801 AND 3000 THEN ARRAY['unsubscribed']
           ELSE '{}'::text[] END,
      CASE WHEN g > 15000 THEN 'loan-intel' ELSE 'tp' END,
      'loadtest'
    FROM generate_series(1, 15100) g`,
    [SUBSECTORS_DEV, SUBSECTORS_INTRO]);

  await query(`
    INSERT INTO suppressed_emails (email, domain, reason, source, tenant)
    SELECT 'c' || g || '@load' || (g % 997) || '.test', 'load' || (g % 997) || '.test', 'unsubscribed', 'unsubscribe', 'tp'
    FROM generate_series(2001, 2450) g`);
  await query(`
    INSERT INTO suppressed_emails (email, domain, reason, source, tenant)
    SELECT 'domain-block@blocked' || g || '.test', 'blocked' || g || '.test', 'domain block', 'manual', 'tp'
    FROM generate_series(2451, 2500) g`);

  // Enrol everyone. rn = contact ordinal.
  await query(`
    WITH c AS (
      SELECT id, (regexp_match(email, '^c(\\d+)@'))[1]::int AS rn FROM contacts
    )
    INSERT INTO sequence_enrollments (sequence_id, contact_id, status, current_step, tenant,
                                      next_step_number, next_step_due_at, enrolled_at)
    SELECT ($1::uuid[])[1 + rn % 18], c.id, 'active',
           CASE WHEN rn % 7 = 0 THEN 1 ELSE 0 END,
           'tp',
           CASE WHEN rn % 7 = 0 AND rn % 13 <> 0 THEN 2 ELSE 1 END,
           CASE WHEN rn % 10 = 0 THEN $2::timestamptz + ((rn % 5) * INTERVAL '1 day') + INTERVAL '2 hours'
                ELSE $2::timestamptz - (((rn * 37) % 120) * INTERVAL '1 day') - INTERVAL '1 hour' END,
           $2::timestamptz - INTERVAL '130 days'
    FROM c`,
    [sequenceIds, o.simStart.toISOString()]);

  // Historical step-1 sends for enrolments that are past step 1
  await query(`
    INSERT INTO email_sends (enrollment_id, sequence_step_id, contact_id, email_account_id, template_id,
                             to_email, from_email, subject, body_html, status, sent_at, created_at, tenant,
                             gmail_message_id, gmail_thread_id)
    SELECT e.id, ss.id, c.id, $1, ss.template_id, c.email, 'marcus.emadi@go.tp.finance',
           'historical', '<p>historical</p>', 'sent',
           e.next_step_due_at - INTERVAL '3 days', e.next_step_due_at - INTERVAL '3 days', 'tp',
           'hist-msg-' || e.id, 'hist-thread-' || e.id
    FROM sequence_enrollments e
    JOIN contacts c ON c.id = e.contact_id
    JOIN sequence_steps ss ON ss.sequence_id = e.sequence_id AND ss.step_number = 1
    WHERE e.current_step = 1`,
    [go1.id]);

  await query('ANALYZE');
  return { go1: go1.id, go2: go2.id, root: root.id, sequenceIds };
}
