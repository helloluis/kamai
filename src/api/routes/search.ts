/**
 * POST /api/v1/search/web   — web search (LLM-optimised when Brave handles it)
 * POST /api/v1/search/image — image search
 * POST /api/v1/search/social — social platform search (reddit, linkedin, tiktok,
 *                              youtube, threads, pinterest, instagram, facebook
 *                              posts, facebook events)
 *
 * Provider order: Serper (Google) is PRIMARY for web/image; Brave is the
 * fallback when Serper errors, times out, or isn't configured. Brave /web
 * itself tries the LLM Context API first, then the standard Web Search API.
 * One paid subscription per provider lives on kamai so callers never manage
 * keys.
 *
 * Social search is a per-platform chain (first success wins): SocialCrawl →
 * Apify actor (registry + 72h health checks in src/api/apifySearch.ts) →
 * Brave site:-scoped search. instagram is Apify-only; facebook posts are
 * Apify-first; tiktok/linkedin use Apify as fallback.
 *
 * All endpoints accept freshness: pd|pw|pm|py or durations ("90min", "2h",
 * "3d", "1w"). Social chains narrow natively where the provider allows, then
 * enforce the exact window with a publishedAt post-filter.
 *
 * Auth + billing: same `creditPayment(PRICE_SEARCH)` middleware as /browse.
 */
import { Router } from 'express';
import {
  APIFY_SEARCH,
  APIFY_API_TOKEN,
  apifyActorSearch,
  shouldAttemptActor,
  recordActorOutcome,
  parseFreshness,
  FRESHNESS_MS,
} from '../apifySearch.js';
import { estimateUpstream } from '../usage.js';
import { priceFor, PRICE_FLOORS } from '../../payment/pricing.js';
import { normalizePublishedAt, sortByRecency, isNewsSource } from '../searchNormalize.js';

const router = Router();

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const SERPER_BASE = 'https://google.serper.dev';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_BASE = 'https://api.search.brave.com/res/v1';

// ─── Serper response types ───

interface SerperWebResponse {
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
  answerBox?: { answer?: string; snippet?: string; title?: string };
  knowledgeGraph?: { title?: string; type?: string; description?: string; attributes?: Record<string, string> };
}

interface SerperNewsResponse {
  news?: Array<{ title?: string; link?: string; snippet?: string; date?: string; source?: string; imageUrl?: string }>;
}

interface SerperImageResponse {
  images?: Array<{
    title?: string;
    link?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
    source?: string;
    domain?: string;
  }>;
}

// ─── Brave response types (we forward verbatim, but type the key fields) ───

interface BraveLLMContextResponse {
  grounding: {
    generic?: Array<{
      url: string;
      title?: string;
      snippets?: Array<string | { text?: string; relevance_score?: number }>;
    }>;
  };
  /** Map of URL → source metadata (NOT an array). */
  sources?: Record<string, { title?: string; hostname?: string; age?: string[] | string; snippet?: string }>;
}

interface BraveWebSearchResponse {
  query?: { original: string };
  web?: {
    results: Array<{ title: string; url: string; description: string; age?: string; extra_snippets?: string[] }>;
  };
  news?: {
    results: Array<{ title: string; url: string; description: string; age?: string }>;
  };
}

interface BraveNewsSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    description?: string;
    age?: string;
    /** ISO 8601 when Brave has an exact timestamp — preferred over the fuzzy `age`. */
    page_age?: string;
    meta_url?: { hostname?: string };
  }>;
}

interface BraveImageSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    properties?: { url?: string; placeholder?: string };
    thumbnail?: { src?: string; original?: string; width?: number; height?: number };
    source?: string;
  }>;
}

// ─── Helpers ───

function callerIp(req: any): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'anonymous';
}

/** Accumulate provider-failure reasons — surfaced in the /adm dashboard's fallback-reason column. */
function addUsageNote(res: any, note: string): void {
  res.locals.usageNote = res.locals.usageNote ? `${res.locals.usageNote}; ${note}` : note;
}

async function braveFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY,
    },
  });
}

/** Serper call with a hard timeout so an outage fails fast into the Brave fallback. */
async function serperFetch(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SERPER_BASE}${path}`, {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Uniform news item — same shape whichever provider answered. */
interface NewsResult {
  title: string;
  url: string;
  description: string;
  /** Publisher name or hostname. */
  source: string;
  /** ISO 8601, or null when the provider gave no usable timestamp. */
  publishedAt: string | null;
  /** The provider's raw age string, kept for debugging. */
  age?: string;
}

/** Brave standard web search, factored out so /web and /social share it as a fallback. */
async function braveWebSearch(
  queryStr: string,
  count: number,
  freshness?: unknown,
  country?: unknown,
): Promise<
  | {
      ok: true;
      results: Array<{ title: string; url: string; description: string; age?: string }>;
      /** The news bucket on its own, unprefixed — /news uses this as its last-resort tier. */
      news: Array<{ title: string; url: string; description: string; age?: string }>;
    }
  | { ok: false; status: number; error: string }
> {
  try {
    const webParams = new URLSearchParams({
      q: queryStr,
      count: String(count),
      text_decorations: 'false',
      search_lang: 'en',
    });
    if (freshness === 'pd' || freshness === 'pw' || freshness === 'pm' || freshness === 'py') {
      webParams.set('freshness', freshness);
    }
    if (typeof country === 'string' && country) webParams.set('country', country);

    const webResp = await braveFetch(`${BRAVE_BASE}/web/search?${webParams.toString()}`);
    if (!webResp.ok) {
      const txt = await webResp.text();
      return { ok: false, status: webResp.status >= 500 ? 502 : webResp.status, error: `Brave web search returned ${webResp.status}: ${txt.slice(0, 200)}` };
    }
    const data = (await webResp.json()) as BraveWebSearchResponse;
    const results: Array<{ title: string; url: string; description: string; age?: string }> = [];
    const news: Array<{ title: string; url: string; description: string; age?: string }> = [];
    for (const r of data.web?.results || []) {
      if (r?.url) results.push({ title: r.title || '', url: r.url, description: r.description || '', age: r.age });
    }
    for (const r of data.news?.results || []) {
      if (!r?.url) continue;
      news.push({ title: r.title || '', url: r.url, description: r.description || '', age: r.age });
      results.push({ title: `[News] ${r.title || ''}`, url: r.url, description: r.description || '', age: r.age });
    }
    return { ok: true, results, news };
  } catch (err: any) {
    return { ok: false, status: 500, error: err.message || 'Search failed' };
  }
}

// ─── Social search ───
//
// Provider chain per platform (first success wins):
//   1. SocialCrawl (where a path exists below)
//   2. Apify actor (registry in src/api/apifySearch.ts; skipped when the
//      72h health check has marked the actor degraded)
//   3. Brave site:-scoped web search (where the platform indexes well)

const SOCIALCRAWL_API_KEY = process.env.SOCIALCRAWL_API_KEY || '';
const SOCIALCRAWL_BASE = 'https://www.socialcrawl.dev';

/** Platform → SocialCrawl search endpoint + param mapping. cursorParam is how each endpoint pages. */
const SOCIAL_PLATFORMS: Record<string, { path: string; sortParam?: string; timeframeParam?: string; timeframeMap?: Record<string, string>; cursorParam?: string }> = {
  reddit:    { path: '/v1/reddit/search',         sortParam: 'sort',    timeframeParam: 'timeframe',   cursorParam: 'after' },
  linkedin:  { path: '/v1/linkedin/search/posts', sortParam: 'sort_by', timeframeParam: 'date_posted', cursorParam: 'page',
               // SocialCrawl linkedin only accepts past_24h|past_week|past_month
               timeframeMap: { day: 'past_24h', week: 'past_week', month: 'past_month' } },
  tiktok:    { path: '/v1/tiktok/search',         cursorParam: 'cursor' },
  youtube:   { path: '/v1/youtube/search',        cursorParam: 'cursor' },
  threads:   { path: '/v1/threads/search',        cursorParam: 'cursor' },
  pinterest: { path: '/v1/pinterest/search',      cursorParam: 'cursor' },
  'facebook-events': { path: '/v1/facebook/events/search' },
};

/** Platforms worth a Brave site:-scoped last resort (Google indexes them decently). */
const PLATFORM_SITES: Record<string, string> = {
  reddit: 'reddit.com',
  linkedin: 'linkedin.com',
  facebook: 'facebook.com',
  'facebook-events': 'facebook.com',
  instagram: 'instagram.com',
  x: 'x.com',
};

/**
 * Caller-facing aliases. The platform is called X now but half the world still
 * says Twitter, and agents will send either — accepting both is cheaper than
 * fielding "unknown platform" errors. Canonical key is `x`, which is what the
 * actor registry, the cost table and the /adm breakdown all use.
 */
const PLATFORM_ALIASES: Record<string, string> = {
  twitter: 'x',
  'x.com': 'x',
  'twitter.com': 'x',
};

/** Supported platforms = SocialCrawl-backed ∪ Apify-backed, plus aliases. */
const SUPPORTED_PLATFORMS = [...new Set([...Object.keys(SOCIAL_PLATFORMS), ...Object.keys(APIFY_SEARCH)])];
/** What we advertise in the error message — aliases included so they're discoverable. */
const ADVERTISED_PLATFORMS = [...SUPPORTED_PLATFORMS, ...Object.keys(PLATFORM_ALIASES)];

async function socialcrawlFetch(path: string, params: URLSearchParams): Promise<Response> {
  return fetch(`${SOCIALCRAWL_BASE}${path}?${params.toString()}`, {
    headers: { 'x-api-key': SOCIALCRAWL_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000), // social endpoints can be slow on cache miss
  });
}

// ─── /web — LLM-optimised search, falls back to legacy Web Search on error ───

router.post('/web', async (req, res) => {
  if (!SERPER_API_KEY && !BRAVE_API_KEY) {
    res.status(503).json({ ok: false, error: 'Search not configured on kamai server (SERPER_API_KEY and BRAVE_API_KEY missing)' });
    return;
  }

  const { q, query, count, freshness, country, maxTokens } = req.body as Record<string, unknown>;
  const queryStr = String(q || query || '').trim();
  if (!queryStr) {
    res.status(400).json({ ok: false, error: 'Missing "q" field' });
    return;
  }

  const ts = new Date().toISOString();
  const ip = callerIp(req);
  const t0 = Date.now();
  const requestedCount = Math.min(Math.max(Number(count) || 5, 1), 20);

  // freshness: pd|pw|pm|py or a duration ("90min", "2h", "3d", "1w") — snapped
  // to the smallest containing preset for the providers' native filters.
  const freshnessMsW = parseFreshness(freshness);
  const webFreshness = freshnessMsW === null ? undefined
    : freshnessMsW <= FRESHNESS_MS.pd ? 'pd'
    : freshnessMsW <= FRESHNESS_MS.pw ? 'pw'
    : freshnessMsW <= FRESHNESS_MS.pm ? 'pm' : 'py';

  // Try LLM Context API first
  const llmParams = new URLSearchParams({
    q: queryStr,
    count: String(Math.max(requestedCount * 2, 10)),
    maximum_number_of_urls: String(requestedCount),
    maximum_number_of_tokens: String(Number(maxTokens) || 4096),
    maximum_number_of_snippets_per_url: '5',
    context_threshold_mode: 'balanced',
    search_lang: 'en',
  });
  if (typeof country === 'string') llmParams.set('country', country);

  console.log(`[Search/web] ${ts} | ${ip} | REQ "${queryStr}"`);

  // ── Serper (primary) ──
  if (SERPER_API_KEY) {
    try {
      const body: Record<string, unknown> = { q: queryStr, num: requestedCount };
      if (typeof country === 'string' && country && country.toUpperCase() !== 'ALL') {
        body.gl = country.toLowerCase();
      }
      const freshnessMap: Record<string, string> = { pd: 'qdr:d', pw: 'qdr:w', pm: 'qdr:m', py: 'qdr:y' };
      if (webFreshness) {
        body.tbs = freshnessMap[webFreshness];
      }

      const serperResp = await serperFetch('/search', body);
      if (serperResp.ok) {
        const data = (await serperResp.json()) as SerperWebResponse;
        const results = (Array.isArray(data?.organic) ? data.organic : [])
          .filter((r) => r?.link)
          .map((r) => ({
            title: r.title || '',
            url: r.link as string,
            description: r.snippet || '',
            age: typeof r.date === 'string' ? r.date : undefined,
          }));
        const elapsed = Date.now() - t0;
        console.log(`[Search/web] ${ts} | ${ip} | OK ${results.length} results | ${elapsed}ms (serper)`);
        const upstream = estimateUpstream('serper');
        res.locals.usage = { source: 'serper', results: Math.min(results.length, requestedCount), upstream, detail: queryStr };
        res.json({
          ok: true,
          source: 'serper',
          query: queryStr,
          results: results.slice(0, requestedCount),
          // Serper extras — direct answers and entity cards are exactly what
          // LLM callers want from a search; previously dropped on the floor.
          ...(data.answerBox ? { answerBox: data.answerBox } : {}),
          ...(data.knowledgeGraph ? { knowledgeGraph: data.knowledgeGraph } : {}),
          priceUsd: priceFor(PRICE_FLOORS.search, upstream),
        });
        return;
      }
      const errBody = await serperResp.text();
      console.warn(`[Search/web] ${ts} | ${ip} | serper error ${serperResp.status}: ${errBody.slice(0, 200)} — falling back to Brave`);
      addUsageNote(res, `serper ${serperResp.status}`);
    } catch (err: any) {
      console.warn(`[Search/web] ${ts} | ${ip} | serper exception: ${err.message} — falling back to Brave`);
      addUsageNote(res, `serper: ${err.message}`);
    }
  }

  // ── Brave (fallback) ──
  if (!BRAVE_API_KEY) {
    res.status(502).json({ ok: false, error: 'Serper search failed and no Brave fallback is configured' });
    return;
  }

  try {
    const llmResp = await braveFetch(`${BRAVE_BASE}/llm/context?${llmParams.toString()}`);

    if (llmResp.ok) {
      const data = (await llmResp.json()) as BraveLLMContextResponse;
      // Real API shape: grounding.generic[].snippets are plain strings;
      // sources is a map keyed by URL (not an array).
      const generic = Array.isArray(data?.grounding?.generic) ? data.grounding.generic : [];
      const sources = data.sources && typeof data.sources === 'object' ? data.sources : {};
      const results: Array<{
        title: string;
        url: string;
        description: string;
        content?: string;
        age?: string;
      }> = [];
      for (const item of generic) {
        if (!item?.url) continue;
        const meta = sources[item.url];
        const texts = (Array.isArray(item.snippets) ? item.snippets : [])
          .map((s) => (typeof s === 'string' ? s : s?.text || ''))
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        const ageRaw = Array.isArray(meta?.age) ? meta?.age[0] : meta?.age;
        results.push({
          title: item.title || meta?.title || new URL(item.url).hostname,
          url: item.url,
          description: texts[0]?.slice(0, 300) || meta?.snippet || '',
          content: texts.length > 0 ? texts.join('\n\n') : undefined,
          age: typeof ageRaw === 'string' ? ageRaw : undefined,
        });
      }
      const elapsed = Date.now() - t0;
      console.log(`[Search/web] ${ts} | ${ip} | OK ${results.length} results | ${elapsed}ms (llm_context)`);
      res.locals.usage = { source: 'brave', results: Math.min(results.length, requestedCount), upstream: estimateUpstream('brave'), detail: queryStr };
      res.json({ ok: true, source: 'llm_context', query: queryStr, results: results.slice(0, requestedCount), priceUsd: priceFor(PRICE_FLOORS.search, estimateUpstream('brave')) });
      return;
    }

    // 5xx or rate limited → fall through to legacy web search
    const errBody = await llmResp.text();
    console.warn(`[Search/web] llm_context error ${llmResp.status}: ${errBody.slice(0, 200)} — falling back to web search`);
    addUsageNote(res, `llm_context ${llmResp.status}`);
  } catch (err: any) {
    console.warn(`[Search/web] llm_context exception: ${err.message} — falling back`);
    addUsageNote(res, `llm_context: ${err.message}`);
  }

  // Legacy fallback
  const legacy = await braveWebSearch(queryStr, requestedCount, webFreshness, country);
  const elapsed = Date.now() - t0;
  if (legacy.ok) {
    console.log(`[Search/web] ${ts} | ${ip} | OK ${legacy.results.length} results | ${elapsed}ms (web fallback)`);
    res.locals.usage = { source: 'brave', results: Math.min(legacy.results.length, requestedCount), upstream: estimateUpstream('brave'), detail: queryStr };
    res.json({ ok: true, source: 'web', query: queryStr, results: legacy.results.slice(0, requestedCount), priceUsd: priceFor(PRICE_FLOORS.search, estimateUpstream('brave')) });
  } else {
    console.error(`[Search/web] ${ts} | ${ip} | FAIL ${legacy.error.slice(0, 80)} | ${elapsed}ms`);
    res.status(legacy.status).json({ ok: false, error: legacy.error });
  }
});

// ─── /news — Serper News → Brave News → Brave web news bucket ───
//
// Split out from /web because a general web index is the wrong corpus for
// "what happened recently": it ranks evergreen pages above reporting, and its
// freshness filter is advisory. This route queries news indexes directly and
// enforces the requested window exactly, the way /social does.

router.post('/news', async (req, res) => {
  if (!SERPER_API_KEY && !BRAVE_API_KEY) {
    res.status(503).json({ ok: false, error: 'Search not configured on kamai server (SERPER_API_KEY and BRAVE_API_KEY missing)' });
    return;
  }

  const { q, query, count, freshness, country, sort, filterSources, cursor } = req.body as Record<string, unknown>;
  const queryStr = String(q || query || '').trim();
  if (!queryStr) {
    res.status(400).json({ ok: false, error: 'Missing "q" field' });
    return;
  }

  // Pagination cursor = the Serper Google-News page to resume from, query-bound
  // (reuses the same opaque, tamper-checked codec as /social).
  let startPage = 1;
  if (typeof cursor === 'string' && cursor) {
    const dec = decodeApifyCursor(cursor, 'news', queryStr);
    if (dec === null) {
      res.status(400).json({ ok: false, error: 'Invalid or mismatched cursor — pass the nextCursor from a prior response for the same query.' });
      return;
    }
    startPage = Math.max(1, dec);
  }

  const freshnessMs = parseFreshness(freshness) ?? undefined;
  if (freshness !== undefined && freshnessMs === undefined) {
    res.status(400).json({ ok: false, error: 'Invalid "freshness" — use pd|pw|pm|py or a duration like "90min", "2h", "3d", "1w"' });
    return;
  }
  // Recency is the default ranking. Provider relevance ordering floats
  // evergreen explainers and hub pages above the reporting a news query is
  // actually after; `sort: "relevance"` opts back into provider order.
  const sortBy = sort === 'relevance' ? 'relevance' : 'date';
  // Source filtering is on by default — see isNewsSource for what it drops.
  const useSourceFilter = filterSources !== false;

  // Cap raised 20 -> 50 per page. Serper's Google News returns a FIXED 10
  // items per page regardless of `num`, so filling a larger count (and
  // surviving the freshness + source filters) means walking multiple Serper
  // pages — see the loop below. Deeper still: paginate with the cursor.
  const requestedCount = Math.min(Math.max(Number(count) || 10, 1), 50);
  // The Brave fallback tiers DO honor a count, so over-fetch there to survive
  // the filters. (Serper ignores it and is paged instead.)
  const fetchCount = Math.min(requestedCount * 3, 50);

  const ts = new Date().toISOString();
  const ip = callerIp(req);
  const t0 = Date.now();
  const now = Date.now();
  console.log(`[Search/news] ${ts} | ${ip} | REQ "${queryStr}"${freshnessMs ? ` fresh<${Math.round(freshnessMs / 60000)}min` : ''}`);

  // Snap the window to each provider's native filter vocabulary. These are
  // coarser than the request (Google has no "90 minutes"), so they only narrow
  // the candidate set — `withinWindow` below is what actually enforces it.
  const serperTbs = !freshnessMs ? undefined
    : freshnessMs <= 3_600_000 ? 'qdr:h'
    : freshnessMs <= FRESHNESS_MS.pd ? 'qdr:d'
    : freshnessMs <= FRESHNESS_MS.pw ? 'qdr:w'
    : freshnessMs <= FRESHNESS_MS.pm ? 'qdr:m' : 'qdr:y';
  const braveFreshness = !freshnessMs ? undefined
    : freshnessMs <= FRESHNESS_MS.pd ? 'pd'
    : freshnessMs <= FRESHNESS_MS.pw ? 'pw'
    : freshnessMs <= FRESHNESS_MS.pm ? 'pm' : 'py';

  /**
   * Exact-window enforcement. An item whose timestamp we can't resolve cannot
   * prove it belongs in the window, so it's dropped rather than passed through
   * — a stale item in a "last 2 hours" feed is worse than a missing one.
   */
  const withinWindow = (r: NewsResult): boolean => {
    if (!freshnessMs) return true;
    if (!r.publishedAt) return false;
    const t = Date.parse(r.publishedAt);
    return !Number.isNaN(t) && t >= now - freshnessMs;
  };

  let droppedSource = 0;
  let droppedWindow = 0;

  /**
   * Filter, then rank. Source filtering runs first so the "stale" count
   * reflects real outlets rather than app-store pages that were never news.
   */
  const finalize = (items: NewsResult[]): NewsResult[] => {
    let kept = items;
    if (useSourceFilter) {
      const before = kept.length;
      kept = kept.filter((r) => isNewsSource(r.url));
      droppedSource = before - kept.length;
    }
    const beforeWindow = kept.length;
    kept = kept.filter(withinWindow);
    droppedWindow = beforeWindow - kept.length;
    if (sortBy === 'date') sortByRecency(kept);
    return kept.slice(0, requestedCount);
  };

  /**
   * Finalize, log, and respond. `tier` doubles as the response `source` so
   * callers can tell which index answered.
   */
  const sendNews = (tier: string, usageSource: 'serper' | 'brave', items: NewsResult[]): void => {
    const results = finalize(items);
    const elapsed = Date.now() - t0;
    const drops = [
      droppedSource ? `${droppedSource} non-news` : '',
      droppedWindow ? `${droppedWindow} stale` : '',
    ].filter(Boolean).join(', ');
    console.log(
      `[Search/news] ${ts} | ${ip} | OK ${results.length}/${items.length} results | ${elapsed}ms (${tier})` +
        (drops ? ` | dropped ${drops}` : ''),
    );
    // Record filtering on the /adm dashboard. An empty result set from a
    // healthy provider is a filter outcome, not an outage — without this note
    // the two are indistinguishable after the fact.
    if (drops) addUsageNote(res, `dropped ${drops}`);
    res.locals.usage = {
      source: usageSource,
      results: results.length,
      upstream: estimateUpstream(usageSource),
      detail: queryStr,
    };
    res.json({ ok: true, source: tier, query: queryStr, results });
  };

  // ── 1. Serper News (primary — Google News index), paged ──
  //
  // Serper returns a fixed 10 news items per page, so we walk pages until we've
  // collected `requestedCount` results that survive the filters, or hit a
  // per-request page budget, or Google runs out. Each page is one Serper
  // credit; the budget bounds cost per request while the cursor lets a caller
  // go arbitrarily deep across requests.
  if (SERPER_API_KEY) {
    const MAX_PAGES_PER_REQUEST = 10; // up to ~100 candidates / ~$0.01 per call
    const kept: NewsResult[] = [];
    let page = startPage;
    let rawSeen = 0;
    let serperExhausted = false;
    let firstPageFailed = false;

    try {
      for (; page < startPage + MAX_PAGES_PER_REQUEST && kept.length < requestedCount; page++) {
        const body: Record<string, unknown> = { q: queryStr, page };
        if (typeof country === 'string' && country && country.toUpperCase() !== 'ALL') {
          body.gl = country.toLowerCase();
        }
        if (serperTbs) body.tbs = serperTbs;

        const serperResp = await serperFetch('/news', body);
        if (!serperResp.ok) {
          if (page === startPage) {
            firstPageFailed = true;
            const errBody = await serperResp.text();
            console.warn(`[Search/news] ${ts} | ${ip} | serper error ${serperResp.status}: ${errBody.slice(0, 200)} — falling back to Brave`);
            addUsageNote(res, `serper ${serperResp.status}`);
          }
          serperExhausted = true;
          break;
        }
        const data = (await serperResp.json()) as SerperNewsResponse;
        const raw = (Array.isArray(data?.news) ? data.news : []).filter((r) => r?.link);
        rawSeen += raw.length;
        if (raw.length === 0) { serperExhausted = true; break; }

        for (const r of raw) {
          const item: NewsResult = {
            title: r.title || '',
            url: r.link as string,
            description: r.snippet || '',
            source: r.source || new URL(r.link as string).hostname,
            publishedAt: normalizePublishedAt(r.date, now),
            age: typeof r.date === 'string' ? r.date : undefined,
          };
          if (useSourceFilter && !isNewsSource(item.url)) { droppedSource++; continue; }
          if (!withinWindow(item)) { droppedWindow++; continue; }
          kept.push(item);
        }
        // Fewer than a full page back means Google is out of results.
        if (raw.length < 10) { serperExhausted = true; break; }
      }

      if (!firstPageFailed) {
        if (sortBy === 'date') sortByRecency(kept);
        const results = kept.slice(0, requestedCount);
        const hasMore = !serperExhausted;
        const nextCursor = hasMore ? encodeApifyCursor(page, 'news', queryStr) : undefined;
        const elapsed = Date.now() - t0;
        const drops = [droppedSource ? `${droppedSource} non-news` : '', droppedWindow ? `${droppedWindow} stale` : '']
          .filter(Boolean).join(', ');
        console.log(
          `[Search/news] ${ts} | ${ip} | OK ${results.length}/${rawSeen} results | pages ${startPage}-${page - 1} | ${elapsed}ms (serper_news)` +
            (drops ? ` | dropped ${drops}` : ''),
        );
        if (drops) addUsageNote(res, `dropped ${drops}`);
        res.locals.usage = { source: 'serper', results: results.length, upstream: estimateUpstream('serper', { credits: page - startPage }), detail: queryStr };
        res.json({ ok: true, source: 'serper_news', query: queryStr, results, nextCursor, hasMore });
        return;
      }
    } catch (err: any) {
      console.warn(`[Search/news] ${ts} | ${ip} | serper exception: ${err.message} — falling back to Brave`);
      addUsageNote(res, `serper: ${err.message}`);
    }
  }

  if (!BRAVE_API_KEY) {
    res.status(502).json({ ok: false, error: 'Serper news search failed and no Brave fallback is configured' });
    return;
  }

  // ── 2. Brave News Search ──
  try {
    const params = new URLSearchParams({
      q: queryStr,
      count: String(fetchCount),
      text_decorations: 'false',
      search_lang: 'en',
    });
    if (braveFreshness) params.set('freshness', braveFreshness);
    if (typeof country === 'string' && country && country.toUpperCase() !== 'ALL') {
      params.set('country', country);
    }

    const newsResp = await braveFetch(`${BRAVE_BASE}/news/search?${params.toString()}`);
    if (newsResp.ok) {
      const data = (await newsResp.json()) as BraveNewsSearchResponse;
      const items: NewsResult[] = (data.results || [])
        .filter((r) => r?.url)
        .map((r) => ({
          title: r.title || '',
          url: r.url as string,
          description: r.description || '',
          source: r.meta_url?.hostname || new URL(r.url as string).hostname,
          // page_age is an exact ISO timestamp when present; age is fuzzy.
          publishedAt: normalizePublishedAt(r.page_age, now) ?? normalizePublishedAt(r.age, now),
          age: r.age,
        }));
      sendNews('brave_news', 'brave', items);
      return;
    }
    const errBody = await newsResp.text();
    console.warn(`[Search/news] brave news error ${newsResp.status}: ${errBody.slice(0, 200)} — falling back to web news bucket`);
    addUsageNote(res, `brave_news ${newsResp.status}`);
  } catch (err: any) {
    console.warn(`[Search/news] brave news exception: ${err.message} — falling back`);
    addUsageNote(res, `brave_news: ${err.message}`);
  }

  // ── 3. Brave web search, news bucket only ──
  // Last resort: the standard web endpoint returns a small news cluster
  // alongside its web results. Thinner coverage, but it keeps the endpoint
  // answering when both news indexes are down.
  const legacy = await braveWebSearch(queryStr, fetchCount, braveFreshness, country);
  const elapsed = Date.now() - t0;
  if (legacy.ok) {
    const items: NewsResult[] = legacy.news.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      source: new URL(r.url).hostname,
      publishedAt: normalizePublishedAt(r.age, now),
      age: r.age,
    }));
    sendNews('web_news', 'brave', items);
    return;
  }
  console.error(`[Search/news] ${ts} | ${ip} | FAIL ${legacy.error.slice(0, 80)} | ${elapsed}ms`);
  res.status(legacy.status).json({ ok: false, error: legacy.error });
});

// ─── /image — Serper (primary) → Brave Image Search (fallback) ───

router.post('/image', async (req, res) => {
  if (!SERPER_API_KEY && !BRAVE_API_KEY) {
    res.status(503).json({ ok: false, error: 'Search not configured on kamai server (SERPER_API_KEY and BRAVE_API_KEY missing)' });
    return;
  }

  const { q, query, count, safesearch } = req.body as Record<string, unknown>;
  const queryStr = String(q || query || '').trim();
  if (!queryStr) {
    res.status(400).json({ ok: false, error: 'Missing "q" field' });
    return;
  }

  const requestedCount = Math.min(Math.max(Number(count) || 5, 1), 50);
  const safe = safesearch === 'off' || safesearch === 'strict' ? safesearch : 'strict';

  const ts = new Date().toISOString();
  const ip = callerIp(req);
  const t0 = Date.now();
  console.log(`[Search/image] ${ts} | ${ip} | REQ "${queryStr}"`);

  // ── Serper (primary) ──
  if (SERPER_API_KEY) {
    try {
      const serperResp = await serperFetch('/images', { q: queryStr, num: requestedCount });
      if (serperResp.ok) {
        const data = (await serperResp.json()) as SerperImageResponse;
        const results = (Array.isArray(data?.images) ? data.images : [])
          .filter((i) => i?.imageUrl)
          .map((i) => ({
            title: i.title || '',
            url: i.link || '',
            imageUrl: i.imageUrl as string,
            thumbnailUrl: i.thumbnailUrl || (i.imageUrl as string),
            width: i.imageWidth,
            height: i.imageHeight,
            source: i.domain || i.source || '',
          }));
        const elapsed = Date.now() - t0;
        console.log(`[Search/image] ${ts} | ${ip} | OK ${results.length} results | ${elapsed}ms (serper)`);
        res.locals.usage = { source: 'serper', results: Math.min(results.length, requestedCount), upstream: estimateUpstream('serper'), detail: queryStr };
        res.json({ ok: true, source: 'serper', query: queryStr, results: results.slice(0, requestedCount) });
        return;
      }
      const errBody = await serperResp.text();
      console.warn(`[Search/image] ${ts} | ${ip} | serper error ${serperResp.status}: ${errBody.slice(0, 200)} — falling back to Brave`);
      addUsageNote(res, `serper ${serperResp.status}`);
    } catch (err: any) {
      console.warn(`[Search/image] ${ts} | ${ip} | serper exception: ${err.message} — falling back to Brave`);
      addUsageNote(res, `serper: ${err.message}`);
    }
  }

  // ── Brave (fallback) ──
  if (!BRAVE_API_KEY) {
    res.status(502).json({ ok: false, error: 'Serper image search failed and no Brave fallback is configured' });
    return;
  }

  try {
    const params = new URLSearchParams({
      q: queryStr,
      count: String(requestedCount),
      search_lang: 'en',
      safesearch: safe,
    });
    const resp = await braveFetch(`${BRAVE_BASE}/images/search?${params.toString()}`);
    if (!resp.ok) {
      const txt = await resp.text();
      const elapsed = Date.now() - t0;
      console.error(`[Search/image] ${ts} | ${ip} | FAIL ${resp.status} | ${elapsed}ms`);
      res.status(resp.status >= 500 ? 502 : resp.status).json({
        ok: false,
        error: `Brave image search returned ${resp.status}: ${txt.slice(0, 200)}`,
      });
      return;
    }
    const data = (await resp.json()) as BraveImageSearchResponse;
    const results = (data.results || [])
      .filter((r) => r?.properties?.url || r?.thumbnail?.src)
      .map((r) => ({
        title: r.title || '',
        url: r.url || '',
        imageUrl: r.properties?.url || r.thumbnail?.original || r.thumbnail?.src || '',
        thumbnailUrl: r.thumbnail?.src || r.properties?.placeholder || '',
        width: r.thumbnail?.width,
        height: r.thumbnail?.height,
        source: r.source || (r.url ? new URL(r.url).hostname : ''),
      }));
    const elapsed = Date.now() - t0;
    console.log(`[Search/image] ${ts} | ${ip} | OK ${results.length} results | ${elapsed}ms (brave)`);
    res.locals.usage = { source: 'brave', results: Math.min(results.length, requestedCount), upstream: estimateUpstream('brave'), detail: queryStr };
    res.json({ ok: true, source: 'brave', query: queryStr, results: results.slice(0, requestedCount) });
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`[Search/image] ${ts} | ${ip} | ERR ${err.message} | ${elapsed}ms`);
    res.status(500).json({ ok: false, error: err.message || 'Image search failed' });
  }
});

// ─── Pagination cursor for the Apify (X) tier ───
//
// SocialCrawl platforms page via the provider's own opaque cursor (passed
// through untouched). The Apify tier has no provider cursor, so for date-paged
// actors (X) we mint our own: an exclusive `end` timestamp, bound to the query
// with a hash so a cursor from one search can't be replayed against another and
// silently return wrong-window results.

function cursorHash(platform: string, q: string): string {
  let h = 5381;
  const s = `${platform}:${q}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function encodeApifyCursor(endMs: number, platform: string, q: string): string {
  return Buffer.from(JSON.stringify({ v: 1, e: endMs, h: cursorHash(platform, q) })).toString('base64url');
}
function decodeApifyCursor(token: string, platform: string, q: string): number | null {
  try {
    const o = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (o?.v !== 1 || typeof o.e !== 'number' || o.h !== cursorHash(platform, q)) return null;
    return o.e;
  } catch {
    return null;
  }
}

// ─── /social — tiered social search: SocialCrawl → Apify → Brave site: ───

router.post('/social', async (req, res) => {
  if (!SOCIALCRAWL_API_KEY && !BRAVE_API_KEY && !APIFY_API_TOKEN) {
    res.status(503).json({ ok: false, error: 'Social search not configured on kamai server' });
    return;
  }

  const { platform: platformRaw, q, query, sort, timeframe, cursor, count, freshness } = req.body as Record<string, unknown>;
  const platformInput = String(platformRaw || '').toLowerCase().trim();
  const platform = PLATFORM_ALIASES[platformInput] ?? platformInput;
  const queryStr = String(q || query || '').trim();

  if (!platform || !SUPPORTED_PLATFORMS.includes(platform)) {
    res.status(400).json({
      ok: false,
      error: `Missing or unknown "platform". Supported: ${ADVERTISED_PLATFORMS.join(', ')}`,
    });
    return;
  }
  if (!queryStr) {
    res.status(400).json({ ok: false, error: 'Missing "q" field' });
    return;
  }
  const freshnessMs = parseFreshness(freshness) ?? undefined;
  if (freshness !== undefined && freshnessMs === undefined) {
    res.status(400).json({ ok: false, error: 'Invalid "freshness" — use pd|pw|pm|py or a duration like "90min", "2h", "3d", "1w"' });
    return;
  }

  const spec = SOCIAL_PLATFORMS[platform]; // SocialCrawl tier (may not exist for this platform)
  const site = PLATFORM_SITES[platform];   // Brave site: tier (may not exist)
  // Per-page cap of 100. Depth beyond one page comes from pagination (cursor),
  // not from an ever-larger single request — a big single Apify run risks the
  // 120s run-sync timeout, and paging keeps each run fast.
  const requestedCount = Math.min(Math.max(Number(count) || 10, 1), 100);
  const ts = new Date().toISOString();
  const ip = callerIp(req);
  const t0 = Date.now();
  console.log(`[Search/social] ${ts} | ${ip} | REQ ${platform} "${queryStr}"${freshnessMs ? ` fresh<${Math.round(freshnessMs / 60000)}min` : ''}`);

  const now = Date.now();

  // Exact-window post-filter. Native provider filters are coarser than the
  // requested window (or absent), so every tier gets this pass. Items with
  // no usable timestamp can't prove freshness and are dropped.
  const withinWindow = (r: { publishedAt: string | null }): boolean => {
    if (!freshnessMs) return true;
    const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
    return !Number.isNaN(t) && t >= now - freshnessMs;
  };

  /**
   * Rank newest-first by default, matching /search/news — relevance ordering
   * surfaces the same high-engagement evergreen posts on every query.
   *
   * An explicit `sort` is a deliberate request for the platform's own ordering
   * (reddit `top`, linkedin `relevance`), so it suppresses the re-rank rather
   * than being silently overridden.
   */
  const explicitSort = typeof sort === 'string' && sort.trim().length > 0;
  const rank = <T extends { publishedAt: string | null }>(items: T[]): T[] =>
    explicitSort ? items : sortByRecency(items);

  // ── 1. SocialCrawl ──
  if (spec && SOCIALCRAWL_API_KEY) {
    try {
      const params = new URLSearchParams({ query: queryStr });
      if (typeof sort === 'string' && sort && spec.sortParam) params.set(spec.sortParam, sort);
      // freshness → native timeframe (closest bucket ≥ window). An explicit
      // `timeframe` param wins, for backward compatibility. LinkedIn has no
      // year bucket — leave native filtering off and rely on the post-filter.
      const tfRaw = typeof timeframe === 'string' && timeframe
        ? timeframe
        : freshnessMs
          ? freshnessMs <= FRESHNESS_MS.pd ? 'day'
            : freshnessMs <= FRESHNESS_MS.pw ? 'week'
            : freshnessMs <= FRESHNESS_MS.pm ? 'month'
            : platform === 'reddit' ? 'year' : undefined
          : undefined;
      // Translate to the provider's vocabulary (linkedin: past_24h|past_week|past_month).
      // Unmapped values (e.g. linkedin 'year') drop the native param; the
      // exact post-filter still enforces the window.
      const tf = tfRaw && spec.timeframeMap ? spec.timeframeMap[tfRaw] : tfRaw;
      if (tf && spec.timeframeParam) params.set(spec.timeframeParam, tf);
      if (typeof cursor === 'string' && cursor && spec.cursorParam) params.set(spec.cursorParam, cursor);

      const scResp = await socialcrawlFetch(spec.path, params);
      const data: any = await scResp.json().catch(() => null);

      if (scResp.ok && data?.success) {
        const items = Array.isArray(data?.data?.items) ? data.data.items : [];
        const mapped = items.map((it: any) => {
          const p = it?.post || it || {};
          const id = p.id || null;
          let url = p.url || null;
          // Reddit items can arrive without a permalink — rebuild it from the post id
          if (!url && platform === 'reddit' && id) url = `https://www.reddit.com/comments/${id}`;
          // Field names vary by platform: linkedin uses title/created_at/
          // author.name/activity.num_*, reddit+tiktok use content.text/
          // published_at/author.username/engagement.*. Take whichever exists.
          return {
            id,
            url,
            text: p.content?.text || p.title || p.text || null,
            author: p.author?.username || p.author?.name || null,
            publishedAt: normalizePublishedAt(p.published_at || p.created_at, now),
            likes: p.engagement?.likes ?? p.activity?.num_likes ?? null,
            comments: p.engagement?.comments ?? p.activity?.num_comments ?? null,
            shares: p.engagement?.shares ?? p.activity?.num_shares ?? null,
            views: p.engagement?.views ?? p.activity?.num_views ?? null,
            meta: p.ext || undefined,
          };
        });
        const results = rank(mapped.filter(withinWindow));
        const elapsed = Date.now() - t0;
        console.log(`[Search/social] ${ts} | ${ip} | OK ${platform} ${results.length} results | ${elapsed}ms (socialcrawl, ${data.credits_used ?? '?'}cr)`);
        res.locals.usage = {
          source: 'socialcrawl',
          results: Math.min(results.length, requestedCount),
          credits: data.credits_used ?? 1,
          upstream: estimateUpstream('socialcrawl', { credits: data.credits_used ?? 1 }),
          detail: platform,
        };
        res.json({
          ok: true,
          source: 'social',
          platform,
          query: queryStr,
          results: results.slice(0, requestedCount),
          nextCursor: data?.pagination?.next_cursor ?? data?.data?.next_cursor ?? undefined,
          hasMore: data?.pagination?.has_more ?? undefined,
        });
        return;
      }
      const msg = data?.error?.message || `HTTP ${scResp.status}`;
      console.warn(`[Search/social] ${ts} | ${ip} | socialcrawl ${platform} error: ${String(msg).slice(0, 200)} — falling back`);
      addUsageNote(res, `socialcrawl: ${String(msg).slice(0, 80)}`);
    } catch (err: any) {
      console.warn(`[Search/social] ${ts} | ${ip} | socialcrawl ${platform} exception: ${err.message} — falling back`);
      addUsageNote(res, `socialcrawl: ${err.message}`);
    }
  }

  // ── 2. Apify actor (circuit-broken actors are skipped until a probe window) ──
  if (APIFY_SEARCH[platform] && APIFY_API_TOKEN) {
    if (!shouldAttemptActor(platform)) {
      console.warn(`[Search/social] ${ts} | ${ip} | apify ${platform} circuit open (failing, awaiting reprobe) — skipping`);
      addUsageNote(res, 'apify skipped (circuit open)');
    } else {
      // Decode an incoming cursor (X only). A malformed or cross-query cursor
      // must fail loudly rather than silently ignore the page position.
      let endMs: number | undefined;
      if (typeof cursor === 'string' && cursor && APIFY_SEARCH[platform]?.pageStrategy) {
        const dec = decodeApifyCursor(cursor, platform, queryStr);
        if (dec === null) {
          res.status(400).json({ ok: false, error: 'Invalid or mismatched cursor — pass the nextCursor from a prior response for the same platform and query.' });
          return;
        }
        endMs = dec;
      }
      const tA = Date.now();
      const apify = await apifyActorSearch(platform, queryStr, requestedCount, freshnessMs, endMs);
      recordActorOutcome(platform, apify.ok, Date.now() - tA, apify.ok ? undefined : apify.error);
      if (apify.ok) {
        const results = rank(apify.results);
        const elapsed = Date.now() - t0;
        const nextCursor = apify.hasMore && apify.nextCursorMs
          ? encodeApifyCursor(apify.nextCursorMs, platform, queryStr)
          : undefined;
        console.log(`[Search/social] ${ts} | ${ip} | OK ${platform} ${results.length} results | ${elapsed}ms (apify${nextCursor ? ', +page' : ''})`);
        res.locals.usage = {
          source: 'apify',
          results: results.length,
          fetched: apify.fetched,
          upstream: estimateUpstream('apify', { platform, fetched: apify.fetched }),
          detail: platform,
        };
        res.json({ ok: true, source: 'social', platform, query: queryStr, results, nextCursor, hasMore: apify.hasMore ?? false });
        return;
      }
      console.warn(`[Search/social] ${ts} | ${ip} | apify ${platform} error: ${apify.error.slice(0, 200)} — falling back`);
      addUsageNote(res, `apify: ${apify.error.slice(0, 80)}`);
    }
  }

  // ── 3. Brave site: fallback ──
  if (site && BRAVE_API_KEY) {
    const siteQuery = `site:${site} ${queryStr}`;
    // Brave only understands pd|pw|pm|py — snap the window to the closest
    // preset containing it (its age strings are too fuzzy to post-filter).
    const braveFreshness = !freshnessMs ? undefined
      : freshnessMs <= FRESHNESS_MS.pd ? 'pd'
      : freshnessMs <= FRESHNESS_MS.pw ? 'pw'
      : freshnessMs <= FRESHNESS_MS.pm ? 'pm' : 'py';
    const fallback = await braveWebSearch(siteQuery, requestedCount, braveFreshness);
    const elapsed = Date.now() - t0;
    if (fallback.ok) {
      // Last-resort tier. Brave's site: index includes years-old posts, and its
      // `age` string is NOT trustworthy — it will report a 2018 post as "1 week
      // ago". Fabricating publishedAt from it stamps old content with a recent
      // date that then passes the freshness filter, silently poisoning a
      // freshness/backfill query with stale results. So we do NOT claim a date
      // we can't stand behind: publishedAt is null, which the exact-window
      // filter treats as unprovable and drops. Net effect — a freshness query
      // degrades to an honest empty result during an actor outage rather than
      // returning old junk labelled as recent.
      // (Brave also merges its news bucket in, returning more rows than asked;
      // the slice keeps `count` meaningful.)
      const mapped = fallback.results.map((r) => ({
        id: null,
        url: r.url,
        text: r.description,
        author: null,
        publishedAt: null,
        likes: null, comments: null, shares: null, views: null,
      }));
      const results = rank(mapped.filter(withinWindow)).slice(0, requestedCount);
      if (freshnessMs && mapped.length && !results.length) {
        addUsageNote(res, 'brave fallback dropped — no verifiable dates for freshness');
      }
      console.log(`[Search/social] ${ts} | ${ip} | OK ${platform} ${results.length} results | ${elapsed}ms (brave site fallback${freshnessMs ? ', dateless dropped' : ''})`);
      res.locals.usage = { source: 'brave', results: results.length, upstream: estimateUpstream('brave'), detail: platform };
      res.json({ ok: true, source: 'web', platform, query: queryStr, results, hasMore: false });
      return;
    }
    console.error(`[Search/social] ${ts} | ${ip} | FAIL ${platform} | ${fallback.error.slice(0, 80)} | ${elapsed}ms`);
    res.status(fallback.status).json({ ok: false, error: fallback.error });
    return;
  }

  res.status(502).json({ ok: false, error: `Social search unavailable for ${platform} (all providers failed or unconfigured)` });
});

export default router;
