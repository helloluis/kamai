/**
 * Screenshot capture engine.
 *
 * Three things here are load-bearing and were measured, not assumed:
 *
 * 1. `fullPage: true` IS NOT USED ANYWHERE. On a real complex page
 *    (en.wikipedia.org/wiki/Manila — 68,980px, 17,341 nodes) it resolved after
 *    51,056ms with EXACTLY 0 bytes: no throw, no error, a silently empty
 *    buffer. `clip` combined with fullPage pays the same cost, and
 *    locator.screenshot() on a very tall element fails identically. The safe
 *    primitive is setViewportSize -> scrollTo -> plain viewport screenshot,
 *    which captured the same region in ~310ms (~150x faster). On a box shared
 *    with 13 other apps an unbounded fullPage is a 51-CPU-second self-DoS.
 *
 * 2. Every buffer is validated for length AND magic bytes before it can be
 *    stored or billed, because of (1) — a zero-byte "success" must never reach
 *    a caller as a valid capture.
 *
 * 3. Overlay removal is GEOMETRIC, not selector-based. A ~25-line pass that
 *    hides fixed/sticky elements covering >=30% of the viewport ran in 8-22ms
 *    and cut consent-wall coverage from 100% to 0-21% on 6/6 EU sites, versus
 *    @duckduckgo/autoconsent at 850-9,916ms clearing only 2/5. The existing
 *    dismissOverlays() in actions.ts is deliberately NOT reused: it has a
 *    module-global one-shot flag that races across concurrent requests, and its
 *    `offsetParent !== null` visibility test returns null for position:fixed
 *    elements — i.e. it silently skips the fixed consent banners it targets.
 */
import type { Page, BrowserContext } from 'playwright';
import { createContext } from './engine.js';
import { resolveEmbed, type EmbedSpec } from './embeds.js';
import { checkUrl, normalizeUrl } from './urlGuard.js';

export type ShotMode = 'auto' | 'relevant' | 'viewport' | 'full' | 'element';

export interface ShotOptions {
  mode: ShotMode;
  selector?: string;
  format: 'jpeg' | 'png';
  quality: number;
  width: number;
  /** Hard ceiling on captured height in CSS px — the fullPage guard. */
  maxHeight: number;
  timeout: number;
  deviceScaleFactor: number;
}

export interface ShotResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  /** Which route produced this: embed:<platform>, page:<region>, element. */
  strategy: string;
  pageUrl: string;
  title?: string;
  /** True when the page was taller than maxHeight and the capture was cut. */
  truncated?: boolean;
}

export const SHOT_DEFAULTS: ShotOptions = {
  mode: 'auto',
  format: 'jpeg',
  quality: 82,
  width: 1280,
  maxHeight: 4000,
  timeout: 30_000,
  deviceScaleFactor: 2,
};

// ─── In-page scripts ───

/**
 * Registered before navigation. Chromium computes LCP natively during load, so
 * this is free — but the element is ONLY reachable through a PerformanceObserver
 * with buffered:true. performance.getEntriesByType('largest-contentful-paint')
 * returned null on 3/3 real sites; with this observer it returned the correct
 * hero element on 3/3 (BBC lead photo, Wikipedia lede, Guardian splash).
 */
const LCP_INIT = `
  try {
    window.__kamaiLCP = null;
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last && last.element) window.__kamaiLCP = last.element;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* observer unsupported — region resolution falls back */ }
`;

/** Geometric overlay nuke. Returns how many elements it removed. */
function nukeOverlays(page: Page): Promise<number> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const viewportArea = Math.max(vw * vh, 1);
    let removed = 0;

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      let cs: CSSStyleDeclaration;
      try { cs = getComputedStyle(el); } catch { continue; }
      const fixed = cs.position === 'fixed' || cs.position === 'sticky';
      const modal = el.getAttribute('aria-modal') === 'true' || el.getAttribute('role') === 'dialog';
      if (!fixed && !modal) continue;

      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const covered =
        Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
        Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));

      if (covered / viewportArea >= 0.3 || (modal && fixed)) {
        el.style.setProperty('display', 'none', 'important');
        removed++;
      } else if (fixed && r.top <= 2) {
        // Sticky header pinned to the top would repeat over the captured
        // region — unpin rather than hide, so layout stays intact.
        el.style.setProperty('position', 'absolute', 'important');
      }
    }

    // Consent walls commonly lock scrolling on <html>/<body>; undo that or the
    // scroll-to-region step silently no-ops.
    for (const el of [document.documentElement, document.body]) {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('position', 'static', 'important');
      el.style.setProperty('filter', 'none', 'important');
    }
    return removed;
  }).catch(() => 0);
}

/** Nudge lazy-loaded images into loading, then return to the top. */
async function primeLazyContent(page: Page, maxHeight: number): Promise<void> {
  await page.evaluate(async (cap: number) => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
    const limit = Math.min(document.body.scrollHeight, cap * 2);
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 120));
  }, maxHeight).catch(() => {});
}

interface Region { x: number; y: number; width: number; height: number; how: string }

/**
 * Pick the region worth capturing, tag it, and report its document-space rect.
 * Order: caller selector -> LCP (expanded to its semantic container) -> main
 * landmark -> viewport.
 */
function resolveRegion(page: Page, selector?: string): Promise<Region | null> {
  return page.evaluate((sel: string | undefined) => {
    const MARK = 'data-kamai-shot';
    document.querySelectorAll(`[${MARK}]`).forEach((e) => e.removeAttribute(MARK));

    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      };
    };
    const usable = (el: Element | null): el is Element => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 80 && r.height >= 60;
    };

    const take = (el: Element, how: string): Region => {
      el.setAttribute(MARK, '1');
      return { ...rectOf(el), how };
    };

    if (sel) {
      const el = document.querySelector(sel);
      if (usable(el)) return take(el, 'selector');
      return null; // caller asked for something specific; do not silently substitute
    }

    // LCP element, widened to the semantic block that contains it — the hero
    // image alone is rarely the whole story (headline + byline live above it).
    const lcp = (window as any).__kamaiLCP as Element | undefined;
    if (usable(lcp ?? null)) {
      const container = lcp!.closest('article, main, [role=main], section, .post, .entry');
      if (usable(container)) {
        const cr = container!.getBoundingClientRect();
        // Only prefer the container when it is not wildly larger than the hero.
        if (cr.height <= Math.max(lcp!.getBoundingClientRect().height * 6, 1200)) {
          return take(container!, 'lcp-container');
        }
      }
      return take(lcp!, 'lcp');
    }

    for (const s of ['main', '[role=main]', 'article', '#content', '.content']) {
      const el = document.querySelector(s);
      if (usable(el)) return take(el!, 'landmark');
    }
    return null;
  }, selector).catch(() => null);
}

// ─── Content validation ───

/**
 * Platform error pages that render as perfectly valid images.
 *
 * Observed live: Bluesky's embed answers a handle-form URL with "Invalid DID:
 * DID syntax didn't validate via regex", and TikTok's answers a rate-limited
 * request with "overload-protect triggered". Both produced well-formed ~20KB
 * JPEGs that passed magic-byte validation. For an endpoint whose whole purpose
 * is evidence that a post existed, returning a blank error card as a
 * successful capture is worse than returning nothing.
 */
const EMBED_ERROR_PATTERNS = [
  /invalid did/i,
  /overload-protect/i,
  /rate.?limit/i,
  /too many requests/i,
  /sorry, this page isn/i,
  /content (is )?unavailable/i,
  /(post|page|tweet|video|photo) not found/i,
  /may have been deleted/i,
  /(this )?(post|tweet|video|content) (is |was )?(unavailable|deleted|removed)/i,
  /no longer available/i,
  /removed by/i,
  /log ?in to (continue|see)/i,
  /doesn'?t exist/i,
];

/**
 * Reject an embed that rendered an error or nothing at all.
 * Returns null when the render looks real, else the reason it does not.
 */
function checkEmbedContent(page: Page): Promise<string | null> {
  return page.evaluate((patterns: string[]) => {
    const text = (document.body?.innerText || '').trim();
    // A hydrated widget (X) is an iframe with no outer text, so media presence
    // has to count as content on its own.
    const media = document.querySelector('img[src]:not([src=""]), video, canvas, iframe');
    if (!media && text.length < 80) {
      return `embed rendered no content (${text.length} chars, no media): "${text.slice(0, 80)}"`;
    }
    for (const p of patterns) {
      if (new RegExp(p, 'i').test(text)) return `embed returned an error page: "${text.slice(0, 100)}"`;
    }
    return null;
  }, EMBED_ERROR_PATTERNS.map((r) => r.source)).catch(() => null);
}

// ─── Buffer validation ───

/** A PNG starts 89 50 4E 47; a JPEG starts FF D8 FF. */
function validImage(buf: Buffer, format: 'jpeg' | 'png'): boolean {
  if (!buf || buf.length < 128) return false;
  if (format === 'png') {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// ─── Core capture ───

/**
 * Resize the viewport to the region, scroll it to the top, and take a plain
 * viewport screenshot. This is the fast path — never fullPage.
 */
async function captureRegion(
  page: Page,
  region: Region | null,
  opts: ShotOptions,
): Promise<{ buffer: Buffer; width: number; height: number; truncated: boolean }> {
  const pageHeight = await page
    .evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))
    .catch(() => opts.maxHeight);

  const wanted = region ? region.height : pageHeight;
  const height = Math.max(200, Math.min(Math.ceil(wanted), opts.maxHeight));
  const truncated = Math.ceil(wanted) > opts.maxHeight;

  await page.setViewportSize({ width: opts.width, height });

  // Layout reflows after a resize, so re-find the tagged element rather than
  // trusting the rect measured at the old viewport size.
  if (region) {
    await page.evaluate(() => {
      const el = document.querySelector('[data-kamai-shot]');
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, Math.max(0, top - 8));
      }
    }).catch(() => {});
  } else {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }
  await page.waitForTimeout(250);

  const buffer = await page.screenshot({
    type: opts.format,
    ...(opts.format === 'jpeg' ? { quality: opts.quality } : {}),
    timeout: Math.min(opts.timeout, 20_000),
  });

  return { buffer: Buffer.from(buffer), width: opts.width, height, truncated };
}

/** Capture a rendered social embed. */
async function captureEmbed(spec: EmbedSpec, opts: ShotOptions): Promise<ShotResult> {
  const context = await createContext({
    viewport: spec.viewport,
    deviceScaleFactor: opts.deviceScaleFactor,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);
    try {
      if (spec.html) {
        await page.setContent(spec.html, { waitUntil: spec.waitUntil, timeout: opts.timeout });
      } else {
        await page.goto(spec.url!, { waitUntil: spec.waitUntil, timeout: opts.timeout });
      }

      // Give the platform's widget script a chance to hydrate the placeholder.
      // Capped at 8s: when the selector never appears it is almost always an
      // error page, and waiting the full timeout just adds latency to a failure.
      const sel = spec.selectors.join(', ');
      await page.waitForSelector(sel, { timeout: Math.min(opts.timeout, 8_000) }).catch(() => {});
      await page.waitForTimeout(spec.settleMs);

      const contentProblem = await checkEmbedContent(page);
      if (contentProblem) throw new Error(contentProblem);

      const el = await page.$(sel);
      if (el) {
        const box = await el.boundingBox();
        // Element screenshots are safe here only because embeds are small; a
        // tall element takes the same 51s zero-byte path as fullPage.
        if (box && box.height > 0 && box.height <= opts.maxHeight) {
          const buf = Buffer.from(
            await el.screenshot({
              type: opts.format,
              ...(opts.format === 'jpeg' ? { quality: opts.quality } : {}),
              timeout: 15_000,
            }),
          );
          if (validImage(buf, opts.format)) {
            return {
              buffer: buf,
              width: Math.round(box.width),
              height: Math.round(box.height),
              format: opts.format,
              strategy: `embed:${spec.platform}`,
              pageUrl: spec.url || page.url(),
              title: await page.title().catch(() => undefined),
            };
          }
        }
      }

      // Fall back to the embed page's own viewport.
      const shot = await captureRegion(page, null, { ...opts, width: spec.viewport.width });
      if (!validImage(shot.buffer, opts.format)) {
        throw new Error('embed produced an invalid or empty image');
      }
      return {
        buffer: shot.buffer,
        width: shot.width,
        height: shot.height,
        format: opts.format,
        strategy: `embed:${spec.platform}`,
        pageUrl: spec.url || page.url(),
        truncated: shot.truncated,
        title: await page.title().catch(() => undefined),
      };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/** Capture an ordinary web page. */
async function capturePage(url: string, opts: ShotOptions): Promise<ShotResult> {
  const context = await createContext({
    viewport: { width: opts.width, height: 900 },
    deviceScaleFactor: opts.deviceScaleFactor,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.addInitScript(LCP_INIT);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });

      // Re-check after redirects — the input URL passing the guard says nothing
      // about where a 302 chain actually landed.
      const landed = page.url();
      const bad = checkUrl(landed);
      if (bad) throw new Error(`Blocked after redirect: ${bad}`);

      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await nukeOverlays(page);

      if (opts.mode === 'full' || opts.mode === 'relevant' || opts.mode === 'auto') {
        await primeLazyContent(page, opts.maxHeight);
        await nukeOverlays(page); // lazy content can mount new sticky bars
      }

      const title = await page.title().catch(() => undefined);

      let region: Region | null = null;
      if (opts.mode === 'element') {
        region = await resolveRegion(page, opts.selector);
        if (!region) throw new Error(`Selector not found or too small: ${opts.selector}`);
      } else if (opts.mode === 'relevant' || opts.mode === 'auto') {
        region = await resolveRegion(page);
      }
      // 'viewport' and 'full' intentionally leave region null.

      const capOpts =
        opts.mode === 'viewport' ? { ...opts, maxHeight: Math.min(opts.maxHeight, 900) } : opts;
      const shot = await captureRegion(page, region, capOpts);

      if (!validImage(shot.buffer, opts.format)) {
        throw new Error('capture produced an invalid or empty image');
      }

      return {
        buffer: shot.buffer,
        width: shot.width,
        height: shot.height,
        format: opts.format,
        strategy: `page:${region?.how ?? opts.mode}`,
        pageUrl: landed,
        title,
        truncated: shot.truncated,
      };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Render self-authored HTML and capture it — used for the Reddit card, where
 * the post data comes from Apify but the pixels are ours.
 *
 * Remote subresources (a Reddit-hosted image) still load, so `waitUntil` is
 * 'networkidle' with a short cap rather than 'domcontentloaded'.
 */
export async function captureHtml(
  html: string,
  selector: string,
  partial: Partial<ShotOptions> = {},
): Promise<ShotResult> {
  const opts: ShotOptions = { ...SHOT_DEFAULTS, ...partial };
  const context = await createContext({
    viewport: { width: opts.width, height: 900 },
    deviceScaleFactor: opts.deviceScaleFactor,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(200);

      const el = await page.$(selector);
      if (!el) throw new Error(`Card selector not found: ${selector}`);
      const box = await el.boundingBox();
      if (!box || box.height <= 0) throw new Error('Card rendered with zero height');
      if (box.height > opts.maxHeight) {
        // Same guard as everywhere else — never hand a huge element to
        // element.screenshot(), which fails the 51s/0-byte way.
        await page.setViewportSize({ width: opts.width, height: opts.maxHeight });
      }

      const buf = Buffer.from(
        await el.screenshot({
          type: opts.format,
          ...(opts.format === 'jpeg' ? { quality: opts.quality } : {}),
          timeout: 15_000,
        }),
      );
      if (!validImage(buf, opts.format)) throw new Error('card capture produced an invalid image');

      return {
        buffer: buf,
        width: Math.round(box.width),
        height: Math.round(Math.min(box.height, opts.maxHeight)),
        format: opts.format,
        strategy: 'card',
        pageUrl: '',
      };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Capture a URL, choosing the route automatically.
 *
 * Social permalinks go through the platform's own embed (clean post, no login
 * wall); everything else renders directly. Reddit is handled upstream by the
 * caller, since it needs Apify.
 */
export async function screenshot(rawUrl: string, partial: Partial<ShotOptions> = {}): Promise<ShotResult> {
  const opts: ShotOptions = { ...SHOT_DEFAULTS, ...partial };
  const bad = checkUrl(rawUrl);
  if (bad) throw new Error(bad);
  const url = normalizeUrl(rawUrl);

  if (opts.mode === 'auto' || opts.mode === 'relevant') {
    const spec = await resolveEmbed(url);
    if (spec) {
      try {
        return await captureEmbed(spec, opts);
      } catch (err: any) {
        // Deliberately NO page-render fallback for social URLs. Rendering
        // instagram.com/p/... directly captures the login interstitial, which
        // passes every content check and looks like a successful capture while
        // proving nothing. Failing loudly is the honest outcome — the caller
        // can retry, or pass mode:"viewport" to force a raw render knowing
        // what they will get.
        throw new Error(`${spec.platform} embed capture failed: ${err.message}`);
      }
    }
  }
  return capturePage(url, opts);
}

export { captureEmbed, capturePage, validImage };
export type { BrowserContext };
