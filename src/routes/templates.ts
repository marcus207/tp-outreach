import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query, TENANT, BRAND_NAME } from '../db/connection';
import { templateEngine } from '../services/template-engine';
import { Template, Contact } from '../types';
import { uuidParam, isUuid } from '../middleware/security';
import {
  buildEmailHtml, buildLinkedInPosterHtml, EmailContent,
  IMAGE_URLS, heroDataUri, TP_BASE as LI_BASE, THEMES,
} from '../services/draft-review';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000 });

const router = Router();

router.param('id', uuidParam);

// GET /api/templates — list all, joined with sequence step info
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT t.*,
              ss.step_number,
              ss.delay_days,
              s.id   AS sequence_id,
              s.name AS sequence_name
       FROM templates t
       LEFT JOIN sequence_steps ss ON ss.template_id = t.id
       LEFT JOIN sequences s       ON s.id = ss.sequence_id
                                   AND s.tenant = $1
       WHERE t.tenant = $1
       ORDER BY s.name ASC NULLS LAST, ss.step_number ASC NULLS LAST, t.position ASC NULLS LAST, t.created_at ASC`,
      [TENANT]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Templates] Error listing templates:', err);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

// PUT /api/templates/reorder — drag-and-drop reorder
// Body: { ids: string[], sequence_id?: string }
router.put('/reorder', async (req: Request, res: Response) => {
  try {
    const { ids, sequence_id } = req.body as { ids: string[]; sequence_id?: string };
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every(isUuid)) {
      res.status(400).json({ error: 'ids array of template ids required' });
      return;
    }
    if (sequence_id !== undefined && sequence_id !== null && !isUuid(sequence_id)) {
      res.status(400).json({ error: 'Invalid sequence_id' });
      return;
    }

    let sequenceId = sequence_id;
    if (!sequenceId) {
      const seqResult = await query<{ id: string }>(
        `SELECT id FROM sequences WHERE tenant = $1 ORDER BY created_at ASC LIMIT 1`,
        [TENANT]
      );
      sequenceId = seqResult.rows[0]?.id;
    }

    for (let i = 0; i < ids.length; i++) {
      await query(
        `UPDATE templates SET position = $1, updated_at = NOW() WHERE id = $2 AND tenant = $3`,
        [i + 1, ids[i], TENANT]
      );
      if (sequenceId) {
        await query(
          `UPDATE sequence_steps SET step_number = $1, updated_at = NOW()
           WHERE sequence_id = $3 AND template_id = $2`,
          [i + 1, ids[i], sequenceId]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Templates] Error reordering templates:', err);
    res.status(500).json({ error: 'Failed to reorder templates' });
  }
});

// POST /api/templates — create
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, subject, body_html, body_text } = req.body;

    if (!name || !subject || !body_html) {
      res.status(400).json({ error: 'name, subject, and body_html are required' });
      return;
    }

    // Auto-detect merge fields from subject + body
    const mergeFields = templateEngine.extractMergeFields(subject + ' ' + body_html);

    const result = await query(
      `INSERT INTO templates (name, subject, body_html, body_text, merge_fields, tenant)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, subject, body_html, body_text || null, mergeFields, TENANT]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Templates] Error creating template:', err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// ── Article Generator (must be before /:id to avoid route conflict) ────────────

// Image key → human-readable labels
const IMAGE_LABELS: Record<string, string> = {
  city_london:        'London Skyline',
  financial_district: 'Skyscrapers',
  london_skyline:     'Glass Office',
  london_office:      'City at Dusk',
  office_interior:    'Night City',
  business_meeting:   'Office Corridor',
  intro_week1:        'Office Building',
  intro_week2:        'Commercial',
  intro_week3:        'Glass Curtain',
  intro_week4:        'Retail Street',
};

const VALID_URLS = [
  `${LI_BASE}/platform-overview`,
  `${LI_BASE}/how-it-works`,
  `${LI_BASE}/features/borrower-intelligence`,
  `${LI_BASE}/features/risk-monitoring`,
  `${LI_BASE}/features/portfolio-analytics`,
  `${LI_BASE}/features/bank-grade-security`,
  `${LI_BASE}/about`,
  `${LI_BASE}/get-started`,
  `${LI_BASE}/resources/faq`,
  `${LI_BASE}/resources/blog`,
];


// GET /api/templates/:id — get single
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`SELECT * FROM templates WHERE id = $1 AND tenant = $2`, [id, TENANT]);

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Templates] Error getting template:', err);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

// PUT /api/templates/:id — update
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, subject, body_html, body_text, is_active, linkedin_content, linkedin_poster_html } = req.body;

    // Recalculate merge fields if content changed
    let mergeFields: string[] | undefined;
    if (subject || body_html) {
      const existingResult = await query<Template>(`SELECT * FROM templates WHERE id = $1 AND tenant = $2`, [id, TENANT]);
      if (existingResult.rows[0]) {
        const existing = existingResult.rows[0];
        const newSubject = subject || existing.subject;
        const newBody = body_html || existing.body_html;
        mergeFields = templateEngine.extractMergeFields(newSubject + ' ' + newBody);
      }
    }

    const result = await query(
      `UPDATE templates SET
        name = COALESCE($1, name),
        subject = COALESCE($2, subject),
        body_html = COALESCE($3, body_html),
        body_text = COALESCE($4, body_text),
        merge_fields = COALESCE($5, merge_fields),
        is_active = COALESCE($6, is_active),
        linkedin_content = COALESCE($7, linkedin_content),
        linkedin_poster_html = COALESCE($8, linkedin_poster_html),
        updated_at = NOW()
      WHERE id = $9 AND tenant = $10
      RETURNING *`,
      [name, subject, body_html, body_text, mergeFields, is_active, linkedin_content, linkedin_poster_html, id, TENANT]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Templates] Error updating template:', err);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/templates/:id — delete
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`DELETE FROM templates WHERE id = $1 AND tenant = $2 RETURNING id`, [id, TENANT]);

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Templates] Error deleting template:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// POST /api/templates/:id/ai-edit — rewrite template using an AI prompt
router.post('/:id/ai-edit', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { prompt } = req.body;

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const templateResult = await query<Template>(`SELECT * FROM templates WHERE id = $1 AND tenant = $2`, [id, TENANT]);
    if (!templateResult.rows[0]) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const template = templateResult.rows[0];

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `You are editing an HTML email template for ${BRAND_NAME}, a commercial property lending intelligence platform. The template is a styled email.

Here is the current HTML template:

<current_html>
${template.body_html}
</current_html>

Apply the following change to the template:

<change_request>
${prompt}
</change_request>

Rules:
- Return ONLY the complete, updated HTML — no explanation, no markdown code fences, no preamble.
- Preserve all inline styles and the overall table-based email structure.
- Keep merge fields like {{first_name}} intact.
- Do not change any part of the template not mentioned in the change request.`,
        },
      ],
    });

    const updatedHtml = (message.content[0] as { type: string; text: string }).text.trim();

    res.json({ body_html: updatedHtml });
  } catch (err) {
    console.error('[Templates] Error in AI edit:', err);
    res.status(500).json({ error: 'AI edit failed' });
  }
});

// POST /api/templates/:id/preview — render with sample or contact data
router.post('/:id/preview', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { contact_id } = req.body || {};
    if (contact_id !== undefined && contact_id !== null && contact_id !== '' && !isUuid(contact_id)) {
      res.status(400).json({ error: 'Invalid contact_id' });
      return;
    }

    const templateResult = await query<Template>(`SELECT * FROM templates WHERE id = $1 AND tenant = $2`, [id, TENANT]);
    if (!templateResult.rows[0]) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const template = templateResult.rows[0];

    let contact: Contact | undefined;
    if (contact_id) {
      const contactResult = await query<Contact>(`SELECT * FROM contacts WHERE id = $1 AND tenant = $2`, [contact_id, TENANT]);
      contact = contactResult.rows[0];
    }

    const preview = templateEngine.previewTemplate(template, contact);
    res.json(preview);
  } catch (err) {
    console.error('[Templates] Error previewing template:', err);
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

export default router;
