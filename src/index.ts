import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';
import { pool, query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from './db/connection';
import { requireAuth } from './middleware/auth';
import { gmailClient } from './services/gmail-client';
import { dripifyMonitor } from './services/dripify-monitor';
import { apolloSyncService } from './services/apollo-sync';

import campaignRoutes from './routes/campaigns';
import contactRoutes from './routes/contacts';
import templateRoutes from './routes/templates';
import analyticsRoutes from './routes/analytics';
import settingsRoutes from './routes/settings';
import digestRoutes from './routes/digest';
import draftReviewRoutes from './routes/draft-reviews';
import webhookRoutes from './routes/webhooks';
import campaignPlannerRoutes from './routes/campaign-planner';
import articleRoutes from './routes/articles';
import pressReleaseRoutes from './routes/press-releases';
import { digestService } from './services/digest';
import { healthCheckService } from './services/health-check';

const app = express();
const PORT = parseInt(process.env.PORT || '3105', 10);

// Trust nginx proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// ---- Security helpers ----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Constant-time string comparison (hash both sides so buffers are equal length)
function safeEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Tiny in-memory fixed-window rate limiter keyed by IP (single process)
function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();
  const current = (key: string) => {
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= Date.now()) return null;
    return entry;
  };
  return {
    isBlocked(key: string): boolean {
      const entry = current(key);
      return !!entry && entry.count >= max;
    },
    hit(key: string): void {
      const entry = current(key);
      if (entry) entry.count++;
      else hits.set(key, { count: 1, resetAt: Date.now() + windowMs });
    },
    reset(key: string): void {
      hits.delete(key);
    },
  };
}

const loginLimiter = createRateLimiter(5, 15 * 60 * 1000);          // 5 failures / 15 min / IP
const forgotPasswordLimiter = createRateLimiter(3, 60 * 60 * 1000); // 3 requests / hour / IP
const resetPasswordLimiter = createRateLimiter(10, 60 * 60 * 1000); // 10 attempts / hour / IP

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ---- Middleware ----
// CSP for the React SPA (and srcdoc email/poster previews, which inherit it).
// /api/* responses are excluded: some authenticated preview pages (e.g. article
// website preview) load third-party scripts and are framed via src=, not srcdoc.
const cspMiddleware = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    connectSrc: ["'self'"],
    frameSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
  },
});

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) { next(); return; }
  cspMiddleware(req, res, next);
});

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? false
    : ['http://localhost:5173', 'http://localhost:3105'],
  credentials: true,
}));

// Webhook routes use express.raw() — MUST be registered BEFORE express.json()
// so the raw body is available for HMAC signature verification
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRoutes);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session — use a unique table name per tenant to avoid session conflicts
const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ---- Auth Routes ----
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!process.env.DASHBOARD_PASSWORD || !process.env.DASHBOARD_EMAIL) {
    res.status(500).json({ error: 'Auth not configured' });
    return;
  }
  const ip = clientKey(req);
  if (loginLimiter.isBlocked(ip)) {
    res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    return;
  }
  // Evaluate both comparisons (no short-circuit) to keep timing uniform
  const emailOk = safeEqual(email, process.env.DASHBOARD_EMAIL);
  const passwordOk = safeEqual(password, process.env.DASHBOARD_PASSWORD);
  if (emailOk && passwordOk) {
    loginLimiter.reset(ip);
    req.session.authenticated = true;
    req.session.email = email;
    res.json({ success: true, email });
  } else {
    loginLimiter.hit(ip);
    console.warn(`[Auth] Failed login from ${ip}`);
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  res.json({ authenticated: !!req.session?.authenticated, email: req.session?.email });
});

// Public health check endpoint (for uptime monitoring)
app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, ts: new Date().toISOString(), tenant: TENANT });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

// Authenticated deep health check
app.get('/api/health/full', requireAuth, async (_req: Request, res: Response) => {
  try {
    const results = await healthCheckService.runAll();
    const allOk = results.every(r => r.ok);
    res.status(allOk ? 200 : 207).json({ ok: allOk, checks: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Same response whatever happens, so the endpoint reveals nothing
const FORGOT_PASSWORD_RESPONSE = {
  success: true,
  message: 'If password reset is configured, a reset link has been emailed to the account owner. It expires in 1 hour.',
};
const RESET_TOKEN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
  const ip = clientKey(req);
  if (forgotPasswordLimiter.isBlocked(ip)) {
    res.status(429).json({ error: 'Too many reset requests. Try again later.' });
    return;
  }
  forgotPasswordLimiter.hit(ip);

  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_MAX_AGE_MS); // 1 hour

    await query(
      `INSERT INTO settings (key, value) VALUES ('pw_reset_token', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({ token, expires_at: expiresAt.toISOString() })]
    );

    const resetUrl = `${process.env.TRACKING_DOMAIN || 'https://tp.finance/outreach'}/#/reset-password?token=${token}`;

    // Try to send via a connected Gmail account
    const accountResult = await query<{ email: string; oauth_tokens: Record<string, unknown> }>(
      `SELECT email, oauth_tokens FROM email_accounts WHERE is_active = true AND tenant = $1 LIMIT 1`,
      [TENANT]
    );

    if (accountResult.rows.length > 0) {
      const account = accountResult.rows[0];
      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials(account.oauth_tokens as Parameters<typeof oauth2Client.setCredentials>[0]);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const emailBody = [
        `To: ${BRAND_EMAIL}`,
        `From: ${account.email}`,
        `Subject: ${BRAND_NAME} Outreach — Password Reset`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        `<p>Click the link below to reset your ${BRAND_NAME} Outreach password. This link expires in 1 hour.</p>`,
        `<p><a href="${resetUrl}">${resetUrl}</a></p>`,
        `<p>If you did not request this, ignore this email.</p>`,
      ].join('\n');
      const encoded = Buffer.from(emailBody).toString('base64url');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
      console.log(`[Auth] Password reset link emailed to ${BRAND_EMAIL} (requested from ${ip})`);
    } else {
      // Never expose the link in the response. With no Gmail account connected,
      // the password must be reset server-side (DASHBOARD_PASSWORD in .env).
      console.warn(`[Auth] Password reset requested from ${ip} but no active Gmail account to send it`);
    }
  } catch (err) {
    console.error('[Auth] Forgot password error:', err);
  }
  res.json(FORGOT_PASSWORD_RESPONSE);
});

app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  const { token, new_password } = req.body || {};
  const ip = clientKey(req);
  if (resetPasswordLimiter.isBlocked(ip)) {
    res.status(429).json({ error: 'Too many attempts. Try again later.' });
    return;
  }
  resetPasswordLimiter.hit(ip);
  if (typeof token !== 'string' || typeof new_password !== 'string' || new_password.length < 8 || /[\r\n]/.test(new_password)) {
    res.status(400).json({ error: 'Token and a password of at least 8 characters are required' });
    return;
  }

  try {
    const result = await query<{ value: { token: string; expires_at: string } }>(
      `SELECT value FROM settings WHERE key = 'pw_reset_token'`
    );

    if (!result.rows[0]) {
      res.status(400).json({ error: 'No reset token found. Please request a new one.' });
      return;
    }

    const { token: storedToken, expires_at } = result.rows[0].value;

    if (!storedToken || !safeEqual(token, storedToken)) {
      res.status(400).json({ error: 'Invalid reset token' });
      return;
    }

    // Enforce expiry, and never honour a stored expiry more than 1 hour out
    const expiresMs = new Date(expires_at).getTime();
    if (!Number.isFinite(expiresMs) || Date.now() > expiresMs || expiresMs - Date.now() > RESET_TOKEN_MAX_AGE_MS) {
      res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
      return;
    }

    // Update password in memory and .env file
    process.env.DASHBOARD_PASSWORD = new_password;
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (/^DASHBOARD_PASSWORD=.*/m.test(envContent)) {
        envContent = envContent.replace(/^DASHBOARD_PASSWORD=.*/m, `DASHBOARD_PASSWORD=${new_password}`);
      } else {
        envContent += `\nDASHBOARD_PASSWORD=${new_password}`;
      }
      fs.writeFileSync(envPath, envContent);
    }

    await query(`DELETE FROM settings WHERE key = 'pw_reset_token'`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ---- Gmail OAuth Routes ----
app.get('/api/auth/gmail', requireAuth, (_req: Request, res: Response) => {
  const url = gmailClient.getAuthUrl();
  res.redirect(url);
});

app.get('/api/auth/gmail/callback', requireAuth, async (req: Request, res: Response) => {
  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Missing OAuth code' });
    return;
  }

  try {
    const { tokens, email, name } = await gmailClient.exchangeCode(code);

    await query(
      // New mailboxes start with zero limits: they must be warmed up deliberately,
      // never inherit the 2000/day column default.
      `INSERT INTO email_accounts (email, display_name, oauth_tokens, tenant, daily_limit, hourly_limit)
       VALUES ($1, $2, $3, $4, 0, 0)
       ON CONFLICT (email) DO UPDATE SET
         oauth_tokens = $3,
         display_name = COALESCE($2, email_accounts.display_name),
         tenant = $4,
         is_active = true,
         updated_at = NOW()`,
      [email, name || email, JSON.stringify(tokens), TENANT]
    );

    console.log(`[Index] Gmail account connected: ${email} (tenant: ${TENANT})`);
    res.redirect('/outreach/#/settings?connected=true');
  } catch (err) {
    console.error('[Index] Gmail OAuth error:', err);
    res.redirect('/outreach/#/settings?error=oauth');
  }
});

// ---- Tracking Endpoints ----
app.get('/t/:trackingId/open', async (req: Request, res: Response) => {
  const { trackingId } = req.params;

  try {
    const sendResult = await query<{ id: string; enrollment_id: string | null }>(
      `SELECT id, enrollment_id FROM email_sends WHERE tracking_id = $1 AND tenant = $2`,
      [trackingId, TENANT]
    );

    if (sendResult.rows[0]) {
      await query(
        `INSERT INTO email_events (email_send_id, event_type, ip_address, user_agent)
         VALUES ($1, 'open', $2, $3)`,
        [
          sendResult.rows[0].id,
          req.ip,
          req.headers['user-agent'] || null,
        ]
      );
    }
  } catch (err) {
    console.error('[Tracking] Error recording open:', err);
  }

  // Return 1x1 transparent GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(pixel);
});

const CLICK_FALLBACK_URL = 'https://www.tp.finance';

// Only redirect to http(s) URLs for a known send, and (when the stored body is
// available) only to hosts that actually appear in that email. Prevents the
// tracking endpoint being used as an open redirect.
function isAllowedClickTarget(rawUrl: string, bodyHtml: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === BRAND_DOMAIN.toLowerCase() || host.endsWith(`.${BRAND_DOMAIN.toLowerCase()}`)) return true;
  if (!bodyHtml) return true; // no stored body to check against: known send + http(s) only
  return bodyHtml.toLowerCase().includes(`//${host}`);
}

app.get('/t/:trackingId/click', async (req: Request, res: Response) => {
  const { trackingId } = req.params;
  const redirectUrl = typeof req.query.url === 'string' ? req.query.url : '';
  let target = CLICK_FALLBACK_URL;

  try {
    const sendResult = await query<{ id: string; body_html: string | null }>(
      `SELECT id, body_html FROM email_sends WHERE tracking_id = $1 AND tenant = $2`,
      [trackingId, TENANT]
    );

    const send = sendResult.rows[0];
    if (send) {
      const allowed = !!redirectUrl && isAllowedClickTarget(redirectUrl, send.body_html);
      if (allowed) target = redirectUrl;
      else if (redirectUrl) console.warn(`[Tracking] Blocked click redirect for ${trackingId} to ${redirectUrl.slice(0, 200)}`);

      await query(
        `INSERT INTO email_events (email_send_id, event_type, url, ip_address, user_agent)
         VALUES ($1, 'click', $2, $3, $4)`,
        [
          send.id,
          redirectUrl || null,
          req.ip,
          req.headers['user-agent'] || null,
        ]
      );
    }
  } catch (err) {
    console.error('[Tracking] Error recording click:', err);
  }

  res.redirect(target);
});

// Full unsubscribe for a tracking id: suppress the recipient address (works even
// when the send has no contact_id, e.g. press releases), tag the contact, cancel
// enrollments and record the event. Returns false if the tracking id is unknown.
async function processUnsubscribe(trackingId: string, req: Request): Promise<boolean> {
  const sendResult = await query<{ id: string; contact_id: string | null; to_email: string | null }>(
    `SELECT id, contact_id, to_email FROM email_sends WHERE tracking_id = $1 AND tenant = $2 LIMIT 1`,
    [trackingId, TENANT]
  );
  const send = sendResult.rows[0];
  if (!send) return false;

  const email = (send.to_email || '').trim();
  if (email) {
    await query(
      `INSERT INTO suppressed_emails (email, domain, reason, source, tenant)
       VALUES (LOWER($1), NULL, 'unsubscribed (link)', 'unsubscribe-link', $2)
       ON CONFLICT DO NOTHING`,
      [email, TENANT]
    );
  }

  // Contact by id if the send has one, otherwise by recipient address
  await query(
    `UPDATE contacts SET tags = array_append(COALESCE(tags, '{}'), 'unsubscribed'), updated_at = NOW()
     WHERE tenant = $1 AND (id = $2 OR LOWER(email) = LOWER(NULLIF($3, '')))
       AND NOT ('unsubscribed' = ANY(COALESCE(tags, '{}')))`,
    [TENANT, send.contact_id, email]
  );
  await query(
    `UPDATE sequence_enrollments SET status = 'cancelled', updated_at = NOW()
     WHERE tenant = $1 AND status IN ('active', 'paused')
       AND contact_id IN (SELECT id FROM contacts WHERE tenant = $1 AND (id = $2 OR LOWER(email) = LOWER(NULLIF($3, ''))))`,
    [TENANT, send.contact_id, email]
  );
  await query(
    `INSERT INTO email_events (email_send_id, event_type, ip_address, user_agent, created_at)
     VALUES ($1, 'unsubscribe', $2, $3, NOW())`,
    [send.id, req.ip, req.headers['user-agent'] || null]
  );
  console.log(`[Tracking] Unsubscribed ${email || '(no address)'} via link ${trackingId}`);
  return true;
}

// RFC 8058 one-click unsubscribe (email client UI button)
app.post('/t/:trackingId/unsubscribe', async (req: Request, res: Response) => {
  const trackingId = String(req.params.trackingId);

  // RFC 8058 requires body to contain List-Unsubscribe=One-Click
  const body = typeof req.body === 'string' ? req.body : '';
  const formBody = req.body?.['List-Unsubscribe'] || '';
  const isValidRfc8058 = body.includes('List-Unsubscribe=One-Click') || formBody === 'One-Click';

  if (!isValidRfc8058) {
    console.log(`[Tracking] Rejected non-RFC-8058 POST unsubscribe for ${trackingId} ua=${req.headers['user-agent']}`);
    res.status(200).send('OK');
    return;
  }

  try {
    await processUnsubscribe(trackingId, req);
  } catch (err) {
    console.error('[Tracking] Error recording one-click unsubscribe:', err);
  }
  res.status(200).send('OK');
});

// GET unsubscribe — show confirmation page (prevents bot/scanner false positives)
app.get('/t/:trackingId/unsubscribe', async (req: Request, res: Response) => {
  const trackingId = String(req.params.trackingId);
  const confirmed = req.query.confirm === '1';
  const brand = escapeHtml(BRAND_NAME);

  if (!confirmed) {
    res.send(`<!DOCTYPE html><html><head><title>Unsubscribe</title><meta name="robots" content="noindex"></head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px;color:#333;">
<h2>Unsubscribe from ${brand}</h2>
<p>Click the button below to confirm you'd like to stop receiving emails.</p>
<form method="GET" action="" style="margin-top:24px;">
<input type="hidden" name="confirm" value="1" />
<button type="submit" style="background:#dc2626;color:#fff;border:none;padding:12px 32px;border-radius:6px;font-size:16px;cursor:pointer;">Confirm Unsubscribe</button>
</form>
</body></html>`);
    return;
  }

  try {
    await processUnsubscribe(trackingId, req);
  } catch (err) {
    console.error('[Tracking] Error recording unsubscribe:', err);
  }
  res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title><meta name="robots" content="noindex"></head><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;color:#333;"><h2>You've been unsubscribed</h2><p>You will no longer receive emails from ${brand}.</p></body></html>`);
});

// ---- Dripify Ingest Endpoint — creates contacts in TP tenant ----
// Key via X-Ingest-Key (preferred) or X-Api-Key header. The ?api_key= query
// param still works for backward compatibility but is deprecated (nginx logs it).
let warnedIngestQueryKey = false;
function requireIngestKey(req: Request, res: Response, next: NextFunction): void {
  const expectedKey = process.env.DRIPIFY_INGEST_KEY;
  if (!expectedKey) {
    res.status(500).json({ error: 'DRIPIFY_INGEST_KEY not configured' });
    return;
  }
  let key = req.get('x-ingest-key') || req.get('x-api-key');
  if (!key && typeof req.query.api_key === 'string') {
    key = req.query.api_key;
    if (!warnedIngestQueryKey) {
      warnedIngestQueryKey = true;
      console.warn('[Dripify] DEPRECATED: ingest key passed in query string (?api_key=). Send it in the X-Ingest-Key header instead.');
    }
  }
  if (!safeEqual(key, expectedKey)) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }
  next();
}

app.post('/api/dripify/ingest', requireIngestKey, async (req: Request, res: Response) => {
  try {
    const payload = req.body || {};
    const snapshotId = await dripifyMonitor.ingestSnapshot(payload);

    // Dripify contacts are TP leads (LinkedIn outreach) — store in TP tenant
    const DRIPIFY_TENANT = 'tp';
    const email = (payload.email || payload.corporateEmail || payload.linkedInEmail || payload.manualEmail || '').toLowerCase().trim();
    if (email) {
      const existing = await query<{ id: string }>(
        `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant = $2`,
        [email, DRIPIFY_TENANT]
      );

      if (existing.rows[0]) {
        await query(
          `UPDATE contacts SET
            first_name     = COALESCE(NULLIF($1, ''), first_name),
            last_name      = COALESCE(NULLIF($2, ''), last_name),
            company        = COALESCE(NULLIF($3, ''), company),
            title          = COALESCE(NULLIF($4, ''), title),
            linkedin_url   = COALESCE(NULLIF($5, ''), linkedin_url),
            company_domain = COALESCE(NULLIF($6, ''), company_domain),
            phone          = COALESCE(NULLIF($7, ''), phone),
            city           = COALESCE(NULLIF($8, ''), city),
            country        = COALESCE(NULLIF($9, ''), country),
            updated_at     = NOW()
          WHERE LOWER(email) = $10 AND tenant = $11`,
          [
            payload.firstName || '', payload.lastName || '',
            payload.company || '', payload.position || '',
            payload.link || '', (payload.companyWebsite || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
            payload.phone || '', payload.city || '',
            payload.country || '', email, DRIPIFY_TENANT,
          ]
        );
        console.log(`[Dripify] Updated existing contact: ${email}`);
      } else {
        await query(
          `INSERT INTO contacts (email, first_name, last_name, company, title,
            linkedin_url, company_domain, phone, city, country, source, tenant)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dripify',$11)`,
          [
            email, payload.firstName || null, payload.lastName || null,
            payload.company || null, payload.position || null,
            payload.link || null,
            (payload.companyWebsite || '').replace(/^https?:\/\//, '').replace(/\/$/, '') || null,
            payload.phone || null, payload.city || null,
            payload.country || null, DRIPIFY_TENANT,
          ]
        );
        console.log(`[Dripify] Created new contact: ${email}`);
      }
    }

    res.json({ success: true, snapshot_id: snapshotId, contact_email: email || null });
  } catch (err) {
    console.error('[Dripify] Error ingesting snapshot:', err);
    res.status(500).json({ error: 'Failed to ingest snapshot' });
  }
});

app.get('/api/dripify/latest', requireAuth, async (_req: Request, res: Response) => {
  try {
    const snapshot = await dripifyMonitor.getLatestSnapshot();
    const alerts = await dripifyMonitor.getUnreadAlerts();
    res.json({ snapshot, alerts });
  } catch (err) {
    console.error('[Dripify] Error getting latest:', err);
    res.status(500).json({ error: 'Failed to get Dripify data' });
  }
});

app.put('/api/dripify/alerts/:id/read', requireAuth, async (req: Request, res: Response) => {
  try {
    await dripifyMonitor.markAlertRead(String(req.params.id));
    res.json({ success: true });
  } catch (err) {
    console.error('[Dripify] Error marking alert read:', err);
    res.status(500).json({ error: 'Failed to mark alert read' });
  }
});

app.put('/api/dripify/alerts/read-all', requireAuth, async (_req: Request, res: Response) => {
  try {
    await dripifyMonitor.markAllAlertsRead();
    res.json({ success: true });
  } catch (err) {
    console.error('[Dripify] Error marking all alerts read:', err);
    res.status(500).json({ error: 'Failed to mark all alerts read' });
  }
});

// ---- Apollo Sync Endpoint ----
app.post('/api/apollo/sync', requireAuth, async (req: Request, res: Response) => {
  const { type = 'incremental' } = req.body;
  try {
    apolloSyncService.syncContacts(type as 'full' | 'incremental').catch((err) => {
      console.error('[Apollo] Background sync error:', err);
    });
    res.json({ success: true, message: `Apollo ${type} sync started` });
  } catch (err) {
    console.error('[Apollo] Error starting sync:', err);
    res.status(500).json({ error: 'Failed to start Apollo sync' });
  }
});

app.get('/api/apollo/logs', requireAuth, async (_req: Request, res: Response) => {
  try {
    const logs = await apolloSyncService.getRecentSyncLogs();
    res.json(logs);
  } catch (err) {
    console.error('[Apollo] Error getting sync logs:', err);
    res.status(500).json({ error: 'Failed to get sync logs' });
  }
});

// ---- Public Digest Approval (token-based, no login needed) ----
// GET only renders a confirmation page (email scanners follow GETs); the actual
// approval happens on POST /api/digest/:id/approve/confirm with the same token.
function publicMessagePage(title: string, color: string, heading: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:80px 20px;color:#333">
<div style="max-width:500px;margin:0 auto">
  <h1 style="color:${color};margin:16px 0 8px">${escapeHtml(heading)}</h1>
  ${bodyHtml}
</div></body></html>`;
}

function readDigestIdAndToken(req: Request): [string, string] | null {
  const id = String(req.params.id || '');
  const raw = (req.body && typeof req.body.token === 'string') ? req.body.token : req.query.token;
  const token = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(id) || !UUID_RE.test(token)) return null;
  return [id, token];
}

const INVALID_DIGEST_LINK = publicMessagePage('Invalid link', '#dc2626', 'Invalid link', '<p>This link is invalid or incomplete.</p>');

app.get('/api/digest/:id/approve', async (req: Request, res: Response) => {
  const parsed = readDigestIdAndToken(req);
  if (!parsed) {
    res.status(400).send(INVALID_DIGEST_LINK);
    return;
  }
  try {
    const digest = await digestService.get(parsed[0]);
    if (!digest || !safeEqual(parsed[1], String(digest.approval_token))) {
      res.status(400).send(INVALID_DIGEST_LINK);
      return;
    }
    const count = (digest.approved_contacts || digest.contacts || []).length;
    res.send(publicMessagePage('Confirm approval', '#1a1a2e', 'Approve this digest?',
      `<p style="font-size:18px;color:#555">${escapeHtml(count)} emails will be queued for sending between 9am–5pm UTC.</p>
  <form method="POST" action="approve/confirm" style="margin-top:24px">
    <input type="hidden" name="token" value="${escapeHtml(parsed[1])}" />
    <button type="submit" style="background:#16a34a;color:#fff;border:none;padding:12px 32px;border-radius:6px;font-size:16px;cursor:pointer">Confirm Approve</button>
  </form>`));
  } catch (err) {
    console.error('[Digest] Approve page error:', err);
    res.status(500).send(publicMessagePage('Error', '#dc2626', 'Error', '<p>Something went wrong. Please try again.</p>'));
  }
});

app.post('/api/digest/:id/approve/confirm', async (req: Request, res: Response) => {
  const parsed = readDigestIdAndToken(req);
  if (!parsed) {
    res.status(400).send(INVALID_DIGEST_LINK);
    return;
  }
  try {
    const digest = await digestService.approve(parsed[0], parsed[1]);
    digestService.executeApproved(digest.id).catch((err: Error) =>
      console.error('[Digest] Execute error:', err.message)
    );
    const count = (digest.approved_contacts || digest.contacts).length;
    res.send(publicMessagePage('Approved', '#16a34a', 'Approved!',
      `<p style="font-size:18px;color:#555">${escapeHtml(count)} emails queued — sending between 9am–5pm UTC today.</p>
  <p style="margin-top:32px"><a href="/outreach/" style="color:#1a1a2e;text-decoration:none;font-weight:600">Open ${escapeHtml(BRAND_NAME)} Outreach →</a></p>`));
  } catch (err) {
    const msg = (err as Error).message;
    res.status(400).send(publicMessagePage('Error', '#dc2626', 'Error', `<p>${escapeHtml(msg)}</p>`));
  }
});

// ---- Protected API Routes ----
app.use('/api/campaigns', requireAuth, campaignRoutes);
app.use('/api/contacts', requireAuth, contactRoutes);
app.use('/api/templates', requireAuth, templateRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);
app.use('/api/settings', requireAuth, settingsRoutes);
app.use('/api/digest', requireAuth, digestRoutes);
// draft-reviews: most routes require auth, but approve/skip are public (token-validated)
app.use('/api/draft-reviews', draftReviewRoutes);
app.use('/api/campaign-planner', requireAuth, campaignPlannerRoutes);
app.use('/api/articles', requireAuth, articleRoutes);
app.use('/api/press-releases', requireAuth, pressReleaseRoutes);

// Serve built React frontend (production)
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));
// HashRouter handles all client-side routing — just serve index.html for non-API routes
// Unknown API routes get a JSON 404 instead of hanging
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});
app.get('*', (req: Request, res: Response) => {
  if (req.path.startsWith('/t/')) {
    res.status(404).send('Not found');
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`[Index] ${BRAND_NAME} Outreach Engine running on port ${PORT} (tenant: ${TENANT})`);
  console.log(`[Index] Dashboard: https://www.${BRAND_DOMAIN}/outreach/`);
});

export default app;
