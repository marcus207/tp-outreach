/**
 * Tests for SendQueue.processEmailSend — the BullMQ email send worker —
 * and the shared send-gate rules / send window helpers.
 *
 * Regression tests:
 *   - Idempotency: duplicate BullMQ jobs must not send twice ('sending' claim)
 *   - Single window: Mon-Fri 08:00-17:00 Europe/London for ALL sends
 *   - Never email lenders / hold / unsubscribed / bounced / suppressed
 *   - Suppression applies to sends with no contact_id (press releases)
 *   - Failed sequence sends never strand the enrollment
 *   - A delivered email is never flipped to 'failed' by a counter error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeAccount, setupQueryResponses,
  setInsideWindow, setOutsideWindow, setWeekend, setUTCTime,
} from './helpers';

// ── Module mocks (before imports) ───────────────────────────────────

const {
  mockQueueAdd, mockQueueClose, mockQuery, mockSendEmail, mockIncrementSendCounts,
  mockScheduleNextStep, mockHandleFailedSend, MockQueue, MockWorker,
} = vi.hoisted(() => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQuery = vi.fn();
  const mockSendEmail = vi.fn();
  const mockIncrementSendCounts = vi.fn();
  const mockScheduleNextStep = vi.fn().mockResolvedValue(undefined);
  const mockHandleFailedSend = vi.fn().mockResolvedValue(undefined);
  const MockQueue = vi.fn(function() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
    };
  });
  const MockWorker = vi.fn(function() {
    return {
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });
  return {
    mockQueueAdd, mockQueueClose, mockQuery, mockSendEmail, mockIncrementSendCounts,
    mockScheduleNextStep, mockHandleFailedSend, MockQueue, MockWorker,
  };
});

vi.mock('bullmq', () => ({
  Queue: MockQueue,
  Worker: MockWorker,
}));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  TENANT: 'test-tenant',
  BULL_PREFIX: 'bull-test-tenant',
}));

vi.mock('../services/gmail-client', () => ({
  gmailClient: {
    sendEmail: mockSendEmail,
    incrementSendCounts: mockIncrementSendCounts,
  },
}));

vi.mock('../services/daily-planner', () => ({
  dailyPlanner: {
    scheduleNextStep: mockScheduleNextStep,
    handleFailedSend: mockHandleFailedSend,
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { SendQueue } from '../services/send-queue';
import { isWithinSendWindow, nextSendWindowStart, msUntilSendWindowCloses, isBulkOrRoleAddress } from '../services/send-gate';

// ── Helpers ─────────────────────────────────────────────────────────

function makeSendRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'send-1',
    to_email: 'recipient@example.com',
    from_email: 'sender@test.com',
    subject: 'Test Subject',
    body_html: '<p>Test</p>',
    tracking_id: 'track-1',
    email_account_id: 'acct-1',
    enrollment_id: null as string | null,
    broadcast_id: null as string | null,
    contact_id: 'contact-1' as string | null,
    status: 'queued',
    ...overrides,
  };
}

/**
 * Configure DB mocks for a standard processEmailSend call.
 * Defaults: queued campaign email (no enrollment), active account, no tags.
 */
function setupSendMocks(overrides: {
  send?: Record<string, unknown>;
  enrollmentStatus?: string;
  sequenceStatus?: string;
  contactTags?: string[];
  contactType?: string | null;
  contacts?: Record<string, unknown>[];
  suppressed?: boolean;
  account?: Record<string, unknown> | null;
  claimSucceeds?: boolean;
  reserveSucceeds?: boolean;
  blast?: { sequence_status: string; sequence_type: string; campaign_active: boolean | null };
} = {}) {
  const send = makeSendRecord(overrides.send || {});
  const account = overrides.account !== null
    ? makeAccount(overrides.account as any || {})
    : null;

  const contacts = overrides.contacts ?? (send.contact_id
    ? [{
        id: send.contact_id,
        email: send.to_email,
        tags: overrides.contactTags || [],
        contact_type: overrides.contactType ?? 'developer',
      }]
    : []);

  const responses: Record<string, unknown[]> = {
    // Atomic slot reservation in the gate (cap check + increment in one UPDATE)
    'sends_this_hour = sends_this_hour + 1': overrides.reserveSucceeds === false ? [] : [{ id: 'acct-1' }],
    "SET status = 'sending'": overrides.claimSucceeds === false ? [] : [{ id: send.id }],
    'AS campaign_active': overrides.blast ? [overrides.blast] : [],
    'FROM email_sends WHERE id': [send],
    'FROM contacts': contacts,
    'FROM suppressed_emails': overrides.suppressed ? [{ id: 'supp-1' }] : [],
    'FROM email_accounts WHERE id': account ? [account] : [],
  };

  if (send.enrollment_id) {
    responses['se.status as enrollment_status'] = [
      {
        enrollment_status: overrides.enrollmentStatus || 'active',
        sequence_status: overrides.sequenceStatus || 'active',
      },
    ];
  }

  setupQueryResponses(mockQuery, responses);
  return { send, account };
}

function sqlCalls(fragment: string) {
  return mockQuery.mock.calls.filter(
    (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes(fragment)
  );
}

function failedUpdates() {
  return sqlCalls("SET status = 'failed'");
}

// ── Setup / teardown ────────────────────────────────────────────────

let sq: SendQueue;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue({ messageId: 'msg-1', threadId: 'thread-1' });
  mockIncrementSendCounts.mockResolvedValue(undefined);
  sq = new SendQueue();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Call the private processEmailSend method directly. */
async function processEmail(data: { emailSendId: string; threadId?: string; fromName?: string; preCounted?: boolean }) {
  return (sq as any).processEmailSend(data);
}

// ═════════════════════════════════════════════════════════════════════
// Send window helpers — Mon-Fri 08:00-17:00 Europe/London
// ═════════════════════════════════════════════════════════════════════

describe('send window helpers', () => {
  const utc = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(Date.UTC(y, m - 1, d, h, min));

  it('BST: 07:00 UTC (08:00 London) is inside, 06:59 UTC is outside', () => {
    expect(isWithinSendWindow(utc(2026, 4, 15, 7, 0))).toBe(true);
    expect(isWithinSendWindow(utc(2026, 4, 15, 6, 59))).toBe(false);
  });

  it('BST: 16:00 UTC (17:00 London) is outside, 15:59 UTC is inside', () => {
    expect(isWithinSendWindow(utc(2026, 4, 15, 16, 0))).toBe(false);
    expect(isWithinSendWindow(utc(2026, 4, 15, 15, 59))).toBe(true);
  });

  it('GMT: 08:00 UTC inside, 17:00 UTC outside', () => {
    expect(isWithinSendWindow(utc(2026, 1, 14, 8, 0))).toBe(true);
    expect(isWithinSendWindow(utc(2026, 1, 14, 7, 59))).toBe(false);
    expect(isWithinSendWindow(utc(2026, 1, 14, 17, 0))).toBe(false);
  });

  it('weekends are outside', () => {
    expect(isWithinSendWindow(utc(2026, 4, 18, 10))).toBe(false); // Sat
    expect(isWithinSendWindow(utc(2026, 4, 19, 10))).toBe(false); // Sun
  });

  it('nextSendWindowStart returns the same instant when inside the window', () => {
    const d = utc(2026, 4, 15, 12, 34);
    expect(nextSendWindowStart(d).getTime()).toBe(d.getTime());
  });

  it('nextSendWindowStart: before window → same day 08:00 London', () => {
    expect(nextSendWindowStart(utc(2026, 4, 15, 5, 0)).toISOString()).toBe('2026-04-15T07:00:00.000Z');
  });

  it('nextSendWindowStart: after window → next day 08:00 London', () => {
    expect(nextSendWindowStart(utc(2026, 4, 14, 22, 0)).toISOString()).toBe('2026-04-15T07:00:00.000Z');
  });

  it('nextSendWindowStart: Friday evening / Saturday → Monday 08:00 London', () => {
    expect(nextSendWindowStart(utc(2026, 4, 17, 18, 0)).toISOString()).toBe('2026-04-20T07:00:00.000Z');
    expect(nextSendWindowStart(utc(2026, 4, 18, 10, 0)).toISOString()).toBe('2026-04-20T07:00:00.000Z');
  });

  it('nextSendWindowStart: across DST change (Sat 24 Oct BST → Mon 26 Oct GMT)', () => {
    expect(nextSendWindowStart(utc(2026, 10, 24, 12, 0)).toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('msUntilSendWindowCloses', () => {
    expect(msUntilSendWindowCloses(utc(2026, 4, 15, 15, 30))).toBe(30 * 60 * 1000);
    expect(msUntilSendWindowCloses(utc(2026, 4, 15, 20, 0))).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Idempotency — duplicate BullMQ jobs must not double-send
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — idempotency', () => {
  it.each(['sent', 'failed', 'sending'])('status "%s" → skips without sending', async (status) => {
    setInsideWindow();
    setupSendMocks({ send: { status } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates().length).toBe(0);
  });

  it('status "queued" → claims as sending, then sends', async () => {
    setInsideWindow();
    setupSendMocks();

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const claim = sqlCalls("SET status = 'sending'");
    expect(claim.length).toBe(1);
    expect(claim[0][0]).toContain("status = 'queued'");
    expect(claim[0][0]).toContain('RETURNING');
    // Claim happened before Gmail was called
    const claimOrder = mockQuery.mock.invocationCallOrder[mockQuery.mock.calls.indexOf(claim[0])];
    expect(claimOrder).toBeLessThan(mockSendEmail.mock.invocationCallOrder[0]);
  });

  it('claim lost to another job (UPDATE returns no row) → does not send', async () => {
    setInsideWindow();
    setupSendMocks({ claimSucceeds: false });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Single window check — applies to ALL emails (campaign + sequence)
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — window check', () => {
  it('campaign email (no enrollment) outside window 22:00 → blocked', async () => {
    setOutsideWindow();
    setupSendMocks({ send: { enrollment_id: null } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('campaign email inside window → sends', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: null } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('sequence email outside window → blocked', async () => {
    setOutsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('weekend → blocked', async () => {
    setWeekend();
    setupSendMocks({ send: { enrollment_id: null } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('07:30 UTC in BST (08:30 London) → sends', async () => {
    setUTCTime(2026, 4, 15, 7, 30);
    setupSendMocks({ send: { enrollment_id: 'enr-1' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('16:30 UTC in BST (17:30 London) → blocked', async () => {
    setUTCTime(2026, 4, 15, 16, 30);
    setupSendMocks({ send: { enrollment_id: 'enr-1' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does NOT re-queue or fail when outside window', async () => {
    setOutsideWindow();
    setupSendMocks();

    await processEmail({ emailSendId: 'send-1' });

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(failedUpdates().length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Enrollment / contact guards
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — enrollment/contact guards', () => {
  it('inactive enrollment → marks failed, cancels (permanent), does not send', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { enrollment_id: 'enr-1' },
      enrollmentStatus: 'cancelled',
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    const fails = failedUpdates();
    expect(fails.length).toBe(1);
    expect(fails[0][1][0]).toBe('Enrollment cancelled');
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Enrollment cancelled', true);
  });

  it('paused sequence → skips send but does NOT mark as failed', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { enrollment_id: 'enr-1' },
      sequenceStatus: 'paused',
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates().length).toBe(0);
  });

  it('draft sequence → refused (failed, not permanent), does not send', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' }, sequenceStatus: 'draft' });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Sequence is draft', false);
  });

  it('archived sequence → refused permanently, does not send', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' }, sequenceStatus: 'archived' });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Sequence is archived', true);
  });

  it('blast send while campaign paused → skipped (stays queued), does not send', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { sequence_step_id: 'step-1' },
      blast: { sequence_status: 'active', sequence_type: 'blast', campaign_active: false },
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates().length).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('blast send with campaign active → sends', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { sequence_step_id: 'step-1' },
      blast: { sequence_status: 'active', sequence_type: 'blast', campaign_active: true },
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('role/bulk recipient (noreply@) → permanent fail, does not send', async () => {
    setInsideWindow();
    setupSendMocks({ send: { to_email: 'noreply@example.com', enrollment_id: 'enr-1' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Role/bulk address', true);
  });

  it('unsubscribed contact → marks failed, does not send', async () => {
    setInsideWindow();
    setupSendMocks({ contactTags: ['unsubscribed'] });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Unsubscribed');
  });

  it('bounced contact → marks failed', async () => {
    setInsideWindow();
    setupSendMocks({ contactTags: ['bounced'] });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Contact bounced');
  });

  it('lender contact → permanent fail, cancels enrollment', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' }, contactType: 'lender' });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Contact is a lender');
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Contact is a lender', true);
  });

  it('hold-tagged contact → fails non-permanently (enrollment retried)', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' }, contactTags: ['hold'] });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Contact on hold', false);
  });

  it('internal @tp.finance address bypasses lender/hold checks', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { to_email: 'marcus@tp.finance' },
      contactType: 'lender',
      contactTags: ['hold'],
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('internal address is still blocked by suppression', async () => {
    setInsideWindow();
    setupSendMocks({ send: { to_email: 'someone@go.tp.finance' }, suppressed: true });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Permanently suppressed');
  });

  it('suppressed email → permanent fail', async () => {
    setInsideWindow();
    setupSendMocks({ suppressed: true });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Permanently suppressed');
  });

  it('press release with NO contact_id is still checked against suppression by to_email', async () => {
    setInsideWindow();
    setupSendMocks({ send: { contact_id: null, to_email: 'Press@Example.com' }, suppressed: true });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    const supp = sqlCalls('FROM suppressed_emails');
    expect(supp.length).toBeGreaterThan(0);
    expect(supp[0][1][0]).toBe('press@example.com');
  });

  it('press release with no contact_id but a lender contact on that address → blocked', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { contact_id: null },
      contacts: [{ id: 'c-9', email: 'recipient@example.com', tags: [], contact_type: 'lender' }],
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Contact is a lender');
  });

  it('suppression domain match only applies to source=manual rows with a domain', async () => {
    setInsideWindow();
    setupSendMocks();

    await processEmail({ emailSendId: 'send-1' });

    const supp = sqlCalls('FROM suppressed_emails');
    expect(supp.length).toBeGreaterThan(0);
    const sql = supp[0][0] as string;
    expect(sql).toContain("source = 'manual'");
    expect(sql).toContain('domain IS NOT NULL');
    expect(sql).toContain('tenant = $2');
  });

  it('contact_id not found in this tenant → permanent fail', async () => {
    setInsideWindow();
    setupSendMocks({ contacts: [] });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Contact not found in tenant');
  });

  it('email send record not found → does not send', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM email_sends WHERE id': [],
    });

    await processEmail({ emailSendId: 'nonexistent' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('email account not found or inactive → fails non-permanently, enrollment retried', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' }, account: null });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates()[0][1][0]).toBe('Email account inactive');
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Email account inactive', false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Rate limits — skip (stay queued), never fail
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — rate limits', () => {
  it('daily limit reached → skips, stays queued', async () => {
    setInsideWindow();
    setupSendMocks({ account: { daily_limit: 80, sends_today: 80 } });

    await processEmail({ emailSendId: 'send-1', threadId: 't-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates().length).toBe(0);
    // Re-added (full payload) for the next window, not dropped
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, data, opts] = mockQueueAdd.mock.calls[0];
    expect(data).toEqual({ emailSendId: 'send-1', threadId: 't-1' });
    const fireAt = new Date(Date.now() + opts.delay);
    expect(isWithinSendWindow(fireAt)).toBe(true);
    expect(fireAt.toISOString().slice(0, 10)).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it('hourly limit reached → skips, stays queued', async () => {
    setInsideWindow();
    setupSendMocks({ account: { hourly_limit: 15, sends_this_hour: 15 } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(failedUpdates().length).toBe(0);
    // Re-added for the next clock hour, inside the window
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const opts = mockQueueAdd.mock.calls[0][2];
    const fireAt = new Date(Date.now() + opts.delay);
    expect(isWithinSendWindow(fireAt)).toBe(true);
    expect(opts.delay).toBeLessThanOrEqual(3600000 + 11 * 60000);
    expect(sqlCalls('sends_this_hour = sends_this_hour + 1').length).toBe(0);
  });

  it('within send gap → re-adds the job with full payload instead of dropping it', async () => {
    setInsideWindow();
    setupSendMocks({ account: { last_send_at: new Date(Date.now() - 30000) } });

    await processEmail({ emailSendId: 'send-1', threadId: 't-1', fromName: 'Marcus' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, data, opts] = mockQueueAdd.mock.calls[0];
    expect(data).toEqual({ emailSendId: 'send-1', threadId: 't-1', fromName: 'Marcus' });
    expect(opts.delay).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Successful send + error handling
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — send + error handling', () => {
  it('successful send → calls Gmail, marks sent, counts once (atomic reservation, no post-send increment)', async () => {
    setInsideWindow();
    const { account } = setupSendMocks();

    await processEmail({ emailSendId: 'send-1', threadId: 'thr-1', fromName: 'Marcus' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: account!.id }),
      expect.objectContaining({
        to: 'recipient@example.com',
        from: 'sender@test.com',
        subject: 'Test Subject',
        threadId: 'thr-1',
        fromName: 'Marcus',
      })
    );
    const reserve = sqlCalls('sends_this_hour = sends_this_hour + 1');
    expect(reserve.length).toBe(1);
    expect(reserve[0][0]).toContain('sends_today < daily_limit');
    expect(reserve[0][0]).toContain('sends_this_hour < hourly_limit');
    expect(reserve[0][0]).toContain('RETURNING');
    // Reservation happens before Gmail; never incremented again afterwards
    const reserveOrder = mockQuery.mock.invocationCallOrder[mockQuery.mock.calls.indexOf(reserve[0])];
    expect(reserveOrder).toBeLessThan(mockSendEmail.mock.invocationCallOrder[0]);
    expect(mockIncrementSendCounts).not.toHaveBeenCalled();
    expect(sqlCalls('GREATEST(sends_today - 1, 0)').length).toBe(0);
    expect(sqlCalls('SET last_send_at = NOW()').length).toBe(1);
    expect(sqlCalls("status = 'sent'").length).toBe(1);
    expect(failedUpdates().length).toBe(0);
  });

  it('preCounted → no reservation and no increment (slot taken at queue time)', async () => {
    setInsideWindow();
    setupSendMocks();

    await processEmail({ emailSendId: 'send-1', preCounted: true });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockIncrementSendCounts).not.toHaveBeenCalled();
    expect(sqlCalls('sends_this_hour = sends_this_hour + 1').length).toBe(0);
  });

  it('reservation lost to a concurrent job → no send, re-added for the next hour with full payload', async () => {
    setInsideWindow();
    setupSendMocks({ reserveSucceeds: false, account: { hourly_limit: 5, sends_this_hour: 4 } });

    await processEmail({ emailSendId: 'send-1', threadId: 't-1', fromName: 'Marcus' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(sqlCalls("SET status = 'sending'").length).toBe(0);
    expect(failedUpdates().length).toBe(0);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, data, opts] = mockQueueAdd.mock.calls[0];
    expect(data).toEqual({ emailSendId: 'send-1', threadId: 't-1', fromName: 'Marcus' });
    expect(opts.delay).toBeGreaterThanOrEqual(60000);
  });

  it('Gmail failure → releases the reserved slot (never below 0)', async () => {
    setInsideWindow();
    setupSendMocks();
    mockSendEmail.mockRejectedValue(new Error('Gmail API 500'));

    await expect(processEmail({ emailSendId: 'send-1' })).rejects.toThrow('500');

    const release = sqlCalls('GREATEST(sends_today - 1, 0)');
    expect(release.length).toBe(1);
    expect(release[0][0]).toContain('GREATEST(sends_this_hour - 1, 0)');
  });

  it('claim lost after reservation → releases the slot', async () => {
    setInsideWindow();
    setupSendMocks({ claimSucceeds: false });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(sqlCalls('GREATEST(sends_today - 1, 0)').length).toBe(1);
  });

  it('pushed back by the send gap → releases the slot', async () => {
    setInsideWindow();
    setupSendMocks({ account: { last_send_at: new Date(Date.now() - 30000) } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(sqlCalls('GREATEST(sends_today - 1, 0)').length).toBe(1);
  });

  it('sequence send success → schedules next step', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockScheduleNextStep).toHaveBeenCalledWith('send-1');
    expect(mockHandleFailedSend).not.toHaveBeenCalled();
  });

  it('last_send_at update failure → still sent, never marked failed', async () => {
    setInsideWindow();
    setupSendMocks();
    const impl0 = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('SET last_send_at = NOW()')) return Promise.reject(new Error('db blip'));
      return impl0(sql, params);
    });

    await expect(processEmail({ emailSendId: 'send-1' })).resolves.toBeUndefined();

    expect(sqlCalls("status = 'sent'").length).toBe(1);
    expect(failedUpdates().length).toBe(0);
  });

  it('status=sent update failure after Gmail success → row left as sending, not failed', async () => {
    setInsideWindow();
    setupSendMocks();
    const impl = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("status = 'sent'")) return Promise.reject(new Error('connection lost'));
      return impl(sql, params);
    });

    await expect(processEmail({ emailSendId: 'send-1' })).resolves.toBeUndefined();

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(failedUpdates().length).toBe(0);
    expect(mockHandleFailedSend).not.toHaveBeenCalled();
  });

  it('Gmail failure → marks failed, reschedules enrollment (non-permanent), re-throws', async () => {
    setInsideWindow();
    setupSendMocks({ send: { enrollment_id: 'enr-1' } });
    mockSendEmail.mockRejectedValue(new Error('invalid_grant'));

    await expect(
      processEmail({ emailSendId: 'send-1' })
    ).rejects.toThrow('invalid_grant');

    const fails = failedUpdates().filter(c => (c[0] as string).includes('error_message'));
    expect(fails.length).toBe(1);
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'invalid_grant', false);
    expect(mockScheduleNextStep).not.toHaveBeenCalled();
  });

  it('thread not found → retries once without threadId', async () => {
    setInsideWindow();
    setupSendMocks();
    mockSendEmail
      .mockRejectedValueOnce(new Error('Requested entity was not found.'))
      .mockResolvedValueOnce({ messageId: 'msg-2', threadId: 'thread-2' });

    await processEmail({ emailSendId: 'send-1', threadId: 'old-thread' });

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls[1][1].threadId).toBeUndefined();
    expect(sqlCalls("status = 'sent'").length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Role / bulk address detection
// ═════════════════════════════════════════════════════════════════════

describe('isBulkOrRoleAddress', () => {
  it.each([
    'noreply@example.com', 'no-reply@example.com', 'no_reply@example.co.uk', 'donotreply@example.com',
    'do-not-reply@example.com', 'notifications@example.com', 'notification@example.com',
    'newsletter@example.com', 'newsletters@example.com', 'enews@example.com', 'mailer-daemon@example.com',
    'bounce@example.com', 'bounces+abc@example.com', 'postmaster@example.com', 'info-noreply@example.com',
    'jane@notifications.platform.com', 'jane@enews.publisher.co.uk', 'x@email.sender.com',
    'x@mail.sender.com', 'x@news.publisher.com', 'NoReply@Example.com',
  ])('%s → blocked', (email) => {
    expect(isBulkOrRoleAddress(email)).toBe(true);
  });

  it.each([
    'info@example.com', 'sales@example.com', 'hello@example.com', 'contact@example.com',
    'jane.smith@example.com', 'news.desk@example.com', 'jane@mail.com', 'jane@email.com',
    'jane@example.co.uk', 'marcus@go.tp.finance', 'mailroom@example.com', '', null, 'not-an-email',
  ])('%s → allowed', (email) => {
    expect(isBulkOrRoleAddress(email as string | null)).toBe(false);
  });
});
