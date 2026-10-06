/**
 * Requirement 3: bounces.
 *   hard DSN (550 5.1.1)  => send bounced, suppressed, contact tagged bounced,
 *                            enrollment cancelled, contact + history NOT deleted
 *   soft DSN (4.x.x)      => nothing suppressed, sequence continues
 *   unknown DSN content   => treated soft
 * DSNs land in the INBOX on the outbound thread, as Gmail delivers them, so
 * both the reply poll and the bounce poll see them.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  restoreClock, closeAll, runReplyWatcher, enrollment, isEmailSuppressed, fakeGmail, emailSends,
} from '../factories';
import {
  freshWorld, sentStepOne, expectNoFurtherSequenceSend, expectNextStepSends, eventsForSend,
  contactById, injectDsn, expectBlockedOnEveryChannel, SENDER, AccountRow,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

describe('R3 hard bounce', () => {
  it('550 5.1.1 user unknown: send=bounced, suppressed, tagged bounced, enrollment cancelled, contact and history kept', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    fakeGmail.injectBounce({ mailbox: SENDER, threadId: mail.fake_thread_id, recipient: contact.email, hard: true });
    await runReplyWatcher();

    const s = (await emailSends(`id = $1`, [send.id]))[0];
    expect(s).toBeDefined();
    expect(s.status).toBe('bounced');
    expect(await isEmailSuppressed(contact.email)).toBe(true);
    const c = await contactById(contact.id);
    expect(c).toBeDefined();
    expect(c.tags).toContain('bounced');
    expect((await enrollment(enrollmentId)).status).toBe('cancelled');
    expect((await eventsForSend(send.id)).map(e => e.event_type)).toContain('bounce');
    expect(fakeGmail.sent).toHaveLength(0); // a bounce is never forwarded as a "reply"
    await expectNoFurtherSequenceSend(enrollmentId, contact.email);
  });

  it('after a hard bounce the address receives nothing from any channel', async () => {
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectBounce({ mailbox: SENDER, threadId: mail.fake_thread_id, recipient: contact.email, hard: true });
    await runReplyWatcher();
    await expectBlockedOnEveryChannel(account.id, contact.email, contact.id);
  });

  it('a hard bounce is processed once even if polled repeatedly (one bounce event)', async () => {
    const { contact, mail, send } = await sentStepOne({ account });
    fakeGmail.injectBounce({ mailbox: SENDER, threadId: mail.fake_thread_id, recipient: contact.email, hard: true });
    await runReplyWatcher();
    await runReplyWatcher();
    expect((await eventsForSend(send.id)).filter(e => e.event_type === 'bounce')).toHaveLength(1);
  });
});

describe('R3 soft bounce: nothing suppressed, sequence continues', () => {
  it('4.4.1 delayed DSN (harness canned soft bounce) does not suppress and step 2 still sends', async () => {
    const { contact, enrollmentId, mail, send } = await sentStepOne({ account });
    fakeGmail.injectBounce({ mailbox: SENDER, threadId: mail.fake_thread_id, recipient: contact.email, hard: false });
    await runReplyWatcher();

    expect(await isEmailSuppressed(contact.email)).toBe(false);
    expect((await contactById(contact.id)).tags).not.toContain('bounced');
    expect((await enrollment(enrollmentId)).status).toBe('active');
    expect((await emailSends(`id = $1`, [send.id]))[0].status).toBe('sent');
    expect(fakeGmail.sent).toHaveLength(0);
    await expectNextStepSends(enrollmentId, contact.email);
  });

  it('452 4.2.2 mailbox full DSN does not suppress and the sequence continues', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });
    injectDsn({
      mailbox: SENDER, threadId: mail.fake_thread_id,
      subject: 'Delivery Status Notification (Delay)',
      body: `Message temporarily rejected\nThe recipient's inbox is full and can't accept messages right now. Gmail will keep trying for a while.\n\nFinal-Recipient: rfc822; ${contact.email}\nAction: delayed\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 4.2.2 The recipient's mailbox is over quota`,
    });
    await runReplyWatcher();

    expect(await isEmailSuppressed(contact.email)).toBe(false);
    expect((await enrollment(enrollmentId)).status).toBe('active');
    await expectNextStepSends(enrollmentId, contact.email);
  });

  it('soft DSN carrying Auto-Submitted: auto-replied (as real Gmail DSNs do) does not suppress', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });
    injectDsn({
      mailbox: SENDER, threadId: mail.fake_thread_id,
      subject: 'Delivery Status Notification (Delay)',
      extraHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
      body: `Delivery incomplete\nThere was a temporary problem delivering your message to ${contact.email}. Gmail will retry for 47 more hours.\n\nAction: delayed\nStatus: 4.4.1`,
    });
    await runReplyWatcher();

    expect(await isEmailSuppressed(contact.email)).toBe(false);
    expect((await enrollment(enrollmentId)).status).toBe('active');
  });

  it('DSN with unknown/unparseable content is treated as soft: no suppression, sequence continues', async () => {
    const { contact, enrollmentId, mail } = await sentStepOne({ account });
    injectDsn({
      mailbox: SENDER, threadId: mail.fake_thread_id,
      subject: 'Delivery Status Notification',
      body: 'Something happened while processing your message. Reference: 7F3A-22B1.',
    });
    await runReplyWatcher();

    expect(await isEmailSuppressed(contact.email)).toBe(false);
    expect((await contactById(contact.id)).tags).not.toContain('bounced');
    expect((await enrollment(enrollmentId)).status).toBe('active');
    await expectNextStepSends(enrollmentId, contact.email);
  });
});
