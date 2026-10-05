import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
import { sequenceEngine } from '../services/sequence-engine';
import { campaignEngine } from '../services/campaign-engine';

const router = Router();

// ═══════════════════════════════════════════════════════════════
// Core CRUD — works for both drip and blast sequences
// ═══════════════════════════════════════════════════════════════

// GET /api/campaigns — list all sequences with stats
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT
        s.*,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active') AS active_enrollments,
        COUNT(DISTINCT se.id) AS total_enrollments,
        COUNT(DISTINCT es.id) AS total_sent,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'open') AS total_opens,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'click') AS total_clicks,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'reply') AS total_replies
      FROM sequences s
      LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id
      LEFT JOIN email_sends es ON es.enrollment_id = se.id AND es.status = 'sent'
      LEFT JOIN email_events ee ON ee.email_send_id = es.id
      WHERE s.tenant = $1
      GROUP BY s.id
      ORDER BY s.type ASC, s.created_at DESC
    `, [TENANT]);

    // For blast sequences, also get step-level stats
    for (const row of result.rows as any[]) {
      if (row.type === 'blast') {
        const stepStats = await query<{ blast_status: string; count: string }>(
          `SELECT blast_status, COUNT(*) as count FROM sequence_steps WHERE sequence_id = $1 GROUP BY blast_status`,
          [row.id]
        );
        const sectorCount = await query<{ count: string }>(
          `SELECT COUNT(DISTINCT sector) as count FROM sequence_steps WHERE sequence_id = $1`,
          [row.id]
        );
        // Blast sends tracked via sequence_step_id, not enrollment
        const blastSent = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM email_sends es
           JOIN sequence_steps ss ON ss.id = es.sequence_step_id
           WHERE ss.sequence_id = $1 AND es.status = 'sent'`,
          [row.id]
        );
        const statusMap: Record<string, number> = {};
        for (const s of stepStats.rows) statusMap[s.blast_status] = parseInt(s.count);
        row.blast_stats = {
          sectors: parseInt(sectorCount.rows[0]?.count || '0'),
          total_steps: Object.values(statusMap).reduce((a, b) => a + b, 0),
          approved: statusMap.approved || 0,
          draft: statusMap.draft || 0,
          sent: statusMap.sent || 0,
        };
        row.total_sent = parseInt(blastSent.rows[0]?.count || '0');
      }
    }

    res.json(result.rows);
  } catch (err) {
    console.error('[Campaigns] Error listing sequences:', err);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

// POST /api/campaigns — create sequence
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      name, description, type,
      sending_account_ids, send_window_start, send_window_end,
      skip_weekends, daily_send_limit, stop_on_reply, stop_on_open,
      frequency_days, start_date,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const result = await query(
      `INSERT INTO sequences (
        name, description, type, sending_account_ids, send_window_start,
        send_window_end, skip_weekends, daily_send_limit, stop_on_reply, stop_on_open,
        frequency_days, start_date, tenant
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        name,
        description || null,
        type || 'drip',
        sending_account_ids || [],
        send_window_start || '08:00',
        send_window_end || '18:00',
        skip_weekends !== undefined ? skip_weekends : true,
        daily_send_limit || null,
        stop_on_reply !== undefined ? stop_on_reply : true,
        stop_on_open !== undefined ? stop_on_open : false,
        frequency_days || null,
        start_date || null,
        TENANT,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Campaigns] Error creating sequence:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// GET /api/campaigns/:id — get sequence with steps and enrollment stats
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const seqResult = await query(`SELECT * FROM sequences WHERE id = $1 AND tenant = $2`, [id, TENANT]);
    if (!seqResult.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const seq = seqResult.rows[0] as any;

    const stepsResult = await query(
      `SELECT
         ss.*,
         t.name AS template_name,
         t.subject AS template_subject,
         vt.name AS variant_template_name
       FROM sequence_steps ss
       LEFT JOIN templates t ON t.id = ss.template_id
       LEFT JOIN templates vt ON vt.id = ss.variant_template_id
       WHERE ss.sequence_id = $1
       ORDER BY ss.step_number`,
      [id]
    );

    const statsResult = await query(
      `SELECT
         se.status,
         COUNT(*) AS count
       FROM sequence_enrollments se
       WHERE se.sequence_id = $1 AND se.tenant = $2
       GROUP BY se.status`,
      [id, TENANT]
    );

    // Aggregate send/event stats (same logic as list endpoint)
    const sendStatsResult = await query<{
      total_sent: string; total_opens: string; total_clicks: string; total_replies: string;
    }>(
      `SELECT
         COUNT(DISTINCT es.id) AS total_sent,
         COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'open') AS total_opens,
         COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'click') AS total_clicks,
         COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'reply') AS total_replies
       FROM sequence_enrollments se
       LEFT JOIN email_sends es ON es.enrollment_id = se.id AND es.status = 'sent'
       LEFT JOIN email_events ee ON ee.email_send_id = es.id
       WHERE se.sequence_id = $1 AND se.tenant = $2`,
      [id, TENANT]
    );
    const sendStats = sendStatsResult.rows[0] || { total_sent: '0', total_opens: '0', total_clicks: '0', total_replies: '0' };

    // Per-step enrollment counts (awaiting = active contacts whose next step is this one)
    const stepEnrollResult = await query<{ step_number: string; awaiting: string }>(
      `SELECT ss.step_number,
         COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active' AND se.current_step = ss.step_number - 1) AS awaiting
       FROM sequence_steps ss
       LEFT JOIN sequence_enrollments se ON se.sequence_id = ss.sequence_id AND se.tenant = $2
       WHERE ss.sequence_id = $1
       GROUP BY ss.step_number`,
      [id, TENANT]
    );

    // Per-step send/event stats
    const stepSendResult = await query<{ step_number: string; sent: string; opened: string; clicked: string; replied: string }>(
      `SELECT ss.step_number,
         COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent') AS sent,
         COUNT(DISTINCT CASE WHEN ee.event_type = 'open' THEN es.id END) AS opened,
         COUNT(DISTINCT CASE WHEN ee.event_type = 'click' THEN es.id END) AS clicked,
         COUNT(DISTINCT CASE WHEN ee.event_type = 'reply' THEN es.id END) AS replied
       FROM sequence_steps ss
       LEFT JOIN email_sends es ON es.sequence_step_id = ss.id AND es.status = 'sent' AND es.tenant = $2
       LEFT JOIN email_events ee ON ee.email_send_id = es.id
       WHERE ss.sequence_id = $1
       GROUP BY ss.step_number`,
      [id, TENANT]
    );

    const stepStatsMap: Record<number, { awaiting: number; sent: number; opened: number; clicked: number; replied: number }> = {};
    for (const row of stepEnrollResult.rows) {
      const n = parseInt(row.step_number);
      stepStatsMap[n] = { awaiting: parseInt(row.awaiting), sent: 0, opened: 0, clicked: 0, replied: 0 };
    }
    for (const row of stepSendResult.rows) {
      const n = parseInt(row.step_number);
      if (!stepStatsMap[n]) stepStatsMap[n] = { awaiting: 0, sent: 0, opened: 0, clicked: 0, replied: 0 };
      stepStatsMap[n].sent = parseInt(row.sent);
      stepStatsMap[n].opened = parseInt(row.opened);
      stepStatsMap[n].clicked = parseInt(row.clicked);
      stepStatsMap[n].replied = parseInt(row.replied);
    }

    const stepsWithStats = stepsResult.rows.map((step: any) => ({
      ...step,
      step_stats: stepStatsMap[step.step_number] || { awaiting: 0, sent: 0, opened: 0, clicked: 0, replied: 0 },
    }));

    res.json({
      ...seq,
      steps: stepsWithStats,
      enrollment_stats: statsResult.rows,
      total_sent: parseInt(sendStats.total_sent),
      total_opens: parseInt(sendStats.total_opens),
      total_clicks: parseInt(sendStats.total_clicks),
      total_replies: parseInt(sendStats.total_replies),
    });
  } catch (err) {
    console.error('[Campaigns] Error getting sequence:', err);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

// PUT /api/campaigns/:id — update sequence
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name, description,
      sending_account_ids, send_window_start, send_window_end,
      skip_weekends, daily_send_limit, stop_on_reply, stop_on_open,
      frequency_days, start_date,
    } = req.body;

    const result = await query(
      `UPDATE sequences SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        sending_account_ids = COALESCE($3, sending_account_ids),
        send_window_start = COALESCE($4, send_window_start),
        send_window_end = COALESCE($5, send_window_end),
        skip_weekends = COALESCE($6, skip_weekends),
        daily_send_limit = COALESCE($7, daily_send_limit),
        stop_on_reply = COALESCE($8, stop_on_reply),
        stop_on_open = COALESCE($9, stop_on_open),
        frequency_days = COALESCE($10, frequency_days),
        start_date = COALESCE($11, start_date),
        updated_at = NOW()
      WHERE id = $12 AND tenant = $13
      RETURNING *`,
      [
        name, description,
        sending_account_ids, send_window_start, send_window_end,
        skip_weekends, daily_send_limit, stop_on_reply, stop_on_open,
        frequency_days, start_date,
        id, TENANT,
      ]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Campaigns] Error updating sequence:', err);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// DELETE /api/campaigns/:id — delete sequence
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`DELETE FROM sequences WHERE id = $1 AND tenant = $2 RETURNING id`, [id, TENANT]);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Campaigns] Error deleting sequence:', err);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

// ═══════════════════════════════════════════════════════════════
// Drip sequence steps
// ═══════════════════════════════════════════════════════════════

// POST /api/campaigns/:id/steps — add step
router.post('/:id/steps', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      step_number, template_id, delay_days, delay_hours,
      step_type, variant_template_id, variant_split,
    } = req.body;

    let stepNum = step_number;
    if (!stepNum) {
      const maxResult = await query<{ max: string }>(
        `SELECT COALESCE(MAX(step_number), 0) + 1 AS max FROM sequence_steps WHERE sequence_id = $1`,
        [id]
      );
      stepNum = parseInt(maxResult.rows[0].max, 10);
    }

    const result = await query(
      `INSERT INTO sequence_steps (
        sequence_id, step_number, template_id, delay_days, delay_hours,
        step_type, variant_template_id, variant_split
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [id, stepNum, template_id || null, delay_days || 0, delay_hours || 0, step_type || 'email', variant_template_id || null, variant_split || 50]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Campaigns] Error adding step:', err);
    res.status(500).json({ error: 'Failed to add step' });
  }
});

// PUT /api/campaigns/:id/steps/:stepId — update step
router.put('/:id/steps/:stepId', async (req: Request, res: Response) => {
  try {
    const { id, stepId } = req.params;
    const {
      template_id, delay_days, delay_hours, step_type,
      variant_template_id, variant_split,
      // Blast-specific fields
      subject_line, body_copy, hero_image, article_slug,
      article_title, article_excerpt, blast_status,
    } = req.body;

    const result = await query(
      `UPDATE sequence_steps SET
        template_id = COALESCE($1, template_id),
        delay_days = COALESCE($2, delay_days),
        delay_hours = COALESCE($3, delay_hours),
        step_type = COALESCE($4, step_type),
        variant_template_id = COALESCE($5, variant_template_id),
        variant_split = COALESCE($6, variant_split),
        subject_line = COALESCE($7, subject_line),
        body_copy = COALESCE($8, body_copy),
        hero_image = COALESCE($9, hero_image),
        article_slug = COALESCE($10, article_slug),
        article_title = COALESCE($11, article_title),
        article_excerpt = COALESCE($12, article_excerpt),
        blast_status = COALESCE($13, blast_status),
        updated_at = NOW()
      WHERE id = $14 AND sequence_id = $15
      RETURNING *`,
      [
        template_id, delay_days, delay_hours, step_type,
        variant_template_id, variant_split,
        subject_line, body_copy, hero_image, article_slug,
        article_title, article_excerpt, blast_status,
        stepId, id,
      ]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Step not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Campaigns] Error updating step:', err);
    res.status(500).json({ error: 'Failed to update step' });
  }
});

// DELETE /api/campaigns/:id/steps/:stepId — delete step
router.delete('/:id/steps/:stepId', async (req: Request, res: Response) => {
  try {
    const { id, stepId } = req.params;
    const result = await query(
      `DELETE FROM sequence_steps WHERE id = $1 AND sequence_id = $2 RETURNING id`,
      [stepId, id]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Step not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Campaigns] Error deleting step:', err);
    res.status(500).json({ error: 'Failed to delete step' });
  }
});

// ═══════════════════════════════════════════════════════════════
// Enrollment (drip sequences only)
// ═══════════════════════════════════════════════════════════════

// POST /api/campaigns/:id/enroll — enroll contacts
router.post('/:id/enroll', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { contact_ids } = req.body;

    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      res.status(400).json({ error: 'contact_ids must be a non-empty array' });
      return;
    }

    const seqResult = await query<{ status: string; type: string }>(
      `SELECT status, type FROM sequences WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );

    if (!seqResult.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    if (seqResult.rows[0].type === 'blast') {
      res.status(400).json({ error: 'Cannot enroll contacts in a blast campaign — blast sends to all contacts in sector automatically' });
      return;
    }

    if (seqResult.rows[0].status !== 'active') {
      res.status(400).json({ error: 'Campaign must be active to enroll contacts' });
      return;
    }

    const results = { enrolled: 0, skipped: 0, errors: 0 };

    for (const contactId of contact_ids) {
      try {
        await sequenceEngine.enrollContact(String(id), String(contactId));
        results.enrolled++;
      } catch (err) {
        const error = err as Error;
        if (error.message.includes('already actively enrolled')) {
          results.skipped++;
        } else {
          results.errors++;
          console.error(`[Campaigns] Error enrolling ${contactId}:`, error.message);
        }
      }
    }

    res.json(results);
  } catch (err) {
    console.error('[Campaigns] Error enrolling contacts:', err);
    res.status(500).json({ error: 'Failed to enroll contacts' });
  }
});

// POST /api/campaigns/:id/enroll-all — enroll all eligible contacts
router.post('/:id/enroll-all', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const seqResult = await query<{ status: string; name: string; type: string }>(
      `SELECT status, name, type FROM sequences WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );

    if (!seqResult.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    if (seqResult.rows[0].type === 'blast') {
      res.status(400).json({ error: 'Blast campaigns send automatically by sector — no enrollment needed' });
      return;
    }

    if (seqResult.rows[0].status !== 'active') {
      res.status(400).json({ error: 'Campaign must be active to enroll contacts' });
      return;
    }

    const contactsResult = await query<{ id: string }>(
      `SELECT id FROM contacts
       WHERE tenant = $1 AND NOT ('unsubscribed' = ANY(tags))
       ORDER BY created_at`,
      [TENANT]
    );

    const existingResult = await query<{ contact_id: string }>(
      `SELECT contact_id FROM sequence_enrollments
       WHERE sequence_id = $1 AND tenant = $2 AND status = 'active'`,
      [id, TENANT]
    );
    const activeSet = new Set(existingResult.rows.map(r => r.contact_id));

    const eligible = contactsResult.rows.filter(c => !activeSet.has(c.id));

    const results = { enrolled: 0, skipped: 0, errors: 0, total_eligible: eligible.length, already_active: activeSet.size };

    for (const contact of eligible) {
      try {
        await sequenceEngine.enrollContact(String(id), String(contact.id));
        results.enrolled++;
      } catch (err) {
        const error = err as Error;
        if (error.message.includes('already actively enrolled')) {
          results.skipped++;
        } else {
          results.errors++;
          console.error(`[Campaigns] Error enrolling ${contact.id}:`, error.message);
        }
      }
    }

    res.json(results);
  } catch (err) {
    console.error('[Campaigns] Error enrolling all contacts:', err);
    res.status(500).json({ error: 'Failed to enroll contacts' });
  }
});

// PUT /api/campaigns/:id/status — change status (works for both types)
router.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['draft', 'active', 'paused', 'archived'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const result = await query(
      `UPDATE sequences SET status = $1, updated_at = NOW() WHERE id = $2 AND tenant = $3 RETURNING *`,
      [status, id, TENANT]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Campaigns] Error updating status:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// GET /api/campaigns/:id/enrollments — list enrollments
router.get('/:id/enrollments', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const offset = (page - 1) * limit;

    const result = await query(
      `SELECT
         se.*,
         c.email, c.first_name, c.last_name, c.company, c.title,
         COUNT(es.id) FILTER (WHERE es.status = 'sent') AS emails_sent
       FROM sequence_enrollments se
       JOIN contacts c ON c.id = se.contact_id
       LEFT JOIN email_sends es ON es.enrollment_id = se.id
       WHERE se.sequence_id = $1 AND se.tenant = $2
       GROUP BY se.id, c.email, c.first_name, c.last_name, c.company, c.title
       ORDER BY se.enrolled_at DESC
       LIMIT $3 OFFSET $4`,
      [id, TENANT, limit, offset]
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = $1 AND tenant = $2`,
      [id, TENANT]
    );

    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
    });
  } catch (err) {
    console.error('[Campaigns] Error listing enrollments:', err);
    res.status(500).json({ error: 'Failed to list enrollments' });
  }
});

// ═══════════════════════════════════════════════════════════════
// Blast-specific routes (merged from campaign-planner.ts)
// ═══════════════════════════════════════════════════════════════

const HERO_DIR = path.join(__dirname, '../../data/hero');

function listHeroImages(): string[] {
  try {
    return fs.readdirSync(HERO_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

function heroToDataUri(filename: string): string {
  try {
    const filePath = path.join(HERO_DIR, filename);
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filename).slice(1) || 'jpeg';
    return `data:image/${ext};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

// GET /api/campaigns/:id/blast/sectors — sectors with contact counts
router.get('/:id/blast/sectors', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const schedSectors = await query<{ sector: string; sends: string }>(
      `SELECT sector, COUNT(*) as sends
       FROM sequence_steps WHERE sequence_id = $1 AND sector IS NOT NULL
       GROUP BY sector ORDER BY sector`,
      [id]
    );

    const contactCounts = await query<{ sector: string; count: string }>(
      `SELECT custom_fields->>'sector' as sector, COUNT(*) as count
       FROM contacts
       WHERE custom_fields->>'sector' IS NOT NULL AND tenant = $1
       GROUP BY custom_fields->>'sector'
       ORDER BY count DESC`,
      [TENANT]
    );

    const contactMap: Record<string, number> = {};
    for (const row of contactCounts.rows) {
      contactMap[row.sector] = parseInt(row.count);
    }

    const sectors = schedSectors.rows.map(r => ({
      sector: r.sector,
      sends: parseInt(r.sends),
      contacts: contactMap[r.sector] || 0,
    }));

    res.json(sectors);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/campaigns/:id/blast/schedule — blast steps with calculated send dates
router.get('/:id/blast/schedule', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const sector = typeof req.query.sector === 'string' ? req.query.sector : undefined;

    // Get the sequence for frequency_days and start_date
    const seqResult = await query<{ frequency_days: number; start_date: string }>(
      `SELECT frequency_days, start_date FROM sequences WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );
    if (!seqResult.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    const seq = seqResult.rows[0];

    let sql = `SELECT ss.* FROM sequence_steps ss WHERE ss.sequence_id = $1 AND ss.sector IS NOT NULL`;
    const params: string[] = [id];

    if (sector) {
      sql += ` AND ss.sector = $2`;
      params.push(sector);
    }

    sql += ` ORDER BY ss.sector, ss.step_number`;

    const result = await query(sql, params);

    // Calculate send dates: within each sector, send_number = position within that sector
    const sectorCounts: Record<string, number> = {};
    const rows = result.rows.map((r: any) => {
      const s = r.sector || '';
      sectorCounts[s] = (sectorCounts[s] || 0) + 1;
      const sendNumber = sectorCounts[s];
      const startDate = new Date(seq.start_date);
      const sendDate = new Date(startDate);
      sendDate.setDate(sendDate.getDate() + (sendNumber - 1) * (seq.frequency_days || 30));
      return {
        ...r,
        send_number: sendNumber,
        frequency_days: seq.frequency_days,
        start_date: seq.start_date,
        calculated_send_date: sendDate.toISOString().split('T')[0],
      };
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/campaigns/:id/blast/preview/:stepId — render email preview
router.get('/:id/blast/preview/:stepId', async (req: Request, res: Response) => {
  try {
    const { id, stepId } = req.params;

    const result = await query<{
      hero_image: string;
      subject_line: string;
      body_copy: string;
      sector: string;
      article_title: string | null;
    }>(
      `SELECT hero_image, subject_line, body_copy, sector, article_title
       FROM sequence_steps WHERE id = $1 AND sequence_id = $2`,
      [stepId, id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });

    const entry = result.rows[0];
    const heroDataUri = heroToDataUri(entry.hero_image);

    const previewHtml = buildEmailPreview(entry, heroDataUri);

    res.json({
      ...entry,
      hero_data_uri: heroDataUri,
      preview_html: previewHtml,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/campaigns/:id/blast/hero-images — list available hero images
router.get('/:id/blast/hero-images', async (_req: Request, res: Response) => {
  try {
    res.json(listHeroImages());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/campaigns/:id/blast/engine/status — engine state + stats
router.get('/:id/blast/engine/status', async (_req: Request, res: Response) => {
  try {
    const status = campaignEngine.getStatus();
    const stats = await campaignEngine.getStats();
    res.json({ ...status, ...stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/campaigns/:id/blast/engine/run — manual trigger
router.post('/:id/blast/engine/run', async (_req: Request, res: Response) => {
  try {
    const result = await campaignEngine.tick();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/campaigns/:id/blast/engine/log — recent send log
router.get('/:id/blast/engine/log', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const log = await campaignEngine.getLog(limit);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/campaigns/:id/blast/approve-all — bulk approve all draft steps
router.post('/:id/blast/approve-all', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE sequence_steps SET blast_status = 'approved', updated_at = NOW()
       WHERE sequence_id = $1 AND blast_status = 'draft' AND sector IS NOT NULL`,
      [id]
    );
    res.json({ approved: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function buildEmailPreview(entry: { hero_image: string; subject_line: string; body_copy: string; sector: string; article_title: string | null }, heroDataUri: string): string {
  const sampleData: Record<string, string> = {
    first_name: 'John',
    last_name: 'Smith',
    sector: entry.sector,
    sector_image: heroDataUri,
    company: 'Sample Corp',
  };

  let body = entry.body_copy || '';
  let subject = entry.subject_line || '';
  for (const [key, val] of Object.entries(sampleData)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    body = body.replace(regex, val);
    subject = subject.replace(regex, val);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f9;">
<tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <tr><td style="background-color:#0A131E;padding:24px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td><span style="font-weight:700;font-size:20px;color:#74DFF6;">TP</span><span style="font-weight:700;font-size:20px;color:#1993C5;">.</span>
        <span style="font-weight:500;font-size:13px;color:#ffffff;margin-left:8px;opacity:0.85;">${BRAND_NAME}</span></td>
        <td align="right"><span style="font-size:11px;color:rgba(255,255,255,0.45);letter-spacing:1px;text-transform:uppercase;">${entry.sector}</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="height:3px;background:linear-gradient(90deg,#0D9488 0%,#74DFF6 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
    ${heroDataUri ? `<tr><td style="padding:0;"><img src="${heroDataUri}" alt="${entry.sector}" width="600" style="display:block;width:100%;height:auto;max-height:220px;object-fit:cover;"/></td></tr>` : ''}
    <tr><td style="padding:40px 40px 32px 40px;">
      <div style="font-family:'DM Sans',Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#1a2332;">
        ${body}
      </div>
    </td></tr>
    <tr><td style="padding:0 40px;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background:rgba(10,19,30,0.08);font-size:0;">&nbsp;</td></tr></table></td></tr>
    <tr><td style="padding:24px 40px 32px 40px;">
      <table cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:16px;border-right:3px solid #0D9488;vertical-align:top;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#0A131E;">${BRAND_NAME}</p>
          <p style="margin:4px 0 0;font-size:12px;color:#0D9488;font-weight:600;">Property Finance Advisory</p>
        </td>
        <td style="padding-left:16px;vertical-align:top;">
          <p style="margin:0;font-size:12px;color:#5a6e84;line-height:1.7;">
            <a href="mailto:${BRAND_EMAIL}" style="color:#0D9488;text-decoration:none;">${BRAND_EMAIL}</a><br/>
            <a href="https://www.${BRAND_DOMAIN}" style="color:#0D9488;text-decoration:none;">${BRAND_DOMAIN}</a>
          </p>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="background-color:#0A131E;padding:20px 40px;">
      <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.40);line-height:1.6;">
        ${BRAND_NAME} &nbsp;|&nbsp; <a href="https://www.${BRAND_DOMAIN}" style="color:#0D9488;text-decoration:none;">${BRAND_DOMAIN}</a><br/>
        To opt out, reply with "unsubscribe".
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

export default router;
