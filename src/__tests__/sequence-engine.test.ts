/**
 * Tests for SequenceEngine — the core email scheduling pipeline.
 *
 * Every bug that shipped in production is captured here so it can
 * never regress:
 *   - Emails sent outside the send window (Mon-Fri 08:00-17:00 Europe/London)
 *   - Duplicate emails from BullMQ job collisions
 *   - Lenders / hold / suppressed / cross-tenant contacts being enrolled
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
  BULL_PREFIX: 'bull-test-tenant',
}));

vi.mock('../services/gmail-client', () => ({
  gmailClient: {
    reserveSendingAccount: vi.fn(),
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

import { SequenceEngine, EnrollmentRefusedError } from '../services/sequence-engine';
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
  hasNextStep?: boolean;
} = {}) {
  const enrollment = makeEnrollment(overrides.enrollment);
  const sequence = makeSequence(overrides.sequence);
  const step = makeStep(overrides.step);
  const contact = makeContact(overrides.contact);
  const template = makeTemplate(overrides.template);
  const account = makeAccount(overrides.account);

  (gmailClient.reserveSendingAccount as ReturnType<typeof vi.fn>)
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
  it('outside window (22:00 UTC / 23:00 BST) → reschedules, does NOT create email_sends', async () => {
    setOutsideWindow(); // Tue 22:00 UTC

    const { enrollment } = setupFullProcessStep();

    await engine.processStep(enrollment.id, 1);

    // Should schedule a retry (reschedule to tomorrow 08:00 London = 07:00 UTC)
    const stepQueueCalls = mockQueueAdd.mock.calls.filter(
      (c) => c[0] === 'process-step'
    );
    expect(stepQueueCalls.length).toBe(1);
    const [, , opts] = stepQueueCalls[0];
    expect(opts.delay).toBe(9 * 60 * 60 * 1000);

    // Should NOT have created an email_sends record
    const insertCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('Saturday → reschedules to Monday 08:00 London (even if sequence skip_weekends=false)', async () => {
    setWeekend(); // Sat 10:00 UTC

    setupFullProcessStep({ sequence: { skip_weekends: false } });

    await engine.processStep('enr-1', 1);

    const stepCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'process-step');
    expect(stepCalls.length).toBe(1);
    // Sat 10:00 UTC → Mon 07:00 UTC (08:00 BST) = 45 hours
    expect(stepCalls[0][2].delay).toBe(45 * 60 * 60 * 1000);

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

  it('06:59 UTC (07:59 BST) → outside window (before start)', async () => {
    setUTCTime(2026, 4, 15, 6, 59); // Wed

    setupFullProcessStep();
    await engine.processStep('enr-1', 1);

    // Should reschedule, not send
    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('16:00 UTC (17:00 BST) → outside window (at boundary, window uses <)', async () => {
    setUTCTime(2026, 4, 15, 16, 0); // Wed

    setupFullProcessStep();
    await engine.processStep('enr-1', 1);

    const insertCalls = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    );
    expect(insertCalls.length).toBe(0);
  });

  it('07:00 UTC (08:00 BST) → inside window (at boundary)', async () => {
    setUTCTime(2026, 4, 15, 7, 0); // Wed

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

describe('processStep — send job', () => {
  it('queues the send with a 5-20s delay, threadId/fromName and preCounted', async () => {
    setInsideWindow();

    setupFullProcessStep({ hasNextStep: false });
    await engine.processStep('enr-1', 1);

    const sendCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'send-email');
    expect(sendCalls.length).toBe(1);
    const [, data, opts] = sendCalls[0];
    expect(data).toEqual({ emailSendId: 'send-1', threadId: undefined, fromName: 'Test Support', preCounted: true });
    expect(opts.delay).toBeGreaterThanOrEqual(5000);
    expect(opts.delay).toBeLessThanOrEqual(20000);
  });

  it('next step is scheduled inside the send window', async () => {
    setUTCTime(2026, 4, 17, 15, 0); // Fri 16:00 BST; next step +7 days = Fri 16:00 BST (inside)

    setupFullProcessStep({ hasNextStep: true });
    await engine.processStep('enr-1', 1);

    const stepCalls = mockQueueAdd.mock.calls.filter(c => c[0] === 'process-step');
    expect(stepCalls.length).toBe(1);
    expect(stepCalls[0][2].delay).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('processStep — recipient guards', () => {
  function insertCount() {
    return mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO email_sends')
    ).length;
  }

  it('lender contact → cancels enrollment, no email', async () => {
    setInsideWindow();
    setupFullProcessStep({ contact: { contact_type: 'lender' } as any, hasNextStep: false });
    await engine.processStep('enr-1', 1);

    expect(insertCount()).toBe(0);
    const cancel = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE sequence_enrollments') && (c[1] as unknown[])?.[0] === 'cancelled'
    );
    expect(cancel.length).toBe(1);
  });

  it('hold-tagged contact → no email, enrollment not cancelled', async () => {
    setInsideWindow();
    setupFullProcessStep({ contact: { tags: ['hold'] }, hasNextStep: false });
    await engine.processStep('enr-1', 1);

    expect(insertCount()).toBe(0);
    const cancel = mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && (c[1] as unknown[])?.[0] === 'cancelled'
    );
    expect(cancel.length).toBe(0);
  });

  it('suppressed contact → no email', async () => {
    setInsideWindow();
    setupFullProcessStep({ hasNextStep: false });
    const impl = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM suppressed_emails')) return Promise.resolve({ rows: [{ id: 's' }], rowCount: 1 });
      return impl(sql, params);
    });
    await engine.processStep('enr-1', 1);

    expect(insertCount()).toBe(0);
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

    (gmailClient.reserveSendingAccount as ReturnType<typeof vi.fn>)
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
  function setupEnroll(opts: {
    contact?: Record<string, unknown> | null;
    sequence?: boolean;
    suppressed?: boolean;
    existing?: { id: string; status: string }[];
  } = {}) {
    const contact = opts.contact === null
      ? []
      : [{ ...makeContact(), contact_type: 'developer', tenant: 'test-tenant', ...(opts.contact || {}) }];
    setupQueryResponses(mockQuery, {
      'FROM sequences WHERE id': opts.sequence === false ? [] : [makeSequence()],
      'FROM contacts WHERE id': contact,
      'FROM suppressed_emails': opts.suppressed ? [{ id: 'supp-1' }] : [],
      'FROM sequence_enrollments WHERE sequence_id': opts.existing || [],
      'INSERT INTO sequence_enrollments': [{ id: 'enr-new' }],
    });
  }

  function insertedEnrollments() {
    return mockQuery.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO sequence_enrollments')
    );
  }

  it('bounced contact → throws', async () => {
    setupEnroll({ contact: { tags: ['bounced'] } });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Contact email has bounced');
  });

  it('unsubscribed contact → throws', async () => {
    setupEnroll({ contact: { tags: ['unsubscribed'] } });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Contact has unsubscribed');
  });

  it('lender → refused with EnrollmentRefusedError', async () => {
    setupEnroll({ contact: { contact_type: 'lender' } });
    const p = engine.enrollContact('seq-1', 'contact-1');
    await expect(p).rejects.toThrow('Contact is a lender');
    await expect(p).rejects.toBeInstanceOf(EnrollmentRefusedError);
    expect(insertedEnrollments().length).toBe(0);
  });

  it('hold-tagged → refused', async () => {
    setupEnroll({ contact: { tags: ['hold'] } });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Contact is on hold');
  });

  it('internal @tp.finance lender/hold → allowed', async () => {
    setupEnroll({ contact: { email: 'marcus@tp.finance', contact_type: 'lender', tags: ['hold'] } });
    await expect(engine.enrollContact('seq-1', 'contact-1')).resolves.toBe('enr-new');
  });

  it('suppressed email → refused', async () => {
    setupEnroll({ suppressed: true });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Email is permanently suppressed');
  });

  it('contact in another tenant → refused', async () => {
    setupEnroll({ contact: { tenant: 'loan-intel' } });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Contact belongs to another tenant');
    expect(insertedEnrollments().length).toBe(0);
  });

  it('contact not found → refused', async () => {
    setupEnroll({ contact: null });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Contact not found');
  });

  it('sequence not in this tenant → refused', async () => {
    setupEnroll({ sequence: false });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('Sequence not found in this tenant');
  });

  it('already actively enrolled → throws the existing error', async () => {
    setupEnroll({ existing: [{ id: 'enr-1', status: 'active' }] });
    await expect(engine.enrollContact('seq-1', 'contact-1')).rejects.toThrow('already actively enrolled');
  });

  it('eligible contact → creates enrollment', async () => {
    setupEnroll();
    await expect(engine.enrollContact('seq-1', 'contact-1')).resolves.toBe('enr-new');
    expect(insertedEnrollments().length).toBe(1);
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
