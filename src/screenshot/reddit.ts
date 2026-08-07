/**
 * Reddit capture via Apify.
 *
 * Reddit is the one platform with no usable route from this server. Verified
 * from the production Vultr IP on 2026-08-07: www.reddit.com -> 403,
 * old.reddit.com -> 403, /r/x/.json -> 403, oauth.reddit.com -> 403, and the
 * reddit oEmbed endpoint -> 403 "Blocked". The block is at the datacenter-IP
 * layer, so no amount of stealth, UA spoofing or embed cleverness reaches it —
 * only a third party with its own proxy pool does.
 *
 * Apify has no Reddit *screenshot* actor (the store has none for any platform
 * except X). What it has is post scrapers. So this fetches the real post data
 * and renders a capture card from it. That is a reconstruction, not a pixel
 * copy of reddit.com — the strategy is reported as `apify:reddit-card` so a
 * caller can never mistake one for the other.
 *
 * Actor chosen empirically: trudax~reddit-scraper-lite (id oAuCIx3ItNrs2okjQ)
 * at ~4.06M runs/30d, the most-used Reddit actor on the store. Verified live:
 * one post returned title/community/username/upVotes/numberOfComments/
 * createdAt/imageUrls in 109 SECONDS — hence the 150s timeout below and the
 * warning in the docs. Swap it without a redeploy via APIFY_REDDIT_ACTOR.
 */
import { escapeHtml } from './html.js';
import { checkUrl } from '../browser/urlGuard.js';

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';
const REDDIT_ACTOR = process.env.APIFY_REDDIT_ACTOR || 'trudax~reddit-scraper-lite';

/** Apify cold-start plus Reddit crawl measured at ~109s; leave real headroom. */
const REDDIT_TIMEOUT_MS = 150_000;

export interface RedditPost {
  title: string;
  community: string | null;
  author: string | null;
  upVotes: number | null;
  comments: number | null;
  createdAt: string | null;
  body: string | null;
  link: string | null;
  imageUrl: string | null;
  url: string;
}

// ─── Circuit breaker ───
//
// Deliberately separate from the actor-health map in apifySearch.ts: that map
// is keyed by *search platform* and its recordActorOutcome() resolves the actor
// through the search registry, which has no reddit entry. Sharing it would
// store a null actor id and corrupt the /search/health readout.

let failedAt = 0;
let lastError = '';
const REPROBE_MS = 60 * 60 * 1000;

export function redditCircuitOpen(): boolean {
  return failedAt > 0 && Date.now() - failedAt < REPROBE_MS;
}

export function redditCircuitStatus(): { ok: boolean; lastError?: string; retryInMs?: number } {
  if (!redditCircuitOpen()) return { ok: true };
  return { ok: false, lastError, retryInMs: REPROBE_MS - (Date.now() - failedAt) };
}

/** Fetch a single Reddit post's real data through Apify. */
export async function fetchRedditPost(url: string): Promise<RedditPost> {
  if (!APIFY_API_TOKEN) throw new Error('Reddit capture requires APIFY_API_TOKEN');
  if (redditCircuitOpen()) throw new Error(`Reddit actor circuit open: ${lastError}`);

  const endpoint =
    `${APIFY_BASE}/acts/${REDDIT_ACTOR}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(APIFY_API_TOKEN)}&timeout=140&memory=1024&maxTotalChargeUsd=0.06`;

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url }],
        skipComments: true,
        skipUserPosts: true,
        skipCommunity: true,
        includeMediaLinks: true,
        maxItems: 1,
      }),
      signal: AbortSignal.timeout(REDDIT_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Apify reddit actor returned ${resp.status}: ${txt.slice(0, 160)}`);
    }
    const items = (await resp.json()) as any[];
    const it = Array.isArray(items) ? items[0] : null;
    if (!it || (!it.title && !it.body)) {
      // The actor worked; this specific post is gone. Tripping the circuit here
      // would let one caller's dead permalink 503 Reddit for every other caller
      // for an hour, so flag it as a per-request failure, not an actor failure.
      const e = new Error('Reddit post not found — deleted, private, or a bad permalink');
      (e as any).notAnActorFailure = true;
      throw e;
    }

    failedAt = 0;
    // The card renders imageUrl into an <img src> inside our own browser, so
    // this value must clear the same SSRF guard as any navigation target — it
    // arrives from a third-party scraper reading attacker-authorable post
    // content, not from us.
    const images: string[] = Array.isArray(it.imageUrls)
      ? it.imageUrls.filter((s: any) => typeof s === 'string' && !checkUrl(s))
      : [];
    return {
      title: it.title || '(untitled)',
      community: it.communityName || it.parsedCommunityName || null,
      author: it.username || null,
      upVotes: typeof it.upVotes === 'number' ? it.upVotes : null,
      comments: typeof it.numberOfComments === 'number' ? it.numberOfComments : null,
      createdAt: it.createdAt || null,
      body: typeof it.body === 'string' && it.body.trim() ? it.body.trim() : null,
      link: it.link || null,
      imageUrl: images[0] || null,
      url: it.url || url,
    };
  } catch (err: any) {
    // Only genuine actor/transport failures open the circuit. A missing post is
    // a property of the caller's URL, not of the actor's health.
    if (!err?.notAnActorFailure) {
      failedAt = Date.now();
      lastError = err?.message?.slice(0, 200) || 'unknown';
    }
    throw err;
  }
}

/**
 * Render the post as a capture card.
 *
 * Styled as an evidence record, NOT as a replica of Reddit's UI — it carries a
 * capture timestamp and a kamai footer so it reads as "kamai captured this
 * post" rather than passing itself off as a screenshot of reddit.com.
 */
export function redditCardHtml(post: RedditPost, capturedAt: string): string {
  const score = post.upVotes != null ? `${post.upVotes.toLocaleString()} upvotes` : '';
  const comments = post.comments != null ? `${post.comments.toLocaleString()} comments` : '';
  const posted = post.createdAt ? new Date(post.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const meta = [score, comments, posted].filter(Boolean).join('  ·  ');

  const bodyBlock = post.body
    ? `<div class="body">${escapeHtml(post.body).slice(0, 2400).replace(/\n+/g, '<br>')}</div>`
    : '';
  const linkBlock = post.link && !/^https?:\/\/(www\.)?reddit\.com/.test(post.link)
    ? `<div class="link">🔗 ${escapeHtml(post.link)}</div>`
    : '';
  const imgBlock = post.imageUrl
    ? `<img class="media" src="${escapeHtml(post.imageUrl)}" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;background:#f6f7f8;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;color:#1a1a1b}
  .card{width:680px;margin:0;background:#fff;border:1px solid #cccfd2;border-radius:8px;overflow:hidden}
  .hd{display:flex;align-items:center;gap:8px;padding:12px 18px;border-bottom:1px solid #edeff1;background:#fafafa}
  .sub{font-weight:700;color:#1a1a1b}
  .by{color:#7c7c7c;font-size:13px}
  .bd{padding:16px 18px 18px}
  h1{font-size:21px;line-height:1.3;margin:0 0 10px;font-weight:600}
  .body{white-space:pre-wrap;color:#1c1c1c;font-size:14.5px;margin:10px 0 0;max-height:520px;overflow:hidden}
  .link{margin-top:12px;font-size:13.5px;color:#0079d3;word-break:break-all}
  .media{display:block;max-width:100%;max-height:460px;margin-top:14px;border-radius:6px;border:1px solid #edeff1}
  .meta{margin-top:16px;padding-top:12px;border-top:1px solid #edeff1;color:#7c7c7c;font-size:13px}
  .ft{padding:9px 18px;background:#fafafa;border-top:1px solid #edeff1;color:#9aa0a6;font-size:11.5px;display:flex;justify-content:space-between;align-items:center;gap:14px}
  /* The permalink is long and the stamp must stay on one line — let the URL
     ellipsize instead of wrapping the timestamp down four rows. */
  .ft code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .ft .stamp{white-space:nowrap;flex-shrink:0}
  </style></head><body>
  <div class="card">
    <div class="hd"><span class="sub">${escapeHtml(post.community || 'reddit')}</span>
      <span class="by">· posted by u/${escapeHtml(post.author || 'unknown')}</span></div>
    <div class="bd">
      <h1>${escapeHtml(post.title)}</h1>
      ${linkBlock}${bodyBlock}${imgBlock}
      <div class="meta">${escapeHtml(meta)}</div>
    </div>
    <div class="ft"><code>${escapeHtml(post.url)}</code><span class="stamp">captured by kamai · ${escapeHtml(capturedAt)}</span></div>
  </div></body></html>`;
}

export { REDDIT_ACTOR, REDDIT_TIMEOUT_MS };
