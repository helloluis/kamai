/**
 * Strategy router — checks domain memories for strategy overrides
 * and routes to specialized handlers before falling back to Playwright.
 */
import { browseYouTube } from './youtube.js';
import { browseGitHub } from './github.js';

export type StrategyHandler = (url: string) => Promise<any>;

/** Map of strategy names to their handler functions. */
const STRATEGY_HANDLERS: Record<string, StrategyHandler> = {
  'yt-dlp': browseYouTube,
  'github-api': browseGitHub,
};

/** Known domain-to-strategy mappings (hardcoded defaults). */
const DEFAULT_STRATEGIES: Record<string, string> = {
  'youtube.com': 'yt-dlp',
  'youtu.be': 'yt-dlp',
  'm.youtube.com': 'yt-dlp',
  'github.com': 'github-api',
};

/**
 * Try to resolve a strategy for a URL.
 * Priority: DB memory strategy > hardcoded defaults > null (use Playwright).
 */
export function resolveStrategy(url: string, dbStrategy: string | null): StrategyHandler | null {
  // DB override takes priority
  if (dbStrategy && STRATEGY_HANDLERS[dbStrategy]) {
    return STRATEGY_HANDLERS[dbStrategy];
  }

  // Check hardcoded defaults
  try {
    const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
    const defaultStrategy = DEFAULT_STRATEGIES[hostname];
    if (defaultStrategy && STRATEGY_HANDLERS[defaultStrategy]) {
      return STRATEGY_HANDLERS[defaultStrategy];
    }
  } catch {
    // Invalid URL — fall through to Playwright
  }

  return null;
}

/** List available strategy names. */
export function listStrategies(): string[] {
  return Object.keys(STRATEGY_HANDLERS);
}