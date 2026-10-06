/**
 * Requirement 11: data-retention evidence. After an unsubscribe, bounce or
 * reply an auditor can reconstruct what was sent, when, from which mailbox,
 * what came back, and why the address is suppressed, from email_sends +
 * email_events + suppressed_emails + sequence_enrollments.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { query } from '../../../src/db/connection';
import { restoreClock, closeAll, runReplyWatcher, fakeGmail } from '../factories';
import { freshWorld, sentStepOne, getApp, SENDER, AccountRow } from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

/** What an auditor would run: full timeline for one address. */
async function auditTrail(email: string) {
  const sends = (await query<{
    id: string; status: string; to_email: string; from_email: string; subject: string; body_html: string;
    sent_at: Date | null; created_at: Date; gmail_message_id: string | null; gmail_thread_id: string | null;
    tracking_id: string; enrollment_id: string | null; sequence_step_id: string | null; tenant: string;
  }>(`SELECT * FROM email_sends WHERE LOWER(to_email) = LOWER($1) ORDER BY created_at`, [email])).rows;
  const events = (await query<{ email_send_id: string; event_type: string; created_at: Date }>(
    `SELECT ee.email_send_id, ee.event_type, ee.created_at FROM email_events ee
     JOIN email_sends es ON es.id = ee.email_send_id WHERE LOWER(es.to_email) = LOWER($1) ORDER BY ee.created_at`, [email])).rows;
  const suppression = (await query<{ reason: string; source: string; suppressed_at: Date; tenant: string }>(
    `SELECT reason, source, suppressed_at, tenant FROM suppressed_emails WHERE LOWER(email) = LOWER($1)`, [email])).rows;
  const enrollments = (await query<{ id: string; status: string; enrolled_at: Date; sequence_id: string }>(
    `SELECT se.id, se.status, se.enrolled_at, se.sequence_id FROM sequence_enrollments se
     JOIN contacts c ON c.id = se.contact_id WHERE LOWER(c.email) = LOWER($1)`, [email])).rows;
  return { sends, events, suppression, enrollments };
}

function expectReconstructable(t: Awaited<ReturnType<typeof auditTrail>>, expected: { event: string; suppressionSource: string; sendStatus: string }) {
  expect(t.sends).toHaveLength(1);
  const s = t.sends[0];
  expect(s.status).toBe(expected.sendStatus);
  expect(s.from_email).toBe(SENDER);
  expect(s.subject).toBe('Funding for Example Developments Ltd');
  expect(s.body_html).toContain('Step 1 copy');
  expect(s.sent_at).toBeInstanceOf(Date);
  expect(s.gmail_message_id).toBeTruthy();
  expect(s.gmail_thread_id).toBeTruthy();
  expect(s.tracking_id).toBeTruthy();
  expect(s.enrollment_id).toBeTruthy();
  expect(s.sequence_step_id).toBeTruthy();
  expect(s.tenant).toBe('tp');

  const ev = t.events.find(e => e.event_type === expected.event);
  expect(ev, `event '${expected.event}' retained`).toBeDefined();
  expect(ev!.created_at).toBeInstanceOf(Date);
  expect(ev!.email_send_id).toBe(s.id);

  expect(t.suppression).toHaveLength(1);
  expect(t.suppression[0].source).toBe(expected.suppressionSource);
  expect(t.suppression[0].reason).toBeTruthy();
  expect(t.suppression[0].suppressed_at).toBeInstanceOf(Date);

  expect(t.enrollments).toHaveLength(1);
  expect(['cancelled', 'replied']).toContain(t.enrollments[0].status);
}

describe('R11 audit trail survives every terminal outcome', () => {
  it('unsubscribe via link: send, unsubscribe event (with IP/UA), suppression and enrollment all retained', async () => {
    const { contact, mail } = await sentStepOne({ account });
    const app = await getApp();
    await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`).set('User-Agent', 'AuditTest/1.0');
    const t = await auditTrail(contact.email);
    expectReconstructable(t, { event: 'unsubscribe', suppressionSource: 'unsubscribe-link', sendStatus: 'sent' });
    const ua = (await query<{ user_agent: string; ip_address: string }>(
      `SELECT user_agent, ip_address FROM email_events WHERE event_type = 'unsubscribe'`)).rows[0];
    expect(ua.user_agent).toBe('AuditTest/1.0');
    expect(ua.ip_address).toBeTruthy();
  });

  it('unsubscribe via reply: trail retained', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectReply({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body: 'Unsubscribe please.' });
    await runReplyWatcher();
    expectReconstructable(await auditTrail(contact.email), { event: 'unsubscribe', suppressionSource: 'reply-watcher', sendStatus: 'sent' });
  });

  it('hard bounce: trail retained (send kept with status bounced)', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectBounce({ mailbox: SENDER, threadId: mail.fake_thread_id, recipient: contact.email, hard: true });
    await runReplyWatcher();
    expectReconstructable(await auditTrail(contact.email), { event: 'bounce', suppressionSource: 'reply-watcher', sendStatus: 'bounced' });
  });

  it('human reply: trail retained, including the forward to marcus@', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectReply({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body: 'Interested, can we talk next week about the Leeds scheme?' });
    await runReplyWatcher();
    const t = await auditTrail(contact.email);
    expectReconstructable(t, { event: 'reply', suppressionSource: 'reply-watcher', sendStatus: 'sent' });
    expect(t.events.map(e => e.event_type)).toContain('reply_fwd');
  });

  it('left company: trail retained', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectOOO({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Automatic reply: ${mail.subject}`, body: 'Jane has left the company.' });
    await runReplyWatcher();
    expectReconstructable(await auditTrail(contact.email), { event: 'left_company', suppressionSource: 'reply-watcher', sendStatus: 'sent' });
  });

  it('a later attempted send that the gate refused is itself recorded (status failed + reason)', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });
    await query(`UPDATE sequence_enrollments SET next_step_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [enrollmentId]);
    const { runPlannerPass } = await import('../factories');
    await runPlannerPass(); // step 2 queued
    const app = await getApp();
    await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`);
    const { drainAll } = await import('./helpers');
    await drainAll();
    const rows = (await query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM email_sends WHERE LOWER(to_email) = LOWER($1) ORDER BY created_at`, [contact.email])).rows;
    expect(rows.map(r => r.status)).toEqual(['sent', 'failed']);
    // the gate checks enrollment status first; the unsubscribe event above explains why it was cancelled
    expect(rows[1].error_message).toMatch(/unsubscribed|suppressed|enrollment cancelled/i);
  });
});
