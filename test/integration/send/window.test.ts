/**
 * Requirement 1: ONE send window, Mon-Fri 08:00-17:00 Europe/London, enforced by
 * the planner, the send gate, the re-queue cron, the campaign engine and the
 * broadcast planner, correct across BST/GMT transitions.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, drainSendQueue, outbox,
} from '../factories';
import {
  isWithinSendWindow, nextSendWindowStart,
} from '../../../src/services/send-gate';
import { sendQueue } from '../../../src/services/send-queue';
import { requeueStuckSends } from '../../../src/services/requeue-stuck';
import { campaignEngine } from '../../../src/services/campaign-engine';
import { broadcastPlanner } from '../../../src/services/broadcast-planner';
import {
  T0, SAT_10, SUN_10, MON_0759, MON_0800, MON_1659, MON_1700,
  BST_MON_0830, BST_MON_0759, BST_MON_1700, GMT_MON_0730, GMT_MON_0800, GMT_MON_1630, GMT_MON_1700,
  COLD_A, queuedJobs, outsideWindow, insertQueuedSend, sendRow, setCampaignActive, createBlast, createBroadcast,
  seedRandom, setSetting,
} from './helpers';

async function seqWithEnrollments(n: number, limits = { daily: 50, hourly: 20 }) {
  const acct = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits });
  const seq = await createSequence({ accountIds: [acct.id], steps: [{ subject: 'Hello {{first_name}}' }] });
  for (let i = 0; i < n; i++) {
    const c = await createContact({ email: `win${i}@example-dev.test` });
    await enroll(seq.id, c.id);
  }
  return acct;
}

afterAll(async () => { await closeAll(); });

describe('send window: isWithinSendWindow / nextSendWindowStart (Europe/London)', () => {
  afterEach(() => restoreClock());

  it.each([
    ['Saturday 10:00', SAT_10, false],
    ['Sunday 10:00', SUN_10, false],
    ['Monday 07:59 BST', MON_0759, false],
    ['Monday 08:00 BST (inclusive start)', MON_0800, true],
    ['Monday 16:59 BST', MON_1659, true],
    ['Monday 17:00 BST (exclusive end)', MON_1700, false],
    ['Mon 30 Mar 2026 08:30 BST = 07:30Z (first weekday of BST)', BST_MON_0830, true],
    ['Mon 30 Mar 2026 07:59 BST = 06:59Z', BST_MON_0759, false],
    ['Mon 30 Mar 2026 17:00 BST = 16:00Z', BST_MON_1700, false],
    ['Mon 26 Oct 2026 07:30 GMT = 07:30Z (first weekday after BST ends)', GMT_MON_0730, false],
    ['Mon 26 Oct 2026 08:00 GMT = 08:00Z', GMT_MON_0800, true],
    ['Mon 26 Oct 2026 16:30 GMT = 16:30Z', GMT_MON_1630, true],
    ['Mon 26 Oct 2026 17:00 GMT = 17:00Z', GMT_MON_1700, false],
  ])('%s => inside window = %s', (_label, at, expected) => {
    expect(isWithinSendWindow(at)).toBe(expected);
  });

  it('next window after Friday close is Monday 08:00 London, across the October DST change (08:00Z)', () => {
    const friLate = new Date('2026-10-23T16:30:00.000Z'); // Fri 17:30 BST
    expect(nextSendWindowStart(friLate).toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('next window after Friday close is Monday 08:00 London, across the March DST change (07:00Z)', () => {
    const friLate = new Date('2026-03-27T18:00:00.000Z'); // Fri 18:00 GMT
    expect(nextSendWindowStart(friLate).toISOString()).toBe('2026-03-30T07:00:00.000Z');
  });

  it('next window on a weekday before 08:00 is the same day 08:00 London', () => {
    expect(nextSendWindowStart(MON_0759).toISOString()).toBe(MON_0800.toISOString());
  });
});

describe('send window: hourly planner', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); });
  afterEach(() => restoreClock());

  it.each([
    ['Saturday', SAT_10],
    ['Sunday', SUN_10],
    ['Monday 07:59 London', MON_0759],
    ['Monday 17:00 London', MON_1700],
    ['Monday 07:30 GMT after the October change', GMT_MON_0730],
  ])('plans and sends nothing on %s', async (_label, at) => {
    await seqWithEnrollments(3);
    setClock(at);
    const plan = await runPlannerPass();
    expect(plan.planned).toBe(0);
    expect(await queuedJobs()).toHaveLength(0);
    expect(await drainSendQueue()).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('plans and sends at 08:30 London during BST (07:30 UTC, Mon 30 Mar 2026)', async () => {
    await seqWithEnrollments(1);
    setClock(BST_MON_0830);
    const plan = await runPlannerPass();
    expect(plan.planned).toBe(1);
    expect(await drainSendQueue()).toBe(1);
    expect(await outbox()).toHaveLength(1);
  });

  it('plans and sends at 08:00 London during GMT (08:00 UTC, Mon 26 Oct 2026)', async () => {
    await seqWithEnrollments(1);
    setClock(GMT_MON_0800);
    expect((await runPlannerPass()).planned).toBe(1);
    expect(await drainSendQueue()).toBe(1);
    expect(await outbox()).toHaveLength(1);
  });

  it('never schedules a job whose fire time (enqueue + jitter) is after 17:00 London, planning at 16:50', async () => {
    await seqWithEnrollments(10);
    setClock(new Date('2026-10-12T15:50:00.000Z')); // 16:50 BST
    const rnd = seedRandom(7);
    try {
      await runPlannerPass();
    } finally { rnd.mockRestore(); }
    const jobs = await queuedJobs();
    expect(jobs.length).toBe(10);
    expect(outsideWindow(jobs).map(j => j.fireAt.toISOString())).toEqual([]);
  });

  it('never schedules a job whose fire time is after 17:00 London, planning at 16:59:30 (last 30s of the window)', async () => {
    await seqWithEnrollments(3);
    setClock(new Date('2026-10-12T15:59:30.000Z')); // 16:59:30 BST
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      await runPlannerPass();
    } finally { rnd.mockRestore(); }
    const jobs = await queuedJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(outsideWindow(jobs).map(j => j.fireAt.toISOString())).toEqual([]);
  });
});

describe('send window: send gate, re-queue cron, campaign engine, broadcast planner', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); });
  afterEach(() => restoreClock());

  it.each([
    ['Saturday', SAT_10], ['Sunday', SUN_10], ['07:59 London', MON_0759], ['17:00 London', MON_1700],
  ])('gate leaves a queued send untouched (still queued, nothing sent) on %s', async (_l, at) => {
    const acct = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
    const id = await insertQueuedSend({ accountId: acct.id, fromEmail: COLD_A, to: 'pat@example-dev.test' });
    setClock(at);
    await sendQueue.processEmailSend({ emailSendId: id });
    expect((await sendRow(id)).status).toBe('queued');
    expect(await outbox()).toHaveLength(0);
  });

  it('gate sends at 08:30 London in BST (07:30Z)', async () => {
    const acct = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
    const id = await insertQueuedSend({ accountId: acct.id, fromEmail: COLD_A, to: 'pat@example-dev.test' });
    setClock(BST_MON_0830);
    await sendQueue.processEmailSend({ emailSendId: id });
    expect((await sendRow(id)).status).toBe('sent');
  });

  it.each([['Saturday', SAT_10], ['07:59 London', MON_0759], ['17:00 London', MON_1700]])(
    're-queue cron re-queues nothing on %s', async (_l, at) => {
      const acct = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
      await insertQueuedSend({ accountId: acct.id, fromEmail: COLD_A, to: 'pat@example-dev.test', lastEnqueuedSql: `NOW() - INTERVAL '2 hours'` });
      setClock(at);
      expect(await requeueStuckSends()).toBe(0);
      expect(await queuedJobs()).toHaveLength(0);
    });

  it.each([['Saturday', SAT_10], ['Sunday', SUN_10], ['07:59 London', MON_0759], ['17:00 London', MON_1700]])(
    'campaign engine (blast) queues nothing on %s', async (_l, at) => {
      await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
      await setCampaignActive(true);
      await createBlast({ contacts: [{ email: 'b1@example-dev.test' }, { email: 'b2@example-dev.test' }] });
      setClock(at);
      const r = await campaignEngine.tick();
      expect(r.contacts_queued).toBe(0);
      expect(await queuedJobs()).toHaveLength(0);
    });

  it.each([['Saturday', SAT_10], ['Sunday', SUN_10], ['07:59 London', MON_0759], ['17:00 London', MON_1700]])(
    'broadcast planner plans nothing on %s', async (_l, at) => {
      const acct = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
      await createBroadcast(3, acct.id, COLD_A);
      setClock(at);
      const r = await broadcastPlanner.plan();
      expect(r.planned).toBe(0);
      expect(await queuedJobs()).toHaveLength(0);
    });

  it('broadcast planner plans at 08:00 GMT on Mon 26 Oct 2026 (control)', async () => {
    const acct = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
    await createBroadcast(2, acct.id, COLD_A);
    setClock(GMT_MON_0800);
    expect((await broadcastPlanner.plan()).planned).toBe(2);
  });

  it('broadcast planner never schedules a job whose fire time is after 17:00 London (planning at 16:45)', async () => {
    const acct = await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
    await createBroadcast(8, acct.id, COLD_A);
    await setSetting('send_gap_minutes', 0);
    setClock(new Date('2026-10-12T15:45:00.000Z')); // 16:45 BST
    const rnd = seedRandom(3);
    try { await broadcastPlanner.plan(); } finally { rnd.mockRestore(); }
    const jobs = await queuedJobs();
    expect(jobs.length).toBe(8);
    expect(outsideWindow(jobs).map(j => j.fireAt.toISOString())).toEqual([]);
  });

  it('campaign engine control: queues inside the window at T0', async () => {
    await createAccount({ email: COLD_A, limits: { daily: 50, hourly: 20 } });
    await setCampaignActive(true);
    await createBlast({ contacts: [{ email: 'b1@example-dev.test' }] });
    setClock(T0);
    expect((await campaignEngine.tick()).contacts_queued).toBe(1);
  });
});
