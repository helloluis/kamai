/**
 * POST /api/v1/browse — browse a URL with optional actions.
 */
import { Router } from 'express';
import { browse } from '../../browser/index.js';
import { getMemoriesForDomain } from './memories.js';

const router = Router();

router.post('/', async (req, res) => {
  const { url, actions, selector, timeout } = req.body;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing "url" field' });
    return;
  }

  const callerIp = (req.headers['x-forwarded-for'] as string) || req.ip;
  const ts = new Date().toISOString();
  const startMs = Date.now();
  const actionSummary = actions?.length ? ` | ${actions.length} actions` : '';

  console.log(`[Browse] ${ts} | ${callerIp} | REQ ${url}${actionSummary}${selector ? ` (${selector})` : ''}`);

  try {
    const result = await browse(url, actions || [], selector || null, timeout || undefined);
    const elapsed = Date.now() - startMs;

    if (result.ok) {
      console.log(`[Browse] ${ts} | ${callerIp} | OK  ${url} | ${result.length} chars | ${elapsed}ms`);
    } else {
      console.log(`[Browse] ${ts} | ${callerIp} | FAIL ${url} | ${result.error} | ${elapsed}ms`);
    }

    // Attach domain memories if available
    if (result.ok) {
      const memories = getMemoriesForDomain(url);
      if (memories.length > 0) {
        (result as any).memories = memories;
      }
    }

    res.json(result);
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[Browse] ${ts} | ${callerIp} | ERR ${url} | ${err.message} | ${elapsed}ms`);
    res.status(500).json({ ok: false, error: err.message || 'Browse failed' });
  }
});

export default router;
