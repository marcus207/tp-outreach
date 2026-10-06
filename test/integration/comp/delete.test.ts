/**
 * Requirement 9: contact delete via the API puts the address on
 * suppressed_emails; re-creating or re-importing the same address must leave
 * it non-enrollable and non-sendable.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../../../src/db/connection';
import { restoreClock, closeAll, createContact, emailSends, suppress } from '../factories';
import {
  freshWorld, authedAgent, suppressionRows, sentStepOne, attemptSequenceEnroll, attemptManualQueuedSend,
  expectBlockedOnEveryChannel, AccountRow,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

/**
 * The post-delete state the route is required to leave behind (asserted by the
 * first two tests): contact row gone, suppression row source='manual-delete'.
 * The re-create tests start from that state directly so a failure in the
 * delete route itself is reported once, not cascaded into every test.
 */
async function deletedState(email: string) {
  const c = await createContact({ email });
  await suppress(email, { source: 'manual-delete', reason: 'deleted by user' });
  await query(`DELETE FROM contacts WHERE id = $1`, [c.id]);
}

describe('R9 contact delete => permanent suppression', () => {
  it('DELETE /api/contacts/:id succeeds (200) and removes the contact', async () => {
    const c = await createContact({ email: 'erase@dev-co.test' });
    const agent = await authedAgent();
    const res = await agent.delete(`/api/contacts/${c.id}`);
    expect(res.status).toBe(200);
    expect((await query(`SELECT 1 FROM contacts WHERE id = $1`, [c.id])).rows).toHaveLength(0);
  });

  it('after DELETE the address is on suppressed_emails (tenant tp, source manual-delete)', async () => {
    const c = await createContact({ email: 'Erase2@Dev-Co.test' });
    const agent = await authedAgent();
    await agent.delete(`/api/contacts/${c.id}`);
    const rows = await suppressionRows('erase2@dev-co.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'erase2@dev-co.test', tenant: 'tp', source: 'manual-delete', domain: null });
  });

  it('contact delete is atomic: if it fails, the send history is left intact', async () => {
    const { contact, send } = await sentStepOne({ account });
    const agent = await authedAgent();
    const res = await agent.delete(`/api/contacts/${contact.id}`);
    const contactStillThere = (await query(`SELECT 1 FROM contacts WHERE id = $1`, [contact.id])).rows.length > 0;
    if (res.status !== 200 || contactStillThere) {
      // failed delete: nothing may have been destroyed
      expect((await emailSends(`id = $1`, [send.id]))).toHaveLength(1);
      expect((await query(`SELECT 1 FROM sequence_enrollments WHERE contact_id = $1`, [contact.id])).rows).toHaveLength(1);
    }
    expect(res.status).toBe(200);
  });

  it('re-create via POST /api/contacts is refused with 409', async () => {
    await deletedState('erase3@dev-co.test');
    const agent = await authedAgent();
    const res = await agent.post('/api/contacts').send({ email: 'ERASE3@dev-co.test', first_name: 'Back' });
    expect(res.status).toBe(409);
    expect((await query(`SELECT 1 FROM contacts WHERE LOWER(email) = 'erase3@dev-co.test'`)).rows).toHaveLength(0);
  });

  it('CSV re-import skips the deleted address', async () => {
    await deletedState('erase4@dev-co.test');
    const agent = await authedAgent();
    const res = await agent.post('/api/contacts/import').send({ csv: 'email,first_name\nErase4@dev-co.test,Back\nnew@dev-co.test,New\n' });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.added).toBe(1);
    expect((await query(`SELECT 1 FROM contacts WHERE LOWER(email) = 'erase4@dev-co.test'`)).rows).toHaveLength(0);
  });

  it('if the address re-appears by another route (direct insert, e.g. Dripify), it is still not enrollable or sendable on any channel', async () => {
    await deletedState('erase5@dev-co.test');

    const back = await createContact({ email: 'erase5@dev-co.test', subsector: 'residential' });
    expect((await attemptSequenceEnroll(account.id, back.id)).refused).toBe(true);
    expect((await attemptManualQueuedSend(account.id, back.email, back.id)).delivered).toBe(false);
    await expectBlockedOnEveryChannel(account.id, back.email, back.id);
  });
});
