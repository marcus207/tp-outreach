import { Router, Request, Response } from 'express';
import { digestService } from '../services/digest';

const router = Router();

// List digests
router.get('/', async (_req: Request, res: Response) => {
  try {
    const digests = await digestService.list();
    res.json(digests);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get single digest
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const digest = await digestService.get(String(req.params.id));
    if (!digest) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Manually generate today's digest
router.post('/generate', async (_req: Request, res: Response) => {
  try {
    const digest = await digestService.generate();
    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Generate + send digest email
router.post('/generate-and-send', async (_req: Request, res: Response) => {
  try {
    const digest = await digestService.generate();
    await digestService.sendDigestEmail(digest.id);
    res.json({ success: true, digest_id: digest.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Resend digest email for existing digest
router.post('/:id/send-email', async (req: Request, res: Response) => {
  try {
    await digestService.sendDigestEmail(String(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Approve a digest (via platform — authenticated)
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const { token, contacts } = req.body;
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    const digest = await digestService.approve(String(req.params.id), String(token), contacts);
    digestService.executeApproved(digest.id).catch((err: Error) =>
      console.error('[Digest] Execute error:', err.message)
    );
    res.json({ success: true, digest });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Reject / cancel a digest
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    const { query } = await import('../db/connection');
    const digestResult = await query<{ approval_token: string; status: string }>(
      `SELECT approval_token, status FROM daily_digest WHERE id = $1`, [String(req.params.id)]
    );
    const d = digestResult.rows[0];
    if (!d) { res.status(404).json({ error: 'Not found' }); return; }
    if (d.approval_token !== String(token)) { res.status(403).json({ error: 'Invalid token' }); return; }
    if (d.status !== 'pending') { res.status(400).json({ error: `Already ${d.status}` }); return; }
    await query(`UPDATE daily_digest SET status = 'rejected' WHERE id = $1`, [String(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
