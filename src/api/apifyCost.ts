/**
 * Real Apify cost tracking.
 *
 * The static per-platform constants in usage.ts understated actual spend by
 * ~6x. Measured 2026-08-07 against Apify's own billing API over 479 runs
 * totalling $22.76, versus $3.96 logged by kamai:
 *
 *   clockworks~tiktok-scraper        94 runs  $10.98   $0.1168/run  (logged ~$0.008 — 15x under)
 *   memo23~facebook-search-scraper  156 runs   $7.64   $0.0490/run  (logged ~$0.012 —  4x under)
 *   harvestapi~linkedin-post-search 171 runs   $3.93   $0.0230/run  (logged ~$0.013 — 1.8x under)
 *   apify~instagram-search-scraper   55 runs   $0.14   $0.0025/run
 *   trudax~reddit-scraper-lite        3 runs   $0.07   $0.0238/run
 *
 * Three causes, all fixed:
 *   1. `fetched` counted items that SURVIVED the freshness post-filter, but
 *      Apify bills every dataset item the actor produced. We deliberately
 *      over-fetch ~3x, so the billable count was systematically undercounted.
 *   2. The per-result constants were guesses from list prices and were simply
 *      too low, worst of all for TikTok.
 *   3. Actor health checks are real billed runs (94 TikTok runs vs 72 kamai
 *      calls — the difference is largely smoke tests) and were never logged.
 *
 * Rather than hand-tune constants that will drift again the next time a vendor
 * reprices, this module reads actual run costs back from Apify and feeds the
 * measured average into estimateUpstream(). Static values remain only as a
 * cold-start fallback.
 */

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';

/** Refresh cadence. Runs are cheap to list and costs move slowly. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

interface ActorCost {
  actorId: string;
  runs: number;
  totalUsd: number;
  avgUsd: number;
  updatedAt: string;
}

/** platform → measured cost, keyed by the actor kamai actually calls. */
const measured = new Map<string, ActorCost>();
/** "username~actor" → Apify's hash actId, so runs can be attributed. */
const actorIdCache = new Map<string, string>();
let lastRefresh = 0;

/** Resolve "username~actor-name" to Apify's internal actId. */
async function resolveActorId(actorSlug: string): Promise<string | null> {
  const cached = actorIdCache.get(actorSlug);
  if (cached) return cached;
  try {
    const r = await fetch(`${APIFY_BASE}/acts/${actorSlug}?token=${encodeURIComponent(APIFY_API_TOKEN)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const id = ((await r.json()) as any)?.data?.id;
    if (typeof id === 'string') {
      actorIdCache.set(actorSlug, id);
      return id;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Pull recent run costs from Apify and recompute per-actor averages.
 * `platformActors` maps kamai's platform key to the actor slug it calls.
 */
export async function refreshApifyCosts(platformActors: Record<string, string>): Promise<void> {
  if (!APIFY_API_TOKEN) return;
  try {
    const resp = await fetch(
      `${APIFY_BASE}/actor-runs?token=${encodeURIComponent(APIFY_API_TOKEN)}&limit=1000&desc=1`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) {
      console.warn(`[ApifyCost] runs list returned ${resp.status}`);
      return;
    }
    const items: any[] = ((await resp.json()) as any)?.data?.items ?? [];

    // actId → aggregate. Runs with no cost yet (still running) are skipped.
    const byActor = new Map<string, { runs: number; usd: number }>();
    for (const r of items) {
      const id = r?.actId;
      const usd = typeof r?.usageTotalUsd === 'number' ? r.usageTotalUsd : null;
      if (!id || usd === null) continue;
      const a = byActor.get(id) ?? { runs: 0, usd: 0 };
      a.runs++; a.usd += usd;
      byActor.set(id, a);
    }

    const now = new Date().toISOString();
    for (const [platform, slug] of Object.entries(platformActors)) {
      const id = await resolveActorId(slug);
      if (!id) continue;
      const agg = byActor.get(id);
      if (!agg || agg.runs === 0) continue;
      measured.set(platform, {
        actorId: id,
        runs: agg.runs,
        totalUsd: agg.usd,
        avgUsd: agg.usd / agg.runs,
        updatedAt: now,
      });
    }
    lastRefresh = Date.now();
    const summary = [...measured.entries()]
      .map(([p, c]) => `${p}=$${c.avgUsd.toFixed(4)}/run(${c.runs})`)
      .join(' ');
    console.log(`[ApifyCost] refreshed from ${items.length} runs — ${summary || 'no matching actors'}`);
  } catch (err: any) {
    console.warn(`[ApifyCost] refresh failed: ${err?.message}`);
  }
}

/** Measured average cost of one run for this platform, or null before first refresh. */
export function measuredCostPerRun(platform: string): number | null {
  return measured.get(platform)?.avgUsd ?? null;
}

/** Snapshot for /adm — real spend vs what kamai logged. */
export function apifyCostSnapshot(): {
  lastRefresh: string | null;
  actors: Array<{ platform: string; runs: number; totalUsd: number; avgUsd: number }>;
  totalUsd: number;
} {
  const actors = [...measured.entries()].map(([platform, c]) => ({
    platform, runs: c.runs, totalUsd: +c.totalUsd.toFixed(4), avgUsd: +c.avgUsd.toFixed(5),
  }));
  return {
    lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
    actors,
    totalUsd: +actors.reduce((n, a) => n + a.totalUsd, 0).toFixed(4),
  };
}

/** Start periodic refresh. First run is delayed so boot stays fast. */
export function startApifyCostScheduler(platformActors: Record<string, string>): void {
  if (!APIFY_API_TOKEN) return;
  setTimeout(() => void refreshApifyCosts(platformActors), 90_000).unref?.();
  setInterval(() => void refreshApifyCosts(platformActors), REFRESH_MS).unref?.();
}
