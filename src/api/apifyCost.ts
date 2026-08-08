/**
 * Real Apify cost tracking and reconciliation.
 *
 * Estimating upstream cost per REQUEST can never sum to an Apify bill, because
 * Apify charges per RUN and there are always more runs than kamai requests.
 * Measured 2026-08-08 for one billing cycle:
 *
 *   platform    apify runs   apify $     kamai requests   true $/request
 *   facebook       319       $17.312          286            $0.0605
 *   linkedin       334        $9.670          310            $0.0312
 *   tiktok          95       $10.985           72            $0.1526
 *   instagram       65        $0.230            1            $0.2300
 *                          --------
 *                            $38.268   vs $15.97 logged by kamai (58% under)
 *
 * The extra runs are actor health checks, circuit half-open probes, and
 * retries. Instagram is the extreme case: its actor is failing, so it gets
 * probed over and over and every failed run still bills, producing 65 runs for
 * a single successful request.
 *
 * So dividing real spend by RUNS and applying that to REQUESTS structurally
 * under-attributes. The correct coefficient is
 *
 *     real platform spend / kamai requests for that platform
 *
 * which absorbs probes, retries and health checks into the per-call price.
 * That is also the economically honest number: those runs are a cost of
 * offering the platform at all, and they should land on the callers using it.
 *
 * This module owns its own read/write handle to usage.db rather than importing
 * usage.ts, because usage.ts imports this module for estimateUpstream().
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceFor, PRICE_FLOORS } from '../payment/pricing.js';

/** Every Apify-backed platform is a social search, so its floor is the search floor. */
const SEARCH_FLOOR = PRICE_FLOORS.search;

const __dirname = dirname(fileURLToPath(import.meta.url));
const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';

/** Costs move slowly; listing runs is cheap but not free. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

const db = new Database(join(__dirname, '..', '..', 'usage.db'));
db.pragma('journal_mode = WAL');

const countStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM request_log
   WHERE source = 'apify' AND detail = ? AND created_at >= ?`,
);
const backfillStmt = db.prepare(
  // Rewrite both the cost and the tab: billable is derived from upstream, so
  // reconciling one without the other would leave the marked-up tab tracking a
  // stale estimate. For every Apify social platform the 2x markup clears the
  // $0.003 search floor, so billable is simply twice the reconciled cost.
  `UPDATE request_log SET upstream_usd = ?, billable_usd = ?
   WHERE source = 'apify' AND detail = ? AND created_at >= ?`,
);
const attributedStmt = db.prepare(
  `SELECT COALESCE(SUM(upstream_usd), 0) AS n FROM request_log
   WHERE source = 'apify' AND created_at >= ?`,
);

interface PlatformCost {
  actorId: string;
  runs: number;
  totalUsd: number;
  kamaiRequests: number;
  /** What one kamai request truly costs, overheads included. */
  costPerRequest: number;
  updatedAt: string;
}

const measured = new Map<string, PlatformCost>();
const actorIdCache = new Map<string, string>();
let cycleStart = '';
let cycleTotalUsd = 0;
let lastRefresh = 0;

async function resolveActorId(slug: string): Promise<string | null> {
  const hit = actorIdCache.get(slug);
  if (hit) return hit;
  try {
    const r = await fetch(`${APIFY_BASE}/acts/${slug}?token=${encodeURIComponent(APIFY_API_TOKEN)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const id = ((await r.json()) as any)?.data?.id;
    if (typeof id === 'string') {
      actorIdCache.set(slug, id);
      return id;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Pull real spend from Apify, divide by kamai's own request counts, and
 * backfill the cycle's rows so /adm reflects the actual bill rather than the
 * estimate that was current when each row was written.
 */
export async function refreshApifyCosts(platformActors: Record<string, string>): Promise<void> {
  if (!APIFY_API_TOKEN) return;
  try {
    const usageResp = await fetch(
      `${APIFY_BASE}/users/me/usage/monthly?token=${encodeURIComponent(APIFY_API_TOKEN)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!usageResp.ok) {
      console.warn(`[ApifyCost] usage HTTP ${usageResp.status}`);
      return;
    }
    const usage = ((await usageResp.json()) as any)?.data;
    cycleStart = usage?.usageCycle?.startAt?.slice(0, 10) ?? '';
    if (!cycleStart) return;
    // AUTHORITATIVE billed figure: the pay-per-event line after any volume
    // discount, i.e. exactly what appears on the invoice. Falls back to the
    // account total. Using this as the anchor is what keeps our number equal to
    // the real bill regardless of how the per-run data is capped or discounted.
    const ppe = usage?.monthlyServiceUsage?.PAID_ACTORS_PER_EVENT ?? {};
    cycleTotalUsd =
      ppe.amountAfterVolumeDiscountUsd ??
      ppe.baseAmountUsd ??
      usage?.totalUsageCreditsUsdAfterVolumeDiscount ??
      0;

    // Paginate ALL runs in the cycle. The old code took only the most recent
    // 1000, so once run count crossed 1000 the oldest runs silently dropped out
    // of the per-actor totals (105 runs / $3.16 missing when this was found).
    const byActor = new Map<string, { runs: number; usd: number }>();
    let offset = 0;
    const PAGE = 1000;
    const SAFETY_CAP = 20_000; // ~20 pages; a backstop, not a real limit
    let reachedCycleStart = false;
    while (offset < SAFETY_CAP && !reachedCycleStart) {
      const resp = await fetch(
        `${APIFY_BASE}/actor-runs?token=${encodeURIComponent(APIFY_API_TOKEN)}&limit=${PAGE}&offset=${offset}&desc=1`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!resp.ok) break;
      const items: any[] = ((await resp.json()) as any)?.data?.items ?? [];
      if (!items.length) break;
      for (const r of items) {
        // Runs come newest-first, so the first pre-cycle run means every run
        // after it is older too — stop paging.
        if (typeof r?.startedAt === 'string' && r.startedAt.slice(0, 10) < cycleStart) {
          reachedCycleStart = true;
          continue;
        }
        const id = r?.actId;
        const usd = typeof r?.usageTotalUsd === 'number' ? r.usageTotalUsd : null;
        if (!id || usd === null) continue;
        const a = byActor.get(id) ?? { runs: 0, usd: 0 };
        a.runs++; a.usd += usd;
        byActor.set(id, a);
      }
      if (items.length < PAGE) break;
      offset += PAGE;
    }

    // Scale per-actor run costs so they sum to the authoritative billed total.
    // Run-level usageTotalUsd tracks the invoice proportions closely (verified
    // within ~1%), but this last step guarantees the parts equal the whole even
    // if a volume discount or an un-paginated tail leaves a residual.
    const rawTotal = [...byActor.values()].reduce((n, a) => n + a.usd, 0);
    const scale = rawTotal > 0 && cycleTotalUsd > 0 ? cycleTotalUsd / rawTotal : 1;

    const now = new Date().toISOString();
    for (const [platform, slug] of Object.entries(platformActors)) {
      const id = await resolveActorId(slug);
      if (!id) continue;
      const agg = byActor.get(id);
      if (!agg || agg.runs === 0) continue;

      const scaledUsd = agg.usd * scale;
      const kamaiRequests = (countStmt.get(platform, cycleStart) as { n: number }).n;
      // With no kamai requests yet, fall back to per-run so the figure is at
      // least the right order of magnitude rather than dividing by zero.
      const costPerRequest = kamaiRequests > 0 ? scaledUsd / kamaiRequests : scaledUsd / agg.runs;

      measured.set(platform, {
        actorId: id, runs: agg.runs, totalUsd: scaledUsd, kamaiRequests, costPerRequest, updatedAt: now,
      });

      // Rewrite this cycle's rows to the reconciled figure. Historical rows
      // were written with whatever estimate was live at the time, so without
      // this the dashboard stays permanently wrong for past traffic.
      if (kamaiRequests > 0) {
        backfillStmt.run(costPerRequest, priceFor(SEARCH_FLOOR, costPerRequest), platform, cycleStart);
      }
    }

    lastRefresh = Date.now();
    const attributed = (attributedStmt.get(cycleStart) as { n: number }).n;
    const summary = [...measured.entries()]
      .map(([p, c]) => `${p}=$${c.costPerRequest.toFixed(4)}/req`)
      .join(' ');
    console.log(
      `[ApifyCost] cycle ${cycleStart}: apify billed $${cycleTotalUsd.toFixed(2)} ` +
        `(${byActor.size} actors, scale ${scale.toFixed(3)}), ` +
        `kamai attributed $${attributed.toFixed(2)} — ${summary}`,
    );
  } catch (err: any) {
    console.warn(`[ApifyCost] refresh failed: ${err?.message}`);
  }
}

/** True cost of one kamai request on this platform, or null before first refresh. */
export function measuredCostPerRun(platform: string): number | null {
  return measured.get(platform)?.costPerRequest ?? null;
}

/** Reconciliation view: what Apify billed vs what kamai attributed. */
export function apifyCostSnapshot(): {
  cycleStart: string | null;
  apifyBilledUsd: number;
  kamaiAttributedUsd: number;
  unattributedUsd: number;
  lastRefresh: string | null;
  platforms: Array<{
    platform: string; apifyRuns: number; apifySpendUsd: number;
    kamaiRequests: number; costPerRequestUsd: number; overheadRuns: number;
  }>;
} {
  const attributed = cycleStart ? (attributedStmt.get(cycleStart) as { n: number }).n : 0;
  return {
    cycleStart: cycleStart || null,
    apifyBilledUsd: +cycleTotalUsd.toFixed(4),
    kamaiAttributedUsd: +attributed.toFixed(4),
    unattributedUsd: +(cycleTotalUsd - attributed).toFixed(4),
    lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
    platforms: [...measured.entries()].map(([platform, c]) => ({
      platform,
      apifyRuns: c.runs,
      apifySpendUsd: +c.totalUsd.toFixed(4),
      kamaiRequests: c.kamaiRequests,
      costPerRequestUsd: +c.costPerRequest.toFixed(5),
      // Runs kamai did not initiate directly: health checks, probes, retries.
      overheadRuns: Math.max(0, c.runs - c.kamaiRequests),
    })),
  };
}

export function startApifyCostScheduler(platformActors: Record<string, string>): void {
  if (!APIFY_API_TOKEN) return;
  setTimeout(() => void refreshApifyCosts(platformActors), 90_000).unref?.();
  setInterval(() => void refreshApifyCosts(platformActors), REFRESH_MS).unref?.();
}

export function closeApifyCostDb(): void {
  db.close();
}
