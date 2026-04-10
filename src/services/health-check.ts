import { google } from 'googleapis';
import { query, pool } from '../db/connection';

interface HealthResult {
  name: string;
  ok: boolean;
  detail?: string;
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
      `SELECT id, email, is_active, oauth_tokens FROM email_accounts ORDER BY email`
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

  async sendHealthReport(results: HealthResult[]): Promise<void> {
    const failures = results.filter(r => !r.ok);
    const allOk = failures.length === 0;

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

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:24px">
<div style="max-width:640px;margin:0 auto">
  <div style="background:${statusColor};border-radius:8px 8px 0 0;padding:20px 24px;color:#fff">
    <h1 style="margin:0;font-size:18px;font-weight:600">TP Outreach — Health Check</h1>
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
  ${!allOk ? `<p style="margin:16px 0 0;font-size:13px;color:#dc2626">⚠ Action required: fix the issues above. Log into the platform at <a href="https://tp.finance/outreach">tp.finance/outreach</a></p>` : ''}
</div>
</body></html>`;

    // Send from the first available connected account
    const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, oauth_tokens FROM email_accounts
       WHERE is_active = true AND oauth_tokens != '{}'::jsonb
       ORDER BY email LIMIT 1`
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

    const subject = allOk
      ? `[Outreach] Health Check — All OK`
      : `[Outreach] Health Check — ${failures.length} ISSUE${failures.length > 1 ? 'S' : ''} DETECTED`;

    const emailLines = [
      `To: marcus@tp.finance`,
      `From: TP Outreach <${account.email}>`,
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

    // Only email if there are failures OR it's the morning check (send daily summary at 7:30am)
    const hour = new Date().getUTCHours();
    const isScheduledReport = hour === 7;
    if (failures.length > 0 || isScheduledReport) {
      try {
        await this.sendHealthReport(results);
      } catch (err) {
        console.error('[Health] Failed to send health report:', (err as Error).message);
      }
    }
  }
}

export const healthCheckService = new HealthCheckService();
