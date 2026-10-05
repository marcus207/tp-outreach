/**
 * Tests for requeueStuckSends — the safety net for orphaned BullMQ jobs.
 *
 * Regression tests:
 *   - Window guard: must NOT run outside Mon-Fri 08:00-17:00 Europe/London
 *     (running overnight caused hundreds of duplicate BullMQ jobs)
 *   - Only rows > 30 min past their scheduled time AND with no Redis job
 *   - Spacing: max(send_gap, 2-5 min random) between re-queued jobs
 *     (was 1s apart, collapsing planner jitter into bursts)
 *   - Payload: threadId + fromName carried (was lost on re-queue)
 *   - 'sending' rows are never re-sent; > 1h old → failed, unknown outcome
 *   - Gate failures update the enrollment (cancel or retry)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setInsideWindow, setOutsideWindow, setWeekend, setUTCTime,
} from './helpers';

// ── Module mocks (before imports) ───────────────────────────────────

const {
  mockQueueAdd, mockQueueClose, mockQueueGetJobs, mockQuery, MockQueue,
  mockHandleFailedSend, mockScheduleNextStep,
} = vi.hoisted(() => {
  const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQueueGetJobs = vi.fn().mockResolvedValue([]);
  const mockQuery = vi.fn();
  const mockHandleFailedSend = vi.fn().mockResolvedValue(undefined);
  const mockScheduleNextStep = vi.fn().mockResolvedValue(undefined);
  const MockQueue = vi.fn(function() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
      getJobs: mockQueueGetJobs,
    };
  });
  return {
    mockQueueAdd, mockQueueClose, mockQueueGetJobs, mockQuery, MockQueue,
    mockHandleFailedSend, mockScheduleNextStep,
  };
});

vi.mock('bullmq', () => ({
  Queue: MockQueue,
}));

vi.mock('../db/connection', () => ({
  query: mockQuery,
  TENANT: 'test-tenant',
  BULL_PREFIX: 'bull-test-tenant',
}));

vi.mock('../services/daily-planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/daily-planner')>();
  return {
    ...actual,
    dailyPlanner: {
      handleFailedSend: mockHandleFailedSend,
      scheduleNextStep: mockScheduleNextStep,
    },
  };
});

// ── Import (after mocks) ───────────────────────────────────────────

import { requeueStuckSends } from '../services/requeue-stuck';

// ── Helpers ─────────────────────────────────────────────────────────

interface Stuck {
  id: string;
  enrollment_id: string | null;
  display_name?: string | null;
  thread_id?: string | null;
}

/**
 * DB mock for requeueStuckSends + the real send-gate it calls.
 *  stuck          rows returned by the stuck-send SELECT
 *  enrollments    enrollment_id → { enrollment_status, sequence_status }
 *  crashed        rows returned by the 'sending' > 1h UPDATE
 *  gapMinutes     settings.send_gap_minutes
 */
function setupDb(opts: {
  stuck?: Stuck[];
  enrollments?: Record<string, { enrollment_status: string; sequence_status: string }>;
  crashed?: { id: string; enrollment_id: string | null }[];
  gapMinutes?: number;
} = {}) {
  const stuck = (opts.stuck || []).map(s => ({ display_name: null, thread_id: null, ...s }));
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const ok = (rows: unknown[]) => Promise.resolve({ rows, rowCount: rows.length });
    if (sql.includes("status = 'sending'") && sql.includes('RETURNING')) return ok(opts.crashed || []);
    if (sql.includes('es.broadcast_id IS NULL')) return ok(stuck);
    if (sql.includes("key = 'send_gap_minutes'")) {
      return ok(opts.gapMinutes !== undefined ? [{ value: String(opts.gapMinutes) }] : []);
    }
    // ── send-gate queries ──
    if (sql.includes('FROM email_sends WHERE id')) {
      const s = stuck.find(r => r.id === params?.[0]);
      return ok(s ? [{
        id: s.id, status: 'queued', enrollment_id: s.enrollment_id,
        contact_id: 'contact-1', email_account_id: 'acct-1', to_email: 'x@example.com',
      }] : []);
    }
    if (sql.includes('se.status as enrollment_status')) {
      const e = opts.enrollments?.[params?.[0] as string];
      return ok(e ? [e] : []);
    }
    if (sql.includes('FROM contacts')) {
      return ok([{ id: 'contact-1', tags: [], email: 'x@example.com', contact_type: 'developer' }]);
    }
    if (sql.includes('FROM email_accounts WHERE id')) {
      return ok([{ email: 'outreach@go.tp.finance', is_active: true, sends_today: 0, daily_limit: 80, sends_this_hour: 0, hourly_limit: 15 }]);
    }
    return ok([]);
  });
}

function sqlCalls(fragment: string) {
  return mockQuery.mock.calls.filter(
    (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes(fragment)
  );
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  // Default to inside the send window so results never depend on the wall clock;
  // window-guard tests override this explicitly.
  setInsideWindow();
  vi.clearAllMocks();
  mockQueueGetJobs.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════
// Window guard — Mon-Fri 08:00-17:00 Europe/London
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — window guard', () => {
  it('22:00 UTC Tuesday → returns 0, no DB queries', async () => {
    setOutsideWindow();
    expect(await requeueStuckSends()).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Saturday 10:00 → returns 0, no DB queries', async () => {
    setWeekend();
    expect(await requeueStuckSends()).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Sunday 12:00 → returns 0', async () => {
    setUTCTime(2026, 4, 19, 12, 0); // Sun Apr 19
    expect(await requeueStuckSends()).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('06:59 UTC in BST (07:59 London) → returns 0 (before window start)', async () => {
    setUTCTime(2026, 4, 15, 6, 59);
    expect(await requeueStuckSends()).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('16:00 UTC in BST (17:00 London) → returns 0 (window end boundary)', async () => {
    setUTCTime(2026, 4, 15, 16, 0);
    expect(await requeueStuckSends()).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('07:00 UTC in BST (08:00 London) → inside window, queries for stuck sends', async () => {
    setUTCTime(2026, 4, 15, 7, 0);
    setupDb();
    expect(await requeueStuckSends()).toBe(0);
    expect(sqlCalls('es.broadcast_id IS NULL').length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Selection: scheduled time + 30 min, not in Redis
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — selection', () => {
  it('only picks rows > 30 min past their scheduled time, excluding broadcasts', async () => {
    setInsideWindow();
    setupDb();
    await requeueStuckSends();

    const sql = sqlCalls('es.broadcast_id IS NULL')[0][0] as string;
    expect(sql).toContain("es.status = 'queued'");
    expect(sql).toContain("COALESCE(es.last_enqueued_at, es.created_at) < NOW() - INTERVAL '30 minutes'");
  });

  it('send that still has a job in Redis → not re-queued', async () => {
    setInsideWindow();
    setupDb({ stuck: [{ id: 'send-1', enrollment_id: null }, { id: 'send-2', enrollment_id: null }] });
    mockQueueGetJobs.mockResolvedValue([{ data: { emailSendId: 'send-1' } }]);

    const result = await requeueStuckSends();
    expect(result).toBe(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][1].emailSendId).toBe('send-2');
  });

  it('no stuck sends → returns 0, no jobs added', async () => {
    setInsideWindow();
    setupDb();
    expect(await requeueStuckSends()).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Re-queue spacing + payload
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — spacing + payload', () => {
  it('3 stuck sends → first after 30-90s, then 2-5 min apart (gap 1 min)', async () => {
    setInsideWindow();
    setupDb({
      stuck: [
        { id: 'send-1', enrollment_id: null },
        { id: 'send-2', enrollment_id: null },
        { id: 'send-3', enrollment_id: null },
      ],
      gapMinutes: 1,
    });

    expect(await requeueStuckSends()).toBe(3);
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);

    const delays = mockQueueAdd.mock.calls.map(c => c[2].delay as number);
    expect(delays[0]).toBeGreaterThanOrEqual(30000);
    expect(delays[0]).toBeLessThanOrEqual(90000);
    for (let i = 1; i < delays.length; i++) {
      const step = delays[i] - delays[i - 1];
      expect(step).toBeGreaterThanOrEqual(2 * 60 * 1000);
      expect(step).toBeLessThanOrEqual(5 * 60 * 1000);
    }
  });

  it('send_gap_minutes larger than 5 → used as spacing', async () => {
    setInsideWindow();
    setupDb({
      stuck: [{ id: 'send-1', enrollment_id: null }, { id: 'send-2', enrollment_id: null }],
      gapMinutes: 10,
    });

    await requeueStuckSends();
    const [d0, d1] = mockQueueAdd.mock.calls.map(c => c[2].delay as number);
    expect(d1 - d0).toBe(10 * 60 * 1000);
  });

  it('carries threadId and fromName in the job payload', async () => {
    setInsideWindow();
    setupDb({
      stuck: [{ id: 'send-1', enrollment_id: 'enr-1', thread_id: 'thr-9', display_name: 'Marcus Dean' }],
      enrollments: { 'enr-1': { enrollment_status: 'active', sequence_status: 'active' } },
    });

    await requeueStuckSends();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'send-email',
      { emailSendId: 'send-1', threadId: 'thr-9', fromName: 'Marcus Dean' },
      expect.objectContaining({ delay: expect.any(Number) })
    );
  });

  it('records the scheduled fire time in last_enqueued_at', async () => {
    setInsideWindow();
    setupDb({ stuck: [{ id: 'send-1', enrollment_id: null }] });

    await requeueStuckSends();
    const upd = sqlCalls('SET last_enqueued_at');
    expect(upd.length).toBe(1);
    expect(upd[0][1]).toEqual([mockQueueAdd.mock.calls[0][2].delay, 'send-1']);
  });

  it('does not schedule past the window close', async () => {
    setUTCTime(2026, 4, 15, 15, 58); // 16:58 London → 2 min left
    setupDb({
      stuck: [{ id: 'send-1', enrollment_id: null }, { id: 'send-2', enrollment_id: null }],
      gapMinutes: 1,
    });

    expect(await requeueStuckSends()).toBe(1);
  });

  it('closes the BullMQ queue after processing', async () => {
    setInsideWindow();
    setupDb({ stuck: [{ id: 'send-1', enrollment_id: null }] });
    await requeueStuckSends();
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Crash handling: 'sending' rows
// ═════════════════════════════════════════════════════════════════════

describe("requeueStuckSends — 'sending' rows", () => {
  it("marks 'sending' rows older than 1h as failed (unknown outcome), never re-sends", async () => {
    setInsideWindow();
    setupDb({ crashed: [{ id: 'send-c', enrollment_id: 'enr-1' }, { id: 'send-b', enrollment_id: null }] });

    await requeueStuckSends();

    const upd = sqlCalls("status = 'sending'")[0][0] as string;
    expect(upd).toContain("error_message = 'unknown outcome (crash)'");
    expect(upd).toContain("INTERVAL '1 hour'");
    // Enrollment advanced to next step (not retried) to avoid a duplicate
    expect(mockScheduleNextStep).toHaveBeenCalledWith('send-c');
    expect(mockScheduleNextStep).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Enrollment checks via the gate
// ═════════════════════════════════════════════════════════════════════

describe('requeueStuckSends — enrollment checks', () => {
  it('inactive enrollment → marks send failed, cancels enrollment, does not re-queue', async () => {
    setInsideWindow();
    setupDb({
      stuck: [{ id: 'send-1', enrollment_id: 'enr-1' }],
      enrollments: { 'enr-1': { enrollment_status: 'cancelled', sequence_status: 'active' } },
    });

    expect(await requeueStuckSends()).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();

    const failCalls = sqlCalls("SET status = 'failed'").filter(c => (c[1] as unknown[])[0] === 'Enrollment cancelled');
    expect(failCalls.length).toBe(1);
    expect(mockHandleFailedSend).toHaveBeenCalledWith('send-1', 'Enrollment cancelled', true);
  });

  it('active enrollment + active sequence → re-queues normally', async () => {
    setInsideWindow();
    setupDb({
      stuck: [{ id: 'send-1', enrollment_id: 'enr-1' }],
      enrollments: { 'enr-1': { enrollment_status: 'active', sequence_status: 'active' } },
    });

    expect(await requeueStuckSends()).toBe(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('paused sequence → skips but does NOT mark as failed', async () => {
    setInsideWindow();
    setupDb({
      stuck: [{ id: 'send-1', enrollment_id: 'enr-1' }],
      enrollments: { 'enr-1': { enrollment_status: 'active', sequence_status: 'paused' } },
    });

    expect(await requeueStuckSends()).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    const fails = sqlCalls("SET status = 'failed'").filter(c => !(c[0] as string).includes("status = 'sending'"));
    expect(fails.length).toBe(0);
  });

  it('mix: 1 active enrollment + 1 inactive + 1 campaign → re-queues 2', async () => {
    setInsideWindow();
    setupDb({
      stuck: [
        { id: 'send-1', enrollment_id: 'enr-active' },
        { id: 'send-2', enrollment_id: 'enr-cancelled' },
        { id: 'send-3', enrollment_id: null },
      ],
      enrollments: {
        'enr-active': { enrollment_status: 'active', sequence_status: 'active' },
        'enr-cancelled': { enrollment_status: 'cancelled', sequence_status: 'active' },
      },
    });

    expect(await requeueStuckSends()).toBe(2);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });
});
