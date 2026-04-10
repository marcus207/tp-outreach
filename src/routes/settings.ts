import { Router, Request, Response } from 'express';
import { query } from '../db/connection';

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

// DELETE /api/email-accounts/:id — disconnect Gmail account
router.delete('/email-accounts/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE email_accounts
       SET is_active = false, oauth_tokens = '{}', updated_at = NOW()
       WHERE id = $1
       RETURNING id, email`,
      [id]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Email account not found' });
      return;
    }

    res.json({ success: true, email: (result.rows[0] as { email: string }).email });
  } catch (err) {
    console.error('[Settings] Error disconnecting account:', err);
    res.status(500).json({ error: 'Failed to disconnect account' });
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
       ORDER BY email`
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
      WHERE id = $4
      RETURNING id, email, display_name, daily_limit, hourly_limit,
                sends_today, sends_this_hour, last_send_at, is_active`,
      [daily_limit, hourly_limit, display_name, id]
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

export default router;
