/**
 * Instagram capture via Apify.
 *
 * Instagram's embed path died from this datacenter IP: verified 2026-08-20 the
 * IP is 302-redirected to a login wall on both /p/<code>/embed/captioned/ AND
 * the post URL itself (og:image), so the Playwright embed renders an empty
 * document. Same IP-layer wall as Reddit — no stealth or UA trick reaches past
 * it, only a third party with its own proxy pool.
 *
 * So, exactly like Reddit, we fetch the real post via Apify and render a capture
 * card. It is a reconstruction, not a pixel copy of instagram.com — reported as
 * `apify:instagram-card` so a caller can never mistake one for the other.
 *
 * Actor: apify~instagram-scraper with directUrls — 15.8M runs/30d at 99.5%,
 * returns clean flat fields (caption, ownerUsername, likesCount, timestamp ISO,
 * displayUrl). Swap without a redeploy via APIFY_IG_POST_ACTOR.
 */
import { escapeHtml } from './html.js';
import { checkUrl } from '../browser/urlGuard.js';

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';
const IG_ACTOR = process.env.APIFY_IG_POST_ACTOR || 'apify~instagram-scraper';

/** Apify cold-start + fetch; IG runs ~15-40s, leave headroom. */
const IG_TIMEOUT_MS = 90_000;

export interface InstagramPost {
  caption: string | null;
  author: string | null;
  authorFullName: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  createdAt: string | null;
  imageUrl: string | null;
  type: string | null;
  url: string;
}

// ─── Circuit breaker (separate from the search actor-health map, like Reddit) ───
let failedAt = 0;
let lastError = '';
const REPROBE_MS = 30 * 60 * 1000;

export function instagramCircuitStatus(): { ok: boolean; lastError?: string; retryInMs?: number } {
  if (!(failedAt > 0 && Date.now() - failedAt < REPROBE_MS)) return { ok: true };
  return { ok: false, lastError, retryInMs: REPROBE_MS - (Date.now() - failedAt) };
}

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Fetch a single Instagram post's real data through Apify. */
export async function fetchInstagramPost(url: string): Promise<InstagramPost> {
  if (!APIFY_API_TOKEN) throw new Error('Instagram capture requires APIFY_API_TOKEN');
  const circuit = instagramCircuitStatus();
  if (!circuit.ok) throw new Error(`Instagram actor circuit open: ${lastError}`);

  const endpoint =
    `${APIFY_BASE}/acts/${IG_ACTOR}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(APIFY_API_TOKEN)}&timeout=80&memory=1024`;

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directUrls: [url], resultsType: 'posts', resultsLimit: 1 }),
      signal: AbortSignal.timeout(IG_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Apify instagram actor returned ${resp.status}: ${txt.slice(0, 160)}`);
    }
    const items = (await resp.json()) as any[];
    const it = Array.isArray(items) ? items[0] : null;
    if (!it || it.error || (!it.caption && !it.displayUrl)) {
      // Post is gone/private — the caller's URL, not the actor's health.
      const e = new Error('Instagram post not found — deleted, private, or a bad URL');
      (e as any).notAnActorFailure = true;
      throw e;
    }
    failedAt = 0;
    // displayUrl is rendered into an <img src> inside our browser, so it must
    // clear the SSRF guard — it comes from a third-party scraper, not from us.
    const img = typeof it.displayUrl === 'string' && !checkUrl(it.displayUrl) ? it.displayUrl : null;
    return {
      caption: typeof it.caption === 'string' && it.caption.trim() ? it.caption.trim() : null,
      author: it.ownerUsername || null,
      authorFullName: it.ownerFullName || null,
      likes: toNum(it.likesCount),
      comments: toNum(it.commentsCount),
      views: toNum(it.videoViewCount ?? it.videoPlayCount),
      createdAt: it.timestamp || null,
      imageUrl: img,
      type: it.type || null,
      url: it.url || url,
    };
  } catch (err: any) {
    if (!err?.notAnActorFailure) {
      failedAt = Date.now();
      lastError = err?.message?.slice(0, 200) || 'unknown';
    }
    throw err;
  }
}

/** Render the post as a capture card (evidence record, not an instagram.com replica). */
export function instagramCardHtml(post: InstagramPost, capturedAt: string): string {
  const likes = post.likes != null ? `♥ ${post.likes.toLocaleString()}` : '';
  const comments = post.comments != null ? `${post.comments.toLocaleString()} comments` : '';
  const views = post.views != null ? `${post.views.toLocaleString()} views` : '';
  const posted = post.createdAt ? new Date(post.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const meta = [likes, comments, views, posted].filter(Boolean).join('  ·  ');
  const name = post.authorFullName ? `${post.authorFullName} (@${post.author || '?'})` : `@${post.author || 'unknown'}`;

  const imgBlock = post.imageUrl
    ? `<img class="media" src="${escapeHtml(post.imageUrl)}" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  const captionBlock = post.caption
    ? `<div class="cap">${escapeHtml(post.caption).slice(0, 2200).replace(/\n+/g, '<br>')}</div>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;background:#fafafa;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;color:#262626}
  .card{width:600px;margin:0;background:#fff;border:1px solid #dbdbdb;border-radius:10px;overflow:hidden}
  .hd{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #efefef}
  .av{width:34px;height:34px;border-radius:50%;background:linear-gradient(45deg,#f09433,#dc2743,#bc1888);flex-shrink:0}
  .who{font-weight:600;font-size:14px}
  .media{display:block;width:100%;max-height:600px;object-fit:cover;background:#fafafa}
  .bd{padding:14px 16px 16px}
  .cap{white-space:pre-wrap;font-size:14.5px;color:#262626;max-height:440px;overflow:hidden}
  .meta{margin-top:14px;padding-top:12px;border-top:1px solid #efefef;color:#8e8e8e;font-size:13px}
  .ft{padding:9px 16px;background:#fafafa;border-top:1px solid #efefef;color:#b0b0b0;font-size:11.5px;display:flex;justify-content:space-between;align-items:center;gap:14px}
  .ft code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .ft .stamp{white-space:nowrap;flex-shrink:0}
  </style></head><body>
  <div class="card">
    <div class="hd"><span class="av"></span><span class="who">${escapeHtml(name)}</span></div>
    ${imgBlock}
    <div class="bd">
      ${captionBlock}
      <div class="meta">${escapeHtml(meta)}</div>
    </div>
    <div class="ft"><code>${escapeHtml(post.url)}</code><span class="stamp">captured by kamai · ${escapeHtml(capturedAt)}</span></div>
  </div></body></html>`;
}

export { IG_ACTOR, IG_TIMEOUT_MS };
