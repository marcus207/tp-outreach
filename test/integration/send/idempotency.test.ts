/**
 * Requirement 6: idempotency and crash safety. Double-processing, stuck
 * 'sending' rows, Gmail transport errors (retry +1 day, cancel after 5), and
 * permanent gate blocks.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  setClock, restoreClock, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll, runPlannerPass, drainSendQueue, outbox, emailSends, enrollment,
  pendingSendJobs, suppress,
} from '../factories';
import { query } from '../../../src/db/connection';
import { sendQueue } from '../../../src/services/send-queue';
import { gmailClient } from '../../../src/services/gmail-client';
import { requeueStuckSends } from '../../../src/services/requeue-stuck';
import { isWithinSendWindow } from '../../../src/services/send-gate';
import { T0, COLD_A, account, forceDue, insertQueuedSend, sendRow, queuedJobs } from './helpers';

async function setup(steps = [{ subject: 'One' }, { subject: 'Two', delayDays: 2 }], email = 'idem@example-dev.test') {
  const a = await createAccount({ email: COLD_A, displayName: 'Alice Adviser', limits: { daily: 100, hourly: 50 } });
  const seq = await createSequence({ accountIds: [a.id], steps });
  const c = await createContact({ email });
  const enr = await enroll(seq.id, c.id);
  return { a, seq, c, enr };
}

afterAll(async () => { await closeAll(); });

describe('idempotency: a job processed twice sends once', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('the same planner job payload processed twice produces one email and one counter increment', async () => {
    const { a } = await setup();
    await runPlannerPass();
    const [job] = await pendingSendJobs();
    await sendQueue.processEmailSend(job);
    await sendQueue.processEmailSend(job);
    expect(await outbox()).toHaveLength(1);
    expect((await account(a.id)).sends_today).toBe(1);
  });

  it('a duplicate job left in Redis after a send is a no-op on the next drain', async () => {
    await setup();
    await runPlannerPass();
    const [job] = await pendingSendJobs();
    await sendQueue.add(job, 1000); // duplicate (e.g. requeue raced the planner)
    await drainSendQueue();
    expect(await outbox()).toHaveLength(1);
  });
});

describe('crash safety: rows stuck in sending', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it("a row stuck 'sending' for over 1 hour becomes failed 'unknown outcome' and is never re-sent", async () => {
    const { a, seq, c, enr } = await setup();
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: c.email, contactId: c.id, enrollmentId: enr, stepId: seq.steps[0].id, status: 'sending', lastEnqueuedSql: `NOW() - INTERVAL '2 hours'` });
    await query(`UPDATE sequence_enrollments SET current_step = 1, next_step_due_at = NULL, next_step_number = NULL WHERE id = $1`, [enr]);

    await requeueStuckSends();
    const row = await sendRow(id);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/unknown outcome/);
    expect((await queuedJobs()).map(j => j.data.emailSendId)).not.toContain(id);

    await drainSendQueue();
    await requeueStuckSends();
    expect(await outbox()).toHaveLength(0);
    // the enrollment moves on to step 2 rather than repeating step 1
    const e = await enrollment(enr);
    expect(e.status).toBe('active');
    expect(e.next_step_number).toBe(2);
  });

  it("a row 'sending' for only 20 minutes is left alone (Gmail call may still be in flight)", async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'x@example-dev.test', status: 'sending', lastEnqueuedSql: `NOW() - INTERVAL '20 minutes'` });
    await requeueStuckSends();
    expect((await sendRow(id)).status).toBe('sending');
  });

  it("the gate never sends a row that is already 'sending' or 'sent'", async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    const s1 = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'x@example-dev.test', status: 'sending' });
    const s2 = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'y@example-dev.test', status: 'sent' });
    await sendQueue.processEmailSend({ emailSendId: s1 });
    await sendQueue.processEmailSend({ emailSendId: s2 });
    expect(await outbox()).toHaveLength(0);
  });
});

describe('Gmail transport errors', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => { vi.restoreAllMocks(); restoreClock(); });

  it('marks the send failed and reschedules the same step +1 day inside the window', async () => {
    const { a, enr } = await setup();
    vi.spyOn(gmailClient, 'sendEmail').mockRejectedValue(new Error('Gmail API 503 backendError'));
    await runPlannerPass();
    const [job] = await pendingSendJobs();
    await expect(sendQueue.processEmailSend(job)).rejects.toThrow(/503/);

    const row = await sendRow(job.emailSendId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toMatch(/503/);
    const e = await enrollment(enr);
    expect(e.status).toBe('active');
    expect(e.next_step_number).toBe(1);
    expect(new Date(e.next_step_due_at!).toISOString()).toBe('2026-10-13T09:00:00.000Z');
    expect(isWithinSendWindow(new Date(e.next_step_due_at!))).toBe(true);
    expect((await account(a.id)).sends_today).toBe(0); // nothing delivered, nothing counted
  });

  it('a failure on Friday reschedules to Monday 08:00 London, not Saturday', async () => {
    setClock(new Date('2026-10-16T09:00:00.000Z')); // Fri 10:00 BST
    const { enr } = await setup();
    vi.spyOn(gmailClient, 'sendEmail').mockRejectedValue(new Error('ECONNRESET'));
    await runPlannerPass();
    const [job] = await pendingSendJobs();
    await sendQueue.processEmailSend(job).catch(() => undefined);
    expect(new Date((await enrollment(enr)).next_step_due_at!).toISOString()).toBe('2026-10-19T07:00:00.000Z');
  });

  it('retries up to 5 attempts at the same step, then cancels the enrollment', async () => {
    const { enr } = await setup();
    vi.spyOn(gmailClient, 'sendEmail').mockRejectedValue(new Error('Gmail API 500'));
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await forceDue(enr);
      const plan = await runPlannerPass();
      expect(plan.planned, `attempt ${attempt} planned`).toBe(1);
      await drainSendQueue().catch(() => undefined);
      const e = await enrollment(enr);
      expect(e.status, `status after attempt ${attempt}`).toBe(attempt < 5 ? 'active' : 'cancelled');
    }
    await forceDue(enr);
    expect((await runPlannerPass()).planned).toBe(0);
    expect((await emailSends()).filter(s => s.status === 'failed')).toHaveLength(5);
    expect(await outbox()).toHaveLength(0);
  });

  it('a "thread not found" error retries once without threadId and sends', async () => {
    const a = await createAccount({ email: COLD_A, limits: { daily: 100, hourly: 50 } });
    const id = await insertQueuedSend({ accountId: a.id, fromEmail: COLD_A, to: 'x@example-dev.test' });
    const real = gmailClient.sendEmail.bind(gmailClient);
    vi.spyOn(gmailClient, 'sendEmail').mockImplementation(async (acc, opts) => {
      if (opts.threadId) throw new Error('Requested entity was not found.');
      return real(acc, opts);
    });
    await sendQueue.processEmailSend({ emailSendId: id, threadId: 'gone-thread' });
    expect((await sendRow(id)).status).toBe('sent');
    expect(await outbox()).toHaveLength(1);
  });
});

describe('permanent gate blocks cancel the enrollment', () => {
  beforeEach(async () => { await resetAll(); installFakeGmail(); setClock(T0); });
  afterEach(() => restoreClock());

  it('recipient suppressed after queuing: send failed, enrollment cancelled, nothing sent', async () => {
    const { c, enr } = await setup();
    await runPlannerPass();
    await suppress(c.email);
    await drainSendQueue();
    expect((await emailSends())[0].status).toBe('failed');
    expect((await enrollment(enr)).status).toBe('cancelled');
    expect(await outbox()).toHaveLength(0);
  });

  it.each(['unsubscribed', 'bounced'])('contact tagged %s after queuing: enrollment cancelled', async (tag) => {
    const { c, enr } = await setup();
    await runPlannerPass();
    await query(`UPDATE contacts SET tags = ARRAY[$1] WHERE id = $2`, [tag, c.id]);
    await drainSendQueue();
    expect((await enrollment(enr)).status).toBe('cancelled');
    expect(await outbox()).toHaveLength(0);
  });

  it('contact re-typed as lender after queuing: enrollment cancelled', async () => {
    const { c, enr } = await setup();
    await runPlannerPass();
    await query(`UPDATE contacts SET contact_type = 'lender' WHERE id = $1`, [c.id]);
    await drainSendQueue();
    expect((await enrollment(enr)).status).toBe('cancelled');
    expect(await outbox()).toHaveLength(0);
  });

  it('contact put on hold after queuing: not sent, enrollment kept active and retried later (non-permanent)', async () => {
    const { c, enr } = await setup();
    await runPlannerPass();
    await query(`UPDATE contacts SET tags = ARRAY['hold'] WHERE id = $1`, [c.id]);
    await drainSendQueue();
    expect(await outbox()).toHaveLength(0);
    const e = await enrollment(enr);
    expect(e.status).toBe('active');
    expect(e.next_step_due_at).not.toBeNull();
  });
});
