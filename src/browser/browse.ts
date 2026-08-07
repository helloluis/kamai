/**
 * Core browse function — navigate, execute actions, extract content.
 * Supports optional sessionId to reuse a persistent browser context
 * (preserves cookies, auth state, localStorage between requests).
 */
import { createContext } from './engine.js';
import { executeActions, type BrowseAction } from './actions.js';
import { extractPage, type ExtractedPage } from './extract.js';
import type { BrowserContext } from 'playwright';
import { checkUrl, normalizeUrl } from './urlGuard.js';

const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT ?? '15000', 10);

export interface BrowseResult extends ExtractedPage {
  ok: true;
  url: string;
  actions_performed?: string[];
  sessionId?: string;
}

export interface BrowseError {
  ok: false;
  error: string;
}

export interface BrowseOptions {
  actions?: BrowseAction[];
  selector?: string | null;
  timeout?: number;
  /** If provided, reuse this browser context (session mode). Context will NOT be closed. */
  sessionContext?: BrowserContext;
  sessionId?: string;
}

export async function browse(
  url: string,
  actionsOrOpts: BrowseAction[] | BrowseOptions = [],
  selector?: string | null,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<BrowseResult | BrowseError> {
  // Support both old signature (actions, selector, timeout) and new options object
  let actions: BrowseAction[];
  let sessionContext: BrowserContext | undefined;
  let sessionId: string | undefined;

  if (Array.isArray(actionsOrOpts)) {
    actions = actionsOrOpts;
  } else {
    actions = actionsOrOpts.actions || [];
    selector = actionsOrOpts.selector ?? selector;
    timeout = actionsOrOpts.timeout ?? timeout;
    sessionContext = actionsOrOpts.sessionContext;
    sessionId = actionsOrOpts.sessionId;
  }

  const blocked = checkUrl(url);
  if (blocked) {
    return { ok: false, error: blocked };
  }
  url = normalizeUrl(url);

  // Use session context if provided, otherwise create a disposable one
  const isSession = !!sessionContext;
  const context = sessionContext || await createContext();

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Auto-accept JavaScript dialogs (alert, confirm, prompt)
    // OutSystems and similar frameworks use confirm() for form submissions
    const dialogLog: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogLog.push(`${dialog.type()}: "${dialog.message()}" → accepted`);
      await dialog.accept();
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

      // Re-check where we actually landed. The input-URL check says nothing
      // about a 302 chain, and 169.254.169.254 (cloud metadata) was not in the
      // old blocklist at all.
      const landedBlocked = checkUrl(page.url());
      if (landedBlocked) {
        return { ok: false, error: `Blocked after redirect: ${landedBlocked}` };
      }

      let actionLog: string[] = [];
      if (actions.length > 0) {
        actionLog = await executeActions(page, actions);
      }
      if (dialogLog.length > 0) {
        actionLog.push(...dialogLog);
      }

      const extracted = await extractPage(page, selector);

      return {
        ok: true,
        url: page.url(),
        ...extracted,
        actions_performed: actionLog.length > 0 ? actionLog : undefined,
        sessionId,
      };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // Only close context if it's NOT a session (sessions persist)
    if (!isSession) {
      await context.close().catch(() => {});
    }
  }
}