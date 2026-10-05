/**
 * Gmail Scanner
 *
 * Polls Gmail sent + inbox for emails to/from contacts outside the sequence system.
 * - Sent: when support emails someone manually, add them as a contact
 * - Received: when someone emails in, add them and trigger AI classification
 *
 * Runs every 10 minutes via cron. Tracks processed message IDs to avoid duplicates.
 */

import { google } from 'googleapis';
import { query } from '../db/connection';

const TENANT = process.env.TENANT || 'tp';
import { gmailClient } from './gmail-client';
import { contactClassifier } from './contact-classifier';
import { EmailAccount } from '../types';

// Email addresses/domains that should never be added as contacts
const SKIP_PATTERNS = [
  /no.?reply/i,
  /noreply/i,
  /donotreply/i,
  /bounce/i,
  /mailer-daemon/i,
  /postmaster/i,
  /notifications?@/i,
  /updates?@/i,
  /support@/i,
  /info@/i,
  /invoice/i,
  /billing/i,
  /statement/i,
  /receipt/i,
  /payment/i,
  /accounts?@/i,
  /@tp\.finance$/i,
  /apollomailtester\.com$/i,
];

// Domains that are definitely test/junk
const SKIP_DOMAINS = new Set([
  'apollomailtester.com',
  'mailinator.com',
  'guerrillamail.com',
  'tempmail.com',
  'throwam.com',
  'yopmail.com',
]);

// Always look back 24 hours — no 365-day historical sweep
const LOOKBACK_HOURS = 24;

// Only scan this account — other accounts are outreach-only senders
const SCAN_ACCOUNT = 'marcus@tp.finance';

interface ParsedEmail {
  email: string;
  name: string;
}

function parseEmailHeader(header: string): ParsedEmail | null {
  if (!header) return null;
  // "First Last <email@domain.com>" or just "email@domain.com"
  const match = header.match(/^(?:"?([^"<]+)"?\s*)?<?([^\s<>@]+@[^\s<>@]+)>?$/);
  if (!match) return null;
  const name = (match[1] || '').trim();
  const email = (match[2] || '').trim().toLowerCase();
  if (!email.includes('@')) return null;

  // Must look like a real email: local part ≥ 2 chars, domain has a dot
  const [local, domain] = email.split('@');
  if (!local || local.length < 2) return null;
  if (!domain || !domain.includes('.')) return null;

  return { email, name };
}

function shouldSkipEmail(email: string): boolean {
  if (SKIP_PATTERNS.some(p => p.test(email))) return true;
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (SKIP_DOMAINS.has(domain)) return true;
  return false;
}

function extractDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() || '';
}

export class GmailScanner {

  async scanAllAccounts(): Promise<void> {
    const accounts = await gmailClient.getActiveAccounts();
    const account = accounts.find(a => a.email === SCAN_ACCOUNT);
    if (!account) {
      console.log(`[Gmail Scanner] Account ${SCAN_ACCOUNT} not found or inactive — skipping`);
      return;
    }

    try {
      await this.scanAccount(account);
    } catch (err) {
      console.error(`[Gmail Scanner] Error scanning ${account.email}:`, (err as Error).message);
    }

    await contactClassifier.classifyPending(50);
  }

  private async scanAccount(account: EmailAccount): Promise<void> {
    const auth = await gmailClient.getAuthenticatedClient(account);

    const gmail = google.gmail({ version: 'v1', auth });

    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

    const afterTs = Math.floor(since.getTime() / 1000);
    console.log(`[Gmail Scanner] Scanning ${account.email} since ${since.toISOString()}`);

    let newContacts = 0;

    // Scan sent mail (exclude spam/trash/junk)
    newContacts += await this.scanFolder(gmail, account, `in:sent -in:spam -in:trash after:${afterTs}`, 'sent');

    // Scan inbox (exclude spam/trash/junk)
    newContacts += await this.scanFolder(gmail, account, `in:inbox -in:spam -in:trash after:${afterTs}`, 'received');

    // Update last scan time
    await this.setLastScanTime(account.id);

    if (newContacts > 0) {
      console.log(`[Gmail Scanner] ${account.email} — ${newContacts} new contact(s) added`);
    }
  }

  private async scanFolder(
    gmail: ReturnType<typeof google.gmail>,
    account: EmailAccount,
    query_: string,
    direction: 'sent' | 'received'
  ): Promise<number> {
    let newContacts = 0;
    let pageToken: string | undefined;

    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query_,
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });

      const messages = listRes.data.messages || [];
      pageToken = listRes.data.nextPageToken || undefined;

      for (const msg of messages) {
        if (!msg.id) continue;

        // Skip already-processed messages
        if (await this.isScanned(account.id, msg.id)) continue;

        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject'],
          });

          const headers = detail.data.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

          // For sent: extract To/Cc recipients
          // For received: extract From sender
          const targets: ParsedEmail[] = [];

          if (direction === 'sent') {
            for (const header of ['To', 'Cc']) {
              const val = getHeader(header);
              if (!val) continue;
              for (const part of val.split(',')) {
                const parsed = parseEmailHeader(part.trim());
                if (parsed) targets.push(parsed);
              }
            }
          } else {
            const from = parseEmailHeader(getHeader('From'));
            if (from) targets.push(from);
          }

          for (const target of targets) {
            if (shouldSkipEmail(target.email)) continue;
            if (target.email === account.email) continue; // skip self

            const added = await this.upsertContactFromGmail(target, direction);
            if (added) newContacts++;

            // Mark message as scanned
            await this.markScanned(account.id, msg.id, direction, target.email);
          }

          // If no valid targets, still mark scanned so we don't re-fetch
          if (targets.length === 0) {
            await this.markScanned(account.id, msg.id, direction, null);
          }
        } catch (err) {
          console.warn(`[Gmail Scanner] Error fetching message ${msg.id}:`, (err as Error).message);
          // Mark as scanned to avoid re-fetching a broken message
          await this.markScanned(account.id, msg.id, direction, null);
        }
      }

    } while (pageToken);

    return newContacts;
  }

  /**
   * Add contact to DB if not already present.
   * Returns true if a new contact was created.
   */
  private async upsertContactFromGmail(
    parsed: ParsedEmail,
    direction: 'sent' | 'received'
  ): Promise<boolean> {
    const email = parsed.email.toLowerCase().trim();
    const domain = extractDomain(email);

    // Check if already exists as a contact
    const existing = await query<{ id: string }>(
      `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
      [email, TENANT]
    );

    if (existing.rows[0]) {
      // Contact exists — nothing to do (classification handles upgrading)
      return false;
    }

    // Check if already on any list (Introducers, Clients, Lenders) via Apollo/CSV contacts
    const onList = await query<{ id: string }>(
      `SELECT c.id FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       WHERE LOWER(c.email) = $1 AND c.tenant = $2
       LIMIT 1`,
      [email, TENANT]
    );

    if (onList.rows[0]) {
      return false;
    }

    // Never re-create suppressed (incl. user-deleted) addresses or domains
    const suppressed = await query<{ id: string }>(
      `SELECT id FROM suppressed_emails
       WHERE tenant = $1 AND (LOWER(email) = $2 OR LOWER(domain) = $3)
       LIMIT 1`,
      [TENANT, email, domain.toLowerCase()]
    );
    if (suppressed.rows[0]) {
      return false;
    }

    // Parse name parts
    const nameParts = parsed.name.split(' ').filter(Boolean);
    const firstName = nameParts[0] || null;
    const lastName = nameParts.slice(1).join(' ') || null;

    // Derive company_domain from email domain (exclude common personal domains)
    const personalDomains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'live.com'];
    const companyDomain = personalDomains.includes(domain) ? null : domain;

    const inserted = await query<{ id: string }>(
      `INSERT INTO contacts (
         email, first_name, last_name, company_domain, source, tenant, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'gmail', $5, NOW(), NOW())
       ON CONFLICT (tenant, (lower(email::text))) DO NOTHING
       RETURNING id`,
      [email, firstName, lastName, companyDomain, TENANT]
    );
    if (!inserted.rows[0]) return false;

    console.log(`[Gmail Scanner] New contact from ${direction}: ${email}${companyDomain ? ` (${companyDomain})` : ''}`);
    return true;
  }

  private async getLastScanTime(accountId: string): Promise<Date | null> {
    const result = await query<{ scanned_at: Date }>(
      `SELECT MAX(scanned_at) AS scanned_at
       FROM gmail_scanned_messages
       WHERE account_id = $1 AND tenant = $2`,
      [accountId, TENANT]
    );
    return result.rows[0]?.scanned_at || null;
  }

  private async setLastScanTime(accountId: string): Promise<void> {
    // Prune old scanned records older than 60 days to keep table lean
    await query(
      `DELETE FROM gmail_scanned_messages
       WHERE account_id = $1 AND scanned_at < NOW() - INTERVAL '60 days'`,
      [accountId]
    );
  }

  private async isScanned(accountId: string, messageId: string): Promise<boolean> {
    const result = await query<{ id: string }>(
      `SELECT id FROM gmail_scanned_messages WHERE account_id = $1 AND gmail_message_id = $2`,
      [accountId, messageId]
    );
    return result.rows.length > 0;
  }

  private async markScanned(
    accountId: string,
    messageId: string,
    direction: 'sent' | 'received',
    contactEmail: string | null
  ): Promise<void> {
    await query(
      `INSERT INTO gmail_scanned_messages (account_id, gmail_message_id, direction, contact_email, tenant)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, gmail_message_id) DO NOTHING`,
      [accountId, messageId, direction, contactEmail, TENANT]
    );
  }
}

export const gmailScanner = new GmailScanner();
