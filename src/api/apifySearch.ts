/**
 * Apify actor-backed social search + actor health monitoring.
 *
 * Apify is a marketplace: each "actor" is a third-party scraper callable via
 * one uniform API (POST /v2/acts/{actor}/run-sync-get-dataset-items). Actors
 * rot — vendors abandon them, platforms change their internals — so every
 * actor ID is env-swappable and a 72h health check smoke-tests each one.
 * A failed check (or failed live call) breaks the circuit: /social skips the
 * actor for up to 1h, then lets one call through as a half-open probe whose
 * outcome heals or re-breaks the circuit. Sisters can also force a full
 * re-check via POST /api/v1/search/health/check.
 *
 * Health state is in-memory: a restart just re-runs the checks (60s after boot).
 * Smoke checks cost ~$0.01 per actor per run — a few dollars a year at 72h.
 */
import { Router } from 'express';
import { SISTER_KEYS } from '../payment/config.js';

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
  makeInput: (q: string, n: number, freshnessMs?: number) => Record<string, unknown>;
  /** Map one raw dataset item to SocialResult; return null to drop the item. */
  normalize: (it: any) => SocialResult | null;
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
  // Facebook public post keyword search (guest-token, no cookies).
  // Normalizer tolerates both memo23 (camelCase) and alien_force (snake_case)
  // outputs so the actor can be swapped without code changes.
  facebook: {
    defaultActor: 'memo23~facebook-search-scraper',
    actorEnv: 'APIFY_FB_SEARCH_ACTOR',
    makeInput: (q, n) => ({ searchType: 'posts', searchQueries: [q], maxItems: n }),
    normalize: (it: any) => {
      const url = it?.postUrl || it?.post_url || it?.url || null;
      if (!url) return null;
      return {
        id: it.postId || it.post_id || null,
        url,
        text: it.text || null,
        author: it.authorName || it.author_username || it.name || null,
        publishedAt:
          it.creationTime ||
          (typeof it.create_time === 'number' ? new Date(it.create_time).toISOString() : null),
        likes: it.likeCount ?? it.like_count ?? null,
        comments: it.commentCount ?? it.comment_count ?? null,
        shares: it.shareCount ?? it.share_count ?? null,
        views: it.viewCount ?? it.view_count ?? null,
        meta: it.isVerified != null ? { isVerified: it.isVerified } : undefined,
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
    normalize: (it: any) => {
      const url = it?.url || null;
      if (!url) return null;
      return {
        id: it.shortCode || it.id || null,
        url,
        text: it.caption || null,
        author: it.ownerUsername || null,
        publishedAt: it.timestamp || null,
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
    normalize: (it: any) => {
      const url = it?.webVideoUrl || null;
      if (!url || it.errorCode) return null;
      return {
        id: it.id || null,
        url,
        text: it.text || null,
        author: it.authorMeta?.name || null,
        publishedAt: it.createTimeISO || null,
        likes: it.diggCount ?? null,
        comments: it.commentCount ?? null,
        shares: it.shareCount ?? null,
        views: it.playCount ?? null,
      };
    },
  },

  // LinkedIn post keyword search — harvestapi runs ~888K times/month at a
  // ~0.03% failure rate. Reactions/comments scraping stays off: each one is
  // billed as a separate result event.
  linkedin: {
    defaultActor: 'harvestapi~linkedin-post-search',
    actorEnv: 'APIFY_LI_SEARCH_ACTOR',
    makeInput: (q, n) => ({
      searchQueries: [q],
      maxPosts: n,
      scrapeReactions: false,
      postNestedReactions: false,
      scrapeComments: false,
      postNestedComments: false,
    }),
    normalize: (it: any) => {
      const url = it?.linkedinUrl || null;
      if (!url) return null;
      return {
        id: null,
        url,
        text: it.content || null,
        author: it.author?.name || null,
        publishedAt: it.postedAt?.date || null,
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
): Promise<{ ok: true; results: SocialResult[] } | { ok: false; status: number; error: string }> {
  const spec = APIFY_SEARCH[platform];
  const actor = resolvedActor(platform);
  if (!spec || !actor) return { ok: false, status: 400, error: `No Apify adapter for ${platform}` };
  // Post-filtering drops items, so over-fetch 3x to still fill `count`.
  const fetchCount = freshnessMs ? Math.min(50, count * 3) : count;
  try {
    const resp = await fetch(
      `${APIFY_BASE}/acts/${actor}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}&timeout=100`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec.makeInput(queryStr, fetchCount, freshnessMs)),
        signal: AbortSignal.timeout(120_000), // actor cold start + pagination can be slow
      },
    );
    if (!resp.ok) {
      const txt = await resp.text();
      return { ok: false, status: resp.status >= 500 ? 502 : resp.status, error: `Apify actor ${actor} returned ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const items: any[] = (await resp.json()) as any[];
    let results = (Array.isArray(items) ? items : [])
      .map(spec.normalize)
      .filter((r): r is SocialResult => r !== null);
    // Post-filter by publishedAt. Items with no usable timestamp can't prove
    // freshness and are dropped — applies even after native provider filtering
    // as a safety net against stale indexes.
    if (freshnessMs) {
      const cutoff = Date.now() - freshnessMs;
      results = results.filter((r) => {
        const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
        return !Number.isNaN(t) && t >= cutoff;
      });
    }
    return { ok: true, results: results.slice(0, count) };
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, status: isTimeout ? 504 : 500, error: err.message || 'Apify search failed' };
  }
}

// ─── Actor health (72h smoke checks) ───

export interface ActorHealth {
  platform: string;
  actor: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: string;
}

const HEALTH_INTERVAL_MS = 72 * 60 * 60 * 1000;
/** How long a failed actor is skipped before a live call is let through as a probe. */
const REPROBE_MS = 60 * 60 * 1000;
const healthState = new Map<string, ActorHealth>();

/**
 * Should /social attempt this platform's actor right now? Healthy actors and
 * never-checked actors always pass. A failed actor is skipped until REPROBE_MS
 * has elapsed, then one live call is let through as a half-open probe — its
 * outcome is recorded via recordActorOutcome and either heals the circuit or
 * re-breaks it for another window.
 */
export function shouldAttemptActor(platform: string): boolean {
  const h = healthState.get(platform);
  if (!h || h.ok) return true;
  return Date.now() - Date.parse(h.checkedAt) > REPROBE_MS;
}

/** Record a live-call outcome as the platform's health (self-healing circuit). */
export function recordActorOutcome(platform: string, ok: boolean, latencyMs: number, error?: string): void {
  const actor = resolvedActor(platform) as string;
  healthState.set(platform, {
    platform,
    actor,
    ok,
    latencyMs,
    error: ok ? undefined : error?.slice(0, 200),
    checkedAt: new Date().toISOString(),
  });
}

export function getActorHealth(): ActorHealth[] {
  return [...healthState.values()];
}

/** Smoke-test every registered actor with a 1-result benign query. Sequential to avoid cost spikes. */
export async function runActorHealthChecks(): Promise<ActorHealth[]> {
  const checks: ActorHealth[] = [];
  for (const platform of Object.keys(APIFY_SEARCH)) {
    const actor = resolvedActor(platform) as string;
    const t0 = Date.now();
    let r = await apifyActorSearch(platform, 'coffee', 1);
    // Transient blocks are common (e.g. Instagram rate-walls a single run) —
    // retry once before branding the actor degraded for the whole interval.
    if (!r.ok) {
      console.warn(`[ActorHealth] ${platform} ${actor} first attempt failed (${r.error.slice(0, 120)}) — retrying in 20s`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      r = await apifyActorSearch(platform, 'coffee', 1);
    }
    const entry: ActorHealth = {
      platform,
      actor,
      ok: r.ok,
      latencyMs: Date.now() - t0,
      error: r.ok ? undefined : r.error.slice(0, 200),
      checkedAt: new Date().toISOString(),
    };
    healthState.set(platform, entry);
    checks.push(entry);
    console.log(`[ActorHealth] ${platform} ${actor} ${r.ok ? 'OK' : 'FAIL'} | ${entry.latencyMs}ms${r.ok ? '' : ` | ${entry.error}`}`);
  }
  return checks;
}

/** Boot check (after a 60s settle delay) + recurring 72h checks. No-op without a token. */
export function startActorHealthScheduler(): void {
  if (!APIFY_API_TOKEN) {
    console.log('[ActorHealth] APIFY_API_TOKEN not set — actor health checks disabled');
    return;
  }
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
  res.json({
    ok: true,
    intervalHours: HEALTH_INTERVAL_MS / 3_600_000,
    configured: !!APIFY_API_TOKEN,
    actors: Object.keys(APIFY_SEARCH).map((p) => ({
      ...(healthState.get(p) ?? { status: 'not yet checked' }),
      platform: p,
      actor: resolvedActor(p),
    })),
  });
});

searchOpsRouter.post('/check', async (_req, res) => {
  const checks = await runActorHealthChecks();
  res.json({ ok: true, checks });
});
