/**
 * Campaign Planner API
 *
 * Manages sector-based outreach campaigns with configurable frequency.
 * GET  /api/campaign-planner/settings        — current frequency + start date
 * PUT  /api/campaign-planner/settings        — update frequency/start/active
 * GET  /api/campaign-planner/sectors         — list sectors with contact counts
 * GET  /api/campaign-planner/schedule        — full schedule (optional ?sector=)
 * GET  /api/campaign-planner/schedule/:id    — single schedule entry
 * PUT  /api/campaign-planner/schedule/:id    — update a schedule entry
 * GET  /api/campaign-planner/preview/:id     — render preview with hero image
 * GET  /api/campaign-planner/hero-images     — list available hero images
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
const router = Router();

// ─── Hero image helpers ────────────────────────────────────────────────────────

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

// ─── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const result = await query<{
      frequency_days: number;
      start_date: string;
      is_active: boolean;
    }>(
      `SELECT frequency_days, start_date, is_active FROM campaign_settings WHERE tenant = $1`,
      [TENANT]
    );
    res.json(result.rows[0] || { frequency_days: 30, start_date: '2026-05-01', is_active: false });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put('/settings', async (req: Request, res: Response) => {
  try {
    const { frequency_days, start_date, is_active } = req.body;
    const result = await query<{
      frequency_days: number;
      start_date: string;
      is_active: boolean;
    }>(
      `INSERT INTO campaign_settings (tenant, frequency_days, start_date, is_active)
       VALUES ($4, COALESCE($1, 30), COALESCE($2, '2026-05-01'), COALESCE($3, false))
       ON CONFLICT (tenant) DO UPDATE SET
         frequency_days = COALESCE($1, campaign_settings.frequency_days),
         start_date     = COALESCE($2, campaign_settings.start_date),
         is_active      = COALESCE($3, campaign_settings.is_active),
         updated_at     = NOW()
       RETURNING frequency_days, start_date, is_active`,
      [frequency_days, start_date, is_active, TENANT]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Sectors ───────────────────────────────────────────────────────────────────

router.get('/sectors', async (_req: Request, res: Response) => {
  try {
    // Get all sectors from the schedule with contact counts
    const schedSectors = await query<{ sector: string; sends: string }>(
      `SELECT sector, COUNT(*) as sends
       FROM campaign_schedule WHERE tenant = $1
       GROUP BY sector ORDER BY sector`,
      [TENANT]
    );

    // Get contact counts per sector from custom_fields
    const contactCounts = await query<{ sector: string; count: string }>(
      `SELECT custom_fields->>'sector' as sector, COUNT(*) as count
       FROM contacts
       WHERE custom_fields->>'sector' IS NOT NULL
         AND tenant = $1
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

// ─── Schedule ──────────────────────────────────────────────────────────────────

router.get('/schedule', async (req: Request, res: Response) => {
  try {
    const sector = req.query.sector as string | undefined;
    let sql = `SELECT cs.*, s.frequency_days, s.start_date
               FROM campaign_schedule cs
               CROSS JOIN campaign_settings s
               WHERE cs.tenant = $1 AND s.tenant = $1`;
    const params: (string | undefined)[] = [TENANT];

    if (sector) {
      sql += ` AND cs.sector = $2`;
      params.push(sector);
    }

    sql += ` ORDER BY cs.sector, cs.send_number`;

    const result = await query(sql, params);

    // Calculate send dates based on frequency
    const rows = result.rows.map((r: any) => {
      const startDate = new Date(r.start_date);
      const sendDate = new Date(startDate);
      sendDate.setDate(sendDate.getDate() + (r.send_number - 1) * r.frequency_days);
      return {
        ...r,
        calculated_send_date: sendDate.toISOString().split('T')[0],
      };
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/schedule/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM campaign_schedule WHERE id = $1 AND tenant = $2`,
      [req.params.id, TENANT]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put('/schedule/:id', async (req: Request, res: Response) => {
  try {
    const { hero_image, subject_line, body_copy, article_slug, article_title, article_excerpt, status } = req.body;
    await query(
      `UPDATE campaign_schedule
       SET hero_image      = COALESCE($1, hero_image),
           subject_line    = COALESCE($2, subject_line),
           body_copy       = COALESCE($3, body_copy),
           article_slug    = COALESCE($4, article_slug),
           article_title   = COALESCE($5, article_title),
           article_excerpt = COALESCE($6, article_excerpt),
           status          = COALESCE($7, status),
           updated_at      = NOW()
       WHERE id = $8 AND tenant = $9`,
      [hero_image, subject_line, body_copy, article_slug, article_title, article_excerpt, status, req.params.id, TENANT]
    );
    const result = await query(
      `SELECT * FROM campaign_schedule WHERE id = $1 AND tenant = $2`,
      [req.params.id, TENANT]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Preview ───────────────────────────────────────────────────────────────────

router.get('/preview/:id', async (req: Request, res: Response) => {
  try {
    const result = await query<{
      hero_image: string;
      subject_line: string;
      body_copy: string;
      sector: string;
      article_title: string | null;
    }>(
      `SELECT hero_image, subject_line, body_copy, sector, article_title
       FROM campaign_schedule WHERE id = $1 AND tenant = $2`,
      [req.params.id, TENANT]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });

    const entry = result.rows[0];
    const heroDataUri = heroToDataUri(entry.hero_image);

    // Build a full email preview HTML
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

function buildEmailPreview(entry: { hero_image: string; subject_line: string; body_copy: string; sector: string; article_title: string | null }, heroDataUri: string): string {
  // Replace merge fields with sample data for preview
  const sampleData: Record<string, string> = {
    first_name: 'John',
    last_name: 'Smith',
    sector: entry.sector,
    sector_image: heroDataUri,
    company: 'Sample Corp',
  };

  let body = entry.body_copy;
  let subject = entry.subject_line;
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

// ─── Template hero image (serves the base64 image from a template) ────────────

router.get('/template-hero/:templateId', async (req: Request, res: Response) => {
  try {
    const result = await query<{ body_html: string }>(
      `SELECT body_html FROM templates WHERE id = $1`,
      [req.params.templateId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });

    const match = result.rows[0].body_html.match(/data:image\/[^"]+/);
    if (!match) return res.status(404).json({ error: 'No image found' });

    const dataUri = match[0];
    const [header, base64Data] = dataUri.split(',');
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const buffer = Buffer.from(base64Data, 'base64');
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Hero images list ──────────────────────────────────────────────────────────

router.get('/hero-images', async (_req: Request, res: Response) => {
  try {
    const images = listHeroImages();
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Campaign Engine Controls ─────────────────────────────────────────────────

import { campaignEngine } from '../services/campaign-engine';

// GET /engine/status — current engine state + stats
router.get('/engine/status', async (_req: Request, res: Response) => {
  try {
    const status = campaignEngine.getStatus();
    const stats = await campaignEngine.getStats();
    res.json({ ...status, ...stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /engine/run — manual trigger
router.post('/engine/run', async (_req: Request, res: Response) => {
  try {
    const result = await campaignEngine.tick();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /engine/pause — pause campaign
router.post('/engine/pause', async (_req: Request, res: Response) => {
  try {
    await query(
      `UPDATE campaign_settings SET is_active = false, updated_at = NOW() WHERE tenant = $1`,
      [TENANT]
    );
    res.json({ is_active: false });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /engine/resume — resume campaign
router.post('/engine/resume', async (_req: Request, res: Response) => {
  try {
    await query(
      `UPDATE campaign_settings SET is_active = true, updated_at = NOW() WHERE tenant = $1`,
      [TENANT]
    );
    res.json({ is_active: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /engine/log — recent send activity
router.get('/engine/log', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const log = await campaignEngine.getLog(limit);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /engine/approve-all — bulk approve all draft entries
router.post('/engine/approve-all', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `UPDATE campaign_schedule SET status = 'approved', updated_at = NOW()
       WHERE tenant = $1 AND status = 'draft'`,
      [TENANT]
    );
    res.json({ approved: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
