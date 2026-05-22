/**
 * POST /api/v1/search/web   — Brave LLM Context API (web search optimised for LLMs)
 * POST /api/v1/search/image — Brave Image Search API
 *
 * Thin proxy over the Brave Search API. Kamai holds a paid Brave subscription
 * so callers can fire bursty searches without hitting the 1 req/sec free-plan
 * rate limit, and so individual app API keys never need to be distributed.
 *
 * Auth + billing: same `creditPayment(PRICE_SEARCH)` middleware as /browse.
 */
import { Router } from 'express';

const router = Router();

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_BASE = 'https://api.search.brave.com/res/v1';

// ─── Brave response types (we forward verbatim, but type the key fields) ───

interface BraveLLMContextResponse {
  grounding: {
    generic?: Array<{
      url: string;
      snippets: Array<{ text: string; relevance_score?: number }>;
    }>;
  };
  sources?: Array<{ url: string; title: string; hostname: string; page_age?: string }>;
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

// ─── /web — LLM-optimised search, falls back to legacy Web Search on error ───

router.post('/web', async (req, res) => {
  if (!BRAVE_API_KEY) {
    res.status(503).json({ ok: false, error: 'Brave search not configured on kamai server (BRAVE_API_KEY missing)' });
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

  try {
    const llmResp = await braveFetch(`${BRAVE_BASE}/llm/context?${llmParams.toString()}`);

    if (llmResp.ok) {
      const data = (await llmResp.json()) as BraveLLMContextResponse;
      // Build flat result list with extracted content
      const sourceMap = new Map<string, { title: string; age?: string }>();
      for (const s of data.sources || []) {
        if (s?.url) sourceMap.set(s.url, { title: s.title || '', age: s.page_age });
      }
      const results: Array<{
        title: string;
        url: string;
        description: string;
        content?: string;
        age?: string;
      }> = [];
      for (const item of data.grounding?.generic || []) {
        if (!item?.url) continue;
        const meta = sourceMap.get(item.url);
        const snippets = (item.snippets || [])
          .filter((s) => s?.text)
          .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
        const content = snippets.map((s) => s.text.trim()).filter((t) => t.length > 0).join('\n\n');
        results.push({
          title: meta?.title || new URL(item.url).hostname,
          url: item.url,
          description: snippets[0]?.text?.slice(0, 300) || '',
          content: content || undefined,
          age: meta?.age,
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

// ─── /image — Brave Image Search ───

router.post('/image', async (req, res) => {
  if (!BRAVE_API_KEY) {
    res.status(503).json({ ok: false, error: 'Brave search not configured on kamai server' });
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
    console.log(`[Search/image] ${ts} | ${ip} | OK ${results.length} results | ${elapsed}ms`);
    res.json({ ok: true, query: queryStr, results: results.slice(0, requestedCount) });
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`[Search/image] ${ts} | ${ip} | ERR ${err.message} | ${elapsed}ms`);
    res.status(500).json({ ok: false, error: err.message || 'Image search failed' });
  }
});

export default router;
