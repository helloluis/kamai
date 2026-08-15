/**
 * Cost-plus pricing.
 *
 * Every call is priced at a 100% markup on what it actually costs us upstream,
 * subject to a per-endpoint floor:
 *
 *     price = max(floor, MARKUP x measured upstream cost)
 *
 * The floor exists because our cheapest calls have almost no *upstream* cost —
 * a browse or an embed screenshot is VPS compute, $0.0002-$0.0005 — so a pure
 * 2x would price them at a tenth of a cent and stop covering the box they run
 * on. Their real cost is infrastructure, not per-call, and the floor is how
 * that gets recovered.
 *
 * The markup half is what fixes the losses. Before this, /search/social was a
 * flat $0.003 against measured upstream of $0.031 (LinkedIn) to $0.232
 * (Instagram) — every social search lost money, up to 77x. Because the cost
 * depends on which provider actually answered, the price can only be settled
 * AFTER the request, from res.locals.usage.upstream.
 */

/** 100% markup — price is twice cost. */
export const MARKUP = 2.0;

/**
 * Per-endpoint floors, matching the historical flat prices. A request never
 * costs less than this, however cheap it was to serve.
 */
export const PRICE_FLOORS = {
  browse: 0.009,
  browseActions: 0.013,
  search: 0.003,
  screenshot: 0.015,
  brochure: 0.05,
  // Image generation always has real upstream ($0.03-$0.19/image), so the 2x
  // markup dominates; the floor only catches a provider mispricing to ~zero.
  image: 0.02,
} as const;

/** Settle the price of one request. `upstreamUsd` is the measured cost. */
export function priceFor(floorUsd: number, upstreamUsd: number | undefined | null): number {
  const marked = MARKUP * (typeof upstreamUsd === 'number' && upstreamUsd > 0 ? upstreamUsd : 0);
  // Round to a tenth of a cent — enough resolution for a $0.0002 embed
  // capture without emitting float noise into the ledger.
  return Math.max(floorUsd, Math.round(marked * 10_000) / 10_000);
}

/**
 * Floor for a logged endpoint path, used to price historical rows and any
 * caller whose route did not set res.locals.priceFloor. Free endpoints
 * (memories, health, image retrieval, spend) return 0 and stay unbilled.
 */
export function floorForEndpoint(endpoint: string): number {
  const e = endpoint.replace(/^\/api\/v1/, '');
  if (e.startsWith('/browse/memories')) return 0;
  if (e.startsWith('/browse')) return PRICE_FLOORS.browse;
  if (e.startsWith('/search/health')) return 0;
  if (e.startsWith('/search')) return PRICE_FLOORS.search;
  // Only the capture is billable; :id metadata and image reads are free.
  if (e === '/screenshot') return PRICE_FLOORS.screenshot;
  if (e.startsWith('/screenshot')) return 0;
  if (e.startsWith('/brochure/templates') || /\/brochure\/[^/]+\/download/.test(e)) return 0;
  if (e.startsWith('/brochure')) return PRICE_FLOORS.brochure;
  // Only generation is billable; :id/file reads are free.
  if (e === '/image/generate') return PRICE_FLOORS.image;
  if (e.startsWith('/image')) return 0;
  return 0;
}

/**
 * Published rates, derived from measured upstream so the price list cannot
 * silently drift from what we actually pay. `upstream` is a representative
 * measured figure; the live price is always recomputed per request.
 */
export interface PublishedRate {
  endpoint: string;
  variant?: string;
  upstreamUsd: number;
  priceUsd: number;
  note?: string;
}

export function publishedRates(
  measuredUpstream: (platform: string) => number | null,
): PublishedRate[] {
  const social = (platform: string, fallback: number): PublishedRate => {
    const up = measuredUpstream(platform) ?? fallback;
    return {
      endpoint: '/api/v1/search/social',
      variant: platform,
      upstreamUsd: +up.toFixed(5),
      priceUsd: priceFor(PRICE_FLOORS.search, up),
      note: 'priced per platform — upstream varies ~7x between them',
    };
  };
  return [
    { endpoint: '/api/v1/browse', upstreamUsd: 0.0005, priceUsd: PRICE_FLOORS.browse, note: 'floor — self-hosted, no per-call upstream' },
    { endpoint: '/api/v1/browse', variant: 'with actions', upstreamUsd: 0.0005, priceUsd: PRICE_FLOORS.browseActions, note: 'floor' },
    { endpoint: '/api/v1/search/web', upstreamUsd: 0.001, priceUsd: priceFor(PRICE_FLOORS.search, 0.001), note: 'serper; brave fallback costs more' },
    { endpoint: '/api/v1/search/news', upstreamUsd: 0.001, priceUsd: priceFor(PRICE_FLOORS.search, 0.001) },
    { endpoint: '/api/v1/search/image', upstreamUsd: 0.001, priceUsd: priceFor(PRICE_FLOORS.search, 0.001) },
    social('linkedin', 0.0312),
    social('facebook', 0.0606),
    social('tiktok', 0.1526),
    social('instagram', 0.2323),
    { endpoint: '/api/v1/image/generate', variant: 'gpt-image-2 medium', upstreamUsd: 0.041, priceUsd: priceFor(PRICE_FLOORS.image, 0.041) },
    { endpoint: '/api/v1/image/generate', variant: 'ideogram-v4 DEFAULT', upstreamUsd: 0.06, priceUsd: priceFor(PRICE_FLOORS.image, 0.06) },
    { endpoint: '/api/v1/image/generate', variant: 'qwen-image-3.0-pro', upstreamUsd: 0.04, priceUsd: priceFor(PRICE_FLOORS.image, 0.04), note: 'priced per model — upstream varies by provider/quality' },
    { endpoint: '/api/v1/screenshot', upstreamUsd: 0.0002, priceUsd: PRICE_FLOORS.screenshot, note: 'floor — embed/page render is self-hosted' },
    { endpoint: '/api/v1/screenshot', variant: 'reddit', upstreamUsd: 0.0238, priceUsd: priceFor(PRICE_FLOORS.screenshot, 0.0238), note: 'via Apify' },
    { endpoint: '/api/v1/brochure/generate', upstreamUsd: 0.0005, priceUsd: PRICE_FLOORS.brochure, note: 'floor' },
  ];
}
