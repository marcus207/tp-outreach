import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { query, TENANT, BRAND_NAME } from '../db/connection';
import { EmailAccount, OAuthTokens } from '../types';
import { escapeHtml, htmlToPlainText } from './template-engine';

interface SendEmailOptions {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  threadId?: string;
  trackingId?: string;
  /** RFC 5322 Message-ID of the message being replied to (follow-ups). Resolved from threadId when omitted. */
  inReplyTo?: string;
  /** Space-separated Message-IDs for the References header. */
  references?: string;
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
    // Display name is never empty: send-time fromName, else the account's
    // display_name, else DEFAULT_FROM_NAME, else the brand.
    const fromName = (options.fromName || account.display_name || process.env.DEFAULT_FROM_NAME || BRAND_NAME || '').trim();
    let opts: SendEmailOptions = { ...options, fromName };

    // Follow-ups into an existing thread need In-Reply-To/References pointing
    // at the previous message's RFC Message-ID, or recipients' clients won't
    // thread them (Gmail's threadId only threads the sender's own mailbox).
    if (opts.threadId && !opts.inReplyTo) {
      const parent = await this.resolveThreadParent(account, opts.threadId);
      if (parent) {
        opts = { ...opts, inReplyTo: parent.messageId, references: parent.references };
        // Gmail only threads a message whose Subject matches the thread, so a
        // follow-up goes out as "Re: <first subject>". FOLLOWUP_SUBJECT_MODE=template
        // keeps each step's own template subject instead.
        if (process.env.FOLLOWUP_SUBJECT_MODE !== 'template' && parent.subject) {
          opts.subject = replySubject(parent.subject);
        }
      }
    }

    const built = buildOutboundMessage(opts);
    options = opts;

    // SEND_MODE switch: only SEND_MODE=live ever reaches Gmail. Prod .env sets
    // SEND_MODE=live. Anything else is captured (tests) or refused.
    if (process.env.SEND_MODE !== 'live') {
      return captureNonLiveSend(account, options, built);
    }

    const auth = await this.getAuthenticatedClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const requestBody: { raw: string; threadId?: string } = {
      raw: built.encodedMessage,
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

  /**
   * RFC Message-ID (and References chain) of the latest message in a thread.
   * Live: read from Gmail (threads.get, metadata only) so we use whatever
   * Message-ID Gmail actually sent. Fallback / non-live: the deterministic
   * Message-ID we stamp on every outbound message, rebuilt from the previous
   * sent email_sends row's tracking_id (no schema change needed).
   */
  async resolveThreadParent(account: EmailAccount, threadId: string): Promise<{ messageId: string; references: string; subject: string } | null> {
    if (process.env.SEND_MODE === 'live') {
      try {
        const auth = await this.getAuthenticatedClient(account);
        const gmail = google.gmail({ version: 'v1', auth });
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'References', 'Subject'],
        });
        const msgs = thread.data.messages || [];
        const header = (m: (typeof msgs)[number] | undefined, n: string) =>
          (m?.payload?.headers || []).find(h => (h.name || '').toLowerCase() === n.toLowerCase())?.value || '';
        const firstSubject = header(msgs[0], 'Subject').trim();
        for (let i = msgs.length - 1; i >= 0; i--) {
          const mid = header(msgs[i], 'Message-ID').trim();
          if (mid) {
            const refs = [header(msgs[i], 'References').trim(), mid].filter(Boolean).join(' ');
            return { messageId: mid, references: refs, subject: firstSubject };
          }
        }
      } catch (err) {
        console.warn(`[Gmail Client] Could not read thread ${threadId} for In-Reply-To: ${(err as Error).message}`);
      }
    }

    try {
      const prev = await query<{ tracking_id: string; from_email: string; subject: string | null }>(
        `SELECT tracking_id, from_email, subject FROM email_sends
         WHERE gmail_thread_id = $1 AND tenant = $2 AND status = 'sent' AND tracking_id IS NOT NULL
         ORDER BY sent_at ASC NULLS LAST, created_at ASC`,
        [threadId, TENANT]
      );
      if (prev.rows.length === 0) return null;
      const ids = prev.rows.map(r => buildMessageId(r.tracking_id, r.from_email));
      return { messageId: ids[ids.length - 1], references: ids.join(' '), subject: fixBareBrand(prev.rows[0].subject || '').trim() };
    } catch (err) {
      console.warn(`[Gmail Client] Could not resolve parent for thread ${threadId}: ${(err as Error).message}`);
      return null;
    }
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

interface BuiltMessage {
  fromLine: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  headerLines: string[];
  rawMessage: string;
  encodedMessage: string;
}

/** UK Companies Act trading disclosure, appended to every outbound email. */
export const DEFAULT_LEGAL_FOOTER =
  'Turning Point Capital Advisory is a trading name of TPCommercialFinance Ltd ' +
  '(Co. No. 14537704, registered office: 187 Brooklands Road, Sale, M33 3PJ).';

function legalFooterText(): string {
  return (process.env.LEGAL_FOOTER || DEFAULT_LEGAL_FOOTER).trim();
}

/** Never ship the bare brand: "Turning Point Capital" must be followed by " Advisory". */
const BARE_BRAND_RE = /Turning Point Capital(?! Advisory)/g;
export function fixBareBrand(value: string): string {
  return value.replace(BARE_BRAND_RE, 'Turning Point Capital Advisory');
}

/** "Re: <subject>" without stacking prefixes. */
function replySubject(subject: string): string {
  const base = subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : subject;
}

/** Deterministic RFC 5322 Message-ID for an outbound send. */
export function buildMessageId(trackingId: string, fromEmail: string): string {
  const domain = (fromEmail.split('@')[1] || 'go.tp.finance').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const local = trackingId.replace(/[^A-Za-z0-9._-]/g, '');
  return `<tp.${local}@${domain}>`;
}

const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ');

function formatFrom(name: string, email: string): string {
  const clean = oneLine(name).replace(/["\\]/g, '').trim();
  if (!clean) return email;
  if (/^[\x20-\x7E]*$/.test(clean)) return `"${clean}" <${email}>`;
  return `${encodeHeaderValue(clean)} <${email}>`;
}

/**
 * Build the exact RFC 822 message sendEmail() hands to Gmail (tracking pixel,
 * unsubscribe rewrite/footer, legal footer, List-Unsubscribe headers,
 * threading headers, multipart body).
 * Pure: no I/O. Shared by the live path and the non-live capture path so the
 * test outbox sees byte-for-byte what production would send.
 * Throws (so the send is failed, never sent) when the subject is empty.
 */
function buildOutboundMessage(options: SendEmailOptions): BuiltMessage {
  const subject = fixBareBrand(oneLine(options.subject || '')).trim();
  if (!subject) {
    throw new Error(`Refusing to send to ${options.to}: subject is empty after rendering`);
  }

  const fromLine = options.fromName ? formatFrom(options.fromName, options.from) : options.from;

  // Build tracking pixel URL if tracking domain configured
  const trackingDomain = process.env.TRACKING_DOMAIN || '';
  // Deliverability: open-pixels and link-redirect wrapping are strong
  // phishing/spam signals. Default OFF for cold outreach. Enable per-need
  // via TRACK_OPENS / TRACK_CLICKS. Unsubscribe handling is always applied.
  const trackOpens = process.env.TRACK_OPENS === 'true';
  const trackClicks = process.env.TRACK_CLICKS === 'true';
  const unsubscribeUrl = options.trackingId && trackingDomain
    ? `${trackingDomain}/t/${options.trackingId}/unsubscribe`
    : '';
  let htmlBody = options.htmlBody;
  if (unsubscribeUrl) {
    if (trackOpens) {
      const trackingPixel = `<img src="${trackingDomain}/t/${options.trackingId}/open" width="1" height="1" style="display:none" alt="" />`;
      htmlBody = htmlBody + trackingPixel;
    }

    // Replace placeholder unsubscribe URLs from template engine
    htmlBody = htmlBody.replace(/href="#unsubscribe"/gi, `href="${unsubscribeUrl}"`);
    htmlBody = htmlBody.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl);
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
  }

  // The ONE footer for every outbound email: unsubscribe line (unless the
  // template already has its own unsubscribe link) + the legal disclosure.
  const legal = legalFooterText();
  const hasUnsubscribe = htmlBody.toLowerCase().includes('unsubscribe</a>');
  const footerLines: string[] = [];
  if (unsubscribeUrl && !hasUnsubscribe) {
    footerLines.push(`You're receiving this because you're a contact of ${escapeHtml(BRAND_NAME)}.<br><a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a>`);
  }
  if (legal && !htmlBody.includes(escapeHtml(legal))) {
    footerLines.push(escapeHtml(legal));
  }
  if (footerLines.length) {
    htmlBody = htmlBody + `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e0e0e0;font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;">${footerLines.map(l => `<p style="margin:0 0 8px;">${l}</p>`).join('')}</div>`;
  }
  htmlBody = fixBareBrand(htmlBody);

  // Plain text part: keeps link targets ("text (https://...)"), then the same footer.
  let textBody = options.textBody || htmlToPlainText(htmlBody);
  const textFooter: string[] = [];
  if (legal && !textBody.includes(legal)) textFooter.push(legal);
  if (unsubscribeUrl) textFooter.push(`To unsubscribe: ${unsubscribeUrl}`);
  if (textFooter.length) textBody = textBody + `\n\n---\n${textFooter.join('\n')}`;
  textBody = fixBareBrand(textBody);

  // List-Unsubscribe: https one-click first, then a mailto to the sending
  // mailbox. Subject "Re: <subject>" + body "unsubscribe" is what reply-watcher
  // matches (sender + subject) and classifies as an unsubscribe.
  const listUnsubscribe = unsubscribeUrl
    ? `<${unsubscribeUrl}>, <mailto:${options.from}?subject=${encodeURIComponent(`Re: ${subject}`)}&body=unsubscribe>`
    : '';

  const messageId = buildMessageId(options.trackingId || randomUUID(), options.from);
  const inReplyTo = options.inReplyTo ? oneLine(options.inReplyTo).trim() : '';
  const references = options.references ? oneLine(options.references).trim() : inReplyTo;

  const messageParts = [
    `From: ${fromLine}`,
    `To: ${oneLine(options.to)}`,
    `Reply-To: Marcus Emadi <marcus@tp.finance>`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references}`] : []),
    ...(listUnsubscribe ? [
      `List-Unsubscribe: ${listUnsubscribe}`,
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

  const blank = messageParts.indexOf('');
  const headerLines = blank >= 0 ? messageParts.slice(0, blank) : [];

  return { fromLine, subject, htmlBody, textBody, headerLines, rawMessage, encodedMessage };
}

// ── Test seams ─────────────────────────────────────────────────────────
//
// Every Gmail call in this codebase goes through `google.gmail({ version, auth })`
// on the shared googleapis singleton (this file, reply-watcher, digest,
// draft-review, health-check, dmarc-scanner, gmail-scanner, routes). Swapping
// that one factory lets integration tests inject inbound mail (replies, DSN
// bounces, OOO), fake getProfile, and capture forwards, with zero network I/O.
// Refuses to run outside NODE_ENV=test, so prod can never be re-pointed.

/** Shape of google.gmail; fakes only need to implement the methods a test exercises. */
export type GmailApiFactory = (options: { version: 'v1'; auth?: unknown }) => unknown;

const realGmailFactory = google.gmail;

export function setGmailTransportForTests(factory: GmailApiFactory | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setGmailTransportForTests() is only available under NODE_ENV=test');
  }
  (google as unknown as { gmail: unknown }).gmail = factory ?? realGmailFactory;
}

/**
 * SEND_MODE != 'live'. Under NODE_ENV=test the fully-built message is written
 * to the test-only `test_outbox` table (exists in test/schema.sql, never in
 * prod) and a fake id pair is returned. Anywhere else it logs and throws, so a
 * process started without SEND_MODE=live can never send.
 */
async function captureNonLiveSend(
  account: EmailAccount,
  options: SendEmailOptions,
  built: BuiltMessage,
): Promise<SendEmailResult> {
  if (process.env.NODE_ENV !== 'test') {
    console.error(
      `[Gmail Client] SEND_MODE=${process.env.SEND_MODE ?? '(unset)'}: NOT sending to ${options.to} from ${options.from} ` +
      `(subject "${options.subject}"). Set SEND_MODE=live to send.`
    );
    throw new Error('SEND_MODE is not live');
  }

  const fakeMessageId = `test-msg-${randomUUID()}`;
  const fakeThreadId = options.threadId || `test-thread-${randomUUID()}`;
  const headers: Record<string, string> = {};
  for (const line of built.headerLines) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  await query(
    `INSERT INTO test_outbox (
       account_id, account_email, from_header, from_email, to_email, reply_to, subject,
       html_body, text_body, headers, raw_message, thread_id, tracking_id,
       fake_message_id, fake_thread_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      account.id || null, account.email, built.fromLine, options.from, options.to,
      headers['Reply-To'] || null, built.subject, built.htmlBody, built.textBody,
      JSON.stringify(headers), built.rawMessage, options.threadId || null,
      options.trackingId || null, fakeMessageId, fakeThreadId,
    ]
  );
  console.log(`[Gmail Client] SEND_MODE=${process.env.SEND_MODE ?? '(unset)'} (test): captured ${options.from} -> ${options.to} in test_outbox`);

  return { messageId: fakeMessageId, threadId: fakeThreadId };
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
