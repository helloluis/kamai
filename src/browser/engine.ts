/**
 * Browser engine — manages a persistent Chromium instance via Playwright.
 * Includes stealth measures to avoid headless browser detection.
 */
import { chromium, Browser, BrowserContext } from 'playwright';

let browser: Browser | null = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled', // hide automation flag
];

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  console.log('[Browser] Launching Chromium...');
  browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  console.log('[Browser] Chromium ready');
  return browser;
}

/** Stealth scripts injected before any page loads. */
const STEALTH_SCRIPTS = `
  // Override navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // Override chrome runtime to look like a real browser
  window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };

  // Override permissions query
  const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  }

  // Override plugins to look non-empty
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // Override languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
`;

export async function createContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'Asia/Manila',
  });

  // Inject stealth scripts before every page load
  await context.addInitScript(STEALTH_SCRIPTS);

  return context;
}

export async function shutdown(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}