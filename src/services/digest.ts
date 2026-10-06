import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { query, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
import { safeEqual } from '../middleware/security';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface DigestContact {
  contact_id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  title: string;
  list_name: string;
  template_id: string;
  template_subject: string;
  from_account_id: string;
  from_email: string;
  scheduled_delay_ms: number;
}

// Public approval links are refused once the digest is older than this
const APPROVAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;

interface DigestRecord {
  id: string;
  digest_date: string;
  status: string;
  contacts: DigestContact[];
  approved_contacts: DigestContact[] | null;
  approval_token: string;
  approved_at: string | null;
  sent_at: string | null;
  emails_sent: number;
  created_at: string;
  digest_gmail_thread_id: string | null;
  digest_from_account_id: string | null;
  reply_processed_at: string | null;
}

// Map each list to its primary template
const LIST_TEMPLATES: Record<string, string> = {
  'Lenders':            '12e3dc48-3918-4ced-bb28-5d950d883a2f', // Outbound — Main
  'Hospitality Sector': 'c85c883e-270e-4495-a7a0-65831c0c07fa', // Hospitality Sector — Main
  'Introducers':        '2464ef46-0b37-4d38-a0ef-befb0d6cbbc8', // Introducer Outreach — Step 1
  'Clients':            '6527eb30-6172-464a-bc6a-addd76041bcb', // Client Check-In — Step 1
};

// Daily send targets per list — 400/day total across 4 accounts (100 each)
const LIST_DAILY_TARGETS: Record<string, number> = {
  'Hospitality Sector': 80,   // ~460 contacts → ~6 days
  'Lenders':            200,  // ~18,600 contacts → ~93 days
  'Introducers':        60,   // ~2,400 contacts → ~40 days
  'Clients':            60,   // ~3,850 contacts → ~64 days
};

// 9am–5pm UTC send window = 8 hours = 28,800,000ms
const WINDOW_START_HOUR = 9;   // 9am UTC
const WINDOW_END_HOUR   = 17;  // 5pm UTC

class DigestService {
  async getOrCreateToday(): Promise<DigestRecord | null> {
    const today = new Date().toISOString().slice(0, 10);
    const existing = await query<DigestRecord>(
      `SELECT * FROM daily_digest WHERE digest_date = $1`, [today]
    );
    return existing.rows[0] || null;
  }

  async generate(): Promise<DigestRecord> {
    const today = new Date().toISOString().slice(0, 10);

    // Delete pending digest for today if one exists (allow re-generation)
    await query(`DELETE FROM daily_digest WHERE digest_date = $1 AND status = 'pending'`, [today]);

    // Get active email accounts with valid OAuth tokens
    const accountsResult = await query<{ id: string; email: string; daily_limit: number; sends_today: number; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, daily_limit, sends_today, oauth_tokens
       FROM email_accounts
       WHERE is_active = true AND oauth_tokens != '{}'::jsonb
       ORDER BY daily_limit DESC`
    );

    if (accountsResult.rows.length === 0) {
      throw new Error('No email accounts with valid OAuth tokens connected');
    }

    const accounts = accountsResult.rows;
    let totalCapacity = accounts.reduce((sum, a) => sum + Math.max(0, a.daily_limit - a.sends_today), 0);

    // Pick contacts per list, excluding already emailed + unsubscribed
    const contacts: DigestContact[] = [];
    let accountIndex = 0;

    const listPriority = ['Hospitality Sector', 'Lenders', 'Introducers', 'Clients'];

    // Season-based rotation: Spring(Mar-May)=0, Summer(Jun-Aug)=1, Autumn(Sep-Nov)=2, Winter(Dec-Feb)=3
    const currentMonth = new Date().getMonth() + 1; // 1–12
    const seasonIndex = currentMonth >= 3 && currentMonth <= 5 ? 0  // Spring
                      : currentMonth >= 6 && currentMonth <= 8 ? 1  // Summer
                      : currentMonth >= 9 && currentMonth <= 11 ? 2 // Autumn
                      : 3;                                           // Winter (Dec, Jan, Feb)

    for (const listName of listPriority) {
      if (totalCapacity <= 0) break;

      // Check for a rotation schedule first, then fall back to LIST_TEMPLATES
      const rotationResult = await query<{ template_id: string; total: number }>(
        `SELECT template_id, (SELECT COUNT(*) FROM template_rotations WHERE list_name = $1) AS total
         FROM template_rotations WHERE list_name = $1
         ORDER BY rotation_index`,
        [listName]
      );

      let templateId: string;
      if (rotationResult.rows.length > 0) {
        const total = parseInt(String(rotationResult.rows[0].total));
        const idx = seasonIndex % total;
        templateId = rotationResult.rows[idx]?.template_id || rotationResult.rows[0].template_id;
      } else {
        templateId = LIST_TEMPLATES[listName];
      }

      if (!templateId) continue;

      const target = Math.min(LIST_DAILY_TARGETS[listName] || 20, totalCapacity);

      // Get template subject for display
      const templateResult = await query<{ subject: string }>(
        `SELECT subject FROM templates WHERE id = $1`, [templateId]
      );
      const templateSubject = templateResult.rows[0]?.subject || '';

      // Pick contacts from this list not yet emailed and not unsubscribed
      const picked = await query<{ id: string; email: string; first_name: string; last_name: string; company: string; title: string }>(
        `SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.title
         FROM contacts c
         JOIN contact_list_members clm ON clm.contact_id = c.id
         JOIN contact_lists cl ON cl.id = clm.list_id
         WHERE cl.name = $1
           AND NOT ('unsubscribed' = ANY(c.tags))
           AND c.email_verified = true
           AND NOT EXISTS (
             SELECT 1 FROM email_sends es
             WHERE es.contact_id = c.id
               AND es.status IN ('sent', 'pending', 'queued')
               AND es.created_at > NOW() - INTERVAL '90 days'
           )
         ORDER BY c.created_at ASC
         LIMIT $2`,
        [listName, target]
      );

      // Distribute across send window: 9am–5pm = 480 minutes
      const windowMs = (WINDOW_END_HOUR - WINDOW_START_HOUR) * 60 * 60 * 1000;
      const count = picked.rows.length;

      picked.rows.forEach((c, i) => {
        const account = accounts[accountIndex % accounts.length];
        const delayMs = count > 1 ? Math.floor((i / (count - 1)) * windowMs) : 0;

        contacts.push({
          contact_id: c.id,
          email: c.email,
          first_name: c.first_name || '',
          last_name: c.last_name || '',
          company: c.company || '',
          title: c.title || '',
          list_name: listName,
          template_id: templateId,
          template_subject: templateSubject,
          from_account_id: account.id,
          from_email: account.email,
          scheduled_delay_ms: delayMs,
        });

        accountIndex++;
      });

      totalCapacity -= count;
    }

    if (contacts.length === 0) {
      throw new Error('No eligible contacts to send to today');
    }

    const result = await query<DigestRecord>(
      `INSERT INTO daily_digest (digest_date, contacts)
       VALUES ($1, $2)
       RETURNING *`,
      [today, JSON.stringify(contacts)]
    );

    return result.rows[0];
  }

  async sendDigestEmail(digestId: string): Promise<void> {
    const digestResult = await query<DigestRecord>(
      `SELECT * FROM daily_digest WHERE id = $1`, [digestId]
    );
    const digest = digestResult.rows[0];
    if (!digest) throw new Error(`Digest ${digestId} not found`);

    const contacts = digest.contacts;
    const baseUrl = process.env.TRACKING_DOMAIN || `https://www.${BRAND_DOMAIN}/outreach`;
    const approveUrl = `${baseUrl}/api/digest/${digest.id}/approve?token=${digest.approval_token}`;
    const viewUrl   = `${baseUrl}/#/digest/${digest.id}`;

    // Group by list for display
    const byList: Record<string, DigestContact[]> = {};
    contacts.forEach(c => {
      if (!byList[c.list_name]) byList[c.list_name] = [];
      byList[c.list_name].push(c);
    });

    // Fetch full template bodies for each unique template
    const templateIds = [...new Set(contacts.map(c => c.template_id))];
    const templateBodies: Record<string, { body_html: string; subject: string }> = {};
    for (const tid of templateIds) {
      const tr = await query<{ body_html: string; subject: string }>(
        `SELECT body_html, subject FROM templates WHERE id = $1`, [tid]
      );
      if (tr.rows[0]) templateBodies[tid] = tr.rows[0];
    }

    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    // Build a section per list
    const listSections = Object.entries(byList).map(([listName, items]) => {
      const fromAccounts = [...new Set(items.map(i => i.from_email))].join(', ');
      const sample = items[0];

      // Render template with first contact's details
      const tmpl = templateBodies[sample.template_id];
      const merge = (s: string) => s
        .replace(/\{\{first_name\}\}/g, sample.first_name || 'there')
        .replace(/\{\{last_name\}\}/g, sample.last_name || '')
        .replace(/\{\{company\}\}/g, sample.company || '')
        .replace(/\{\{title\}\}/g, sample.title || '');

      const renderedSubject = tmpl ? merge(tmpl.subject) : sample.template_subject;
      const renderedBody    = tmpl ? merge(tmpl.body_html) : '';

      // Contact list rows
      const contactRows = items.map(c =>
        `<tr>
           <td style="padding:5px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333">${c.first_name} ${c.last_name}</td>
           <td style="padding:5px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666">${c.company || ''}</td>
           <td style="padding:5px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#888">${c.title || ''}</td>
           <td style="padding:5px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#aaa">${c.from_email}</td>
         </tr>`
      ).join('');

      return `
        <div style="margin:32px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
          <!-- List header -->
          <div style="background:#1a1a2e;padding:14px 20px;display:flex;align-items:center;justify-content:space-between">
            <span style="color:#fff;font-weight:600;font-size:15px">${listName}</span>
            <span style="color:rgba(255,255,255,0.6);font-size:13px">${items.length} contacts &nbsp;·&nbsp; from ${fromAccounts}</span>
          </div>

          <!-- Subject line -->
          <div style="padding:10px 20px;background:#f8f9fb;border-bottom:1px solid #e5e7eb">
            <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Subject: </span>
            <span style="font-size:13px;color:#333;font-weight:500">${renderedSubject}</span>
          </div>

          <!-- Full email template preview -->
          <div style="padding:20px;background:#f4f6f9">
            <p style="margin:0 0 10px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px">Email preview (rendered for ${sample.first_name} ${sample.last_name})</p>
            <div style="border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#fff">
              ${renderedBody}
            </div>
          </div>

          <!-- Contact list -->
          <div style="padding:0 20px 16px">
            <p style="margin:16px 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Recipients</p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #f0f0f0;border-radius:4px;overflow:hidden">
              <thead>
                <tr style="background:#f8f9fb">
                  <th style="padding:6px 12px;text-align:left;font-size:11px;color:#999;font-weight:500">Name</th>
                  <th style="padding:6px 12px;text-align:left;font-size:11px;color:#999;font-weight:500">Company</th>
                  <th style="padding:6px 12px;text-align:left;font-size:11px;color:#999;font-weight:500">Title</th>
                  <th style="padding:6px 12px;text-align:left;font-size:11px;color:#999;font-weight:500">From</th>
                </tr>
              </thead>
              <tbody>${contactRows}</tbody>
            </table>
          </div>
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:24px">
<div style="max-width:700px;margin:0 auto">

  <!-- Header + approve button -->
  <div style="background:#1a1a2e;border-radius:8px 8px 0 0;padding:24px 28px;color:#fff">
    <h1 style="margin:0;font-size:20px;font-weight:600">Daily Outreach Digest</h1>
    <p style="margin:6px 0 0;opacity:0.7;font-size:14px">${today} &mdash; ${contacts.length} emails ready to send</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px 28px;text-align:center">
    <a href="${approveUrl}"
       style="display:inline-block;background:#16a34a;color:#fff;padding:13px 40px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">
      Approve &amp; Send All ${contacts.length} Emails
    </a>
    <p style="margin:10px 0 0;font-size:12px;color:#999">Emails will go out 9am–5pm UTC today &nbsp;·&nbsp; <a href="${viewUrl}" style="color:#666">View in platform</a></p>
  </div>

  <!-- One section per list with full template -->
  ${listSections}

  <!-- Footer approve again -->
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;padding:20px 28px;text-align:center;margin-top:-1px">
    <a href="${approveUrl}"
       style="display:inline-block;background:#16a34a;color:#fff;padding:13px 40px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">
      Approve &amp; Send All ${contacts.length} Emails
    </a>
  </div>

</div>
</body>
</html>`;

    // Send from a different connected account so it lands in the brand email inbox
    // (Gmail suppresses self-sent emails from showing in inbox)
    const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, oauth_tokens FROM email_accounts
       WHERE email != $1 AND is_active = true AND oauth_tokens != '{}'::jsonb
       LIMIT 1`,
      [BRAND_EMAIL]
    );

    if (!accountResult.rows[0]) {
      throw new Error('No secondary email account connected — cannot send digest');
    }

    const account = accountResult.rows[0];
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const emailLines = [
      `To: ${BRAND_EMAIL}`,
      `From: ${BRAND_NAME} Outreach <${account.email}>`,
      `Subject: [Outreach] ${contacts.length} contacts ready — ${today}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html,
    ].join('\n');

    const sendResult = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(emailLines).toString('base64url') },
    });

    // Store the thread ID so we can poll for replies later
    if (sendResult.data.threadId) {
      await query(
        `UPDATE daily_digest SET digest_gmail_thread_id = $1, digest_from_account_id = $2 WHERE id = $3`,
        [sendResult.data.threadId, account.id, digestId]
      );
    }

    console.log(`[Digest] Digest email sent for ${digest.digest_date} — ${contacts.length} contacts`);
  }

  async approve(digestId: string, token: string, overrideContacts?: DigestContact[]): Promise<DigestRecord> {
    const digestResult = await query<DigestRecord>(
      `SELECT * FROM daily_digest WHERE id = $1`, [digestId]
    );
    const digest = digestResult.rows[0];
    if (!digest) throw new Error('Digest not found');
    if (!safeEqual(token, String(digest.approval_token ?? ''))) throw new Error('Invalid approval token');
    if (digest.status !== 'pending') throw new Error(`Digest is already ${digest.status}`);
    // Approval links expire: refuse anything older than 72 hours
    if (Date.now() - new Date(digest.created_at).getTime() > APPROVAL_MAX_AGE_MS) {
      throw new Error('This approval link has expired (older than 72 hours)');
    }

    // Atomic transition: only one caller can move pending -> approved
    const updated = await query<DigestRecord>(
      `UPDATE daily_digest
       SET status = 'approved',
           approved_contacts = $1,
           approved_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [overrideContacts ? JSON.stringify(overrideContacts) : null, digestId]
    );
    if (!updated.rows[0]) throw new Error('Digest is no longer pending');

    return updated.rows[0];
  }

  async executeApproved(digestId: string): Promise<void> {
    const digestResult = await query<DigestRecord>(
      `SELECT * FROM daily_digest WHERE id = $1`, [digestId]
    );
    const digest = digestResult.rows[0];
    if (!digest) throw new Error('Digest not found');
    if (!['approved'].includes(digest.status)) throw new Error(`Digest status is ${digest.status}`);

    await query(`UPDATE daily_digest SET status = 'sending' WHERE id = $1`, [digestId]);

    const contacts = digest.approved_contacts || digest.contacts;
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setUTCHours(WINDOW_START_HOUR, 0, 0, 0);
    if (now > windowStart) {
      // If already past 9am, send relative to now
      windowStart.setTime(now.getTime());
    }

    let sent = 0;

    for (const contact of contacts) {
      try {
        // Check not already sent to this contact today
        const alreadySent = await query(
          `SELECT id FROM email_sends WHERE contact_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
          [contact.contact_id]
        );
        if (alreadySent.rows.length > 0) continue;

        // Render template
        const templateResult = await query<{ body_html: string; subject: string }>(
          `SELECT body_html, subject FROM templates WHERE id = $1`, [contact.template_id]
        );
        const template = templateResult.rows[0];
        if (!template) continue;

        // Simple merge field substitution
        const body = template.body_html
          .replace(/\{\{first_name\}\}/g, contact.first_name || 'there')
          .replace(/\{\{last_name\}\}/g, contact.last_name || '')
          .replace(/\{\{company\}\}/g, contact.company || '')
          .replace(/\{\{title\}\}/g, contact.title || '');

        const subject = template.subject
          .replace(/\{\{first_name\}\}/g, contact.first_name || 'there')
          .replace(/\{\{last_name\}\}/g, contact.last_name || '')
          .replace(/\{\{company\}\}/g, contact.company || '');

        const trackingId = require('crypto').randomBytes(16).toString('hex');

        // Schedule the send
        const sendAt = new Date(windowStart.getTime() + contact.scheduled_delay_ms);

        const sendResult = await query<{ id: string }>(
          `INSERT INTO email_sends
             (contact_id, email_account_id, to_email, from_email, subject, body_html,
              tracking_id, status, scheduled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)
           RETURNING id`,
          [
            contact.contact_id,
            contact.from_account_id,
            contact.email,
            contact.from_email,
            subject,
            body,
            trackingId,
            sendAt.toISOString(),
          ]
        );

        // Add to BullMQ with delay
        const { sendQueue } = await import('./send-queue');
        const delayMs = Math.max(0, sendAt.getTime() - Date.now());
        await sendQueue.add({ emailSendId: sendResult.rows[0].id }, delayMs);

        sent++;
      } catch (err) {
        console.error(`[Digest] Error queuing email for ${contact.email}:`, (err as Error).message);
      }
    }

    await query(
      `UPDATE daily_digest SET status = 'sent', sent_at = NOW(), emails_sent = $1 WHERE id = $2`,
      [sent, digestId]
    );

    console.log(`[Digest] Queued ${sent} emails for digest ${digestId}`);
  }

  async list(limit = 30): Promise<DigestRecord[]> {
    const result = await query<DigestRecord>(
      `SELECT id, digest_date, status, emails_sent, created_at, approved_at, sent_at,
              approval_token,
              jsonb_array_length(COALESCE(approved_contacts, contacts)) AS contact_count
       FROM daily_digest
       ORDER BY digest_date DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async get(digestId: string): Promise<DigestRecord | null> {
    const result = await query<DigestRecord>(
      `SELECT * FROM daily_digest WHERE id = $1`, [digestId]
    );
    return result.rows[0] || null;
  }

  async getByToken(token: string): Promise<DigestRecord | null> {
    const result = await query<DigestRecord>(
      `SELECT * FROM daily_digest WHERE approval_token = $1`, [token]
    );
    return result.rows[0] || null;
  }

  // Poll for replies to digest emails and apply any template edit instructions
  async checkForReplies(): Promise<void> {
    // Find digests sent in the last 3 days with a thread ID that haven't been replied-to yet
    const digestsResult = await query<DigestRecord>(
      `SELECT * FROM daily_digest
       WHERE digest_gmail_thread_id IS NOT NULL
         AND reply_processed_at IS NULL
         AND created_at > NOW() - INTERVAL '3 days'
       ORDER BY created_at DESC`
    );

    if (digestsResult.rows.length === 0) return;

    for (const digest of digestsResult.rows) {
      try {
        await this._processDigestReplies(digest);
      } catch (err) {
        console.error(`[Digest Reply] Error processing digest ${digest.id}:`, (err as Error).message);
      }
    }
  }

  private async _processDigestReplies(digest: DigestRecord): Promise<void> {
    const accountResult = await query<{ id: string; email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT id, email, oauth_tokens FROM email_accounts WHERE id = $1`, [digest.digest_from_account_id]
    );
    const account = accountResult.rows[0];
    if (!account) return;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get all messages in this thread
    const threadResult = await gmail.users.threads.get({
      userId: 'me',
      id: digest.digest_gmail_thread_id!,
      format: 'full',
    });

    const messages = threadResult.data.messages || [];
    // The first message is the original digest — replies are everything after
    if (messages.length <= 1) return;

    // Find the most recent reply FROM the brand email that we haven't processed
    const replies = messages.slice(1).filter(msg => {
      const from = msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
      return from.toLowerCase().includes(BRAND_EMAIL.toLowerCase());
    });

    if (replies.length === 0) return;

    // Get the latest reply body text
    const latestReply = replies[replies.length - 1];
    const replyText = this._extractMessageText(latestReply);
    if (!replyText || replyText.trim().length < 5) return;

    console.log(`[Digest Reply] Got reply for digest ${digest.id}: "${replyText.substring(0, 100)}..."`);

    // Mark as processed immediately to avoid double-processing
    await query(
      `UPDATE daily_digest SET reply_processed_at = NOW() WHERE id = $1`,
      [digest.id]
    );

    // Get all active templates with their list associations
    const templatesResult = await query<{ id: string; name: string; subject: string; list_name: string | null }>(
      `SELECT t.id, t.name, t.subject,
              (SELECT tr.list_name FROM template_rotations tr WHERE tr.template_id = t.id LIMIT 1) AS list_name
       FROM templates t
       WHERE t.is_active = true
       ORDER BY t.name`
    );

    const templateList = templatesResult.rows.map(t =>
      `- ID: ${t.id} | Name: ${t.name} | List: ${t.list_name || 'none'} | Subject: ${t.subject}`
    ).join('\n');

    // Ask Claude to parse the reply and determine which templates to edit and how
    const parseMessage = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You are helping manage email templates for ${BRAND_NAME}. Marcus has replied to his daily digest email with editing instructions.

Here are the available templates:
${templateList}

Here is Marcus's reply:
<reply>
${replyText}
</reply>

Parse the reply and identify any template edits requested. Return a JSON array (and nothing else) in this format:
[
  {
    "templateId": "<uuid>",
    "templateName": "<name>",
    "editPrompt": "<specific edit instruction to apply to this template>"
  }
]

If no edits are requested (e.g. just "thanks" or an approval message), return an empty array: []
Only include templates that need changing. Be specific in the editPrompt — it will be passed directly to an AI that edits the HTML.`,
        },
      ],
    });

    let edits: Array<{ templateId: string; templateName: string; editPrompt: string }> = [];
    try {
      const raw = (parseMessage.content[0] as { type: string; text: string }).text.trim();
      edits = JSON.parse(raw);
    } catch {
      console.error('[Digest Reply] Failed to parse Claude response as JSON');
      return;
    }

    if (edits.length === 0) {
      console.log('[Digest Reply] No edits requested in reply');
      return;
    }

    console.log(`[Digest Reply] Applying ${edits.length} template edits...`);

    const appliedEdits: string[] = [];

    for (const edit of edits) {
      try {
        // Fetch current template HTML
        const tmplResult = await query<{ body_html: string }>(
          `SELECT body_html FROM templates WHERE id = $1`, [edit.templateId]
        );
        if (!tmplResult.rows[0]) continue;

        const currentHtml = tmplResult.rows[0].body_html;

        // Apply the edit via Claude
        const editMessage = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          messages: [
            {
              role: 'user',
              content: `You are editing an HTML email template for ${BRAND_NAME}.

Here is the current HTML template:
<current_html>
${currentHtml}
</current_html>

Apply the following change:
<change_request>
${edit.editPrompt}
</change_request>

Rules:
- Return ONLY the complete, updated HTML — no explanation, no markdown code fences.
- Preserve all inline styles and the table-based email structure.
- Keep merge fields like {{first_name}} intact.
- Do not change anything not mentioned in the change request.`,
            },
          ],
        });

        const updatedHtml = (editMessage.content[0] as { type: string; text: string }).text.trim();

        // Save the updated template
        await query(
          `UPDATE templates SET body_html = $1, updated_at = NOW() WHERE id = $2`,
          [updatedHtml, edit.templateId]
        );

        appliedEdits.push(edit.templateName);
        console.log(`[Digest Reply] Updated template: ${edit.templateName}`);
      } catch (err) {
        console.error(`[Digest Reply] Failed to edit template ${edit.templateName}:`, (err as Error).message);
      }
    }

    if (appliedEdits.length === 0) return;

    // Send a confirmation reply in the same thread
    const confirmText = `Got it — I've updated ${appliedEdits.length === 1 ? 'the template' : `${appliedEdits.length} templates`}:\n\n${appliedEdits.map(n => `• ${n}`).join('\n')}\n\nChanges will apply from tomorrow's digest onwards.`;

    const replyLines = [
      `To: ${BRAND_EMAIL}`,
      `From: ${BRAND_NAME} Outreach <${account.email}>`,
      `Subject: Re: [Outreach] Digest edits applied`,
      `In-Reply-To: ${latestReply.id}`,
      `References: ${digest.digest_gmail_thread_id}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      confirmText,
    ].join('\n');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(replyLines).toString('base64url'),
        threadId: digest.digest_gmail_thread_id!,
      },
    });

    console.log(`[Digest Reply] Sent confirmation reply for ${appliedEdits.length} edits`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _extractMessageText(message: any): string {
    const payload = message.payload;
    if (!payload) return '';

    // Helper to decode base64url
    const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf-8');

    // Try to get plain text part
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findText = (part: any): string => {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decode(part.body.data);
      }
      if (part.parts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const p of part.parts as any[]) {
          const found = findText(p);
          if (found) return found;
        }
      }
      return '';
    };

    const raw = findText(payload);

    // Strip quoted reply content (lines starting with >, or "On ... wrote:")
    const lines = raw.split('\n');
    const cleaned: string[] = [];
    for (const line of lines) {
      if (line.startsWith('>') || line.match(/^On .* wrote:/)) break;
      cleaned.push(line);
    }

    return cleaned.join('\n').trim();
  }
}

export const digestService = new DigestService();
