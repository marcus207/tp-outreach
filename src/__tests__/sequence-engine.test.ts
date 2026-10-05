/**
 * Tests for SequenceEngine — the core email scheduling pipeline.
 *
 * Every bug that shipped in production is captured here so it can
 * never regress:
 *   - Emails sent outside the 09:00-17:00 send window
 *   - All emails blasting at once instead of staggering
 *   - Duplicate emails from BullMQ job collisions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeSequence, makeStep, makeEnrollment, makeContact,
  makeTemplate, makeAccount, setupQueryResponses,
  setInsideWindow, setOutsideWindow, setWeekend, setUTCTime,
} from './helpers';

// ── Module mocks (must be before imports) ────────────────────────────

const {
  mockQueueAdd, mockQueueClose, mockQueueGetJobs, mockQuery, MockQueue,
} = vi.hoisted(() => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQueueGetJobs = vi.fn().mockResolvedValue([]);
  const mockQuery = vi.fn();
  const MockQueue = vi.fn(function() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
      getJobs: mockQueueGetJobs,
    };
  });
  return { mockQueueAdd, mockQueueClose, mockQueueGetJobs, mockQuery, MockQueue };
});

vi.mock('bullmq', () => ({
  Queue: MockQueue,
}));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  TENANT: 'test-tenant',
}));

vi.mock('../services/gmail-client', () => ({
  gmailClient: {
    getBestSendingAccount: vi.fn(),
  },
}));

vi.mock('../services/template-engine', () => ({
  templateEngine: {
    renderTemplate: vi.fn().mockReturnValue({
      subject: 'Test Subject',
      bodyHtml: '<p>Test Body</p>',
      bodyText: 'Test Body',
    }),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { SequenceEngine } from '../services/sequence-engine';
import { gmailClient } from '../services/gmail-client';

// ── Setup / teardown ─────────────────────────────────────────────────

let engine: SequenceEngine;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  engine = new SequenceEngine();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Set up DB mocks for a standard processStep call that reaches the email send stage. */
function setupFullProcessStep(overrides: {
  enrollment?: Partial<ReturnType<typeof makeEnrollment>>;
  sequence?: Partial<ReturnType<typeof makeSequence>>;
  step?: Partial<ReturnType<typeof makeStep>>;
  contact?: Partial<ReturnType<typeof makeContact>>;
  template?: Partial<ReturnType<typeof makeTemplate>>;
  account?: Partial<ReturnType<typeof makeAccount>>;
  queuedCount?: number;
  hasNextStep?: boolean;
} = {}) {
  const enrollment = makeEnrollment(overrides.enrollment);
  const sequence = makeSequence(overrides.sequence);
  const step = makeStep(overrides.step);
  const contact = makeContact(overrides.contact);
  const template = makeTemplate(overrides.template);
  const account = makeAccount(overrides.account);

  (gmailClient.getBestSendingAccount as ReturnType<typeof vi.fn>)
    .mockResolvedValue(account);

  setupQueryResponses(mockQuery, {
    'FROM sequence_enrollments WHERE id': [enrollment],
    'FROM sequences WHERE id': [sequence],
    'FROM sequence_steps WHERE sequence_id': overrides.hasNextStep === false
      ? [step]  // only current step, no next
      : [step], // we handle next step queries separately below
    'FROM contacts WHERE id': [contact],
    'FROM templates WHERE id': [template],
    'gmail_thread_id FROM email_sends': [],  // no previous thread
    'INSERT INTO email_sends': [{ id: 'send-1' }],
    'UPDATE sequence_enrollments SET current_step': [],
    'COUNT(*) as count FROM email_sends': [{ count: String(overrides.queuedCount ?? 0) }],
  });

  // Override step query to handle both current and next step lookups
  const originalImpl = mockQuery.getMockImplementation()!;
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM sequence_steps WHERE sequence_id') && params) {
      const stepNum = params[1] as number;
      if (stepNum === step.step_number) {
        return Promise.resolve({ rows: [step], rowCount: 1 });
      }
      // Next step
      if (overrides.hasNextStep !== false) {
        return Promise.resolve({
          rows: [makeStep({ step_number: stepNum, delay_days: 7, delay_hours: 0 })],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return originalImpl(sql, params);
  });

  return { enrollment, sequence, step, contact, template, account };
}

// ═════════════════════════════════════════════════════════════════════
// processStep — Send Window
// ═════════════════════════════════════════════════════════════════════

describe('processStep — send window enforcement', () => {
  it('outside window (22:00 UTC) → reschedules, does NOT create email_sends', async () => {
    setOutsideWindow(); // Tue 22:00 UTC

    const { enrollment } = setupFullProcessStep();

    await engine.processStep(enrollment.id, 1);

    // Should schedule a retry (reschedule to tomorrow 09:00)
    const stepQueueCalls = mockQueueAdd.mock.calls.filter(
      (c) => c[0] === 'process-step'
    );
    expect(stepQueueCalls.length).toBe(1);
    const [, , opts] = stepQueueCalls[0];
    // Delay should be roughly 11 hours (22:00 → 09:00 next day)
    expect(opts.delay).toBeGreaterThan(10 * 60 * 60 * 1000);
    expect(opts.delay).toBeLessThan(12 * 60 * 60 * 1000);

    // Should NOT have created an email_sends record
    const insertCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('Saturday with skip_weekends=true → reschedules to Monday 09:00', async () => {
    setWeekend(); // Sat 10:00 UTC

    setupFullProcessStep({ sequence: { skip_weekends: true } });

    await engine.processStep('enr-1', 1);

    const stepCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'process-step');
    expect(stepCalls.length).toBe(1);
    const delayMs = stepCalls[0][2].delay;
    // Sat 10:00 → Mon 09:00 = 47 hours
    expect(delayMs).toBeGreaterThan(46 * 60 * 60 * 1000);
    expect(delayMs).toBeLessThan(48 * 60 * 60 * 1000);

    // No email created
    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('inside window (14:30 UTC Wed) → creates email_sends and queues send', async () => {
    setInsideWindow(); // Wed 14:30 UTC

    setupFullProcessStep({ hasNextStep: false });

    await engine.processStep('enr-1', 1);

    // Should have created an email_sends record
    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(1);

    // Should have added to email-sends queue
    const sendQueueCalls = mockQueueAdd.mock.calls.filter(
      c => c[0] === 'send-email'
    );
    expect(sendQueueCalls.length).toBe(1);
  });

  it('08:59 UTC → outside window (before start)', async () => {
    setUTCTime(2026, 4, 15, 8, 59); // Wed 08:59

    setupFullProcessStep();
    await engine.processStep('enr-1', 1);

    // Should reschedule, not send
    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('17:00 UTC → outside window (at boundary, window uses <)', async () => {
    setUTCTime(2026, 4, 15, 17, 0); // Wed 17:00

    setupFullProcessStep();
    await engine.processStep('enr-1', 1);

    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('09:00 UTC → inside window (at boundary)', async () => {
    setUTCTime(2026, 4, 15, 9, 0); // Wed 09:00

    setupFullProcessStep({ hasNextStep: false });
    await engine.processStep('enr-1', 1);

    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// processStep — Stagger
// ═════════════════════════════════════════════════════════════════════

describe('processStep — stagger delays', () => {
  it('first email (0 queued) → delay is 30-90s jitter only', async () => {
    setInsideWindow();

    setupFullProcessStep({ queuedCount: 0, hasNextStep: false });
    await engine.processStep('enr-1', 1);

    const sendCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'send-email');
    expect(sendCalls.length).toBe(1);
    const delay = sendCalls[0][2].delay;
    // 0 * 4min + 30-90s jitter = 30000-90000ms
    expect(delay).toBeGreaterThanOrEqual(30000);
    expect(delay).toBeLessThanOrEqual(91000);
  });

  it('10 already queued → delay is ~40min + jitter', async () => {
    setInsideWindow();

    setupFullProcessStep({ queuedCount: 10, hasNextStep: false });
    await engine.processStep('enr-1', 1);

    const sendCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'send-email');
    expect(sendCalls.length).toBe(1);
    const delay = sendCalls[0][2].delay;
    // 10 * 4min = 40min = 2400000ms, + 30-90s jitter
    expect(delay).toBeGreaterThanOrEqual(2400000 + 30000);
    expect(delay).toBeLessThanOrEqual(2400000 + 91000);
  });

  it('15 already queued → delay is ~60min + jitter (fills the hour)', async () => {
    setInsideWindow();

    setupFullProcessStep({ queuedCount: 15, hasNextStep: false });
    await engine.processStep('enr-1', 1);

    const sendCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'send-email');
    const delay = sendCalls[0][2].delay;
    // 15 * 4min = 60min = 3600000ms
    expect(delay).toBeGreaterThanOrEqual(3600000 + 30000);
    expect(delay).toBeLessThanOrEqual(3600000 + 91000);
  });
});

// ═════════════════════════════════════════════════════════════════════
// processStep — Deduplication
// ═════════════════════════════════════════════════════════════════════

describe('processStep — deduplication', () => {
  it('current_step >= stepNumber → skips (already processed)', async () => {
    setInsideWindow();

    // Enrollment already at step 1, trying to process step 1 again
    setupFullProcessStep({
      enrollment: { current_step: 1 },
    });
    await engine.processStep('enr-1', 1);

    // Should not create email or queue anything
    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);

    const sendCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'send-email');
    expect(sendCalls.length).toBe(0);
  });

  it('current_step > stepNumber → skips (step already passed)', async () => {
    setInsideWindow();

    // Enrollment at step 3, trying to process step 1 (very stale job)
    setupFullProcessStep({
      enrollment: { current_step: 3 },
    });
    await engine.processStep('enr-1', 1);

    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('current_step < stepNumber → processes normally', async () => {
    setInsideWindow();

    setupFullProcessStep({
      enrollment: { current_step: 0 },
      hasNextStep: false,
    });
    await engine.processStep('enr-1', 1);

    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// processStep — Edge cases
// ═════════════════════════════════════════════════════════════════════

describe('processStep — guard clauses', () => {
  it('enrollment not found → returns without error', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM sequence_enrollments WHERE id': [],
    });

    // Should not throw
    await engine.processStep('nonexistent', 1);

    // Nothing should be queued
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enrollment status is cancelled → skips', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM sequence_enrollments WHERE id': [
        makeEnrollment({ status: 'cancelled' }),
      ],
    });

    await engine.processStep('enr-1', 1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('sequence status is paused → skips', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM sequence_enrollments WHERE id': [makeEnrollment()],
      'FROM sequences WHERE id': [makeSequence({ status: 'paused' })],
    });

    await engine.processStep('enr-1', 1);
    // No email_sends insert
    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('no more steps → marks enrollment completed', async () => {
    setInsideWindow();

    const enrollment = makeEnrollment({ current_step: 0 });
    const sequence = makeSequence();

    setupQueryResponses(mockQuery, {
      'FROM sequence_enrollments WHERE id': [enrollment],
      'FROM sequences WHERE id': [sequence],
      // No step found for this step_number
      'FROM sequence_steps WHERE sequence_id': [],
    });

    await engine.processStep('enr-1', 1);

    // Should update enrollment to completed
    const updateCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes("SET status = 'completed'")
    );
    expect(updateCalls.length).toBe(1);
  });

  it('no sending account available → reschedules in 1 hour', async () => {
    setInsideWindow();

    (gmailClient.getBestSendingAccount as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);

    setupQueryResponses(mockQuery, {
      'FROM sequence_enrollments WHERE id': [makeEnrollment()],
      'FROM sequences WHERE id': [makeSequence()],
      'FROM sequence_steps WHERE sequence_id': [makeStep()],
      'FROM contacts WHERE id': [makeContact()],
      'FROM templates WHERE id': [makeTemplate()],
    });

    await engine.processStep('enr-1', 1);

    const stepCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'process-step');
    expect(stepCalls.length).toBe(1);
    expect(stepCalls[0][2].delay).toBe(60 * 60 * 1000); // 1 hour
  });
});

// ═════════════════════════════════════════════════════════════════════
// enrollContact — bounced/unsubscribed guards
// ═════════════════════════════════════════════════════════════════════

describe('enrollContact — guards', () => {
  it('bounced contact → throws', async () => {
    setupQueryResponses(mockQuery, {
      'FROM contacts WHERE id': [makeContact({ tags: ['bounced'] })],
    });

    await expect(
      engine.enrollContact('seq-1', 'contact-1')
    ).rejects.toThrow('Contact email has bounced');
  });

  it('unsubscribed contact → throws', async () => {
    setupQueryResponses(mockQuery, {
      'FROM contacts WHERE id': [makeContact({ tags: ['unsubscribed'] })],
    });

    await expect(
      engine.enrollContact('seq-1', 'contact-1')
    ).rejects.toThrow('Contact has unsubscribed');
  });
});

// ═════════════════════════════════════════════════════════════════════
// scheduleStep — no jobId (regression: jobId collision)
// ═════════════════════════════════════════════════════════════════════

describe('scheduleStep — no jobId collision', () => {
  it('does not use jobId (prevents completed-job collision)', async () => {
    await engine.scheduleStep('enr-1', 1, 5000);

    const calls = mockQueueAdd.mock.calls;
    expect(calls.length).toBe(1);
    const [name, data, opts] = calls[0];
    expect(name).toBe('process-step');
    expect(data).toEqual({ enrollmentId: 'enr-1', stepNumber: 1 });
    expect(opts.delay).toBe(5000);
    // Must NOT have a jobId
    expect(opts.jobId).toBeUndefined();
  });

  it('two scheduleStep calls for the same step → both succeed', async () => {
    await engine.scheduleStep('enr-1', 1, 0);
    await engine.scheduleStep('enr-1', 1, 60000);

    // Both should go through — dedup happens in processStep
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });
});
