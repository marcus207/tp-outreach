import { Router, Request, Response, NextFunction } from 'express';
import { google } from 'googleapis';
import { query, getClient, TENANT } from '../db/connection';
import { sequenceEngine } from '../services/sequence-engine';
import { gmailClient } from '../services/gmail-client';
import { EmailAccount } from '../types';
import { suppressionMatchSql, suppressionExclusionSql } from '../services/suppression';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Integer query param: non-numeric => default; clamped to [min, max]. */
export function intParam(raw: unknown, def: number, min: number, max: number): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== 'string' || !/^\s*-?\d+\s*$/.test(s)) return def;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** Max rows per page (security test SEC-07 caps bulk export at 200). */
const MAX_PAGE_LIMIT = 200;

// Every :id in this router is a uuid column: reject anything else up front
// (400, no DB error text).
router.param('id', (req: Request, res: Response, next: NextFunction, id: string) => {
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  next();
});

// Auto-enroll a new contact into the active intro series sequence (if one exists).
// Runs in the background — does not block the response.
async function autoEnrollInIntroSeries(contactId: string): Promise<void> {
  try {
    // tp auto-enrol is paused unless explicitly enabled (same switch as worker.ts)
    if (TENANT === 'tp' && process.env.TP_AUTO_ENROL_ENABLED !== 'true') return;

    // Never auto-enrol lenders, held/unsubscribed/bounced, suppressed, or our own mailboxes
    const eligible = await query<{ id: string }>(
      `SELECT c.id FROM contacts c
       WHERE c.id = $1 AND c.tenant = $2
         AND (c.contact_type IS NULL OR c.contact_type <> 'lender')
         AND NOT (COALESCE(c.tags, '{}'::text[]) && ARRAY['hold', 'unsubscribed', 'bounced']::text[])
         AND LOWER(c.email) NOT LIKE '%@tp.finance'
         AND LOWER(c.email) NOT LIKE '%@go.tp.finance'
         AND ${suppressionExclusionSql('c.email', 'c.tenant')}`,
      [contactId, TENANT]
    );
    if (!eligible.rows[0]) return;

    const seqResult = await query<{ id: string }>(
      `SELECT id FROM sequences WHERE tenant = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [TENANT]
    );
    if (!seqResult.rows[0]) return;
    await sequenceEngine.enrollContact(seqResult.rows[0].id, contactId);
    console.log(`[AutoEnroll] Contact ${contactId} enrolled in active sequence`);
  } catch (err) {
    // Don't fail the contact creation if enrollment fails (e.g. already enrolled, unsubscribed)
    console.log(`[AutoEnroll] Skipped ${contactId}: ${(err as Error).message}`);
  }
}

// GET /api/contacts — list with pagination, search, filter by tag/company
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = intParam(req.query.page, 1, 1, 1_000_000);
    const limit = intParam(req.query.limit, 50, 1, MAX_PAGE_LIMIT);
    const offset = (page - 1) * limit;
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const search = str(req.query.search);
    const tag = str(req.query.tag);
    const company = str(req.query.company);
    const source = str(req.query.source);
    const sortCol = ['email', 'first_name', 'company', 'title', 'city', 'created_at'].includes(req.query.sort as string)
      ? (req.query.sort as string) : 'created_at';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Always filter by tenant
    params.push(TENANT);
    conditions.push(`c.tenant = $${params.length}`);

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(c.email ILIKE $${params.length} OR c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length} OR c.company ILIKE $${params.length})`
      );
    }

    if (tag) {
      params.push(tag);
      conditions.push(`$${params.length} = ANY(c.tags)`);
    }

    if (company) {
      params.push(`%${company}%`);
      conditions.push(`c.company ILIKE $${params.length}`);
    }

    if (source) {
      params.push(source);
      conditions.push(`c.source = $${params.length}`);
    }

    const category = req.query.category as string | undefined;
    if (category === 'introducer') {
      conditions.push(`c.contact_type = 'introducer'`);
    } else if (category === 'client') {
      conditions.push(`c.contact_type = 'developer'`);
    } else if (category === 'lender') {
      conditions.push(`c.contact_type = 'lender'`);
    } else if (category === 'unclassified') {
      conditions.push(`c.contact_type IS NULL`);
    }

    const subsector = str(req.query.subsector);
    if (subsector) {
      params.push(subsector);
      conditions.push(`c.subsector = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts c ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await query(
      `SELECT
         c.*,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active') AS active_sequences
       FROM contacts c
       LEFT JOIN sequence_enrollments se ON se.contact_id = c.id
       ${whereClause}
       GROUP BY c.id
       ORDER BY c.${sortCol} ${sortDir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
    });
  } catch (err) {
    console.error('[Contacts] Error listing contacts:', err);
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

// POST /api/contacts — create single contact
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      email,
      first_name,
      last_name,
      title,
      company,
      company_domain,
      linkedin_url,
      phone,
      city,
      country,
      tags,
      custom_fields,
      source,
    } = req.body;

    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    // Block permanently suppressed emails
    const suppCheck = await query<{ id: string; reason: string }>(
      `SELECT sup.id, sup.reason FROM suppressed_emails sup
       WHERE sup.tenant = $2
         AND (LOWER(sup.email) = $1
              OR (sup.source = 'manual' AND sup.domain IS NOT NULL AND sup.domain <> ''
                  AND LOWER(sup.domain) = SPLIT_PART($1, '@', 2)))
       ORDER BY (LOWER(sup.email) = $1) DESC
       LIMIT 1`,  /* same rule as services/suppression.ts; needs the row's reason */
      [String(email).toLowerCase().trim(), TENANT]
    );
    if (suppCheck.rows.length > 0) {
      res.status(409).json({ error: `Email is permanently suppressed: ${suppCheck.rows[0].reason}` });
      return;
    }

    // Check if contact already exists (to know if this is new or an update)
    const existingCheck = await query<{ id: string }>(
      `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
      [email.toLowerCase().trim(), TENANT]
    );
    const isNew = existingCheck.rows.length === 0;

    const result = await query(
      `INSERT INTO contacts (
        email, first_name, last_name, title, company, company_domain,
        linkedin_url, phone, city, country, tags, custom_fields, source, tenant
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (tenant, (lower(email::text))) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        title = EXCLUDED.title,
        company = EXCLUDED.company,
        updated_at = NOW()
      RETURNING *`,
      [
        email.toLowerCase().trim(),
        first_name || null,
        last_name || null,
        title || null,
        company || null,
        company_domain || null,
        linkedin_url || null,
        phone || null,
        city || null,
        country || null,
        tags || [],
        JSON.stringify(custom_fields || {}),
        source || 'manual',
        TENANT,
      ]
    );

    // Auto-enroll new contacts into the intro series (don't block response)
    if (isNew && result.rows[0]) {
      autoEnrollInIntroSeries(result.rows[0].id).catch(() => {});
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Contacts] Error creating contact:', err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// GET /api/contacts/tags — list all unique tags
router.get('/tags', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT DISTINCT unnest(tags) AS tag FROM contacts WHERE tenant = $1 AND array_length(tags, 1) > 0 ORDER BY tag`,
      [TENANT]
    );
    res.json((result.rows as Array<{ tag: string }>).map((r) => r.tag));
  } catch (err) {
    console.error('[Contacts] Error listing tags:', err);
    res.status(500).json({ error: 'Failed to list tags' });
  }
});

// POST /api/contacts/import — CSV import
router.post('/import', async (req: Request, res: Response) => {
  try {
    const { csv, source } = req.body;

    if (!csv) {
      res.status(400).json({ error: 'csv body is required' });
      return;
    }

    const lines = csv.split('\n').filter((l: string) => l.trim());
    if (lines.length < 2) {
      res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      return;
    }

    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase().replace(/"/g, ''));
    const results = { added: 0, updated: 0, skipped: 0, errors: [] as string[] };

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length < headers.length) continue;

      const row: Record<string, string> = {};
      headers.forEach((h: string, idx: number) => {
        row[h] = (values[idx] || '').replace(/"/g, '').trim();
      });

      if (!row.email) {
        results.skipped++;
        continue;
      }

      // Skip permanently suppressed emails during import
      const suppRow = await query<{ id: string }>(
        `SELECT 1 AS id WHERE ${suppressionMatchSql('$1::text', '$2')}`,
        [row.email.toLowerCase(), TENANT]
      );
      if (suppRow.rows.length > 0) {
        results.skipped++;
        continue;
      }

      try {
        const existing = await query<{ id: string }>(
          `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
          [row.email.toLowerCase(), TENANT]
        );

        if (existing.rows.length > 0) {
          await query(
            `UPDATE contacts SET
              first_name = COALESCE($1, first_name),
              last_name = COALESCE($2, last_name),
              company = COALESCE($3, company),
              title = COALESCE($4, title),
              phone = COALESCE($5, phone),
              updated_at = NOW()
            WHERE LOWER(email) = $6 AND tenant = $7`,
            [
              row.first_name || null,
              row.last_name || null,
              row.company || null,
              row.title || null,
              row.phone || null,
              row.email.toLowerCase(),
              TENANT,
            ]
          );
          results.updated++;
        } else {
          const tags = row.tags ? row.tags.split(';').map((t) => t.trim()).filter(Boolean) : [];
          const insertResult = await query<{ id: string }>(
            `INSERT INTO contacts (email, first_name, last_name, company, title, phone, city, country, tags, source, tenant)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
              row.email.toLowerCase(),
              row.first_name || null,
              row.last_name || null,
              row.company || null,
              row.title || null,
              row.phone || null,
              row.city || null,
              row.country || null,
              tags,
              source || 'csv',
              TENANT,
            ]
          );
          // Auto-enroll new CSV contacts into the intro series
          if (insertResult.rows[0]) {
            autoEnrollInIntroSeries(insertResult.rows[0].id).catch(() => {});
          }
          results.added++;
        }
      } catch (err) {
        const error = err as Error;
        results.errors.push(`Row ${i}: ${error.message}`);
      }
    }

    res.json(results);
  } catch (err) {
    console.error('[Contacts] Error importing CSV:', err);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

// POST /api/contacts/bulk-lookup-names — scan Gmail for all contacts with missing names
router.post('/bulk-lookup-names', async (req: Request, res: Response) => {
  try {
    const contactsResult = await query<{ id: string; email: string; first_name: string | null; last_name: string | null }>(
      `SELECT id, email, first_name, last_name FROM contacts
       WHERE tenant = $1 AND (first_name IS NULL OR first_name = '' OR last_name IS NULL OR last_name = '')
       ORDER BY created_at DESC
       LIMIT 100`,
      [TENANT]
    );

    if (contactsResult.rows.length === 0) {
      res.json({ processed: 0, updated: 0, message: 'All contacts already have names' });
      return;
    }

    const accounts = await gmailClient.getActiveAccounts();
    if (accounts.length === 0) {
      res.status(400).json({ error: 'No active Gmail accounts to search with' });
      return;
    }

    const account = accounts[0];
    const auth = await gmailClient.getAuthenticatedClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    let updated = 0;
    let processed = 0;

    for (const contact of contactsResult.rows) {
      processed++;
      try {
        const listResponse = await gmail.users.messages.list({
          userId: 'me',
          q: `from:${contact.email}`,
          maxResults: 3,
        });

        const messages = listResponse.data.messages || [];
        let firstName: string | null = null;
        let lastName: string | null = null;

        for (const msg of messages) {
          if (!msg.id || (firstName && lastName)) break;

          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });

          const fromHeader = detail.data.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
          const fromMatch = fromHeader.match(/^"?([^"<]+)"?\s*</);
          if (fromMatch) {
            const parts = fromMatch[1].trim().split(/\s+/);
            if (parts.length >= 2 && !parts[0].includes('@')) {
              firstName = parts[0];
              lastName = parts.slice(1).join(' ');
              break;
            }
          }

          const body = extractBody(detail.data.payload);
          if (body) {
            const sigName = extractNameFromSignature(body, contact.email);
            if (sigName) {
              firstName = sigName.firstName;
              lastName = sigName.lastName;
              break;
            }
          }
        }

        if (firstName || lastName) {
          const updates: string[] = [];
          const params: unknown[] = [];
          let paramIdx = 0;

          if (firstName && (!contact.first_name || contact.first_name === '')) {
            paramIdx++;
            updates.push(`first_name = $${paramIdx}`);
            params.push(firstName);
          }
          if (lastName && (!contact.last_name || contact.last_name === '')) {
            paramIdx++;
            updates.push(`last_name = $${paramIdx}`);
            params.push(lastName);
          }

          if (updates.length > 0) {
            paramIdx++;
            params.push(contact.id);
            paramIdx++;
            params.push(TENANT);
            await query(
              `UPDATE contacts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIdx - 1} AND tenant = $${paramIdx}`,
              params
            );
            updated++;
          }
        }
      } catch (err) {
        console.error(`[Contacts] Error looking up ${contact.email}:`, (err as Error).message);
      }
    }

    console.log(`[Contacts] Bulk name lookup: ${processed} processed, ${updated} updated`);
    res.json({ processed, updated });
  } catch (err) {
    console.error('[Contacts] Error in bulk name lookup:', err);
    res.status(500).json({ error: 'Failed to bulk look up names' });
  }
});

// GET /api/contacts/breakdown — counts by category + subsector
router.get('/breakdown', async (_req: Request, res: Response) => {
  try {
    const totalRes = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts WHERE tenant = $1`, [TENANT]
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    const catRes = await query<{ contact_type: string | null; count: string }>(
      `SELECT contact_type, COUNT(*) FROM contacts WHERE tenant = $1 GROUP BY contact_type`, [TENANT]
    );
    const cats: Record<string, number> = {};
    for (const r of catRes.rows) cats[r.contact_type || '__null'] = parseInt(r.count, 10);

    const subRes = await query<{ contact_type: string; subsector: string; count: string }>(
      `SELECT contact_type, subsector, COUNT(*) FROM contacts WHERE tenant = $1 AND contact_type IS NOT NULL AND subsector IS NOT NULL GROUP BY contact_type, subsector ORDER BY count DESC`, [TENANT]
    );

    const introSubsectors = subRes.rows.filter(r => r.contact_type === 'introducer').map(r => ({ key: r.subsector, label: r.subsector, count: parseInt(r.count, 10) }));
    const clientSubsectors = subRes.rows.filter(r => r.contact_type === 'developer').map(r => ({ key: r.subsector, label: r.subsector, count: parseInt(r.count, 10) }));

    const introTotal = (cats['introducer'] || 0);
    const clientTotal = (cats['developer'] || 0);
    const introSectored = introSubsectors.reduce((s, x) => s + x.count, 0);
    const clientSectored = clientSubsectors.reduce((s, x) => s + x.count, 0);

    res.json({
      total,
      introducers: { total: introTotal, subsectors: introSubsectors, unsectored: introTotal - introSectored },
      clients: { total: clientTotal, subsectors: clientSubsectors, unsectored: clientTotal - clientSectored },
      lenders: { total: cats['lender'] || 0 },
      unclassified: { total: cats['__null'] || 0 },
    });
  } catch (err) {
    console.error('[Contacts] Error fetching breakdown:', err);
    res.status(500).json({ error: 'Failed to fetch breakdown' });
  }
});

// POST /api/contacts/suggest — AI category suggestion (stub: returns null for all)
router.post('/suggest', async (req: Request, res: Response) => {
  try {
    const { contact_ids } = req.body;
    if (!Array.isArray(contact_ids)) { res.json({}); return; }
    const result: Record<string, null> = {};
    for (const id of contact_ids) result[id] = null;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// POST /api/contacts/bulk-assign — assign category + subsector to contacts
router.post('/bulk-assign', async (req: Request, res: Response) => {
  try {
    const { contact_ids, contact_type, subsector } = req.body;
    if (!Array.isArray(contact_ids) || !contact_type) {
      res.status(400).json({ error: 'contact_ids and contact_type required' });
      return;
    }
    if (!contact_ids.every(isUuid)) {
      res.status(400).json({ error: 'contact_ids must be UUIDs' });
      return;
    }
    const result = await query(
      `UPDATE contacts SET contact_type = $1, subsector = $2, updated_at = NOW()
       WHERE tenant = $3 AND id = ANY($4::uuid[])`,
      [contact_type, subsector || null, TENANT, contact_ids]
    );
    res.json({ updated: result.rowCount || 0 });
  } catch (err) {
    console.error('[Contacts] Error bulk assigning:', err);
    res.status(500).json({ error: 'Failed to bulk assign' });
  }
});

// GET /api/lists — list contact lists
// NOTE: must be registered BEFORE GET /:id or Express parses "lists" as :id (route shadow).
router.get('/lists', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT cl.*, COUNT(clm.contact_id) AS member_count
       FROM contact_lists cl
       LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
       WHERE cl.tenant = $1
       GROUP BY cl.id
       ORDER BY cl.created_at DESC`,
      [TENANT]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Contacts] Error listing lists:', err);
    res.status(500).json({ error: 'Failed to list contact lists' });
  }
});

// GET /api/contacts/:id — get contact with send history
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const contactResult = await query(`SELECT * FROM contacts WHERE id = $1 AND tenant = $2`, [id, TENANT]);
    if (!contactResult.rows[0]) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    const sendsResult = await query(
      `SELECT
         es.*,
         s.name AS sequence_name,
         COUNT(ee.id) FILTER (WHERE ee.event_type = 'open') AS opens,
         COUNT(ee.id) FILTER (WHERE ee.event_type = 'click') AS clicks
       FROM email_sends es
       LEFT JOIN sequence_enrollments se ON se.id = es.enrollment_id
       LEFT JOIN sequences s ON s.id = se.sequence_id
       LEFT JOIN email_events ee ON ee.email_send_id = es.id
       WHERE es.contact_id = $1 AND es.tenant = $2
       GROUP BY es.id, s.name
       ORDER BY es.created_at DESC
       LIMIT 50`,
      [id, TENANT]
    );

    const enrollmentsResult = await query(
      `SELECT se.*, s.name AS sequence_name
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.contact_id = $1 AND se.tenant = $2
       ORDER BY se.enrolled_at DESC`,
      [id, TENANT]
    );

    res.json({
      ...contactResult.rows[0],
      sends: sendsResult.rows,
      enrollments: enrollmentsResult.rows,
    });
  } catch (err) {
    console.error('[Contacts] Error getting contact:', err);
    res.status(500).json({ error: 'Failed to get contact' });
  }
});

// PUT /api/contacts/:id — update contact
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      first_name,
      last_name,
      title,
      company,
      company_domain,
      linkedin_url,
      phone,
      city,
      country,
      tags,
      custom_fields,
    } = req.body;

    const result = await query(
      `UPDATE contacts SET
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        title = COALESCE($3, title),
        company = COALESCE($4, company),
        company_domain = COALESCE($5, company_domain),
        linkedin_url = COALESCE($6, linkedin_url),
        phone = COALESCE($7, phone),
        city = COALESCE($8, city),
        country = COALESCE($9, country),
        tags = COALESCE($10, tags),
        custom_fields = COALESCE($11, custom_fields),
        updated_at = NOW()
      WHERE id = $12 AND tenant = $13
      RETURNING *`,
      [
        first_name,
        last_name,
        title,
        company,
        company_domain,
        linkedin_url,
        phone,
        city,
        country,
        tags,
        custom_fields ? JSON.stringify(custom_fields) : null,
        id,
        TENANT,
      ]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Contacts] Error updating contact:', err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// POST /api/contacts/:id/lookup-name — search Gmail for emails from this contact and extract name from signature/headers
router.post('/:id/lookup-name', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get the contact
    const contactResult = await query<{ id: string; email: string; first_name: string | null; last_name: string | null }>(
      `SELECT id, email, first_name, last_name FROM contacts WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );
    if (!contactResult.rows[0]) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }
    const contact = contactResult.rows[0];

    // Get an active Gmail account to search with
    const accounts = await gmailClient.getActiveAccounts();
    if (accounts.length === 0) {
      res.status(400).json({ error: 'No active Gmail accounts to search with' });
      return;
    }

    const account = accounts[0];
    const auth = await gmailClient.getAuthenticatedClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    // Search for emails FROM this contact's address
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${contact.email}`,
      maxResults: 5,
    });

    const messages = listResponse.data.messages || [];
    if (messages.length === 0) {
      res.json({ found: false, message: 'No emails found from this contact' });
      return;
    }

    let firstName: string | null = null;
    let lastName: string | null = null;

    for (const msg of messages) {
      if (!msg.id) continue;
      if (firstName && lastName) break;

      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        // 1. Try the From header — often has the display name like "John Smith <john@example.com>"
        const fromHeader = detail.data.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
        const fromMatch = fromHeader.match(/^"?([^"<]+)"?\s*</);
        if (fromMatch) {
          const parts = fromMatch[1].trim().split(/\s+/);
          if (parts.length >= 2 && !parts[0].includes('@')) {
            firstName = parts[0];
            lastName = parts.slice(1).join(' ');
            break;
          }
        }

        // 2. Try the email body — look for signature patterns
        const body = extractBody(detail.data.payload);
        if (body) {
          const sigName = extractNameFromSignature(body, contact.email);
          if (sigName) {
            firstName = sigName.firstName;
            lastName = sigName.lastName;
            break;
          }
        }
      } catch (err) {
        console.error(`[Contacts] Error fetching message ${msg.id}:`, err);
      }
    }

    if (firstName || lastName) {
      // Auto-update the contact if names were found
      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 0;

      if (firstName && (!contact.first_name || contact.first_name === '')) {
        paramIdx++;
        updates.push(`first_name = $${paramIdx}`);
        params.push(firstName);
      }
      if (lastName && (!contact.last_name || contact.last_name === '')) {
        paramIdx++;
        updates.push(`last_name = $${paramIdx}`);
        params.push(lastName);
      }

      if (updates.length > 0) {
        paramIdx++;
        params.push(id);
        paramIdx++;
        params.push(TENANT);
        await query(
          `UPDATE contacts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIdx - 1} AND tenant = $${paramIdx}`,
          params
        );
      }

      res.json({ found: true, first_name: firstName, last_name: lastName });
    } else {
      res.json({ found: false, message: 'Could not extract name from emails' });
    }
  } catch (err) {
    console.error('[Contacts] Error looking up name:', err);
    res.status(500).json({ error: 'Failed to look up name' });
  }
});

// Helper: extract text body from Gmail message payload
function extractBody(payload: any): string | null {
  if (!payload) return null;

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart — prefer text/plain, fall back to text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }
    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return null;
}

// Helper: try to extract a name from an email signature
function extractNameFromSignature(body: string, contactEmail: string): { firstName: string; lastName: string } | null {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

  // Look for common signature delimiters and grab the name line after them
  const sigDelimiters = ['--', '---', '—', 'regards', 'kind regards', 'best regards', 'best wishes', 'many thanks', 'thanks', 'cheers', 'warm regards'];

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase().replace(/[,.\s]+$/, '');
    if (sigDelimiters.includes(lower)) {
      // The next non-empty line is likely the name
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        // Skip if it looks like a title/role, phone, email, or URL
        if (candidate.includes('@') || candidate.includes('http') || candidate.match(/^\+?\d[\d\s()-]{6,}/)) continue;
        if (candidate.length > 40) continue;

        const parts = candidate.split(/\s+/);
        if (parts.length >= 2 && parts.length <= 4) {
          // Check it looks like a name (starts with uppercase, no special chars)
          if (parts[0].match(/^[A-Z][a-z]+$/)) {
            return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
          }
        }
        break;
      }
    }
  }

  return null;
}

// DELETE /api/contacts/:id — delete contact
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check contact exists
    const check = await query<{ id: string; email: string }>(
      `SELECT id, email FROM contacts WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );
    if (!check.rows[0]) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    // One transaction: suppression first (so Apollo/Dripify/imports can't re-add
    // it), then detach send history (email_sends / email_events are KEPT, with
    // contact_id = NULL, like the Oct 5 cleanup), then remove enrollments, list
    // memberships and campaign_sends rows, then the contact. Any failure rolls
    // everything back so history is never half-destroyed.
    // campaign_sends has no tenant column; it is scoped via the tenant-checked contact id.
    const client = await getClient();
    try {
      await client.query('BEGIN');
      if (check.rows[0].email) {
        await client.query(
          `INSERT INTO suppressed_emails (email, domain, reason, source, tenant)
           VALUES (LOWER($1), NULL, 'deleted by user', 'manual-delete', $2)
           ON CONFLICT (lower(email), tenant) DO NOTHING`,
          [check.rows[0].email, TENANT]
        );
      }
      await client.query(`UPDATE email_sends SET contact_id = NULL WHERE contact_id = $1 AND tenant = $2`, [id, TENANT]);
      await client.query(`DELETE FROM campaign_sends WHERE contact_id = $1`, [id]);
      await client.query(`DELETE FROM sequence_enrollments WHERE contact_id = $1 AND tenant = $2`, [id, TENANT]);
      await client.query(`DELETE FROM contact_list_members WHERE contact_id = $1 AND tenant = $2`, [id, TENANT]);
      const del = await client.query(`DELETE FROM contacts WHERE id = $1 AND tenant = $2`, [id, TENANT]);
      if ((del.rowCount || 0) === 0) throw new Error('contact vanished during delete');
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Contacts] Error deleting contact:', err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// POST /api/contacts/:id/tags — add tags
router.post('/:id/tags', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;

    if (!Array.isArray(tags)) {
      res.status(400).json({ error: 'tags must be an array' });
      return;
    }

    const result = await query(
      `UPDATE contacts
       SET tags = array(SELECT DISTINCT unnest(tags || $1::text[])), updated_at = NOW()
       WHERE id = $2 AND tenant = $3
       RETURNING *`,
      [tags, id, TENANT]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Contacts] Error adding tags:', err);
    res.status(500).json({ error: 'Failed to add tags' });
  }
});

// POST /api/lists — create list
router.post('/lists', async (req: Request, res: Response) => {
  try {
    const { name, description, apollo_list_id } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const result = await query(
      `INSERT INTO contact_lists (name, description, apollo_list_id, tenant) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, apollo_list_id || null, TENANT]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Contacts] Error creating list:', err);
    res.status(500).json({ error: 'Failed to create list' });
  }
});

// POST /api/lists/:id/members — add contacts to list
router.post('/lists/:id/members', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { contact_ids } = req.body;

    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      res.status(400).json({ error: 'contact_ids must be a non-empty array' });
      return;
    }
    if (!contact_ids.every(isUuid)) {
      res.status(400).json({ error: 'contact_ids must be UUIDs' });
      return;
    }

    // The list must belong to this tenant.
    const list = await query<{ id: string }>(
      `SELECT id FROM contact_lists WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );
    if (!list.rows[0]) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    // Every contact must belong to this tenant too.
    const owned = await query<{ id: string }>(
      `SELECT id FROM contacts WHERE id = ANY($1::uuid[]) AND tenant = $2`,
      [contact_ids, TENANT]
    );
    if (owned.rows.length !== new Set(contact_ids.map((c: string) => c.toLowerCase())).size) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    const ins = await query(
      `INSERT INTO contact_list_members (list_id, contact_id, tenant)
       SELECT $1, c.id, c.tenant FROM contacts c
       WHERE c.id = ANY($2::uuid[]) AND c.tenant = $3
       ON CONFLICT DO NOTHING`,
      [id, contact_ids, TENANT]
    );

    res.json({ added: ins.rowCount || 0 });
  } catch (err) {
    console.error('[Contacts] Error adding list members:', err);
    res.status(500).json({ error: 'Failed to add list members' });
  }
});

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export default router;
