import { Router, Request, Response } from 'express';
import { query } from '../db/connection';

const router = Router();

// GET /api/analytics/overview
router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const [sendsResult, eventsResult, enrollmentsResult] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent') AS total_sent,
          COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
          COUNT(*) FILTER (WHERE status = 'queued') AS total_queued
        FROM email_sends
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'open') AS total_opens,
          COUNT(DISTINCT email_send_id) FILTER (WHERE event_type = 'open') AS unique_opens,
          COUNT(*) FILTER (WHERE event_type = 'click') AS total_clicks,
          COUNT(DISTINCT email_send_id) FILTER (WHERE event_type = 'click') AS unique_clicks,
          COUNT(*) FILTER (WHERE event_type = 'reply') AS total_replies
        FROM email_events
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active_enrollments,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_enrollments,
          COUNT(*) FILTER (WHERE status = 'replied') AS replied_enrollments
        FROM sequence_enrollments
      `),
    ]);

    const sends = sendsResult.rows[0];
    const events = eventsResult.rows[0];
    const enrollments = enrollmentsResult.rows[0];

    const totalSent = parseInt(sends.total_sent, 10) || 0;
    const openRate = totalSent > 0 ? (parseInt(events.unique_opens, 10) / totalSent) * 100 : 0;
    const clickRate = totalSent > 0 ? (parseInt(events.unique_clicks, 10) / totalSent) * 100 : 0;
    const replyRate = totalSent > 0 ? (parseInt(events.total_replies, 10) / totalSent) * 100 : 0;

    res.json({
      total_sent: totalSent,
      total_failed: parseInt(sends.total_failed, 10) || 0,
      total_queued: parseInt(sends.total_queued, 10) || 0,
      open_rate: parseFloat(openRate.toFixed(2)),
      click_rate: parseFloat(clickRate.toFixed(2)),
      reply_rate: parseFloat(replyRate.toFixed(2)),
      unique_opens: parseInt(events.unique_opens, 10) || 0,
      unique_clicks: parseInt(events.unique_clicks, 10) || 0,
      total_replies: parseInt(events.total_replies, 10) || 0,
      active_enrollments: parseInt(enrollments.active_enrollments, 10) || 0,
      completed_enrollments: parseInt(enrollments.completed_enrollments, 10) || 0,
      replied_enrollments: parseInt(enrollments.replied_enrollments, 10) || 0,
    });
  } catch (err) {
    console.error('[Analytics] Error getting overview:', err);
    res.status(500).json({ error: 'Failed to get analytics overview' });
  }
});

// GET /api/analytics/daily — daily send volume for last N days
router.get('/daily', async (req: Request, res: Response) => {
  try {
    const days = Math.min(parseInt(String(req.query.days || '30'), 10), 90);

    const result = await query(
      `SELECT
         DATE(sent_at AT TIME ZONE 'UTC') AS date,
         COUNT(*) AS sent,
         COUNT(DISTINCT contact_id) AS unique_contacts
       FROM email_sends
       WHERE status = 'sent'
         AND sent_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE(sent_at AT TIME ZONE 'UTC')
       ORDER BY date ASC`,
      [days]
    );

    // Fill in missing dates with zeros
    interface DailyRow { date: string; sent: string; unique_contacts: string }
    const dataMap = new Map((result.rows as DailyRow[]).map((r) => [r.date, r]));
    const filled = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const existing = dataMap.get(dateStr);
      filled.push({
        date: dateStr,
        sent: existing ? parseInt(existing.sent as string, 10) : 0,
        unique_contacts: existing ? parseInt(existing.unique_contacts as string, 10) : 0,
      });
    }

    res.json(filled);
  } catch (err) {
    console.error('[Analytics] Error getting daily stats:', err);
    res.status(500).json({ error: 'Failed to get daily analytics' });
  }
});

// GET /api/analytics/accounts — per-account send health
router.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT
        ea.id,
        ea.email,
        ea.display_name,
        ea.sends_today,
        ea.sends_this_hour,
        ea.daily_limit,
        ea.hourly_limit,
        ea.last_send_at,
        ea.is_active,
        COUNT(es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '7 days') AS sent_last_7d,
        COUNT(es.id) FILTER (WHERE es.status = 'failed' AND es.created_at > NOW() - INTERVAL '7 days') AS failed_last_7d
      FROM email_accounts ea
      LEFT JOIN email_sends es ON es.email_account_id = ea.id
      GROUP BY ea.id
      ORDER BY ea.email
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('[Analytics] Error getting account stats:', err);
    res.status(500).json({ error: 'Failed to get account analytics' });
  }
});

// GET /api/analytics/campaigns — per-campaign stats
router.get('/campaigns', async (_req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT
        s.id,
        s.name,
        s.status,
        COUNT(DISTINCT se.id) AS total_enrollments,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active') AS active_enrollments,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'completed') AS completed_enrollments,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'replied') AS replied_enrollments,
        COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent') AS emails_sent,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'open') AS opens,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'click') AS clicks,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'reply') AS replies,
        CASE
          WHEN COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent') > 0
          THEN ROUND(
            COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'open')::numeric /
            COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent') * 100,
            2
          )
          ELSE 0
        END AS open_rate,
        CASE
          WHEN COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent') > 0
          THEN ROUND(
            COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'click')::numeric /
            COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent') * 100,
            2
          )
          ELSE 0
        END AS click_rate
      FROM sequences s
      LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id
      LEFT JOIN email_sends es ON es.enrollment_id = se.id
      LEFT JOIN email_events ee ON ee.email_send_id = es.id
      GROUP BY s.id
      ORDER BY emails_sent DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('[Analytics] Error getting campaign stats:', err);
    res.status(500).json({ error: 'Failed to get campaign analytics' });
  }
});

export default router;
