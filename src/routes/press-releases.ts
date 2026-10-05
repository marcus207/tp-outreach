import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { query, TENANT, BRAND_NAME, BRAND_DOMAIN, BRAND_EMAIL } from '../db/connection';
import { sendQueue } from '../services/send-queue';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── 1. GET /api/press-releases/contacts — List press contacts ────────────────

router.get('/contacts', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM press_contacts WHERE is_active = true ORDER BY publication, is_primary DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[PressReleases] Error listing contacts:', err);
    res.status(500).json({ error: 'Failed to list press contacts' });
  }
});

// ── 2. POST /api/press-releases/contacts — Add a press contact ───────────────

router.post('/contacts', async (req: Request, res: Response) => {
  try {
    const { publication, publication_url, contact_name, contact_role, email, focus_notes, is_primary } = req.body;

    const result = await query(
      `INSERT INTO press_contacts (publication, publication_url, contact_name, contact_role, email, focus_notes, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [publication, publication_url, contact_name, contact_role, email, focus_notes, is_primary || false]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PressReleases] Error adding contact:', err);
    res.status(500).json({ error: 'Failed to add press contact' });
  }
});

// ── 3. DELETE /api/press-releases/contacts/:id ───────────────────────────────

router.delete('/contacts/:id', async (req: Request, res: Response) => {
  try {
    await query(`UPDATE press_contacts SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[PressReleases] Error deleting contact:', err);
    res.status(500).json({ error: 'Failed to delete press contact' });
  }
});

// ── 4. GET /api/press-releases — List all press releases ─────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, announcement } = req.query;
    const conditions: string[] = [`pr.tenant = '${TENANT}'`];
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      conditions.push(`pr.status = $${params.length}`);
    }
    if (announcement) {
      params.push(announcement);
      conditions.push(`pr.announcement_title = $${params.length}`);
    }

    const result = await query(
      `SELECT pr.*, pc.contact_name, pc.email as contact_email, pc.publication_url
       FROM press_releases pr
       LEFT JOIN press_contacts pc ON pc.id = pr.press_contact_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY pr.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[PressReleases] Error listing press releases:', err);
    res.status(500).json({ error: 'Failed to list press releases' });
  }
});

// ── 5. GET /api/press-releases/announcements — List unique announcements ─────

router.get('/announcements', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT announcement_title,
              COUNT(*) as release_count,
              COUNT(*) FILTER (WHERE status = 'sent') as sent_count,
              COUNT(*) FILTER (WHERE status = 'draft') as draft_count,
              MIN(created_at) as created_at
       FROM press_releases
       WHERE tenant = '${TENANT}'
       GROUP BY announcement_title
       ORDER BY MIN(created_at) DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[PressReleases] Error listing announcements:', err);
    res.status(500).json({ error: 'Failed to list announcements' });
  }
});

// ── 6. GET /api/press-releases/:id — Get single press release ────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT pr.*, pc.contact_name, pc.email as contact_email, pc.publication_url, pc.focus_notes
       FROM press_releases pr
       LEFT JOIN press_contacts pc ON pc.id = pr.press_contact_id
       WHERE pr.id = $1 AND pr.tenant = '${TENANT}'`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Press release not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PressReleases] Error getting press release:', err);
    res.status(500).json({ error: 'Failed to get press release' });
  }
});

// ── 7. PUT /api/press-releases/:id — Update press release ────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { headline, subheadline, body, spokesperson_name, spokesperson_title,
            spokesperson_quote, boilerplate, notes_to_editors, status } = req.body;

    const result = await query(
      `UPDATE press_releases SET
        headline = COALESCE($1, headline),
        subheadline = COALESCE($2, subheadline),
        body = COALESCE($3, body),
        spokesperson_name = COALESCE($4, spokesperson_name),
        spokesperson_title = COALESCE($5, spokesperson_title),
        spokesperson_quote = COALESCE($6, spokesperson_quote),
        boilerplate = COALESCE($7, boilerplate),
        notes_to_editors = COALESCE($8, notes_to_editors),
        status = COALESCE($9, status),
        updated_at = NOW()
      WHERE id = $10 AND tenant = '${TENANT}'
      RETURNING *`,
      [headline, subheadline, body, spokesperson_name, spokesperson_title,
       spokesperson_quote, boilerplate, notes_to_editors, status, req.params.id]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Press release not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PressReleases] Error updating press release:', err);
    res.status(500).json({ error: 'Failed to update press release' });
  }
});

// ── 8. DELETE /api/press-releases/:id ────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM press_releases WHERE id = $1 AND tenant = '${TENANT}' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Press release not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[PressReleases] Error deleting press release:', err);
    res.status(500).json({ error: 'Failed to delete press release' });
  }
});

// ── 9. POST /api/press-releases/generate — Generate press releases for an announcement ─

router.post('/generate', async (req: Request, res: Response) => {
  try {
    const { announcement_title, announcement_body, publications } = req.body as {
      announcement_title: string;
      announcement_body: string;
      publications?: string[];
    };

    if (!announcement_title || !announcement_body) {
      res.status(400).json({ error: 'announcement_title and announcement_body are required' });
      return;
    }

    // Get target publications (primary contacts only)
    const pubFilter = publications && publications.length > 0
      ? `AND publication = ANY($1)`
      : '';
    const pubParams = publications && publications.length > 0 ? [publications] : [];

    const contactsResult = await query(
      `SELECT * FROM press_contacts WHERE is_active = true AND is_primary = true ${pubFilter} ORDER BY publication`,
      pubParams
    );

    if (contactsResult.rows.length === 0) {
      res.status(400).json({ error: 'No active press contacts found' });
      return;
    }

    const today = new Date();
    const dateline = `LONDON, ${today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;

    const created: any[] = [];

    for (const contact of contactsResult.rows) {
      const pub = contact as any;

      // Generate a publication-specific angle based on their focus
      const anglePrompt = pub.focus_notes || 'General trade press';
      const body = generatePressReleaseBody(announcement_title, announcement_body, pub.publication, anglePrompt);

      const result = await query(
        `INSERT INTO press_releases
          (announcement_title, publication, press_contact_id, headline, subheadline, dateline, body,
           spokesperson_name, spokesperson_title, spokesperson_quote, tenant)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '${TENANT}')
         RETURNING *`,
        [
          announcement_title,
          pub.publication,
          pub.id,
          body.headline,
          body.subheadline,
          dateline,
          body.body,
          'Marcus Emadi',
          `CEO, ${BRAND_NAME}`,
          body.quote,
        ]
      );

      created.push({ ...result.rows[0], contact_email: pub.email });
    }

    console.log(`[PressReleases] Generated ${created.length} press releases for: ${announcement_title}`);
    res.json({ success: true, count: created.length, releases: created });
  } catch (err) {
    console.error('[PressReleases] Error generating press releases:', err);
    res.status(500).json({ error: 'Failed to generate press releases' });
  }
});

function generatePressReleaseBody(
  title: string,
  announcement: string,
  publication: string,
  focusNotes: string
): { headline: string; subheadline: string; body: string; quote: string } {
  // Publication-specific angles
  const angles: Record<string, { focus: string; tone: string }> = {
    'The Intermediary': {
      focus: 'how this helps intermediaries and brokers serve their clients better',
      tone: 'practical, broker-audience friendly',
    },
    'Property Week': {
      focus: 'commercial real estate market impact, deal flow implications, institutional perspective',
      tone: 'authoritative, data-driven, hard news',
    },
    'Bridging & Commercial': {
      focus: 'specialist lending market, bridging and development finance implications',
      tone: 'deal-focused, market-specific',
    },
    'Development Finance Today': {
      focus: 'development finance, construction lending, project completions',
      tone: 'development-focused, project lifecycle',
    },
    'NACFB': {
      focus: 'benefits for NACFB members, commercial finance broker perspective',
      tone: 'membership-oriented, professional development',
    },
    'The Drawdown': {
      focus: 'fund operations, LP/GP dynamics, lending fund infrastructure',
      tone: 'institutional, fund management perspective',
    },
    'Green Street': {
      focus: 'data analytics, market research, institutional-grade intelligence',
      tone: 'research-oriented, analytical',
    },
    'Financial Reporter': {
      focus: 'specialist lending news, product innovation, market trends',
      tone: 'news-driven, comprehensive',
    },
    'Mortgage Solutions': {
      focus: 'specialist lending innovation, mortgage market evolution',
      tone: 'industry-focused, editorial',
    },
    'Mortgage Introducer': {
      focus: 'intermediary tools and market access, broker enablement',
      tone: 'intermediary-focused, practical',
    },
    'BDLA (formerly ASTL)': {
      focus: 'industry standards, responsible lending, short-term lending market',
      tone: 'association-appropriate, industry leadership',
    },
  };

  const angle = angles[publication] || { focus: focusNotes, tone: 'professional, news-style' };

  // Build publication-specific headline
  const headlineVariants: Record<string, string> = {
    'The Intermediary': `${BRAND_NAME} Platform Gives Brokers Real-Time Lender Intelligence — ${title}`,
    'Property Week': `${title}: New Platform Brings Deal-Level Transparency to UK CRE Lending`,
    'Bridging & Commercial': `${title} — ${BRAND_NAME} Launches Specialist Lending Intelligence Tool`,
    'Development Finance Today': `${title}: ${BRAND_NAME} Brings Data-Driven Intelligence to Development Lenders`,
    'NACFB': `${title} — New Lender Intelligence Platform Available to NACFB Members`,
    'The Drawdown': `${title}: Fund-Level Lending Analytics Platform Launches for UK Market`,
    'Green Street': `${BRAND_NAME} Launches CRE Lending Analytics Platform — ${title}`,
    'Financial Reporter': `${title} — ${BRAND_NAME} Launches Lender Intelligence Platform`,
    'Mortgage Solutions': `${title}: Specialist Lending Market Gets Purpose-Built Intelligence Platform`,
    'Mortgage Introducer': `New Platform Helps Intermediaries Access Lender Intelligence — ${title}`,
    'BDLA (formerly ASTL)': `${title} — ${BRAND_NAME} Brings Transparency to Bridging & Development Lending`,
  };

  const headline = headlineVariants[publication] || `${title} — ${BRAND_NAME}`;

  const quoteVariants: Record<string, string> = {
    'The Intermediary': `"Intermediaries are the backbone of the UK lending market, yet they've been making placement decisions with incomplete information. ${BRAND_NAME} changes that by giving brokers the same data-driven visibility that institutional investors have had for years."`,
    'Property Week': `"The UK CRE lending market has operated with remarkable opacity. Borrowers and advisers have no systematic way to compare lender appetite, pricing, or track record. We built ${BRAND_NAME} to fix that — with deal-level data, not directory listings."`,
    'Bridging & Commercial': `"Specialist lenders complete thousands of deals annually, but there's been no way for the market to see patterns across them — who's active in which sectors, what terms they're offering, where appetite is growing. ${BRAND_NAME} makes that visible for the first time."`,
    'Development Finance Today': `"Development finance is inherently complex — multiple tranches, staged drawdowns, varied risk profiles. Lenders need to see how their peers are pricing similar schemes before they can compete effectively. That's what ${BRAND_NAME} delivers."`,
    'NACFB': `"We built ${BRAND_NAME} to serve the professional intermediary market. When a broker needs to place a deal quickly and accurately, they need to know which lenders are genuinely active in that space — not just which ones have a page on a website."`,
    'The Drawdown': `"For lending funds, operational efficiency in origination is everything. ${BRAND_NAME} gives fund managers real-time market intelligence on competitor positioning, borrower quality, and deal flow — the same analytical infrastructure that equity funds have had for years."`,
    'Green Street': `"We're bringing institutional-grade analytics to a market segment that has been historically underserved by data providers. UK CRE lending decisions should be driven by evidence, not relationships and guesswork."`,
    'Financial Reporter': `"The specialist lending market has grown significantly, but the intelligence infrastructure hasn't kept pace. ${BRAND_NAME} bridges that gap with real-time lender analytics, sponsor screening, and market intelligence purpose-built for UK CRE."`,
    'Mortgage Solutions': `"The specialist lending space is evolving rapidly and intermediaries need tools that reflect that. ${BRAND_NAME} provides the market intelligence layer that enables faster, better-informed lending decisions across bridging, development, and commercial finance."`,
    'Mortgage Introducer': `"Intermediaries tell us the same thing: they want to place deals faster and with more confidence. ${BRAND_NAME} gives them visibility into which lenders are actively deploying in their client's sector, at what terms, and how quickly."`,
    'BDLA (formerly ASTL)': `"Transparency is good for the entire short-term lending ecosystem. When lenders can see market benchmarks and borrowers can compare genuine appetite, the result is more efficient capital allocation and better outcomes for everyone."`,
  };

  const quote = quoteVariants[publication] || `"${BRAND_NAME} brings institutional-grade lending intelligence to the UK CRE market. ${title} represents a significant step forward in market transparency."`;

  // Build body with publication-specific angle
  const body = `${announcement}

The platform, which launched in April 2026, addresses a long-standing transparency gap in UK commercial real estate lending. ${angle.focus.charAt(0).toUpperCase() + angle.focus.slice(1)}.

${quote.replace(/^"|"$/g, '')}

-- ${headline.includes('Marcus') ? '' : `Marcus Emadi, CEO of ${BRAND_NAME}, said: `}${quote}

For more information, visit www.${BRAND_DOMAIN} or contact ${BRAND_EMAIL}.`;

  return { headline, subheadline: `Platform delivers real-time lender analytics and sponsor screening for UK CRE market`, body, quote };
}

// ── 10. POST /api/press-releases/:id/send — Send a press release via email ───

router.post('/:id/send', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const prResult = await query(
      `SELECT pr.*, pc.email as contact_email, pc.contact_name, pc.publication
       FROM press_releases pr
       LEFT JOIN press_contacts pc ON pc.id = pr.press_contact_id
       WHERE pr.id = $1 AND pr.tenant = '${TENANT}'`,
      [id]
    );

    if (!prResult.rows[0]) {
      res.status(404).json({ error: 'Press release not found' });
      return;
    }

    const pr = prResult.rows[0] as any;

    if (pr.status === 'sent') {
      res.status(400).json({ error: 'Press release has already been sent' });
      return;
    }

    if (!pr.contact_email) {
      res.status(400).json({ error: 'No press contact email linked to this release' });
      return;
    }

    // Get sending account — always send press releases and follow-ups from Marcus
    const accountRes = await query(
      `SELECT * FROM email_accounts WHERE is_active = true AND tenant = '${TENANT}' AND email = 'marcus@tp.finance' LIMIT 1`
    );

    if (!accountRes.rows[0]) {
      res.status(400).json({ error: 'marcus@tp.finance is not connected/active for sending' });
      return;
    }

    const account = accountRes.rows[0] as { id: string; email: string };
    const trackingId = crypto.randomUUID();

    const emailHtml = buildPressReleaseEmail(pr);

    // Press releases get a "Press Release:" subject; warm follow-ups (no headline) use their own subject
    const subject = pr.headline ? `Press Release: ${pr.headline}` : (pr.subheadline || 'Following up on our press release');

    const sendRes = await query<{ id: string }>(
      `INSERT INTO email_sends (to_email, from_email, subject, body_html, tracking_id, email_account_id, status, tenant)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', '${TENANT}') RETURNING id`,
      [pr.contact_email, account.email, subject, emailHtml, trackingId, account.id]
    );

    await sendQueue.add({ emailSendId: sendRes.rows[0].id });

    await query(
      `UPDATE press_releases SET status = 'sent', sent_at = NOW(), email_send_id = $1, updated_at = NOW() WHERE id = $2`,
      [sendRes.rows[0].id, id]
    );

    console.log(`[PressReleases] Sent press release ${id} to ${pr.contact_email} (${pr.publication})`);
    res.json({ success: true, sent_to: pr.contact_email, publication: pr.publication });
  } catch (err) {
    console.error('[PressReleases] Error sending press release:', err);
    res.status(500).json({ error: 'Failed to send press release' });
  }
});

// ── 11. POST /api/press-releases/send-all — Send all drafts for an announcement ─

router.post('/send-all', async (req: Request, res: Response) => {
  try {
    const { announcement_title } = req.body;

    if (!announcement_title) {
      res.status(400).json({ error: 'announcement_title is required' });
      return;
    }

    const drafts = await query(
      `SELECT pr.id, pr.headline, pc.email as contact_email, pc.publication
       FROM press_releases pr
       LEFT JOIN press_contacts pc ON pc.id = pr.press_contact_id
       WHERE pr.announcement_title = $1 AND pr.tenant = '${TENANT}' AND pr.status = 'draft'`,
      [announcement_title]
    );

    if (drafts.rows.length === 0) {
      res.status(400).json({ error: 'No unsent press releases found for this announcement' });
      return;
    }

    const accountRes = await query(
      `SELECT * FROM email_accounts WHERE is_active = true AND tenant = '${TENANT}' AND email = 'marcus@tp.finance' LIMIT 1`
    );

    if (!accountRes.rows[0]) {
      res.status(400).json({ error: 'marcus@tp.finance is not connected/active for sending' });
      return;
    }

    const account = accountRes.rows[0] as { id: string; email: string };
    let sent = 0;

    for (const row of drafts.rows) {
      const draft = row as any;
      if (!draft.contact_email) continue;

      const fullPr = await query(
        `SELECT pr.*, pc.email as contact_email, pc.contact_name, pc.publication
         FROM press_releases pr
         LEFT JOIN press_contacts pc ON pc.id = pr.press_contact_id
         WHERE pr.id = $1`,
        [draft.id]
      );
      if (!fullPr.rows[0]) continue;

      const pr = fullPr.rows[0] as any;
      const trackingId = crypto.randomUUID();
      const emailHtml = buildPressReleaseEmail(pr);
      const subject = pr.headline ? `Press Release: ${pr.headline}` : (pr.subheadline || 'Following up on our press release');

      const sendRes = await query<{ id: string }>(
        `INSERT INTO email_sends (to_email, from_email, subject, body_html, tracking_id, email_account_id, status, tenant)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', '${TENANT}') RETURNING id`,
        [pr.contact_email, account.email, subject, emailHtml, trackingId, account.id]
      );

      await sendQueue.add({ emailSendId: sendRes.rows[0].id });

      await query(
        `UPDATE press_releases SET status = 'sent', sent_at = NOW(), email_send_id = $1, updated_at = NOW() WHERE id = $2`,
        [sendRes.rows[0].id, draft.id]
      );

      sent++;
    }

    console.log(`[PressReleases] Sent ${sent} press releases for: ${announcement_title}`);
    res.json({ success: true, sent_count: sent });
  } catch (err) {
    console.error('[PressReleases] Error sending all press releases:', err);
    res.status(500).json({ error: 'Failed to send press releases' });
  }
});

export function buildPressReleaseEmail(pr: any): string {
  const body = pr.body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');

  // Warm follow-up / personal note: no headline means render a plain personal
  // email (greeting + body + signature already in the body), no press-release chrome.
  if (!pr.headline) {
    return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.7;max-width:580px;"><p>${body}</p></div>`;
  }

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.7;max-width:580px;">
<p style="font-size:11px;text-transform:uppercase;letter-spacing:2px;font-weight:bold;">For Immediate Release</p>
<p><strong style="font-size:18px;">${pr.headline}</strong></p>
${pr.subheadline ? `<p style="color:#555;font-style:italic;">${pr.subheadline}</p>` : ''}
<p>${pr.dateline ? `<strong>${pr.dateline}</strong> — ` : ''}${body}</p>
${pr.spokesperson_quote ? `<p style="border-left:3px solid #1993C5;padding-left:16px;font-style:italic;">${pr.spokesperson_quote}<br><span style="font-style:normal;font-size:13px;color:#555;">— <strong>${pr.spokesperson_name || 'Marcus Emadi'}</strong>, ${pr.spokesperson_title || `CEO, ${BRAND_NAME}`}</span></p>` : ''}
<p style="text-align:center;color:#999;font-size:12px;">— ENDS —</p>
<p style="font-size:12px;color:#666;"><strong>About ${BRAND_NAME}:</strong> ${pr.boilerplate || `Specialist advisory firm focused on UK commercial real estate finance.`}</p>
<p style="font-size:12px;color:#666;"><strong>Media contact:</strong> Marcus Emadi, CEO, ${BRAND_NAME}<br><a href="mailto:${BRAND_EMAIL}" style="color:#1993C5;">${BRAND_EMAIL}</a> | <a href="https://www.${BRAND_DOMAIN}" style="color:#1993C5;">www.${BRAND_DOMAIN}</a></p>
</div>`;
}

export default router;
