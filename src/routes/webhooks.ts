import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, TENANT } from '../db/connection';
import { suppressionMatchSql } from '../services/suppression';

const router = Router();

// ---- Helpers ----

interface ApolloContact {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string;
  title?: string | null;
  organization_name?: string | null;
  organization?: { primary_domain?: string; name?: string };
  linkedin_url?: string | null;
  phone_numbers?: Array<{ raw_number: string }>;
  city?: string | null;
  country?: string | null;
  label_names?: string[];
  email_status?: string;
}

function verifyApolloSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  // Apollo sends: X-Apollo-Signature: sha256=<hex>
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Tags that must survive every webhook update, whatever Apollo says
const PROTECTED_TAGS = ['unsubscribed', 'bounced', 'hold'];

/**
 * Mirrors ApolloSyncService.upsertContact (whose method is private):
 *  - never insert or update a suppressed address (exact lower(email), or a
 *    deliberate domain block: source='manual' AND domain IS NOT NULL)
 *  - tags are MERGED (union); protected tags are never dropped
 *  - contact_type / subsector / list membership never touched on update
 *  - new contacts get contact_type NULL (classifier decides), no list, no enrolment
 *  - every query tenant-scoped
 */
async function upsertContact(c: ApolloContact): Promise<'added' | 'updated' | 'skipped'> {
  if (!c.email) return 'skipped';
  const email = c.email.toLowerCase().trim();
  if (!email.includes('@')) return 'skipped';
  const phone = c.phone_numbers?.length ? c.phone_numbers[0].raw_number : null;
  const apolloTags = (c.label_names || []).filter(t => !!t);
  const emailVerified = c.email_status === 'verified';

  const suppressed = await query<{ id: string }>(
    `SELECT 1 AS id WHERE ${suppressionMatchSql('$1::text', '$2')}`,
    [email, TENANT]
  );
  if (suppressed.rows.length > 0) return 'skipped';

  const existing = await query<{ id: string; tags: string[] | null }>(
    `SELECT id, tags FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
    [email, TENANT]
  );

  if (existing.rows[0]) {
    const current = existing.rows[0].tags || [];
    const merged = Array.from(new Set([...current, ...apolloTags]));
    for (const t of PROTECTED_TAGS) {
      if (current.includes(t) && !merged.includes(t)) merged.push(t);
    }
    const upd = await query(
      `UPDATE contacts SET
        apollo_id = COALESCE(
          CASE WHEN $1::text IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM contacts c2 WHERE c2.apollo_id = $1 AND c2.id <> $14)
               THEN $1::text ELSE NULL END,
          apollo_id),
        first_name        = COALESCE($2,  first_name),
        last_name         = COALESCE($3,  last_name),
        title             = COALESCE($4,  title),
        company           = COALESCE($5,  company),
        company_domain    = COALESCE($6,  company_domain),
        linkedin_url      = COALESCE($7,  linkedin_url),
        phone             = COALESCE($8,  phone),
        city              = COALESCE($9,  city),
        country           = COALESCE($10, country),
        tags              = ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(tags, '{}'::text[]) || $11::text[]) AS t),
        email_verified    = $12,
        last_synced_at    = NOW(),
        updated_at        = NOW()
       WHERE id = $14 AND tenant = $13`,
      [
        c.id || null,
        c.first_name || null,
        c.last_name || null,
        c.title || null,
        c.organization_name || null,
        c.organization?.primary_domain || null,
        c.linkedin_url || null,
        phone,
        c.city || null,
        c.country || null,
        merged,
        emailVerified,
        TENANT,
        existing.rows[0].id,
      ]
    );
    return (upd.rowCount || 0) > 0 ? 'updated' : 'skipped';
  }

  const ins = await query<{ id: string }>(
    `INSERT INTO contacts (
      apollo_id, email, first_name, last_name, title, company,
      company_domain, linkedin_url, phone, city, country, tags,
      email_verified, source, last_synced_at, tenant, contact_type
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'apollo',NOW(),$14,NULL)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      c.id && !(await query(`SELECT 1 FROM contacts WHERE apollo_id = $1`, [c.id])).rows.length ? c.id : null,
      email,
      c.first_name || null,
      c.last_name || null,
      c.title || null,
      c.organization_name || null,
      c.organization?.primary_domain || null,
      c.linkedin_url || null,
      phone,
      c.city || null,
      c.country || null,
      apolloTags,
      emailVerified,
      TENANT,
    ]
  );
  return ins.rows.length > 0 ? 'added' : 'skipped';
}

// ---- POST /api/webhooks/apollo ----
// Apollo sends: req.body = raw Buffer (registered with express.raw before global json middleware)
router.post('/apollo', async (req: Request, res: Response) => {
  // Always respond 200 quickly — Apollo will retry on non-2xx
  res.status(200).json({ received: true });

  // Disabled Oct 2026: this webhook fed lender contacts into tp and auto-enrolled them.
  // Lenders belong to Loan Intel, not tp.finance outreach. Opt in explicitly to re-enable.
  if (process.env.APOLLO_WEBHOOK_ENABLED !== 'true') return;

  const webhookSecret = process.env.APOLLO_WEBHOOK_SECRET;
  const rawBody = req.body as Buffer;

  // Fail closed: never accept unsigned payloads
  if (!webhookSecret) {
    console.warn('[Webhook/Apollo] APOLLO_WEBHOOK_SECRET not set — dropping');
    return;
  }
  {
    const sig = (req.headers['x-apollo-signature'] || req.headers['x-webhook-signature'] || '') as string;
    if (!sig) {
      console.warn('[Webhook/Apollo] Request missing signature header — dropping');
      return;
    }
    if (!verifyApolloSignature(rawBody, sig, webhookSecret)) {
      console.warn('[Webhook/Apollo] Invalid signature — dropping');
      return;
    }
  }

  let payload: Record<string, unknown>;
  try {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : String(rawBody);
    if (!bodyStr || bodyStr.trim() === '') return; // Apollo connectivity test ping
    payload = JSON.parse(bodyStr);
  } catch {
    console.warn('[Webhook/Apollo] Failed to parse JSON body');
    return;
  }

  // Log raw payload first time (helps debug Apollo's exact format)
  console.log('[Webhook/Apollo] Received:', JSON.stringify(payload).substring(0, 500));

  // Apollo webhook formats vary slightly — handle both known shapes:
  // Shape A: { event_type: "contact_updated", data: { ...contact } }
  // Shape B: { event: "contact_updated", contact: { ...contact } }
  const eventType = (payload.event_type || payload.event || '') as string;
  const contactData = (payload.data || payload.contact) as ApolloContact | undefined;

  // Only process contact events
  if (!eventType.includes('contact') || !contactData) {
    console.log(`[Webhook/Apollo] Ignoring event type: ${eventType}`);
    return;
  }

  try {
    const result = await upsertContact(contactData);
    if (result === 'skipped') {
      console.log('[Webhook/Apollo] Skipped — no email address');
      return;
    }

    // No auto-listing or auto-enrolment: new contacts must be classified first
    // (lenders are excluded from tp outreach).
    console.log(`[Webhook/Apollo] Contact ${result}: ${contactData.email}`);
  } catch (err) {
    console.error('[Webhook/Apollo] Error processing contact:', (err as Error).message);
  }
});

// GET /api/webhooks/apollo/test — verify the endpoint is reachable (returns 200 + config info)
router.get('/apollo/test', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    tenant: TENANT,
    webhook_url: `${process.env.TRACKING_DOMAIN || `https://www.${process.env.BRAND_DOMAIN || 'tp.finance'}/outreach`}/api/webhooks/apollo`,
    enabled: process.env.APOLLO_WEBHOOK_ENABLED === 'true',
    signature_verification: !!process.env.APOLLO_WEBHOOK_SECRET,
    message: 'Apollo webhook endpoint is live. Configure this URL in Apollo → Settings → Integrations → Webhooks.',
  });
});

export default router;
