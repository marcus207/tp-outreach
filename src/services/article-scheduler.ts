import { query, TENANT, BRAND_NAME } from '../db/connection';
import {
  buildArticleEmailHtml,
  BROADCAST_RECIPIENT_EXCLUSIONS,
  getBroadcastPlaceholderAccount,
} from '../routes/articles';
import * as crypto from 'crypto';

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';

export async function processScheduledArticles(): Promise<void> {
  const now = new Date();

  // 1. Auto-publish articles whose scheduled_publish_at has passed
  const toPublish = await query(
    `SELECT * FROM article_drafts
     WHERE tenant = $1
       AND status = 'draft'
       AND scheduled_publish_at IS NOT NULL
       AND scheduled_publish_at <= $2`,
    [TENANT, now]
  );

  for (const article of toPublish.rows as any[]) {
    try {
      if (!STRAPI_API_TOKEN) {
        console.error(`[ArticleScheduler] No STRAPI_API_TOKEN — skipping ${article.id}`);
        continue;
      }

      const publishDate = article.publish_date
        ? new Date(article.publish_date).toISOString().split('T')[0]
        : now.toISOString().split('T')[0];

      // Check duplicate slug
      const existing = await fetch(
        `${STRAPI_URL}/api/articles?filters[slug][$eq]=${encodeURIComponent(article.slug)}&pagination[pageSize]=1`
      );
      if (existing.ok) {
        const data = await existing.json() as any;
        if (data.data?.length > 0) {
          console.log(`[ArticleScheduler] Slug exists in Strapi: ${article.slug} — marking published`);
          await query(
            `UPDATE article_drafts SET status = 'published', published_at = $2, updated_at = $2 WHERE id = $1`,
            [article.id, now]
          );
          continue;
        }
      }

      const strapiRes = await fetch(`${STRAPI_URL}/api/articles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${STRAPI_API_TOKEN}`,
        },
        body: JSON.stringify({
          data: {
            title: article.title,
            slug: article.slug,
            excerpt: article.excerpt,
            content: article.content,
            sector: article.sector,
            author: article.author || 'Turning Point Capital Advisory',
            publishDate,
          },
        }),
      });

      if (!strapiRes.ok) {
        const err = await strapiRes.json().catch(() => ({})) as any;
        console.error(`[ArticleScheduler] Strapi failed for ${article.id}:`, err?.error?.message);
        continue;
      }

      // Revalidate website cache
      try {
        for (const path of ['/insights', `/insights/${article.slug}`]) {
          await fetch('http://127.0.0.1:3050/api/revalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: 'tp-revalidate-2026', path }),
          });
        }
      } catch {}

      await query(
        `UPDATE article_drafts SET status = 'published', published_at = $2, updated_at = $2 WHERE id = $1`,
        [article.id, now]
      );

      console.log(`[ArticleScheduler] Published: ${article.title}`);
    } catch (err) {
      console.error(`[ArticleScheduler] Publish error ${article.id}:`, (err as Error).message);
    }
  }

  // 2. Auto-broadcast articles whose scheduled_broadcast_at has passed (and not yet broadcast)
  const toBroadcast = await query(
    `SELECT ad.* FROM article_drafts ad
     WHERE ad.tenant = $1
       AND ad.scheduled_broadcast_at IS NOT NULL
       AND ad.scheduled_broadcast_at <= $2
       AND ad.broadcast_subsectors IS NOT NULL
       AND array_length(ad.broadcast_subsectors, 1) > 0
       AND NOT EXISTS (
         SELECT 1 FROM article_broadcasts ab WHERE ab.article_id = ad.id
       )`,
    [TENANT, now]
  );

  for (const article of toBroadcast.rows as any[]) {
    try {
      const subsectors: string[] = article.broadcast_subsectors;

      const contactsResult = await query<{
        id: string; email: string; first_name: string | null; company: string | null;
      }>(
        `SELECT c.id, c.email, c.first_name, c.company
         FROM contacts c
         WHERE c.subsector = ANY($1) AND c.tenant = $2
         ${BROADCAST_RECIPIENT_EXCLUSIONS}
           -- Exclude contacts who already received (or are queued for) THIS article
           AND NOT EXISTS (
             SELECT 1 FROM email_sends es
             JOIN article_broadcasts ab ON ab.id = es.broadcast_id
             WHERE es.contact_id = c.id
               AND ab.article_id = $3
               AND es.status IN ('queued', 'sent')
           )`,
        [subsectors, TENANT, article.id]
      );

      if (contactsResult.rows.length === 0) {
        console.log(`[ArticleScheduler] No contacts for ${article.id} — skipping broadcast`);
        continue;
      }

      // Placeholder sender only; broadcast-planner assigns the real
      // @go.tp.finance account within budgets and the send window.
      const placeholder = await getBroadcastPlaceholderAccount();
      if (!placeholder) {
        console.error(`[ArticleScheduler] No @go.tp.finance account configured — skipping broadcast ${article.id}`);
        continue;
      }

      const subject = `${article.title} - ${BRAND_NAME}`;

      const recentRes = await query(
        `SELECT title, slug, excerpt, author FROM article_drafts
         WHERE id != $1 AND tenant = $2 AND status IN ('published', 'draft', 'approved')
         ORDER BY publish_date DESC LIMIT 3`,
        [article.id, TENANT]
      );

      const broadcastRes = await query<{ id: string }>(
        `INSERT INTO article_broadcasts (article_id, subsectors, contact_type, total_contacts, total_sent, status, sent_at)
         VALUES ($1, $2, NULL, $3, 0, 'queuing', NOW()) RETURNING id`,
        [article.id, subsectors, contactsResult.rows.length]
      );
      const broadcastId = broadcastRes.rows[0].id;

      console.log(`[ArticleScheduler] Queuing broadcast: ${article.title} → ${contactsResult.rows.length} contacts`);

      // Insert as 'queued' with broadcast_id; broadcast-planner enqueues them
      let queued = 0;
      for (const contact of contactsResult.rows) {
        const trackingId = crypto.randomUUID();
        const renderedHtml = buildArticleEmailHtml(article, contact, trackingId, recentRes.rows as any[]);

        await query(
          `INSERT INTO email_sends (to_email, from_email, subject, body_html, tracking_id, email_account_id, contact_id, status, tenant, broadcast_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9)`,
          [contact.email, placeholder.email, subject, renderedHtml, trackingId, placeholder.id, contact.id, TENANT, broadcastId]
        );
        queued++;
      }

      await query(
        `UPDATE article_broadcasts SET total_sent = $1, status = 'sending' WHERE id = $2`,
        [queued, broadcastId]
      );

      console.log(`[ArticleScheduler] Broadcast queued: ${article.title} → ${queued} emails`);
    } catch (err) {
      console.error(`[ArticleScheduler] Broadcast error ${article.id}:`, (err as Error).message);
    }
  }
}
