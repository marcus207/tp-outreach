/**
 * Requirement 1 (human reply), 4 (OOO / auto-reply), 5 (left company).
 * Path: enrol -> plan -> queue -> gate -> dryrun send -> inbound via FakeGmail
 * -> ReplyWatcher.pollAllAccounts -> outcome.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { restoreClock, closeAll, runReplyWatcher, enrollment, isEmailSuppressed, fakeGmail, createContact } from '../factories';
import {
  freshWorld, sentStepOne, expectNoFurtherSequenceSend, expectNextStepSends, eventsForSend,
  contactById, SENDER, PRIMARY, AccountRow, expectBlockedOnEveryChannel,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

describe('R1 human reply: stop sequence, suppress, forward to marcus@', () => {
  it('reply in the same thread stops all further steps, suppresses the address and forwards to marcus@tp.finance', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });

    fakeGmail.injectReply({
      mailbox: SENDER, threadId: mail.fake_thread_id,
      from: `Jane Developer <${contact.email}>`,
      subject: `Re: ${mail.subject}`,
      body: 'Hi Marcus, timely. Could we speak Thursday afternoon about the Leeds scheme?',
    });
    await runReplyWatcher();

    const enr = await enrollment(enrollmentId);
    expect(enr.status).toBe('replied');
    expect(enr.replied_at).not.toBeNull();
    expect(await isEmailSuppressed(contact.email)).toBe(true);
    expect((await eventsForSend(send.id)).map(e => e.event_type)).toEqual(expect.arrayContaining(['reply', 'reply_fwd']));

    expect(fakeGmail.sent).toHaveLength(1);
    expect(fakeGmail.sent[0].headers.To).toBe(PRIMARY);
    expect(fakeGmail.sent[0].raw).toContain('Leeds scheme');

    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
    // polling again is idempotent: no second forward
    await runReplyWatcher();
    expect(fakeGmail.sent).toHaveLength(1);
  });

  it('reply on a NEW thread is matched by subject fallback (Re: <subject>) and stops the sequence', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });

    fakeGmail.injectReply({
      mailbox: SENDER, threadId: 'unrelated-thread-123',
      from: `"Jane Developer" <${contact.email}>`,
      subject: `RE: ${mail.subject}`,
      body: 'Yes please send over your terms sheet template.',
    });
    await runReplyWatcher();

    expect((await enrollment(enrollmentId)).status).toBe('replied');
    expect(await isEmailSuppressed(contact.email)).toBe(true);
    expect(fakeGmail.sent.map(s => s.headers.To)).toEqual([PRIMARY]);
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
  });

  it('reply from a colleague address in the same thread stops the sequence for the original recipient and is forwarded', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });

    fakeGmail.injectReply({
      mailbox: SENDER, threadId: mail.fake_thread_id,
      from: 'Tom Colleague <tom@harbourside-dev.test>',
      subject: `Re: ${mail.subject}`,
      body: 'Jane passed this to me, I run our funding. Free for a call Tuesday?',
    });
    await runReplyWatcher();

    expect((await enrollment(enrollmentId)).status).toBe('replied');
    expect(await isEmailSuppressed(contact.email)).toBe(true);
    expect(fakeGmail.sent).toHaveLength(1);
    expect(fakeGmail.sent[0].headers.To).toBe(PRIMARY);
    expect(fakeGmail.sent[0].raw).toContain('tom@harbourside-dev.test');
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
  });

  it('after a human reply the address receives nothing from any channel (sequence, blast, broadcast, press, manual queue)', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectReply({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body: 'Call me Thursday please, keen to discuss.' });
    await runReplyWatcher();
    await expectBlockedOnEveryChannel(account.id, contact.email, contact.id);
  });
});

describe('R4 out-of-office / auto-reply: no suppression, sequence continues', () => {
  it('OOO auto-reply (Auto-Submitted header) does not suppress, does not forward, and step 2 still sends', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });

    fakeGmail.injectOOO({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email });
    await runReplyWatcher();

    expect((await enrollment(enrollmentId)).status).toBe('active');
    expect(await isEmailSuppressed(contact.email)).toBe(false);
    expect(fakeGmail.sent).toHaveLength(0);
    expect((await eventsForSend(send.id)).map(e => e.event_type)).toEqual(['ooo']);
    await expectNextStepSends(enrollmentId, contact.email);
  });

  it('OOO identified by subject only ("Out of Office: ...", no auto headers) does not suppress and the sequence continues', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });

    fakeGmail.injectReply({
      mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email,
      subject: `Out of Office: ${mail.subject}`,
      body: 'I am on annual leave until 12 October with no access to email.',
    });
    await runReplyWatcher();

    expect((await enrollment(enrollmentId)).status).toBe('active');
    expect(await isEmailSuppressed(contact.email)).toBe(false);
    await expectNextStepSends(enrollmentId, contact.email);
  });

  it('generic auto-acknowledgement (Auto-Submitted, not OOO) does not suppress and the sequence continues', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });

    fakeGmail.injectOOO({
      mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email,
      subject: `Automatic reply: ${mail.subject}`,
      body: 'Thank you for your email. We aim to respond within two working days.',
    });
    await runReplyWatcher();

    expect((await enrollment(enrollmentId)).status).toBe('active');
    expect(await isEmailSuppressed(contact.email)).toBe(false);
    await expectNextStepSends(enrollmentId, contact.email);
  });
});

describe('R5 left company', () => {
  it('auto-reply "X has left the company" suppresses the address, cancels the sequence, keeps the contact row', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });

    fakeGmail.injectOOO({
      mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email,
      subject: `Automatic reply: ${mail.subject}`,
      body: 'Jane Developer has left the company. For funding enquiries please contact info@harbourside-dev.test.',
    });
    await runReplyWatcher();

    expect(await isEmailSuppressed(contact.email)).toBe(true);
    expect((await enrollment(enrollmentId)).status).toBe('cancelled');
    expect(await contactById(contact.id)).toBeDefined();
    expect((await eventsForSend(send.id)).map(e => e.event_type)).toContain('left_company');
    expect(fakeGmail.sent).toHaveLength(0);
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
  });

  it('a long HUMAN reply mentioning "since John has left" is a human reply (forwarded), not left-company', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    const body = [
      'Hi Marcus,',
      'Thanks for reaching out. Since John has left, I have taken over responsibility for our development funding',
      'across the north west pipeline. We have two residential schemes in Salford and one later living scheme in Stockport',
      'coming through planning this quarter, with total development costs of around forty million pounds. We are looking',
      'at senior plus mezzanine structures and would value an independent view on terms. Could you share some recent',
      'comparable deals and availability for a call next Wednesday or Thursday morning? Happy to send our appraisals.',
      'Best regards, Priya',
    ].join('\n');

    fakeGmail.injectReply({ mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body });
    await runReplyWatcher();

    const types = (await eventsForSend(send.id)).map(e => e.event_type);
    expect(types).toContain('reply');
    expect(types).not.toContain('left_company');
    expect(fakeGmail.sent).toHaveLength(1);
    expect(fakeGmail.sent[0].headers.To).toBe(PRIMARY);
    expect((await enrollment(enrollmentId)).status).toBe('replied');
  });

  it('left-company suppression is exact-address only: a colleague at the same domain can still be enrolled', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectOOO({
      mailbox: SENDER, threadId: mail.fake_thread_id, from: contact.email,
      subject: `Automatic reply: ${mail.subject}`, body: 'Jane is no longer with Harbourside.',
    });
    await runReplyWatcher();
    expect(await isEmailSuppressed(contact.email)).toBe(true);

    const colleague = await createContact({ email: 'tom@harbourside-dev.test', type: 'developer' });
    expect(await isEmailSuppressed(colleague.email)).toBe(false);
  });
});
