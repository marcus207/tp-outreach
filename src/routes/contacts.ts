import { Router, Request, Response } from 'express';
import { query } from '../db/connection';

const router = Router();

// GET /api/contacts — list with pagination, search, filter by tag/company
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200);
    const offset = (page - 1) * limit;
    const search = req.query.search as string | undefined;
    const tag = req.query.tag as string | undefined;
    const company = req.query.company as string | undefined;
    const source = req.query.source as string | undefined;
    const sortCol = ['email', 'first_name', 'company', 'title', 'city', 'created_at'].includes(req.query.sort as string)
      ? (req.query.sort as string) : 'created_at';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: unknown[] = [];

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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

    const result = await query(
      `INSERT INTO contacts (
        email, first_name, last_name, title, company, company_domain,
        linkedin_url, phone, city, country, tags, custom_fields, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (LOWER(email)) DO UPDATE SET
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
      ]
    );

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
      `SELECT DISTINCT unnest(tags) AS tag FROM contacts WHERE array_length(tags, 1) > 0 ORDER BY tag`
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

      try {
        const existing = await query<{ id: string }>(
          `SELECT id FROM contacts WHERE LOWER(email) = $1`,
          [row.email.toLowerCase()]
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
            WHERE LOWER(email) = $6`,
            [
              row.first_name || null,
              row.last_name || null,
              row.company || null,
              row.title || null,
              row.phone || null,
              row.email.toLowerCase(),
            ]
          );
          results.updated++;
        } else {
          const tags = row.tags ? row.tags.split(';').map((t) => t.trim()).filter(Boolean) : [];
          await query(
            `INSERT INTO contacts (email, first_name, last_name, company, title, phone, city, country, tags, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
            ]
          );
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

// GET /api/contacts/:id — get contact with send history
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const contactResult = await query(`SELECT * FROM contacts WHERE id = $1`, [id]);
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
       WHERE es.contact_id = $1
       GROUP BY es.id, s.name
       ORDER BY es.created_at DESC
       LIMIT 50`,
      [id]
    );

    const enrollmentsResult = await query(
      `SELECT se.*, s.name AS sequence_name
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.contact_id = $1
       ORDER BY se.enrolled_at DESC`,
      [id]
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
      WHERE id = $12
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

// DELETE /api/contacts/:id — delete contact
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`DELETE FROM contacts WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Contact not found' });
      return;
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
       WHERE id = $2
       RETURNING *`,
      [tags, id]
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

// GET /api/lists — list contact lists
router.get('/lists', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT cl.*, COUNT(clm.contact_id) AS member_count
       FROM contact_lists cl
       LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
       GROUP BY cl.id
       ORDER BY cl.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Contacts] Error listing lists:', err);
    res.status(500).json({ error: 'Failed to list contact lists' });
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
      `INSERT INTO contact_lists (name, description, apollo_list_id) VALUES ($1, $2, $3) RETURNING *`,
      [name, description || null, apollo_list_id || null]
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

    let added = 0;
    for (const contactId of contact_ids) {
      try {
        await query(
          `INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, contactId]
        );
        added++;
      } catch {
        // skip invalid contact ids
      }
    }

    res.json({ added });
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
