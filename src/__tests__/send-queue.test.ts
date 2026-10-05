/**
 * Tests for SendQueue.processEmailSend — the BullMQ email send worker.
 *
 * Regression tests:
 *   - Idempotency: duplicate BullMQ jobs must not send twice
 *   - Global window check: campaign emails (no enrollment) must respect the window
 *   - Unsubscribed / inactive enrollment guards
 *   - No re-queue on window miss (prevents overnight BullMQ job accumulation)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeAccount, setupQueryResponses,
  setInsideWindow, setOutsideWindow, setWeekend, setUTCTime,
} from './helpers';

// ── Module mocks (before imports) ───────────────────────────────────

const {
  mockQueueAdd, mockQueueClose, mockQuery, mockSendEmail, mockIncrementSendCounts,
  MockQueue, MockWorker,
} = vi.hoisted(() => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQuery = vi.fn();
  const mockSendEmail = vi.fn();
  const mockIncrementSendCounts = vi.fn();
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
    MockQueue, MockWorker,
  };
});

vi.mock('bullmq', () => ({
  Queue: MockQueue,
  Worker: MockWorker,
}));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  TENANT: 'test-tenant',
}));

vi.mock('../services/gmail-client', () => ({
  gmailClient: {
    sendEmail: mockSendEmail,
    incrementSendCounts: mockIncrementSendCounts,
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { SendQueue } from '../services/send-queue';

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
    contact_id: 'contact-1',
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
  account?: Record<string, unknown> | null;
  sequenceWindow?: { send_window_start: string; send_window_end: string; skip_weekends: boolean };
} = {}) {
  const send = makeSendRecord(overrides.send || {});
  const account = overrides.account !== null
    ? makeAccount(overrides.account as any || {})
    : null;

  const responses: Record<string, unknown[]> = {
    'FROM email_sends WHERE id': [send],
    'FROM contacts WHERE id': [{ tags: overrides.contactTags || [] }],
    'FROM email_accounts WHERE id': account ? [account] : [],
  };

  if (send.enrollment_id) {
    // Enrollment + sequence status check (JOIN query with se.status, s.status)
    responses['se.status as enrollment_status'] = [
      {
        enrollment_status: overrides.enrollmentStatus || 'active',
        sequence_status: overrides.sequenceStatus || 'active',
      },
    ];
    // Window settings query (JOIN query with s.send_window_start)
    responses['s.send_window_start'] = [
      overrides.sequenceWindow || {
        send_window_start: '09:00',
        send_window_end: '17:00',
        skip_weekends: true,
      },
    ];
  }

  setupQueryResponses(mockQuery, responses);
  return { send, account };
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
async function processEmail(data: { emailSendId: string; threadId?: string; fromName?: string }) {
  return (sq as any).processEmailSend(data);
}

// ═════════════════════════════════════════════════════════════════════
// Idempotency — duplicate BullMQ jobs must not double-send
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — idempotency', () => {
  it('status "sent" → skips without sending', async () => {
    setInsideWindow();
    setupSendMocks({ send: { status: 'sent' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('status "failed" → skips without sending', async () => {
    setInsideWindow();
    setupSendMocks({ send: { status: 'failed' } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('status "queued" → proceeds to send', async () => {
    setInsideWindow();
    setupSendMocks();

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Global window check — applies to ALL emails (campaign + sequence)
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — global window check', () => {
  it('campaign email (no enrollment) outside window 22:00 → blocked', async () => {
    setOutsideWindow(); // 22:00 UTC
    setupSendMocks({ send: { enrollment_id: null } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('campaign email inside window → sends', async () => {
    setInsideWindow(); // 14:30 UTC
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

  it('weekend with skip_weekends → blocked', async () => {
    setWeekend(); // Sat 10:00 UTC
    setupSendMocks({ send: { enrollment_id: null } });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does NOT re-queue when outside window (prevents BullMQ job accumulation)', async () => {
    setOutsideWindow();
    setupSendMocks();

    await processEmail({ emailSendId: 'send-1' });

    // Must NOT add any new jobs — requeueStuckSends handles retry
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('uses sequence window settings when enrollment exists', async () => {
    // 08:00 UTC — outside default 09:00-17:00 but inside custom 07:00-18:00
    setUTCTime(2026, 4, 15, 8, 0);

    setupSendMocks({
      send: { enrollment_id: 'enr-1' },
      sequenceWindow: { send_window_start: '07:00', send_window_end: '18:00', skip_weekends: true },
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('sequence with narrow window overrides default at 14:30', async () => {
    setInsideWindow(); // 14:30 — inside default window

    // But sequence has narrow 08:00-14:00 window
    setupSendMocks({
      send: { enrollment_id: 'enr-1' },
      sequenceWindow: { send_window_start: '08:00', send_window_end: '14:00', skip_weekends: true },
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Enrollment / contact guards
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — enrollment/contact guards', () => {
  it('inactive enrollment → marks as failed, does not send', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { enrollment_id: 'enr-1' },
      enrollmentStatus: 'cancelled',
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();

    const updateCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Enrollment cancelled')
    );
    expect(updateCalls.length).toBe(1);
  });

  it('paused sequence → skips send but does NOT mark as failed', async () => {
    setInsideWindow();
    setupSendMocks({
      send: { enrollment_id: 'enr-1' },
      sequenceStatus: 'paused',
    });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();

    // Must NOT update email_sends to failed — just skip
    const failCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'")
    );
    expect(failCalls.length).toBe(0);
  });

  it('unsubscribed contact → marks as failed, does not send', async () => {
    setInsideWindow();
    setupSendMocks({ contactTags: ['unsubscribed'] });

    await processEmail({ emailSendId: 'send-1' });

    expect(mockSendEmail).not.toHaveBeenCalled();

    const updateCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Unsubscribed')
    );
    expect(updateCalls.length).toBe(1);
  });

  it('email send record not found → throws', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM email_sends WHERE id': [],
    });

    await expect(
      processEmail({ emailSendId: 'nonexistent' })
    ).rejects.toThrow('not found');
  });

  it('email account not found or inactive → throws', async () => {
    setInsideWindow();
    setupSendMocks({ account: null });

    await expect(
      processEmail({ emailSendId: 'send-1' })
    ).rejects.toThrow('not found or inactive');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Rate limits
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — rate limits', () => {
  it('daily limit reached → throws', async () => {
    setInsideWindow();
    setupSendMocks({ account: { daily_limit: 80, sends_today: 80 } });

    await expect(
      processEmail({ emailSendId: 'send-1' })
    ).rejects.toThrow('Daily limit reached');
  });

  it('hourly limit reached → throws', async () => {
    setInsideWindow();
    setupSendMocks({ account: { hourly_limit: 15, sends_this_hour: 15 } });

    await expect(
      processEmail({ emailSendId: 'send-1' })
    ).rejects.toThrow('Hourly limit reached');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Successful send + error handling
// ═════════════════════════════════════════════════════════════════════

describe('processEmailSend — send + error handling', () => {
  it('successful send → calls Gmail, updates record, increments counts', async () => {
    setInsideWindow();
    const { account } = setupSendMocks();

    await processEmail({ emailSendId: 'send-1' });

    // Gmail API called
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: account!.id }),
      expect.objectContaining({
        to: 'recipient@example.com',
        from: 'sender@test.com',
        subject: 'Test Subject',
      })
    );

    // Send counts incremented
    expect(mockIncrementSendCounts).toHaveBeenCalledWith(account!.id);

    // Record updated to 'sent'
    const updateCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'sent'")
    );
    expect(updateCalls.length).toBe(1);
  });

  it('Gmail failure → updates to failed and re-throws for BullMQ retry', async () => {
    setInsideWindow();
    setupSendMocks();
    mockSendEmail.mockRejectedValue(new Error('Gmail API rate limit'));

    await expect(
      processEmail({ emailSendId: 'send-1' })
    ).rejects.toThrow('Gmail API rate limit');

    // Record updated to failed with error message
    const updateCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes("status = 'failed'") &&
        (c[0] as string).includes('error_message')
    );
    expect(updateCalls.length).toBe(1);
  });
});
