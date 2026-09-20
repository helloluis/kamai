/**
 * Comment / reply crawl for a single post permalink.
 *
 * Used by POST /api/v1/search/comments. Sentigen (and any other sister) probes
 * that route every collect run and treats HTTP 404 as "kamai has not shipped
 * this yet". So this module must never 404 a deleted, private, or empty post —
 * those come back as an empty result set. Transient actor failures are 5xx.
 *
 * Actors (env-swappable, researched Aug 2026):
 *   facebook  danek~facebook-comments-ppr          ($0.40/1k, needs post_id)
 *             apify~facebook-comments-scraper      ($1.40/1k, startUrls fallback)
 *   x         xquik~x-reply-scraper                ($0.15/1k replies)
 *   reddit    trudax~reddit-scraper-lite           (already used by /screenshot)
 *
 * Nested replies are flattened. Textless rows are dropped. run-sync is capped
 * at ~120s (reddit ~150s); a truncated thread is accepted — sentigen crawls
 * each post once, so a later page is never fetched.
 */
import { checkUrl } from '../browser/urlGuard.js';
import { normalizePublishedAt } from './searchNormalize.js';

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';

export const COMMENT_PLATFORMS = ['facebook', 'x', 'reddit'] as const;
export type CommentPlatform = (typeof COMMENT_PLATFORMS)[number];

/** Usage/cost key — distinct from /search/social so invoices don't mix. */
export function commentCostKey(platform: CommentPlatform): string {
  return `${platform}-comments`;
}

export const COMMENT_ACTORS = {
  facebook: () => process.env.APIFY_FB_COMMENTS_ACTOR || 'danek~facebook-comments-ppr',
  facebookFallback: () =>
    process.env.APIFY_FB_COMMENTS_FALLBACK_ACTOR || 'apify~facebook-comments-scraper',
  x: () => process.env.APIFY_X_COMMENTS_ACTOR || 'xquik~x-reply-scraper',
  reddit: () => process.env.APIFY_REDDIT_ACTOR || 'trudax~reddit-scraper-lite',
};

/** Actor slugs for Apify cost reconciliation. Reddit comments share the
 *  screenshot actor — attributing that spend twice would double-count it. */
export function commentPlatformActorMap(): Record<string, string> {
  return {
    'facebook-comments': COMMENT_ACTORS.facebook(),
    'x-comments': COMMENT_ACTORS.x(),
  };
}

export interface CommentResult {
  id: string | null;
  url: string | null;
  author: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
}

export type CommentsOk = {
  ok: true;
  results: CommentResult[];
  fetched: number;
  hasMore: boolean;
  nextCursor: null;
};

export type CommentsFail = {
  ok: false;
  status: number;
  error: string;
};

const PLATFORM_ALIASES: Record<string, CommentPlatform> = {
  twitter: 'x',
  'x.com': 'x',
  'twitter.com': 'x',
};

export function canonicalCommentPlatform(raw: unknown): CommentPlatform | null {
  const s = String(raw || '').toLowerCase().trim();
  const mapped = (PLATFORM_ALIASES[s] ?? s) as CommentPlatform;
  return COMMENT_PLATFORMS.includes(mapped) ? mapped : null;
}

export function parseCommentCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(500, Math.max(1, Math.trunc(n)));
}

// ─── URL shape ───

const HOSTS: Record<CommentPlatform, string[]> = {
  facebook: ['facebook.com', 'fb.com', 'fb.watch'],
  x: ['x.com', 'twitter.com'],
  reddit: ['reddit.com', 'redd.it'],
};

function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

function hostAllowed(host: string, roots: string[]): boolean {
  const h = canonicalHost(host);
  return roots.some((r) => h === r || h.endsWith(`.${r}`));
}

function parseHttpUrl(raw: string): URL | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

/** Facebook post_id for danek (pfbid… or a numeric id). Null → use the URL actor. */
export function facebookPostId(u: URL): string | null {
  const blob = `${u.pathname}${u.search}`;
  const pfbid = blob.match(/pfbid[0-9A-Za-z]+/);
  if (pfbid) return pfbid[0];

  const path =
    u.pathname.match(
      /\/(?:posts|videos|reel|reels|permalink|photos?)\/(?:[^/]+\/)?(\d{5,})/i,
    ) || u.pathname.match(/\/groups\/[^/]+\/(?:posts|permalink)\/(\d{5,})/i);
  if (path) return path[1];

  for (const key of ['story_fbid', 'fbid', 'v']) {
    const v = u.searchParams.get(key);
    if (v && /^(pfbid[0-9A-Za-z]+|\d{5,})$/.test(v)) return v;
  }
  return null;
}

function facebookLooksLikePost(u: URL): boolean {
  if (facebookPostId(u)) return true;
  const p = u.pathname.toLowerCase();
  // Share / watch / photo permalinks the numeric extractor can miss.
  return (
    /\/(posts|videos|reel|reels|permalink|photo|photos|watch|story\.php|permalink\.php)\b/.test(p) ||
    /\/share\/[pr]\//.test(p) ||
    u.searchParams.has('story_fbid') ||
    u.searchParams.has('fbid') ||
    (canonicalHost(u.hostname) === 'fb.watch' && p.replace(/\//g, '').length > 0)
  );
}

export function xTweetId(u: URL): string | null {
  const m = u.pathname.match(/\/status\/(\d{5,})/i);
  return m ? m[1] : null;
}

function redditLooksLikePost(u: URL): boolean {
  const host = canonicalHost(u.hostname);
  const p = u.pathname;
  if (host === 'redd.it' || host.endsWith('.redd.it')) {
    return /^\/[A-Za-z0-9]+\/?$/.test(p);
  }
  return /\/comments\/[A-Za-z0-9]+/i.test(p) || /\/r\/[^/]+\/s\/[A-Za-z0-9]+/i.test(p);
}

export type UrlCheck =
  | { ok: true; url: string; parsed: URL }
  | { ok: false; error: string };

/**
 * Lexical SSRF + "is this a post permalink on the claimed platform".
 * A well-formed but dead permalink is NOT rejected here — the actor decides.
 */
export function checkCommentUrl(platform: CommentPlatform, raw: unknown): UrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'Missing "url" — pass the post permalink' };
  }
  const ssrf = checkUrl(raw.trim());
  if (ssrf) return { ok: false, error: ssrf };
  const parsed = parseHttpUrl(raw.trim());
  if (!parsed) return { ok: false, error: 'Malformed "url"' };
  if (!hostAllowed(parsed.hostname, HOSTS[platform])) {
    return {
      ok: false,
      error: `"url" host is not a ${platform} permalink (${parsed.hostname})`,
    };
  }
  if (platform === 'facebook' && !facebookLooksLikePost(parsed)) {
    return { ok: false, error: '"url" is not a Facebook post permalink' };
  }
  if (platform === 'x' && !xTweetId(parsed)) {
    return { ok: false, error: '"url" is not an X/Twitter status permalink' };
  }
  if (platform === 'reddit' && !redditLooksLikePost(parsed)) {
    return { ok: false, error: '"url" is not a Reddit post permalink' };
  }
  return { ok: true, url: parsed.toString(), parsed };
}

// ─── Circuits ───
//
// Separate from /search/social health: a comment actor is a different vendor
// input, and a "coffee" keyword smoke-test would 400 it. Per-post misses
// (deleted permalinks) must not open the circuit — same rule as Reddit
// screenshots.

const REPROBE_MS = 60 * 60 * 1000;
const circuits: Record<string, { failedAt: number; lastError: string }> = {
  facebook: { failedAt: 0, lastError: '' },
  'facebook-fallback': { failedAt: 0, lastError: '' },
  x: { failedAt: 0, lastError: '' },
  reddit: { failedAt: 0, lastError: '' },
};

function circuitOpen(name: string): boolean {
  const c = circuits[name];
  return c.failedAt > 0 && Date.now() - c.failedAt < REPROBE_MS;
}

function trip(name: string, err: string): void {
  circuits[name].failedAt = Date.now();
  circuits[name].lastError = err.slice(0, 200);
}

function heal(name: string): void {
  circuits[name].failedAt = 0;
}

export function commentCircuitStatus(platform: CommentPlatform): { ok: boolean; lastError?: string } {
  if (platform === 'facebook') {
    if (!circuitOpen('facebook') || !circuitOpen('facebook-fallback')) return { ok: true };
    return { ok: false, lastError: circuits.facebook.lastError || circuits['facebook-fallback'].lastError };
  }
  if (!circuitOpen(platform)) return { ok: true };
  return { ok: false, lastError: circuits[platform].lastError };
}

// ─── Actor run ───

function looksDead(status: number, body: string): boolean {
  if (status === 404) return true;
  const s = body.toLowerCase();
  return /not found|does not exist|deleted|private post|login required|cannot find|no such (post|tweet|status)|page not found|permalink.*(invalid|bad)/.test(
    s,
  );
}

type ActorFail = { ok: false; status: number; error: string; timedOut: boolean; dead: boolean };
type ActorOk = { ok: true; items: any[] };

async function runSyncGetItems(
  actor: string,
  input: Record<string, unknown>,
  opts: { timeoutSec: number; clientTimeoutMs: number; memoryMb?: number; maxTotalChargeUsd: number },
): Promise<ActorOk | ActorFail> {
  const params = new URLSearchParams({
    token: APIFY_API_TOKEN,
    timeout: String(opts.timeoutSec),
    maxTotalChargeUsd: String(opts.maxTotalChargeUsd),
  });
  if (opts.memoryMb) params.set('memory', String(opts.memoryMb));
  try {
    const resp = await fetch(`${APIFY_BASE}/acts/${actor}/run-sync-get-dataset-items?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(opts.clientTimeoutMs),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return {
        ok: false,
        status: resp.status >= 500 ? 502 : resp.status,
        error: `Apify actor ${actor} returned ${resp.status}: ${txt.slice(0, 200)}`,
        timedOut: false,
        dead: looksDead(resp.status, txt),
      };
    }
    const items = (await resp.json()) as unknown;
    return { ok: true, items: Array.isArray(items) ? items : [] };
  } catch (err: any) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      status: timedOut ? 504 : 500,
      error: err?.message || 'Apify comments run failed',
      timedOut,
      dead: false,
    };
  }
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function asId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function emptyOk(): CommentsOk {
  return { ok: true, results: [], fetched: 0, hasMore: false, nextCursor: null };
}

function finalize(items: any[], fetched: number, count: number, normalize: (it: any, now: number) => CommentResult | null): CommentsOk {
  const now = Date.now();
  const seen = new Set<string>();
  const results: CommentResult[] = [];
  for (const it of items) {
    const row = normalize(it, now);
    if (!row) continue;
    const key = row.id || row.url || `\0${row.author ?? ''}\0${row.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(row);
    if (results.length >= count) break;
  }
  return {
    ok: true,
    results,
    fetched,
    hasMore: results.length >= count,
    nextCursor: null,
  };
}

function failFrom(run: ActorFail): CommentsFail {
  return {
    ok: false,
    status: run.timedOut ? 504 : run.status >= 400 && run.status < 500 ? 502 : run.status,
    error: run.error,
  };
}

/** Timeouts and 5xx are actor-health; a 400 on one permalink is not. */
function tripIfActorDown(name: string, run: ActorFail): void {
  if (run.timedOut || run.status >= 500) trip(name, run.error);
}

// ─── Per-platform normalizers ───

function facebookDanekNormalize(it: any, now: number): CommentResult | null {
  const text = asText(it?.message);
  if (!text) return null;
  return {
    id: asId(it.id),
    url: null,
    author: asText(it.from?.name),
    text,
    publishedAt: normalizePublishedAt(it.created_time, now),
    likes: toNum(it.like_count),
  };
}

function facebookApifyNormalize(it: any, now: number): CommentResult | null {
  const text = asText(it?.text);
  if (!text) return null;
  return {
    id: asId(it.commentId || it.id),
    url: asText(it.commentUrl),
    author: asText(it.profileName),
    text,
    publishedAt: normalizePublishedAt(it.date, now),
    likes: toNum(it.likesCount),
  };
}

function xNormalize(it: any, now: number, rootId: string | null): CommentResult | null {
  // Empty / failed runs write one free diagnostic row — not a reply.
  const kind = it?.resultType;
  if (kind && kind !== 'reply') return null;
  const id = asId(it?.id);
  if (rootId && id === rootId) return null;
  const text = asText(it?.fullText || it?.text);
  if (!text) return null;
  const author =
    asText(it?.author?.userName) ||
    asText(it?.author?.username) ||
    asText(it?.author?.screen_name) ||
    asText(it?.authorUsername);
  return {
    id,
    url: asText(it?.url),
    author,
    text,
    publishedAt: normalizePublishedAt(it?.createdAt, now),
    likes: toNum(it?.likeCount ?? it?.likes),
  };
}

function redditNormalize(it: any, now: number): CommentResult | null {
  if (it?.dataType && it.dataType !== 'comment') return null;
  const text = asText(it?.body);
  if (!text) return null;
  return {
    id: asId(it.parsedId || it.id),
    url: asText(it.url),
    author: asText(it.username),
    text,
    publishedAt: normalizePublishedAt(it.createdAt, now),
    likes: toNum(it.upVotes),
  };
}

function xDiagnosticFailure(items: any[]): CommentsFail | null {
  const diag = items.find((it) => it?.resultType && it.resultType !== 'reply');
  if (!diag) return null;
  if (items.some((it) => !it?.resultType || it.resultType === 'reply')) return null;
  const status = String(diag.status || diag.completionReason || diag.message || '').toLowerCase();
  // An empty thread writes a free diagnostic — that is a successful crawl.
  if (/zero[- ]output|no replies|empty/.test(status)) return null;
  if (/unexpected-error|aborted|timeout|deadline|retryable|invalid-input/.test(status)) {
    return {
      ok: false,
      status: 502,
      error: asText(diag.message || diag.status) || 'X reply scraper reported a retryable failure',
    };
  }
  return null;
}

// ─── Public fetch ───

export async function fetchComments(
  platform: CommentPlatform,
  permalink: string,
  parsed: URL,
  count: number,
): Promise<CommentsOk | CommentsFail> {
  if (!APIFY_API_TOKEN) {
    return { ok: false, status: 503, error: 'Comments not configured on kamai server (APIFY_API_TOKEN missing)' };
  }

  const circuit = commentCircuitStatus(platform);
  if (!circuit.ok) {
    return {
      ok: false,
      status: 503,
      error: `${platform} comments temporarily unavailable (last error: ${circuit.lastError}). Retry later.`,
    };
  }

  if (platform === 'facebook') return fetchFacebook(permalink, parsed, count);
  if (platform === 'x') return fetchX(permalink, parsed, count);
  return fetchReddit(permalink, count);
}

async function fetchFacebook(permalink: string, parsed: URL, count: number): Promise<CommentsOk | CommentsFail> {
  const postId = facebookPostId(parsed);
  const primaryActor = COMMENT_ACTORS.facebook();
  const fallbackActor = COMMENT_ACTORS.facebookFallback();
  const primaryOpts = { timeoutSec: 110, clientTimeoutMs: 120_000, maxTotalChargeUsd: 0.5 };
  const fallbackOpts = { timeoutSec: 110, clientTimeoutMs: 120_000, maxTotalChargeUsd: 1.5 };

  let primary: ActorOk | ActorFail | null = null;
  if (postId && !circuitOpen('facebook')) {
    primary = await runSyncGetItems(primaryActor, { post_id: postId, max_comments: count }, primaryOpts);
    if (primary.ok) {
      heal('facebook');
      return finalize(primary.items, primary.items.length, count, facebookDanekNormalize);
    }
    if (primary.dead) return emptyOk();
    if (primary.timedOut) {
      trip('facebook', primary.error);
      return failFrom(primary);
    }
    // Fast 4xx/5xx: try the URL-based actor before giving up. A bad post_id
    // parse is the usual case; falling through on timeout would blow the
    // caller's 180s budget.
    tripIfActorDown('facebook', primary);
  }

  if (circuitOpen('facebook-fallback')) {
    return primary ? failFrom(primary) : { ok: false, status: 503, error: `Facebook comments unavailable: ${circuits['facebook-fallback'].lastError}` };
  }

  const fallback = await runSyncGetItems(
    fallbackActor,
    {
      startUrls: [{ url: permalink }],
      resultsLimit: count,
      includeNestedComments: true,
    },
    fallbackOpts,
  );
  if (fallback.ok) {
    heal('facebook-fallback');
    return finalize(fallback.items, fallback.items.length, count, facebookApifyNormalize);
  }
  if (fallback.dead) return emptyOk();
  tripIfActorDown('facebook-fallback', fallback);
  return failFrom(fallback);
}

async function fetchX(permalink: string, parsed: URL, count: number): Promise<CommentsOk | CommentsFail> {
  const actor = COMMENT_ACTORS.x();
  const tweetId = xTweetId(parsed);
  const run = await runSyncGetItems(
    actor,
    {
      startUrls: [{ url: permalink }],
      ...(tweetId ? { tweetIds: [tweetId] } : {}),
      scope: 'all',
      maxDepth: 8,
      maxItems: count,
      includeOriginalPost: false,
      collectionStrategy: 'auto',
      outputMode: 'compact',
      fieldStyle: 'camelCase',
    },
    { timeoutSec: 110, clientTimeoutMs: 120_000, maxTotalChargeUsd: 0.3 },
  );
  if (!run.ok) {
    if (run.dead) return emptyOk();
    tripIfActorDown('x', run);
    return failFrom(run);
  }
  heal('x');
  const diagFail = xDiagnosticFailure(run.items);
  if (diagFail) {
    trip('x', diagFail.error);
    return diagFail;
  }
  return finalize(run.items, run.items.length, count, (it, now) => xNormalize(it, now, tweetId));
}

async function fetchReddit(permalink: string, count: number): Promise<CommentsOk | CommentsFail> {
  const actor = COMMENT_ACTORS.reddit();
  // The post itself is one dataset item; comments are the rest. Cap both so a
  // 500-comment ask doesn't also bill a community crawl.
  const run = await runSyncGetItems(
    actor,
    {
      startUrls: [{ url: permalink }],
      skipComments: false,
      skipUserPosts: true,
      skipCommunity: true,
      maxItems: count + 1,
      maxPostCount: 1,
      maxComments: count,
    },
    { timeoutSec: 140, clientTimeoutMs: 150_000, memoryMb: 1024, maxTotalChargeUsd: 2.5 },
  );
  if (!run.ok) {
    if (run.dead) return emptyOk();
    tripIfActorDown('reddit', run);
    return failFrom(run);
  }
  heal('reddit');
  return finalize(run.items, run.items.length, count, redditNormalize);
}
