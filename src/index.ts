import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';
import { pool, query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from './db/connection';
import { requireAuth, requireApiKey } from './middleware/auth';
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

// ---- Middleware ----
app.use(helmet({
  contentSecurityPolicy: false,
}));

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
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ---- Auth Routes ----
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!process.env.DASHBOARD_PASSWORD || !process.env.DASHBOARD_EMAIL) {
    res.status(500).json({ error: 'Auth not configured' });
    return;
  }
  if (email === process.env.DASHBOARD_EMAIL && password === process.env.DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    req.session.email = email;
    res.json({ success: true, email });
  } else {
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

app.post('/api/auth/forgot-password', async (_req: Request, res: Response) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

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
      res.json({ success: true, sent: true });
    } else {
      // No Gmail connected — return the URL directly (private single-user system)
      res.json({ success: true, sent: false, reset_url: resetUrl });
    }
  } catch (err) {
    console.error('[Auth] Forgot password error:', err);
    res.status(500).json({ error: 'Failed to generate reset link' });
  }
});

app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  const { token, new_password } = req.body;
  if (!token || !new_password || new_password.length < 8) {
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

    if (token !== storedToken) {
      res.status(400).json({ error: 'Invalid reset token' });
      return;
    }

    if (new Date() > new Date(expires_at)) {
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

app.get('/t/:trackingId/click', async (req: Request, res: Response) => {
  const { trackingId } = req.params;
  const redirectUrl = req.query.url as string;

  try {
    const sendResult = await query<{ id: string }>(
      `SELECT id FROM email_sends WHERE tracking_id = $1 AND tenant = $2`,
      [trackingId, TENANT]
    );

    if (sendResult.rows[0]) {
      await query(
        `INSERT INTO email_events (email_send_id, event_type, url, ip_address, user_agent)
         VALUES ($1, 'click', $2, $3, $4)`,
        [
          sendResult.rows[0].id,
          redirectUrl || null,
          req.ip,
          req.headers['user-agent'] || null,
        ]
      );
    }
  } catch (err) {
    console.error('[Tracking] Error recording click:', err);
  }

  if (redirectUrl) {
    res.redirect(redirectUrl);
  } else {
    res.status(200).send('OK');
  }
});

// RFC 8058 one-click unsubscribe (email client UI button)
app.post('/t/:trackingId/unsubscribe', async (req: Request, res: Response) => {
  const { trackingId } = req.params;

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
    const sendResult = await query<{ contact_id: string }>(
      `SELECT contact_id FROM email_sends WHERE tracking_id = $1 AND tenant = $2`,
      [trackingId, TENANT]
    );
    if (sendResult.rows[0]) {
      await query(
        `UPDATE contacts SET tags = array_append(tags, 'unsubscribed'), updated_at = NOW()
         WHERE id = $1 AND NOT ('unsubscribed' = ANY(tags))`,
        [sendResult.rows[0].contact_id]
      );
      await query(
        `UPDATE sequence_enrollments SET status = 'cancelled', updated_at = NOW()
         WHERE contact_id = $1 AND status = 'active' AND tenant = $2`,
        [sendResult.rows[0].contact_id, TENANT]
      );
      await query(
        `INSERT INTO email_events (email_send_id, event_type, ip_address, user_agent)
         SELECT id, 'unsubscribe', $2, $3 FROM email_sends WHERE tracking_id = $1`,
        [trackingId, req.ip, req.headers['user-agent'] || null]
      );
    }
  } catch (err) {
    console.error('[Tracking] Error recording one-click unsubscribe:', err);
  }
  res.status(200).send('OK');
});

// GET unsubscribe — show confirmation page (prevents bot/scanner false positives)
app.get('/t/:trackingId/unsubscribe', async (req: Request, res: Response) => {
  const { trackingId } = req.params;
  const confirmed = req.query.confirm === '1';

  if (!confirmed) {
    res.send(`<!DOCTYPE html><html><head><title>Unsubscribe</title></head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px;color:#333;">
<h2>Unsubscribe from ${BRAND_NAME}</h2>
<p>Click the button below to confirm you'd like to stop receiving emails.</p>
<form method="GET" action="" style="margin-top:24px;">
<input type="hidden" name="confirm" value="1" />
<button type="submit" style="background:#dc2626;color:#fff;border:none;padding:12px 32px;border-radius:6px;font-size:16px;cursor:pointer;">Confirm Unsubscribe</button>
</form>
</body></html>`);
    return;
  }

  try {
    const sendResult = await query<{ contact_id: string }>(
      `SELECT contact_id FROM email_sends WHERE tracking_id = $1 AND tenant = $2`,
      [trackingId, TENANT]
    );
    if (sendResult.rows[0]) {
      await query(
        `UPDATE contacts SET tags = array_append(tags, 'unsubscribed'), updated_at = NOW()
         WHERE id = $1 AND NOT ('unsubscribed' = ANY(tags))`,
        [sendResult.rows[0].contact_id]
      );
      await query(
        `UPDATE sequence_enrollments SET status = 'cancelled', updated_at = NOW()
         WHERE contact_id = $1 AND status = 'active' AND tenant = $2`,
        [sendResult.rows[0].contact_id, TENANT]
      );
      await query(
        `INSERT INTO email_events (email_send_id, event_type, ip_address, user_agent)
         SELECT id, 'unsubscribe', $2, $3 FROM email_sends WHERE tracking_id = $1`,
        [trackingId, req.ip, req.headers['user-agent'] || null]
      );
    }
  } catch (err) {
    console.error('[Tracking] Error recording unsubscribe:', err);
  }
  res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title></head><body style="font-family:Arial,sans-serif;text-align:center;padding:60px;color:#333;"><h2>You've been unsubscribed</h2><p>You will no longer receive emails from ${BRAND_NAME}.</p></body></html>`);
});

// ---- Dripify Ingest Endpoint — creates contacts in TP tenant ----
app.post('/api/dripify/ingest', requireApiKey, async (req: Request, res: Response) => {
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
app.get('/api/digest/:id/approve', async (req: Request, res: Response) => {
  const token = req.query.token as string | undefined;
  if (!token) {
    res.status(400).send('<h2>Invalid link</h2>');
    return;
  }
  try {
    const digest = await digestService.approve(String(req.params.id), token);
    digestService.executeApproved(digest.id).catch((err: Error) =>
      console.error('[Digest] Execute error:', err.message)
    );
    const count = (digest.approved_contacts || digest.contacts).length;
    res.send(`<!DOCTYPE html><html><head><title>Approved</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:80px 20px;color:#333">
<div style="max-width:500px;margin:0 auto">
  <div style="font-size:48px">✓</div>
  <h1 style="color:#16a34a;margin:16px 0 8px">Approved!</h1>
  <p style="font-size:18px;color:#555">${count} emails queued — sending between 9am–5pm UTC today.</p>
  <p style="margin-top:32px"><a href="/outreach/" style="color:#1a1a2e;text-decoration:none;font-weight:600">Open ${BRAND_NAME} Outreach →</a></p>
</div></body></html>`);
  } catch (err) {
    const msg = (err as Error).message;
    res.status(400).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:80px 20px">
<h2 style="color:#dc2626">Error</h2><p>${msg}</p></body></html>`);
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

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), tenant: TENANT });
});

// Serve built React frontend (production)
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));
// HashRouter handles all client-side routing — just serve index.html for non-API routes
app.get('*', (req: Request, res: Response) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/t/')) {
    res.sendFile(path.join(publicDir, 'index.html'));
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`[Index] ${BRAND_NAME} Outreach Engine running on port ${PORT} (tenant: ${TENANT})`);
  console.log(`[Index] Dashboard: https://www.${BRAND_DOMAIN}/outreach/`);
});

export default app;
