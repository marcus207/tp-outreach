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
 */
import { query, TENANT } from '../db/connection';

export type SendDecision =
  | { action: 'send' }
  | { action: 'skip'; reason: string }   // Leave as 'queued' — retry later (e.g. paused, outside window)
  | { action: 'fail'; reason: string };   // Mark as 'failed' — permanent (e.g. unsubscribed, cancelled)

interface EmailSendRow {
  id: string;
  status: string;
  enrollment_id: string | null;
  contact_id: string;
  email_account_id: string;
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
    `SELECT id, status, enrollment_id, contact_id, email_account_id
     FROM email_sends WHERE id = $1 AND tenant = $2`,
    [emailSendId, TENANT]
  );

  const send = sendResult.rows[0];
  if (!send) {
    return { action: 'fail', reason: 'Email send record not found' };
  }

  // 2. Idempotency — already processed?
  if (send.status !== 'queued') {
    return { action: 'skip', reason: `Status is '${send.status}', not queued` };
  }

  // 3. Enrollment + sequence checks (only for sequence emails)
  if (send.enrollment_id) {
    const checkResult = await query<{
      enrollment_status: string;
      sequence_status: string;
      send_window_start: string;
      send_window_end: string;
      skip_weekends: boolean;
    }>(
      `SELECT se.status as enrollment_status, s.status as sequence_status,
              s.send_window_start, s.send_window_end, s.skip_weekends
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.id = $1 AND se.tenant = $2`,
      [send.enrollment_id, TENANT]
    );

    const row = checkResult.rows[0];
    if (!row || row.enrollment_status !== 'active') {
      return { action: 'fail', reason: 'Enrollment cancelled' };
    }
    if (row.sequence_status === 'paused') {
      return { action: 'skip', reason: 'Sequence is paused' };
    }

    // Send window (sequence-specific settings)
    if (checkWindow) {
      const windowResult = checkSendWindow(
        row.send_window_start || '09:00',
        row.send_window_end || '17:00',
        row.skip_weekends,
      );
      if (windowResult) return windowResult;
    }
  } else if (checkWindow) {
    // Broadcast/campaign emails — read window from settings, fall back to 08:00-18:00
    const windowSettings = await query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN ('send_window_start', 'send_window_end', 'skip_weekends')`
    );
    const sm: Record<string, string> = {};
    for (const s of windowSettings.rows) sm[s.key] = String(s.value);
    const windowResult = checkSendWindow(
      sm.send_window_start || '08:00',
      sm.send_window_end || '18:00',
      sm.skip_weekends === 'true',
    );
    if (windowResult) return windowResult;
  }

  // 4. Contact unsubscribed / bounced?
  const contactCheck = await query<{ tags: string[]; email: string }>(
    `SELECT tags, email FROM contacts WHERE id = $1 AND tenant = $2`,
    [send.contact_id, TENANT]
  );
  const tags = contactCheck.rows[0]?.tags || [];
  if (tags.includes('unsubscribed')) {
    return { action: 'fail', reason: 'Unsubscribed' };
  }
  if (tags.includes('bounced')) {
    return { action: 'fail', reason: 'Contact bounced' };
  }

  // 4b. Permanent suppression list (survives contact deletion + re-import).
  // Matches on exact email OR on the domain, so a whole domain can be blocked.
  if (contactCheck.rows[0]?.email) {
    const em = contactCheck.rows[0].email;
    const dom = (em.split('@')[1] || '').toLowerCase();
    const suppressed = await query<{ id: string }>(
      `SELECT id FROM suppressed_emails
       WHERE tenant = $2 AND (LOWER(email) = LOWER($1) OR LOWER(domain) = $3)
       LIMIT 1`,
      [em, TENANT, dom]
    );
    if (suppressed.rows.length > 0) {
      return { action: 'fail', reason: 'Permanently suppressed' };
    }
  }

  // 5. Email account still active?
  const accountCheck = await query<{ is_active: boolean; sends_today: number; daily_limit: number; sends_this_hour: number; hourly_limit: number }>(
    `SELECT is_active, sends_today, daily_limit, sends_this_hour, hourly_limit
     FROM email_accounts WHERE id = $1 AND tenant = $2`,
    [send.email_account_id, TENANT]
  );
  const account = accountCheck.rows[0];
  if (!account || !account.is_active) {
    return { action: 'fail', reason: 'Email account inactive' };
  }

  // 6. Rate limits
  if (account.sends_today >= account.daily_limit) {
    return { action: 'skip', reason: 'Daily send limit reached' };
  }
  if (account.sends_this_hour >= account.hourly_limit) {
    return { action: 'skip', reason: 'Hourly send limit reached' };
  }

  return { action: 'send' };
}

export function checkSendWindow(
  windowStart: string,
  windowEnd: string,
  skipWeekends: boolean,
): SendDecision | null {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const [startH, startM] = windowStart.split(':').map(Number);
  const [endH, endM] = windowEnd.split(':').map(Number);
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const isWeekend = skipWeekends && (dayOfWeek === 0 || dayOfWeek === 6);
  const outsideWindow = currentMinutes < startH * 60 + startM || currentMinutes >= endH * 60 + endM;

  if (isWeekend || outsideWindow) {
    return { action: 'skip', reason: `Outside send window (${windowStart}-${windowEnd})` };
  }
  return null; // Inside window — ok to proceed
}
