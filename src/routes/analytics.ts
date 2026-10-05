import { Router, Request, Response } from 'express';
import { query, TENANT } from '../db/connection';
import { dmarcScanner } from '../services/dmarc-scanner';

const router = Router();

// GET /api/analytics/overview
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const rangeDays = Math.max(parseInt(String(req.query.days || '7'), 10), 1);
    const interval = `${rangeDays} days`;

    const [sendsResult, eventsResult, enrollmentsResult, broadcastResult] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')    AS total_sent,
          COUNT(*) FILTER (WHERE status = 'failed')  AS total_failed,
          COUNT(*) FILTER (WHERE status = 'queued')  AS total_queued,
          COUNT(*) FILTER (WHERE status = 'bounced') AS total_bounced
        FROM email_sends
        WHERE tenant = $1 AND COALESCE(sent_at, created_at) >= NOW() - $2::interval
      `, [TENANT, interval]),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE ee.event_type = 'open')        AS total_opens,
          COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'open') AS unique_opens,
          COUNT(*) FILTER (WHERE ee.event_type = 'click')       AS total_clicks,
          COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'click') AS unique_clicks,
          COUNT(*) FILTER (WHERE ee.event_type = 'reply')       AS total_replies,
          COUNT(*) FILTER (WHERE ee.event_type = 'auto_reply')  AS total_auto_replies,
          COUNT(*) FILTER (WHERE ee.event_type = 'ooo')         AS total_ooo,
          COUNT(*) FILTER (WHERE ee.event_type = 'left_company') AS total_left_company,
          COUNT(*) FILTER (WHERE ee.event_type = 'unsubscribe') AS total_unsubscribes
        FROM email_events ee
        JOIN email_sends es ON es.id = ee.email_send_id
        WHERE es.tenant = $1 AND ee.created_at >= NOW() - $2::interval
      `, [TENANT, interval]),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')    AS active_enrollments,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_enrollments,
          COUNT(*) FILTER (WHERE status = 'replied')   AS replied_enrollments,
          COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_enrollments
        FROM sequence_enrollments
        WHERE tenant = $1 AND created_at >= NOW() - $2::interval
      `, [TENANT, interval]),
      query(`
        SELECT
          COUNT(*) AS total_broadcasts,
          COALESCE(SUM(total_contacts), 0) AS broadcast_contacts,
          COALESCE(SUM(total_sent), 0) AS broadcast_sent
        FROM article_broadcasts ab
        JOIN article_drafts ad ON ad.id = ab.article_id
        WHERE ad.tenant = $1 AND ab.status != 'cancelled'
          AND ab.sent_at >= NOW() - $2::interval
      `, [TENANT, interval]),
    ]);

    const sends = sendsResult.rows[0];
    const events = eventsResult.rows[0];
    const enrollments = enrollmentsResult.rows[0];
    const broadcast = broadcastResult.rows[0];

    const totalSent = parseInt(sends.total_sent, 10) || 0;
    const openRate = totalSent > 0 ? (parseInt(events.unique_opens, 10) / totalSent) * 100 : 0;
    const clickRate = totalSent > 0 ? (parseInt(events.unique_clicks, 10) / totalSent) * 100 : 0;
    const replyRate = totalSent > 0 ? (parseInt(events.total_replies, 10) / totalSent) * 100 : 0;
    const totalFailed = parseInt(sends.total_failed, 10) || 0;
    const bounceRate = totalSent > 0 ? (totalFailed / (totalSent + totalFailed)) * 100 : 0;

    res.json({
      total_sent: totalSent,
      total_failed: totalFailed,
      total_queued: parseInt(sends.total_queued, 10) || 0,
      total_bounced: parseInt(sends.total_bounced, 10) || 0,
      open_rate: parseFloat(openRate.toFixed(2)),
      click_rate: parseFloat(clickRate.toFixed(2)),
      reply_rate: parseFloat(replyRate.toFixed(2)),
      bounce_rate: parseFloat(bounceRate.toFixed(2)),
      unique_opens: parseInt(events.unique_opens, 10) || 0,
      unique_clicks: parseInt(events.unique_clicks, 10) || 0,
      total_replies: parseInt(events.total_replies, 10) || 0,
      total_auto_replies: parseInt(events.total_auto_replies, 10) || 0,
      total_unsubscribes: parseInt(events.total_unsubscribes, 10) || 0,
      total_ooo: parseInt(events.total_ooo, 10) || 0,
      total_left_company: parseInt(events.total_left_company, 10) || 0,
      active_enrollments: parseInt(enrollments.active_enrollments, 10) || 0,
      completed_enrollments: parseInt(enrollments.completed_enrollments, 10) || 0,
      replied_enrollments: parseInt(enrollments.replied_enrollments, 10) || 0,
      cancelled_enrollments: parseInt(enrollments.cancelled_enrollments, 10) || 0,
      total_broadcasts: parseInt(broadcast.total_broadcasts, 10) || 0,
      broadcast_contacts: parseInt(broadcast.broadcast_contacts, 10) || 0,
      broadcast_sent: parseInt(broadcast.broadcast_sent, 10) || 0,
    });
  } catch (err) {
    console.error('[Analytics] Error getting overview:', err);
    res.status(500).json({ error: 'Failed to get analytics overview' });
  }
});

// GET /api/analytics/recent — 1hr + 24hr performance snapshot
router.get('/recent', async (_req: Request, res: Response) => {
  try {
    const periods = ['1 hour', '24 hours'] as const;
    const [h1, h24] = await Promise.all(
      periods.map((interval) =>
        Promise.all([
          query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
               COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
               COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
               COUNT(*) FILTER (WHERE status = 'queued')  AS queued
             FROM email_sends
             WHERE tenant = $1 AND created_at >= NOW() - INTERVAL '${interval}'`,
            [TENANT]
          ),
          query(
            `SELECT
               COUNT(*) FILTER (WHERE ee.event_type = 'open')        AS opens,
               COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'open') AS unique_opens,
               COUNT(*) FILTER (WHERE ee.event_type = 'click')       AS clicks,
               COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'click') AS unique_clicks,
               COUNT(*) FILTER (WHERE ee.event_type = 'reply')       AS replies,
               COUNT(*) FILTER (WHERE ee.event_type = 'unsubscribe') AS unsubscribes,
               COUNT(*) FILTER (WHERE ee.event_type = 'bounce')      AS bounces
             FROM email_events ee
             JOIN email_sends es ON es.id = ee.email_send_id
             WHERE es.tenant = $1 AND ee.created_at >= NOW() - INTERVAL '${interval}'`,
            [TENANT]
          ),
        ])
      )
    );

    const build = (sends: any, events: any) => {
      const sent = parseInt(sends.sent, 10) || 0;
      const uniqueOpens = parseInt(events.unique_opens, 10) || 0;
      const uniqueClicks = parseInt(events.unique_clicks, 10) || 0;
      const replies = parseInt(events.replies, 10) || 0;
      return {
        sent,
        failed: parseInt(sends.failed, 10) || 0,
        bounced: parseInt(sends.bounced, 10) || 0,
        queued: parseInt(sends.queued, 10) || 0,
        opens: parseInt(events.opens, 10) || 0,
        unique_opens: uniqueOpens,
        clicks: parseInt(events.clicks, 10) || 0,
        unique_clicks: uniqueClicks,
        replies,
        unsubscribes: parseInt(events.unsubscribes, 10) || 0,
        open_rate: sent > 0 ? parseFloat(((uniqueOpens / sent) * 100).toFixed(1)) : 0,
        click_rate: sent > 0 ? parseFloat(((uniqueClicks / sent) * 100).toFixed(1)) : 0,
        reply_rate: sent > 0 ? parseFloat(((replies / sent) * 100).toFixed(1)) : 0,
      };
    };

    // Hourly breakdown for last 24 hours
    const hourly = await query(
      `SELECT
         DATE_TRUNC('hour', sent_at) AS hour,
         COUNT(*) AS sent
       FROM email_sends
       WHERE status = 'sent' AND tenant = $1 AND sent_at >= NOW() - INTERVAL '24 hours'
       GROUP BY DATE_TRUNC('hour', sent_at)
       ORDER BY hour ASC`,
      [TENANT]
    );

    res.json({
      last_1h: build(h1[0].rows[0], h1[1].rows[0]),
      last_24h: build(h24[0].rows[0], h24[1].rows[0]),
      hourly: hourly.rows,
    });
  } catch (err) {
    console.error('[Analytics] Error getting recent stats:', err);
    res.status(500).json({ error: 'Failed to get recent analytics' });
  }
});

// GET /api/analytics/stale-contacts — contacts with no engagement, OOO, or left company
router.get('/stale-contacts', async (req: Request, res: Response) => {
  try {
    const [zeroEngagement, oooContacts, leftCompany] = await Promise.all([
      query(`
        SELECT c.id, c.email, c.first_name, c.last_name, c.company,
          COUNT(es.id) AS total_sends,
          MAX(es.sent_at) AS last_sent
        FROM contacts c
        JOIN email_sends es ON es.contact_id = c.id AND es.status = 'sent'
        LEFT JOIN email_events ee ON ee.email_send_id = es.id AND ee.event_type IN ('open', 'click', 'reply')
        WHERE c.tenant = $1 AND ee.id IS NULL
        GROUP BY c.id HAVING COUNT(es.id) >= 4
        ORDER BY COUNT(es.id) DESC LIMIT 100
      `, [TENANT]),
      query(`
        SELECT DISTINCT c.id, c.email, c.first_name, c.last_name, c.company, ee.created_at AS ooo_at
        FROM email_events ee
        JOIN email_sends es ON es.id = ee.email_send_id
        JOIN contacts c ON c.id = es.contact_id
        WHERE ee.event_type = 'ooo' AND es.tenant = $1
        ORDER BY ee.created_at DESC LIMIT 50
      `, [TENANT]),
      query(`
        SELECT DISTINCT c.id, c.email, c.first_name, c.last_name, c.company, ee.created_at AS detected_at
        FROM email_events ee
        JOIN email_sends es ON es.id = ee.email_send_id
        JOIN contacts c ON c.id = es.contact_id
        WHERE ee.event_type = 'left_company' AND es.tenant = $1
        ORDER BY ee.created_at DESC LIMIT 50
      `, [TENANT]),
    ]);

    res.json({
      zero_engagement: zeroEngagement.rows,
      ooo: oooContacts.rows,
      left_company: leftCompany.rows,
    });
  } catch (err) {
    console.error('[Analytics] Error getting stale contacts:', err);
    res.status(500).json({ error: 'Failed to get stale contacts' });
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
         AND tenant = $1
         AND sent_at >= NOW() - INTERVAL '1 day' * $2
       GROUP BY DATE(sent_at AT TIME ZONE 'UTC')
       ORDER BY date ASC`,
      [TENANT, days]
    );

    // Fill in missing dates with zeros
    interface DailyRow { date: string | Date; sent: string; unique_contacts: string }
    const normalize = (d: string | Date) => d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
    const dataMap = new Map((result.rows as DailyRow[]).map((r) => [normalize(r.date), r]));
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
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(String(req.query.days), 10) : 7;
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
        COUNT(es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '1 day' * $2) AS total_sent,
        COUNT(es.id) FILTER (WHERE es.status = 'failed' AND es.created_at > NOW() - INTERVAL '1 day' * $2) AS total_failed,
        COUNT(es.id) FILTER (WHERE es.status = 'queued') AS total_queued,
        CASE WHEN COUNT(es.id) FILTER (WHERE es.status IN ('sent','failed') AND es.created_at > NOW() - INTERVAL '1 day' * $2) > 0
          THEN ROUND(COUNT(es.id) FILTER (WHERE es.status = 'failed' AND es.created_at > NOW() - INTERVAL '1 day' * $2)::numeric / COUNT(es.id) FILTER (WHERE es.status IN ('sent','failed') AND es.created_at > NOW() - INTERVAL '1 day' * $2) * 100, 2)
          ELSE 0 END AS fail_rate
      FROM email_accounts ea
      LEFT JOIN email_sends es ON es.email_account_id = ea.id AND es.tenant = $1
      WHERE ea.tenant = $1
      GROUP BY ea.id
      ORDER BY ea.email
    `, [TENANT, days]);

    res.json(result.rows);
  } catch (err) {
    console.error('[Analytics] Error getting account stats:', err);
    res.status(500).json({ error: 'Failed to get account analytics' });
  }
});

// GET /api/analytics/campaigns — per-campaign stats
router.get('/campaigns', async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(String(req.query.days), 10) : 7;
    const result = await query(`
      SELECT
        s.id,
        s.name,
        s.status,
        COUNT(DISTINCT se.id) AS total_enrollments,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active') AS active_enrollments,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'completed') AS completed_enrollments,
        COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'replied') AS replied_enrollments,
        COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '1 day' * $2) AS emails_sent,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'open' AND ee.created_at > NOW() - INTERVAL '1 day' * $2) AS opens,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'click' AND ee.created_at > NOW() - INTERVAL '1 day' * $2) AS clicks,
        COUNT(DISTINCT ee.id) FILTER (WHERE ee.event_type = 'reply' AND ee.created_at > NOW() - INTERVAL '1 day' * $2) AS replies,
        CASE
          WHEN COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '1 day' * $2) > 0
          THEN ROUND(
            COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'open' AND ee.created_at > NOW() - INTERVAL '1 day' * $2)::numeric /
            COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '1 day' * $2) * 100,
            2
          )
          ELSE 0
        END AS open_rate,
        CASE
          WHEN COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '1 day' * $2) > 0
          THEN ROUND(
            COUNT(DISTINCT ee.email_send_id) FILTER (WHERE ee.event_type = 'click' AND ee.created_at > NOW() - INTERVAL '1 day' * $2)::numeric /
            COUNT(DISTINCT es.id) FILTER (WHERE es.status = 'sent' AND es.sent_at > NOW() - INTERVAL '1 day' * $2) * 100,
            2
          )
          ELSE 0
        END AS click_rate
      FROM sequences s
      LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id
      LEFT JOIN email_sends es ON es.enrollment_id = se.id
      LEFT JOIN email_events ee ON ee.email_send_id = es.id
      WHERE s.tenant = $1
      GROUP BY s.id
      ORDER BY emails_sent DESC
    `, [TENANT, days]);

    res.json(result.rows);
  } catch (err) {
    console.error('[Analytics] Error getting campaign stats:', err);
    res.status(500).json({ error: 'Failed to get campaign analytics' });
  }
});

// GET /api/analytics/broadcasts — article broadcast performance
router.get('/broadcasts', async (_req: Request, res: Response) => {
  try {
    const result = await query(`
      SELECT
        ab.id,
        ad.title,
        ad.sector,
        ab.subsectors,
        ab.contact_type,
        ab.total_contacts,
        ab.total_sent,
        ab.total_opened,
        ab.total_clicked,
        ab.status,
        ab.sent_at
      FROM article_broadcasts ab
      JOIN article_drafts ad ON ad.id = ab.article_id
      WHERE ad.tenant = $1
      ORDER BY ab.sent_at DESC NULLS LAST
      LIMIT 50
    `, [TENANT]);
    res.json(result.rows);
  } catch (err) {
    console.error('[Analytics] Error getting broadcast stats:', err);
    res.status(500).json({ error: 'Failed to get broadcast analytics' });
  }
});

// GET /api/analytics/deliverability — latest check + history
router.get('/deliverability', async (_req: Request, res: Response) => {
  try {
    const latest = await query(
      `SELECT * FROM deliverability_checks WHERE tenant = 'tp' ORDER BY checked_at DESC LIMIT 1`
    );
    const history = await query(
      `SELECT id, checked_at, overall_score, spf_status, dkim_status, dmarc_status, blacklist_status,
              total_sent_7d, open_rate_7d, unsubscribes_7d
       FROM deliverability_checks WHERE tenant = 'tp' ORDER BY checked_at DESC LIMIT 12`
    );
    res.json({ latest: latest.rows[0] || null, history: history.rows });
  } catch (err) {
    console.error('[Analytics] Error getting deliverability:', err);
    res.status(500).json({ error: 'Failed to get deliverability data' });
  }
});

// POST /api/analytics/deliverability/run — trigger a check now
router.post('/deliverability/run', async (_req: Request, res: Response) => {
  try {
    const { execSync } = require('child_process');
    execSync('python3 /root/tp-outreach/scripts/deliverability_check.py --no-email', { timeout: 60000 });
    const latest = await query(
      `SELECT * FROM deliverability_checks WHERE tenant = 'tp' ORDER BY checked_at DESC LIMIT 1`
    );
    res.json({ success: true, result: latest.rows[0] || null });
  } catch (err) {
    console.error('[Analytics] Error running deliverability check:', err);
    res.status(500).json({ error: 'Failed to run deliverability check' });
  }
});

// GET /api/analytics/failed-emails — recent failed sends with contact details
router.get('/failed-emails', async (req: Request, res: Response) => {
  try {
    const days = Math.min(parseInt(String(req.query.days || '7'), 10), 90);
    const result = await query(`
      SELECT
        es.id, es.to_email, es.from_email, es.subject, es.error_message,
        es.created_at, es.status,
        c.first_name, c.last_name, c.company, c.contact_type, c.subsector,
        s.name AS sequence_name
      FROM email_sends es
      LEFT JOIN contacts c ON c.id = es.contact_id
      LEFT JOIN sequence_enrollments se ON se.id = es.enrollment_id
      LEFT JOIN sequences s ON s.id = se.sequence_id
      WHERE es.tenant = $1 AND es.status = 'failed'
        AND es.created_at >= NOW() - INTERVAL '1 day' * $2
      ORDER BY es.created_at DESC
      LIMIT 200
    `, [TENANT, days]);

    const summary = await query(`
      SELECT
        COALESCE(NULLIF(es.error_message, ''), 'Unknown error') AS reason,
        COUNT(*) AS count
      FROM email_sends es
      WHERE es.tenant = $1 AND es.status = 'failed'
        AND es.created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY reason
      ORDER BY count DESC
    `, [TENANT, days]);

    res.json({ emails: result.rows, summary: summary.rows });
  } catch (err) {
    console.error('[Analytics] Error getting failed emails:', err);
    res.status(500).json({ error: 'Failed to get failed emails' });
  }
});

// GET /api/analytics/dmarc — DMARC report summary
router.get('/dmarc', async (req: Request, res: Response) => {
  try {
    const days = parseInt(String(req.query.days || '30'), 10);
    const data = await dmarcScanner.getSummary(days);
    res.json(data);
  } catch (err) {
    console.error('[Analytics] Error getting DMARC reports:', err);
    res.status(500).json({ error: 'Failed to get DMARC reports' });
  }
});

// POST /api/analytics/dmarc/scan — scan Gmail for DMARC reports and archive them
router.post('/dmarc/scan', async (_req: Request, res: Response) => {
  try {
    const result = await dmarcScanner.scanAndArchive();
    await dmarcScanner.setupFiltersForAllAccounts();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Analytics] Error scanning DMARC reports:', err);
    res.status(500).json({ error: 'Failed to scan DMARC reports' });
  }
});

export default router;
