import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { query, TENANT, BRAND_NAME } from '../db/connection';
import { EmailAccount, OAuthTokens } from '../types';

interface SendEmailOptions {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  threadId?: string;
  trackingId?: string;
}

interface SendEmailResult {
  messageId: string;
  threadId: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export class GmailClient {
  private getOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  getAuthUrl(state?: string): string {
    const oauth2Client = this.getOAuth2Client();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.settings.basic',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      prompt: 'consent',
      state,
    });
  }

  async exchangeCode(code: string): Promise<{ tokens: OAuthTokens; email: string; name: string }> {
    const oauth2Client = this.getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    const oauthTokens: OAuthTokens = {
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token ?? '',
      expiry_date: tokens.expiry_date != null ? tokens.expiry_date : undefined,
      token_type: tokens.token_type != null ? tokens.token_type : undefined,
      scope: tokens.scope != null ? tokens.scope : undefined,
    };
    return {
      tokens: oauthTokens,
      email: userInfo.data.email || '',
      name: userInfo.data.name || '',
    };
  }

  async getAuthenticatedClient(account: EmailAccount): Promise<OAuth2Client> {
    const oauth2Client = this.getOAuth2Client();
    oauth2Client.setCredentials(account.oauth_tokens);

    // Auto-refresh token if needed
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        const updated: OAuthTokens = {
          ...account.oauth_tokens,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? account.oauth_tokens.refresh_token,
          expiry_date: tokens.expiry_date != null ? tokens.expiry_date : account.oauth_tokens.expiry_date,
          scope: tokens.scope ?? account.oauth_tokens.scope,
        };
        await query(
          `UPDATE email_accounts SET oauth_tokens = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(updated), account.id]
        );
        console.log(`[Gmail Client] Refreshed tokens for ${account.email}`);
      }
    });

    // Validate stored scopes against required scopes
    if (account.oauth_tokens.scope) {
      const grantedScopes = account.oauth_tokens.scope.split(' ');
      const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));
      if (missingScopes.length > 0) {
        console.warn(`[Gmail] Account ${account.email} needs re-authorization (missing scopes: ${missingScopes.join(', ')})`);
      }
    } else {
      console.warn(`[Gmail] Account ${account.email} has no stored scopes — may need re-authorization`);
    }

    return oauth2Client;
  }

  async sendEmail(
    account: EmailAccount,
    options: SendEmailOptions
  ): Promise<SendEmailResult> {
    const auth = await this.getAuthenticatedClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const fromLine = options.fromName
      ? `"${options.fromName}" <${options.from}>`
      : options.from;

    // Build tracking pixel URL if tracking domain configured
    const trackingDomain = process.env.TRACKING_DOMAIN || '';
    // Deliverability: open-pixels and link-redirect wrapping are strong
    // phishing/spam signals. Default OFF for cold outreach. Enable per-need
    // via TRACK_OPENS / TRACK_CLICKS. Unsubscribe handling is always applied.
    const trackOpens = process.env.TRACK_OPENS === 'true';
    const trackClicks = process.env.TRACK_CLICKS === 'true';
    let htmlBody = options.htmlBody;
    if (options.trackingId && trackingDomain) {
      if (trackOpens) {
        const trackingPixel = `<img src="${trackingDomain}/t/${options.trackingId}/open" width="1" height="1" style="display:none" alt="" />`;
        htmlBody = htmlBody + trackingPixel;
      }

      const unsubscribeUrl = `${trackingDomain}/t/${options.trackingId}/unsubscribe`;

      // Replace placeholder unsubscribe URLs from template engine
      htmlBody = htmlBody.replace(/href="#unsubscribe"/gi, `href="${unsubscribeUrl}"`);
      htmlBody = htmlBody.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
      // Fix empty href="" on unsubscribe links (from records created before template engine fix)
      htmlBody = htmlBody.replace(/href=""([^>]*>)\s*Unsubscribe\s*<\/a>/gi, `href="${unsubscribeUrl}"$1Unsubscribe</a>`);

      // Rewrite links for click tracking (off by default — redirect wrapping
      // through the sending domain reads as phishing to spam filters).
      if (trackClicks) {
        htmlBody = htmlBody.replace(/(<a\s[^>]*href=")([^"]+)(")/gi, (_match, pre, url, post) => {
          // Skip mailto:, anchors, and already-tracked links
          if (url.startsWith('mailto:') || url.startsWith('#') || url.includes('/t/')) {
            return pre + url + post;
          }
          return pre + `${trackingDomain}/t/${options.trackingId}/click?url=${encodeURIComponent(url)}` + post;
        });
      }

      // Only append unsubscribe footer if template doesn't already have one
      const hasUnsubscribe = htmlBody.toLowerCase().includes('unsubscribe</a>');
      if (!hasUnsubscribe) {
        htmlBody = htmlBody + `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e0e0e0;font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;"><p>You're receiving this because you're a contact of ${BRAND_NAME}.<br><a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a></p></div>`;
      }
    }

    // Build plain text body (with unsubscribe notice if tracking)
    let textBody = options.textBody || stripHtml(htmlBody);
    if (options.trackingId && trackingDomain) {
      const unsubscribeUrl = `${trackingDomain}/t/${options.trackingId}/unsubscribe`;
      textBody = textBody + `\n\n---\nTo unsubscribe: ${unsubscribeUrl}`;
    }

    const messageParts = [
      `From: ${fromLine}`,
      `To: ${options.to}`,
      `Reply-To: Marcus Emadi <marcus@tp.finance>`,
      `Subject: ${encodeHeaderValue(options.subject)}`,
      ...(options.trackingId && trackingDomain ? [
        `List-Unsubscribe: <${trackingDomain}/t/${options.trackingId}/unsubscribe>`,
        `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
      ] : []),
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="boundary_tp_outreach"',
      '',
      '--boundary_tp_outreach',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      textBody,
      '',
      '--boundary_tp_outreach',
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
      '',
      '--boundary_tp_outreach--',
    ];

    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const requestBody: { raw: string; threadId?: string } = {
      raw: encodedMessage,
    };

    if (options.threadId) {
      requestBody.threadId = options.threadId;
    }

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody,
    });

    if (!response.data.id || !response.data.threadId) {
      throw new Error('Gmail send returned no message ID');
    }

    return {
      messageId: response.data.id,
      threadId: response.data.threadId,
    };
  }

  async checkForReplies(
    account: EmailAccount,
    sinceDate?: Date
  ): Promise<GmailMessage[]> {
    const auth = await this.getAuthenticatedClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const since = sinceDate || new Date(Date.now() - 10 * 60 * 1000); // last 10 min
    const afterTimestamp = Math.floor(since.getTime() / 1000);

    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: `in:inbox after:${afterTimestamp}`,
      maxResults: 100,
    });

    const messages = listResponse.data.messages || [];
    const result: GmailMessage[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'In-Reply-To', 'References'],
        });
        if (detail.data.threadId && detail.data.id) {
          result.push({
            id: detail.data.id,
            threadId: detail.data.threadId,
            payload: detail.data.payload as GmailMessage['payload'],
          });
        }
      } catch (err) {
        console.error(`[Gmail Client] Error fetching message ${msg.id}:`, err);
      }
    }

    return result;
  }

  async getActiveAccounts(): Promise<EmailAccount[]> {
    const result = await query<EmailAccount>(
      `SELECT * FROM email_accounts WHERE is_active = true AND tenant = $1 ORDER BY email`,
      [TENANT]
    );
    return result.rows;
  }

  async getBestSendingAccount(sequenceAccountIds: string[]): Promise<EmailAccount | null> {
    const params: unknown[] = [TENANT];
    let whereClause = `is_active = true AND tenant = $1`;

    if (sequenceAccountIds.length > 0) {
      params.push(sequenceAccountIds);
      whereClause += ` AND id = ANY($${params.length}::uuid[])`;
    }

    const result = await query<EmailAccount>(
      `SELECT * FROM email_accounts
       WHERE ${whereClause}
         AND sends_today < daily_limit
         AND sends_this_hour < hourly_limit
       ORDER BY sends_today ASC, last_send_at ASC NULLS FIRST
       LIMIT 1`,
      params
    );

    return result.rows[0] || null;
  }

  /**
   * Atomically reserve a sending slot: pick the best account under BOTH its
   * daily and hourly caps and increment its counters in a single statement.
   * This closes the check-then-act race in the sequence-step path — where a
   * burst of steps (e.g. the 24 Jun backlog flush of ~18k enrollments) all
   * read a stale sends_today≈0 via getBestSendingAccount before any actual
   * send incremented the counter, so every one passed the cap. With the
   * increment folded into the selection, capacity is consumed at reserve time.
   * Returns null when no account has capacity — the caller should reschedule.
   */
  async reserveSendingAccount(sequenceAccountIds: string[]): Promise<EmailAccount | null> {
    const params: unknown[] = [TENANT];
    let filter = `is_active = true AND tenant = $1`;
    if (sequenceAccountIds.length > 0) {
      params.push(sequenceAccountIds);
      filter += ` AND id = ANY($${params.length}::uuid[])`;
    }

    const result = await query<EmailAccount>(
      `UPDATE email_accounts
         SET sends_today = sends_today + 1,
             sends_this_hour = sends_this_hour + 1,
             last_send_at = NOW(),
             updated_at = NOW()
       WHERE id = (
         SELECT id FROM email_accounts
         WHERE ${filter}
           AND sends_today < daily_limit
           AND sends_this_hour < hourly_limit
         ORDER BY sends_today ASC, last_send_at ASC NULLS FIRST
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      params
    );

    return result.rows[0] || null;
  }

  async incrementSendCounts(accountId: string): Promise<void> {
    await query(
      `UPDATE email_accounts
       SET sends_today = sends_today + 1,
           sends_this_hour = sends_this_hour + 1,
           last_send_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [accountId]
    );
  }

  async resetHourlyCounts(): Promise<void> {
    await query(
      `UPDATE email_accounts SET sends_this_hour = 0, updated_at = NOW()`
    );
    console.log('[Gmail Client] Reset hourly send counts');
  }

  async resetDailyCounts(): Promise<void> {
    await query(
      `UPDATE email_accounts SET sends_today = 0, sends_this_hour = 0, updated_at = NOW()`
    );
    console.log('[Gmail Client] Reset daily send counts');
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// RFC 2047 encode a header value (e.g. Subject) when it contains non-ASCII
// characters. Without this, a raw UTF-8 byte like £ (C2 A3) in a header is
// mis-decoded by mail clients into mojibake such as "Ã‚Â£".
function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value; // pure ASCII, no encoding needed
  const b64 = Buffer.from(value, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

export const gmailClient = new GmailClient();
