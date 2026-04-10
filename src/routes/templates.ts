import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/connection';
import { templateEngine } from '../services/template-engine';
import { Template, Contact } from '../types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const router = Router();

// GET /api/templates — list all
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM templates ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Templates] Error listing templates:', err);
    res.status(500).json({ error: 'Failed to list templates' });
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
      `INSERT INTO templates (name, subject, body_html, body_text, merge_fields)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, subject, body_html, body_text || null, mergeFields]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Templates] Error creating template:', err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// GET /api/templates/:id — get single
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(`SELECT * FROM templates WHERE id = $1`, [id]);

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
    const { name, subject, body_html, body_text, is_active } = req.body;

    // Recalculate merge fields if content changed
    let mergeFields: string[] | undefined;
    if (subject || body_html) {
      const existingResult = await query<Template>(`SELECT * FROM templates WHERE id = $1`, [id]);
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
        updated_at = NOW()
      WHERE id = $7
      RETURNING *`,
      [name, subject, body_html, body_text, mergeFields, is_active, id]
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
    const result = await query(`DELETE FROM templates WHERE id = $1 RETURNING id`, [id]);

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

    const templateResult = await query<Template>(`SELECT * FROM templates WHERE id = $1`, [id]);
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
          content: `You are editing an HTML email template for Turning Point Capital Advisory, a hospitality debt advisory firm. The template is a styled email poster.

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
- Available hero images (use full URLs): https://tp.finance/images/sectors/hospitality.jpg, https://tp.finance/images/sectors/hotel_london.jpg, https://tp.finance/images/sectors/uk_hotel.jpg, https://tp.finance/images/sectors/product_07_stabilisation_hotels.jpg, https://tp.finance/images/stock/london_hotel.jpg
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
    const { contact_id } = req.body;

    const templateResult = await query<Template>(`SELECT * FROM templates WHERE id = $1`, [id]);
    if (!templateResult.rows[0]) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const template = templateResult.rows[0];

    let contact: Contact | undefined;
    if (contact_id) {
      const contactResult = await query<Contact>(`SELECT * FROM contacts WHERE id = $1`, [contact_id]);
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
