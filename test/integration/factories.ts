/**
 * Fixtures + drivers for the isolated integration harness.
 *
 * All rows go to tpca_outreach_test (enforced by src/db/connection.ts under
 * NODE_ENV=test and by global-setup). BullMQ jobs go to Redis DB 15 under the
 * bull-test prefix (enforced by src/db/redis.ts + connection.ts).
 *
 * Queue processing strategy (deliberate): the planner enqueues real BullMQ
 * jobs into Redis DB 15, exactly as in prod. drainSendQueue() then reads those
 * jobs back (delayed + waiting), removes them, and calls the production
 * processor SendQueue.processEmailSend(job.data) synchronously in the test
 * process. That exercises the real enqueue path and payload while avoiding
 * BullMQ worker timing (random 0-55 min jitter delays, lock renewals), so tests
 * are deterministic. No BullMQ Worker and no node-cron schedule is ever started
 * (src/jobs/worker.ts is never imported).
 */
import { vi } from 'vitest';
import { Queue } from 'bullmq';
import { pool, query, BULL_PREFIX } from '../../src/db/connection';
import { getRedisConnection } from '../../src/db/redis';
import { setGmailTransportForTests } from '../../src/services/gmail-client';
import { sequenceEngine } from '../../src/services/sequence-engine';
import { sendQueue, EmailSendJobData } from '../../src/services/send-queue';
import { dailyPlanner } from '../../src/services/daily-planner';
import { replyWatcher } from '../../src/services/reply-watcher';
import { isWithinSendWindow } from '../../src/services/send-gate';
import { fakeGmail, fakeAccessToken } from './fake-gmail';
import { clearTestRedis } from './global-setup';
import { TEST_DB_NAME } from './safety';

export { fakeGmail };

// ── Clock ──────────────────────────────────────────────────────────────

/** Monday 5 Oct 2026, 10:00 Europe/London (BST, so 09:00Z). Inside the send window. */
export const MON_10_LONDON = new Date('2026-10-05T09:00:00.000Z');

/**
 * Fake ONLY Date (timers stay real so pg/ioredis/BullMQ keep working).
 * Note: Postgres NOW() is the real wall clock; only JS-side time is moved.
 * Code that compares DB timestamps with Date.now() sees the difference.
 */
export function setClock(at: Date = MON_10_LONDON): Date {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  return at;
}

export function restoreClock(): void {
  vi.useRealTimers();
}

export function assertInSendWindow(): void {
  if (!isWithinSendWindow(new Date())) throw new Error(`Clock ${new Date().toISOString()} is outside the send window`);
}

// ── Database ───────────────────────────────────────────────────────────

/** TRUNCATE every table in the test DB. Re-checks current_database() first. */
export async function resetDb(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db');
  if (db.rows[0]?.db !== TEST_DB_NAME) throw new Error(`resetDb refused: connected to ${db.rows[0]?.db}`);
  const tables = await query<{ t: string }>(
    `SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public'`
  );
  if (tables.rows.length) {
    await query(`TRUNCATE ${tables.rows.map(r => r.t).join(', ')} RESTART IDENTITY CASCADE`);
  }
}

/** Full per-test reset: DB rows, bull-test* keys in Redis DB 15, fake Gmail state. */
export async function resetAll(): Promise<void> {
  await resetDb();
  await clearTestRedis();
  fakeGmail.reset();
}

export function installFakeGmail(): void {
  setGmailTransportForTests(fakeGmail.factory);
}

export async function closeAll(): Promise<void> {
  setGmailTransportForTests(null);
  await sequenceEngine.close();
  await sendQueue.close();
  await pool.end();
}

// ── Factories ──────────────────────────────────────────────────────────

export interface AccountRow {
  id: string; email: string; display_name: string | null;
  daily_limit: number; hourly_limit: number; is_active: boolean;
}

export async function createAccount(o: {
  email?: string;
  displayName?: string | null;
  limits?: { daily: number; hourly: number };
  active?: boolean;
  tenant?: string;
} = {}): Promise<AccountRow> {
  const email = (o.email || 'marcus.emadi@go.tp.finance').toLowerCase();
  const r = await query<AccountRow>(
    `INSERT INTO email_accounts (email, display_name, oauth_tokens, daily_limit, hourly_limit, is_active, tenant)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      email,
      o.displayName === undefined ? 'Marcus Emadi' : o.displayName,
      JSON.stringify({
        access_token: fakeAccessToken(email),
        refresh_token: 'fake-refresh',
        expiry_date: 4102444800000, // 2100-01-01, never triggers a refresh
        token_type: 'Bearer',
        scope: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/gmail.settings.basic',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
      }),
      o.limits?.daily ?? 10,
      o.limits?.hourly ?? 2,
      o.active ?? true,
      o.tenant ?? 'tp',
    ]
  );
  return r.rows[0];
}

export interface ContactRow { id: string; email: string; first_name: string | null; contact_type: string | null; tags: string[] }

let contactSeq = 0;
export async function createContact(o: {
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  type?: string;        // contact_type: developer | investor | lender | ...
  subsector?: string | null;
  tags?: string[];
  tenant?: string;
} = {}): Promise<ContactRow> {
  contactSeq++;
  const r = await query<ContactRow>(
    `INSERT INTO contacts (email, first_name, last_name, company, contact_type, subsector, tags, tenant, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'test') RETURNING *`,
    [
      (o.email || `contact${contactSeq}@example-dev.test`).toLowerCase(),
      o.firstName ?? 'Dana',
      o.lastName ?? 'Developer',
      o.company ?? 'Example Developments Ltd',
      o.type ?? 'developer',
      o.subsector ?? null,
      o.tags ?? [],
      o.tenant ?? 'tp',
    ]
  );
  return r.rows[0];
}

export async function createTemplate(o: { name?: string; subject: string; bodyHtml: string; tenant?: string }) {
  const r = await query<{ id: string; subject: string }>(
    `INSERT INTO templates (name, subject, body_html, tenant) VALUES ($1, $2, $3, $4) RETURNING id, subject`,
    [o.name ?? o.subject, o.subject, o.bodyHtml, o.tenant ?? 'tp']
  );
  return r.rows[0];
}

export interface StepSpec { subject: string; bodyHtml?: string; delayDays?: number; delayHours?: number }

export async function createSequence(o: {
  name?: string;
  status?: 'active' | 'paused' | 'draft';
  accountIds?: string[];
  steps: StepSpec[];
  tenant?: string;
}) {
  const tenant = o.tenant ?? 'tp';
  const seq = await query<{ id: string; name: string }>(
    `INSERT INTO sequences (name, status, sending_account_ids, tenant) VALUES ($1, $2, $3::uuid[], $4) RETURNING id, name`,
    [o.name ?? 'Test sequence', o.status ?? 'active', o.accountIds ?? [], tenant]
  );
  const sequenceId = seq.rows[0].id;
  const steps: Array<{ id: string; stepNumber: number; templateId: string; subject: string }> = [];
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i];
    const tpl = await createTemplate({
      subject: s.subject,
      bodyHtml: s.bodyHtml ?? `<p>Hi {{first_name}},</p><p>Step ${i + 1} copy for {{company}}.</p>`,
      tenant,
    });
    const st = await query<{ id: string }>(
      `INSERT INTO sequence_steps (sequence_id, step_number, template_id, delay_days, delay_hours, variant_split, tenant)
       VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING id`,
      [sequenceId, i + 1, tpl.id, s.delayDays ?? (i === 0 ? 0 : 3), s.delayHours ?? 0, tenant]
    );
    steps.push({ id: st.rows[0].id, stepNumber: i + 1, templateId: tpl.id, subject: s.subject });
  }
  return { id: sequenceId, name: seq.rows[0].name, steps };
}

/** Enrol through the production path (all refusal rules apply). */
export function enroll(sequenceId: string, contactId: string): Promise<string> {
  return sequenceEngine.enrollContact(sequenceId, contactId);
}

export async function suppress(email: string, o: { reason?: string; source?: string; domain?: string | null; tenant?: string } = {}) {
  await query(
    `INSERT INTO suppressed_emails (email, domain, reason, source, tenant) VALUES (LOWER($1), $2, $3, $4, $5)
     ON CONFLICT (LOWER(email), tenant) DO NOTHING`,
    [email, o.domain ?? null, o.reason ?? 'test', o.source ?? 'manual', o.tenant ?? 'tp']
  );
}

// ── Drivers ────────────────────────────────────────────────────────────

/** One hourly-planner pass (dailyPlanner.plan), as the worker cron would run it. */
export function runPlannerPass() {
  return dailyPlanner.plan();
}

function emailSendsQueue(): Queue<EmailSendJobData> {
  return new Queue<EmailSendJobData>('email-sends', { connection: getRedisConnection(), prefix: BULL_PREFIX });
}

/** Jobs currently sitting in the bull-test email-sends queue (DB 15). */
export async function pendingSendJobs(): Promise<EmailSendJobData[]> {
  const q = emailSendsQueue();
  try {
    const jobs = await q.getJobs(['delayed', 'waiting', 'prioritized', 'paused']);
    return jobs.map(j => j.data);
  } finally {
    await q.close();
  }
}

/**
 * Process every email-sends job present right now, synchronously, through the
 * production SendQueue.processEmailSend (send gate, claim, sendEmail, status
 * update, next-step scheduling). Jobs re-added during processing (e.g. the
 * per-account gap push-back) are left in the queue for the next drain.
 * Returns the number of jobs processed.
 */
export async function drainSendQueue(): Promise<number> {
  const q = emailSendsQueue();
  try {
    const jobs = (await q.getJobs(['delayed', 'waiting', 'prioritized', 'paused']))
      .sort((a, b) => (a.timestamp + (a.opts.delay || 0)) - (b.timestamp + (b.opts.delay || 0)));
    for (const job of jobs) {
      await job.remove();
      await sendQueue.processEmailSend(job.data);
    }
    return jobs.length;
  } finally {
    await q.close();
  }
}

/** One reply/bounce poll across all active accounts (replyWatcher.pollAllAccounts). */
export function runReplyWatcher(): Promise<void> {
  return replyWatcher.pollAllAccounts();
}

// ── Readers ────────────────────────────────────────────────────────────

export interface OutboxRow {
  id: string; account_email: string; from_header: string; from_email: string; to_email: string;
  reply_to: string | null; subject: string; html_body: string; text_body: string;
  headers: Record<string, string>; raw_message: string; thread_id: string | null;
  tracking_id: string | null; fake_message_id: string; fake_thread_id: string;
}

export async function outbox(): Promise<OutboxRow[]> {
  return (await query<OutboxRow>(`SELECT * FROM test_outbox ORDER BY id`)).rows;
}

export async function emailSends(where = 'TRUE', params: unknown[] = []) {
  return (await query<{
    id: string; status: string; to_email: string; from_email: string; enrollment_id: string | null;
    sequence_step_id: string | null; gmail_message_id: string | null; gmail_thread_id: string | null;
    tracking_id: string; error_message: string | null;
  }>(`SELECT * FROM email_sends WHERE ${where} ORDER BY created_at`, params)).rows;
}

export async function enrollment(id: string) {
  return (await query<{
    id: string; status: string; current_step: number; next_step_number: number | null;
    next_step_due_at: Date | null; replied_at: Date | null;
  }>(`SELECT * FROM sequence_enrollments WHERE id = $1`, [id])).rows[0];
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM suppressed_emails WHERE LOWER(email) = LOWER($1) AND tenant = 'tp'`, [email]);
  return r.rows.length > 0;
}
