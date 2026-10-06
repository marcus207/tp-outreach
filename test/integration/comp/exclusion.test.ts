/**
 * Requirement 6: lender exclusion + hold/unsubscribed/bounced tags + suppressed
 * addresses are refused on EVERY path: enrollContact, POST enroll, POST
 * enroll-all, blast, article broadcast, press release, and a queued send
 * inserted by hand (send-gate). Domain suppression only for source='manual'
 * rows with a domain; a single-person suppression carrying a domain must not
 * block colleagues.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../../../src/db/connection';
import { restoreClock, closeAll, createContact, createSequence, enroll, suppress, enrollment, runPlannerPass } from '../factories';
import {
  freshWorld, attemptSequenceEnroll, attemptEnrollRoute, attemptEnrollAllRoute, attemptBlast, attemptBroadcast,
  attemptPressRelease, attemptManualQueuedSend, expectBlockedOnEveryChannel, sentStepOne, forceDue, planAndSend,
  outboxTo, AccountRow, ContactRow,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

type Blocker = { name: string; make: () => Promise<ContactRow> };

const blockers: Blocker[] = [
  { name: "contact_type='lender'", make: () => createContact({ email: 'credit@bigbank-lending.test', type: 'lender', subsector: 'residential' }) },
  { name: "contact_type='Lender' (mixed case)", make: () => createContact({ email: 'credit@otherbank.test', type: 'Lender', subsector: 'residential' }) },
  { name: "tag 'hold'", make: () => createContact({ email: 'held@dev-co.test', tags: ['hold'], subsector: 'residential' }) },
  { name: "tag 'unsubscribed'", make: () => createContact({ email: 'gone@dev-co.test', tags: ['unsubscribed'], subsector: 'residential' }) },
  { name: "tag 'bounced'", make: () => createContact({ email: 'dead@dev-co.test', tags: ['bounced'], subsector: 'residential' }) },
  {
    name: 'address on suppressed_emails',
    make: async () => {
      const c = await createContact({ email: 'suppressed@dev-co.test', subsector: 'residential' });
      await suppress(c.email, { source: 'unsubscribe-link', reason: 'unsubscribed (link)' });
      return c;
    },
  },
  {
    name: 'manual DOMAIN suppression (source=manual, domain set)',
    make: async () => {
      await suppress('admin@blocked-firm.test', { source: 'manual', domain: 'blocked-firm.test', reason: 'firm opted out' });
      return createContact({ email: 'analyst@blocked-firm.test', subsector: 'residential' });
    },
  },
];

describe.each(blockers)('R6 $name is excluded everywhere', ({ make }) => {
  it('enrollContact refuses', async () => {
    const c = await make();
    expect((await attemptSequenceEnroll(account.id, c.id)).refused).toBe(true);
  });

  it('POST /api/campaigns/:id/enroll does not enrol it', async () => {
    const c = await make();
    const { res, enrolled } = await attemptEnrollRoute(account.id, [c.id]);
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(0);
    expect(enrolled).not.toContain(c.id);
  });

  it('POST /api/campaigns/:id/enroll-all does not enrol it (a clean contact is enrolled)', async () => {
    const c = await make();
    const ok = await createContact({ email: 'clean@ok-dev.test' });
    const { res, enrolled } = await attemptEnrollAllRoute(account.id);
    expect(res.status).toBe(200);
    expect(enrolled).toContain(ok.id);
    expect(enrolled).not.toContain(c.id);
  });

  it('blast, broadcast, press release and a hand-queued send never reach it', async () => {
    const c = await make();
    await expectBlockedOnEveryChannel(account.id, c.email, c.id);
  });
});

describe('R6 lender/blocked status applied AFTER enrolment', () => {
  it('contact reclassified as lender after step 1: planner cancels and nothing further is sent', async () => {
    const { contact, enrollmentId } = await sentStepOne({ account });
    await query(`UPDATE contacts SET contact_type = 'lender' WHERE id = $1`, [contact.id]);
    await forceDue(enrollmentId);
    await planAndSend();
    expect(await outboxTo(contact.email)).toHaveLength(1);
    expect((await enrollment(enrollmentId)).status).toBe('cancelled');
  });

  it('contact reclassified as lender while step 2 is already queued: the gate fails the send and cancels the enrollment', async () => {
    const { contact, enrollmentId } = await sentStepOne({ account });
    await forceDue(enrollmentId);
    expect((await runPlannerPass()).planned).toBe(1);
    await query(`UPDATE contacts SET contact_type = 'lender' WHERE id = $1`, [contact.id]);
    await planAndSend();
    expect(await outboxTo(contact.email)).toHaveLength(1);
    const last = (await query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM email_sends WHERE enrollment_id = $1 ORDER BY created_at DESC LIMIT 1`, [enrollmentId])).rows[0];
    expect(last.status).toBe('failed');
    expect(last.error_message).toMatch(/lender/i);
    expect((await enrollment(enrollmentId)).status).toBe('cancelled');
  });

  it('a lender with a second contact row (same address, other type) is still blocked by the gate', async () => {
    const lender = await createContact({ email: 'dup@bank-co.test', type: 'lender' });
    const r = await attemptManualQueuedSend(account.id, 'DUP@bank-co.test', null);
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/lender/i);
    void lender;
  });
});

describe('R6 single-person suppression carrying a domain must NOT block colleagues', () => {
  async function setup() {
    // e.g. written by an unsubscribe/reply path or an import that filled `domain`
    await suppress('alice@acme-dev.test', { source: 'reply-watcher', domain: 'acme-dev.test', reason: 'replied' });
    return createContact({ email: 'bob@acme-dev.test', firstName: 'Bob', subsector: 'residential' });
  }

  it('enrollContact accepts the colleague', async () => {
    const bob = await setup();
    expect((await attemptSequenceEnroll(account.id, bob.id)).refused).toBe(false);
  });

  it('send-gate delivers a queued send to the colleague', async () => {
    const bob = await setup();
    expect((await attemptManualQueuedSend(account.id, bob.email, bob.id)).delivered).toBe(true);
  });

  it('a sequence send to the colleague goes out end to end', async () => {
    const bob = await setup();
    const seq = await createSequence({ accountIds: [account.id], steps: [{ subject: 'Hello Bob' }] });
    await enroll(seq.id, bob.id);
    await planAndSend();
    expect(await outboxTo(bob.email)).toHaveLength(1);
  });

  it('POST /api/campaigns/:id/enroll enrols the colleague', async () => {
    const bob = await setup();
    const { enrolled } = await attemptEnrollRoute(account.id, [bob.id]);
    expect(enrolled).toContain(bob.id);
  });

  it('POST /api/campaigns/:id/enroll-all enrols the colleague', async () => {
    const bob = await setup();
    const { enrolled } = await attemptEnrollAllRoute(account.id);
    expect(enrolled).toContain(bob.id);
  });

  it('blast reaches the colleague', async () => {
    const bob = await setup();
    expect(await attemptBlast([bob.id])).toContain(bob.email);
  });

  it('article broadcast reaches the colleague', async () => {
    const bob = await setup();
    expect((await attemptBroadcast([bob.id])).delivered).toContain(bob.email);
  });

  it('press release reaches the colleague', async () => {
    await setup();
    expect((await attemptPressRelease('news@acme-dev.test')).delivered).toBe(true);
  });

  it('the suppressed person herself is still blocked', async () => {
    await setup();
    expect((await attemptManualQueuedSend(account.id, 'alice@acme-dev.test', null)).delivered).toBe(false);
  });
});
