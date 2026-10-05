import axios from 'axios';
import { query, TENANT } from '../db/connection';
import { Contact } from '../types';

interface ApolloContact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  organization_name: string | null;
  organization?: { primary_domain?: string };
  linkedin_url: string | null;
  phone_numbers?: Array<{ raw_number: string }>;
  city: string | null;
  country: string | null;
  label_names?: string[];
  email_status?: string;
}

interface ApolloSearchResponse {
  contacts: ApolloContact[];
  pagination: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
}

export class ApolloSyncService {
  private apiKey: string;
  private baseUrl = 'https://api.apollo.io/v1';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.APOLLO_API_KEY || '';
  }

  async startSync(syncType: 'full' | 'incremental'): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO apollo_sync_log (sync_type, status) VALUES ($1, 'running') RETURNING id`,
      [syncType]
    );
    return result.rows[0].id;
  }

  async finishSync(
    logId: string,
    status: 'completed' | 'failed',
    contactsAdded: number,
    contactsUpdated: number,
    errorMessage?: string
  ): Promise<void> {
    await query(
      `UPDATE apollo_sync_log
       SET status = $1, contacts_added = $2, contacts_updated = $3,
           error_message = $4, completed_at = NOW()
       WHERE id = $5`,
      [status, contactsAdded, contactsUpdated, errorMessage || null, logId]
    );
  }

  async syncContacts(syncType: 'full' | 'incremental' = 'incremental'): Promise<void> {
    if (!this.apiKey) {
      console.warn('[Apollo Sync] No API key configured, skipping sync');
      return;
    }

    const logId = await this.startSync(syncType);
    let contactsAdded = 0;
    let contactsUpdated = 0;

    try {
      console.log(`[Apollo Sync] Starting ${syncType} sync...`);

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const params: Record<string, unknown> = {
          page,
          per_page: 100,
          contact_email_status: ['verified', 'guessed', 'unverified'],
        };

        if (syncType === 'incremental') {
          // Only sync contacts updated in the last N hours
          const hoursResult = await query<{ value: string }>(
            `SELECT value FROM settings WHERE key = 'apollo_sync_interval_hours'`
          );
          const hours = hoursResult.rows[0]?.value
            ? parseInt(JSON.parse(hoursResult.rows[0].value), 10)
            : 6;
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          params['updated_at_after'] = since.toISOString();
        }

        const response = await axios.post<ApolloSearchResponse>(
          `${this.baseUrl}/contacts/search`,
          params,
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': this.apiKey,
            },
            timeout: 30000,
          }
        );

        const { contacts, pagination } = response.data;

        if (!contacts || contacts.length === 0) {
          hasMore = false;
          break;
        }

        for (const apolloContact of contacts) {
          const result = await this.upsertContact(apolloContact);
          if (result === 'added') contactsAdded++;
          else if (result === 'updated') contactsUpdated++;
        }

        console.log(
          `[Apollo Sync] Page ${page}/${pagination.total_pages} - Added: ${contactsAdded}, Updated: ${contactsUpdated}`
        );

        hasMore = page < pagination.total_pages;
        page++;

        // Rate limiting: 100ms between requests
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await this.finishSync(logId, 'completed', contactsAdded, contactsUpdated);
      console.log(
        `[Apollo Sync] Completed. Added: ${contactsAdded}, Updated: ${contactsUpdated}`
      );
    } catch (err) {
      const error = err as Error;
      console.error('[Apollo Sync] Error during sync:', error.message);
      await this.finishSync(logId, 'failed', contactsAdded, contactsUpdated, error.message);
      throw err;
    }
  }

  private async upsertContact(apolloContact: ApolloContact): Promise<'added' | 'updated' | 'skipped'> {
    if (!apolloContact.email) return 'skipped';

    const email = apolloContact.email.toLowerCase().trim();
    const phone =
      apolloContact.phone_numbers && apolloContact.phone_numbers.length > 0
        ? apolloContact.phone_numbers[0].raw_number
        : null;
    const tags = apolloContact.label_names || [];
    const emailVerified = apolloContact.email_status === 'verified';

    try {
      const suppressed = await query<{ id: string }>(
        `SELECT id FROM suppressed_emails WHERE LOWER(email) = $1 AND tenant = $2 LIMIT 1`,
        [email, TENANT]
      );
      if (suppressed.rows.length > 0) {
        return 'skipped';
      }

      const existing = await query<{ id: string }>(
        `SELECT id FROM contacts WHERE LOWER(email) = $1`,
        [email]
      );

      if (existing.rows.length > 0) {
        await query(
          `UPDATE contacts SET
            apollo_id = COALESCE(
              CASE WHEN $1::text IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM contacts c2
                     WHERE c2.apollo_id = $1 AND LOWER(c2.email) <> $13
                   )
                   THEN $1::text ELSE NULL END,
              apollo_id),
            first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            title = COALESCE($4, title),
            company = COALESCE($5, company),
            company_domain = COALESCE($6, company_domain),
            linkedin_url = COALESCE($7, linkedin_url),
            phone = COALESCE($8, phone),
            city = COALESCE($9, city),
            country = COALESCE($10, country),
            tags = $11,
            email_verified = $12,
            last_synced_at = NOW(),
            updated_at = NOW()
          WHERE LOWER(email) = $13`,
          [
            apolloContact.id,
            apolloContact.first_name,
            apolloContact.last_name,
            apolloContact.title,
            apolloContact.organization_name,
            apolloContact.organization?.primary_domain,
            apolloContact.linkedin_url,
            phone,
            apolloContact.city,
            apolloContact.country,
            tags,
            emailVerified,
            email,
          ]
        );
        return 'updated';
      } else {
        await query(
          `INSERT INTO contacts (
            apollo_id, email, first_name, last_name, title, company,
            company_domain, linkedin_url, phone, city, country, tags,
            email_verified, source, last_synced_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'apollo', NOW())
          ON CONFLICT (apollo_id) DO NOTHING`,
          [
            apolloContact.id,
            email,
            apolloContact.first_name,
            apolloContact.last_name,
            apolloContact.title,
            apolloContact.organization_name,
            apolloContact.organization?.primary_domain,
            apolloContact.linkedin_url,
            phone,
            apolloContact.city,
            apolloContact.country,
            tags,
            emailVerified,
          ]
        );
        return 'added';
      }
    } catch (err) {
      const error = err as Error;
      console.error(`[Apollo Sync] Error upserting contact ${email}:`, error.message);
      return 'skipped';
    }
  }

  async getRecentSyncLogs(limit = 10) {
    const result = await query(
      `SELECT * FROM apollo_sync_log ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

export const apolloSyncService = new ApolloSyncService();
