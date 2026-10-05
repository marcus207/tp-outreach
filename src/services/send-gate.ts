/**
 * Centralised pre-send gate — the SINGLE place that decides whether an
 * email should be sent, skipped (retry later), or failed permanently.
 *
 * Called by:
 *   - SendQueue.processEmailSend()  — at actual send time
 *   - requeueStuckSends()           — before re-queuing orphaned jobs
 *
 * Why this exists: pre-send checks were scattered across processEmailSend,
 * processStep, requeueStuckSends, and campaignEngine.tick(). Bugs in one
 * path (e.g. missing sequence-pause check) caused overnight email blasts.
 * Now there is ONE set of checks, ONE place to fix.
 *
 * Also home to the ONE send window (Mon-Fri 08:00-17:00 Europe/London) used by
 * the gate, the hourly planner, the re-queue cron, the campaign engine and the
 * broadcast planner: isWithinSendWindow() / nextSendWindowStart().
 */
import { query, TENANT } from '../db/connection';

export type SendDecision =
  | { action: 'send' }
  | { action: 'skip'; reason: string }   // Leave as 'queued' — retry later (e.g. paused, outside window)
  // Mark as 'failed'. permanent=true means the RECIPIENT must never get this
  // sequence (unsubscribed, suppressed, lender...) so the enrollment should be
  // cancelled; permanent=false/undefined means the enrollment may be retried.
  | { action: 'fail'; reason: string; permanent?: boolean };

interface EmailSendRow {
  id: string;
  status: string;
  enrollment_id: string | null;
  contact_id: string | null;
  email_account_id: string;
  to_email: string | null;
}

// ── Send window: Mon-Fri 08:00-17:00 Europe/London ──────────────────────

export const SEND_WINDOW_TIMEZONE = 'Europe/London';
export const SEND_WINDOW_START_HOUR = 8;  // inclusive
export const SEND_WINDOW_END_HOUR = 17;   // exclusive

const londonFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: SEND_WINDOW_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number; // 0=Sun .. 6=Sat
}

function londonParts(date: Date): LocalParts {
  const p: Record<string, string> = {};
  for (const part of londonFormatter.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday] ?? 0,
  };
}

/** UTC instant for a London wall-clock time (safe for 08:00/17:00 — not near DST jumps). */
function londonWallTimeToDate(year: number, month: number, day: number, hour: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  const p = londonParts(new Date(guess));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asUtc - guess; // 0 in GMT, +1h in BST
  return new Date(guess - offsetMs);
}

/** True if `date` is Mon-Fri, 08:00 <= London local time < 17:00. */
export function isWithinSendWindow(date: Date = new Date()): boolean {
  const p = londonParts(date);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.hour >= SEND_WINDOW_START_HOUR && p.hour < SEND_WINDOW_END_HOUR;
}

/**
 * Earliest instant >= `date` that is inside the send window.
 * Returns `date` unchanged if it is already inside the window, otherwise the
 * start (08:00 London) of the next Mon-Fri window.
 */
export function nextSendWindowStart(date: Date = new Date()): Date {
  if (isWithinSendWindow(date)) return new Date(date);
  let p = londonParts(date);
  // Today's 08:00 if we're before the window on a weekday
  if (p.weekday >= 1 && p.weekday <= 5 && p.hour < SEND_WINDOW_START_HOUR) {
    return londonWallTimeToDate(p.year, p.month, p.day, SEND_WINDOW_START_HOUR);
  }
  // Otherwise walk forward day by day (noon UTC avoids any DST edge) to the next weekday
  let cursor = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0, 0));
  for (let i = 0; i < 8; i++) {
    cursor = new Date(cursor.getTime() + 86400000);
    p = londonParts(cursor);
    if (p.weekday >= 1 && p.weekday <= 5) {
      return londonWallTimeToDate(p.year, p.month, p.day, SEND_WINDOW_START_HOUR);
    }
  }
  return londonWallTimeToDate(p.year, p.month, p.day, SEND_WINDOW_START_HOUR);
}

/** Milliseconds until the current window closes (17:00 London); 0 if outside the window. */
export function msUntilSendWindowCloses(date: Date = new Date()): number {
  if (!isWithinSendWindow(date)) return 0;
  const p = londonParts(date);
  return londonWallTimeToDate(p.year, p.month, p.day, SEND_WINDOW_END_HOUR).getTime() - date.getTime();
}

// ── Recipient checks shared by gate / planner / enrolment ───────────────

/** Our own mailboxes — may bypass lender/hold checks (never suppression). */
/** Cold outreach may only leave from this domain; the root domain is for personal mail. */
export const COLD_SENDER_DOMAIN = (process.env.COLD_SENDER_DOMAIN || 'go.tp.finance').toLowerCase();

export function isColdSenderAddress(email: string | null | undefined): boolean {
  return (email || '').trim().toLowerCase().endsWith('@' + COLD_SENDER_DOMAIN);
}

export function isInternalAddress(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  return e.endsWith('@tp.finance') || e.endsWith('@go.tp.finance');
}

/**
 * Tenant-scoped suppression check.
 * Exact email match on ANY row; domain match ONLY on source='manual' rows that
 * have a domain (single-person suppressions often carry a domain too and must
 * not block colleagues).
 */
export async function isSuppressed(email: string | null | undefined): Promise<boolean> {
  const em = (email || '').trim().toLowerCase();
  if (!em) return false;
  const dom = em.split('@')[1] || '';
  const suppressed = await query<{ id: string }>(
    `SELECT id FROM suppressed_emails
     WHERE tenant = $2
       AND (LOWER(email) = $1
            OR (source = 'manual' AND domain IS NOT NULL AND domain <> '' AND LOWER(domain) = $3))
     LIMIT 1`,
    [em, TENANT, dom]
  );
  return suppressed.rows.length > 0;
}

/**
 * Decide whether emailSendId should be sent right now.
 *
 * @param emailSendId  UUID of the email_sends record
 * @param checkWindow  Whether to enforce send window (default true).
 *                     requeueStuckSends already has its own window guard,
 *                     so it passes false to avoid double-checking.
 */
export async function canSend(
  emailSendId: string,
  { checkWindow = true }: { checkWindow?: boolean } = {}
): Promise<SendDecision> {

  // 1. Fetch the email_sends record
  const sendResult = await query<EmailSendRow>(
    `SELECT id, status, enrollment_id, contact_id, email_account_id, to_email
     FROM email_sends WHERE id = $1 AND tenant = $2`,
    [emailSendId, TENANT]
  );

  const send = sendResult.rows[0];
  if (!send) {
    return { action: 'fail', reason: 'Email send record not found' };
  }

  // 2. Idempotency — already processed (or being processed: 'sending')?
  if (send.status !== 'queued') {
    return { action: 'skip', reason: `Status is '${send.status}', not queued` };
  }

  // 3. The single send window (Mon-Fri 08:00-17:00 Europe/London) for ALL sends
  if (checkWindow && !isWithinSendWindow(new Date())) {
    return { action: 'skip', reason: 'Outside send window (Mon-Fri 08:00-17:00 Europe/London)' };
  }

  // 4. Enrollment + sequence checks (only for sequence emails)
  if (send.enrollment_id) {
    const checkResult = await query<{
      enrollment_status: string;
      sequence_status: string;
    }>(
      `SELECT se.status as enrollment_status, s.status as sequence_status
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.id = $1 AND se.tenant = $2`,
      [send.enrollment_id, TENANT]
    );

    const row = checkResult.rows[0];
    if (!row || row.enrollment_status !== 'active') {
      return { action: 'fail', reason: 'Enrollment cancelled', permanent: true };
    }
    if (row.sequence_status === 'paused') {
      return { action: 'skip', reason: 'Sequence is paused' };
    }
  }

  // 5. Contact checks. Looks at the linked contact AND any contact in this
  // tenant with the same address, so sends with no contact_id (press releases)
  // are covered too.
  const toEmail = (send.to_email || '').trim();
  const contactCheck = await query<{ id: string; tags: string[] | null; email: string; contact_type: string | null }>(
    `SELECT id, tags, email, contact_type FROM contacts
     WHERE tenant = $2 AND (id = $1 OR ($3 <> '' AND LOWER(email) = LOWER($3)))`,
    [send.contact_id, TENANT, toEmail]
  );
  const contacts = contactCheck.rows;

  if (send.contact_id && !contacts.some(c => c.id === send.contact_id)) {
    // contact_id points at a deleted contact or one in another tenant
    return { action: 'fail', reason: 'Contact not found in tenant', permanent: true };
  }

  const allTags = contacts.flatMap(c => c.tags || []);
  if (allTags.includes('unsubscribed')) {
    return { action: 'fail', reason: 'Unsubscribed', permanent: true };
  }
  if (allTags.includes('bounced')) {
    return { action: 'fail', reason: 'Contact bounced', permanent: true };
  }

  // 6. Permanent suppression list (survives contact deletion + re-import).
  // Checked for EVERY send, by the actual recipient address (and the linked
  // contact's address if it differs).
  const addresses = new Set<string>();
  if (toEmail) addresses.add(toEmail.toLowerCase());
  for (const c of contacts) if (c.email) addresses.add(c.email.trim().toLowerCase());
  for (const addr of addresses) {
    if (await isSuppressed(addr)) {
      return { action: 'fail', reason: 'Permanently suppressed', permanent: true };
    }
  }

  // 7. Lender / hold — tp outreach never emails lenders. Internal mailboxes bypass.
  if (!isInternalAddress(toEmail)) {
    if (contacts.some(c => (c.contact_type || '').toLowerCase() === 'lender')) {
      return { action: 'fail', reason: 'Contact is a lender', permanent: true };
    }
    if (allTags.includes('hold')) {
      // Not permanent: the hold may be lifted, enrollment is retried later
      return { action: 'fail', reason: 'Contact on hold' };
    }
  }

  // 8. Email account still active?
  const accountCheck = await query<{ email: string; is_active: boolean; sends_today: number; daily_limit: number; sends_this_hour: number; hourly_limit: number }>(
    `SELECT email, is_active, sends_today, daily_limit, sends_this_hour, hourly_limit
     FROM email_accounts WHERE id = $1 AND tenant = $2`,
    [send.email_account_id, TENANT]
  );
  const account = accountCheck.rows[0];
  if (!account || !account.is_active) {
    return { action: 'fail', reason: 'Email account inactive' };
  }

  // 8b. External mail only from the cold-outreach domain, never the root domain
  if (!isInternalAddress(send.to_email) && !isColdSenderAddress(account.email)) {
    return { action: 'fail', reason: `Sender ${account.email} is not on ${COLD_SENDER_DOMAIN}` };
  }

  // 9. Rate limits
  if (account.sends_today >= account.daily_limit) {
    return { action: 'skip', reason: 'Daily send limit reached' };
  }
  if (account.sends_this_hour >= account.hourly_limit) {
    return { action: 'skip', reason: 'Hourly send limit reached' };
  }

  return { action: 'send' };
}

/**
 * @deprecated Use isWithinSendWindow(). Kept for existing callers; the
 * window arguments are ignored — there is ONE send window
 * (Mon-Fri 08:00-17:00 Europe/London).
 */
export function checkSendWindow(
  _windowStart?: string,
  _windowEnd?: string,
  _skipWeekends?: boolean,
): SendDecision | null {
  if (!isWithinSendWindow(new Date())) {
    return { action: 'skip', reason: 'Outside send window (Mon-Fri 08:00-17:00 Europe/London)' };
  }
  return null; // Inside window — ok to proceed
}
