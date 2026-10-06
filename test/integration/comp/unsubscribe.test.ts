/**
 * Requirement 2: unsubscribe by link (GET confirm page / GET ?confirm=1 /
 * RFC 8058 one-click POST) and by reply; after an OOO; press release with no
 * contact; case-insensitivity. Outcome every time: suppressed_emails row,
 * contact tagged, enrollments cancelled, unsubscribe event retained, and no
 * future send of any kind to that address.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { query } from '../../../src/db/connection';
import {
  restoreClock, closeAll, runReplyWatcher, enrollment, isEmailSuppressed, fakeGmail,
  createSequence, enroll, outbox, suppress,
} from '../factories';
import {
  freshWorld, sentStepOne, getApp, expectNoFurtherSequenceSend, expectBlockedOnEveryChannel, eventsForSend,
  contactById, suppressionRows, enrollmentsFor, attemptPressRelease, attemptManualQueuedSend, attemptSequenceEnroll,
  planAndSend, outboxTo, SENDER, AccountRow,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

/** The full set of post-unsubscribe outcomes required for every route in. */
async function expectFullyUnsubscribed(o: { email: string; contactId: string; sendId: string; enrollmentIds: string[] }) {
  const rows = await suppressionRows(o.email);
  expect(rows.filter(r => r.tenant === 'tp')).toHaveLength(1);
  expect((await contactById(o.contactId)).tags).toContain('unsubscribed');
  for (const id of o.enrollmentIds) expect(['cancelled']).toContain((await enrollment(id)).status);
  expect((await eventsForSend(o.sendId)).map(e => e.event_type)).toContain('unsubscribe');
}

describe('R2 unsubscribe by link', () => {
  it('GET /t/:id/unsubscribe shows a confirmation page and does NOT unsubscribe', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    const app = await getApp();
    const res = await request(app).get(`/t/${mail.tracking_id}/unsubscribe`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Confirm Unsubscribe/);
    expect(await isEmailSuppressed(contact.email)).toBe(false);
    expect((await contactById(contact.id)).tags).not.toContain('unsubscribed');
    expect((await enrollment(enrollmentId)).status).toBe('active');
    expect((await eventsForSend(send.id)).map(e => e.event_type)).not.toContain('unsubscribe');
  });

  it('GET ?confirm=1 unsubscribes: suppressed, tagged, ALL enrollments cancelled, event kept, nothing further sent', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    // second, unrelated sequence for the same contact must also stop
    const other = await createSequence({ name: 'Other', accountIds: [account.id], steps: [{ subject: 'Other 1' }, { subject: 'Other 2' }] });
    const otherEnr = await enroll(other.id, contact.id);

    const app = await getApp();
    const res = await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/unsubscribed/i);

    await expectFullyUnsubscribed({ email: contact.email, contactId: contact.id, sendId: send.id, enrollmentIds: [enrollmentId, otherEnr] });
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
    await expectNoFurtherSequenceSend(otherEnr, contact.email);
    await expectBlockedOnEveryChannel(account.id, contact.email, contact.id);
  });

  it('RFC 8058 one-click POST (application/x-www-form-urlencoded "List-Unsubscribe=One-Click") unsubscribes', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    const app = await getApp();
    const res = await request(app)
      .post(`/t/${mail.tracking_id}/unsubscribe`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    await expectFullyUnsubscribed({ email: contact.email, contactId: contact.id, sendId: send.id, enrollmentIds: [enrollmentId] });
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
  });

  it('RFC 8058 one-click POST sent as multipart/form-data (allowed by RFC 8058 s3.1) unsubscribes', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    const app = await getApp();
    const res = await request(app)
      .post(`/t/${mail.tracking_id}/unsubscribe`)
      .field('List-Unsubscribe', 'One-Click');
    expect(res.status).toBe(200);
    await expectFullyUnsubscribed({ email: contact.email, contactId: contact.id, sendId: send.id, enrollmentIds: [enrollmentId] });
  });

  it('a bare POST with no One-Click body is ignored (link-scanner protection) and does not unsubscribe', async () => {
    const { contact, mail } = await sentStepOne({ account });
    const app = await getApp();
    const res = await request(app).post(`/t/${mail.tracking_id}/unsubscribe`);
    expect(res.status).toBe(200);
    expect(await isEmailSuppressed(contact.email)).toBe(false);
  });

  it('unsubscribe while the next step is already queued in Redis: the gate blocks the queued send', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });
    // queue step 2 (planner -> BullMQ) but do not drain yet
    const { runPlannerPass } = await import('../factories');
    await query(`UPDATE sequence_enrollments SET next_step_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [enrollmentId]);
    expect((await runPlannerPass()).planned).toBe(1);

    const app = await getApp();
    await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`);
    await planAndSend();

    expect(await outboxTo(contact.email)).toHaveLength(1);
    const step2 = (await query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM email_sends WHERE enrollment_id = $1 ORDER BY created_at DESC LIMIT 1`, [enrollmentId])).rows[0];
    expect(step2.status).toBe('failed');
  });

  it('unknown tracking id: confirm page renders but nothing is suppressed', async () => {
    const app = await getApp();
    const res = await request(app).get(`/t/deadbeef/unsubscribe?confirm=1`);
    expect(res.status).toBe(200);
    expect((await query(`SELECT 1 FROM suppressed_emails`)).rows).toHaveLength(0);
  });
});

describe('R2 unsubscribe by reply', () => {
  const cases: Array<[string, string]> = [
    ['"please remove me"', 'Please remove me from your mailing list.'],
    ['"unsubscribe"', 'unsubscribe'],
    ['"not interested" with signature and quoted original', [
      'Not interested, thanks.',
      '',
      'Jane Developer',
      'Director | Harbourside Developments Ltd',
      'T: 020 7946 0000',
      '',
      'On Mon, 5 Oct 2026 at 10:00, Marcus Emadi <marcus.emadi@go.tp.finance> wrote:',
      '> Hi Jane,',
      '> We have helped developers across the North West structure senior and mezzanine development',
      '> finance on schemes from fifteen to eighty million pounds. If funding is on the agenda for',
      '> Harbourside this year I would be glad to share recent comparable terms. Do let me know.',
      '> Unsubscribe',
    ].join('\n')],
  ];

  for (const [label, body] of cases) {
    it(`reply ${label}: suppressed, tagged, enrollment cancelled, event kept, NOT forwarded, nothing further sent`, async () => {
      const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
      fakeGmail.injectReply({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body });
      await runReplyWatcher();

      await expectFullyUnsubscribed({ email: contact.email, contactId: contact.id, sendId: send.id, enrollmentIds: [enrollmentId] });
      expect(fakeGmail.sent).toHaveLength(0);
      await expectNoFurtherSequenceSend(enrollmentId, contact.email);
    });
  }

  it('unsubscribe reply AFTER an earlier OOO on the same send still unsubscribes fully', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    fakeGmail.injectOOO({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email });
    await runReplyWatcher();
    expect(await isEmailSuppressed(contact.email)).toBe(false);

    fakeGmail.injectReply({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body: 'Back now. Please remove me from your list.' });
    await runReplyWatcher();

    await expectFullyUnsubscribed({ email: contact.email, contactId: contact.id, sendId: send.id, enrollmentIds: [enrollmentId] });
    const types = (await eventsForSend(send.id)).map(e => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['ooo', 'unsubscribe']));
    await expectBlockedOnEveryChannel(account.id, contact.email, contact.id);
  });

  it('unsubscribe link AFTER an earlier OOO on the same send unsubscribes fully', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    fakeGmail.injectOOO({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email });
    await runReplyWatcher();
    const app = await getApp();
    await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`);
    await expectFullyUnsubscribed({ email: contact.email, contactId: contact.id, sendId: send.id, enrollmentIds: [enrollmentId] });
  });
});

describe('R2 unsubscribe from a press release (send has no contact)', () => {
  it('press release send with no contact_id: link unsubscribe suppresses the address and blocks every later send', async () => {
    const email = 'newsdesk@propertyweek.test';
    const first = await attemptPressRelease(email);
    expect(first.status).toBe(200);
    expect(first.delivered).toBe(true);
    const sendRow = (await query<{ id: string; contact_id: string | null }>(`SELECT id, contact_id FROM email_sends WHERE tracking_id = $1`, [first.trackingId])).rows[0];
    expect(sendRow.contact_id).toBeNull();

    const app = await getApp();
    await request(app).get(`/t/${first.trackingId}/unsubscribe?confirm=1`);

    expect((await suppressionRows(email)).filter(r => r.tenant === 'tp')).toHaveLength(1);
    expect((await eventsForSend(sendRow.id)).map(e => e.event_type)).toContain('unsubscribe');

    const second = await attemptPressRelease(email);
    expect(second.delivered).toBe(false);
    const manual = await attemptManualQueuedSend(account.id, email, null);
    expect(manual.delivered).toBe(false);
  });

  it('press release unsubscribe also tags + stops a sequence contact with the same address', async () => {
    const { contact, enrollmentId } = await sentStepOne({ account, email: 'editor@estatesgazette.test' });
    const pr = await attemptPressRelease(contact.email);
    expect(pr.delivered).toBe(true);
    const app = await getApp();
    await request(app).get(`/t/${pr.trackingId}/unsubscribe?confirm=1`);
    expect((await contactById(contact.id)).tags).toContain('unsubscribed');
    expect((await enrollment(enrollmentId)).status).toBe('cancelled');
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
  });
});

describe('R2 case-insensitivity', () => {
  it('suppression of upper@example.com blocks a contact stored as Upper@Example.com (enrol + gate + press)', async () => {
    const c = (await query<{ id: string; email: string }>(
      `INSERT INTO contacts (email, first_name, contact_type, tenant, source) VALUES ('Upper@Example.com', 'Una', 'developer', 'tp', 'test') RETURNING id, email`
    )).rows[0];
    await suppress('upper@example.com', { source: 'unsubscribe-link' });

    expect((await attemptSequenceEnroll(account.id, c.id)).refused).toBe(true);
    expect((await attemptManualQueuedSend(account.id, 'Upper@Example.com', c.id)).delivered).toBe(false);
    expect((await attemptManualQueuedSend(account.id, 'UPPER@EXAMPLE.COM', null)).delivered).toBe(false);
    expect((await attemptPressRelease('UPPER@example.com')).delivered).toBe(false);
  });

  it('unsubscribing a send to Upper@Example.com stores the address lower-cased and blocks upper@example.com', async () => {
    const c = (await query<{ id: string }>(
      `INSERT INTO contacts (email, first_name, contact_type, tenant, source, subsector) VALUES ('Upper@Example.com', 'Una', 'developer', 'tp', 'test', 'residential') RETURNING id`
    )).rows[0];
    const seq = await createSequence({ accountIds: [account.id], steps: [{ subject: 'Hello' }, { subject: 'Again' }] });
    const enr = await enroll(seq.id, c.id);
    await planAndSend();
    const mail = (await outbox())[0];
    expect(mail.to_email).toBe('Upper@Example.com');

    const app = await getApp();
    await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`);
    const rows = await suppressionRows('upper@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('upper@example.com');
    expect((await enrollmentsFor(c.id)).map(e => e.status)).toEqual(['cancelled']);
    expect((await attemptManualQueuedSend(account.id, 'upper@example.com', null)).delivered).toBe(false);
    await expectNoFurtherSequenceSend(enr, 'upper@example.com');
  });
});
