/**
 * Helpers for the `send` lane (sending-mechanics suite).
 *
 * Clock strategy: the JS clock is faked (Date only); Postgres NOW() is the real
 * wall clock. send-queue.ts compares accounts.last_send_at (written with NOW())
 * against Date.now() for the per-account send gap, so most tests run at a fake
 * time AFTER the real clock (week of 12 Oct 2026). Then the gap check never
 * fires by accident and tests that want it set last_send_at explicitly.
 */
import { vi } from 'vitest';
import { Queue } from 'bullmq';
import request from 'supertest';
import { query, BULL_PREFIX } from '../../../src/db/connection';
import { getRedisConnection } from '../../../src/db/redis';
import { EmailSendJobData } from '../../../src/services/send-queue';
import { isWithinSendWindow } from '../../../src/services/send-gate';

// ── Fixed instants (all comments are Europe/London wall-clock) ──────────

/** Mon 12 Oct 2026 10:00 BST (09:00Z). Default "inside window" instant, after the real clock. */
export const T0 = new Date('2026-10-12T09:00:00.000Z');
export const SAT_10 = new Date('2026-10-10T09:00:00.000Z');      // Sat 10:00 BST
export const SUN_10 = new Date('2026-10-11T09:00:00.000Z');      // Sun 10:00 BST
export const MON_0759 = new Date('2026-10-12T06:59:00.000Z');    // Mon 07:59 BST
export const MON_0800 = new Date('2026-10-12T07:00:00.000Z');    // Mon 08:00 BST
export const MON_1659 = new Date('2026-10-12T15:59:00.000Z');    // Mon 16:59 BST
export const MON_1700 = new Date('2026-10-12T16:00:00.000Z');    // Mon 17:00 BST
// BST starts Sun 29 Mar 2026; GMT resumes Sun 25 Oct 2026
export const BST_MON_0830 = new Date('2026-03-30T07:30:00.000Z'); // Mon 08:30 BST (07:30Z)
export const BST_MON_0759 = new Date('2026-03-30T06:59:00.000Z'); // Mon 07:59 BST
export const BST_MON_1700 = new Date('2026-03-30T16:00:00.000Z'); // Mon 17:00 BST
export const GMT_MON_0730 = new Date('2026-10-26T07:30:00.000Z'); // Mon 07:30 GMT
export const GMT_MON_0800 = new Date('2026-10-26T08:00:00.000Z'); // Mon 08:00 GMT
export const GMT_MON_1630 = new Date('2026-10-26T16:30:00.000Z'); // Mon 16:30 GMT
export const GMT_MON_1700 = new Date('2026-10-26T17:00:00.000Z'); // Mon 17:00 GMT

export const COLD_A = 'alice@go.tp.finance';
export const COLD_B = 'bob@go.tp.finance';
export const ROOT = 'marcus@tp.finance';

// ── Settings ────────────────────────────────────────────────────────────

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const r = await query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

// ── Readers ─────────────────────────────────────────────────────────────

export async function account(id: string) {
  return (await query<{
    id: string; email: string; daily_limit: number; hourly_limit: number; broadcast_hourly_limit: number;
    sends_today: number; sends_this_hour: number; last_send_at: Date | null; is_active: boolean;
  }>(`SELECT * FROM email_accounts WHERE id = $1`, [id])).rows[0];
}

export async function sendRow(id: string) {
  return (await query<{
    id: string; status: string; error_message: string | null; email_account_id: string; from_email: string;
    to_email: string; subject: string; last_enqueued_at: Date | null; gmail_thread_id: string | null;
  }>(`SELECT * FROM email_sends WHERE id = $1`, [id])).rows[0];
}

export interface TimedJob { data: EmailSendJobData; delay: number; timestamp: number; fireAt: Date }

/** Jobs in the lane's email-sends queue with their scheduled fire time (enqueue time + delay). */
export async function queuedJobs(): Promise<TimedJob[]> {
  const q = new Queue<EmailSendJobData>('email-sends', { connection: getRedisConnection(), prefix: BULL_PREFIX });
  try {
    const jobs = await q.getJobs(['delayed', 'waiting', 'prioritized', 'paused']);
    return jobs
      .map(j => ({
        data: j.data,
        delay: j.opts.delay || 0,
        timestamp: j.timestamp,
        fireAt: new Date(j.timestamp + (j.opts.delay || 0)),
      }))
      .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  } finally {
    await q.close();
  }
}

export function outsideWindow(jobs: TimedJob[]): TimedJob[] {
  return jobs.filter(j => !isWithinSendWindow(j.fireAt));
}

// ── Fixtures ────────────────────────────────────────────────────────────

/** A queued email_sends row (as press release / ad-hoc sends create them). */
export async function insertQueuedSend(o: {
  accountId: string; fromEmail: string; to: string;
  contactId?: string | null; enrollmentId?: string | null; stepId?: string | null;
  broadcastId?: string | null; subject?: string; bodyHtml?: string; status?: string;
  lastEnqueuedSql?: string; // SQL expression, e.g. "NOW() - INTERVAL '2 hours'"
}): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO email_sends (enrollment_id, sequence_step_id, contact_id, email_account_id, to_email, from_email,
       subject, body_html, status, broadcast_id, tenant, last_enqueued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'tp', ${o.lastEnqueuedSql ?? 'NULL'}) RETURNING id`,
    [
      o.enrollmentId ?? null, o.stepId ?? null, o.contactId ?? null, o.accountId, o.to, o.fromEmail,
      o.subject ?? 'Quick question', o.bodyHtml ?? '<p>Hello there.</p>', o.status ?? 'queued', o.broadcastId ?? null,
    ]
  );
  return r.rows[0].id;
}

export async function setContactFields(contactId: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE contacts SET ${sets} WHERE id = $1`, [contactId, ...keys.map(k => fields[k])]);
}

/** Active campaign settings row (Pause/Resume switch). */
export async function setCampaignActive(active: boolean): Promise<void> {
  await query(`DELETE FROM campaign_settings WHERE tenant = 'tp'`);
  await query(`INSERT INTO campaign_settings (tenant, is_active) VALUES ('tp', $1)`, [active]);
}

/** One active blast sequence with one approved step for `sector`, plus sector contacts. */
export async function createBlast(o: {
  sector?: string; subject?: string; bodyCopy?: string; contacts?: Array<{ email: string; firstName?: string | null; company?: string }>;
} = {}) {
  const sector = o.sector ?? 'Developer';
  const seq = await query<{ id: string }>(
    `INSERT INTO sequences (name, status, type, frequency_days, start_date, tenant)
     VALUES ('Blast', 'active', 'blast', 30, '2026-10-01', 'tp') RETURNING id`
  );
  const step = await query<{ id: string }>(
    `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, sector, subject_line, body_copy, blast_status, tenant)
     VALUES ($1, 1, 0, $2, $3, $4, 'approved', 'tp') RETURNING id`,
    [seq.rows[0].id, sector, o.subject ?? 'Market note for {{company}}', o.bodyCopy ?? '<p>Hi {{first_name}},</p><p>A short market note.</p>']
  );
  const contactIds: string[] = [];
  for (const c of o.contacts ?? []) {
    const r = await query<{ id: string }>(
      `INSERT INTO contacts (email, first_name, last_name, company, contact_type, custom_fields, tenant, source)
       VALUES ($1, $2, 'Blast', $3, 'developer', $4, 'tp', 'test') RETURNING id`,
      [c.email, c.firstName === undefined ? 'Bea' : c.firstName, c.company ?? 'Blast Homes Ltd', JSON.stringify({ sector })]
    );
    contactIds.push(r.rows[0].id);
  }
  return { sequenceId: seq.rows[0].id, stepId: step.rows[0].id, contactIds };
}

/** An article broadcast with `n` queued broadcast email_sends (assigned to accountId initially). */
export async function createBroadcast(n: number, accountId: string, fromEmail: string): Promise<string> {
  const art = await query<{ id: string }>(
    `INSERT INTO article_drafts (title, slug) VALUES ('Market update', 'market-update-' || gen_random_uuid()) RETURNING id`
  );
  const b = await query<{ id: string }>(
    `INSERT INTO article_broadcasts (article_id, subsectors, status) VALUES ($1, ARRAY['residential'], 'sending') RETURNING id`,
    [art.rows[0].id]
  );
  for (let i = 0; i < n; i++) {
    await query(
      `INSERT INTO email_sends (email_account_id, to_email, from_email, subject, body_html, status, broadcast_id, send_type, tenant)
       VALUES ($1, $2, $3, 'Market update', '<p>Our latest note.</p>', 'queued', $4, 'broadcast', 'tp')`,
      [accountId, `reader${i}-${b.rows[0].id.slice(0, 6)}@example-reader.test`, fromEmail, b.rows[0].id]
    );
  }
  return b.rows[0].id;
}

/** Press contacts + draft press releases under one announcement title. */
export async function createPressReleases(n: number, title = 'Announcement'): Promise<void> {
  for (let i = 0; i < n; i++) {
    const pc = await query<{ id: string }>(
      `INSERT INTO press_contacts (publication, email, contact_name, is_primary) VALUES ($1, $2, 'Ed', true) RETURNING id`,
      [`Pub ${i}`, `editor${i}@example-press.test`]
    );
    await query(
      `INSERT INTO press_releases (announcement_title, publication, press_contact_id, headline, body, status, tenant,
         spokesperson_name, spokesperson_title, boilerplate)
       VALUES ($1, $2, $3, 'Headline news', 'Body paragraph one.\n\nBody paragraph two.', 'draft', 'tp',
         'Marcus Emadi', NULL, NULL)`,
      [title, `Pub ${i}`, pc.rows[0].id]
    );
  }
}

/** Supertest agent logged in to the dashboard (session cookie). */
export async function loggedInAgent() {
  const { app } = await import('../../../src/index');
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: 'test@tp.finance', password: 'test-password' });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

// ── Determinism ─────────────────────────────────────────────────────────

/** Seeded Math.random (mulberry32). Returns the spy; call .mockRestore() after. */
export function seedRandom(seed = 42) {
  let a = seed >>> 0;
  return vi.spyOn(Math, 'random').mockImplementation(() => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

/** Push an enrollment's next step due into the (real-clock) past so the planner picks it up. */
export async function forceDue(enrollmentId: string): Promise<void> {
  await query(`UPDATE sequence_enrollments SET next_step_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [enrollmentId]);
}

/** Seed finished sends for circuit-breaker tests. */
export async function seedOutcomes(accountId: string, fromEmail: string, o: {
  sent?: number; bounced?: number; failed?: Array<string | null>; unsubscribes?: number;
}): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < (o.sent ?? 0); i++) {
    ids.push(await insertQueuedSend({ accountId, fromEmail, to: `s${i}-${accountId.slice(0, 6)}@example-cb.test`, status: 'sent' }));
  }
  for (let i = 0; i < (o.bounced ?? 0); i++) {
    await insertQueuedSend({ accountId, fromEmail, to: `b${i}-${accountId.slice(0, 6)}@example-cb.test`, status: 'bounced' });
  }
  for (const [i, msg] of (o.failed ?? []).entries()) {
    const id = await insertQueuedSend({ accountId, fromEmail, to: `f${i}-${accountId.slice(0, 6)}@example-cb.test`, status: 'failed' });
    await query(`UPDATE email_sends SET error_message = $1 WHERE id = $2`, [msg, id]);
  }
  for (let i = 0; i < (o.unsubscribes ?? 0); i++) {
    await query(`INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'unsubscribe')`, [ids[i]]);
  }
}
