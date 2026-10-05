/**
 * Campaign Engine — Blast Mode
 *
 * Processes scheduled blast sends from sequences WHERE type = 'blast'.
 * Each blast sequence has sequence_steps with sector, subject_line, body_copy, etc.
 *
 * Flow:
 * 1. tick() is called hourly by worker.ts (or manually via API)
 * 2. Finds blast sequences WHERE status = 'active'
 * 3. Finds steps where calculated send_date <= today AND blast_status = 'approved'
 * 4. For each due step, finds eligible contacts in that sector
 * 5. Creates email_sends records and queues via BullMQ
 */

import { query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
import { gmailClient } from './gmail-client';
import { templateEngine } from './template-engine';
import { sendQueue } from './send-queue';
import { checkSendWindow } from './send-gate';
import { Contact, Template } from '../types';

// Introducer sector names — contacts in these sectors use the introducer template
const INTRODUCER_SECTORS = new Set([
  'accountant', 'advisory', 'agent', 'lawyer',
  'surveyor', 'wealth', 'construction', 'planning / architect',
  'architect', 'planning',
]);

interface BlastSequence {
  id: string;
  frequency_days: number;
  start_date: string;
}

interface BlastStep {
  id: string;
  sequence_id: string;
  step_number: number;
  sector: string;
  subject_line: string;
  body_copy: string;
  hero_image: string;
  article_slug: string | null;
  article_title: string | null;
  article_excerpt: string | null;
  template_id: string | null;
  blast_status: string;
}

interface TickResult {
  ran: boolean;
  reason?: string;
  due_entries: number;
  contacts_queued: number;
  contacts_skipped: number;
  errors: string[];
}

export class CampaignEngine {
  private running = false;
  private lastRunAt: Date | null = null;
  private lastResult: TickResult | null = null;

  /**
   * Main tick — called hourly by worker or manually via API.
   */
  async tick(): Promise<TickResult> {
    if (this.running) {
      return { ran: false, reason: 'Already running', due_entries: 0, contacts_queued: 0, contacts_skipped: 0, errors: [] };
    }

    this.running = true;
    const result: TickResult = { ran: true, due_entries: 0, contacts_queued: 0, contacts_skipped: 0, errors: [] };

    try {
      // Window guard — don't create or queue blast emails outside business hours
      const outsideWindow = checkSendWindow('09:00', '17:00', true);
      if (outsideWindow && outsideWindow.action !== 'send') {
        result.ran = false;
        result.reason = outsideWindow.reason;
        return result;
      }

      // 1. Find active blast sequences for this tenant
      const blastSeq = await this.getActiveBlastSequence();
      if (!blastSeq) {
        result.ran = false;
        result.reason = 'No active blast campaign';
        return result;
      }

      // 2. Find steps that are due today or earlier
      const today = new Date().toISOString().split('T')[0];
      const dueSteps = await this.getDueSteps(blastSeq, today);
      result.due_entries = dueSteps.length;

      if (dueSteps.length === 0) {
        result.reason = 'No sends due today';
        return result;
      }

      console.log(`[Campaign Engine] ${dueSteps.length} blast sends due on or before ${today}`);

      // 3. Get the two base templates
      const clientTemplate = await this.getTemplateByName('Client — Sector Personalised');
      const introducerTemplate = await this.getTemplateByName('Introducer — Sector Personalised');

      // 4. Process each due step
      for (const step of dueSteps) {
        try {
          const entryResult = await this.processStep(step, blastSeq, clientTemplate, introducerTemplate);
          result.contacts_queued += entryResult.queued;
          result.contacts_skipped += entryResult.skipped;
        } catch (err) {
          const msg = `Error processing ${step.sector} #${step.step_number}: ${(err as Error).message}`;
          console.error(`[Campaign Engine] ${msg}`);
          result.errors.push(msg);
        }
      }

      console.log(`[Campaign Engine] Tick complete: ${result.contacts_queued} queued, ${result.contacts_skipped} skipped, ${result.errors.length} errors`);
    } catch (err) {
      result.errors.push((err as Error).message);
      console.error('[Campaign Engine] Tick failed:', (err as Error).message);
    } finally {
      this.running = false;
      this.lastRunAt = new Date();
      this.lastResult = result;
    }

    return result;
  }

  getStatus() {
    return {
      running: this.running,
      last_run_at: this.lastRunAt?.toISOString() || null,
      last_result: this.lastResult,
    };
  }

  private async getActiveBlastSequence(): Promise<BlastSequence | null> {
    const result = await query<BlastSequence>(
      `SELECT id, frequency_days, start_date
       FROM sequences
       WHERE tenant = $1 AND type = 'blast' AND status = 'active'
       LIMIT 1`,
      [TENANT]
    );
    return result.rows[0] || null;
  }

  /**
   * Find blast steps where the calculated send date <= today
   * and blast_status = 'approved'.
   *
   * Each sector's steps have a send_number derived from their position within the sector.
   * Send date = start_date + (send_number_within_sector - 1) * frequency_days
   */
  private async getDueSteps(seq: BlastSequence, today: string): Promise<BlastStep[]> {
    const result = await query<BlastStep>(
      `WITH sector_numbered AS (
        SELECT ss.*,
          ROW_NUMBER() OVER (PARTITION BY ss.sector ORDER BY ss.step_number) AS send_number
        FROM sequence_steps ss
        WHERE ss.sequence_id = $1 AND ss.blast_status = 'approved'
      )
      SELECT *
      FROM sector_numbered
      WHERE ($2::date + ((send_number - 1) * $3) * INTERVAL '1 day')::date <= $4::date
      ORDER BY send_number, sector`,
      [seq.id, seq.start_date, seq.frequency_days, today]
    );
    return result.rows;
  }

  /**
   * Process a single blast step: find eligible contacts in sector, queue sends.
   */
  private async processStep(
    step: BlastStep,
    _seq: BlastSequence,
    clientTemplate: Template | null,
    introducerTemplate: Template | null
  ): Promise<{ queued: number; skipped: number }> {
    let queued = 0;
    let skipped = 0;

    const isIntroducerSector = INTRODUCER_SECTORS.has(step.sector.toLowerCase());
    const baseTemplate = isIntroducerSector ? introducerTemplate : clientTemplate;

    // Find contacts in this sector who haven't already been sent this step
    const contacts = await query<Contact>(
      `SELECT c.*
       FROM contacts c
       WHERE c.tenant = $1
         AND (
           SPLIT_PART(c.custom_fields->>'sector', ',', 1) = $2
           OR TRIM(SPLIT_PART(c.custom_fields->>'sector', ',', 1)) = $2
           OR UPPER(TRIM(SPLIT_PART(c.custom_fields->>'sector', ',', 1))) = UPPER($2)
         )
         AND NOT EXISTS (
           SELECT 1 FROM email_sends es
           WHERE es.sequence_step_id = $3 AND es.contact_id = c.id
         )
         AND NOT ('unsubscribed' = ANY(c.tags))
         AND c.email IS NOT NULL
         AND c.email != ''
       ORDER BY c.created_at
       LIMIT 50`,
      [TENANT, step.sector, step.id]
    );

    if (contacts.rows.length === 0) {
      // All contacts already sent — mark step as sent
      const existingSends = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM email_sends WHERE sequence_step_id = $1`,
        [step.id]
      );
      if (parseInt(existingSends.rows[0]?.count || '0') > 0) {
        await query(
          `UPDATE sequence_steps SET blast_status = 'sent', updated_at = NOW() WHERE id = $1`,
          [step.id]
        );
      }
      return { queued, skipped };
    }

    console.log(`[Campaign Engine] ${step.sector} step ${step.step_number}: ${contacts.rows.length} contacts eligible`);

    const account = await gmailClient.getBestSendingAccount([]);
    if (!account) {
      throw new Error('No sending account available (all at limit)');
    }

    for (const contact of contacts.rows) {
      try {
        if (!contact.email || !contact.email.includes('@')) {
          skipped++;
          continue;
        }

        const { subject, bodyHtml } = this.buildBlastEmail(step, contact, baseTemplate);

        const sendResult = await query<{ id: string }>(
          `INSERT INTO email_sends (
            contact_id, email_account_id, template_id, sequence_step_id,
            to_email, from_email, subject, body_html, status, tenant
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9)
          RETURNING id`,
          [
            contact.id,
            account.id,
            step.template_id,
            step.id,
            contact.email,
            account.email,
            subject,
            bodyHtml,
            TENANT,
          ]
        );

        await sendQueue.add({ emailSendId: sendResult.rows[0].id, fromName: account.display_name || undefined });
        queued++;
      } catch (err) {
        console.error(`[Campaign Engine] Failed to queue for ${contact.email}: ${(err as Error).message}`);
        skipped++;
      }
    }

    // Check if all contacts have been processed
    const remaining = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM contacts c
       WHERE c.tenant = $1
         AND (
           SPLIT_PART(c.custom_fields->>'sector', ',', 1) = $2
           OR TRIM(SPLIT_PART(c.custom_fields->>'sector', ',', 1)) = $2
           OR UPPER(TRIM(SPLIT_PART(c.custom_fields->>'sector', ',', 1))) = UPPER($2)
         )
         AND NOT EXISTS (
           SELECT 1 FROM email_sends es
           WHERE es.sequence_step_id = $3 AND es.contact_id = c.id
         )
         AND NOT ('unsubscribed' = ANY(c.tags))`,
      [TENANT, step.sector, step.id]
    );

    if (parseInt(remaining.rows[0]?.count || '0') === 0) {
      await query(
        `UPDATE sequence_steps SET blast_status = 'sent', updated_at = NOW() WHERE id = $1`,
        [step.id]
      );
      console.log(`[Campaign Engine] ${step.sector} step ${step.step_number} fully sent`);
    }

    return { queued, skipped };
  }

  /**
   * Build the full email HTML for a blast send.
   */
  private buildBlastEmail(
    step: BlastStep,
    contact: Contact,
    baseTemplate: Template | null
  ): { subject: string; bodyHtml: string } {
    const mergeData = templateEngine.buildMergeData(contact);
    let subject = step.subject_line || '';
    for (const [key, val] of Object.entries(mergeData)) {
      if (val) subject = subject.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }

    let body = step.body_copy || '';
    for (const [key, val] of Object.entries(mergeData)) {
      if (val) body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }

    return {
      subject,
      bodyHtml: this.buildFullEmail(step, contact, mergeData, body),
    };
  }

  /**
   * Build the full branded email HTML matching the clean sequence template format.
   */
  private buildFullEmail(
    _step: BlastStep,
    _contact: Contact,
    _mergeData: Record<string, string | undefined>,
    renderedBody: string
  ): string {
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0f1a2e;padding:16px 28px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">TP</span><span style="color:#9ca3af;font-size:12px;margin-left:8px;font-family:Arial,sans-serif;">Turning Point Capital</span></td>
</tr></table>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#4db8a4,#74DFF6);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 24px;font-family:Arial,sans-serif;">
<div style="font-size:15px;line-height:1.7;color:#374151;">
${renderedBody}
</div>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:20px 28px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#374151;">Kind regards,</p>
<img src="https://res.cloudinary.com/dfqfrd5l0/image/upload/v1779917807/tp-outreach/marcus-signature.gif" width="400" alt="Marcus Emadi - Director - Turning Point Capital Advisory" style="display:block;max-width:400px;width:100%;height:auto;" />
</td></tr>
<tr><td style="background:#f8f9fb;padding:12px 28px;border-top:1px solid #e5e7eb;text-align:center;">
<p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Turning Point Capital Advisory Ltd · London · <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr>
</table>`;
  }

  private async getTemplateByName(name: string): Promise<Template | null> {
    const result = await query<Template>(
      `SELECT * FROM templates WHERE name = $1 AND tenant = $2 LIMIT 1`,
      [name, TENANT]
    );
    return result.rows[0] || null;
  }

  /**
   * Get recent blast send log for the UI.
   * Uses email_sends with sequence_step_id to track blast sends.
   */
  async getLog(limit = 50): Promise<unknown[]> {
    const result = await query(
      `SELECT
        es.status as email_status,
        es.sent_at as email_sent_at,
        es.created_at,
        es.error_message,
        ss.sector,
        ss.step_number,
        ss.subject_line,
        c.email,
        c.first_name,
        c.last_name,
        c.company
      FROM email_sends es
      JOIN sequence_steps ss ON ss.id = es.sequence_step_id
      JOIN sequences s ON s.id = ss.sequence_id
      JOIN contacts c ON c.id = es.contact_id
      WHERE s.tenant = $1 AND s.type = 'blast'
      ORDER BY es.created_at DESC
      LIMIT $2`,
      [TENANT, limit]
    );
    return result.rows;
  }

  /**
   * Get stats for the engine status panel.
   */
  async getStats(): Promise<{
    total_scheduled: number;
    approved: number;
    sent: number;
    draft: number;
    sends_today: number;
    sends_total: number;
    next_due: string | null;
  }> {
    // Find the blast sequence for this tenant
    const seqResult = await query<{ id: string; frequency_days: number; start_date: string }>(
      `SELECT id, frequency_days, start_date FROM sequences WHERE tenant = $1 AND type = 'blast' LIMIT 1`,
      [TENANT]
    );
    const seq = seqResult.rows[0];

    if (!seq) {
      return { total_scheduled: 0, approved: 0, sent: 0, draft: 0, sends_today: 0, sends_total: 0, next_due: null };
    }

    const counts = await query<{ blast_status: string; count: string }>(
      `SELECT blast_status, COUNT(*) as count FROM sequence_steps WHERE sequence_id = $1 GROUP BY blast_status`,
      [seq.id]
    );

    const statusMap: Record<string, number> = {};
    for (const row of counts.rows) {
      statusMap[row.blast_status] = parseInt(row.count);
    }

    const sendsToday = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_sends es
       JOIN sequence_steps ss ON ss.id = es.sequence_step_id
       WHERE ss.sequence_id = $1 AND es.created_at::date = CURRENT_DATE`,
      [seq.id]
    );

    const sendsTotal = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_sends es
       JOIN sequence_steps ss ON ss.id = es.sequence_step_id
       WHERE ss.sequence_id = $1`,
      [seq.id]
    );

    // Find next due date
    let nextDue: string | null = null;
    if (seq.frequency_days && seq.start_date) {
      const nextResult = await query<{ next_date: string }>(
        `WITH sector_numbered AS (
          SELECT ss.id,
            ROW_NUMBER() OVER (PARTITION BY ss.sector ORDER BY ss.step_number) AS send_number
          FROM sequence_steps ss
          WHERE ss.sequence_id = $1 AND ss.blast_status = 'approved'
        )
        SELECT ($2::date + ((send_number - 1) * $3) * INTERVAL '1 day')::date as next_date
        FROM sector_numbered
        ORDER BY next_date ASC
        LIMIT 1`,
        [seq.id, seq.start_date, seq.frequency_days]
      );
      nextDue = nextResult.rows[0]?.next_date || null;
    }

    return {
      total_scheduled: Object.values(statusMap).reduce((a, b) => a + b, 0),
      approved: statusMap.approved || 0,
      sent: statusMap.sent || 0,
      draft: statusMap.draft || 0,
      sends_today: parseInt(sendsToday.rows[0]?.count || '0'),
      sends_total: parseInt(sendsTotal.rows[0]?.count || '0'),
      next_due: nextDue,
    };
  }
}

export const campaignEngine = new CampaignEngine();
