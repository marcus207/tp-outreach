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
  updated_at?: string;
}

// Tags that must survive every sync, whatever Apollo says
const PROTECTED_TAGS = ['unsubscribed', 'bounced', 'hold'];

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
    // Disabled Oct 2026: the sync overwrote unsubscribe tags and re-imported lenders.
    // Root causes fixed Oct 5 (tags merge, tenant-scoped queries, suppression by
    // email+domain, new contacts unclassified). Still opt-in explicitly.
    if (process.env.APOLLO_SYNC_ENABLED !== 'true') {
      console.warn('[Apollo Sync] Disabled (APOLLO_SYNC_ENABLED != true), skipping sync');
      return;
    }

    const logId = await this.startSync(syncType);
    let contactsAdded = 0;
    let contactsUpdated = 0;

    try {
      console.log(`[Apollo Sync] Starting ${syncType} sync...`);

      // Incremental = contacts Apollo updated since the last successful sync
      // (minus a 1h overlap). Apollo's contacts/search has no updated-since
      // filter, so sort newest-updated first and stop paging at the cutoff.
      let since: Date | null = null;
      if (syncType === 'incremental') {
        since = await this.getIncrementalSince(logId);
        console.log(`[Apollo Sync] Incremental since ${since.toISOString()}`);
      }

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const params: Record<string, unknown> = {
          page,
          per_page: 100,
          contact_email_status: ['verified', 'guessed', 'unverified'],
        };

        if (since) {
          params['sort_by_field'] = 'contact_updated_at';
          params['sort_ascending'] = false;
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

        let reachedCutoff = false;
        for (const apolloContact of contacts) {
          if (since && apolloContact.updated_at && new Date(apolloContact.updated_at) < since) {
            reachedCutoff = true;
            break;
          }
          const result = await this.upsertContact(apolloContact);
          if (result === 'added') contactsAdded++;
          else if (result === 'updated') contactsUpdated++;
        }

        console.log(
          `[Apollo Sync] Page ${page}/${pagination.total_pages} - Added: ${contactsAdded}, Updated: ${contactsUpdated}`
        );

        hasMore = !reachedCutoff && page < pagination.total_pages;
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

  /**
   * Cutoff for an incremental sync: start of the last completed sync (1h
   * overlap), falling back to apollo_sync_interval_hours (default 6h).
   * NOTE: apollo_sync_log has no tenant column, so this is shared across tenants.
   */
  private async getIncrementalSince(currentLogId: string): Promise<Date> {
    const last = await query<{ started_at: Date }>(
      `SELECT started_at FROM apollo_sync_log
       WHERE status = 'completed' AND id <> $1
       ORDER BY started_at DESC LIMIT 1`,
      [currentLogId]
    );
    if (last.rows[0]?.started_at) {
      return new Date(new Date(last.rows[0].started_at).getTime() - 60 * 60 * 1000);
    }
    const hoursResult = await query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'apollo_sync_interval_hours'`
    );
    const hours = hoursResult.rows[0]?.value
      ? parseInt(JSON.parse(hoursResult.rows[0].value), 10)
      : 6;
    return new Date(Date.now() - hours * 60 * 60 * 1000);
  }

  private async upsertContact(apolloContact: ApolloContact): Promise<'added' | 'updated' | 'skipped'> {
    if (!apolloContact.email) return 'skipped';

    const email = apolloContact.email.toLowerCase().trim();
    const domain = (email.split('@')[1] || '').toLowerCase();
    const phone =
      apolloContact.phone_numbers && apolloContact.phone_numbers.length > 0
        ? apolloContact.phone_numbers[0].raw_number
        : null;
    // Apollo labels are only ever ADDED to existing tags (never replace them)
    const apolloTags = (apolloContact.label_names || []).filter(t => !!t);
    const emailVerified = apolloContact.email_status === 'verified';

    try {
      // Suppressed (exact email or whole domain) — never insert or update
      const suppressed = await query<{ id: string }>(
        `SELECT id FROM suppressed_emails
         WHERE tenant = $2 AND (LOWER(email) = $1 OR LOWER(domain) = $3)
         LIMIT 1`,
        [email, TENANT, domain]
      );
      if (suppressed.rows.length > 0) {
        return 'skipped';
      }

      const existing = await query<{ id: string; tags: string[] | null }>(
        `SELECT id, tags FROM contacts WHERE tenant = $1 AND LOWER(email) = $2`,
        [TENANT, email]
      );

      if (existing.rows.length > 0) {
        // Union of existing tags and Apollo labels; protected tags can't be dropped
        const current = existing.rows[0].tags || [];
        const merged = Array.from(new Set([...current, ...apolloTags]));
        for (const t of PROTECTED_TAGS) {
          if (current.includes(t) && !merged.includes(t)) merged.push(t);
        }

        // contact_type / subsector / tenant / list membership are never touched here
        const upd = await query(
          `UPDATE contacts SET
            apollo_id = COALESCE(
              CASE WHEN $1::text IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM contacts c2
                     WHERE c2.apollo_id = $1 AND c2.id <> $14
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
            tags = ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(tags, '{}'::text[]) || $11::text[]) AS t),
            email_verified = $12,
            last_synced_at = NOW(),
            updated_at = NOW()
          WHERE id = $14 AND tenant = $13`,
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
            merged,
            emailVerified,
            TENANT,
            existing.rows[0].id,
          ]
        );
        return (upd.rowCount || 0) > 0 ? 'updated' : 'skipped';
      } else {
        // New contacts: contact_type left NULL so the classifier decides
        // (lenders get classified out); never auto-added to any list.
        const ins = await query<{ id: string }>(
          `INSERT INTO contacts (
            apollo_id, email, first_name, last_name, title, company,
            company_domain, linkedin_url, phone, city, country, tags,
            email_verified, source, last_synced_at, tenant, contact_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'apollo', NOW(), $14, NULL)
          ON CONFLICT DO NOTHING
          RETURNING id`,
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
            apolloTags,
            emailVerified,
            TENANT,
          ]
        );
        return ins.rows.length > 0 ? 'added' : 'skipped';
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
