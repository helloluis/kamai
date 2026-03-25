/**
 * Browser engine — manages a persistent Chromium instance via Playwright.
 */
import { chromium, Browser, BrowserContext, Page } from 'playwright';

let browser: Browser | null = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
];

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  console.log('[Browser] Launching Chromium...');
  browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  console.log('[Browser] Chromium ready');
  return browser;
}

export async function createContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });
}

export async function shutdown(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}