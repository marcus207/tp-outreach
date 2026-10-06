/**
 * Requirement 5: sequence logic. Step delays, ordering, threading, completion,
 * paused/cancelled enrollments, non-active sequences.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, drainSendQueue, outbox, emailSends, enrollment,
  pendingSendJobs,
} from '../factories';
import { query } from '../../../src/db/connection';
import { T0, COLD_A, forceDue } from './helpers';
import type { StepSpec } from '../factories';

async function setup(steps: StepSpec[], email = 'seq@example-dev.test') {
  const a = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 50 } });
  const seq = await createSequence({ accountIds: [a.id], steps });
  const c = await createContact({ email });
  const enr = await enroll(seq.id, c.id);
  return { a, seq, c, enr };
}

async function sendStep(): Promise<void> {
  await runPlannerPass();
  await drainSendQueue();
}

afterAll(async () => { await closeAll(); });

describe('sequence: step delays', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); });
  afterEach(() => restoreClock());

  it('step 2 with delay_days=3 is due exactly 3 days after step 1 was sent (Mon 10:00 -> Thu 10:00)', async () => {
    setClock(T0);
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 3 }]);
    await sendStep();
    const e = await enrollment(enr);
    expect(e.next_step_number).toBe(2);
    expect(new Date(e.next_step_due_at!).toISOString()).toBe('2026-10-15T09:00:00.000Z');
  });

  it('step 2 with delay_hours=2 is due 2 hours after step 1 was sent', async () => {
    setClock(T0);
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 0, delayHours: 2 }]);
    await sendStep();
    expect(new Date((await enrollment(enr)).next_step_due_at!).toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });

  it('a delay landing on Saturday moves to Monday 08:00 London', async () => {
    setClock(new Date('2026-10-15T09:00:00.000Z')); // Thu 10:00 BST
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 2 }]);
    await sendStep();
    expect(new Date((await enrollment(enr)).next_step_due_at!).toISOString()).toBe('2026-10-19T07:00:00.000Z');
  });

  it('a delay landing after 17:00 London moves to the next weekday 08:00', async () => {
    setClock(new Date('2026-10-12T15:00:00.000Z')); // Mon 16:00 BST
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 0, delayHours: 2 }]);
    await sendStep();
    expect(new Date((await enrollment(enr)).next_step_due_at!).toISOString()).toBe('2026-10-13T07:00:00.000Z');
  });

  it('a delay crossing the October DST change lands on 08:00 GMT (08:00Z)', async () => {
    setClock(new Date('2026-10-23T14:00:00.000Z')); // Fri 15:00 BST
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 1 }]); // Sat -> Mon
    await sendStep();
    expect(new Date((await enrollment(enr)).next_step_due_at!).toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });
});

describe('sequence: ordering and threading', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('step 2 is never planned while step 1 is still queued (repeated planner passes queue one job)', async () => {
    await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 0 }]);
    await runPlannerPass();
    await runPlannerPass();
    await runPlannerPass();
    expect(await pendingSendJobs()).toHaveLength(1);
    expect(await emailSends()).toHaveLength(1);
  });

  it('step 2 is not planned before its due time', async () => {
    await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 3 }]);
    await sendStep();
    setClock(new Date(T0.getTime() + 3600000));
    expect((await runPlannerPass()).planned).toBe(0);
  });

  it('step 2 is sent after step 1, never before it, and in step order', async () => {
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 1 }]);
    await sendStep();
    setClock(new Date('2026-10-13T09:00:00.000Z'));
    await forceDue(enr);
    await sendStep();
    const box = await outbox();
    // step 2 replies into step 1's thread, so its subject is "Re: <step 1 subject>"
    expect(box.map(m => m.subject)).toEqual(['One', 'Re: One']);
  });

  it('the follow-up is sent into the same Gmail thread (threadId from step 1 passed to the send)', async () => {
    const { enr } = await setup([{ subject: 'Funding for {{company}}' }, { subject: 'Following up', delayDays: 1 }]);
    await sendStep();
    const first = (await outbox())[0];
    setClock(new Date('2026-10-13T09:00:00.000Z'));
    await forceDue(enr);
    await runPlannerPass();
    const jobs = await pendingSendJobs();
    expect(jobs[0].threadId).toBe(first.fake_thread_id);
    await drainSendQueue();
    const second = (await outbox())[1];
    expect(second.thread_id).toBe(first.fake_thread_id);
    // Follow-ups into the thread reply to it: "Re: <first subject>" (Gmail requires
    // a matching Subject to thread; see the In-Reply-To/References test below).
    expect(second.subject).toBe(`Re: ${first.subject}`);
  });

  it('the follow-up meets Gmail\'s threading rules: In-Reply-To/References set and subject matches the thread', async () => {
    const { enr } = await setup([{ subject: 'Funding for {{company}}' }, { subject: 'Following up', delayDays: 1 }]);
    await sendStep();
    const first = (await outbox())[0];
    setClock(new Date('2026-10-13T09:00:00.000Z'));
    await forceDue(enr);
    await sendStep();
    const second = (await outbox())[1];
    const h = Object.fromEntries(Object.entries(second.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['in-reply-to'], 'follow-up has no In-Reply-To header').toBeTruthy();
    expect(h['references'], 'follow-up has no References header').toBeTruthy();
    expect([first.subject, `Re: ${first.subject}`]).toContain(second.subject);
  });

  it('the enrollment completes after the last step is sent', async () => {
    const { enr } = await setup([{ subject: 'One' }, { subject: 'Two', delayDays: 1 }]);
    await sendStep();
    expect((await enrollment(enr)).status).toBe('active');
    setClock(new Date('2026-10-13T09:00:00.000Z'));
    await forceDue(enr);
    await sendStep();
    const e = await enrollment(enr);
    expect(e.status).toBe('completed');
    expect(e.next_step_due_at).toBeNull();
    expect(e.next_step_number).toBeNull();
    expect(await outbox()).toHaveLength(2);
  });

  it('a single-step sequence completes as soon as its one email is sent', async () => {
    const { enr } = await setup([{ subject: 'Only' }]);
    await sendStep();
    expect((await enrollment(enr)).status).toBe('completed');
  });
});

describe('sequence: paused / cancelled enrollments and non-active sequences never send', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it.each(['paused', 'cancelled'])('a %s enrollment that is due is never planned', async (status) => {
    const { enr } = await setup([{ subject: 'One' }]);
    await query(`UPDATE sequence_enrollments SET status = $1 WHERE id = $2`, [status, enr]);
    expect((await runPlannerPass()).planned).toBe(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it.each(['paused', 'cancelled'])('an enrollment %s after its send was queued does not send', async (status) => {
    const { enr } = await setup([{ subject: 'One' }]);
    await runPlannerPass();
    await query(`UPDATE sequence_enrollments SET status = $1 WHERE id = $2`, [status, enr]);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it.each(['paused', 'draft', 'archived'])('a due enrollment in a %s sequence is never planned', async (status) => {
    const { seq } = await setup([{ subject: 'One' }]);
    await query(`UPDATE sequences SET status = $1 WHERE id = $2`, [status, seq.id]);
    expect((await runPlannerPass()).planned).toBe(0);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });

  it.each(['paused', 'draft', 'archived'])('a send already queued does not go out after the sequence is set to %s', async (status) => {
    const { seq } = await setup([{ subject: 'One' }]);
    await runPlannerPass();
    await query(`UPDATE sequences SET status = $1 WHERE id = $2`, [status, seq.id]);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
  });
});
