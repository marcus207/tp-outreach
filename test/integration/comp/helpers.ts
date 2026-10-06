/**
 * Compliance-lane helpers (lane `comp`). Built only on the shared harness
 * (factories.ts / fake-gmail.ts) and production entry points. Nothing here
 * mocks business logic: sends go through planner -> BullMQ (Redis DB 15) ->
 * SendQueue.processEmailSend -> send-gate -> GmailClient (SEND_MODE=dryrun ->
 * test_outbox). Inbound mail goes through FakeGmail -> ReplyWatcher.
 */
import { expect } from 'vitest';
import request from 'supertest';
import { query } from '../../../src/db/connection';
import { sendQueue } from '../../../src/services/send-queue';
import { campaignEngine } from '../../../src/services/campaign-engine';
import { broadcastPlanner } from '../../../src/services/broadcast-planner';
import { EnrollmentRefusedError } from '../../../src/services/sequence-engine';
import {
  resetAll, installFakeGmail, setClock, createAccount, createContact, createSequence, enroll,
  runPlannerPass, drainSendQueue, outbox, emailSends, fakeGmail, AccountRow, ContactRow,
} from '../factories';

export { EnrollmentRefusedError };

export const SENDER = 'marcus.emadi@go.tp.finance';
export const PRIMARY = 'marcus@tp.finance';

// ── World setup ─────────────────────────────────────────────────────────

/** Reset everything, install the Gmail seam, freeze JS time at Mon 10:00 London, create one sender. */
export async function freshWorld(): Promise<{ account: AccountRow }> {
  await resetAll();
  installFakeGmail();
  setClock();
  const account = await createAccount({ email: SENDER, limits: { daily: 500, hourly: 200 } });
  return { account };
}

let appPromise: Promise<typeof import('../../../src/index')> | null = null;
export async function getApp() {
  if (!appPromise) appPromise = import('../../../src/index');
  return (await appPromise).app;
}

/** Supertest agent with an authenticated dashboard session. */
export async function authedAgent() {
  const app = await getApp();
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: 'test@tp.finance', password: 'test-password' });
  expect(res.status).toBe(200);
  return agent;
}

// ── Sending ─────────────────────────────────────────────────────────────

/**
 * Drain the send queue until it is empty. Clears last_send_at between passes so
 * the per-account send-gap push-back (which compares the real DB clock with the
 * frozen JS clock) never strands a job.
 */
export async function drainAll(maxPasses = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxPasses; i++) {
    await query(`UPDATE email_accounts SET last_send_at = NULL`);
    const n = await drainSendQueue();
    total += n;
    if (n === 0) return total;
  }
  throw new Error('drainAll: queue did not empty');
}

/** One planner pass + full drain. */
export async function planAndSend(): Promise<void> {
  await runPlannerPass();
  await drainAll();
}

/** Make the enrollment's next step due now (DB clock), as the smoke test does. */
export async function forceDue(enrollmentId: string): Promise<void> {
  await query(`UPDATE sequence_enrollments SET next_step_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [enrollmentId]);
}

export async function outboxTo(email: string) {
  return (await outbox()).filter(m => m.to_email.toLowerCase() === email.toLowerCase());
}

/**
 * Create a contact + N-step sequence, enrol, send step 1 through the full path.
 * Returns the captured outbound mail and its email_sends row.
 */
export async function sentStepOne(o: {
  account: AccountRow;
  email?: string;
  firstName?: string;
  steps?: number;
  type?: string;
}) {
  const contact = await createContact({
    email: o.email ?? 'jane@harbourside-dev.test',
    firstName: o.firstName ?? 'Jane',
    type: o.type ?? 'developer',
    subsector: 'residential',
  });
  const n = o.steps ?? 3;
  const seq = await createSequence({
    name: 'Developer intro',
    accountIds: [o.account.id],
    steps: Array.from({ length: n }, (_, i) => ({
      subject: i === 0 ? 'Funding for {{company}}' : `Follow up ${i}`,
      delayDays: i === 0 ? 0 : 3,
    })),
  });
  const enrollmentId = await enroll(seq.id, contact.id);
  await planAndSend();
  const mails = await outboxTo(contact.email);
  expect(mails).toHaveLength(1);
  const sends = await emailSends(`to_email = $1`, [contact.email]);
  expect(sends).toHaveLength(1);
  expect(sends[0].status).toBe('sent');
  return { contact, seq, enrollmentId, mail: mails[0], send: sends[0] };
}

/**
 * Force the next step due, plan and drain; assert NOTHING new is sent to `email`
 * from any path, and no email_sends row reaches 'sent' for it.
 */
export async function expectNoFurtherSequenceSend(enrollmentId: string, email: string): Promise<void> {
  const before = (await outboxTo(email)).length;
  await forceDue(enrollmentId);
  await planAndSend();
  expect((await outboxTo(email)).length).toBe(before);
}

/** Step 2 goes out (sequence continues). */
export async function expectNextStepSends(enrollmentId: string, email: string): Promise<void> {
  const before = (await outboxTo(email)).length;
  await forceDue(enrollmentId);
  await planAndSend();
  expect((await outboxTo(email)).length).toBe(before + 1);
}

// ── Inbound helpers ─────────────────────────────────────────────────────

/** Inject an arbitrary DSN body (FakeGmail.injectBounce only has two canned bodies). */
export function injectDsn(o: { mailbox: string; threadId: string; subject: string; body: string; extraHeaders?: Array<{ name: string; value: string }> }) {
  const add = (fakeGmail as unknown as {
    add: (mb: string, kind: string, t: string, h: Array<{ name: string; value: string }>, b: string) => unknown;
  }).add.bind(fakeGmail);
  return add(o.mailbox, 'bounce', o.threadId, [
    { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
    { name: 'To', value: o.mailbox },
    { name: 'Subject', value: o.subject },
    ...(o.extraHeaders || []),
  ], o.body);
}

// ── Readers ─────────────────────────────────────────────────────────────

export async function suppressionRows(email: string) {
  return (await query<{ email: string; domain: string | null; reason: string; source: string; tenant: string; suppressed_at: Date }>(
    `SELECT email, domain, reason, source, tenant, suppressed_at FROM suppressed_emails WHERE LOWER(email) = LOWER($1)`, [email]
  )).rows;
}

export async function contactById(id: string) {
  return (await query<{ id: string; email: string; tags: string[]; tenant: string; contact_type: string | null }>(
    `SELECT id, email, tags, tenant, contact_type FROM contacts WHERE id = $1`, [id]
  )).rows[0];
}

export async function eventsForSend(sendId: string) {
  return (await query<{ event_type: string; created_at: Date }>(
    `SELECT event_type, created_at FROM email_events WHERE email_send_id = $1 ORDER BY created_at, event_type`, [sendId]
  )).rows;
}

export async function enrollmentsFor(contactId: string) {
  return (await query<{ id: string; status: string }>(
    `SELECT id, status FROM sequence_enrollments WHERE contact_id = $1`, [contactId]
  )).rows;
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  // Date is frozen by setClock, so poll a fixed number of times (timers are real).
  let v = await fn();
  for (let i = 0; i < 60 && !ok(v); i++) {
    await new Promise(r => setTimeout(r, ms / 60));
    v = await fn();
  }
  return v;
}

// ── Channel attempts: "no future send of any kind" ──────────────────────

/** Sequence: production enrollContact must refuse. Returns the refusal error (or null if it enrolled). */
export async function attemptSequenceEnroll(accountId: string, contactId: string): Promise<{ refused: boolean; message: string }> {
  const seq = await createSequence({ name: `Probe ${Math.random()}`, accountIds: [accountId], steps: [{ subject: 'Probe' }] });
  try {
    await enroll(seq.id, contactId);
    return { refused: false, message: '' };
  } catch (err) {
    return { refused: err instanceof EnrollmentRefusedError, message: (err as Error).message };
  }
}

/** POST /api/campaigns/:id/enroll for the given contacts. */
export async function attemptEnrollRoute(accountId: string, contactIds: string[]) {
  const seq = await createSequence({ name: `Route ${Math.random()}`, accountIds: [accountId], steps: [{ subject: 'Route' }] });
  const agent = await authedAgent();
  const res = await agent.post(`/api/campaigns/${seq.id}/enroll`).send({ contact_ids: contactIds });
  const enrolled = (await query<{ contact_id: string }>(
    `SELECT contact_id FROM sequence_enrollments WHERE sequence_id = $1`, [seq.id])).rows.map(r => r.contact_id);
  return { res, enrolled };
}

/** POST /api/campaigns/:id/enroll-all. */
export async function attemptEnrollAllRoute(accountId: string) {
  const seq = await createSequence({ name: `All ${Math.random()}`, accountIds: [accountId], steps: [{ subject: 'All' }] });
  const agent = await authedAgent();
  const res = await agent.post(`/api/campaigns/${seq.id}/enroll-all`).send({});
  const enrolled = (await query<{ contact_id: string }>(
    `SELECT contact_id FROM sequence_enrollments WHERE sequence_id = $1`, [seq.id])).rows.map(r => r.contact_id);
  return { res, enrolled };
}

/**
 * Blast: put the contacts in sector 'Residential', set up an active blast
 * campaign with one approved step due today, run the campaign engine tick and
 * drain the queue. Returns the outbox addresses that received the blast.
 */
export async function attemptBlast(contactIds: string[]): Promise<string[]> {
  await query(
    `UPDATE contacts SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"sector":"Residential"}'::jsonb WHERE id = ANY($1::uuid[])`,
    [contactIds]
  );
  await query(`INSERT INTO campaign_settings (tenant, is_active) VALUES ('tp', true)`);
  const seq = await query<{ id: string }>(
    `INSERT INTO sequences (name, status, type, frequency_days, start_date, tenant)
     VALUES ('Blast', 'active', 'blast', 30, '2026-10-01', 'tp') RETURNING id`
  );
  await query(
    `INSERT INTO sequence_steps (sequence_id, step_number, sector, subject_line, body_copy, blast_status, tenant)
     VALUES ($1, 1, 'Residential', 'Residential market note', '<p>Hi {{first_name}}, a short market note.</p>', 'approved', 'tp')`,
    [seq.rows[0].id]
  );
  const before = new Set((await outbox()).map(m => m.id));
  await campaignEngine.tick();
  await drainAll();
  return (await outbox()).filter(m => !before.has(m.id)).map(m => m.to_email.toLowerCase());
}

/**
 * Article broadcast: put contacts in subsector 'residential', POST the
 * broadcast route, wait for the background insert, run the broadcast planner,
 * drain. Returns addresses that received it.
 */
export async function attemptBroadcast(contactIds: string[]): Promise<{ status: number; delivered: string[] }> {
  await query(`UPDATE contacts SET subsector = 'residential' WHERE id = ANY($1::uuid[])`, [contactIds]);
  const art = await query<{ id: string }>(
    `INSERT INTO article_drafts (title, slug, excerpt, content, sector, publish_date, status, tenant)
     VALUES ('Market note', 'market-note-' || substr(md5(random()::text), 1, 8), 'Excerpt', '<p>Body</p>', 'announcement', '2026-10-01', 'published', 'tp')
     RETURNING id`
  );
  const before = new Set((await outbox()).map(m => m.id));
  const agent = await authedAgent();
  const res = await agent.post(`/api/articles/${art.rows[0].id}/broadcast`).send({ subsectors: ['residential'] });
  if (res.status === 200) {
    await waitFor(
      async () => (await query<{ status: string }>(`SELECT status FROM article_broadcasts WHERE article_id = $1`, [art.rows[0].id])).rows[0]?.status,
      s => s === 'sending' || s === 'failed',
    );
    await broadcastPlanner.plan();
    await drainAll();
  }
  return { status: res.status, delivered: (await outbox()).filter(m => !before.has(m.id)).map(m => m.to_email.toLowerCase()) };
}

/** Press release to `email` via POST /api/press-releases/:id/send, then drain. */
export async function attemptPressRelease(email: string): Promise<{ status: number; delivered: boolean; trackingId: string | null }> {
  const pc = await query<{ id: string }>(
    `INSERT INTO press_contacts (publication, contact_name, email) VALUES ('Property Week', 'News Desk', $1) RETURNING id`, [email]
  );
  const pr = await query<{ id: string }>(
    `INSERT INTO press_releases (announcement_title, publication, press_contact_id, headline, body, tenant)
     VALUES ('Fund close', 'Property Week', $1, 'TPCA arranges facility', 'Body text.', 'tp') RETURNING id`,
    [pc.rows[0].id]
  );
  const before = (await outboxTo(email)).length;
  const agent = await authedAgent();
  const res = await agent.post(`/api/press-releases/${pr.rows[0].id}/send`).send({});
  await drainAll();
  const send = (await query<{ tracking_id: string }>(
    `SELECT es.tracking_id FROM press_releases p JOIN email_sends es ON es.id = p.email_send_id WHERE p.id = $1`, [pr.rows[0].id]
  )).rows[0];
  return { status: res.status, delivered: (await outboxTo(email)).length > before, trackingId: send?.tracking_id ?? null };
}

/**
 * A queued send inserted directly (bypassing every planner) for `email`
 * (optionally linked to a contact), pushed through the real send queue.
 * Proves the send-gate alone blocks it.
 */
export async function attemptManualQueuedSend(accountId: string, email: string, contactId: string | null = null, tenant = 'tp') {
  const r = await query<{ id: string }>(
    `INSERT INTO email_sends (contact_id, email_account_id, to_email, from_email, subject, body_html, status, tenant)
     VALUES ($1, $2, $3, $4, 'Manual', '<p>Manual</p>', 'queued', $5) RETURNING id`,
    [contactId, accountId, email, SENDER, tenant]
  );
  await sendQueue.add({ emailSendId: r.rows[0].id, fromName: 'Marcus Emadi' }, 0);
  const before = (await outboxTo(email)).length;
  await drainAll();
  const row = (await query<{ status: string; error_message: string | null }>(`SELECT status, error_message FROM email_sends WHERE id = $1`, [r.rows[0].id])).rows[0];
  return { delivered: (await outboxTo(email)).length > before, status: row.status, error: row.error_message };
}

/**
 * Run every outbound channel against `email` / `contactId` with a clean control
 * contact alongside (so "not delivered" is never vacuous). Asserts the blocked
 * address gets nothing and the control gets every channel.
 */
export async function expectBlockedOnEveryChannel(accountId: string, email: string, contactId: string | null): Promise<void> {
  const control = await createContact({ email: `control-${Math.floor(Math.random() * 1e9)}@control-co.test`, firstName: 'Carl', type: 'developer' });
  const ids = contactId ? [contactId, control.id] : [control.id];

  if (contactId) {
    const seq = await attemptSequenceEnroll(accountId, contactId);
    expect(seq.refused, `sequence enrolment should be refused for ${email}`).toBe(true);
  }

  const blast = await attemptBlast(ids);
  expect(blast, 'blast control').toContain(control.email);
  expect(blast, `blast must not reach ${email}`).not.toContain(email.toLowerCase());

  const bc = await attemptBroadcast(ids);
  expect(bc.delivered, 'broadcast control').toContain(control.email);
  expect(bc.delivered, `broadcast must not reach ${email}`).not.toContain(email.toLowerCase());

  const press = await attemptPressRelease(email);
  expect(press.delivered, `press release must not reach ${email}`).toBe(false);

  const manual = await attemptManualQueuedSend(accountId, email, contactId);
  expect(manual.delivered, `manual queued send must not reach ${email}`).toBe(false);
  expect(manual.status).toBe('failed');
}

/** Compliance footer checks for one captured message. Returns the list of failures. */
export function footerProblems(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&middot;|&nbsp;|·/g, ' ').replace(/\s+/g, ' ');
  const problems: string[] = [];
  // The registered company is TPCommercialFinance Ltd (14537704); "Turning Point
  // Capital Advisory" is its trading name, not a registered company.
  if (!/\b[A-Z][A-Za-z&' -]* (Ltd|Limited)\b/.test(text)) problems.push('registered company name (… Ltd/Limited)');
  if (!/(company|co\.?|registered)\s*(no\.?|number|registration)[^0-9]{0,20}\d{6,8}/i.test(text)) problems.push('company registration number');
  if (!/registered office/i.test(text)) problems.push('registered office address');
  return problems;
}

export type { ContactRow, AccountRow };
