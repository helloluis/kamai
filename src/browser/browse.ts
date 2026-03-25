/**
 * Core browse function — navigate, execute actions, extract content.
 */
import { createContext } from './engine.js';
import { executeActions, type BrowseAction } from './actions.js';
import { extractPage, type ExtractedPage } from './extract.js';

const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT ?? '15000', 10);

const BLOCKED_PATTERNS = [
  /^file:/i,
  /^data:/i,
  /^(https?:\/\/)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|localhost|0\.0\.0\.0)/i,
];

export interface BrowseResult extends ExtractedPage {
  ok: true;
  url: string;
  actions_performed?: string[];
}

export interface BrowseError {
  ok: false;
  error: string;
}

export async function browse(
  url: string,
  actions: BrowseAction[] = [],
  selector?: string | null,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<BrowseResult | BrowseError> {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(url)) {
      return { ok: false, error: `Blocked URL pattern: ${url}` };
    }
  }

  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  const context = await createContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

      let actionLog: string[] = [];
      if (actions.length > 0) {
        actionLog = await executeActions(page, actions);
      }

      const extracted = await extractPage(page, selector);

      return {
        ok: true,
        url: page.url(),
        ...extracted,
        actions_performed: actionLog.length > 0 ? actionLog : undefined,
      };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}