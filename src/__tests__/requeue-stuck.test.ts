/**
 * Tests for requeueStuckSends — the safety net for orphaned BullMQ jobs.
 *
 * Regression tests:
 *   - Window guard: must NOT run outside 09:00-17:00 UTC Mon-Fri
 *     (running overnight caused hundreds of duplicate BullMQ jobs)
 *   - Stagger: re-queued sends spaced ~4 min apart
 *   - Enrollment check: inactive enrollments → mark failed, don't re-queue
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupQueryResponses,
  setInsideWindow, setOutsideWindow, setWeekend, setUTCTime,
} from './helpers';

// ── Module mocks (before imports) ───────────────────────────────────

const { mockQueueAdd, mockQueueClose, mockQuery, MockQueue } = vi.hoisted(() => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQuery = vi.fn();
  const MockQueue = vi.fn(function() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
    };
  });
  return { mockQueueAdd, mockQueueClose, mockQuery, MockQueue };
});

vi.mock('bullmq', () => ({
  Queue: MockQueue,
}));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  TENANT: 'test-tenant',
}));

// ── Import (after mocks) ───────────────────────────────────────────

import { requeueStuckSends } from '../services/requeue-stuck';

// ── Setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════
// Window guard — must not run outside 09:00-17:00 UTC Mon-Fri
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — window guard', () => {
  it('22:00 UTC Tuesday → returns 0, no DB queries', async () => {
    setOutsideWindow();
    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Saturday 10:00 → returns 0, no DB queries', async () => {
    setWeekend();
    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Sunday 12:00 → returns 0', async () => {
    setUTCTime(2026, 4, 19, 12, 0); // Sun Apr 19
    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('08:59 → returns 0 (before window start)', async () => {
    setUTCTime(2026, 4, 15, 8, 59); // Wed
    const result = await requeueStuckSends();
    expect(result).toBe(0);
  });

  it('17:00 → returns 0 (at window end boundary)', async () => {
    setUTCTime(2026, 4, 15, 17, 0); // Wed
    const result = await requeueStuckSends();
    expect(result).toBe(0);
  });

  it('09:00 → inside window, queries for stuck sends', async () => {
    setUTCTime(2026, 4, 15, 9, 0); // Wed
    setupQueryResponses(mockQuery, {
      'FROM email_sends': [],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(0);
    // Should have queried for stuck sends
    expect(mockQuery).toHaveBeenCalled();
  });

  it('14:30 → inside window, queries for stuck sends', async () => {
    setInsideWindow(); // Wed 14:30
    setupQueryResponses(mockQuery, {
      'FROM email_sends': [],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQuery).toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Re-queuing logic
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — re-queue + stagger', () => {
  it('no stuck sends → returns 0, no jobs added', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM email_sends': [],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('3 stuck campaign sends → re-queues all with 4-min stagger', async () => {
    setInsideWindow();

    setupQueryResponses(mockQuery, {
      'FROM email_sends': [
        { id: 'send-1', enrollment_id: null },
        { id: 'send-2', enrollment_id: null },
        { id: 'send-3', enrollment_id: null },
      ],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(3);
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);

    // First: 0 * 4min + 30-90s jitter
    const d0 = mockQueueAdd.mock.calls[0][2].delay;
    expect(d0).toBeGreaterThanOrEqual(30000);
    expect(d0).toBeLessThanOrEqual(91000);

    // Second: 1 * 4min (240000) + 30-90s jitter
    const d1 = mockQueueAdd.mock.calls[1][2].delay;
    expect(d1).toBeGreaterThanOrEqual(240000 + 30000);
    expect(d1).toBeLessThanOrEqual(240000 + 91000);

    // Third: 2 * 4min (480000) + 30-90s jitter
    const d2 = mockQueueAdd.mock.calls[2][2].delay;
    expect(d2).toBeGreaterThanOrEqual(480000 + 30000);
    expect(d2).toBeLessThanOrEqual(480000 + 91000);
  });

  it('closes the BullMQ queue after processing', async () => {
    setInsideWindow();
    setupQueryResponses(mockQuery, {
      'FROM email_sends': [{ id: 'send-1', enrollment_id: null }],
    });

    await requeueStuckSends();
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Enrollment checks
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — enrollment checks', () => {
  it('inactive enrollment → marks send as failed, does not re-queue', async () => {
    setInsideWindow();

    setupQueryResponses(mockQuery, {
      'FROM email_sends': [{ id: 'send-1', enrollment_id: 'enr-1' }],
      'se.status as enrollment_status': [{ enrollment_status: 'cancelled', sequence_status: 'active' }],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();

    // Should update to failed
    const failCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('UPDATE email_sends') &&
        (c[0] as string).includes('Enrollment no longer active')
    );
    expect(failCalls.length).toBe(1);
  });

  it('active enrollment + active sequence → re-queues normally', async () => {
    setInsideWindow();

    setupQueryResponses(mockQuery, {
      'FROM email_sends': [{ id: 'send-1', enrollment_id: 'enr-1' }],
      'se.status as enrollment_status': [{ enrollment_status: 'active', sequence_status: 'active' }],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('paused sequence → skips but does NOT mark as failed', async () => {
    setInsideWindow();

    setupQueryResponses(mockQuery, {
      'FROM email_sends': [{ id: 'send-1', enrollment_id: 'enr-1' }],
      'se.status as enrollment_status': [{ enrollment_status: 'active', sequence_status: 'paused' }],
    });

    const result = await requeueStuckSends();
    expect(result).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();

    // Must NOT mark as failed — sequence may be unpaused later
    const failCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'")
    );
    expect(failCalls.length).toBe(0);
  });

  it('mix: 1 active enrollment + 1 inactive + 1 campaign → re-queues 2', async () => {
    setInsideWindow();

    const stuckSends = [
      { id: 'send-1', enrollment_id: 'enr-active' },
      { id: 'send-2', enrollment_id: 'enr-cancelled' },
      { id: 'send-3', enrollment_id: null },
    ];

    // Need to handle two different enrollment lookups (now JOIN query)
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM email_sends')) {
        return Promise.resolve({ rows: stuckSends, rowCount: 3 });
      }
      if (sql.includes('se.status as enrollment_status')) {
        const id = params?.[0];
        if (id === 'enr-active') {
          return Promise.resolve({ rows: [{ enrollment_status: 'active', sequence_status: 'active' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [{ enrollment_status: 'cancelled', sequence_status: 'active' }], rowCount: 1 });
      }
      // UPDATE / default
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await requeueStuckSends();
    expect(result).toBe(2); // send-1 (active enrollment) + send-3 (campaign)
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });
});
