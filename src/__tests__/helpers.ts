/**
 * Shared test helpers: mock factories, DB mock utilities, clock control.
 */
import { vi } from 'vitest';
import type {
  Sequence,
  SequenceStep,
  SequenceEnrollment,
  Contact,
  Template,
  EmailAccount,
} from '../types';

// ── Fixture factories ────────────────────────────────────────────────

export function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq-1',
    name: 'Test Sequence',
    description: null,
    status: 'active',
    sending_account_ids: ['acct-1'],
    send_window_start: '09:00',
    send_window_end: '17:00',
    skip_weekends: true,
    daily_send_limit: null,
    stop_on_reply: true,
    stop_on_open: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeStep(overrides: Partial<SequenceStep> = {}): SequenceStep {
  return {
    id: 'step-1',
    sequence_id: 'seq-1',
    step_number: 1,
    template_id: 'tpl-1',
    delay_days: 0,
    delay_hours: 0,
    step_type: 'email',
    variant_template_id: null,
    variant_split: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeEnrollment(overrides: Partial<SequenceEnrollment> = {}): SequenceEnrollment {
  return {
    id: 'enr-1',
    sequence_id: 'seq-1',
    contact_id: 'contact-1',
    status: 'active',
    current_step: 0,
    enrolled_at: new Date(),
    completed_at: null,
    replied_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    apollo_id: null,
    email: 'test@example.com',
    first_name: 'John',
    last_name: 'Smith',
    title: 'CFO',
    company: 'Acme Corp',
    company_domain: 'acme.com',
    linkedin_url: null,
    phone: null,
    city: 'London',
    country: 'UK',
    tags: [],
    custom_fields: {},
    email_verified: true,
    source: 'manual',
    last_synced_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    subject: 'Hello {{first_name}}',
    body_html: '<p>Hello {{first_name}}</p>',
    body_text: null,
    merge_fields: ['first_name'],
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: 'acct-1',
    email: 'outreach@go.tp.finance',
    display_name: 'Test Support',
    oauth_tokens: { access_token: 'x', refresh_token: 'y' },
    daily_limit: 80,
    hourly_limit: 15,
    sends_today: 0,
    sends_this_hour: 0,
    last_send_at: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ── DB mock helper ───────────────────────────────────────────────────

/**
 * Configure the mock query function to return specific rows based on
 * SQL pattern matching.  Patterns are matched with `sql.includes(pattern)`.
 *
 * Usage:
 *   setupQueryResponses(mockQuery, {
 *     'FROM sequence_enrollments': [makeEnrollment()],
 *     'FROM sequences': [makeSequence()],
 *   });
 */
export function setupQueryResponses(
  mockQuery: ReturnType<typeof vi.fn>,
  responses: Record<string, unknown[]>
) {
  mockQuery.mockImplementation((sql: string) => {
    for (const [pattern, rows] of Object.entries(responses)) {
      if (sql.includes(pattern)) {
        return Promise.resolve({ rows, rowCount: rows.length });
      }
    }
    // Default: empty result
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

// ── Time helpers ─────────────────────────────────────────────────────

/** Set fake clock to a specific UTC time.  Returns the Date. */
export function setUTCTime(
  year: number, month: number, day: number,
  hour: number, minute: number
): Date {
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  vi.setSystemTime(d);
  return d;
}

// The send window is Mon-Fri 08:00-17:00 Europe/London (send-gate.ts).
// April 2026 dates below are in BST (UTC+1).

/** Wednesday 14:30 UTC (15:30 BST) — inside the window */
export function setInsideWindow(): Date {
  return setUTCTime(2026, 4, 15, 14, 30); // Wed Apr 15
}

/** Tuesday 22:00 UTC (23:00 BST) — outside the window */
export function setOutsideWindow(): Date {
  return setUTCTime(2026, 4, 14, 22, 0); // Tue Apr 14
}

/** Saturday 10:00 UTC — weekend, inside window hours */
export function setWeekend(): Date {
  return setUTCTime(2026, 4, 18, 10, 0); // Sat Apr 18
}
