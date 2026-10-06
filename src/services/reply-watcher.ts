import { google } from 'googleapis';
import { query, TENANT, BRAND_EMAIL } from '../db/connection';
import { gmailClient } from './gmail-client';
import { sequenceEngine } from './sequence-engine';
import { EmailAccount } from '../types';

interface ReplyMatch {
  emailSendId: string;
  enrollmentId: string | null;
  sequenceId: string | null;
  contactId: string;
  contactEmail: string;
  contactName: string;
  sendingAccount: string | null;
}

const AUTO_REPLY_PREFIXES = [
  'automatic reply:', 'auto-reply:', 'auto reply:', 'autoreply:',
  'out of office:', 'out of office re:', 'abwesend:',
  're:', 'fw:', 'fwd:',
];

const PRIMARY_EMAIL = BRAND_EMAIL;

/** Cap on Gmail messages processed per account per poll (paged 100 at a time). */
const MAX_MESSAGES_PER_POLL = 500;

/** Left-company phrases only count on a short reply (or an auto/system message). */
const LEFT_COMPANY_MAX_WORDS = 60;

const LEFT_COMPANY_PHRASES = [
  'no longer with', 'no longer works', 'no longer at', 'no longer employed',
  'left the company', 'left the organisation', 'left the organization',
  'left the business', 'left the firm', 'has left', 'have left',
  'moved on from', 'no longer an employee', 'is no longer here',
  'no longer available at this address', 'this mailbox is no longer',
  'this email address is no longer', 'this account has been disabled',
  'mailbox not found', 'address rejected', 'user unknown',
  'does not exist', 'invalid recipient', 'recipient rejected',
  'no such user', 'account has been deactivated', 'account disabled',
  'no longer a member', 'departed', 'position has been filled',
];

export type DsnKind = 'hard' | 'soft';

/**
 * Remove quoted text from a reply body: '>'-prefixed lines and everything after
 * a common reply separator ("On ... wrote:", "-----Original Message-----",
 * an Outlook "From: ... Sent: ..." header block, or a Gmail forward marker).
 */
export function stripQuotedText(body: string): string {
  if (!body) return '';
  let text = body.replace(/\r\n/g, '\n');
  // Not line-anchored: HTML-only bodies arrive whitespace-collapsed onto one line.
  const separators: RegExp[] = [
    /(^|\s)On\s[\s\S]{0,300}?\swrote:/i, // "On <date>, <name> <addr> wrote:" (may wrap)
    /-{2,}\s*Original Message\s*-{2,}/i,
    /-{2,}\s*Forwarded message\s*-{2,}/i,
    /(^|\s)\*?From:\*?\s[\s\S]{0,300}?\s\*?(Sent|Date):\*?\s/i, // Outlook header block
    /^\s*_{10,}\s*$/m, // Outlook divider
  ];
  for (const re of separators) {
    const m = re.exec(text);
    if (m) text = text.slice(0, m.index);
  }
  return text
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

export function isLeftCompanyText(text: string): boolean {
  const t = (text || '').toLowerCase();
  return LEFT_COMPANY_PHRASES.some(p => t.includes(p));
}

/**
 * Classify a mailer-daemon DSN. Structured delivery-status fields win, then
 * SMTP reply codes, then wording. Anything not clearly permanent is treated as
 * soft (log only) so a transient failure never suppresses a contact.
 */
export function classifyDsn(text: string): DsnKind {
  const t = (text || '').toLowerCase();
  if (/^\s*action:\s*failed\b/m.test(t) || /^\s*status:\s*5\.\d{1,3}\.\d{1,3}/m.test(t)) return 'hard';
  if (/^\s*action:\s*delayed\b/m.test(t) || /^\s*status:\s*4\.\d{1,3}\.\d{1,3}/m.test(t)) return 'soft';
  if (/(^|[\s(\[#])55[0-4][\s-]/m.test(t) || /(^|[\s(\[#])5\.[1-7]\.\d{1,3}\b/m.test(t)) return 'hard';
  if (/(^|[\s(\[#])4[25]\d[\s-]/m.test(t) || /(^|[\s(\[#])4\.[1-7]\.\d{1,3}\b/m.test(t)) return 'soft';
  if (/delayed|will retry|will be retried|temporar(y|ily)|try again later/.test(t)) return 'soft';
  if (/address not found|user unknown|no such user|mailbox not found|mailbox unavailable|does not exist|recipient rejected|address rejected|permanent(ly)? fail/.test(t)) return 'hard';
  return 'soft';
}

type GmailPart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
};

/** Concatenate all inline text parts (incl. message/delivery-status) of a Gmail payload. */
export function collectPayloadText(payload: GmailPart | null | undefined): string {
  if (!payload) return '';
  const out: string[] = [];
  const walk = (part: GmailPart) => {
    const mime = (part.mimeType || '').toLowerCase();
    if (part.body?.data && (mime.startsWith('text/') || mime.startsWith('message/') || !mime)) {
      try {
        let txt = Buffer.from(part.body.data, 'base64url').toString('utf-8');
        if (mime === 'text/html') txt = txt.replace(/<[^>]+>/g, ' ');
        out.push(txt);
      } catch { /* ignore decode errors */ }
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  return out.join('\n');
}

/** Sender is a mail system (mailer-daemon / postmaster / MAILER-DAEMON@...). */
export function isDsnFrom(from: string): boolean {
  const f = (from || '').toLowerCase();
  const m = f.match(/<([^>]+)>/) || f.match(/([^\s<]+@[^\s>]+)/);
  const addr = m ? m[1] : f;
  const local = addr.split('@')[0];
  return local === 'mailer-daemon' || local === 'postmaster' || /mail delivery (subsystem|system)/.test(f);
}

function hasDeliveryStatusPart(part: GmailPart | null | undefined): boolean {
  if (!part) return false;
  const mime = (part.mimeType || '').toLowerCase();
  if (mime === 'multipart/report' || mime === 'message/delivery-status') return true;
  return (part.parts || []).some(hasDeliveryStatusPart);
}

export class ReplyWatcher {
  async pollAllAccounts(): Promise<void> {
    console.log('[Reply Watcher] Polling all active accounts for replies and bounces...');

    const accounts = await gmailClient.getActiveAccounts();

    if (accounts.length === 0) {
      console.log('[Reply Watcher] No active accounts to poll');
      return;
    }

    for (const account of accounts) {
      try {
        await this.pollAccount(account);
        await this.pollBounces(account);
      } catch (err) {
        console.error(`[Reply Watcher] Error polling account ${account.email}:`, err);
      }
    }
  }

  private async pollBounces(account: EmailAccount): Promise<void> {
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });

      const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      const messages: Array<{ id?: string | null; threadId?: string | null }> = [];
      let pageToken: string | undefined;
      do {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: `from:mailer-daemon after:${oneDayAgo}`,
          maxResults: 100,
          pageToken,
        });
        messages.push(...(res.data.messages || []));
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken && messages.length < MAX_MESSAGES_PER_POLL);

      if (messages.length === 0) return;

      console.log(`[Reply Watcher] Found ${messages.length} bounce messages for ${account.email}`);

      for (const msg of messages.slice(0, MAX_MESSAGES_PER_POLL)) {
        if (!msg.id || !msg.threadId) continue;
        try {
          const kind = await this.processBounce(gmail, msg.id, msg.threadId);
          // Soft bounces (delayed / will retry) are left in place so the final
          // DSN on the same thread is still visible to a later poll.
          if (kind !== 'soft') {
            await this.trashThread(gmail, msg.threadId);
          }
        } catch (err) {
          console.error(`[Reply Watcher] Error processing bounce ${msg.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`[Reply Watcher] Error polling bounces for ${account.email}:`, err);
    }
  }

  private async processBounce(
    gmail: ReturnType<typeof google.gmail>,
    messageId: string,
    threadId: string,
  ): Promise<DsnKind | 'unmatched'> {
    const sendResult = await query<{
      id: string; contact_id: string; enrollment_id: string | null; to_email: string;
    }>(
      `SELECT es.id, es.contact_id, es.enrollment_id, es.to_email
       FROM email_sends es
       WHERE es.gmail_thread_id = $1 AND es.tenant = $2 AND es.status = 'sent'
       LIMIT 1`,
      [threadId, TENANT]
    );

    if (!sendResult.rows[0]) return 'unmatched';
    const send = sendResult.rows[0];

    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const subject = (msg.data.payload?.headers || [])
      .find(h => h.name?.toLowerCase() === 'subject')?.value || '';
    const dsnText = subject + '\n' + collectPayloadText(msg.data.payload);
    const kind = classifyDsn(dsnText);

    if (kind === 'soft') {
      console.log(`[Reply Watcher] Soft bounce (delayed/retrying) for ${send.to_email} (thread ${threadId}) — no action`);
      return 'soft';
    }

    await this.applyHardBounce(send.id, send.to_email, send.contact_id, threadId);
    return 'hard';
  }

  /**
   * Hard-bounce handling shared by the bounce poll and the reply path: one
   * 'bounce' event per send, send marked bounced, address suppressed, contact
   * tagged 'bounced', enrollments cancelled. Contact and history are kept.
   */
  private async applyHardBounce(sendId: string, toEmail: string, contactId: string | null, threadId: string): Promise<void> {
    const existing = await query<{ id: string }>(
      `SELECT id FROM email_events WHERE email_send_id = $1 AND event_type = 'bounce'`,
      [sendId]
    );
    if (existing.rows.length > 0) return;

    console.log(`[Reply Watcher] Hard bounce detected: ${toEmail} (thread ${threadId})`);

    await query(
      `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'bounce')`,
      [sendId]
    );

    await query(
      `UPDATE email_sends SET status = 'bounced' WHERE id = $1 AND tenant = $2`,
      [sendId, TENANT]
    );

    await this.suppressEmail(toEmail, 'bounce');
    if (contactId) {
      await this.tagContact(contactId, 'bounced');
      await this.cancelContactEnrollments(contactId, 'bounced');
    }
  }

  private async pollAccount(account: EmailAccount): Promise<void> {
    const lastPoll = await this.getLastPollTime(account.id);
    const since = lastPoll
      ? new Date(lastPoll.getTime() - 2 * 60 * 1000)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await gmailClient.checkForReplies(account, since);
    await this.setLastPollTime(account.id);

    if (messages.length === 0) return;

    console.log(`[Reply Watcher] Found ${messages.length} messages for ${account.email}`);

    for (const message of messages) {
      try {
        await this.processMessage(account, message.id, message.threadId, message.payload);
      } catch (err) {
        console.error(`[Reply Watcher] Error processing message ${message.id}:`, err);
      }
    }
  }

  private async processMessage(
    account: EmailAccount,
    messageId: string,
    threadId: string,
    payload?: { headers?: Array<{ name: string; value: string }> }
  ): Promise<void> {
    // DSNs (mailer-daemon / postmaster / multipart/report delivery-status) land
    // in the INBOX on the outbound thread. They are routed to the bounce
    // classifier BEFORE any human-reply / left-company classification, so a
    // bounce is never suppressed as a "reply" nor forwarded to marcus@.
    const dsn = await this.detectDsn(account, messageId, payload);
    if (dsn) {
      await this.handleDsnInReplyPath(account, threadId, dsn);
      return;
    }

    let match = await this.matchReply(threadId, messageId);

    if (!match && payload) {
      const headers = payload.headers || [];
      const fromHeader = headers.find((h: { name: string; value: string }) => h.name?.toLowerCase() === 'from')?.value || '';
      const subjectHeader = headers.find((h: { name: string; value: string }) => h.name?.toLowerCase() === 'subject')?.value || '';
      match = await this.matchReplyBySubject(fromHeader, subjectHeader);
      if (match) {
        console.log(`[Reply Watcher] Fallback match by subject for ${match.contactEmail}: "${subjectHeader}"`);
      }
    }

    if (!match) return;

    const replyType = await this.classifyReply(account, messageId);

    const existing = await query<{ id: string }>(
      `SELECT id FROM email_events
       WHERE event_type IN ('reply', 'auto_reply', 'left_company', 'ooo', 'unsubscribe')
         AND email_send_id = $1`,
      [match.emailSendId]
    );
    const firstTime = existing.rows.length === 0;

    if (firstTime) {
      await query(
        `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, $2)`,
        [match.emailSendId, replyType]
      );
    }

    // Suppression + enrollment cancellation are idempotent, so they run on every
    // matching message regardless of earlier events on the same send (e.g. an
    // unsubscribe arriving after an OOO was already logged). Only the event row
    // and the forward are de-duplicated.
    if (replyType === 'unsubscribe') {
      if (!firstTime) await this.recordEventOnce(match.emailSendId, 'unsubscribe');
      console.log(`[Reply Watcher] Unsubscribe request from ${match.contactEmail} — suppressing contact`);
      await this.suppressEmail(match.contactEmail, 'unsubscribed (reply)');
      await this.tagContact(match.contactId, 'unsubscribed');
      await this.cancelContactEnrollments(match.contactId, 'unsubscribed');
      await this.archiveThread(account, threadId);
    } else if (replyType === 'left_company') {
      if (!firstTime) await this.recordEventOnce(match.emailSendId, 'left_company');
      console.log(`[Reply Watcher] Left company / undeliverable: ${match.contactEmail} — removing from sequencing`);
      await this.suppressEmail(match.contactEmail, 'left company');
      await this.tagContact(match.contactId, 'left_company');
      await this.cancelContactEnrollments(match.contactId, 'left_company');
      await this.archiveThread(account, threadId);
    } else if (replyType === 'ooo') {
      if (firstTime) console.log(`[Reply Watcher] Out of office from ${match.contactEmail} on thread ${threadId}`);
      await this.archiveThread(account, threadId);
    } else if (replyType === 'auto_reply') {
      if (firstTime) console.log(`[Reply Watcher] Auto-reply from ${match.contactEmail} on thread ${threadId}`);
      await this.archiveThread(account, threadId);
    } else {
      // Genuine human reply. Marcus handles replies personally, so the contact is
      // taken out of ALL automation (every active/paused enrollment cancelled and
      // the address suppressed). Then notify marcus@ when the conversation belongs
      // to one of the *other* sending accounts. Decision is based on the SENDING
      // account, not the inbox the reply landed in: Reply-To routes most replies to
      // marcus@, so keying off the polling account missed them.
      if (!firstTime) await this.recordEventOnce(match.emailSendId, 'reply');
      if (firstTime) console.log(`[Reply Watcher] Genuine reply from ${match.contactEmail} on thread ${threadId}`);
      await this.cancelContactEnrollments(match.contactId, 'replied', match.enrollmentId);
      await this.suppressEmail(match.contactEmail, 'replied - removed from automation');
      await this.maybeForwardReply(account, messageId, match);
    }
  }

  /**
   * Decide whether an inbox message is a delivery status notification. Returns
   * the DSN text (subject + all inline parts, incl. message/delivery-status) when
   * it is, otherwise null. Signals: From mailer-daemon/postmaster, a
   * multipart/report (report-type=delivery-status) content type, or
   * Auto-Submitted from a mailer-daemon.
   */
  private async detectDsn(
    account: EmailAccount,
    messageId: string,
    payload?: { headers?: Array<{ name: string; value: string }> },
  ): Promise<string | null> {
    const metaHeaders = payload?.headers || [];
    const metaFrom = metaHeaders.find(h => h.name?.toLowerCase() === 'from')?.value || '';
    let full: GmailPart & { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null | undefined;
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });
      const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      full = msg.data.payload as typeof full;
    } catch (err) {
      // Could not fetch the body: fall back to metadata headers only.
      if (!isDsnFrom(metaFrom)) return null;
      const subj = metaHeaders.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
      return subj;
    }
    const headers = full?.headers || [];
    const get = (n: string) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
    const from = get('From') || metaFrom;
    const contentType = (get('Content-Type') || '').toLowerCase();
    const mime = (full?.mimeType || '').toLowerCase();
    const isReport =
      mime === 'multipart/report' ||
      contentType.includes('multipart/report') ||
      contentType.includes('report-type=delivery-status') ||
      hasDeliveryStatusPart(full);
    if (!isDsnFrom(from) && !isReport) return null;
    return (get('Subject') || '') + '\n' + collectPayloadText(full);
  }

  /**
   * Reply-path DSN handling: hard => bounce handling on the matched send; soft or
   * unknown => no action (no suppression, sequence continues, left in place so
   * the bounce poll can still see a later final DSN).
   */
  private async handleDsnInReplyPath(account: EmailAccount, threadId: string, dsnText: string): Promise<void> {
    const kind = classifyDsn(dsnText);
    if (kind === 'soft') {
      console.log(`[Reply Watcher] Soft/unknown DSN on thread ${threadId} (${account.email}) - no action`);
      return;
    }
    const sendResult = await query<{ id: string; contact_id: string | null; to_email: string }>(
      `SELECT es.id, es.contact_id, es.to_email
       FROM email_sends es
       WHERE es.gmail_thread_id = $1 AND es.tenant = $2 AND es.status IN ('sent', 'bounced')
       ORDER BY es.sent_at DESC NULLS LAST
       LIMIT 1`,
      [threadId, TENANT]
    );
    const send = sendResult.rows[0];
    if (!send) return;
    await this.applyHardBounce(send.id, send.to_email, send.contact_id, threadId);
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });
      await this.trashThread(gmail, threadId);
    } catch (err) {
      console.error(`[Reply Watcher] Failed to trash DSN thread ${threadId}:`, err);
    }
  }

  /** Insert an event of this exact type for the send if one does not already exist. */
  private async recordEventOnce(emailSendId: string, eventType: string): Promise<void> {
    const existing = await query<{ id: string }>(
      `SELECT id FROM email_events WHERE email_send_id = $1 AND event_type = $2`,
      [emailSendId, eventType]
    );
    if (existing.rows.length > 0) return;
    await query(
      `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, $2)`,
      [emailSendId, eventType]
    );
  }

  /**
   * Suppress the exact email only. Do NOT store the domain here: the send-gate
   * matches suppression on email OR domain, so writing the domain for a single
   * contact would block every address at that domain. Domain-level blocks are
   * reserved for deliberate manual entries.
   */
  private async suppressEmail(email: string, reason: string): Promise<void> {
    if (!email) return;
    await query(
      `INSERT INTO suppressed_emails (email, domain, reason, source, tenant)
       VALUES (LOWER($1), NULL, $2, 'reply-watcher', $3)
       ON CONFLICT (LOWER(email), tenant) DO NOTHING`,
      [email, reason, TENANT]
    );
  }

  /** Add a tag to the contact if it is not already present. Never deletes anything. */
  private async tagContact(contactId: string, tag: string): Promise<void> {
    if (!contactId) return;
    await query(
      `UPDATE contacts
       SET tags = array_append(COALESCE(tags, '{}'), $1::text), updated_at = NOW()
       WHERE id = $2 AND tenant = $3
         AND NOT ($1::text = ANY(COALESCE(tags, '{}')))`,
      [tag, contactId, TENANT]
    );
  }

  /**
   * Stop every active/paused enrollment for the contact in this tenant. Uses
   * sequenceEngine.cancelEnrollment so pending BullMQ step jobs are removed too.
   * For a human reply, the enrollment the reply belongs to is marked 'replied'
   * (keeps reply analytics); all others are 'cancelled'.
   */
  private async cancelContactEnrollments(
    contactId: string,
    reason: string,
    repliedEnrollmentId: string | null = null,
  ): Promise<void> {
    if (!contactId) return;
    const result = await query<{ id: string }>(
      `SELECT id FROM sequence_enrollments
       WHERE contact_id = $1 AND tenant = $2 AND status IN ('active', 'paused')`,
      [contactId, TENANT]
    );
    for (const row of result.rows) {
      const why = reason === 'replied' && row.id !== repliedEnrollmentId ? 'replied (other sequence)' : reason;
      await sequenceEngine.cancelEnrollment(row.id, why);
    }
  }

  private async maybeForwardReply(account: EmailAccount, messageId: string, match: ReplyMatch): Promise<void> {
    const sender = (match.sendingAccount || '').toLowerCase();
    // Only notify for replies to the OTHER addresses. Replies to marcus@'s own
    // outreach already arrive directly in his inbox, so no notification needed.
    if (!sender || sender === PRIMARY_EMAIL.toLowerCase()) return;

    // Idempotent: forward each reply to marcus@ at most once.
    const already = await query<{ id: string }>(
      `SELECT id FROM email_events WHERE email_send_id = $1 AND event_type = 'reply_fwd'`,
      [match.emailSendId]
    );
    if (already.rows.length > 0) return;

    const ok = await this.forwardReply(account, messageId, match);
    if (ok) {
      await query(
        `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'reply_fwd')`,
        [match.emailSendId]
      );
    }
  }

  private async classifyReply(account: EmailAccount, messageId: string): Promise<'reply' | 'auto_reply' | 'ooo' | 'left_company' | 'unsubscribe'> {
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
        metadataHeaders: [
          'Auto-Submitted', 'X-Autoreply', 'X-Auto-Response-Suppress',
          'X-Autorespond', 'Precedence', 'X-MS-Exchange-Organization-AutoForwarded',
          'Subject',
        ],
      });

      const headers = msg.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

      const isAutoHeader =
        (getHeader('Auto-Submitted') && getHeader('Auto-Submitted') !== 'no') ||
        !!getHeader('X-Autoreply') ||
        !!getHeader('X-Autorespond') ||
        getHeader('Precedence').toLowerCase() === 'auto_reply' ||
        getHeader('Precedence').toLowerCase() === 'bulk' ||
        !!getHeader('X-MS-Exchange-Organization-AutoForwarded');

      const subject = getHeader('Subject').toLowerCase();

      const oooSubjects = [
        'out of office', 'on vacation', 'on holiday', 'away from',
        'i am currently out', 'abwesend', 'absence', 'not in the office',
      ];

      const deliveryFailSubjects = [
        'delivery status', 'undeliverable', 'mail delivery failed',
        'delivery failure', 'returned mail', 'not delivered',
      ];

      const autoSubjects = [
        'automatic reply', 'auto-reply', 'auto reply', 'autoreply',
      ];

      // Extract body text for "left company" detection
      let bodyText = '';
      try {
        const parts = msg.data.payload?.parts || [];
        if (parts.length > 0) {
          for (const part of parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
              bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
              break;
            }
            if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
              bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            }
          }
        } else if (msg.data.payload?.body?.data) {
          bodyText = Buffer.from(msg.data.payload.body.data, 'base64url').toString('utf-8');
          if (msg.data.payload.mimeType === 'text/html') {
            bodyText = bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          }
        }
      } catch { /* ignore decode errors */ }

      const combined = (subject + ' ' + bodyText).toLowerCase();

      // Only the new text the sender wrote counts; the quoted original (our own
      // outreach) must never trigger left-company or unsubscribe handling.
      const freshBody = stripQuotedText(bodyText)
        .toLowerCase().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const freshWords = freshBody ? freshBody.split(/\s+/).length : 0;
      const isAutoLike = !!isAutoHeader || autoSubjects.some(p => subject.includes(p));

      if (isLeftCompanyText(subject + ' ' + freshBody) && (isAutoLike || freshWords <= LEFT_COMPANY_MAX_WORDS)) {
        return 'left_company';
      }

      if (isAutoHeader || autoSubjects.some(p => subject.includes(p))) {
        if (oooSubjects.some(p => subject.includes(p)) || oooSubjects.some(p => combined.includes(p))) {
          return 'ooo';
        }
        if (deliveryFailSubjects.some(p => subject.includes(p))) {
          return 'left_company';
        }
        return 'auto_reply';
      }

      if (oooSubjects.some(p => subject.includes(p))) {
        return 'ooo';
      }

      const unsubscribePhrases = [
        'unsubscribe', 'remove me', 'stop emailing', 'stop sending',
        'opt out', 'opt-out', 'take me off', 'remove from list',
        'remove from your list', 'remove my email', 'don\'t email',
        'do not email', 'do not contact', 'don\'t contact',
        'no longer interested', 'not interested',
        'please remove', 'stop contacting', 'cease and desist',
      ];

      if (freshWords <= 30 && unsubscribePhrases.some(p => freshBody.includes(p))) {
        return 'unsubscribe';
      }

      return 'reply';
    } catch (err) {
      console.error(`[Reply Watcher] Error classifying reply for ${messageId}:`, err);
      return 'reply';
    }
  }

  private async forwardReply(account: EmailAccount, messageId: string, match: ReplyMatch): Promise<boolean> {
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });

      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const headers = msg.data.payload?.headers || [];
      const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '(no subject)';
      const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || match.contactEmail;

      let bodyHtml = '';
      let bodyText = '';
      const parts = msg.data.payload?.parts || [];

      if (parts.length > 0) {
        for (const part of parts) {
          if (part.mimeType === 'text/html' && part.body?.data) {
            bodyHtml = Buffer.from(part.body.data, 'base64url').toString('utf-8');
          } else if (part.mimeType === 'text/plain' && part.body?.data) {
            bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
          }
        }
      } else if (msg.data.payload?.body?.data) {
        const decoded = Buffer.from(msg.data.payload.body.data, 'base64url').toString('utf-8');
        if (msg.data.payload.mimeType === 'text/html') {
          bodyHtml = decoded;
        } else {
          bodyText = decoded;
        }
      }

      const content = bodyHtml || `<pre>${bodyText}</pre>`;
      const contactName = match.contactName || match.contactEmail;

      const forwardHtml = `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">
          <p style="background:#f0f7ff;border-left:4px solid #1993C5;padding:12px 16px;margin:0 0 16px;">
            <strong>New reply</strong> to outreach sent from <strong>${match.sendingAccount || account.email}</strong><br>
            From: ${from}<br>
            Contact: ${contactName}
          </p>
          <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-top:8px;">
            ${content}
          </div>
        </div>`;

      const cleanSubject = subject.replace(/^(re:|fwd:|fw:)\s*/i, '');
      const fwdSubject = `New reply (${match.sendingAccount || account.email}): ${cleanSubject}`;

      const messageParts = [
        `From: ${account.email}`,
        `To: ${PRIMARY_EMAIL}`,
        `Subject: ${fwdSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        '',
        forwardHtml,
      ];

      const rawMessage = messageParts.join('\r\n');
      const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage },
      });

      console.log(`[Reply Watcher] Forwarded reply from ${match.contactEmail} (sent from ${match.sendingAccount}, found in ${account.email}) to ${PRIMARY_EMAIL}`);
      return true;
    } catch (err) {
      console.error(`[Reply Watcher] Failed to forward reply to ${PRIMARY_EMAIL}:`, err);
      return false;
    }
  }

  private async trashThread(gmail: ReturnType<typeof google.gmail>, threadId: string): Promise<void> {
    try {
      await gmail.users.threads.trash({ userId: 'me', id: threadId });
      console.log(`[Reply Watcher] Trashed bounce thread ${threadId} from inbox`);
    } catch (err) {
      console.error(`[Reply Watcher] Failed to trash thread ${threadId}:`, err);
    }
  }

  private async getLastPollTime(accountId: string): Promise<Date | null> {
    const result = await query<{ last_poll: Date }>(
      `SELECT value::timestamptz AS last_poll FROM kv_store WHERE key = $1`,
      [`reply_poll_${accountId}`]
    );
    return result.rows[0]?.last_poll || null;
  }

  private async setLastPollTime(accountId: string): Promise<void> {
    await query(
      `INSERT INTO kv_store (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`reply_poll_${accountId}`, new Date().toISOString()]
    );
  }

  private async matchReplyBySubject(fromHeader: string, subject: string): Promise<ReplyMatch | null> {
    const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s<]+@[^\s>]+)/);
    const senderEmail = emailMatch ? emailMatch[1].toLowerCase() : '';
    if (!senderEmail) return null;

    let cleanSubject = subject.toLowerCase().trim();
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const prefix of AUTO_REPLY_PREFIXES) {
        if (cleanSubject.startsWith(prefix)) {
          cleanSubject = cleanSubject.slice(prefix.length).trim();
          stripped = true;
        }
      }
    }

    if (!cleanSubject) return null;

    const result = await query<{
      id: string;
      contact_id: string;
      enrollment_id: string | null;
      sequence_id: string | null;
      contact_email: string;
      contact_name: string;
      sending_account: string | null;
    }>(
      `SELECT
         es.id,
         es.contact_id,
         es.enrollment_id,
         se.sequence_id,
         es.to_email AS contact_email,
         COALESCE(c.first_name || ' ' || c.last_name, c.first_name, es.to_email) AS contact_name,
         ea.email AS sending_account
       FROM email_sends es
       LEFT JOIN sequence_enrollments se ON se.id = es.enrollment_id
       LEFT JOIN contacts c ON c.id = es.contact_id
       LEFT JOIN email_accounts ea ON ea.id = es.email_account_id
       WHERE LOWER(es.to_email) = $1
         AND LOWER(es.subject) = $2
         AND es.tenant = $3
         AND es.status = 'sent'
       ORDER BY es.sent_at DESC
       LIMIT 1`,
      [senderEmail, cleanSubject, TENANT]
    );

    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      emailSendId: row.id,
      enrollmentId: row.enrollment_id,
      sequenceId: row.sequence_id,
      contactId: row.contact_id,
      contactEmail: row.contact_email,
      contactName: row.contact_name,
      sendingAccount: row.sending_account,
    };
  }

  private async archiveThread(account: EmailAccount, threadId: string): Promise<void> {
    try {
      const auth = await gmailClient.getAuthenticatedClient(account);
      const gmail = google.gmail({ version: 'v1', auth });
      // Automated responses (auto-reply, OOO, left-company, unsubscribe) get pulled
      // out of the inbox AND marked as read so they don't sit as unread noise.
      await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: { removeLabelIds: ['INBOX', 'UNREAD'] },
      });
      console.log(`[Reply Watcher] Archived + marked read thread ${threadId} from ${account.email}`);
    } catch (err) {
      console.error(`[Reply Watcher] Failed to archive thread ${threadId}:`, err);
    }
  }

  async matchReply(threadId: string, _messageId: string): Promise<ReplyMatch | null> {
    const result = await query<{
      id: string;
      contact_id: string;
      enrollment_id: string | null;
      sequence_id: string | null;
      contact_email: string;
      contact_name: string;
      sending_account: string | null;
    }>(
      `SELECT
         es.id,
         es.contact_id,
         es.enrollment_id,
         se.sequence_id,
         es.to_email AS contact_email,
         COALESCE(c.first_name || ' ' || c.last_name, c.first_name, es.to_email) AS contact_name,
         ea.email AS sending_account
       FROM email_sends es
       LEFT JOIN sequence_enrollments se ON se.id = es.enrollment_id
       LEFT JOIN contacts c ON c.id = es.contact_id
       LEFT JOIN email_accounts ea ON ea.id = es.email_account_id
       WHERE es.gmail_thread_id = $1 AND es.tenant = $2
       ORDER BY es.sent_at ASC
       LIMIT 1`,
      [threadId, TENANT]
    );

    if (!result.rows[0]) return null;

    const row = result.rows[0];
    return {
      emailSendId: row.id,
      enrollmentId: row.enrollment_id,
      sequenceId: row.sequence_id,
      contactId: row.contact_id,
      contactEmail: row.contact_email,
      contactName: row.contact_name,
      sendingAccount: row.sending_account,
    };
  }

  /** Record that a reply has been forwarded to marcus@ (idempotent), without re-sending. */
  async markForwarded(emailSendId: string): Promise<void> {
    const existing = await query<{ id: string }>(
      `SELECT id FROM email_events WHERE email_send_id = $1 AND event_type = 'reply_fwd'`,
      [emailSendId]
    );
    if (existing.rows.length > 0) return;
    await query(
      `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'reply_fwd')`,
      [emailSendId]
    );
  }

  /**
   * One-off backfill: find the most recent inbound message from a contact across
   * the active mailboxes and forward it to marcus@ (idempotent). Used because the
   * stored gmail_thread_id points at the OUTBOUND thread — replies routed via
   * Reply-To land in marcus@ on a separate thread, so we search by sender.
   */
  async backfillContact(
    emailSendId: string,
    contactEmail: string,
    contactName: string,
    sendingAccount: string | null,
  ): Promise<'sent' | 'skip-primary' | 'skip-done' | 'notfound' | 'fail'> {
    const sender = (sendingAccount || '').toLowerCase();
    if (!sender || sender === PRIMARY_EMAIL.toLowerCase()) return 'skip-primary';

    const already = await query<{ id: string }>(
      `SELECT id FROM email_events WHERE email_send_id = $1 AND event_type = 'reply_fwd'`,
      [emailSendId]
    );
    if (already.rows.length > 0) return 'skip-done';

    const match: ReplyMatch = {
      emailSendId,
      enrollmentId: null,
      sequenceId: null,
      contactId: '',
      contactEmail,
      contactName: contactName || contactEmail,
      sendingAccount,
    };

    const accounts = await gmailClient.getActiveAccounts();
    for (const acct of accounts) {
      try {
        const auth = await gmailClient.getAuthenticatedClient(acct);
        const gmail = google.gmail({ version: 'v1', auth });
        const list = await gmail.users.messages.list({
          userId: 'me', q: `from:${contactEmail}`, maxResults: 5,
        });
        const messages = list.data.messages || [];
        if (messages.length === 0) continue;
        const messageId = messages[0].id; // most recent inbound from this contact
        if (!messageId) continue;

        const ok = await this.forwardReply(acct, messageId, match);
        if (ok) {
          await query(
            `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'reply_fwd')`,
            [emailSendId]
          );
          return 'sent';
        }
        return 'fail';
      } catch {
        continue;
      }
    }
    return 'notfound';
  }

  /**
   * One-off backfill: locate the inbound reply for a thread across the active
   * mailboxes and forward it to marcus@ if it hasn't been forwarded already.
   */
  async backfillThread(threadId: string): Promise<'sent' | 'skip-primary' | 'skip-done' | 'notfound' | 'fail'> {
    const match = await this.matchReply(threadId, '');
    if (!match) return 'notfound';

    const sender = (match.sendingAccount || '').toLowerCase();
    if (!sender || sender === PRIMARY_EMAIL.toLowerCase()) return 'skip-primary';

    const already = await query<{ id: string }>(
      `SELECT id FROM email_events WHERE email_send_id = $1 AND event_type = 'reply_fwd'`,
      [match.emailSendId]
    );
    if (already.rows.length > 0) return 'skip-done';

    const accounts = await gmailClient.getActiveAccounts();
    for (const acct of accounts) {
      try {
        const auth = await gmailClient.getAuthenticatedClient(acct);
        const gmail = google.gmail({ version: 'v1', auth });
        let thread;
        try {
          thread = await gmail.users.threads.get({
            userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'],
          });
        } catch {
          continue; // thread not in this mailbox
        }
        const msgs = thread.data.messages || [];
        let messageId = '';
        for (const m of msgs) {
          const from = (m.payload?.headers || []).find(h => h.name?.toLowerCase() === 'from')?.value || '';
          if (from.toLowerCase().includes(match.contactEmail.toLowerCase())) messageId = m.id || '';
        }
        if (!messageId) continue;

        const ok = await this.forwardReply(acct, messageId, match);
        if (ok) {
          await query(
            `INSERT INTO email_events (email_send_id, event_type) VALUES ($1, 'reply_fwd')`,
            [match.emailSendId]
          );
          return 'sent';
        }
        return 'fail';
      } catch {
        continue;
      }
    }
    return 'notfound';
  }
}

export const replyWatcher = new ReplyWatcher();
