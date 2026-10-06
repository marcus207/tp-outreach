/**
 * Requirement 2: per-account daily + hourly caps across ALL send paths, zero-limit
 * and inactive accounts never used, counters, and concurrency safety.
 * Requirement 7: fair distribution across accounts; overflow carries forward.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, drainSendQueue, outbox, emailSends,
} from '../factories';
import { query } from '../../../src/db/connection';
import { sendQueue } from '../../../src/services/send-queue';
import { gmailClient } from '../../../src/services/gmail-client';
import { campaignEngine } from '../../../src/services/campaign-engine';
import { broadcastPlanner } from '../../../src/services/broadcast-planner';
import {
  T0, COLD_A, COLD_B, account, insertQueuedSend, setCampaignActive, createBlast, createBroadcast,
  createPressReleases, loggedInAgent, queuedJobs,
} from './helpers';

async function enrolMany(seqId: string, n: number, prefix = 'cap') {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await createContact({ email: `${prefix}${i}@example-dev.test` });
    ids.push(await enroll(seqId, c.id));
  }
  return ids;
}

async function sentCountFrom(email: string): Promise<number> {
  return (await outbox()).filter(m => m.from_email === email).length;
}

afterAll(async () => { await closeAll(); });

describe('caps: hourly and daily limits on the planner + gate', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('plans at most hourly_limit sends for an account in one hour and overflows the rest', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 3 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 8);
    const plan = await runPlannerPass();
    expect(plan.planned).toBe(3);
    expect(plan.overflow).toBe(5);
    await drainSendQueue();
    expect(await sentCountFrom(COLD_A)).toBe(3);
    expect((await account(a.id)).sends_this_hour).toBe(3);
  });

  it('plans at most the remaining daily budget when the account is near its daily limit', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 10, hourly: 5 } });
    await query(`UPDATE email_accounts SET sends_today = 9 WHERE id = $1`, [a.id]);
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 4);
    expect((await runPlannerPass()).planned).toBe(1);
    await drainSendQueue();
    expect((await account(a.id)).sends_today).toBe(10);
  });

  it('gate refuses to send once sends_today reached daily_limit (row stays queued)', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 2, hourly: 10 } });
    await query(`UPDATE email_accounts SET sends_today = 2 WHERE id = $1`, [a.id]);
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'x@example-dev.test' });
    await sendQueue.processEmailSend({ emailSendId: id });
    expect(await outbox()).toHaveLength(0);
    expect((await emailSends())[0].status).toBe('queued');
  });

  it('planner never repeatedly over-commits the hourly budget when run twice in the same hour before sends land', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 3 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 6);
    await runPlannerPass();
    await runPlannerPass(); // e.g. manual "plan now" from the dashboard in the same hour
    const queued = (await emailSends()).filter(s => s.status === 'queued');
    expect(queued.length).toBeLessThanOrEqual(3);
  });

  it('sends_today and sends_this_hour increment exactly once per sent email', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 10 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 4);
    await runPlannerPass();
    await drainSendQueue();
    const acc = await account(a.id);
    expect(await sentCountFrom(COLD_A)).toBe(4);
    expect(acc.sends_today).toBe(4);
    expect(acc.sends_this_hour).toBe(4);
  });

  it('hourly reset frees the hourly budget but not the daily one; daily reset frees both', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 4, hourly: 2 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 8);

    expect((await runPlannerPass()).planned).toBe(2);
    await drainSendQueue();
    expect((await runPlannerPass()).planned).toBe(0); // hour exhausted

    await gmailClient.resetHourlyCounts();
    setClock(new Date(T0.getTime() + 3600000));
    expect((await runPlannerPass()).planned).toBe(2);
    await drainSendQueue();
    expect((await account(a.id)).sends_today).toBe(4);

    await gmailClient.resetHourlyCounts();
    setClock(new Date(T0.getTime() + 2 * 3600000));
    expect((await runPlannerPass()).planned).toBe(0); // day exhausted

    await gmailClient.resetDailyCounts();
    setClock(new Date(T0.getTime() + 24 * 3600000));
    const acc = await account(a.id);
    expect([acc.sends_today, acc.sends_this_hour]).toEqual([0, 0]);
    expect((await runPlannerPass()).planned).toBe(2);
  });
});

describe('caps: zero-limit and inactive accounts are never used', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('planner never assigns to an account with daily_limit 0 or hourly_limit 0', async () => {
    const z1 = await createAccount({ email: 'zero1@go.tp.finance', limits: { daily: 0, hourly: 10 } });
    const z2 = await createAccount({ email: 'zero2@go.tp.finance', limits: { daily: 10, hourly: 0 } });
    const seq = await createSequence({ accountIds: [z1.id, z2.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 3);
    expect((await runPlannerPass()).planned).toBe(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it('planner never assigns to an inactive account', async () => {
    const off = await createAccount({ email: COLD_B, limits: { daily: 100, hourly: 50 }, active: false });
    const seq = await createSequence({ accountIds: [off.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 2);
    expect((await runPlannerPass()).planned).toBe(0);
  });

  it('blast tick never queues on zero-limit or inactive accounts', async () => {
    await createAccount({ email: 'zero@go.tp.finance', limits: { daily: 0, hourly: 0 } });
    await createAccount({ email: COLD_B, limits: { daily: 100, hourly: 50 }, active: false });
    await setCampaignActive(true);
    await createBlast({ contacts: [{ email: 'b1@example-dev.test' }, { email: 'b2@example-dev.test' }] });
    const r = await campaignEngine.tick();
    expect(r.contacts_queued).toBe(0);
    expect(await emailSends()).toHaveLength(0);
  });

  it('broadcast planner never assigns to zero-limit or inactive accounts', async () => {
    const zero = await createAccount({ email: 'zero@go.tp.finance', limits: { daily: 0, hourly: 0 } });
    await createAccount({ email: COLD_B, limits: { daily: 100, hourly: 50 }, active: false });
    await createBroadcast(3, zero.id, zero.email);
    expect((await broadcastPlanner.plan()).planned).toBe(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it('gate refuses a queued send on an account that was deactivated after queuing', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'x@example-dev.test' });
    await query(`UPDATE email_accounts SET is_active = false WHERE id = $1`, [a.id]);
    await sendQueue.processEmailSend({ emailSendId: id });
    expect(await outbox()).toHaveLength(0);
    expect((await emailSends())[0].status).toBe('failed');
  });

  it('gate refuses a queued send on an account whose limits were zeroed after queuing', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'x@example-dev.test' });
    await query(`UPDATE email_accounts SET daily_limit = 0, hourly_limit = 0 WHERE id = $1`, [a.id]);
    await sendQueue.processEmailSend({ emailSendId: id });
    expect(await outbox()).toHaveLength(0);
  });
});

describe('caps: all paths together in the same hour (sequence + blast + broadcast + press release)', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('one account with hourly_limit 4 sends at most 4 emails in total across every path', async () => {
    const a = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 4 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 3, 'seq');
    await setCampaignActive(true);
    await createBlast({ contacts: [1, 2, 3].map(i => ({ email: `blast${i}@example-dev.test` })) });
    await createBroadcast(3, a.id, COLD_A);
    await createPressReleases(2, 'Launch');

    await runPlannerPass();
    await campaignEngine.tick();
    await broadcastPlanner.plan();
    const agent = await loggedInAgent();
    const pr = await agent.post('/api/press-releases/send-all').send({ announcement_title: 'Launch' });
    expect(pr.status).toBe(200);

    await drainSendQueue();
    await drainSendQueue(); // anything pushed back by the per-account gap

    const acc = await account(a.id);
    expect(await sentCountFrom(COLD_A)).toBeLessThanOrEqual(4);
    expect(acc.sends_this_hour).toBeLessThanOrEqual(4);
    expect(acc.sends_this_hour).toBe(await sentCountFrom(COLD_A));
  });
});

describe('caps: concurrent send processing', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('processing 20 queued sends concurrently never exceeds hourly_limit 5', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 5 } });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: `par${i}@example-dev.test` }));
    await Promise.all(ids.map(id => sendQueue.processEmailSend({ emailSendId: id }).catch(() => undefined)));
    const sent = await sentCountFrom(COLD_A);
    expect(sent).toBeLessThanOrEqual(5);
    expect((await account(a.id)).sends_this_hour).toBeLessThanOrEqual(5);
  });

  it('processing 20 queued sends concurrently never exceeds daily_limit 3', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 3, hourly: 50 } });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: `pard${i}@example-dev.test` }));
    await Promise.all(ids.map(id => sendQueue.processEmailSend({ emailSendId: id }).catch(() => undefined)));
    expect(await sentCountFrom(COLD_A)).toBeLessThanOrEqual(3);
  });

  it('the same email_sends row processed by 10 concurrent jobs is sent exactly once and counted once', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'once@example-dev.test' });
    await Promise.all(Array.from({ length: 10 }, () => sendQueue.processEmailSend({ emailSendId: id }).catch(() => undefined)));
    expect(await outbox()).toHaveLength(1);
    expect((await account(a.id)).sends_today).toBe(1);
  });

  it('10 rows each processed by 3 concurrent jobs produce exactly 10 distinct sends (no duplicates)', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 100 } });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: `dup${i}@example-dev.test` }));
    await Promise.all(ids.flatMap(id => [1, 2, 3].map(() => sendQueue.processEmailSend({ emailSendId: id }).catch(() => undefined))));
    const box = await outbox();
    expect(box).toHaveLength(10);
    expect(new Set(box.map(m => m.to_email)).size).toBe(10);
    expect((await account(a.id)).sends_today).toBe(10);
  });
});

describe('distribution across accounts (requirement 7)', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('splits evenly between two go.tp.finance accounts with equal budgets', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 3 } });
    const b = await createAccount({ email: COLD_B, limits: { daily: 50, hourly: 3 } });
    const seq = await createSequence({ accountIds: [a.id, b.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 10);
    const plan = await runPlannerPass();
    expect(plan.distribution).toEqual({ [COLD_A]: 3, [COLD_B]: 3 });
    expect(plan.overflow).toBe(4);
  });

  it('gives each account no more than its own budget when budgets differ', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 5 } });
    const b = await createAccount({ email: COLD_B, limits: { daily: 50, hourly: 1 } });
    const seq = await createSequence({ accountIds: [a.id, b.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 4);
    const plan = await runPlannerPass();
    expect(plan.distribution).toEqual({ [COLD_A]: 3, [COLD_B]: 1 });
  });

  it('overflow carries to the next hour and the next day; every contact is emailed exactly once', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 4, hourly: 2 } });
    const b = await createAccount({ email: COLD_B, limits: { daily: 4, hourly: 2 } });
    const seq = await createSequence({ accountIds: [a.id, b.id], steps: [{ subject: 'Hi' }] });
    await enrolMany(seq.id, 10);

    const hour1 = await runPlannerPass();
    expect(hour1.planned).toBe(4);
    expect(hour1.overflow).toBe(6);
    await drainSendQueue();
    // overflowed enrollments are still due (not dropped)
    const stillDue = await query(`SELECT 1 FROM sequence_enrollments WHERE status = 'active' AND next_step_due_at IS NOT NULL AND current_step = 0`);
    expect(stillDue.rows).toHaveLength(6);

    await gmailClient.resetHourlyCounts();
    setClock(new Date(T0.getTime() + 3600000));
    expect((await runPlannerPass()).planned).toBe(4);
    await drainSendQueue();

    await gmailClient.resetHourlyCounts();
    setClock(new Date(T0.getTime() + 2 * 3600000));
    expect((await runPlannerPass()).planned).toBe(0); // both accounts at daily cap

    await gmailClient.resetDailyCounts();
    setClock(new Date(T0.getTime() + 24 * 3600000));
    expect((await runPlannerPass()).planned).toBe(2);
    await drainSendQueue();

    const box = await outbox();
    expect(box).toHaveLength(10);
    expect(new Set(box.map(m => m.to_email)).size).toBe(10);
    expect(await queuedJobs()).toHaveLength(0);
  });
});
