import { Router, Request, Response } from 'express';
import { query, TENANT } from '../db/connection';

const router = Router();

// GET /api/settings — get all settings
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await query(`SELECT key, value FROM settings ORDER BY key`);

    const settings: Record<string, unknown> = {};
    for (const row of result.rows as Array<{ key: string; value: unknown }>) {
      settings[row.key] = row.value;
    }

    res.json(settings);
  } catch (err) {
    console.error('[Settings] Error getting settings:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/settings — update one or more settings
router.put('/', async (req: Request, res: Response) => {
  try {
    const updates = req.body as Record<string, unknown>;

    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'Request body must be a non-empty object' });
      return;
    }

    for (const [key, value] of Object.entries(updates)) {
      await query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    }

    // Return updated settings
    const result = await query(`SELECT key, value FROM settings ORDER BY key`);
    const settings: Record<string, unknown> = {};
    for (const row of result.rows as Array<{ key: string; value: unknown }>) {
      settings[row.key] = row.value;
    }

    res.json(settings);
  } catch (err) {
    console.error('[Settings] Error updating settings:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// DELETE /api/email-accounts/:id — delete Gmail account and related records
router.delete('/email-accounts/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check the account exists and belongs to this tenant
    const check = await query<{ email: string }>(
      `SELECT email FROM email_accounts WHERE id = $1 AND tenant = $2`,
      [id, TENANT]
    );
    if (!check.rows[0]) {
      res.status(404).json({ error: 'Email account not found' });
      return;
    }
    const email = check.rows[0].email;

    // Soft-disconnect rather than hard-delete. A hard delete used to cascade
    // DELETE FROM email_sends (months of send history) AND drop the account row,
    // which on re-auth minted a NEW account id — orphaning sequences'
    // sending_account_ids and silently halting all sends. Instead we deactivate
    // and clear the OAuth tokens, preserving the id + history. Re-authing the
    // same address hits ON CONFLICT (email) DO UPDATE and reactivates this exact
    // row, so sending resumes with zero reconfiguration. (Same fix applied to
    // li-outreach after the Jun 4 2026 Loan Intel incident.)
    await query(
      `UPDATE email_accounts
         SET is_active = false, oauth_tokens = '{}'::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    console.log(`[Settings] Disconnected email account (soft, history preserved): ${email}`);
    res.json({ success: true, email, disconnected: true });
  } catch (err) {
    console.error('[Settings] Error deleting account:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// GET /api/email-accounts — list all Gmail accounts
router.get('/email-accounts', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT id, email, display_name, daily_limit, hourly_limit,
              sends_today, sends_this_hour, last_send_at, is_active, created_at,
              (oauth_tokens != '{}'::jsonb) AS has_oauth
       FROM email_accounts
       WHERE tenant = $1
       ORDER BY email`,
      [TENANT]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Settings] Error listing email accounts:', err);
    res.status(500).json({ error: 'Failed to list email accounts' });
  }
});

// PUT /api/email-accounts/:id — update account limits
router.put('/email-accounts/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { daily_limit, hourly_limit, display_name } = req.body;

    const result = await query(
      `UPDATE email_accounts SET
        daily_limit = COALESCE($1, daily_limit),
        hourly_limit = COALESCE($2, hourly_limit),
        display_name = COALESCE($3, display_name),
        updated_at = NOW()
      WHERE id = $4 AND tenant = $5
      RETURNING id, email, display_name, daily_limit, hourly_limit,
                sends_today, sends_this_hour, last_send_at, is_active`,
      [daily_limit, hourly_limit, display_name, id, TENANT]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Email account not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Settings] Error updating email account:', err);
    res.status(500).json({ error: 'Failed to update email account' });
  }
});

// GET /api/settings/sequence-cadence — current delay_days for drip sequences
router.get('/sequence-cadence', async (_req: Request, res: Response) => {
  try {
    const result = await query<{ delay_days: number; step_count: string }>(
      `SELECT ss.delay_days, COUNT(*) as step_count
       FROM sequence_steps ss
       JOIN sequences s ON s.id = ss.sequence_id
       WHERE s.tenant = $1 AND s.status = 'active' AND s.type = 'drip' AND ss.delay_days > 0
       GROUP BY ss.delay_days
       ORDER BY step_count DESC
       LIMIT 1`,
      [TENANT]
    );
    const cadence = result.rows[0]?.delay_days ?? 30;
    res.json({ cadence_days: cadence });
  } catch (err) {
    console.error('[Settings] Error getting sequence cadence:', err);
    res.status(500).json({ error: 'Failed to get sequence cadence' });
  }
});

// PUT /api/settings/sequence-cadence — bulk-update delay_days on all active drip steps (except step 1)
router.put('/sequence-cadence', async (req: Request, res: Response) => {
  try {
    const { cadence_days } = req.body;
    const days = parseInt(cadence_days, 10);
    if (!days || days < 1 || days > 90) {
      res.status(400).json({ error: 'cadence_days must be between 1 and 90' });
      return;
    }

    const result = await query(
      `UPDATE sequence_steps ss
       SET delay_days = $1, updated_at = NOW()
       FROM sequences s
       WHERE ss.sequence_id = s.id
         AND s.tenant = $2
         AND s.status = 'active'
         AND s.type = 'drip'
         AND ss.step_number > 1`,
      [days, TENANT]
    );

    console.log(`[Settings] Updated cadence to ${days} days for ${result.rowCount} steps (tenant=${TENANT})`);
    res.json({ success: true, cadence_days: days, steps_updated: result.rowCount });
  } catch (err) {
    console.error('[Settings] Error updating sequence cadence:', err);
    res.status(500).json({ error: 'Failed to update sequence cadence' });
  }
});

export default router;
