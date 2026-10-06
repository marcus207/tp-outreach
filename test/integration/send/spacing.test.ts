/**
 * Requirement 4: spacing / throttling. Planner jitter spreads an hour's sends
 * (no bursts, min gap >= send_gap_minutes, not clustered at :00); the send-time
 * gap pushes jobs back; the re-queue cron keeps spacing, threadId and fromName.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, outbox,
} from '../factories';
import { query } from '../../../src/db/connection';
import { sendQueue } from '../../../src/services/send-queue';
import { requeueStuckSends } from '../../../src/services/requeue-stuck';
import {
  T0, COLD_A, queuedJobs, outsideWindow, insertQueuedSend, sendRow, setSetting, seedRandom,
} from './helpers';

const MIN = 60000;

async function plannedHour(limit: number, seed: number) {
  const a = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: limit } });
  const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'Hi' }] });
  for (let i = 0; i < limit; i++) await enroll(seq.id, (await createContact({ email: `sp${i}@example-dev.test` })).id);
  const rnd = seedRandom(seed);
  try { await runPlannerPass(); } finally { rnd.mockRestore(); }
  return { account: a, jobs: await queuedJobs() };
}

function gaps(jobs: { fireAt: Date }[]): number[] {
  const t = jobs.map(j => j.fireAt.getTime()).sort((a, b) => a - b);
  return t.slice(1).map((x, i) => x - t[i]);
}

afterAll(async () => { await closeAll(); });

describe('spacing: planner jitter', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); await setSetting('send_gap_minutes', 3); });
  afterEach(() => restoreClock());

  it.each([11, 42, 2026])('with 10/hr the scheduled fire times are at least send_gap_minutes (3) apart (seed %i)', async (seed) => {
    const { jobs } = await plannedHour(10, seed);
    expect(jobs).toHaveLength(10);
    expect(Math.min(...gaps(jobs))).toBeGreaterThanOrEqual(3 * MIN);
  });

  it('with 10/hr the fire times spread across the hour, not clustered at the start', async () => {
    const { jobs } = await plannedHour(10, 42);
    const offsets = jobs.map(j => j.fireAt.getTime() - T0.getTime());
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThanOrEqual(30 * MIN);
    expect(offsets.filter(o => o < 5 * MIN).length).toBeLessThanOrEqual(2);
  });

  it('planned fire times stay inside the current window and within the hour', async () => {
    const { jobs } = await plannedHour(10, 5);
    expect(outsideWindow(jobs)).toEqual([]);
    expect(jobs.every(j => j.fireAt.getTime() - T0.getTime() <= 60 * MIN)).toBe(true);
  });
});

describe('spacing: send-time per-account gap', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); await setSetting('send_gap_minutes', 3); });
  afterEach(() => restoreClock());

  it('a send attempted 1 minute after the account last sent is pushed back (not sent, not dropped)', async () => {
    const a = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 50 } });
    await query(`UPDATE email_accounts SET last_send_at = $1 WHERE id = $2`, [new Date(T0.getTime() - MIN), a.id]);
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'g@example-dev.test' });
    await sendQueue.processEmailSend({ emailSendId: id, threadId: 'thread-xyz', fromName: 'Alice Adviser' });
    expect(await outbox()).toHaveLength(0);
    expect((await sendRow(id)).status).toBe('queued');
    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({ emailSendId: id, threadId: 'thread-xyz', fromName: 'Alice Adviser' });
    expect(jobs[0].delay).toBeGreaterThanOrEqual(2 * MIN); // remaining gap (2 min) + random slack
  });

  it('a send attempted after the gap has elapsed goes out', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    await query(`UPDATE email_accounts SET last_send_at = $1 WHERE id = $2`, [new Date(T0.getTime() - 4 * MIN), a.id]);
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'g@example-dev.test' });
    await sendQueue.processEmailSend({ emailSendId: id });
    expect(await outbox()).toHaveLength(1);
  });
});

describe('spacing: re-queue cron', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  async function stuckSequenceSends(n: number) {
    const a = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 50 } });
    const seq = await createSequence({ accountIds: [a.id], steps: [{ subject: 'One' }, { subject: 'Two' }] });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = await createContact({ email: `rq${i}@example-dev.test` });
      const enr = await enroll(seq.id, c.id);
      // step 1 already sent on a Gmail thread
      const s1 = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: c.email, contactId: c.id, enrollmentId: enr, stepId: seq.steps[0].id, status: 'sent' });
      await query(`UPDATE email_sends SET gmail_thread_id = $1, created_at = NOW() - INTERVAL '3 days' WHERE id = $2`, [`thread-${i}`, s1]);
      // step 2 queued 2h ago, its job lost
      ids.push(await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: c.email, contactId: c.id, enrollmentId: enr, stepId: seq.steps[1].id, lastEnqueuedSql: `NOW() - INTERVAL '2 hours'` }));
      await query(`UPDATE sequence_enrollments SET current_step = 2, next_step_due_at = NULL, next_step_number = NULL WHERE id = $1`, [enr]);
    }
    return ids;
  }

  it('re-queued jobs keep threadId and fromName', async () => {
    const ids = await stuckSequenceSends(3);
    expect(await requeueStuckSends()).toBe(3);
    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(3);
    for (const j of jobs) {
      const i = ids.indexOf(j.data.emailSendId);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(j.data.threadId).toBe(`thread-${i}`);
      expect(j.data.fromName).toBe('Alice Adviser');
    }
  });

  it('re-queued jobs are spaced by at least max(send_gap_minutes, 2 min)', async () => {
    await setSetting('send_gap_minutes', 4);
    await stuckSequenceSends(4);
    await requeueStuckSends();
    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(4);
    expect(Math.min(...gaps(jobs))).toBeGreaterThanOrEqual(4 * MIN);
  });

  it('re-queue never schedules past 17:00 London; the rest waits for the next window', async () => {
    await setSetting('send_gap_minutes', 3);
    await stuckSequenceSends(5);
    setClock(new Date('2026-10-12T15:52:00.000Z')); // 16:52 BST
    await requeueStuckSends();
    const jobs = await queuedJobs();
    expect(jobs.length).toBeLessThan(5);
    expect(outsideWindow(jobs)).toEqual([]);
  });

  it('a queued row that still has a live job in Redis is not re-queued again', async () => {
    const [id] = await stuckSequenceSends(1);
    await sendQueue.add({ emailSendId: id }, 10 * MIN);
    expect(await requeueStuckSends()).toBe(0);
    expect(await queuedJobs()).toHaveLength(1);
  });

  it('a queued row whose scheduled fire time is < 30 minutes ago is not treated as stuck', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'fresh@example-dev.test', lastEnqueuedSql: `NOW() - INTERVAL '10 minutes'` });
    expect(await requeueStuckSends()).toBe(0);
  });
});
