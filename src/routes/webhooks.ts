import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, TENANT } from '../db/connection';
import { sequenceEngine } from '../services/sequence-engine';

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

async function ensureLendersListExists(): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM contact_lists WHERE name = 'Lenders' AND tenant = $1`,
    [TENANT]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await query<{ id: string }>(
    `INSERT INTO contact_lists (name, description, tenant)
     VALUES ('Lenders', 'Lenders enriched via Apollo webhook', $1)
     RETURNING id`,
    [TENANT]
  );
  return created.rows[0].id;
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

async function addToLendersList(email: string, listId: string): Promise<void> {
  const contactResult = await query<{ id: string }>(
    `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
    [email.toLowerCase().trim(), TENANT]
  );
  if (!contactResult.rows[0]) return;

  await query(
    `INSERT INTO contact_list_members (list_id, contact_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [listId, contactResult.rows[0].id]
  );
}

// ---- POST /api/webhooks/apollo ----
// Apollo sends: req.body = raw Buffer (registered with express.raw before global json middleware)
router.post('/apollo', async (req: Request, res: Response) => {
  // Always respond 200 quickly — Apollo will retry on non-2xx
  res.status(200).json({ received: true });

  const webhookSecret = process.env.APOLLO_WEBHOOK_SECRET;
  const rawBody = req.body as Buffer;

  // Verify HMAC signature if secret is configured
  if (webhookSecret) {
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

    // Auto-add to Lenders list
    const listId = await ensureLendersListExists();
    if (contactData.email) {
      await addToLendersList(contactData.email, listId);
    }

    // Auto-enroll new contacts in the Intro Series
    if (result === 'added' && contactData.email) {
      const contactRow = await query<{ id: string }>(
        `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
        [contactData.email.toLowerCase().trim(), TENANT]
      );
      if (contactRow.rows[0]) {
        const seqResult = await query<{ id: string }>(
          `SELECT id FROM sequences WHERE tenant = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
          [TENANT]
        );
        if (seqResult.rows[0]) {
          try {
            await sequenceEngine.enrollContact(seqResult.rows[0].id, contactRow.rows[0].id);
            console.log(`[Webhook/Apollo] Auto-enrolled ${contactData.email} in Intro Series`);
          } catch (err) {
            console.log(`[Webhook/Apollo] Enroll skipped for ${contactData.email}: ${(err as Error).message}`);
          }
        }
      }
    }

    console.log(`[Webhook/Apollo] Contact ${result}: ${contactData.email} → Lenders list`);
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
    signature_verification: !!process.env.APOLLO_WEBHOOK_SECRET,
    message: 'Apollo webhook endpoint is live. Configure this URL in Apollo → Settings → Integrations → Webhooks.',
  });
});

export default router;
