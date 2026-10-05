/**
 * Outreach circuit breaker (tp tenant).
 *
 * Every 15 minutes (worker.ts) evaluate() looks at the last 7 days AND the
 * last 24 hours of sends, per active account and overall, and trips when:
 *   - hard-bounce rate   bounced / (sent + bounced)                 > 2%
 *   - unsubscribe rate   unsubscribe events / (sent + bounced)      > 1%
 *     (Gmail gives us no complaint feed, so unsubscribes are the proxy)
 *   - infra failure rate infra-failed / (sent + bounced + infra-failed) > 5%
 *     (policy blocks from send-gate such as 'Contact on hold' or
 *      'Permanently suppressed' are NOT infrastructure failures)
 *   - any auth error (invalid_grant / Invalid Credentials) in the last 24h
 *     trips that account.
 * Rate checks only apply once a window has >= minSample sends (default 20).
 *
 * Tripping an account sets daily_limit = hourly_limit = broadcast_hourly_limit
 * = 0. The previous limits are saved to settings key
 * `circuit_breaker_prev_limits:<account_id>` so they can be restored MANUALLY.
 * An overall trip zeroes every tp account. The breaker never raises limits.
 * Alerts go to BRAND_EMAIL (marcus@) through the same internal Gmail path as
 * the daily health report, at most once per 24h per account (or overall).
 */
import { google } from 'googleapis';
import { query, TENANT, BRAND_NAME, BRAND_EMAIL } from '../db/connection';

// ── Types ───────────────────────────────────────────────────────────────

export interface Thresholds {
  bounceRate: number;        // fraction, e.g. 0.02
  unsubscribeRate: number;   // fraction, e.g. 0.01
  infraFailureRate: number;  // fraction, e.g. 0.05
  minSample: number;         // sends required before rate checks apply
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  bounceRate: 0.02,
  unsubscribeRate: 0.01,
  infraFailureRate: 0.05,
  minSample: 20,
};

export type WindowName = '7d' | '24h';

export interface WindowStats {
  sent: number;
  bounced: number;
  unsubscribed: number;
  infraFailed: number;
  authErrors: number; // only meaningful for the 24h window
}

export interface AccountRow {
  id: string;
  email: string;
  daily_limit: number;
  hourly_limit: number;
  broadcast_hourly_limit: number;
}

export interface TripReason {
  scope: 'account' | 'overall';
  accountId: string | null;
  accountEmail: string | null;
  window: WindowName;
  metric: 'bounce_rate' | 'unsubscribe_rate' | 'infra_failure_rate' | 'auth_error';
  value: number;
  threshold: number;
  sample: number;
}

export interface EvaluateResult {
  enabled: boolean;
  thresholds: Thresholds;
  trips: TripReason[];
  accountsZeroed: string[];
  alertsSent: string[];
  stats: {
    accounts: Record<string, { email: string; '7d': WindowStats; '24h': WindowStats }>;
    overall: { '7d': WindowStats; '24h': WindowStats };
  };
}

// ── Failure classification ──────────────────────────────────────────────

/**
 * error_message values written by policy decisions (send-gate.ts canSend,
 * send-queue.ts, daily-planner.ts, suppression paths). These are the system
 * correctly REFUSING to send, not infrastructure failing to send.
 */
export const POLICY_BLOCK_PATTERNS: RegExp[] = [
  /^Email send record not found/i,
  /^Enrollment cancelled/i,
  /^Contact not found in tenant/i,
  /^Unsubscribed/i,
  /^Contact bounced/i,
  /^Permanently suppressed/i,
  /^Suppressed/i,
  /^Contact is a lender/i,
  /^Contact on hold/i,
  /^Email account inactive/i,
  /^Sender .* is not on /i,
  /^superseded \(stale queued\)/i,
  /^Daily send limit reached/i,
  /^Hourly send limit reached/i,
  /^Outside send window/i,
  /^Sequence is paused/i,
  /^SEND_MODE/i,
  /^dry[- ]?run/i,
];

export const AUTH_ERROR_PATTERNS: RegExp[] = [
  /invalid_grant/i,
  /Invalid Credentials/i,
  /Token has been expired or revoked/i,
];

export function isPolicyBlock(errorMessage: string | null | undefined): boolean {
  const msg = (errorMessage || '').trim();
  if (!msg) return false; // unexplained failure counts as infrastructure
  return POLICY_BLOCK_PATTERNS.some(re => re.test(msg));
}

export function isAuthError(errorMessage: string | null | undefined): boolean {
  const msg = errorMessage || '';
  return AUTH_ERROR_PATTERNS.some(re => re.test(msg));
}

// ── Thresholds ──────────────────────────────────────────────────────────

const THRESHOLD_KEYS: Record<keyof Thresholds, { setting: string; env: string }> = {
  bounceRate:       { setting: 'circuit_breaker_bounce_rate',        env: 'CIRCUIT_BREAKER_BOUNCE_RATE' },
  unsubscribeRate:  { setting: 'circuit_breaker_unsubscribe_rate',   env: 'CIRCUIT_BREAKER_UNSUBSCRIBE_RATE' },
  infraFailureRate: { setting: 'circuit_breaker_infra_failure_rate', env: 'CIRCUIT_BREAKER_INFRA_FAILURE_RATE' },
  minSample:        { setting: 'circuit_breaker_min_sample',         env: 'CIRCUIT_BREAKER_MIN_SAMPLE' },
};

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/"/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** settings table > env > default. Rates are fractions (0.02 = 2%). */
export async function getThresholds(): Promise<Thresholds> {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS };
  let settings: Record<string, unknown> = {};
  try {
    const r = await query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key = ANY($1)`,
      [Object.values(THRESHOLD_KEYS).map(k => k.setting)]
    );
    settings = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  } catch (err) {
    console.error('[Circuit Breaker] Could not read threshold settings:', (err as Error).message);
  }
  for (const [field, keys] of Object.entries(THRESHOLD_KEYS) as [keyof Thresholds, { setting: string; env: string }][]) {
    const fromSetting = toNumber(settings[keys.setting]);
    const fromEnv = toNumber(process.env[keys.env]);
    if (fromSetting !== null) t[field] = fromSetting;
    else if (fromEnv !== null) t[field] = fromEnv;
  }
  return t;
}

export function isCircuitBreakerEnabled(): boolean {
  return (process.env.CIRCUIT_BREAKER_ENABLED || '').trim().toLowerCase() !== 'false';
}

// ── Decision (pure) ─────────────────────────────────────────────────────

function emptyStats(): WindowStats {
  return { sent: 0, bounced: 0, unsubscribed: 0, infraFailed: 0, authErrors: 0 };
}

export function sumStats(list: WindowStats[]): WindowStats {
  return list.reduce((acc, s) => ({
    sent: acc.sent + s.sent,
    bounced: acc.bounced + s.bounced,
    unsubscribed: acc.unsubscribed + s.unsubscribed,
    infraFailed: acc.infraFailed + s.infraFailed,
    authErrors: acc.authErrors + s.authErrors,
  }), emptyStats());
}

/** Rate checks for one window of one scope. Auth errors handled separately. */
export function checkRates(
  s: WindowStats,
  t: Thresholds,
  base: Pick<TripReason, 'scope' | 'accountId' | 'accountEmail' | 'window'>
): TripReason[] {
  const trips: TripReason[] = [];
  const delivered = s.sent + s.bounced;
  const attempted = delivered + s.infraFailed;

  if (delivered >= t.minSample) {
    const bounceRate = s.bounced / delivered;
    if (bounceRate > t.bounceRate) {
      trips.push({ ...base, metric: 'bounce_rate', value: bounceRate, threshold: t.bounceRate, sample: delivered });
    }
    const unsubRate = s.unsubscribed / delivered;
    if (unsubRate > t.unsubscribeRate) {
      trips.push({ ...base, metric: 'unsubscribe_rate', value: unsubRate, threshold: t.unsubscribeRate, sample: delivered });
    }
  }
  if (attempted >= t.minSample) {
    const infraRate = s.infraFailed / attempted;
    if (infraRate > t.infraFailureRate) {
      trips.push({ ...base, metric: 'infra_failure_rate', value: infraRate, threshold: t.infraFailureRate, sample: attempted });
    }
  }
  return trips;
}

export function decideTrips(
  accounts: AccountRow[],
  perAccount: Record<string, { '7d': WindowStats; '24h': WindowStats }>,
  overall: { '7d': WindowStats; '24h': WindowStats },
  t: Thresholds
): TripReason[] {
  const trips: TripReason[] = [];
  for (const a of accounts) {
    const st = perAccount[a.id];
    if (!st) continue;
    for (const w of ['7d', '24h'] as WindowName[]) {
      trips.push(...checkRates(st[w], t, { scope: 'account', accountId: a.id, accountEmail: a.email, window: w }));
    }
    if (st['24h'].authErrors > 0) {
      trips.push({
        scope: 'account', accountId: a.id, accountEmail: a.email, window: '24h',
        metric: 'auth_error', value: st['24h'].authErrors, threshold: 0, sample: st['24h'].authErrors,
      });
    }
  }
  for (const w of ['7d', '24h'] as WindowName[]) {
    trips.push(...checkRates(overall[w], t, { scope: 'overall', accountId: null, accountEmail: null, window: w }));
  }
  return trips;
}

// ── DB access ───────────────────────────────────────────────────────────

const INTERVALS: Record<WindowName, string> = { '7d': '7 days', '24h': '24 hours' };

/** Per-account stats for one window. Event time = sent_at, else claim time, else created_at. */
export async function loadWindowStats(window: WindowName): Promise<Record<string, WindowStats>> {
  const interval = INTERVALS[window];
  const out: Record<string, WindowStats> = {};
  const get = (id: string) => (out[id] ||= emptyStats());

  const sends = await query<{ email_account_id: string; status: string; error_message: string | null; n: string }>(
    `SELECT email_account_id, status,
            CASE WHEN status = 'failed' THEN error_message ELSE NULL END AS error_message,
            COUNT(*)::text AS n
     FROM email_sends
     WHERE tenant = $1
       AND status IN ('sent', 'bounced', 'failed')
       AND COALESCE(sent_at, last_enqueued_at, created_at) > NOW() - $2::interval
     GROUP BY 1, 2, 3`,
    [TENANT, interval]
  );
  for (const r of sends.rows) {
    const s = get(r.email_account_id);
    const n = Number(r.n) || 0;
    if (r.status === 'sent') s.sent += n;
    else if (r.status === 'bounced') s.bounced += n;
    else if (r.status === 'failed') {
      if (isAuthError(r.error_message)) s.authErrors += n;
      if (!isPolicyBlock(r.error_message)) s.infraFailed += n;
    }
  }

  // email_events has no tenant column: join email_sends
  const unsubs = await query<{ email_account_id: string; n: string }>(
    `SELECT es.email_account_id, COUNT(DISTINCT ev.email_send_id)::text AS n
     FROM email_events ev
     JOIN email_sends es ON es.id = ev.email_send_id
     WHERE es.tenant = $1
       AND ev.event_type = 'unsubscribe'
       AND ev.created_at > NOW() - $2::interval
     GROUP BY 1`,
    [TENANT, interval]
  );
  for (const r of unsubs.rows) get(r.email_account_id).unsubscribed += Number(r.n) || 0;

  return out;
}

async function getSetting<T = unknown>(key: string): Promise<{ value: T; updated_at: Date } | null> {
  const r = await query<{ value: T; updated_at: Date }>(
    `SELECT value, updated_at FROM settings WHERE key = $1`, [key]
  );
  return r.rows[0] || null;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

/**
 * Zero an account's limits. Saves the previous limits first (only when they
 * were non-zero, so a second trip never overwrites the real values with 0s).
 * Returns true if the account's limits actually changed.
 */
export async function zeroAccount(a: AccountRow, reasons: TripReason[]): Promise<boolean> {
  const hadLimits = a.daily_limit > 0 || a.hourly_limit > 0 || a.broadcast_hourly_limit > 0;
  if (!hadLimits) return false;
  await setSetting(`circuit_breaker_prev_limits:${a.id}`, {
    email: a.email,
    daily_limit: a.daily_limit,
    hourly_limit: a.hourly_limit,
    broadcast_hourly_limit: a.broadcast_hourly_limit,
    tripped_at: new Date().toISOString(),
    reasons,
  });
  // Only ever lowers: never sets a limit above its current value.
  await query(
    `UPDATE email_accounts
     SET daily_limit = 0, hourly_limit = 0, broadcast_hourly_limit = 0, updated_at = NOW()
     WHERE id = $1 AND tenant = $2`,
    [a.id, TENANT]
  );
  return true;
}

// ── Alerting (same mechanism as health-check.ts sendHealthReport) ──────

export type AlertSender = (subject: string, html: string, excludeAccountIds: string[]) => Promise<void>;

export const sendInternalAlert: AlertSender = async (subject, html, excludeAccountIds) => {
  const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
    `SELECT id, email, oauth_tokens FROM email_accounts
     WHERE tenant = $1 AND is_active = true AND oauth_tokens != '{}'::jsonb
       AND NOT (id = ANY($2::uuid[]))
     ORDER BY email LIMIT 1`,
    [TENANT, excludeAccountIds]
  );
  const account = accountResult.rows[0];
  if (!account) throw new Error('No connected account to send circuit-breaker alert from');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const raw = [
    `To: ${BRAND_EMAIL}`,
    `From: ${BRAND_NAME} Outreach <${account.email}>`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    html,
  ].join('\n');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') } });
};

const ALERT_INTERVAL_MS = 24 * 3600 * 1000;

function fmtReason(r: TripReason): string {
  const who = r.scope === 'overall' ? 'ALL ACCOUNTS' : r.accountEmail;
  if (r.metric === 'auth_error') return `${who}: ${r.value} auth error(s) (invalid_grant / Invalid Credentials) in last 24h`;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return `${who}: ${r.metric.replace(/_/g, ' ')} ${pct(r.value)} over ${r.window} (threshold ${pct(r.threshold)}, sample ${r.sample})`;
}

function buildAlertHtml(trips: TripReason[], zeroed: AccountRow[]): string {
  const items = trips.map(r => `<li>${fmtReason(r)}</li>`).join('');
  const zeroedList = zeroed.length
    ? `<p>Limits set to 0 for: ${zeroed.map(a => `${a.email} (was ${a.daily_limit}/day, ${a.hourly_limit}/hr)`).join(', ')}.</p>`
    : '<p>All affected accounts were already at 0 limits; no change made.</p>';
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<h2 style="color:#b00020">Outreach circuit breaker tripped</h2>
<ul>${items}</ul>
${zeroedList}
<p>Previous limits are stored in settings under <code>circuit_breaker_prev_limits:&lt;account_id&gt;</code>.
Limits are never raised automatically. Investigate, then restore manually.</p>
</body></html>`;
}

// ── Main entry point ────────────────────────────────────────────────────

export async function evaluate(
  opts: { sendAlert?: AlertSender; now?: Date } = {}
): Promise<EvaluateResult> {
  const sendAlert = opts.sendAlert ?? sendInternalAlert;
  const now = opts.now ?? new Date();
  const thresholds = await getThresholds();
  const result: EvaluateResult = {
    enabled: isCircuitBreakerEnabled(),
    thresholds,
    trips: [],
    accountsZeroed: [],
    alertsSent: [],
    stats: { accounts: {}, overall: { '7d': emptyStats(), '24h': emptyStats() } },
  };
  if (!result.enabled) return result;

  const accountsRes = await query<AccountRow>(
    `SELECT id, email, daily_limit, hourly_limit, broadcast_hourly_limit
     FROM email_accounts WHERE tenant = $1 ORDER BY email`,
    [TENANT]
  );
  const allAccounts = accountsRes.rows;
  const activeRes = await query<{ id: string }>(
    `SELECT id FROM email_accounts WHERE tenant = $1 AND is_active = true`,
    [TENANT]
  );
  const activeIds = new Set(activeRes.rows.map(r => r.id));
  const activeAccounts = allAccounts.filter(a => activeIds.has(a.id));

  const s7 = await loadWindowStats('7d');
  const s24 = await loadWindowStats('24h');

  const perAccount: Record<string, { '7d': WindowStats; '24h': WindowStats }> = {};
  for (const a of activeAccounts) {
    perAccount[a.id] = { '7d': s7[a.id] || emptyStats(), '24h': s24[a.id] || emptyStats() };
    result.stats.accounts[a.id] = { email: a.email, ...perAccount[a.id] };
  }
  // Overall covers every send in the tenant, including inactive accounts' recent sends
  const overall = { '7d': sumStats(Object.values(s7)), '24h': sumStats(Object.values(s24)) };
  result.stats.overall = overall;

  const trips = decideTrips(activeAccounts, perAccount, overall, thresholds);
  result.trips = trips;
  if (trips.length === 0) return result;

  // Group trips into scopes: 'overall' or account id
  const overallTrips = trips.filter(t => t.scope === 'overall');
  const byAccount = new Map<string, TripReason[]>();
  for (const t of trips) {
    if (t.scope === 'account' && t.accountId) {
      byAccount.set(t.accountId, [...(byAccount.get(t.accountId) || []), t]);
    }
  }

  const scopes: { key: string; reasons: TripReason[]; targets: AccountRow[] }[] = [];
  if (overallTrips.length) scopes.push({ key: 'overall', reasons: overallTrips, targets: allAccounts });
  for (const [id, reasons] of byAccount) {
    const acct = allAccounts.find(a => a.id === id);
    if (acct) scopes.push({ key: id, reasons, targets: [acct] });
  }

  const zeroedIds = new Set<string>();
  const authFailedIds = trips.filter(t => t.metric === 'auth_error' && t.accountId).map(t => t.accountId as string);

  for (const scope of scopes) {
    const zeroedHere: AccountRow[] = [];
    for (const acct of scope.targets) {
      if (zeroedIds.has(acct.id)) continue;
      try {
        if (await zeroAccount(acct, scope.reasons)) {
          zeroedIds.add(acct.id);
          zeroedHere.push(acct);
          console.warn(`[Circuit Breaker] Zeroed limits for ${acct.email} (${scope.key})`);
        }
      } catch (err) {
        console.error(`[Circuit Breaker] Failed to zero ${acct.email}:`, (err as Error).message);
      }
    }

    // Idempotent alerting: once per 24h per scope, unless limits just changed
    const alertKey = `circuit_breaker_last_alert:${scope.key}`;
    const last = await getSetting<{ at?: string }>(alertKey);
    const lastAt = last?.value?.at ? new Date(last.value.at).getTime() : 0;
    const due = zeroedHere.length > 0 || now.getTime() - lastAt >= ALERT_INTERVAL_MS;
    if (!due) continue;

    await setSetting('circuit_breaker_last_trip', {
      at: now.toISOString(),
      scope: scope.key,
      reasons: scope.reasons,
      zeroed: zeroedHere.map(a => a.email),
    });

    const subject = `[${BRAND_NAME}] OUTREACH CIRCUIT BREAKER TRIPPED: ${
      scope.key === 'overall' ? 'all accounts' : scope.targets[0].email}`;
    try {
      await sendAlert(subject, buildAlertHtml(scope.reasons, zeroedHere), authFailedIds);
      await setSetting(alertKey, { at: now.toISOString(), reasons: scope.reasons });
      result.alertsSent.push(scope.key);
    } catch (err) {
      // Not recorded, so the next run retries the alert
      console.error('[Circuit Breaker] Alert send failed:', (err as Error).message);
    }
  }

  result.accountsZeroed = allAccounts.filter(a => zeroedIds.has(a.id)).map(a => a.email);
  return result;
}
