/**
 * Requirement 7: tenant isolation. The process runs as TENANT=tp. A loan-intel
 * contact / suppression / list / send must never be read, enrolled or emailed
 * by tp, and tp's suppression/unsubscribe must not leak into loan-intel rows.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { query } from '../../../src/db/connection';
import { restoreClock, closeAll, createContact, createSequence, enroll, suppress, createAccount, runReplyWatcher, fakeGmail, isEmailSuppressed } from '../factories';
import {
  freshWorld, authedAgent, getApp, attemptSequenceEnroll, attemptEnrollRoute, attemptEnrollAllRoute, attemptBlast,
  attemptBroadcast, attemptManualQueuedSend, sentStepOne, outboxTo, suppressionRows, contactById, enrollmentsFor, AccountRow,
} from './helpers';

let account: AccountRow;

beforeEach(async () => {
  ({ account } = await freshWorld());
});

afterAll(async () => {
  restoreClock();
  await closeAll();
});

const liContact = () => createContact({ email: 'borrower@li-only.test', type: 'developer', subsector: 'residential', tenant: 'loan-intel' });

describe('R7 loan-intel contacts are invisible and unsendable for tp', () => {
  it('enrollContact refuses a loan-intel contact into a tp sequence', async () => {
    const li = await liContact();
    const r = await attemptSequenceEnroll(account.id, li.id);
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/another tenant/i);
  });

  it('POST enroll ignores a loan-intel contact id; enroll-all never picks loan-intel contacts', async () => {
    const li = await liContact();
    const one = await attemptEnrollRoute(account.id, [li.id]);
    expect(one.enrolled).toHaveLength(0);
    const all = await attemptEnrollAllRoute(account.id);
    expect(all.enrolled).not.toContain(li.id);
  });

  it('GET /api/contacts does not list it and GET /api/contacts/:id returns 404', async () => {
    const li = await liContact();
    const tp = await createContact({ email: 'tp-visible@dev.test' });
    const agent = await authedAgent();
    const list = await agent.get('/api/contacts?limit=200');
    const emails = list.body.data.map((c: { email: string }) => c.email);
    expect(emails).toContain(tp.email);
    expect(emails).not.toContain(li.email);
    expect((await agent.get(`/api/contacts/${li.id}`)).status).toBe(404);
    expect((await agent.get(`/api/contacts?search=li-only`)).body.total).toBe(0);
  });

  it('PUT/DELETE/tag via the tp API cannot modify a loan-intel contact', async () => {
    const li = await liContact();
    const agent = await authedAgent();
    expect((await agent.put(`/api/contacts/${li.id}`).send({ first_name: 'Hacked' })).status).toBe(404);
    expect((await agent.post(`/api/contacts/${li.id}/tags`).send({ tags: ['x'] })).status).toBe(404);
    expect((await agent.delete(`/api/contacts/${li.id}`)).status).toBe(404);
    const after = await contactById(li.id);
    expect(after.tags).toEqual([]);
    expect(await suppressionRows(li.email)).toHaveLength(0);
  });

  it('blast and broadcast never reach loan-intel contacts', async () => {
    const li = await liContact();
    const tp = await createContact({ email: 'tp-ok@dev.test', subsector: 'residential' });
    const blast = await attemptBlast([li.id, tp.id]);
    expect(blast).toContain(tp.email);
    expect(blast).not.toContain(li.email);
    const bc = await attemptBroadcast([li.id, tp.id]);
    expect(bc.delivered).toContain(tp.email);
    expect(bc.delivered).not.toContain(li.email);
  });

  it('a tp send whose contact_id points at a loan-intel contact is failed by the gate', async () => {
    const li = await liContact();
    const r = await attemptManualQueuedSend(account.id, li.email, li.id);
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/tenant/i);
  });

  it('a queued email_sends row belonging to loan-intel is never processed by the tp send queue', async () => {
    const liAcct = await createAccount({ email: 'ops@loan-intel.test', tenant: 'loan-intel' });
    const r = await attemptManualQueuedSend(liAcct.id, 'someone@li-only.test', null, 'loan-intel');
    expect(r.delivered).toBe(false);
    expect(r.status).toBe('queued'); // untouched by tp
  });
});

describe('R7 lists are tenant-scoped', () => {
  async function lists() {
    const li = (await query<{ id: string }>(`INSERT INTO contact_lists (name, tenant) VALUES ('LI lenders', 'loan-intel') RETURNING id`)).rows[0];
    const tp = (await query<{ id: string }>(`INSERT INTO contact_lists (name, tenant) VALUES ('TP devs', 'tp') RETURNING id`)).rows[0];
    return { li, tp };
  }

  it('GET /api/contacts/lists does not show loan-intel lists', async () => {
    const { li, tp } = await lists();
    const agent = await authedAgent();
    const ids = (await agent.get('/api/contacts/lists')).body.map((l: { id: string }) => l.id);
    expect(ids).toContain(tp.id);
    expect(ids).not.toContain(li.id);
  });

  it('tp API cannot add members to a loan-intel list', async () => {
    const { li } = await lists();
    const tpc = await createContact({ email: 'member@dev.test' });
    const agent = await authedAgent();
    await agent.post(`/api/contacts/lists/${li.id}/members`).send({ contact_ids: [tpc.id] });
    const members = (await query(`SELECT 1 FROM contact_list_members WHERE list_id = $1`, [li.id])).rows;
    expect(members).toHaveLength(0);
  });

  it('tp API cannot add a loan-intel contact to a tp list', async () => {
    const { tp } = await lists();
    const li = await liContact();
    const agent = await authedAgent();
    await agent.post(`/api/contacts/lists/${tp.id}/members`).send({ contact_ids: [li.id] });
    const members = (await query(`SELECT 1 FROM contact_list_members WHERE list_id = $1 AND contact_id = $2`, [tp.id, li.id])).rows;
    expect(members).toHaveLength(0);
  });
});

describe('R7 suppression is tenant-scoped in both directions', () => {
  it('a loan-intel suppression row does not block tp from emailing the same address', async () => {
    const tp = await createContact({ email: 'shared@both.test' });
    await suppress('shared@both.test', { tenant: 'loan-intel', source: 'unsubscribe-link' });
    expect(await isEmailSuppressed('shared@both.test')).toBe(false);
    expect((await attemptSequenceEnroll(account.id, tp.id)).refused).toBe(false);
    expect((await attemptManualQueuedSend(account.id, tp.email, tp.id)).delivered).toBe(true);
  });

  it('tp unsubscribe (link) writes tenant=tp only and leaves the loan-intel contact untagged with its enrollment active', async () => {
    const liAcct = await createAccount({ email: 'ops@loan-intel.test', tenant: 'loan-intel' });
    const li = await createContact({ email: 'jane@harbourside-dev.test', tenant: 'loan-intel' });
    const liSeq = await createSequence({ tenant: 'loan-intel', accountIds: [liAcct.id], steps: [{ subject: 'LI' }] });
    const liEnr = (await query<{ id: string }>(
      `INSERT INTO sequence_enrollments (sequence_id, contact_id, status, current_step, tenant, next_step_number, next_step_due_at)
       VALUES ($1, $2, 'active', 0, 'loan-intel', 1, NOW()) RETURNING id`, [liSeq.id, li.id])).rows[0].id;

    const { contact, mail } = await sentStepOne({ account });
    expect(contact.email).toBe(li.email);
    const app = await getApp();
    await request(app).get(`/t/${mail.tracking_id}/unsubscribe?confirm=1`);

    const rows = await suppressionRows(li.email);
    expect(rows.map(r => r.tenant)).toEqual(['tp']);
    expect((await contactById(li.id)).tags).not.toContain('unsubscribed');
    expect((await enrollmentsFor(li.id)).find(e => e.id === liEnr)?.status).toBe('active');
  });

  it('tp reply-watcher suppression (human reply) does not touch the loan-intel contact', async () => {
    const li = await createContact({ email: 'jane@harbourside-dev.test', tenant: 'loan-intel' });
    const { contact, mail } = await sentStepOne({ account });
    fakeGmail.injectReply({ mailbox: account.email, threadId: mail.fake_thread_id, from: contact.email, subject: `Re: ${mail.subject}`, body: 'Keen to talk, call me.' });
    await runReplyWatcher();
    expect((await suppressionRows(li.email)).map(r => r.tenant)).toEqual(['tp']);
    expect((await contactById(li.id)).tags).toEqual([]);
  });

  it('a loan-intel tracking id cannot be used to unsubscribe through the tp app', async () => {
    const liAcct = await createAccount({ email: 'ops@loan-intel.test', tenant: 'loan-intel' });
    const s = (await query<{ tracking_id: string }>(
      `INSERT INTO email_sends (email_account_id, to_email, from_email, subject, body_html, status, tenant)
       VALUES ($1, 'x@li-only.test', 'ops@loan-intel.test', 'LI', '<p/>', 'sent', 'loan-intel') RETURNING tracking_id`, [liAcct.id])).rows[0];
    const app = await getApp();
    await request(app).get(`/t/${s.tracking_id}/unsubscribe?confirm=1`);
    expect(await suppressionRows('x@li-only.test')).toHaveLength(0);
  });

  it('loan-intel mailboxes are not polled by the tp reply watcher', async () => {
    await createAccount({ email: 'ops@loan-intel.test', tenant: 'loan-intel' });
    await runReplyWatcher();
    expect(fakeGmail.calls.some(c => c.mailbox === 'ops@loan-intel.test')).toBe(false);
    expect(await outboxTo('x@li-only.test')).toHaveLength(0);
  });
});
