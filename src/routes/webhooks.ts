import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, TENANT } from '../db/connection';

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

async function upsertContact(c: ApolloContact): Promise<'added' | 'updated' | 'skipped'> {
  if (!c.email) return 'skipped';
  const email = c.email.toLowerCase().trim();
  const phone = c.phone_numbers?.length ? c.phone_numbers[0].raw_number : null;
  const tags = c.label_names || [];
  const emailVerified = c.email_status === 'verified';

  const existing = await query<{ id: string }>(
    `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
    [email, TENANT]
  );

  if (existing.rows[0]) {
    await query(
      `UPDATE contacts SET
        apollo_id         = COALESCE($1,  apollo_id),
        first_name        = COALESCE($2,  first_name),
        last_name         = COALESCE($3,  last_name),
        title             = COALESCE($4,  title),
        company           = COALESCE($5,  company),
        company_domain    = COALESCE($6,  company_domain),
        linkedin_url      = COALESCE($7,  linkedin_url),
        phone             = COALESCE($8,  phone),
        city              = COALESCE($9,  city),
        country           = COALESCE($10, country),
        tags              = $11,
        email_verified    = $12,
        last_synced_at    = NOW(),
        updated_at        = NOW()
       WHERE LOWER(email) = $13 AND tenant = $14`,
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
        tags,
        emailVerified,
        email,
        TENANT,
      ]
    );
    return 'updated';
  } else {
    await query(
      `INSERT INTO contacts (
        apollo_id, email, first_name, last_name, title, company,
        company_domain, linkedin_url, phone, city, country, tags,
        email_verified, source, last_synced_at, tenant
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'apollo',NOW(),$14)`,
      [
        c.id || null,
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
        tags,
        emailVerified,
        TENANT,
      ]
    );
    return 'added';
  }
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
