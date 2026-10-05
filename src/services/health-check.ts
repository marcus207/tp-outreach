import { google } from 'googleapis';
import { query, pool, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';

interface HealthResult {
  name: string;
  ok: boolean;
  detail?: string;
}

interface OutreachStats {
  sent_yesterday: number;
  bounced_yesterday: number;
  failed_yesterday: number;
  replied_yesterday: number;
  avg_sends_per_hour: string;
  active_step_0: number;
  active_step_1: number;
  queued_now: number;
  total_active_enrollments: number;
  send_gap_minutes: number;
  daily_limit: number;
  hourly_limit: number;
}

interface OutOfWindowSend {
  sent_at: string;
  from_email: string;
  to_email: string;
  subject: string;
}

class HealthCheckService {
  async runAll(): Promise<HealthResult[]> {
    const results = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkGmailAccounts(),
      this.checkLastDigest(),
    ]);

    // Flatten (checkGmailAccounts returns multiple)
    return results.flat();
  }

  private async checkDatabase(): Promise<HealthResult> {
    try {
      await query('SELECT 1');
      const counts = await query<{ table_name: string; cnt: string }>(
        `SELECT 'contacts' AS table_name, COUNT(*)::text AS cnt FROM contacts
         UNION ALL SELECT 'email_sends', COUNT(*)::text FROM email_sends
         UNION ALL SELECT 'daily_digest', COUNT(*)::text FROM daily_digest`
      );
      const detail = counts.rows.map(r => `${r.table_name}: ${r.cnt}`).join(', ');
      return { name: 'PostgreSQL', ok: true, detail };
    } catch (err) {
      return { name: 'PostgreSQL', ok: false, detail: (err as Error).message };
    }
  }

  private async checkRedis(): Promise<HealthResult> {
    try {
      const Redis = (await import('ioredis')).default;
      const url = process.env.REDIS_URL || 'redis://localhost:6379';
      const redis = new Redis(url, { lazyConnect: true, connectTimeout: 3000 });
      await redis.connect();
      await redis.ping();
      await redis.quit();
      return { name: 'Redis', ok: true };
    } catch (err) {
      return { name: 'Redis', ok: false, detail: (err as Error).message };
    }
  }

  private async checkGmailAccounts(): Promise<HealthResult[]> {
    const accountsResult = await query<{ id: string; email: string; is_active: boolean; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, is_active, oauth_tokens FROM email_accounts WHERE tenant = $1 ORDER BY email`,
      [TENANT]
    );

    if (accountsResult.rows.length === 0) {
      return [{ name: 'Gmail Accounts', ok: false, detail: 'No accounts configured' }];
    }

    const results: HealthResult[] = [];

    for (const account of accountsResult.rows) {
      const hasTokens = account.oauth_tokens &&
        JSON.stringify(account.oauth_tokens) !== '{}' &&
        (account.oauth_tokens as { access_token?: string }).access_token;

      if (!hasTokens) {
        results.push({ name: `Gmail: ${account.email}`, ok: false, detail: 'No OAuth tokens' });
        continue;
      }

      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Lightweight check — get profile (doesn't count against send quota)
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const emailAddress = profile.data.emailAddress || account.email;
        results.push({ name: `Gmail: ${account.email}`, ok: true, detail: `Connected as ${emailAddress}` });
      } catch (err) {
        const msg = (err as Error).message;
        results.push({
          name: `Gmail: ${account.email}`,
          ok: false,
          detail: msg.includes('invalid_grant') ? 'Token expired — reconnect in Settings' : msg,
        });
      }
    }

    return results;
  }

  private async checkLastDigest(): Promise<HealthResult> {
    try {
      const result = await query<{ digest_date: string; status: string; emails_sent: number; created_at: string }>(
        `SELECT digest_date, status, emails_sent, created_at
         FROM daily_digest ORDER BY created_at DESC LIMIT 1`
      );

      if (!result.rows[0]) {
        return { name: 'Daily Digest', ok: false, detail: 'No digests have been generated yet' };
      }

      const d = result.rows[0];
      const createdAt = new Date(d.created_at);
      const ageHours = (Date.now() - createdAt.getTime()) / 3600000;

      if (ageHours > 28) {
        return {
          name: 'Daily Digest',
          ok: false,
          detail: `Last digest was ${Math.round(ageHours)}h ago (${d.digest_date}) — may have missed today`,
        };
      }

      return {
        name: 'Daily Digest',
        ok: true,
        detail: `${d.digest_date} — ${d.status} — ${d.emails_sent} sent`,
      };
    } catch (err) {
      return { name: 'Daily Digest', ok: false, detail: (err as Error).message };
    }
  }

  async getOutreachStats(): Promise<OutreachStats> {
    const yesterday = `NOW() - INTERVAL '1 day'`;

    const statsResult = await query<{
      sent_yesterday: string;
      bounced_yesterday: string;
      failed_yesterday: string;
      replied_yesterday: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM email_sends WHERE tenant = $1 AND status = 'sent' AND sent_at >= date_trunc('day', NOW() - INTERVAL '1 day') AND sent_at < date_trunc('day', NOW()))::text as sent_yesterday,
        (SELECT COUNT(*) FROM email_sends WHERE tenant = $1 AND status = 'bounced' AND created_at >= date_trunc('day', NOW() - INTERVAL '1 day') AND created_at < date_trunc('day', NOW()))::text as bounced_yesterday,
        (SELECT COUNT(*) FROM email_sends WHERE tenant = $1 AND status = 'failed' AND created_at >= date_trunc('day', NOW() - INTERVAL '1 day') AND created_at < date_trunc('day', NOW()))::text as failed_yesterday,
        (SELECT COUNT(*) FROM sequence_enrollments WHERE tenant = $1 AND replied_at >= date_trunc('day', NOW() - INTERVAL '1 day') AND replied_at < date_trunc('day', NOW()))::text as replied_yesterday
    `, [TENANT]);

    const hourlyResult = await query<{ hour: string; count: string }>(`
      SELECT date_trunc('hour', sent_at) as hour, COUNT(*) as count
      FROM email_sends
      WHERE tenant = $1 AND status = 'sent'
        AND sent_at >= date_trunc('day', NOW() - INTERVAL '1 day')
        AND sent_at < date_trunc('day', NOW())
      GROUP BY hour
      ORDER BY hour
    `, [TENANT]);
    const sendingHours = hourlyResult.rows.length || 1;
    const totalSent = parseInt(statsResult.rows[0]?.sent_yesterday || '0');
    const avgPerHour = (totalSent / sendingHours).toFixed(1);

    const enrollmentResult = await query<{ step_0: string; step_1: string; total: string }>(`
      SELECT
        COUNT(*) FILTER (WHERE current_step = 0)::text as step_0,
        COUNT(*) FILTER (WHERE current_step = 1)::text as step_1,
        COUNT(*)::text as total
      FROM sequence_enrollments
      WHERE tenant = $1 AND status = 'active'
    `, [TENANT]);

    const queuedResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM email_sends WHERE tenant = $1 AND status = 'queued'`,
      [TENANT]
    );

    const settingsResult = await query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'send_gap_minutes'`
    );
    const sendGapMinutes: number = settingsResult.rows[0] ? Number(settingsResult.rows[0].value) : 5;

    const accountResult = await query<{ daily_limit: number; hourly_limit: number }>(
      `SELECT daily_limit, hourly_limit FROM email_accounts WHERE tenant = $1 AND is_active = true LIMIT 1`,
      [TENANT]
    );

    const r = statsResult.rows[0];
    const e = enrollmentResult.rows[0];
    return {
      sent_yesterday: parseInt(r?.sent_yesterday || '0'),
      bounced_yesterday: parseInt(r?.bounced_yesterday || '0'),
      failed_yesterday: parseInt(r?.failed_yesterday || '0'),
      replied_yesterday: parseInt(r?.replied_yesterday || '0'),
      avg_sends_per_hour: avgPerHour,
      active_step_0: parseInt(e?.step_0 || '0'),
      active_step_1: parseInt(e?.step_1 || '0'),
      queued_now: parseInt(queuedResult.rows[0]?.count || '0'),
      total_active_enrollments: parseInt(e?.total || '0'),
      send_gap_minutes: sendGapMinutes,
      daily_limit: accountResult.rows[0]?.daily_limit || 0,
      hourly_limit: accountResult.rows[0]?.hourly_limit || 0,
    };
  }

  async getOutOfWindowSends(): Promise<OutOfWindowSend[]> {
    const result = await query<OutOfWindowSend>(`
      SELECT sent_at::text, from_email, to_email, subject
      FROM email_sends
      WHERE tenant = $1
        AND status = 'sent'
        AND sent_at >= date_trunc('day', NOW() - INTERVAL '1 day')
        AND sent_at < date_trunc('day', NOW())
        AND (
          EXTRACT(HOUR FROM sent_at AT TIME ZONE 'UTC') < 9
          OR EXTRACT(HOUR FROM sent_at AT TIME ZONE 'UTC') >= 17
          OR EXTRACT(DOW FROM sent_at AT TIME ZONE 'UTC') IN (0, 6)
        )
      ORDER BY sent_at
    `, [TENANT]);
    return result.rows;
  }

  async sendHealthReport(results: HealthResult[]): Promise<void> {
    const failures = results.filter(r => !r.ok);
    let allOk = failures.length === 0;

    // Gather outreach stats
    let stats: OutreachStats | null = null;
    try {
      stats = await this.getOutreachStats();
    } catch (err) {
      console.error('[Health] Failed to get outreach stats:', (err as Error).message);
    }

    // Check for out-of-window sends
    let outOfWindowSends: OutOfWindowSend[] = [];
    try {
      outOfWindowSends = await this.getOutOfWindowSends();
      if (outOfWindowSends.length > 0) allOk = false;
    } catch (err) {
      console.error('[Health] Failed to get out-of-window sends:', (err as Error).message);
    }

    const statusColor = allOk ? '#16a34a' : '#dc2626';
    const statusText = allOk ? 'All systems healthy' : `${failures.length} issue${failures.length > 1 ? 's' : ''} detected`;

    const rows = results.map(r => `
      <tr>
        <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333">${r.name}</td>
        <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;font-size:13px">
          <span style="color:${r.ok ? '#16a34a' : '#dc2626'};font-weight:600">${r.ok ? '✓ OK' : '✗ FAIL'}</span>
        </td>
        <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666">${r.detail || ''}</td>
      </tr>`).join('');

    const bounceRate = stats && stats.sent_yesterday > 0
      ? ((stats.bounced_yesterday / stats.sent_yesterday) * 100).toFixed(1)
      : '0.0';

    const outreachSection = stats ? `
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-top:16px">
    <div style="background:#1a1a2e;padding:16px 24px;color:#fff">
      <h2 style="margin:0;font-size:16px;font-weight:600">Outreach Summary — Yesterday</h2>
    </div>
    <div style="padding:20px 24px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0">
            <span style="font-size:28px;font-weight:700;color:#1a1a2e">${stats.sent_yesterday}</span>
            <span style="font-size:13px;color:#666;margin-left:8px">emails sent</span>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;text-align:right">
            <span style="font-size:13px;color:#666">${stats.avg_sends_per_hour} per hour avg</span>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:13px;color:#333">Bounced</td>
          <td style="padding:8px 0;font-size:13px;text-align:right;color:${stats.bounced_yesterday > 0 ? '#dc2626' : '#666'};font-weight:${stats.bounced_yesterday > 0 ? '600' : '400'}">${stats.bounced_yesterday} (${bounceRate}%)</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:13px;color:#333">Failed</td>
          <td style="padding:8px 0;font-size:13px;text-align:right;color:${stats.failed_yesterday > 0 ? '#dc2626' : '#666'}">${stats.failed_yesterday}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:13px;color:#333">Replies received</td>
          <td style="padding:8px 0;font-size:13px;text-align:right;color:${stats.replied_yesterday > 0 ? '#16a34a' : '#666'};font-weight:${stats.replied_yesterday > 0 ? '600' : '400'}">${stats.replied_yesterday}</td>
        </tr>
      </table>

      <div style="margin-top:16px;padding-top:16px;border-top:1px solid #f0f0f0">
        <p style="margin:0 0 4px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px">Pipeline Status</p>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#333">Active enrollments</td>
            <td style="padding:6px 0;font-size:13px;text-align:right;color:#666">${stats.total_active_enrollments}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#333">Awaiting step 1</td>
            <td style="padding:6px 0;font-size:13px;text-align:right;color:#666">${stats.active_step_0}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#333">Step 1 complete (awaiting step 2)</td>
            <td style="padding:6px 0;font-size:13px;text-align:right;color:#666">${stats.active_step_1}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#333">Queued right now</td>
            <td style="padding:6px 0;font-size:13px;text-align:right;color:#666">${stats.queued_now}</td>
          </tr>
        </table>
      </div>

      <div style="margin-top:16px;padding-top:16px;border-top:1px solid #f0f0f0">
        <p style="margin:0 0 4px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px">Send Settings</p>
        <span style="font-size:12px;color:#666">Gap: ${stats.send_gap_minutes} min &nbsp;·&nbsp; Hourly limit: ${stats.hourly_limit} &nbsp;·&nbsp; Daily limit: ${stats.daily_limit}</span>
      </div>
    </div>
  </div>` : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:24px">
<div style="max-width:640px;margin:0 auto">
  <div style="background:${statusColor};border-radius:8px 8px 0 0;padding:20px 24px;color:#fff">
    <h1 style="margin:0;font-size:18px;font-weight:600">${BRAND_NAME} — Daily Report</h1>
    <p style="margin:6px 0 0;opacity:0.85;font-size:13px">${new Date().toUTCString()} &mdash; ${statusText}</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f8f9fb">
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#999;font-weight:500;text-transform:uppercase">Check</th>
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#999;font-weight:500;text-transform:uppercase">Status</th>
          <th style="padding:8px 14px;text-align:left;font-size:11px;color:#999;font-weight:500;text-transform:uppercase">Detail</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${outreachSection}
  ${outOfWindowSends.length > 0 ? (() => {
    const oowRows = outOfWindowSends.slice(0, 50).map(s => {
      const sentTime = new Date(s.sent_at);
      const timeStr = sentTime.toLocaleString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
      const dayStr = sentTime.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#333;white-space:nowrap">${dayStr} ${timeStr} UTC</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666">${s.from_email}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666">${s.to_email}</td>
      </tr>`;
    }).join('');
    const extra = outOfWindowSends.length > 50 ? `<p style="margin:8px 0 0;font-size:12px;color:#666">+ ${outOfWindowSends.length - 50} more</p>` : '';
    return `
  <div style="background:#fff;border:2px solid #dc2626;border-radius:8px;overflow:hidden;margin-top:16px">
    <div style="background:#dc2626;padding:14px 24px;color:#fff">
      <h2 style="margin:0;font-size:16px;font-weight:600">⚠ ${outOfWindowSends.length} Email${outOfWindowSends.length === 1 ? '' : 's'} Sent Outside Window (09:00–17:00 UTC)</h2>
    </div>
    <div style="padding:16px 24px">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:#999;font-weight:500;text-transform:uppercase">Sent at</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:#999;font-weight:500;text-transform:uppercase">From</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:#999;font-weight:500;text-transform:uppercase">To</th>
          </tr>
        </thead>
        <tbody>${oowRows}</tbody>
      </table>
      ${extra}
    </div>
  </div>`;
  })() : ''}
  ${!allOk ? `<p style="margin:16px 0 0;font-size:13px;color:#dc2626">Action required: fix the issues above. Log into the platform at <a href="https://www.${BRAND_DOMAIN}/outreach">www.${BRAND_DOMAIN}/outreach</a></p>` : ''}
</div>
</body></html>`;

    // Send from the first available connected account
    const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, oauth_tokens FROM email_accounts
       WHERE tenant = $1 AND is_active = true AND oauth_tokens != '{}'::jsonb
       ORDER BY email LIMIT 1`,
      [TENANT]
    );
    if (!accountResult.rows[0]) {
      console.error('[Health] No connected account to send health report from');
      return;
    }

    const account = accountResult.rows[0];
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const sentCount = stats?.sent_yesterday ?? 0;
    const oowTag = outOfWindowSends.length > 0 ? ` — ⚠ ${outOfWindowSends.length} OUT-OF-WINDOW` : '';
    const subject = allOk
      ? `[${BRAND_NAME}] Daily Report — ${sentCount} sent (${yesterday})`
      : `[${BRAND_NAME}] Daily Report — ${failures.length} ISSUE${failures.length > 1 ? 'S' : ''}${oowTag} — ${sentCount} sent (${yesterday})`;

    const emailLines = [
      `To: ${BRAND_EMAIL}`,
      `From: ${BRAND_NAME} Outreach <${account.email}>`,
      `Subject: ${subject}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html,
    ].join('\n');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(emailLines).toString('base64url') },
    });

    console.log(`[Health] Health report sent — ${allOk ? 'all OK' : `${failures.length} failures`}`);
  }

  // Public entry point: run checks + send report
  async runAndReport(): Promise<void> {
    const results = await this.runAll();
    const failures = results.filter(r => !r.ok);

    // Always log to console
    for (const r of results) {
      console.log(`[Health] ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ': ' + r.detail : ''}`);
    }

    // Always send the daily report (includes outreach stats now)
    {
      try {
        await this.sendHealthReport(results);
      } catch (err) {
        console.error('[Health] Failed to send health report:', (err as Error).message);
      }
    }
  }
}

export const healthCheckService = new HealthCheckService();
