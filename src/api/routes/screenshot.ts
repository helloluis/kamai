/**
 * POST /api/v1/screenshot — capture the relevant part of a URL as an image.
 * GET  /api/v1/screenshot/:id/image — public, unauthenticated retrieval.
 *
 * Tiered by URL, first match wins:
 *   1. Social permalink  -> render the platform's OWN embed (no login wall).
 *   2. Reddit            -> Apify post fetch + rendered capture card, because
 *                           every reddit.com surface 403s this server's IP.
 *   3. Anything else     -> render the page and capture the relevant region.
 *
 * Returns a stored image behind an expiring public URL by default. base64 is
 * opt-in and size-capped: a 1MB PNG pasted into an agent transcript as text is
 * ~380k tokens, versus ~1.2k visual tokens for the same image passed properly,
 * so the URL form is the right default for the LLM callers this serves.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { screenshot, captureHtml, SHOT_DEFAULTS, type ShotMode, type ShotResult } from '../../browser/screenshot.js';
import { isReddit } from '../../browser/embeds.js';
import { fetchRedditPost, redditCardHtml, redditCircuitStatus } from '../../screenshot/reddit.js';
import { checkUrl, normalizeUrl } from '../../browser/urlGuard.js';
import {
  insertScreenshot, getScreenshot, readImage, saveImage, listScreenshots,
} from '../../screenshot/storage.js';
import { estimateUpstream } from '../usage.js';

const router = Router();

/** Public router — image retrieval carries no auth so agents can hand out links. */
export const screenshotPublic = Router();

const MODES: ShotMode[] = ['auto', 'relevant', 'viewport', 'full', 'element'];
/** Above this, base64 stops being a sane transport. */
const MAX_BASE64_BYTES = 1_500_000;
const DEFAULT_EXPIRY_DAYS = 7;

function expiryIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function callerWallet(req: any): string {
  return (req.headers['x-wallet-address'] as string)
    || (req.headers['x-api-key'] as string)
    || 'anonymous';
}

function addUsageNote(res: any, note: string): void {
  res.locals.usageNote = res.locals.usageNote ? `${res.locals.usageNote}; ${note}` : note;
}

// ─── POST / — capture ───

router.post('/', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawUrl = String(body.url || body.u || '').trim();

  if (!rawUrl) {
    res.status(400).json({ ok: false, error: 'Missing "url" field' });
    return;
  }
  const blocked = checkUrl(rawUrl);
  if (blocked) {
    res.status(400).json({ ok: false, error: blocked });
    return;
  }
  const url = normalizeUrl(rawUrl);

  const mode = MODES.includes(body.mode as ShotMode) ? (body.mode as ShotMode) : 'auto';
  if (mode === 'element' && !body.selector) {
    res.status(400).json({ ok: false, error: 'mode "element" requires a "selector"' });
    return;
  }
  const format = body.format === 'png' ? 'png' : 'jpeg';
  const encoding = body.encoding === 'base64' ? 'base64' : 'url';
  const opts = {
    mode,
    selector: typeof body.selector === 'string' ? body.selector : undefined,
    format: format as 'jpeg' | 'png',
    quality: Math.min(Math.max(Number(body.quality) || SHOT_DEFAULTS.quality, 30), 100),
    width: Math.min(Math.max(Number(body.width) || SHOT_DEFAULTS.width, 320), 2000),
    maxHeight: Math.min(Math.max(Number(body.maxHeight) || SHOT_DEFAULTS.maxHeight, 200), 8000),
    deviceScaleFactor: Math.min(Math.max(Number(body.scale) || SHOT_DEFAULTS.deviceScaleFactor, 1), 3),
    timeout: Math.min(Math.max(Number(body.timeout) || SHOT_DEFAULTS.timeout, 5_000), 60_000),
  };
  const expiryDays = Math.min(Math.max(Number(body.expiresInDays) || DEFAULT_EXPIRY_DAYS, 1), 30);

  const t0 = Date.now();
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'anonymous';
  console.log(`[Screenshot] ${new Date().toISOString()} | ${ip} | REQ ${mode} "${url.slice(0, 90)}"`);

  try {
    let shot: ShotResult;
    let upstream = estimateUpstream('playwright');

    if (isReddit(url)) {
      // Reddit: real data via Apify, pixels rendered here. ~110s in practice.
      const circuit = redditCircuitStatus();
      if (!circuit.ok) {
        addUsageNote(res, 'reddit circuit open');
        res.status(503).json({
          ok: false,
          error: `Reddit capture temporarily unavailable (last error: ${circuit.lastError}). Retrying in ~${Math.round((circuit.retryInMs ?? 0) / 60000)}min.`,
        });
        return;
      }
      const post = await fetchRedditPost(url);
      const html = redditCardHtml(post, new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
      shot = await captureHtml(html, '.card', { ...opts, width: 700 });
      shot = { ...shot, strategy: 'apify:reddit-card', pageUrl: post.url, title: post.title };
      upstream = estimateUpstream('apify', { platform: 'reddit', fetched: 1 });
      addUsageNote(res, 'reddit via apify card');
    } else {
      shot = await screenshot(url, opts);
      if (shot.strategy.startsWith('embed:')) upstream = estimateUpstream('embed');
    }

    const id = uuid();
    const filePath = saveImage(id, shot.buffer, shot.format);
    const expires = expiryIso(expiryDays);

    insertScreenshot({
      id,
      wallet: callerWallet(req),
      source_url: url,
      page_url: shot.pageUrl || null,
      title: shot.title ?? null,
      strategy: shot.strategy,
      format: shot.format,
      width: shot.width,
      height: shot.height,
      size_bytes: shot.buffer.length,
      file_path: filePath,
      expires_at: expires,
    });

    const elapsed = Date.now() - t0;
    console.log(
      `[Screenshot] ${ip} | OK ${shot.strategy} ${shot.width}x${shot.height} ` +
        `${(shot.buffer.length / 1024).toFixed(0)}KB | ${elapsed}ms → ${id}`,
    );
    res.locals.usage = {
      source: shot.strategy.split(':')[0],
      results: 1,
      upstream,
      detail: shot.strategy,
    };

    const payload: Record<string, unknown> = {
      ok: true,
      screenshotId: id,
      imageUrl: `/api/v1/screenshot/${id}/image`,
      strategy: shot.strategy,
      sourceUrl: url,
      pageUrl: shot.pageUrl || undefined,
      title: shot.title,
      format: shot.format,
      width: shot.width,
      height: shot.height,
      sizeBytes: shot.buffer.length,
      truncated: shot.truncated || undefined,
      expiresAt: expires,
      elapsedMs: elapsed,
    };

    if (encoding === 'base64') {
      if (shot.buffer.length > MAX_BASE64_BYTES) {
        payload.base64Omitted =
          `Image is ${(shot.buffer.length / 1024).toFixed(0)}KB, above the ${MAX_BASE64_BYTES / 1000}KB inline cap — fetch imageUrl instead.`;
      } else {
        payload.imageBase64 = shot.buffer.toString('base64');
        payload.mediaType = shot.format === 'png' ? 'image/png' : 'image/jpeg';
      }
    }

    res.json(payload);
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    const msg = err?.message || 'Screenshot failed';
    console.error(`[Screenshot] ${ip} | FAIL ${msg.slice(0, 120)} | ${elapsed}ms`);
    addUsageNote(res, `fail: ${msg.slice(0, 80)}`);
    const timedOut = /timeout|timed out/i.test(msg);
    res.status(timedOut ? 504 : 502).json({ ok: false, error: msg.slice(0, 300), elapsedMs: elapsed });
  }
});

// ─── GET /list — recent captures for this caller (public: read-only, no charge) ───

screenshotPublic.get('/list', (req, res) => {
  res.json({ ok: true, screenshots: listScreenshots(callerWallet(req)) });
});

// ─── GET /:id — metadata. Public so a metadata read is never billed; the
//     paid router below handles POST only. Declared AFTER /list so that a
//     literal "list" path can't be swallowed as an :id. ───

screenshotPublic.get('/:id', (req, res) => {
  const rec = getScreenshot(req.params.id);
  if (!rec) {
    res.status(404).json({ ok: false, error: 'Screenshot not found or expired.' });
    return;
  }
  res.json({
    ok: true,
    screenshotId: rec.id,
    imageUrl: `/api/v1/screenshot/${rec.id}/image`,
    sourceUrl: rec.source_url,
    pageUrl: rec.page_url,
    title: rec.title,
    strategy: rec.strategy,
    format: rec.format,
    width: rec.width,
    height: rec.height,
    sizeBytes: rec.size_bytes,
    createdAt: rec.created_at,
    expiresAt: rec.expires_at,
  });
});

// ─── GET /:id/image — public image bytes ───

screenshotPublic.get('/:id/image', (req, res) => {
  const rec = getScreenshot(req.params.id);
  if (!rec) {
    res.status(404).json({ ok: false, error: 'Screenshot not found or expired.' });
    return;
  }
  const buffer = readImage(rec);
  if (!buffer) {
    res.status(404).json({ ok: false, error: 'Image file not found on disk.' });
    return;
  }
  res.setHeader('Content-Type', rec.format === 'png' ? 'image/png' : 'image/jpeg');
  res.setHeader('Content-Disposition', `inline; filename="kamai-${rec.id.slice(0, 8)}.${rec.format === 'png' ? 'png' : 'jpg'}"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

export default router;
