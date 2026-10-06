/**
 * Requirement 3: only @go.tp.finance accounts send to external recipients. A root
 * @tp.finance account (even with high limits) is never selected by the planner,
 * blast or broadcast, and is refused at the gate. Internal recipients may be
 * sent from root.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, drainSendQueue, outbox, emailSends, enrollment,
} from '../factories';
import { sendQueue } from '../../../src/services/send-queue';
import { campaignEngine } from '../../../src/services/campaign-engine';
import { broadcastPlanner } from '../../../src/services/broadcast-planner';
import {
  T0, COLD_A, ROOT, insertQueuedSend, setCampaignActive, createBlast, createBroadcast, createPressReleases,
  loggedInAgent, sendRow,
} from './helpers';

const BIG = { daily: 1000, hourly: 200 };

afterAll(async () => { await closeAll(); });

describe('cold-sender domain: root @tp.finance never sends cold outreach', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('planner never selects a root @tp.finance account, even when it is the only one with budget', async () => {
    await createAccount({ email: ROOT, displayName: 'Marcus Emadi', limits: BIG });
    const seq = await createSequence({ steps: [{ subject: 'Hi' }] });
    for (let i = 0; i < 3; i++) await enroll(seq.id, (await createContact({ email: `ext${i}@example-dev.test` })).id);
    expect((await runPlannerPass()).planned).toBe(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it('planner never selects root even when the sequence explicitly lists it as a sending account', async () => {
    const root = await createAccount({ email: ROOT, limits: BIG });
    const seq = await createSequence({ accountIds: [root.id], steps: [{ subject: 'Hi' }] });
    await enroll(seq.id, (await createContact({ email: 'ext@example-dev.test' })).id);
    expect((await runPlannerPass()).planned).toBe(0);
  });

  it('planner uses only the go.tp.finance account when root (high limits) and cold (low limits) both exist', async () => {
    await createAccount({ email: ROOT, limits: BIG });
    await createAccount({ email: COLD_A, limits: { daily: 10, hourly: 2 } });
    const seq = await createSequence({ steps: [{ subject: 'Hi' }] });
    for (let i = 0; i < 5; i++) await enroll(seq.id, (await createContact({ email: `mix${i}@example-dev.test` })).id);
    const plan = await runPlannerPass();
    expect(plan.distribution).toEqual({ [COLD_A]: 2 });
    await drainSendQueue();
    expect((await outbox()).every(m => m.from_email === COLD_A)).toBe(true);
  });

  it('blast tick never queues from root', async () => {
    await createAccount({ email: ROOT, limits: BIG });
    await setCampaignActive(true);
    await createBlast({ contacts: [{ email: 'b1@example-dev.test' }, { email: 'b2@example-dev.test' }] });
    const r = await campaignEngine.tick();
    expect(r.contacts_queued).toBe(0);
    expect(await emailSends()).toHaveLength(0);
  });

  it('broadcast planner never assigns broadcast emails to root', async () => {
    const root = await createAccount({ email: ROOT, limits: BIG });
    await createBroadcast(3, root.id, ROOT);
    expect((await broadcastPlanner.plan()).planned).toBe(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it('broadcast planner reassigns a row created on root to a go.tp.finance account', async () => {
    const root = await createAccount({ email: ROOT, limits: BIG });
    await createAccount({ email: COLD_A, limits: { daily: 10, hourly: 5 } });
    await createBroadcast(2, root.id, ROOT);
    expect((await broadcastPlanner.plan()).distribution).toEqual({ [COLD_A]: 2 });
    await drainSendQueue();
    const box = await outbox();
    expect(box).toHaveLength(2);
    expect(box.every(m => m.from_email === COLD_A)).toBe(true);
  });

  it('press release send refuses when only root is connected (409, nothing queued)', async () => {
    await createAccount({ email: ROOT, limits: BIG });
    await createPressReleases(1, 'PR');
    const agent = await loggedInAgent();
    const res = await agent.post('/api/press-releases/send-all').send({ announcement_title: 'PR' });
    expect(res.status).toBe(409);
    expect(await emailSends()).toHaveLength(0);
  });

  it('gate refuses a queued external send whose account is root (failed, nothing sent)', async () => {
    const root = await createAccount({ email: ROOT, limits: BIG });
    const id = await insertQueuedSend({ accountId: root.id, fromEmail: ROOT, to: 'ext@example-dev.test' });
    await sendQueue.processEmailSend({ emailSendId: id });
    const row = await sendRow(id);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/not on go\.tp\.finance/);
    expect(await outbox()).toHaveLength(0);
  });

  it('gate refuses a look-alike sender domain (ops@notgo.tp.finance)', async () => {
    const fake = await createAccount({ email: 'ops@notgo.tp.finance', limits: BIG });
    const id = await insertQueuedSend({ accountId: fake.id, fromEmail: 'ops@notgo.tp.finance', to: 'ext@example-dev.test' });
    await sendQueue.processEmailSend({ emailSendId: id });
    expect(await outbox()).toHaveLength(0);
  });

  it('gate refusal of a root sender on a sequence send does not burn the enrollment (retried, not cancelled)', async () => {
    const root = await createAccount({ email: ROOT, limits: BIG });
    const seq = await createSequence({ steps: [{ subject: 'Hi' }] });
    const c = await createContact({ email: 'ext@example-dev.test' });
    const enr = await enroll(seq.id, c.id);
    const id = await insertQueuedSend({ accountId: root.id, fromEmail: ROOT, to: c.email, contactId: c.id, enrollmentId: enr, stepId: seq.steps[0].id });
    await import('../../../src/db/connection').then(m => m.query(
      `UPDATE sequence_enrollments SET next_step_due_at = NULL, current_step = 1 WHERE id = $1`, [enr]));
    await sendQueue.processEmailSend({ emailSendId: id });
    expect(await outbox()).toHaveLength(0);
    expect((await enrollment(enr)).status).toBe('active');
  });

  it('root may send to an internal @tp.finance recipient', async () => {
    const root = await createAccount({ email: ROOT, displayName: 'Marcus Emadi', limits: BIG });
    const id = await insertQueuedSend({ accountId: root.id, fromEmail: ROOT, to: 'charlotte@tp.finance' });
    await sendQueue.processEmailSend({ emailSendId: id });
    expect((await sendRow(id)).status).toBe('sent');
    const box = await outbox();
    expect(box).toHaveLength(1);
    expect(box[0].from_email).toBe(ROOT);
    expect(box[0].to_email).toBe('charlotte@tp.finance');
  });
});
