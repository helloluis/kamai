/**
 * POST /api/v1/browse — browse a URL with optional actions.
 *
 * Smart routing: checks for domain-specific strategies (yt-dlp, github-api)
 * before falling back to Playwright. Strategies can be set via domain memories.
 *
 * Auto-sessions: callers are automatically assigned a persistent browser
 * context based on their identity (x-wallet-address, x-api-key, or IP).
 * Cookies, auth state, and localStorage persist across requests from the
 * same caller. Sessions expire after 30 minutes of inactivity.
 *
 * Manual sessions: pass `sessionId` explicitly to use a specific session.
 */
import { Router } from 'express';
import { browse } from '../../browser/index.js';
import { getMemoriesForDomain, getStrategyForDomain } from './memories.js';
import { resolveStrategy } from '../../browser/strategies/index.js';
import { SessionManager } from '../../browser/session-manager.js';

const router = Router();
export const sessionManager = new SessionManager();

/**
 * Resolve the caller's identity for auto-session.
 * Priority: explicit sessionId > x-api-key > x-wallet-address > IP
 */
function resolveCallerId(req: any): string {
  return (
    (req.headers['x-api-key'] as string) ||
    (req.headers['x-wallet-address'] as string) ||
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.ip ||
    'anonymous'
  );
}

router.post('/', async (req, res) => {
  const { url, actions, selector, timeout, sessionId: explicitSessionId } = req.body;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing "url" field' });
    return;
  }

  const callerIp = (req.headers['x-forwarded-for'] as string) || req.ip;
  const callerId = resolveCallerId(req);
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

      // Resolve session: explicit sessionId > auto-session by caller identity
      let sessionContext;
      let activeSessionId: string | undefined;

      if (explicitSessionId) {
        // Explicit session
        const session = sessionManager.get(explicitSessionId);
        if (session) {
          sessionContext = session.context;
          activeSessionId = explicitSessionId;
          console.log(`[Browse] ${ts} | ${callerIp} | SESSION ${explicitSessionId}`);
        } else {
          console.log(`[Browse] ${ts} | ${callerIp} | SESSION ${explicitSessionId} NOT FOUND, creating new`);
        }
      }

      if (!sessionContext) {
        // Auto-session: find or create session for this caller
        let session = sessionManager.getByUserId(callerId);
        if (session) {
          sessionContext = session.context;
          activeSessionId = session.sessionId;
          console.log(`[Browse] ${ts} | ${callerIp} | AUTO-SESSION reuse ${activeSessionId} for ${callerId}`);
        } else {
          // Create new auto-session
          activeSessionId = await sessionManager.create(callerId);
          session = sessionManager.get(activeSessionId);
          if (session) {
            sessionContext = session.context;
            console.log(`[Browse] ${ts} | ${callerIp} | AUTO-SESSION new ${activeSessionId} for ${callerId}`);
          }
        }
      }

      result = await browse(url, {
        actions: actions || [],
        selector: selector || null,
        timeout: timeout || undefined,
        sessionContext,
        sessionId: activeSessionId,
      });
    }

    const elapsed = Date.now() - startMs;

    if (result.ok) {
      const strategyTag = result.strategy_used ? ` [${result.strategy_used}]` : '';
      console.log(`[Browse] ${ts} | ${callerIp} | OK  ${url} | ${result.length} chars | ${elapsed}ms${strategyTag}`);
    } else {
      console.log(`[Browse] ${ts} | ${callerIp} | FAIL ${url} | ${result.error} | ${elapsed}ms`);
    }

    // Attach domain memories on ALL responses (success or failure)
    // so the LLM always has tips for retrying
    const memories = getMemoriesForDomain(url);
    if (memories.length > 0) {
      result.memories = memories;
    }

    res.json(result);
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[Browse] ${ts} | ${callerIp} | ERR ${url} | ${err.message} | ${elapsed}ms`);
    // Include memories even in error responses
    const memories = getMemoriesForDomain(url);
    const errorResp: any = { ok: false, error: err.message || 'Browse failed' };
    if (memories.length > 0) errorResp.memories = memories;
    res.status(500).json(errorResp);
  }
});

export default router;
