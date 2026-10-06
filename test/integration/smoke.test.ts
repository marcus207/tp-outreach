/**
 * End-to-end smoke test proving the harness: plan -> queue -> send (captured)
 * -> human reply injected via the Gmail seam -> reply watcher stops automation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  setClock, restoreClock, assertInSendWindow, resetAll, installFakeGmail, closeAll,
  createAccount, createContact, createSequence, enroll,
  runPlannerPass, pendingSendJobs, drainSendQueue, runReplyWatcher,
  outbox, emailSends, enrollment, isEmailSuppressed, fakeGmail,
} from './factories';
import { query } from '../../src/db/connection';

describe('harness smoke: developer contact, 2-step sequence, human reply', () => {
  beforeAll(async () => {
    await resetAll();
    installFakeGmail();
    setClock(); // Mon 10:00 Europe/London
  });

  afterAll(async () => {
    restoreClock();
    await closeAll();
  });

  it('Express app is importable without listening and answers /api/health', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenant: 'tp' });
  });

  it('plans, sends exactly one captured email, then a human reply stops step 2', async () => {
    assertInSendWindow();

    const account = await createAccount({ email: 'marcus.emadi@go.tp.finance', limits: { daily: 10, hourly: 2 } });
    const contact = await createContact({ email: 'dana@harbourside-dev.test', type: 'developer', subsector: 'residential' });
    const seq = await createSequence({
      name: 'Developer intro',
      accountIds: [account.id],
      steps: [
        { subject: 'Funding for {{company}}' },
        { subject: 'Following up', delayDays: 3 },
      ],
    });
    const enrollmentId = await enroll(seq.id, contact.id);

    // ── Planner pass: one job queued in Redis DB 15 ──
    const plan = await runPlannerPass();
    expect(plan.planned).toBe(1);
    expect(plan.distribution).toEqual({ 'marcus.emadi@go.tp.finance': 1 });
    const jobs = await pendingSendJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].fromName).toBe('Marcus Emadi');

    // ── Process the queue synchronously ──
    expect(await drainSendQueue()).toBe(1);

    const box = await outbox();
    expect(box).toHaveLength(1);
    const mail = box[0];
    expect(mail.from_email).toBe('marcus.emadi@go.tp.finance');
    expect(mail.from_header).toBe('"Marcus Emadi" <marcus.emadi@go.tp.finance>');
    expect(mail.to_email).toBe('dana@harbourside-dev.test');
    expect(mail.subject).toBe('Funding for Example Developments Ltd');
    expect(mail.headers['List-Unsubscribe']).toMatch(/^<https:\/\/track\.test\.invalid\/t\/[0-9a-f]+\/unsubscribe>(, <mailto:[^>]+>)?$/);
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.headers['Reply-To']).toBe('Marcus Emadi <marcus@tp.finance>');
    expect(mail.html_body).toContain('Hi Dana,');
    expect(mail.html_body).toContain('/unsubscribe');
    expect(mail.raw_message).toContain('Content-Type: multipart/alternative');

    const sends = await emailSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].status).toBe('sent');
    expect(sends[0].gmail_message_id).toBe(mail.fake_message_id);
    expect(sends[0].gmail_thread_id).toBe(mail.fake_thread_id);
    expect(mail.tracking_id).toBe(sends[0].tracking_id);

    // Step 2 is scheduled on the enrollment
    let enr = await enrollment(enrollmentId);
    expect(enr.status).toBe('active');
    expect(enr.current_step).toBe(1);
    expect(enr.next_step_number).toBe(2);

    // ── Human reply arrives on the outbound thread ──
    fakeGmail.injectReply({
      mailbox: 'marcus.emadi@go.tp.finance',
      threadId: mail.fake_thread_id,
      from: 'Dana Developer <dana@harbourside-dev.test>',
      subject: 'Re: Funding for Example Developments Ltd',
      body: 'Hi Marcus, yes this is timely. Could you do a call on Thursday?',
    });
    await runReplyWatcher();

    enr = await enrollment(enrollmentId);
    expect(enr.status).not.toBe('active');
    expect(enr.status).toBe('replied');
    expect(enr.replied_at).not.toBeNull();
    expect(await isEmailSuppressed('dana@harbourside-dev.test')).toBe(true);

    const events = await query<{ event_type: string }>(
      `SELECT event_type FROM email_events WHERE email_send_id = $1 ORDER BY created_at`, [sends[0].id]
    );
    expect(events.rows.map(e => e.event_type)).toEqual(['reply', 'reply_fwd']);

    // Reply was forwarded to marcus@ through the Gmail seam (not real Gmail)
    expect(fakeGmail.sent).toHaveLength(1);
    expect(fakeGmail.sent[0].headers.To).toBe('marcus@tp.finance');

    // ── Step 2 never sends: force it due, then plan + drain again ──
    await query(`UPDATE sequence_enrollments SET next_step_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [enrollmentId]);
    const plan2 = await runPlannerPass();
    expect(plan2.planned).toBe(0);
    expect(await drainSendQueue()).toBe(0);
    expect(await outbox()).toHaveLength(1);
    expect(await emailSends()).toHaveLength(1);
  });
});
