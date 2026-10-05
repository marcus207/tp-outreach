import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
import { gmailClient } from '../services/gmail-client';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

const BLOG_ARTICLES_PATH = TENANT === 'loan-intel'
  ? '/root/platform_v2/frontend/src/data/blog-articles.json'
  : '/root/tp_website_dev/frontend/src/data/articles.json';

// ── Broadcast recipient + sender rules (shared with article-scheduler) ───────

// Recipient exclusions (contacts aliased as c). Broadcasts must never go to
// lenders, held/unsubscribed/bounced contacts, or anything on the tenant's
// suppression list (exact email or whole domain).
export const BROADCAST_RECIPIENT_EXCLUSIONS = `
         AND (c.contact_type IS NULL OR c.contact_type <> 'lender')
         AND NOT (COALESCE(c.tags, '{}'::text[]) && ARRAY['hold', 'unsubscribed', 'bounced']::text[])
         AND NOT EXISTS (
           SELECT 1 FROM suppressed_emails sup
           WHERE sup.tenant = c.tenant
             AND (LOWER(sup.email) = LOWER(c.email)
                  OR LOWER(sup.domain) = LOWER(SPLIT_PART(c.email, '@', 2)))
         )`;

// Broadcasts only ever send from the cold-outreach subdomain. marcus@tp.finance
// is reply-scan only.
export const BROADCAST_SENDER_DOMAIN = '@go.tp.finance';

/**
 * Placeholder sender for newly inserted broadcast rows (email_account_id is
 * NOT NULL). broadcast-planner reassigns each row to an active
 * @go.tp.finance account with budget at schedule time. Prefers an active
 * account; returns null if no @go.tp.finance account exists at all.
 */
export async function getBroadcastPlaceholderAccount(): Promise<{ id: string; email: string } | null> {
  const res = await query<{ id: string; email: string }>(
    `SELECT id, email FROM email_accounts
     WHERE tenant = $1 AND LOWER(email) LIKE $2
     ORDER BY is_active DESC, email
     LIMIT 1`,
    [TENANT, `%${BROADCAST_SENDER_DOMAIN}`]
  );
  return res.rows[0] || null;
}

// ── Email HTML template for article broadcasts ───────────────────────────────

interface RecentArticle {
  title: string;
  slug: string;
  excerpt: string;
  author: string;
}

export function buildArticleEmailHtml(article: {
  title: string;
  excerpt: string;
  author: string;
  slug: string;
  publish_date: string;
  sector: string;
  content?: string | null;
  hero_image?: string | null;
}, contact: { first_name: string | null; company: string | null }, trackingId: string, recentArticles: RecentArticle[]): string {
  const firstName = contact.first_name || 'there';
  const articleUrl = `https://www.${BRAND_DOMAIN}/insights/${article.slug}`;

  // Text + link: short personal note linking to the website article. Best for
  // large client-database broadcasts (deliverability). Triggered by sector='announcement'.
  if (article.sector === 'announcement') {
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td style="padding:8px 4px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.7;">
<p style="margin:0 0 16px;">Hi ${firstName},</p>
<p style="margin:0 0 16px;">I wanted to share a transaction we have just completed. Turning Point Capital Advisory arranged a circa &pound;19m development and bridging facility to deliver three new Special Education Needs schools across the Midlands and the South, helping over 300 families access care provision in a school setting.</p>
<p style="margin:0 0 16px;">The full story is here:<br><a href="${articleUrl}" style="color:#1993C5;font-weight:600;">${articleUrl}</a></p>
<p style="margin:0 0 16px;">We specialise in operational real estate, typically on facilities of more than &pound;15m. If you or anyone in your network would benefit from a call, let's book one in for sometime next week.</p>
<p style="margin:0 0 4px;">Best regards,</p>
<p style="margin:0;font-weight:700;">Marcus Emadi</p>
<p style="margin:2px 0 0;color:#555;">CEO, Turning Point Capital Advisory</p>
<p style="margin:4px 0 0;font-size:13px;"><a href="mailto:marcus@tp.finance" style="color:#1993C5;">marcus@tp.finance</a> &middot; <a href="https://${BRAND_DOMAIN}" style="color:#1993C5;">www.${BRAND_DOMAIN}</a></p>
<p style="margin:22px 0 0;font-size:11px;color:#9ca3af;">Turning Point Capital Advisory Ltd, London &middot; <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>`;
  }

  // Generic plain-text note: greeting + article.content (HTML paragraphs) + signature.
  // Reusable for targeted broadcasts (e.g. an introducer note). Triggered by sector='note'.
  if (article.sector === 'note') {
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td style="padding:8px 4px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.7;">
<p style="margin:0 0 16px;">Hi ${firstName},</p>
${article.content || ''}
<p style="margin:0 0 4px;">Best regards,</p>
<p style="margin:0;font-weight:700;">Marcus Emadi</p>
<p style="margin:2px 0 0;color:#555;">CEO, Turning Point Capital Advisory</p>
<p style="margin:4px 0 0;font-size:13px;"><a href="mailto:marcus@tp.finance" style="color:#1993C5;">marcus@tp.finance</a> &middot; <a href="https://${BRAND_DOMAIN}" style="color:#1993C5;">www.${BRAND_DOMAIN}</a></p>
<p style="margin:22px 0 0;font-size:11px;color:#9ca3af;">Turning Point Capital Advisory Ltd, London &middot; <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>`;
  }

  // Announcement layout: when the article has a hero image (e.g. a deal poster),
  // lead with the image and inline the full body rather than the research-notice format.
  if (article.hero_image) {
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0f1a2e;padding:16px 28px;">
<span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">TP</span><span style="color:#9ca3af;font-size:12px;margin-left:8px;font-family:Arial,sans-serif;">Turning Point Capital Advisory</span>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#1993C5,#74DFF6);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:0;font-size:0;"><img src="${article.hero_image}" width="600" alt="${article.title}" style="display:block;width:100%;max-width:600px;height:auto;"/></td></tr>
<tr><td style="padding:28px 28px 8px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#0f1a2e;line-height:1.7;">Hey ${firstName},</p>
<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">We are pleased to share a transaction Turning Point Capital Advisory has just completed.</p>
</td></tr>
<tr><td style="padding:0 28px 8px;font-family:Arial,sans-serif;color:#374151;font-size:15px;line-height:1.7;">
${article.content || ''}
</td></tr>
<tr><td style="padding:8px 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:16px 28px 24px;font-family:Arial,sans-serif;">
<p style="margin:0;font-size:14px;font-weight:700;color:#0f1a2e;">Marcus Emadi</p>
<p style="margin:2px 0 0;font-size:13px;color:#1993C5;font-weight:600;">CEO, Turning Point Capital Advisory</p>
<p style="margin:4px 0 0;font-size:12px;"><a href="mailto:marcus@tp.finance" style="color:#9ca3af;text-decoration:none;">marcus@tp.finance</a> | <a href="https://${BRAND_DOMAIN}" style="color:#9ca3af;text-decoration:none;">${BRAND_DOMAIN}</a></p>
</td></tr>
<tr><td style="background:#f8f9fb;padding:12px 28px;border-top:1px solid #e5e7eb;text-align:center;">
<p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Turning Point Capital Advisory Ltd · London · <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr>
</table>`;
  }

  const excerptTrimmed = article.excerpt.length > 300
    ? article.excerpt.slice(0, 297) + '...'
    : article.excerpt;

  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0f1a2e;padding:16px 28px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">TP</span><span style="color:#9ca3af;font-size:12px;margin-left:8px;font-family:Arial,sans-serif;">Turning Point Capital Advisory</span></td>
</tr></table>
</td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#4db8a4,#74DFF6);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 24px;font-family:Arial,sans-serif;">
<p style="margin:0 0 16px;font-size:15px;color:#0f1a2e;line-height:1.7;">Hey ${firstName},</p>
<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">We have just published new research that we thought you would find relevant.</p>
<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;font-weight:600;">${article.title}</p>
<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.7;">${excerptTrimmed}</p>
<p style="margin:0;"><a href="${articleUrl}" style="color:#0D9488;font-size:14px;font-weight:600;text-decoration:none;">${articleUrl}</a></p>
</td></tr>
<tr><td style="padding:0 28px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:20px 28px;font-family:Arial,sans-serif;">
<p style="margin:0;font-size:14px;font-weight:700;color:#0f1a2e;">Marcus Emadi</p>
<p style="margin:2px 0 0;font-size:13px;color:#4db8a4;font-weight:600;">Managing Director</p>
<p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Turning Point Capital Advisory</p>
<p style="margin:4px 0 0;font-size:12px;"><a href="mailto:marcus@tp.finance" style="color:#9ca3af;text-decoration:none;">marcus@tp.finance</a> · <a href="https://tp.finance" style="color:#9ca3af;text-decoration:none;">tp.finance</a></p>
</td></tr>
<tr><td style="background:#f8f9fb;padding:12px 28px;border-top:1px solid #e5e7eb;text-align:center;">
<p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;">Turning Point Capital Advisory Ltd · London · <a href="{{unsubscribe_url}}" style="color:#9ca3af;">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr>
</table>`;
}

// ── 1. GET /api/articles — List all article drafts ───────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, sector } = req.query;

    const conditions: string[] = [`ad.tenant = '${TENANT}'`];
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      conditions.push(`ad.status = $${params.length}`);
    }

    if (sector) {
      params.push(sector);
      conditions.push(`ad.sector = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await query(
      `SELECT
         ad.*,
         COUNT(ab.id) AS broadcast_count,
         MAX(ab.sent_at) AS broadcasted_at,
         SUM(ab.total_contacts) AS broadcast_total_contacts
       FROM article_drafts ad
       LEFT JOIN article_broadcasts ab ON ab.article_id = ad.id
       ${whereClause}
       GROUP BY ad.id
       ORDER BY ad.publish_date DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Articles] Error listing articles:', err);
    res.status(500).json({ error: 'Failed to list articles' });
  }
});

// ── 2. GET /api/articles/:id — Get single article draft ──────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const articleResult = await query(
      `SELECT * FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}'`,
      [id]
    );

    if (!articleResult.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const broadcastsResult = await query(
      `SELECT ab.*,
         (SELECT COUNT(*) FROM email_sends es WHERE es.broadcast_id = ab.id AND es.status = 'sent') AS actual_sent,
         (SELECT COUNT(*) FROM email_sends es WHERE es.broadcast_id = ab.id AND es.status = 'failed') AS actual_failed
       FROM article_broadcasts ab WHERE ab.article_id = $1 ORDER BY ab.sent_at DESC`,
      [id]
    );

    res.json({
      ...articleResult.rows[0],
      broadcasts: broadcastsResult.rows,
    });
  } catch (err) {
    console.error('[Articles] Error getting article:', err);
    res.status(500).json({ error: 'Failed to get article' });
  }
});

// ── 2b. GET /api/articles/:id/preview-email — Render broadcast email preview ─

router.get('/:id/preview-email', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const articleResult = await query(
      `SELECT * FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}'`,
      [id]
    );

    if (!articleResult.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const article = articleResult.rows[0] as any;

    const recentRes = await query<RecentArticle>(
      `SELECT title, slug, excerpt, author FROM article_drafts
       WHERE id != $1 AND tenant = '${TENANT}' AND status IN ('published', 'draft', 'approved')
       ORDER BY publish_date DESC LIMIT 3`,
      [id]
    );

    const html = buildArticleEmailHtml(
      article,
      { first_name: 'James', company: 'Example Capital' },
      'preview-tracking-id',
      recentRes.rows,
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('[Articles] Error generating preview:', err);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// ── 2c. GET /api/articles/:id/preview-website — Render website preview ───────

const websiteSectorImagePools: Record<string, string[]> = {
  living: [
    '/images/sectors/photo-1545324418-cc1a3fa10c00.jpg',
    '/images/sectors/photo-1460317442991-0ec209397118.jpg',
    '/images/sectors/photo-1574362848149-11496d93a7c7.jpg',
    '/images/sectors/photo-1560448204-e02f11c3d0e2.jpg',
    '/images/sectors/photo-1558036117-15d82a90b9b1.jpg',
    '/images/sectors/photo-1568605114967-8130f3a36994.jpg',
    '/images/sectors/photo-1600585154340-be6161a56a0c.jpg',
    '/images/sectors/photo-1600047509807-ba8f99d2cdde.jpg',
    '/images/sectors/photo-1605276374104-dee2a0ed3cd6.jpg',
    '/images/sectors/photo-1600566753190-17f0baa2a6c3.jpg',
  ],
  hospitality: [
    '/images/sectors/photo-1542314831-068cd1dbfeeb.jpg',
    '/images/sectors/photo-1551882547-ff40c63fe5fa.jpg',
    '/images/sectors/photo-1578683010236-d716f9a3f461.jpg',
    '/images/sectors/photo-1445019980597-93fa8acb246c.jpg',
    '/images/sectors/photo-1618773928121-c32242e63f39.jpg',
    '/images/sectors/photo-1564501049412-61c2a3083791.jpg',
    '/images/sectors/photo-1596436889106-be35e843f974.jpg',
    '/images/sectors/photo-1571003123894-1f0594d2b5d9.jpg',
    '/images/sectors/photo-1582719478250-c89cae4dc85b.jpg',
    '/images/sectors/photo-1455587734955-081b22074882.jpg',
  ],
  office: [
    '/images/sectors/photo-1486406146926-c627a92ad1ab.jpg',
    '/images/sectors/photo-1497366216548-37526070297c.jpg',
    '/images/sectors/photo-1497366811353-6870744d04b2.jpg',
    '/images/sectors/photo-1577412647305-991150c7d163.jpg',
    '/images/sectors/photo-1560179707-f14e90ef3623.jpg',
    '/images/sectors/photo-1568992687947-868a62a9f521.jpg',
    '/images/sectors/photo-1497215842964-222b430dc094.jpg',
    '/images/sectors/photo-1462826303086-329426d1aef5.jpg',
    '/images/sectors/photo-1524758631624-e2822e304c36.jpg',
    '/images/sectors/photo-1556761175-4b46a572b786.jpg',
  ],
  industrial: [
    '/images/sectors/photo-1586528116311-ad8dd3c8310d.jpg',
    '/images/sectors/photo-1553413077-190dd305871c.jpg',
    '/images/sectors/photo-1565891741441-64926e441838.jpg',
    '/images/sectors/photo-1587293852726-70cdb56c2866.jpg',
    '/images/sectors/photo-1749244768351-2726dc23d26c.jpg',
    '/images/sectors/photo-1504307651254-35680f356dfd.jpg',
    '/images/sectors/photo-1611273426858-450d8e3c9fce.jpg',
    '/images/sectors/photo-1578575437130-527eed3abbec.jpg',
    '/images/sectors/photo-1590069261209-f8e9b8642343.jpg',
    '/images/sectors/photo-1715026323282-073e1a65576a.jpg',
  ],
  retail: [
    '/images/sectors/photo-1753699298393-0543088110d1.jpg',
    '/images/sectors/photo-1441984904996-e0b6ba687e04.jpg',
    '/images/sectors/photo-1567449303183-ae0d6ed1498e.jpg',
    '/images/sectors/photo-1758448500866-ed2d4187e32e.jpg',
    '/images/sectors/photo-1534452203293-494d7ddbf7e0.jpg',
    '/images/sectors/photo-1472851294608-062f824d29cc.jpg',
    '/images/sectors/photo-1604719312566-8912e9227c6a.jpg',
    '/images/sectors/photo-1555529669-e69e7aa0ba9a.jpg',
    '/images/sectors/photo-1556742049-0cfed4f6a45d.jpg',
    '/images/sectors/photo-1690451831264-c6b30f17aaac.jpg',
  ],
  esg: [
    '/images/sectors/photo-1473341304170-971dccb5ac1e.jpg',
    '/images/sectors/photo-1509391366360-2e959784a276.jpg',
    '/images/sectors/photo-1713647266530-8a4c01b14033.jpg',
    '/images/sectors/photo-1532601224476-15c79f2f7a51.jpg',
    '/images/sectors/photo-1569163139394-de4e5f43e5ca.jpg',
    '/images/sectors/photo-1559302504-64aae6ca6b6d.jpg',
    '/images/sectors/photo-1548337138-e87d889cc369.jpg',
    '/images/sectors/photo-1497440001374-f26997328c1b.jpg',
    '/images/sectors/photo-1467533003447-e295ff1b0435.jpg',
    '/images/sectors/photo-1595437193398-f24279553f4f.jpg',
  ],
  capital_markets: [
    '/images/sectors/photo-1611974789855-9c2a0a7236a3.jpg',
    '/images/sectors/photo-1590283603385-17ffb3a7f29f.jpg',
    '/images/sectors/photo-1454165804606-c3d57bc86b40.jpg',
    '/images/sectors/photo-1460925895917-afdab827c52f.jpg',
    '/images/sectors/photo-1444653614773-995cb1ef9efa.jpg',
    '/images/sectors/photo-1579532537598-459ecdaf39cc.jpg',
    '/images/sectors/photo-1526304640581-d334cdbbf45e.jpg',
    '/images/sectors/photo-1507679799987-c73779587ccf.jpg',
    '/images/sectors/photo-1549421263-5ec394a5ad4c.jpg',
    '/images/sectors/photo-1486406146926-c627a92ad1ab.jpg',
  ],
  general: [
    '/images/sectors/photo-1486406146926-c627a92ad1ab.jpg',
    '/images/sectors/photo-1444653614773-995cb1ef9efa.jpg',
    '/images/sectors/photo-1513635269975-59663e0ac1ad.jpg',
    '/images/sectors/photo-1480449649358-ee14c6ee0b17.jpg',
    '/images/sectors/photo-1560179707-f14e90ef3623.jpg',
    '/images/sectors/photo-1449824913935-59a10b8d2000.jpg',
    '/images/sectors/photo-1526304640581-d334cdbbf45e.jpg',
    '/images/sectors/photo-1579532537598-459ecdaf39cc.jpg',
    '/images/sectors/photo-1568992687947-868a62a9f521.jpg',
    '/images/sectors/photo-1577412647305-991150c7d163.jpg',
    '/images/sectors/photo-1462826303086-329426d1aef5.jpg',
    '/images/sectors/photo-1554469384-e58fac16e23a.jpg',
  ],
};

const websiteSectorLabels: Record<string, string> = {
  living: 'Living &amp; Residential', hospitality: 'Hospitality', office: 'Office',
  industrial: 'Industrial &amp; Logistics', retail: 'Retail', data_centres: 'Data Centres',
  esg: 'ESG &amp; Sustainability', capital_markets: 'Capital Markets',
  'digital-infrastructure': 'Digital Infrastructure', general: 'General',
};

const websiteAuthorInfo: Record<string, { title: string; bio: string; email: string }> = {
  'Marcus Emadi': { title: 'Director', bio: 'Marcus leads Turning Point Capital Advisory, specialising in sponsor-led and lender-led debt advisory.', email: 'marcus@tp.finance' },
  'Loredana Emadi': { title: 'Head of Research', bio: 'Loredana oversees research and analysis across all sectors at Turning Point Capital Advisory.', email: 'loredana@tp.finance' },
  'Charlotte Wilson': { title: 'Associate Director', bio: 'Charlotte supports deal execution and client management across the advisory team.', email: 'charlotte@tp.finance' },
};

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getWebsiteArticleImage(sector: string, slug: string): string {
  const pool = websiteSectorImagePools[sector] || websiteSectorImagePools.general;
  return pool[hashString(slug) % pool.length];
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n### $1\n\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildWebsitePreviewHtml(article: any, mode: 'cards' | 'article'): string {
  const slug = article.slug;
  const heroImage = getWebsiteArticleImage(article.sector, slug);
  const sectorLabel = websiteSectorLabels[article.sector] || article.sector;
  const author = article.author || 'Turning Point Capital Advisory';
  const aInfo = websiteAuthorInfo[author];
  const publishDateShort = article.publish_date
    ? new Date(article.publish_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  const publishDateLong = article.publish_date
    ? new Date(article.publish_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const title = escHtml(article.title);
  const excerpt = escHtml(article.excerpt || '');

  const head = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: { extend: { colors: { brand: '#74DFF6', dark: '#0A131E', panel: '#111D2E', border: '#1A2A3D' } } }
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { font-family: 'Poppins', sans-serif; }
  body { margin: 0; background: #0A131E; }
  .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
</head>`;

  if (mode === 'cards') {
    return `${head}
<body>
<div style="padding: 24px;">
  <p style="color: #6B7E8F; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 8px 0;">Featured Card (as it appears at the top of /insights)</p>
  <!-- FEATURED CARD — exact copy of insights/page.tsx lines 119-150 -->
  <div style="position: relative; border-radius: 12px; overflow: hidden; cursor: pointer;">
    <div style="position: relative; height: 300px;">
      <img src="${heroImage}" alt="${title}" style="width: 100%; height: 100%; object-fit: cover;">
      <div style="position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0.4) 50%, transparent);"></div>
      <div style="position: absolute; top: 16px; right: 16px; background: rgba(10,19,30,0.6); backdrop-filter: blur(4px); border-radius: 4px; padding: 6px 12px; display: flex; align-items: baseline; gap: 2px;">
        <span style="color: #74DFF6; font-weight: 700; font-size: 18px; line-height: 1;">TP</span>
        <span style="color: #74DFF6; font-weight: 700; font-size: 18px; line-height: 1;">.</span>
      </div>
    </div>
    <div style="position: absolute; bottom: 0; left: 0; right: 0; padding: 24px;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
        <span style="background: #74DFF6; color: white; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 12px; border-radius: 9999px;">${sectorLabel}</span>
        <span style="color: #B0BEC5; font-size: 14px;">${publishDateShort}</span>
      </div>
      <h2 style="font-size: 20px; font-weight: 700; color: white; margin: 0 0 8px 0; line-height: 1.3;">${title}</h2>
      <p style="color: #B0BEC5; font-size: 14px; margin: 0; line-height: 1.5;" class="line-clamp-2">${excerpt}</p>
      ${author ? `<p style="color: #6B7280; font-size: 12px; margin: 12px 0 0 0;">By ${escHtml(author)}</p>` : ''}
    </div>
  </div>

  <p style="color: #6B7E8F; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; margin: 32px 0 8px 0;">Grid Card (as it appears in the article grid)</p>
  <!-- GRID CARD — exact copy of insights/page.tsx lines 156-192 -->
  <div style="max-width: 340px;">
    <div style="border-radius: 12px; overflow: hidden; background: #111D2E; border: 1px solid #1A2A3D; cursor: pointer;">
      <div style="position: relative; height: 180px;">
        <img src="${heroImage}" alt="${title}" style="width: 100%; height: 100%; object-fit: cover;">
        <div style="position: absolute; inset: 0; background: linear-gradient(to top, #111D2E, transparent 60%, transparent);"></div>
        <div style="position: absolute; top: 12px; left: 12px;">
          <span style="background: rgba(116,223,246,0.9); color: white; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 8px; border-radius: 9999px;">${sectorLabel}</span>
        </div>
        <div style="position: absolute; top: 12px; right: 12px; background: rgba(10,19,30,0.6); backdrop-filter: blur(4px); border-radius: 4px; padding: 4px 8px; display: flex; align-items: baseline; gap: 2px;">
          <span style="color: #74DFF6; font-weight: 700; font-size: 14px; line-height: 1;">TP</span>
          <span style="color: #74DFF6; font-weight: 700; font-size: 14px; line-height: 1;">.</span>
        </div>
      </div>
      <div style="padding: 20px;">
        <p style="color: #6B7280; font-size: 12px; margin: 0 0 8px 0;">${publishDateShort}</p>
        <h3 style="color: white; font-weight: 600; font-size: 18px; margin: 0 0 8px 0; line-height: 1.4;" class="line-clamp-2">${title}</h3>
        <p style="color: #B0BEC5; font-size: 14px; margin: 0 0 12px 0; line-height: 1.5;" class="line-clamp-2">${excerpt}</p>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          ${author ? `<p style="color: #6B7280; font-size: 12px; margin: 0;">By ${escHtml(author)}</p>` : ''}
          <span style="color: #74DFF6; font-size: 14px; font-weight: 500;">Read more &rarr;</span>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
  }

  // Full article preview
  const cleanContent = article.content ? stripHtmlToText(article.content) : '';
  const paragraphs = cleanContent.split('\n\n').filter((p: string) => p.trim());
  const contentHtml = paragraphs.map((p: string) => {
    const trimmed = p.trim();
    if (trimmed.startsWith('### ')) {
      return `<h2 style="font-size: 24px; font-weight: 700; color: white; margin: 40px 0 16px 0;">${escHtml(trimmed.replace('### ', ''))}</h2>`;
    }
    if (trimmed.startsWith('- ')) {
      const items = trimmed.split('\n').filter((l: string) => l.startsWith('- '));
      return `<ul style="list-style: disc; padding-left: 24px; color: #D1D5DB; line-height: 1.75; margin: 0 0 24px 0;">${items.map((item: string) => `<li style="margin-bottom: 8px;">${escHtml(item.replace('- ', ''))}</li>`).join('')}</ul>`;
    }
    return `<p style="color: #D1D5DB; line-height: 1.75; margin: 0 0 24px 0;">${escHtml(trimmed)}</p>`;
  }).join('\n');

  const authorBioHtml = aInfo ? `
  <div style="margin-top: 48px; padding: 24px; border-radius: 12px; background: #111D2E; border: 1px solid #1A2A3D;">
    <div style="display: flex; align-items: flex-start; gap: 16px;">
      <div style="width: 48px; height: 48px; border-radius: 9999px; background: #74DFF6; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 18px; flex-shrink: 0;">${author.charAt(0)}</div>
      <div>
        <p style="color: white; font-weight: 600; font-size: 18px; margin: 0;">${escHtml(author)}</p>
        <p style="color: #74DFF6; font-size: 14px; margin: 4px 0 8px 0;">${aInfo.title}</p>
        <p style="color: #9CA3AF; font-size: 14px; line-height: 1.6; margin: 0 0 12px 0;">${aInfo.bio}</p>
        <div style="display: flex; gap: 16px;">
          <span style="color: #74DFF6; font-size: 14px;">${aInfo.email}</span>
          <span style="color: #74DFF6; font-size: 14px;">View full bio</span>
        </div>
      </div>
    </div>
  </div>` : '';

  return `${head}
<body>
<!-- FULL ARTICLE — exact copy of insights/[slug]/page.tsx -->
<main style="min-height: 100vh; background: #0A131E;">
  <div style="position: relative; height: 500px; width: 100%;">
    <img src="${heroImage}" alt="${title}" style="width: 100%; height: 100%; object-fit: cover; position: absolute; inset: 0;">
    <div style="position: absolute; inset: 0; background: linear-gradient(to top, #0A131E, rgba(10,19,30,0.6) 50%, transparent);"></div>
    <div style="position: absolute; top: 24px; right: 24px; background: rgba(10,19,30,0.6); backdrop-filter: blur(4px); border-radius: 8px; padding: 8px 16px; display: flex; align-items: baseline; gap: 4px;">
      <span style="color: #74DFF6; font-weight: 700; font-size: 24px; line-height: 1;">TP</span>
      <span style="color: #74DFF6; font-weight: 700; font-size: 24px; line-height: 1;">.</span>
    </div>
    <div style="position: absolute; bottom: 0; left: 0; right: 0; padding: 32px 0 48px 0;">
      <div style="max-width: 896px; margin: 0 auto; padding: 0 16px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
          <span style="background: #74DFF6; color: white; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 12px; border-radius: 9999px;">${sectorLabel}</span>
          <span style="color: #B0BEC5; font-size: 14px;">${publishDateLong}</span>
        </div>
        <h1 style="font-size: 36px; font-weight: 700; color: white; line-height: 1.2; margin: 0;">${title}</h1>
        ${author ? `<p style="color: #B0BEC5; margin: 16px 0 0 0; font-size: 14px;">By <span style="color: white; font-weight: 500;">${escHtml(author)}</span>${aInfo ? ` <span style="color: #6B7280;">&mdash; ${aInfo.title}</span>` : ''}</p>` : ''}
      </div>
    </div>
  </div>

  <div style="max-width: 896px; margin: 0 auto; padding: 48px 16px;">
    ${excerpt ? `<p style="color: #B0BEC5; font-size: 18px; line-height: 1.75; margin: 0 0 32px 0; border-left: 4px solid #74DFF6; padding-left: 24px; font-style: italic;">${excerpt}</p>` : ''}
    ${contentHtml}
    ${authorBioHtml}
    <div style="margin-top: 32px;">
      <span style="color: #74DFF6; font-size: 14px;">&larr; Back to all insights</span>
    </div>
  </div>
</main>
</body></html>`;
}

router.get('/:id/preview-website', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const mode = (req.query.mode === 'article' ? 'article' : 'cards') as 'cards' | 'article';

    const articleResult = await query(
      `SELECT * FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}'`,
      [id]
    );

    if (!articleResult.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const html = buildWebsitePreviewHtml(articleResult.rows[0], mode);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('[Articles] Error generating website preview:', err);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// ── 3. PUT /api/articles/:id — Update article draft ──────────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, excerpt, content, sector, author, status } = req.body;

    const result = await query(
      `UPDATE article_drafts SET
        title = COALESCE($1, title),
        excerpt = COALESCE($2, excerpt),
        content = COALESCE($3, content),
        sector = COALESCE($4, sector),
        author = COALESCE($5, author),
        status = COALESCE($6, status),
        updated_at = NOW()
      WHERE id = $7 AND tenant = '${TENANT}'
      RETURNING *`,
      [title, excerpt, content, sector, author, status, id]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Articles] Error updating article:', err);
    res.status(500).json({ error: 'Failed to update article' });
  }
});

// ── 4. DELETE /api/articles/:id — Delete article draft ───────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `DELETE FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}' RETURNING id`,
      [id]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Articles] Error deleting article:', err);
    res.status(500).json({ error: 'Failed to delete article' });
  }
});

// ── 5. POST /api/articles/:id/publish — Publish to Strapi CMS ──────────────

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';

router.post('/:id/publish', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const articleResult = await query(
      `SELECT * FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}'`,
      [id]
    );

    if (!articleResult.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const article = articleResult.rows[0] as any;

    if (article.status === 'published') {
      res.status(400).json({ error: 'Article is already published' });
      return;
    }

    if (!STRAPI_API_TOKEN) {
      res.status(500).json({ error: 'STRAPI_API_TOKEN not configured' });
      return;
    }

    const publishDate = article.publish_date
      ? new Date(article.publish_date).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    // Check if slug already exists in Strapi
    const existingCheck = await fetch(
      `${STRAPI_URL}/api/articles?filters[slug][$eq]=${encodeURIComponent(article.slug)}&pagination[pageSize]=1`
    );
    if (existingCheck.ok) {
      const existing = await existingCheck.json() as any;
      if (existing.data && existing.data.length > 0) {
        res.status(400).json({ error: 'An article with this slug already exists on the website' });
        return;
      }
    }

    // Publish to Strapi CMS
    const strapiPayload = {
      data: {
        title: article.title,
        slug: article.slug,
        excerpt: article.excerpt,
        content: article.content,
        sector: article.sector,
        author: article.author || 'Turning Point Capital Advisory',
        publishDate,
      },
    };

    const strapiRes = await fetch(`${STRAPI_URL}/api/articles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      },
      body: JSON.stringify(strapiPayload),
    });

    if (!strapiRes.ok) {
      const errBody = await strapiRes.json().catch(() => ({})) as any;
      console.error('[Articles] Strapi publish failed:', strapiRes.status, errBody);
      res.status(502).json({ error: `Strapi publish failed: ${errBody?.error?.message || strapiRes.statusText}` });
      return;
    }

    const strapiData = await strapiRes.json() as any;
    console.log(`[Articles] Published to Strapi: documentId=${strapiData.data?.documentId}`);

    const now = new Date();
    await query(
      `UPDATE article_drafts SET status = 'published', published_at = $2, updated_at = $2 WHERE id = $1`,
      [id, now]
    );

    // Revalidate the website's Next.js cache so the article appears immediately
    try {
      await fetch('http://127.0.0.1:3050/api/revalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'tp-revalidate-2026', path: '/insights' }),
      });
      await fetch('http://127.0.0.1:3050/api/revalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'tp-revalidate-2026', path: `/insights/${article.slug}` }),
      });
    } catch {}

    // Verify article appears on the live website (Strapi public API)
    let liveVerified = false;
    const liveUrl = `https://tp.finance/insights/${article.slug}`;
    try {
      const check = await fetch(
        `${STRAPI_URL}/api/articles?filters[slug][$eq]=${encodeURIComponent(article.slug)}&pagination[pageSize]=1`
      );
      if (check.ok) {
        const data = await check.json() as any;
        if (data.data && data.data.length > 0) liveVerified = true;
      }
    } catch {}

    console.log(`[Articles] Published article ${id} (slug: ${article.slug}) at ${now.toISOString()} — live: ${liveVerified}`);
    res.json({
      success: true,
      slug: article.slug,
      published_at: now.toISOString(),
      live_verified: liveVerified,
      live_url: liveUrl,
    });
  } catch (err) {
    console.error('[Articles] Error publishing article:', err);
    res.status(500).json({ error: 'Failed to publish article' });
  }
});

// ── 5b. POST /api/articles/:id/broadcast-test — Send test broadcast email ───

router.post('/:id/broadcast-test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email } = req.body as { email: string };

    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    // Test sends bypass the queue, so only allow internal addresses
    const testTo = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@(go\.)?tp\.finance$/.test(testTo)) {
      res.status(400).json({ error: 'Test emails can only be sent to @tp.finance or @go.tp.finance addresses' });
      return;
    }

    const articleResult = await query(
      `SELECT * FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}'`,
      [id]
    );

    if (!articleResult.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const article = articleResult.rows[0] as any;

    const accountRes = await query(
      `SELECT * FROM email_accounts WHERE is_active = true AND tenant = '${TENANT}' LIMIT 1`
    );

    if (!accountRes.rows[0]) {
      res.status(400).json({ error: 'No active email account available' });
      return;
    }

    const account = accountRes.rows[0] as { id: string; email: string };

    const recentRes = await query<RecentArticle>(
      `SELECT title, slug, excerpt, author FROM article_drafts
       WHERE id != $1 AND tenant = '${TENANT}' AND status IN ('published', 'draft', 'approved')
       ORDER BY publish_date DESC LIMIT 3`,
      [id]
    );

    const trackingId = crypto.randomUUID();
    const renderedHtml = buildArticleEmailHtml(
      article,
      { first_name: 'Test', company: 'Test Company' },
      trackingId,
      recentRes.rows
    );

    const subject = `[TEST] ${article.title} - ${BRAND_NAME}`;

    // Send directly via Gmail API — bypass queue and send window
    const accountRecord = accountRes.rows[0] as any;
    await gmailClient.sendEmail(accountRecord, {
      to: testTo,
      from: account.email,
      subject,
      htmlBody: renderedHtml,
    });

    console.log(`[Articles] Test broadcast sent to ${testTo} for article ${id}`);
    res.json({ success: true, message: `Test email sent to ${testTo}` });
  } catch (err) {
    console.error('[Articles] Error sending test broadcast:', err);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// ── 6. POST /api/articles/:id/broadcast — Queue article email to subsector contacts ─
// Rows are inserted as 'queued' with broadcast_id set; broadcast-planner
// schedules them within account budgets and the shared send window.

router.post('/:id/broadcast', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { subsectors } = req.body as { subsectors: string[] };

    if (!Array.isArray(subsectors) || subsectors.length === 0) {
      res.status(400).json({ error: 'subsectors must be a non-empty array' });
      return;
    }

    const articleResult = await query(
      `SELECT * FROM article_drafts WHERE id = $1 AND tenant = '${TENANT}'`,
      [id]
    );

    if (!articleResult.rows[0]) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const article = articleResult.rows[0] as any;

    // Subsector contacts, excluding lenders / held / unsubscribed / bounced / suppressed
    const contactsResult = await query<{
      id: string;
      email: string;
      first_name: string | null;
      company: string | null;
    }>(
      `SELECT c.id, c.email, c.first_name, c.company
       FROM contacts c
       WHERE c.subsector = ANY($1)
         AND c.tenant = '${TENANT}'
         ${BROADCAST_RECIPIENT_EXCLUSIONS}
         -- Exclude contacts who already received (or are queued for) THIS article
         AND NOT EXISTS (
           SELECT 1 FROM email_sends es
           JOIN article_broadcasts ab ON ab.id = es.broadcast_id
           WHERE es.contact_id = c.id
             AND ab.article_id = $2
             AND es.status IN ('queued', 'sent')
         )`,
      [subsectors, id]
    );

    const contacts = contactsResult.rows;

    if (contacts.length === 0) {
      res.status(400).json({ error: 'No contacts found matching the selected subsectors' });
      return;
    }

    const placeholder = await getBroadcastPlaceholderAccount();
    if (!placeholder) {
      res.status(409).json({ error: `No ${BROADCAST_SENDER_DOMAIN} sending account configured for broadcasts` });
      return;
    }

    const subject = `${article.title} - ${BRAND_NAME}`;

    const broadcastRes = await query<{ id: string }>(
      `INSERT INTO article_broadcasts (article_id, subsectors, contact_type, total_contacts, total_sent, status, sent_at)
       VALUES ($1, $2, NULL, $3, 0, 'queuing', NOW()) RETURNING id`,
      [id, subsectors, contacts.length]
    );
    const broadcastId = broadcastRes.rows[0].id;

    console.log(`[Articles] Broadcast ${broadcastId}: queuing ${contacts.length} contacts for article ${id}`);
    res.json({
      success: true,
      contacts_queued: contacts.length,
      subsectors,
      message: `Queued ${contacts.length} emails. The broadcast planner sends them from ${BROADCAST_SENDER_DOMAIN} accounts within account limits during the send window (Mon-Fri 08:00-17:00 UK time)`,
    });

    // Background: render and insert each email as 'queued' (no direct enqueue)
    (async () => {
      try {
        const recentRes = await query<RecentArticle>(
          `SELECT title, slug, excerpt, author FROM article_drafts
           WHERE id != $1 AND tenant = '${TENANT}' AND status IN ('published', 'draft', 'approved')
           ORDER BY publish_date DESC LIMIT 3`,
          [id]
        );
        const recentArticles = recentRes.rows;
        let queued = 0;

        for (const contact of contacts) {
          const trackingId = crypto.randomUUID();
          const renderedHtml = buildArticleEmailHtml(article, contact, trackingId, recentArticles);

          await query(
            `INSERT INTO email_sends (to_email, from_email, subject, body_html, tracking_id, email_account_id, contact_id, status, tenant, broadcast_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', '${TENANT}', $8)`,
            [contact.email, placeholder.email, subject, renderedHtml, trackingId, placeholder.id, contact.id, broadcastId]
          );
          queued++;
        }

        await query(
          `UPDATE article_broadcasts SET total_sent = $1, status = 'sending' WHERE id = $2`,
          [queued, broadcastId]
        );
        console.log(`[Articles] Broadcast ${broadcastId}: finished queuing ${queued} emails`);
      } catch (bgErr) {
        console.error(`[Articles] Broadcast ${broadcastId} background error:`, bgErr);
        await query(
          `UPDATE article_broadcasts SET status = 'failed' WHERE id = $1`,
          [broadcastId]
        ).catch(() => {});
      }
    })();
  } catch (err) {
    console.error('[Articles] Error broadcasting article:', err);
    res.status(500).json({ error: 'Failed to broadcast article' });
  }
});

// ── 7. POST /api/articles/schedule-sequence — Schedule multiple articles on 7-day cadence ─

router.post('/schedule-sequence', async (req: Request, res: Response) => {
  try {
    const { article_ids, start_date, subsectors, broadcast_delay_hours } = req.body as {
      article_ids: string[];
      start_date: string;
      subsectors: string[];
      broadcast_delay_hours?: number;
    };

    if (!Array.isArray(article_ids) || article_ids.length === 0) {
      res.status(400).json({ error: 'article_ids must be a non-empty array' });
      return;
    }

    if (!start_date) {
      res.status(400).json({ error: 'start_date is required' });
      return;
    }

    if (!Array.isArray(subsectors) || subsectors.length === 0) {
      res.status(400).json({ error: 'subsectors must be a non-empty array' });
      return;
    }

    const delayHours = broadcast_delay_hours ?? 2;
    const startDate = new Date(start_date);
    startDate.setUTCHours(9, 0, 0, 0);

    const scheduled: { id: string; title: string; publish_at: string; broadcast_at: string; order: number }[] = [];

    for (let i = 0; i < article_ids.length; i++) {
      const articleId = article_ids[i];
      const publishAt = new Date(startDate.getTime() + i * 7 * 24 * 60 * 60 * 1000);
      const broadcastAt = new Date(publishAt.getTime() + delayHours * 60 * 60 * 1000);

      const result = await query(
        `UPDATE article_drafts
         SET scheduled_publish_at = $2,
             scheduled_broadcast_at = $3,
             broadcast_subsectors = $4,
             sequence_order = $5,
             publish_date = $6::date,
             updated_at = NOW()
         WHERE id = $1 AND tenant = '${TENANT}'
         RETURNING id, title`,
        [articleId, publishAt, broadcastAt, subsectors, i + 1, publishAt.toISOString().split('T')[0]]
      );

      if (result.rows[0]) {
        scheduled.push({
          id: result.rows[0].id,
          title: (result.rows[0] as any).title,
          publish_at: publishAt.toISOString(),
          broadcast_at: broadcastAt.toISOString(),
          order: i + 1,
        });
      }
    }

    console.log(`[Articles] Scheduled ${scheduled.length} articles starting ${start_date} (7-day cadence, ${delayHours}h broadcast delay)`);
    res.json({ success: true, scheduled });
  } catch (err) {
    console.error('[Articles] Error scheduling sequence:', err);
    res.status(500).json({ error: 'Failed to schedule sequence' });
  }
});

// ── 8. POST /api/articles/:id/clear-schedule — Remove schedule from an article ─

router.post('/:id/clear-schedule', async (req: Request, res: Response) => {
  try {
    await query(
      `UPDATE article_drafts
       SET scheduled_publish_at = NULL, scheduled_broadcast_at = NULL, broadcast_subsectors = NULL, sequence_order = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant = '${TENANT}'`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear schedule' });
  }
});

export default router;
