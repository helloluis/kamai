/**
 * POST /api/v1/browse — browse a URL with optional actions.
 *
 * Smart routing: checks for domain-specific strategies (yt-dlp, github-api)
 * before falling back to Playwright. Strategies can be set via domain memories.
 *
 * Sessions: pass `sessionId` to reuse a persistent browser context that
 * preserves cookies, auth state, and localStorage between requests.
 */
import { Router } from 'express';
import { browse } from '../../browser/index.js';
import { getMemoriesForDomain, getStrategyForDomain } from './memories.js';
import { resolveStrategy } from '../../browser/strategies/index.js';
import { SessionManager } from '../../browser/session-manager.js';

const router = Router();
export const sessionManager = new SessionManager();

router.post('/', async (req, res) => {
  const { url, actions, selector, timeout, sessionId } = req.body;

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
    let result: any;

    // Check for strategy override — only if no actions requested
    // (strategies handle simple page loads; actions need Playwright)
    if (!actions?.length && !selector) {
      const dbStrategy = getStrategyForDomain(url);
      const handler = resolveStrategy(url, dbStrategy);

      if (handler) {
        const strategyName = dbStrategy || 'default';
        console.log(`[Browse] ${ts} | ${callerIp} | STRATEGY ${strategyName} for ${url}`);
        result = await handler(url);
      }
    }

    // Fall back to Playwright if no strategy matched or strategy failed
    if (!result || !result.ok) {
      if (result && !result.ok) {
        console.log(`[Browse] ${ts} | ${callerIp} | STRATEGY FAILED, falling back to Playwright: ${result.error}`);
      }

      // If sessionId provided, reuse persistent browser context
      let sessionContext;
      if (sessionId) {
        const session = sessionManager.get(sessionId);
        if (session) {
          sessionContext = session.context;
          console.log(`[Browse] ${ts} | ${callerIp} | SESSION ${sessionId}`);
        } else {
          console.log(`[Browse] ${ts} | ${callerIp} | SESSION ${sessionId} NOT FOUND, using fresh context`);
        }
      }

      result = await browse(url, {
        actions: actions || [],
        selector: selector || null,
        timeout: timeout || undefined,
        sessionContext,
        sessionId,
      });
    }

    const elapsed = Date.now() - startMs;

    if (result.ok) {
      const strategyTag = result.strategy_used ? ` [${result.strategy_used}]` : '';
      console.log(`[Browse] ${ts} | ${callerIp} | OK  ${url} | ${result.length} chars | ${elapsed}ms${strategyTag}`);
    } else {
      console.log(`[Browse] ${ts} | ${callerIp} | FAIL ${url} | ${result.error} | ${elapsed}ms`);
    }

    // Attach domain memories if available
    if (result.ok) {
      const memories = getMemoriesForDomain(url);
      if (memories.length > 0) {
        result.memories = memories;
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
