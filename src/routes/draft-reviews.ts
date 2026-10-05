import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { draftReviewService } from '../services/draft-review';
import { query, TENANT } from '../db/connection';

const router = Router();

// GET /api/draft-reviews — list all drafts (auth required)
router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const drafts = await draftReviewService.list(50);
    res.json(drafts);
  } catch (err) {
    console.error('[DraftReviews] Error listing drafts:', err);
    res.status(500).json({ error: 'Failed to list drafts' });
  }
});

// GET /api/draft-reviews/series-counts — recipient counts for intro steps + bi-weekly eligible
// IMPORTANT: must be registered BEFORE /:id to avoid Express matching "series-counts" as an ID
router.get('/series-counts', requireAuth, async (_req: Request, res: Response) => {
  try {
    // Count per intro step: contacts at each current_step position
    const introResult = await query<{ step_number: number; template_id: string; due_next: string }>(
      `SELECT ss.step_number, ss.template_id,
        COUNT(DISTINCT se.contact_id) FILTER (WHERE se.status = 'active' AND se.current_step = ss.step_number - 1) as due_next
       FROM sequence_steps ss
       JOIN sequences s ON s.id = ss.sequence_id
       LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id
       WHERE s.tenant = $1 AND s.name = 'TP Hospitality Advisory Series'
       GROUP BY ss.step_number, ss.template_id
       ORDER BY ss.step_number`,
      [TENANT]
    );

    // Count for bi-weekly: eligible contacts from lender lists not emailed in last 10 days
    const biweeklyResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       JOIN contact_lists cl ON cl.id = clm.list_id
       WHERE cl.tenant = $1
         AND LOWER(cl.name) IN ('clients', 'introducers', 'lenders')
         AND c.tenant = $1
         AND NOT ('unsubscribed' = ANY(c.tags))
         AND NOT EXISTS (
           SELECT 1 FROM email_sends es
           WHERE es.contact_id = c.id
             AND es.tenant = $1
             AND es.status IN ('sent', 'queued')
             AND es.created_at > NOW() - INTERVAL '10 days'
         )`,
      [TENANT]
    );

    // Total enrolled in intro series
    const enrolledResult = await query<{ total: string; active: string }>(
      `SELECT
        COUNT(DISTINCT se.contact_id) as total,
        COUNT(DISTINCT se.contact_id) FILTER (WHERE se.status = 'active') as active
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE s.tenant = $1 AND s.name = 'TP Hospitality Advisory Series'`,
      [TENANT]
    );

    const introSteps: Record<string, number> = {};
    for (const row of introResult.rows) {
      introSteps[row.template_id] = parseInt(row.due_next, 10);
    }

    // Total lender contacts (for display)
    const totalResult = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       JOIN contact_lists cl ON cl.id = clm.list_id
       WHERE cl.tenant = $1 AND LOWER(cl.name) IN ('clients', 'introducers', 'lenders') AND c.tenant = $1
         AND NOT ('unsubscribed' = ANY(c.tags))`,
      [TENANT]
    );

    res.json({
      intro_steps: introSteps,
      intro_enrolled: parseInt(enrolledResult.rows[0]?.total || '0', 10),
      intro_active: parseInt(enrolledResult.rows[0]?.active || '0', 10),
      biweekly_eligible: parseInt(biweeklyResult.rows[0]?.count || '0', 10),
      total_contacts: parseInt(totalResult.rows[0]?.count || '0', 10),
    });
  } catch (err) {
    console.error('[DraftReviews] Error getting series counts:', err);
    res.status(500).json({ error: 'Failed to get series counts' });
  }
});

// GET /api/draft-reviews/:id — get single draft with stats (auth required)
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const draft = await draftReviewService.get(id);
    if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
    const stats = await draftReviewService.getStats(id);
    res.json({ ...draft, stats });
  } catch (err) {
    console.error('[DraftReviews] Error getting draft:', err);
    res.status(500).json({ error: 'Failed to get draft' });
  }
});

// POST /api/draft-reviews/generate-bulk — generate all upcoming bi-weekly drafts for next N weeks
router.post('/generate-bulk', requireAuth, async (req: Request, res: Response) => {
  try {
    const weeks = Math.min(parseInt(req.body?.weeks || '13', 10), 26);
    // Run async — client polls the list to see progress
    draftReviewService.generateBulk(weeks).catch(err =>
      console.error('[DraftReviews] Bulk gen error:', err)
    );
    res.json({ success: true, message: `Generating up to ${weeks} drafts in background — refresh the list to see progress` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/draft-reviews/:id/feedback — apply inline feedback from the platform
router.post('/:id/feedback', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { feedback } = req.body;
    if (!feedback?.trim()) { res.status(400).json({ error: 'feedback is required' }); return; }
    const newDraft = await draftReviewService.applyFeedback(id, feedback.trim());
    res.json(newDraft);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/draft-reviews/generate — manually trigger draft generation (auth required)
router.post('/generate', requireAuth, async (_req: Request, res: Response) => {
  try {
    const draft = await draftReviewService.generateDraft();
    await draftReviewService.sendDraftEmail(draft.id);
    res.json({ success: true, draft });
  } catch (err) {
    console.error('[DraftReviews] Error generating draft:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/draft-reviews/:id/regenerate — force new round (auth required)
router.post('/:id/regenerate', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const draft = await draftReviewService.get(id);
    if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
    if (draft.round >= 3) { res.status(400).json({ error: 'Already at maximum 3 rounds' }); return; }
    const newDraft = await draftReviewService.generateDraft();
    await draftReviewService.sendDraftEmail(newDraft.id);
    res.json({ success: true, draft: newDraft });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/draft-reviews/:id — delete a draft (auth required)
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await draftReviewService.deleteDraft(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// PATCH /api/draft-reviews/:id — update email_subject + email_html (auth required)
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { email_subject, email_html } = req.body;
    if (!email_subject || !email_html) {
      res.status(400).json({ error: 'email_subject and email_html are required' }); return;
    }
    const draft = await draftReviewService.updateDraft(id, email_subject, email_html);
    res.json(draft);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/draft-reviews/:id/approve-direct — auth-gated, no token needed (platform UI)
router.post('/:id/approve-direct', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const draft = await draftReviewService.approveDraftDirect(id);
    draftReviewService.executeDraftSend(draft.id).catch(err =>
      console.error('[DraftReviews] Error executing send:', err)
    );
    res.json({ success: true, draft });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/draft-reviews/:id/skip-direct — auth-gated, no token needed (platform UI)
router.post('/:id/skip-direct', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await draftReviewService.skipDraftDirect(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---- Public approve/skip (token-validated, linked from email) ----
// GET only shows a confirmation page; the action happens on POST so that email
// link scanners (which follow GETs) cannot trigger sends.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Returns [id, token] if both are UUID-shaped, otherwise null
function readIdAndToken(req: Request): [string, string] | null {
  const id = String(req.params.id || '');
  const raw = (req.body && typeof req.body.token === 'string') ? req.body.token : req.query.token;
  const token = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(id) || !UUID_RE.test(token)) return null;
  return [id, token];
}

function publicPage(title: string, accent: string, icon: string, heading: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)} — TP Outreach</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;margin:0;padding:40px 20px;text-align:center}
.card{background:#fff;border-radius:12px;padding:40px;max-width:480px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{color:${accent};margin:0 0 12px}p{color:#6b7280;margin:0 0 24px}
a,button{display:inline-block;background:${accent};color:#fff;padding:11px 28px;border-radius:6px;text-decoration:none;font-weight:500;border:none;font-size:15px;cursor:pointer}</style>
</head>
<body>
<div class="card">
  <div style="font-size:48px;margin-bottom:16px">${escapeHtml(icon)}</div>
  <h1>${escapeHtml(heading)}</h1>
  ${bodyHtml}
</div>
</body>
</html>`;
}

function invalidLinkPage(): string {
  return publicPage('Invalid link', '#dc2626', '!', 'Invalid link', '<p>This link is invalid or incomplete.</p>');
}

function errorPage(message: string): string {
  return publicPage('Error', '#dc2626', '!', 'Could not complete', `<p>${escapeHtml(message)}</p>`);
}

function confirmPage(action: 'approve' | 'skip', token: string, theme: string): string {
  const isApprove = action === 'approve';
  return publicPage(
    isApprove ? 'Confirm approval' : 'Confirm skip',
    isApprove ? '#0F2744' : '#374151',
    isApprove ? '?' : '—',
    isApprove ? 'Approve this outreach?' : 'Skip this week?',
    `<p>${isApprove
      ? `Confirm to approve the <strong>${escapeHtml(theme)}</strong> campaign and queue the emails.`
      : `Confirm to skip the <strong>${escapeHtml(theme)}</strong> outreach for this week.`}</p>
  <form method="POST" action="">
    <input type="hidden" name="token" value="${escapeHtml(token)}" />
    <button type="submit">${isApprove ? 'Confirm Approve' : 'Confirm Skip'}</button>
  </form>`
  );
}

// GET /api/draft-reviews/:id/approve?token= — public, shows confirmation page only
router.get('/:id/approve', async (req: Request, res: Response) => {
  const parsed = readIdAndToken(req);
  if (!parsed) { res.status(400).send(invalidLinkPage()); return; }
  try {
    const draft = await draftReviewService.get(parsed[0]);
    if (!draft || draft.approval_token !== parsed[1]) { res.status(400).send(invalidLinkPage()); return; }
    res.send(confirmPage('approve', parsed[1], draft.theme));
  } catch (err) {
    console.error('[DraftReviews] Approve page error:', err);
    res.status(500).send(errorPage('Something went wrong. Please try again.'));
  }
});

// POST /api/draft-reviews/:id/approve — public (token-validated), performs the approval
router.post('/:id/approve', async (req: Request, res: Response) => {
  const parsed = readIdAndToken(req);
  if (!parsed) { res.status(400).send(invalidLinkPage()); return; }
  try {
    const draft = await draftReviewService.approveDraft(parsed[0], parsed[1]);

    // Execute send asynchronously
    draftReviewService.executeDraftSend(draft.id).catch(err =>
      console.error('[DraftReviews] Error executing send:', err)
    );

    res.send(publicPage('Approved', '#0F2744', '✓', 'Outreach Approved',
      `<p>The <strong>${escapeHtml(draft.theme)}</strong> campaign has been approved. Emails are being queued and will send from 9am UTC tomorrow.</p>
  <a href="https://tp.finance/outreach/#/drafts">View in Platform</a>`));
  } catch (err) {
    res.status(400).send(errorPage((err as Error).message));
  }
});

// GET /api/draft-reviews/:id/skip?token= — public, shows confirmation page only
router.get('/:id/skip', async (req: Request, res: Response) => {
  const parsed = readIdAndToken(req);
  if (!parsed) { res.status(400).send(invalidLinkPage()); return; }
  try {
    const draft = await draftReviewService.get(parsed[0]);
    if (!draft || draft.skip_token !== parsed[1]) { res.status(400).send(invalidLinkPage()); return; }
    res.send(confirmPage('skip', parsed[1], draft.theme));
  } catch (err) {
    console.error('[DraftReviews] Skip page error:', err);
    res.status(500).send(errorPage('Something went wrong. Please try again.'));
  }
});

// POST /api/draft-reviews/:id/skip — public (token-validated), performs the skip
router.post('/:id/skip', async (req: Request, res: Response) => {
  const parsed = readIdAndToken(req);
  if (!parsed) { res.status(400).send(invalidLinkPage()); return; }
  try {
    await draftReviewService.skipDraft(parsed[0], parsed[1]);
    res.send(publicPage('Skipped', '#374151', '—', 'Week Skipped',
      `<p>This week's outreach has been skipped. The next draft will be generated automatically in two weeks.</p>
  <a href="https://tp.finance/outreach/#/drafts" style="background:#6b7280">Back to Platform</a>`));
  } catch (err) {
    res.status(400).send(errorPage((err as Error).message));
  }
});

// PATCH /api/draft-reviews/:id/poster — direct poster edit (instant, no AI call)
router.patch('/:id/poster', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { headline, subline } = req.body;
    if (!headline) { res.status(400).json({ error: 'headline is required' }); return; }
    const draft = await draftReviewService.updatePoster(id, headline, subline || '');
    res.json(draft);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/draft-reviews/:id/poster — serve the LinkedIn poster HTML as a standalone page
router.get('/:id/poster', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const draft = await draftReviewService.get(id);
    if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }
    if (!draft.linkedin_poster_html) { res.status(404).json({ error: 'No poster for this draft' }); return; }
    res.setHeader('Content-Type', 'text/html');
    res.send(draft.linkedin_poster_html);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/draft-reviews/seed-intro — idempotent: creates the 4-week intro sequence + templates
router.post('/seed-intro', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await draftReviewService.seedIntroSequence();
    res.json(result);
  } catch (err) {
    console.error('[DraftReviews] Seed intro error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
