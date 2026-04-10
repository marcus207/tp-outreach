import { Router, Request, Response } from 'express';
import { query } from '../db/connection';
import { sequenceEngine } from '../services/sequence-engine';

const router = Router();

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
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
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
      name,
      description,
      sending_account_ids,
      send_window_start,
      send_window_end,
      skip_weekends,
      daily_send_limit,
      stop_on_reply,
      stop_on_open,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const result = await query(
      `INSERT INTO sequences (
        name, description, sending_account_ids, send_window_start,
        send_window_end, skip_weekends, daily_send_limit, stop_on_reply, stop_on_open
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        name,
        description || null,
        sending_account_ids || [],
        send_window_start || '08:00',
        send_window_end || '18:00',
        skip_weekends !== undefined ? skip_weekends : true,
        daily_send_limit || null,
        stop_on_reply !== undefined ? stop_on_reply : true,
        stop_on_open !== undefined ? stop_on_open : false,
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

    const seqResult = await query(`SELECT * FROM sequences WHERE id = $1`, [id]);
    if (!seqResult.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

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
       WHERE se.sequence_id = $1
       GROUP BY se.status`,
      [id]
    );

    res.json({
      ...seqResult.rows[0],
      steps: stepsResult.rows,
      enrollment_stats: statsResult.rows,
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
      name,
      description,
      sending_account_ids,
      send_window_start,
      send_window_end,
      skip_weekends,
      daily_send_limit,
      stop_on_reply,
      stop_on_open,
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
        updated_at = NOW()
      WHERE id = $10
      RETURNING *`,
      [
        name,
        description,
        sending_account_ids,
        send_window_start,
        send_window_end,
        skip_weekends,
        daily_send_limit,
        stop_on_reply,
        stop_on_open,
        id,
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
    const result = await query(`DELETE FROM sequences WHERE id = $1 RETURNING id`, [id]);
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

// POST /api/campaigns/:id/steps — add step
router.post('/:id/steps', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      step_number,
      template_id,
      delay_days,
      delay_hours,
      step_type,
      variant_template_id,
      variant_split,
    } = req.body;

    // Auto-assign step number if not provided
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
      [
        id,
        stepNum,
        template_id || null,
        delay_days || 0,
        delay_hours || 0,
        step_type || 'email',
        variant_template_id || null,
        variant_split || 50,
      ]
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
    const { template_id, delay_days, delay_hours, step_type, variant_template_id, variant_split } =
      req.body;

    const result = await query(
      `UPDATE sequence_steps SET
        template_id = COALESCE($1, template_id),
        delay_days = COALESCE($2, delay_days),
        delay_hours = COALESCE($3, delay_hours),
        step_type = COALESCE($4, step_type),
        variant_template_id = COALESCE($5, variant_template_id),
        variant_split = COALESCE($6, variant_split),
        updated_at = NOW()
      WHERE id = $7 AND sequence_id = $8
      RETURNING *`,
      [
        template_id,
        delay_days,
        delay_hours,
        step_type,
        variant_template_id,
        variant_split,
        stepId,
        id,
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

// POST /api/campaigns/:id/enroll — enroll contacts
router.post('/:id/enroll', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { contact_ids } = req.body;

    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      res.status(400).json({ error: 'contact_ids must be a non-empty array' });
      return;
    }

    // Check sequence is active
    const seqResult = await query<{ status: string }>(
      `SELECT status FROM sequences WHERE id = $1`,
      [id]
    );

    if (!seqResult.rows[0]) {
      res.status(404).json({ error: 'Campaign not found' });
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

// PUT /api/campaigns/:id/status — change status
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
      `UPDATE sequences SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
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
       WHERE se.sequence_id = $1
       GROUP BY se.id, c.email, c.first_name, c.last_name, c.company, c.title
       ORDER BY se.enrolled_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = $1`,
      [id]
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

export default router;
