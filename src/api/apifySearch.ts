/**
 * Apify actor-backed social search + actor health monitoring.
 *
 * Apify is a marketplace: each "actor" is a third-party scraper callable via
 * one uniform API (POST /v2/acts/{actor}/run-sync-get-dataset-items). Actors
 * rot — vendors abandon them, platforms change their internals — so every
 * actor ID is env-swappable and a 72h health check smoke-tests each one.
 * A failed check (or failed live call) breaks the circuit: /social skips the
 * actor, then lets one call through as a half-open probe whose outcome heals or
 * re-breaks it. Sisters can force a re-check via POST /search/health/check.
 *
 * Health is PERSISTED in usage.db (src/api/actorHealth.ts) with an exponential
 * backoff — 1h, 2h, 4h … capped at 24h — and every failure is logged. Probing
 * still happens, because that is what heals the circuit when a vendor recovers;
 * it just gets cheaper the longer something stays broken.
 *
 * That matters because a health check is a BILLED run, not a free ping. While
 * state was in-memory, every deploy re-probed every known-dead actor (twice,
 * with the retry): Instagram burned 66 billed runs against ONE successful
 * request across a day of restarts.
 */
import { Router } from 'express';
import { SISTER_KEYS } from '../payment/config.js';
import { normalizePublishedAt } from './searchNormalize.js';
import { startApifyCostScheduler, apifyCostSnapshot, measuredCostPerRun } from './apifyCost.js';
import {
  shouldAttempt, recordOutcome, getAllHealth, isKnownFailing, dueForHealthCheck,
  actorReport, recentFailures, type ActorHealth,
} from './actorHealth.js';

const APIFY_BASE = 'https://api.apify.com/v2';
export const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';

// ─── Result shape (mirrors the /search/social normalization) ───

export interface SocialResult {
  id: string | null;
  url: string | null;
  text: string | null;
  author: string | null;
  publishedAt: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  meta?: unknown;
}

// ─── Actor registry ───

interface ApifySearchSpec {
  /** Default actor in username~actorname form; overridable via actorEnv. */
  defaultActor: string;
  actorEnv: string;
  /**
   * Build the actor input. `endIso` is set only for date-paged actors on
   * page 2+ — it's the exclusive upper time bound (results strictly before it).
   */
  makeInput: (q: string, n: number, freshnessMs?: number, endIso?: string) => Record<string, unknown>;
  /**
   * Map one raw dataset item to SocialResult; return null to drop the item.
   * `nowMs` anchors relative timestamps so every item in a run shares a clock.
   */
  normalize: (it: any, nowMs: number) => SocialResult | null;
  /**
   * How the actor supports backward pagination, if at all:
   *  - 'timestamp': honors a second-precision `end` bound (X/apidojo). Each page
   *    walks older by setting `end` to the previous page's oldest timestamp.
   *  - 'dayWindow': honors a strict startDate=endDate day slice but NOT an
   *    open-ended end bound (facebook/scraper_one). Paging walks one calendar
   *    day at a time.
   * Absent → no pagination (the actor has a volume knob only, so a second call
   * re-returns the same top-N — instagram).
   */
  pageStrategy?: 'timestamp' | 'dayWindow';
}

const DAY_MS = 86_400_000;
/** How far a dayWindow backfill walks when no freshness floor is given. */
const DAYWINDOW_BACKSTOP_DAYS = 90;

/** apidojo wants `YYYY-MM-DD_HH:MM:SS_UTC`. Second precision is honored (verified). */
function apidojoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', '_') + '_UTC';
}

/** `YYYY-MM-DD` for a timestamp (UTC). */
function dayOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** Midnight-UTC ms of the day containing `ms`. */
function startOfDayMs(ms: number): number {
  return Date.parse(dayOnly(ms) + 'T00:00:00.000Z');
}

/** Coerce actor count fields that arrive as strings (and sometimes "None"). */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Preset freshness windows, same vocabulary as /search/web. */
export const FRESHNESS_MS: Record<string, number> = {
  pd: 24 * 3_600_000,
  pw: 7 * 24 * 3_600_000,
  pm: 30 * 24 * 3_600_000,
  py: 365 * 24 * 3_600_000,
};

const FRESHNESS_UNITS: Record<string, number> = {
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Smallest harvestapi postedLimit bucket that fully contains the window.
 * Buckets are coarser than the requested window on purpose — the exact
 * post-filter in apifyActorSearch still trims to the precise cutoff.
 */
function linkedinPostedLimit(ms: number): string {
  if (ms <= 3_600_000) return '1h';
  if (ms <= 86_400_000) return '24h';
  if (ms <= 604_800_000) return 'week';
  if (ms <= 2_592_000_000) return 'month';
  if (ms <= 7_776_000_000) return '3months';
  if (ms <= 15_552_000_000) return '6months';
  return 'year';
}

/**
 * Parse a caller-supplied freshness window to milliseconds.
 * Accepts presets (pd|pw|pm|py) or durations: "90min", "2h", "3d", "1w" —
 * agents can ask for anything from "last hour" to a long backfill.
 */
export function parseFreshness(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (FRESHNESS_MS[s]) return FRESHNESS_MS[s];
  const m = s.match(/^(\d+)\s*(min|h|d|w)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * FRESHNESS_UNITS[m[2]];
}

export const APIFY_SEARCH: Record<string, ApifySearchSpec> = {
  // Facebook public post keyword search — scraper_one~facebook-posts-search.
  //
  // Switched from memo23~facebook-search-scraper, which has ONLY maxItems (no
  // dates, no cursor) and so re-returns the same top-N on any repeat — it
  // cannot backfill. scraper_one honors a STRICT startDate=endDate day slice
  // (verified 18/18 inside one day), but NOT an open-ended end bound (endDate
  // alone leaks months of results), so its paging is a day-at-a-time walk
  // rather than X's smooth timestamp cursor. ~$0.0025/item, 99.9% success.
  //
  // Page 1 (no cursor) is a plain newest-N search, freshness-bounded when given,
  // so a non-paginating "latest FB posts" caller is unchanged. Pages 2+ are
  // single-day slices; makeInput's `endIso` is a YYYY-MM-DD day for this actor.
  facebook: {
    defaultActor: 'scraper_one~facebook-posts-search',
    actorEnv: 'APIFY_FB_SEARCH_ACTOR',
    pageStrategy: 'dayWindow',
    makeInput: (q, n, freshnessMs, endIso) => {
      const base: Record<string, unknown> = { query: q, searchType: 'latest', resultsCount: Math.min(n, 200) };
      if (endIso) return { ...base, startDate: endIso, endDate: endIso }; // page 2+: one day
      if (freshnessMs) return { ...base, startDate: dayOnly(Date.now() - freshnessMs), endDate: dayOnly(Date.now()) };
      return base; // page 1, no window: newest N
    },
    normalize: (it: any, nowMs: number) => {
      const id = it?.postId || null;
      const url = it?.url || null;
      if (!url && !id) return null;
      return {
        id,
        url,
        text: it.postText || null,
        author: it.author?.name || null,
        // timestamp is epoch MILLISECONDS; normalizePublishedAt handles the unit.
        publishedAt: normalizePublishedAt(it.timestamp, nowMs),
        likes: toNum(it.reactionsCount),
        comments: toNum(it.commentsCount),
        shares: toNum(it.sharesCount),
        views: null,
        meta: it.reactions ? { reactions: it.reactions } : undefined,
      };
    },
  },

  // Instagram keyword search — official Apify actor, "popular" type is the only
  // no-login keyword path; returns public reels (IG exposes no photo keyword
  // search without a session). likesCount === -1 means the author hid likes.
  instagram: {
    defaultActor: 'apify~instagram-search-scraper',
    actorEnv: 'APIFY_IG_SEARCH_ACTOR',
    makeInput: (q, n) => ({ search: q, searchType: 'popular', searchLimit: n }),
    normalize: (it: any, nowMs: number) => {
      const url = it?.url || null;
      if (!url) return null;
      return {
        id: it.shortCode || it.id || null,
        url,
        text: it.caption || null,
        author: it.ownerUsername || null,
        publishedAt: normalizePublishedAt(it.timestamp, nowMs),
        likes: typeof it.likesCount === 'number' && it.likesCount >= 0 ? it.likesCount : null,
        comments: it.commentsCount ?? null,
        shares: null, // Instagram never exposes share counts
        views: it.videoViewCount ?? it.videoPlayCount ?? null,
      };
    },
  },

  // TikTok keyword search — clockworks is the most battle-tested actor in the
  // marketplace. searchSection '/video' is required (default '' mixes profiles
  // in). Error items land in the dataset with an errorCode field — drop them.
  // NOTE: the videoSearchDateFilter/videoSearchSorting add-ons both hang the
  // actor upstream (device-id retry loops, 100s+ runs) — freshness is handled
  // by over-fetch + post-filter instead.
  tiktok: {
    defaultActor: 'clockworks~tiktok-scraper',
    actorEnv: 'APIFY_TT_SEARCH_ACTOR',
    makeInput: (q, n) => ({ searchQueries: [q], searchSection: '/video', resultsPerPage: n }),
    normalize: (it: any, nowMs: number) => {
      const url = it?.webVideoUrl || null;
      if (!url || it.errorCode) return null;
      return {
        id: it.id || null,
        url,
        text: it.text || null,
        author: it.authorMeta?.name || null,
        publishedAt: normalizePublishedAt(it.createTimeISO ?? it.createTime, nowMs),
        likes: it.diggCount ?? null,
        comments: it.commentCount ?? null,
        shares: it.shareCount ?? null,
        views: it.playCount ?? null,
      };
    },
  },

  // X / Twitter keyword search — apidojo~tweet-scraper.
  //
  // Switched from danek~twitter-scraper (which is cheaper at $0.00024/item but
  // was measured to IGNORE date operators — every since:/until: window returned
  // out-of-window tweets, so it cannot backfill). apidojo honors native
  // `start`/`end` at SECOND precision (verified 15/15 inside a 2h window), which
  // is what makes true backward pagination possible. $0.0004/item, no start fee.
  //
  // sort 'Latest' is chronological — required for date-windowed paging;
  // 'Top' would return an engagement-ranked slice that breaks the time walk.
  x: {
    defaultActor: 'apidojo~tweet-scraper',
    actorEnv: 'APIFY_X_SEARCH_ACTOR',
    pageStrategy: 'timestamp',
    makeInput: (q, n, freshnessMs, endIso) => ({
      searchTerms: [q],
      sort: 'Latest',
      maxItems: n,
      // freshness is the backfill floor (start); the cursor is the ceiling
      // (end). Together they bound the window and terminate the walk.
      ...(freshnessMs ? { start: apidojoDate(Date.now() - freshnessMs) } : {}),
      ...(endIso ? { end: endIso } : {}),
    }),
    normalize: (it: any, nowMs: number) => {
      const id = it?.id || null;
      const handle = it?.author?.userName || it?.author?.screen_name || null;
      if (!id) return null;
      return {
        id,
        url: it.url || (handle ? `https://x.com/${handle}/status/${id}` : null),
        text: it.fullText || it.text || null,
        author: handle,
        publishedAt: normalizePublishedAt(it.createdAt, nowMs),
        likes: toNum(it.likeCount),
        comments: toNum(it.replyCount),
        shares: toNum(it.retweetCount),
        views: toNum(it.viewCount),
        meta: it.lang
          ? { lang: it.lang, quotes: toNum(it.quoteCount), retweet: it.isRetweet === true || it.isRetweet === 'true' }
          : undefined,
      };
    },
  },

  // LinkedIn post keyword search — harvestapi runs ~888K times/month at a
  // ~0.03% failure rate. Reactions/comments scraping stays off: each one is
  // billed as a separate result event. postedLimit/sortBy are first-class
  // inputs (unlike tiktok's hang-prone add-ons): without them a freshness
  // window filters a relevance-sorted top-N that is all old posts, so fresh
  // ones never surface. Only applied when freshness is requested — backfills
  // keep LinkedIn's default relevance order.
  linkedin: {
    defaultActor: 'harvestapi~linkedin-post-search',
    actorEnv: 'APIFY_LI_SEARCH_ACTOR',
    makeInput: (q, n, freshnessMs) => ({
      searchQueries: [q],
      maxPosts: n,
      ...(freshnessMs ? { postedLimit: linkedinPostedLimit(freshnessMs), sortBy: 'date' } : {}),
      scrapeReactions: false,
      postNestedReactions: false,
      scrapeComments: false,
      postNestedComments: false,
    }),
    normalize: (it: any, nowMs: number) => {
      const url = it?.linkedinUrl || null;
      if (!url) return null;
      return {
        id: null,
        url,
        text: it.content || null,
        author: it.author?.name || null,
        publishedAt: normalizePublishedAt(it.postedAt?.date ?? it.postedAt?.timestamp, nowMs),
        likes: it.engagement?.likes ?? null,
        comments: it.engagement?.comments ?? null,
        shares: it.engagement?.shares ?? null,
        views: null, // LinkedIn doesn't expose public view counts
      };
    },
  },
};

/** Resolve the actor ID for a platform (env override → registry default). */
export function resolvedActor(platform: string): string | null {
  const spec = APIFY_SEARCH[platform];
  return spec ? process.env[spec.actorEnv] || spec.defaultActor : null;
}

// ─── Search call ───

export async function apifyActorSearch(
  platform: string,
  queryStr: string,
  count: number,
  freshnessMs?: number,
  /** Upper time bound in ms — page backward before this (paged actors only). */
  endMs?: number,
): Promise<
  | { ok: true; results: SocialResult[]; fetched: number; nextCursorMs?: number; hasMore?: boolean }
  | { ok: false; status: number; error: string }
> {
  const spec = APIFY_SEARCH[platform];
  const actor = resolvedActor(platform);
  if (!spec || !actor) return { ok: false, status: 400, error: `No Apify adapter for ${platform}` };
  // A date-paged actor filters by start/end natively (accurate), so the 3x
  // over-fetch that compensates for the post-filter isn't needed. Others still
  // over-fetch to survive the freshness post-filter dropping items.
  const fetchCount = spec.pageStrategy
    ? count
    : freshnessMs ? Math.min(50, count * 3) : count;
  // The `end` bound format differs by strategy: second-precision datetime for
  // the timestamp walk, a bare day for the day-window walk.
  const endIso = endMs === undefined ? undefined
    : spec.pageStrategy === 'timestamp' ? apidojoDate(endMs)
    : spec.pageStrategy === 'dayWindow' ? dayOnly(endMs)
    : undefined;
  try {
    const resp = await fetch(
      `${APIFY_BASE}/acts/${actor}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}&timeout=100`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec.makeInput(queryStr, fetchCount, freshnessMs, endIso)),
        signal: AbortSignal.timeout(120_000), // actor cold start + pagination can be slow
      },
    );
    if (!resp.ok) {
      const txt = await resp.text();
      return { ok: false, status: resp.status >= 500 ? 502 : resp.status, error: `Apify actor ${actor} returned ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const items: any[] = (await resp.json()) as any[];
    // NB: an arrow, not a bare `.map(spec.normalize)` — map would pass the
    // array index as normalize's second argument, silently anchoring every
    // relative timestamp to epoch+0ms.
    const now = Date.now();
    let results = (Array.isArray(items) ? items : [])
      .map((it) => spec.normalize(it, now))
      .filter((r): r is SocialResult => r !== null);
    // Post-filter by publishedAt. Items with no usable timestamp can't prove
    // freshness and are dropped — applies even after native provider filtering
    // as a safety net against stale indexes.
    if (freshnessMs) {
      const cutoff = now - freshnessMs;
      results = results.filter((r) => {
        const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
        return !Number.isNaN(t) && t >= cutoff;
      });
    }
    // Compute the next cursor per paging strategy.
    let nextCursorMs: number | undefined;
    let hasMore: boolean | undefined;
    const times = results.map((r) => (r.publishedAt ? Date.parse(r.publishedAt) : NaN)).filter((t) => !Number.isNaN(t));
    if (spec.pageStrategy === 'timestamp') {
      // Walk older: next `end` is the oldest timestamp in this page (exclusive,
      // so the oldest post won't reappear). A short page means the window is dry.
      nextCursorMs = times.length ? Math.min(...times) : undefined;
      hasMore = items.length >= fetchCount && nextCursorMs !== undefined;
    } else if (spec.pageStrategy === 'dayWindow') {
      // Walk one calendar day at a time, down to the freshness floor (or a
      // backstop). Page 1 (no endMs) hands the next page the OLDEST day it saw —
      // page 2 then re-fetches that whole day (deduped by id) so nothing between
      // page 1's cut and the day boundary is skipped. Page 2+ steps one day back.
      const floorMs = startOfDayMs(freshnessMs ? Date.now() - freshnessMs : Date.now() - DAYWINDOW_BACKSTOP_DAYS * DAY_MS);
      const nextDayMs = endMs === undefined
        ? (times.length ? startOfDayMs(Math.min(...times)) : undefined)
        : startOfDayMs(endMs) - DAY_MS;
      if (nextDayMs !== undefined && nextDayMs >= floorMs) {
        nextCursorMs = nextDayMs;
        hasMore = true;
      } else {
        hasMore = false;
      }
    }
    // `fetched` feeds the cost estimate, so it must be what Apify BILLS — the
    // number of dataset items the actor produced — not what survived our
    // freshness post-filter. We over-fetch ~3x on purpose, so counting the
    // filtered survivors understated spend on every windowed query.
    return { ok: true, results: results.slice(0, count), fetched: items.length, nextCursorMs, hasMore };
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, status: isTimeout ? 504 : 500, error: err.message || 'Apify search failed' };
  }
}

// ─── Actor health (72h smoke checks) ───
//
// The ActorHealth shape now lives with the persistent store in actorHealth.ts;
// re-exported here so existing importers of this module are unaffected.

export type { ActorHealth };

const HEALTH_INTERVAL_MS = 72 * 60 * 60 * 1000;
/** How long a failed actor is skipped before a live call is let through as a probe. */
const REPROBE_MS = 60 * 60 * 1000;

/**
 * Should /social attempt this platform's actor right now? Healthy actors and
 * never-checked actors always pass. A failed actor is skipped until REPROBE_MS
 * has elapsed, then one live call is let through as a half-open probe — its
 * outcome is recorded via recordActorOutcome and either heals the circuit or
 * re-breaks it for another window.
 */
export function shouldAttemptActor(platform: string): boolean {
  return shouldAttempt(platform);
}

/** Record a live-call outcome as the platform's health (self-healing circuit). */
export function recordActorOutcome(platform: string, ok: boolean, latencyMs: number, error?: string): void {
  const actor = resolvedActor(platform) as string;
  // A live call reaching the actor at all means the circuit was half-open, so
  // this outcome is a probe result as much as a call result.
  recordOutcome(platform, actor, ok, latencyMs, error, 'live-call');
}

export function getActorHealth(): ActorHealth[] {
  return getAllHealth();
}

/** Smoke-test every registered actor with a 1-result benign query. Sequential to avoid cost spikes. */
export async function runActorHealthChecks(force = false): Promise<ActorHealth[]> {
  const checks: ActorHealth[] = [];
  for (const platform of Object.keys(APIFY_SEARCH)) {
    const actor = resolvedActor(platform) as string;

    // Respect the persisted backoff unless explicitly forced. Without this the
    // boot check re-tested every known-dead actor on every deploy — the single
    // largest source of wasted Apify spend, since each check is a billed run
    // (two, with the retry below).
    if (!force && !dueForHealthCheck(platform)) {
      console.log(`[ActorHealth] ${platform} ${actor} SKIP — still inside backoff window`);
      continue;
    }

    const t0 = Date.now();
    let r = await apifyActorSearch(platform, 'coffee', 1);
    // Transient blocks are common (e.g. Instagram rate-walls a single run) —
    // retry once before branding the actor degraded for the whole interval.
    // Skipped for an actor already failing repeatedly: paying twice to confirm
    // what the failure log already says is exactly the waste we are removing.
    if (!r.ok && !isKnownFailing(platform)) {
      console.warn(`[ActorHealth] ${platform} ${actor} first attempt failed (${r.error.slice(0, 120)}) — retrying in 20s`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      r = await apifyActorSearch(platform, 'coffee', 1);
    }
    const latencyMs = Date.now() - t0;
    recordOutcome(platform, actor, r.ok, latencyMs, r.ok ? undefined : r.error, 'health-check');
    const entry: ActorHealth = {
      platform, actor, ok: r.ok, latencyMs,
      error: r.ok ? undefined : r.error.slice(0, 200),
      checkedAt: new Date().toISOString(),
    };
    checks.push(entry);
    console.log(`[ActorHealth] ${platform} ${actor} ${r.ok ? 'OK' : 'FAIL'} | ${latencyMs}ms${r.ok ? '' : ` | ${entry.error}`}`);
  }
  return checks;
}

/** Boot check (after a 60s settle delay) + recurring 72h checks. No-op without a token. */
/** platform → the actor slug it currently calls, for cost attribution. */
export function platformActorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const platform of Object.keys(APIFY_SEARCH)) {
    const actor = resolvedActor(platform);
    if (actor) map[platform] = actor;
  }
  // Reddit is not a search platform but its screenshot actor bills the same way.
  map.reddit = process.env.APIFY_REDDIT_ACTOR || 'trudax~reddit-scraper-lite';
  return map;
}

export function startActorHealthScheduler(): void {
  if (!APIFY_API_TOKEN) {
    console.log('[ActorHealth] APIFY_API_TOKEN not set — actor health checks disabled');
    return;
  }
  // Health checks are real billed Apify runs — 94 TikTok runs against 72 kamai
  // calls, the gap being smoke tests — and they were previously invisible to
  // the /adm P&L. Start the cost refresher alongside them so the measured
  // averages include their cost.
  startApifyCostScheduler(platformActorMap());
  const boot = setTimeout(() => {
    runActorHealthChecks().catch((err) => console.error(`[ActorHealth] check run failed: ${err.message}`));
  }, 60_000);
  boot.unref();
  const timer = setInterval(() => {
    runActorHealthChecks().catch((err) => console.error(`[ActorHealth] check run failed: ${err.message}`));
  }, HEALTH_INTERVAL_MS);
  timer.unref();
  console.log('[ActorHealth] scheduled — first check in 60s, then every 72h');
}

// ─── Ops endpoint (sister-key gated; actor IDs name vendors, so not public) ───

export const searchOpsRouter = Router();

searchOpsRouter.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey && SISTER_KEYS.has(apiKey)) return next();
  res.status(404).json({ ok: false, error: 'Not found' });
});

searchOpsRouter.get('/', (_req, res) => {
  const byPlatform = new Map(getAllHealth().map((h) => [h.platform, h]));
  res.json({
    ok: true,
    intervalHours: HEALTH_INTERVAL_MS / 3_600_000,
    configured: !!APIFY_API_TOKEN,
    actors: Object.keys(APIFY_SEARCH).map((p) => ({
      ...(byPlatform.get(p) ?? { status: 'not yet checked' }),
      platform: p,
      actor: resolvedActor(p),
    })),
  });
});

/**
 * GET /api/v1/search/health/actors — failure history with an explicit
 * replace/watch recommendation, so swapping a rotted actor is driven by
 * numbers rather than a hunch. `?platform=x` adds that actor's recent errors.
 */
searchOpsRouter.get('/actors', (req, res) => {
  const report = actorReport(
    (p) => measuredCostPerRun(p),
    (p) => (p === 'reddit' ? 'APIFY_REDDIT_ACTOR' : APIFY_SEARCH[p]?.actorEnv ?? null),
  );
  const platform = typeof req.query.platform === 'string' ? req.query.platform : null;
  res.json({
    ok: true,
    actors: report,
    ...(platform ? { recentFailures: recentFailures(platform, 15) } : {}),
  });
});

/**
 * GET /api/v1/search/health/cost — real Apify spend vs what kamai logged.
 * The two drifting apart is the signal that the estimate is wrong again.
 */
searchOpsRouter.get('/cost', (_req, res) => {
  res.json({ ok: true, apify: apifyCostSnapshot() });
});

/** Manual re-check. `?force=1` ignores the backoff — costs a run per actor. */
searchOpsRouter.post('/check', async (req, res) => {
  const checks = await runActorHealthChecks(req.query.force === '1' || req.query.force === 'true');
  res.json({ ok: true, checks });
});
