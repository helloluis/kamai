/**
 * Session management routes — isolated browser contexts per user.
 *
 * POST   /api/v1/session             — create a new session
 * GET    /api/v1/session/:sessionId  — get session status
 * DELETE /api/v1/session/:sessionId  — destroy session
 */
import { Router } from 'express';
import { SessionManager } from '../../browser/session-manager.js';

const router = Router();
const sessions = new SessionManager();

router.post('/', async (req, res) => {
  try {
    const userId = (req.headers['x-api-key'] as string) || 'anonymous';
    const sessionId = await sessions.create(userId);
    res.status(201).json({ ok: true, sessionId });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Session not found' });
    return;
  }
  res.json({
    ok: true,
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivity: session.lastActivity.toISOString(),
  });
});

router.delete('/:sessionId', async (req, res) => {
  await sessions.destroy(req.params.sessionId);
  res.json({ ok: true, deleted: req.params.sessionId });
});

export default router;
