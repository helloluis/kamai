/**
 * POST /api/v1/search/web   — web search (LLM-optimised when Brave handles it)
 * POST /api/v1/search/image — image search
 *
 * Provider order: Serper (Google) is PRIMARY; Brave is the fallback when
 * Serper errors, times out, or isn't configured. Brave /web itself tries the
 * LLM Context API first, then the standard Web Search API. One paid
 * subscription per provider lives on kamai so callers never manage keys.
 *
 * Auth + billing: same `creditPayment(PRICE_SEARCH)` middleware as /browse.
 */
import { Router } from 'express';

const router = Router();

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const SERPER_BASE = 'https://google.serper.dev';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_BASE = 'https://api.search.brave.com/res/v1';

// ─── Serper response types ───

interface SerperWebResponse {
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
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
      if (typeof freshness === 'string' && freshnessMap[freshness]) {
        body.tbs = freshnessMap[freshness];
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
        res.json({ ok: true, source: 'serper', query: queryStr, results: results.slice(0, requestedCount) });
        return;
      }
      const errBody = await serperResp.text();
      console.warn(`[Search/web] ${ts} | ${ip} | serper error ${serperResp.status}: ${errBody.slice(0, 200)} — falling back to Brave`);
    } catch (err: any) {
      console.warn(`[Search/web] ${ts} | ${ip} | serper exception: ${err.message} — falling back to Brave`);
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
      res.json({ ok: true, source: 'llm_context', query: queryStr, results: results.slice(0, requestedCount) });
      return;
    }

    // 5xx or rate limited → fall through to legacy web search
    const errBody = await llmResp.text();
    console.warn(`[Search/web] llm_context error ${llmResp.status}: ${errBody.slice(0, 200)} — falling back to web search`);
  } catch (err: any) {
    console.warn(`[Search/web] llm_context exception: ${err.message} — falling back`);
  }

  // Legacy fallback
  try {
    const webParams = new URLSearchParams({
      q: queryStr,
      count: String(requestedCount),
      text_decorations: 'false',
      search_lang: 'en',
    });
    if (freshness === 'pd' || freshness === 'pw' || freshness === 'pm' || freshness === 'py') {
      webParams.set('freshness', freshness);
    }
    if (typeof country === 'string') webParams.set('country', country);

    const webResp = await braveFetch(`${BRAVE_BASE}/web/search?${webParams.toString()}`);
    if (!webResp.ok) {
      const txt = await webResp.text();
      const elapsed = Date.now() - t0;
      console.error(`[Search/web] ${ts} | ${ip} | FAIL ${webResp.status} | ${elapsed}ms`);
      res.status(webResp.status >= 500 ? 502 : webResp.status).json({
        ok: false,
        error: `Brave web search returned ${webResp.status}: ${txt.slice(0, 200)}`,
      });
      return;
    }
    const data = (await webResp.json()) as BraveWebSearchResponse;
    const results: Array<{ title: string; url: string; description: string; age?: string }> = [];
    for (const r of data.web?.results || []) {
      if (r?.url) results.push({ title: r.title || '', url: r.url, description: r.description || '', age: r.age });
    }
    for (const r of data.news?.results || []) {
      if (r?.url) results.push({ title: `[News] ${r.title || ''}`, url: r.url, description: r.description || '', age: r.age });
    }
    const elapsed = Date.now() - t0;
    console.log(`[Search/web] ${ts} | ${ip} | OK ${results.length} results | ${elapsed}ms (web fallback)`);
    res.json({ ok: true, source: 'web', query: queryStr, results: results.slice(0, requestedCount) });
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`[Search/web] ${ts} | ${ip} | ERR ${err.message} | ${elapsed}ms`);
    res.status(500).json({ ok: false, error: err.message || 'Search failed' });
  }
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
        res.json({ ok: true, source: 'serper', query: queryStr, results: results.slice(0, requestedCount) });
        return;
      }
      const errBody = await serperResp.text();
      console.warn(`[Search/image] ${ts} | ${ip} | serper error ${serperResp.status}: ${errBody.slice(0, 200)} — falling back to Brave`);
    } catch (err: any) {
      console.warn(`[Search/image] ${ts} | ${ip} | serper exception: ${err.message} — falling back to Brave`);
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
    res.json({ ok: true, source: 'brave', query: queryStr, results: results.slice(0, requestedCount) });
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`[Search/image] ${ts} | ${ip} | ERR ${err.message} | ${elapsed}ms`);
    res.status(500).json({ ok: false, error: err.message || 'Image search failed' });
  }
});

export default router;
