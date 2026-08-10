/**
 * Landing page — human-readable API documentation served at GET /.
 * This is the canonical integration doc for external (sibling) apps;
 * skill.md remains the machine-readable companion.
 */

const BASE = 'https://kamai.minai.work';

export function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>kamai — headless browser & search API for AI agents</title>
  <style>
    :root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;--dim:#8b949e;--accent:#58a6ff;--green:#3fb950;--orange:#f59e0b;--code:#1c2128;--pink:#f778ba}
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;line-height:1.6}
    .page{max-width:860px;margin:0 auto;padding:48px 24px}
    h1{font-size:34px;color:#fff;font-weight:700}
    h2{font-size:19px;color:#fff;margin:40px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
    h3{font-size:15px;color:#fff;margin:22px 0 8px}
    header .sub{color:var(--dim);margin-top:6px;font-size:14px}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
    p{margin:8px 0;font-size:14px}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin:12px 0}
    pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:14px 16px;overflow-x:auto;font-size:12.5px;line-height:1.55;margin:10px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    code{background:var(--code);padding:2px 6px;border-radius:3px;font-size:12.5px;color:var(--pink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    pre code{background:none;padding:0;color:var(--text)}
    table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}
    th{text-align:left;color:var(--dim);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border)}
    td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
    tr:last-child td{border-bottom:none}
    .method{color:var(--green);font-weight:700;font-size:12px;font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
    .free{color:var(--green);font-size:12px;font-weight:600}
    .paid{color:var(--orange);font-size:12px;font-weight:600}
    .note{color:var(--dim);font-size:12.5px}
    .box{background:var(--code);border:1px solid var(--border);border-left:3px solid var(--orange);border-radius:6px;padding:14px 18px;margin:12px 0}
    .box p{font-size:13px}
    footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--border);color:var(--dim);font-size:12.5px}
    .sep{display:inline-block;margin:0 10px;opacity:.3}
    .toc{columns:2;font-size:13.5px}
    .toc a{display:block;padding:2px 0}
    @media(max-width:600px){.toc{columns:1}}
  </style>
</head>
<body>
<div class="page">

  <header>
    <h1>kamai</h1>
    <p class="sub">
      Headless browser &amp; search API for AI agents
      <span class="sep">|</span>
      <a href="/skill.md">skill.md</a>
      <span class="sep">|</span>
      <a href="/health">health</a>
      <span class="sep">|</span>
      <a href="https://github.com/helloluis/kamai">source</a>
    </p>
    <p class="sub" style="margin-top:10px">
      kamai gives your agent a real Chromium browser, web, image &amp; social
      search with automatic provider failover, per-domain
      memory, and PDF brochure generation — over plain HTTPS JSON. No SDK required.
    </p>
  </header>

  <nav class="card toc">
    <a href="#quickstart">Quick start</a>
    <a href="#browse">Browse</a>
    <a href="#actions">Browse actions</a>
    <a href="#sessions">Sessions</a>
    <a href="#search">Search</a>
    <a href="#memories">Domain memories</a>
    <a href="#brochure">PDF brochures</a>
    <a href="#pricing">Pricing &amp; credits</a>
    <a href="#endpoints">Endpoint summary</a>
    <a href="#errors">Errors &amp; limits</a>
  </nav>

  <h2 id="quickstart">Quick start</h2>
  <p>Base URL: <code>${BASE}</code></p>
  <p>
    Identify your app on <em>authenticated</em> routes with either header:
    <code>x-api-key: &lt;key&gt;</code> or <code>x-wallet-address: 0x…</code> (Celo).
    Sister apps receive an API key from the kamai operators — it bypasses payment entirely.
    Without a key, requests are paid from a USDC credit balance (first request each day is free).
  </p>
  <pre>curl -X POST ${BASE}/api/v1/browse \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: &lt;your-key&gt;" \\
  -d '{"url": "https://example.com"}'</pre>
  <div class="box">
    <p><strong>Legacy routes need no auth at all</strong> — sister backends can call
    <code>POST /browse</code>, <code>POST /search/web</code>, <code>POST /search/image</code>
    and <code>/browse/memories</code> directly. The <code>/api/v1/…</code> equivalents exist
    for credit-paying callers; sister keys make them behave identically.</p>
  </div>

  <h2 id="browse">Browse</h2>
  <p><span class="method">POST</span> <code>/api/v1/browse</code> &nbsp;·&nbsp; legacy alias <code>/browse</code></p>
  <p>
    Navigates a real headless Chromium to a URL, optionally performs actions (fill forms, click
    through flows), then extracts clean text, links, and form fields. Stealth measures are applied
    to avoid headless detection. JavaScript dialogs (alert/confirm/prompt) are auto-accepted and logged.
  </p>
  <pre>{
  "url": "https://example.gov.ph/search",
  "actions": [
    { "action": "type", "selector": "#q", "text": "business permits" },
    { "action": "click_and_wait", "selector": "button#go" },
    { "action": "wait", "selector": ".results" }
  ],
  "selector": ".results",     // optional: narrow extraction to one element
  "timeout": 15000            // optional, ms (default 15000, max 30000)
}</pre>
  <pre>// Response
{
  "ok": true,
  "url": "https://example.gov.ph/results",
  "title": "Search Results",
  "text": "…page content as plain text…",
  "links":  [{ "text": "Permit application", "href": "https://…" }],
  "forms":  [{ "tag": "input", "type": "text", "name": "q", "selector": "#q" }],
  "memories": ["Use /Indexes/index for keyword search instead of homepage"],
  "actions_performed": ["typed \\"business permits\\" into #q", "clicked button#go → navigated"],
  "sessionId": "…",           // your persistent session (see Sessions)
  "length": 4500
}</pre>
  <p class="note">Safety: <code>file:</code>, <code>data:</code>, localhost and private-IP URLs are blocked. Text is capped at 30 000 chars.</p>

  <h2 id="actions">Browse actions</h2>
  <p>Up to 20 actions per request, executed in order before extraction. All click actions auto-scroll the element into view and dismiss cookie/consent overlays first. CSS selectors and Playwright <code>text=…</code> selectors are supported everywhere.</p>
  <table>
    <tr><th>Action</th><th>Params</th><th>What it does</th></tr>
    <tr><td><code>type</code></td><td>selector, text</td><td>Clear field and type text</td></tr>
    <tr><td><code>click</code></td><td>selector</td><td>Click element (500 ms pause)</td></tr>
    <tr><td><code>click_and_wait</code></td><td>selector</td><td>Click, wait for navigation</td></tr>
    <tr><td><code>submit</code></td><td>selector?</td><td>Programmatic form submit (ASP.NET postbacks)</td></tr>
    <tr><td><code>select</code></td><td>selector, value</td><td>Choose a dropdown option</td></tr>
    <tr><td><code>wait</code></td><td>selector, timeout?</td><td>Wait for element to appear</td></tr>
    <tr><td><code>wait_ms</code></td><td>ms</td><td>Pause (max 5000)</td></tr>
    <tr><td><code>scroll_to</code></td><td>selector</td><td>Scroll element into view (centered)</td></tr>
    <tr><td><code>js_click</code></td><td>selector</td><td>Force-click via JS — bypasses overlays/pointer interception</td></tr>
    <tr><td><code>set_date</code></td><td>selector, value</td><td>Set any date picker, value <code>yyyy-mm-dd</code></td></tr>
    <tr><td><code>evaluate</code></td><td>text</td><td>Run arbitrary JS on the page</td></tr>
  </table>

  <h2 id="sessions">Sessions</h2>
  <p>
    Sessions are <strong>automatic</strong>. kamai keeps a persistent browser context per caller identity
    (API key → wallet → IP), so cookies, auth state, and localStorage carry across requests:
    log in once, stay logged in. Idle sessions expire after 30 minutes.
  </p>
  <p>
    For explicit control, create a session via <span class="method">POST</span> <code>/api/v1/session</code>
    and pass its <code>sessionId</code> in browse requests;
    <span class="method">GET</span>/<span class="method">DELETE</span> <code>/api/v1/session/:id</code> inspect and destroy it.
  </p>

  <h2 id="screenshot">Screenshots</h2>
  <p><span class="method">POST</span> <code>/api/v1/screenshot</code> &nbsp;·&nbsp; legacy alias <code>/screenshot</code></p>
  <p>
    Capture the relevant part of any URL — including social posts, which are captured by rendering
    the platform's <em>own</em> embed rather than its login wall.
  </p>
  <pre>{ "url": "https://x.com/jack/status/20", "mode": "auto", "format": "jpeg" }

// → { "ok": true, "screenshotId": "…", "imageUrl": "/api/v1/screenshot/…/image",
//     "strategy": "embed:x", "width": 550, "height": 225, "sizeBytes": 37888,
//     "expiresAt": "…" }</pre>
  <p class="note"><code>mode</code> <code>auto</code> (default) · <code>relevant</code> · <code>viewport</code> · <code>full</code> · <code>element</code> (needs <code>selector</code>) ·
  <code>format</code> <code>jpeg</code>/<code>png</code> · <code>width</code> 320–2000 · <code>maxHeight</code> 200–8000 · <code>scale</code> 1–3 ·
  <code>encoding</code> <code>url</code> (default) or <code>base64</code>.
  <code>GET /api/v1/screenshot/:id/image</code> is public and needs no auth, so the link can go straight to a vision model.</p>
  <table>
    <tr><th>Platform</th><th>Strategy</th></tr>
    <tr><td><code>x</code> · <code>instagram</code> · <code>linkedin</code> · <code>facebook</code> · <code>threads</code> · <code>bluesky</code></td><td><code>embed:*</code> — full post card via the official embed</td></tr>
    <tr><td><code>tiktok</code></td><td><code>embed:tiktok</code> — card renders, video poster frame often does not</td></tr>
    <tr><td><code>reddit</code></td><td><code>apify:reddit-card</code> — rendered from scraped data, ~110s; not a pixel capture</td></tr>
    <tr><td>any other URL</td><td><code>page:*</code> — cropped to the main content region</td></tr>
  </table>
  <p class="note">If an embed returns an error page ("Post not found", a rate-limit notice) the request <em>fails</em> with that reason
  rather than returning a blank image — a screenshot that proves nothing is worse than no screenshot.</p>

  <h2 id="search">Search</h2>
  <p>Web, news, image, and social search across multiple premium providers with automatic failover — one API, no search keys to manage on your side.</p>
  <p><span class="method">POST</span> <code>/api/v1/search/web</code> &nbsp;·&nbsp; legacy alias <code>/search/web</code></p>
  <pre>{ "q": "Tim Cook age", "count": 5, "country": "US" }

// → { "ok": true, "source": "web",
//     "results": [{ "title", "url", "description", "content"?, "age"? }] }</pre>
  <p class="note"><code>count</code> 1–20 (default 5) · <code>country</code> 2-letter code or <code>ALL</code> ·
  <code>freshness</code> <code>pd|pw|pm|py</code> or durations like <code>90min</code>, <code>2h</code>, <code>3d</code> · <code>maxTokens</code> context budget (default 4096).
  <code>source</code> identifies which backend answered — failover is automatic.
  When available, results include extracted page <code>content</code>.</p>
  <h3>News search</h3>
  <p><span class="method">POST</span> <code>/api/v1/search/news</code> &nbsp;·&nbsp; legacy alias <code>/search/news</code></p>
  <p>
    Searches news indexes instead of the general web — use it whenever recency matters.
    Unlike <code>/search/web</code>, the freshness window is enforced exactly and every result
    carries an ISO 8601 <code>publishedAt</code> you can sort on.
  </p>
  <pre>{ "q": "openai funding round", "freshness": "6h", "count": 10 }

// → { "ok": true, "source": "serper_news",
//     "results": [{ "title", "url", "description", "source",
//                   "publishedAt", "age"? }] }</pre>
  <p class="note"><code>count</code> 1–50 (default 10) · <code>freshness</code> <code>pd|pw|pm|py</code> or durations like
  <code>90min</code>, <code>2h</code>, <code>3d</code> · <code>sort</code> <code>date</code> (default) or <code>relevance</code> ·
  <code>country</code> 2-letter code or <code>ALL</code> · <code>filterSources</code> <code>true</code> (default) ·
  <code>cursor</code>/<code>nextCursor</code> pagination for deep coverage.
  Ranked newest-first, and non-news sources — app stores, corporate FAQ and support pages, retailers,
  job boards, wikis — are dropped; set <code>filterSources: false</code> to keep them.
  Tight windows may return fewer than <code>count</code> results — that means there was no fresher coverage.</p>

  <p><span class="method">POST</span> <code>/api/v1/search/image</code> &nbsp;·&nbsp; legacy alias <code>/search/image</code></p>
  <pre>{ "q": "Eiffel Tower at night", "count": 10, "safesearch": "strict" }

// → { "ok": true, "results": [{ "title", "url", "imageUrl", "thumbnailUrl",
//     "width", "height", "source" }] }</pre>
  <p class="note"><code>count</code> 1–50 (default 5) · <code>safesearch</code> <code>strict</code> (default) or <code>off</code>.</p>

  <h3>Social search</h3>
  <p><span class="method">POST</span> <code>/api/v1/search/social</code> &nbsp;·&nbsp; legacy alias <code>/search/social</code></p>
  <p>
    Keyword search across social platforms — brand mentions, competitor tracking, community
    research. One request shape for every platform; results are normalized to one schema.
  </p>
  <pre>{ "platform": "reddit", "q": "your brand", "freshness": "3d", "count": 10 }

// → { "ok": true, "source": "social", "platform": "reddit",
//     "results": [{ "id", "url", "text", "author", "publishedAt",
//                   "likes", "comments", "shares", "views", "meta"? }],
//     "nextCursor": "…", "hasMore": true }</pre>
  <p class="note">Ranked newest-first, with <code>publishedAt</code> normalized to ISO 8601 (or <code>null</code>) on every
  backend. Pass <code>sort</code> to hand ordering back to the platform instead.</p>
  <table>
    <tr><th>Platform</th><th>Notes</th></tr>
    <tr><td><code>x</code> <span class="note">(aliases <code>twitter</code>, <code>x.com</code>)</span></td><td>Keyword search with engagement counts · chronological · <b>cursor pagination</b> for multi-day backfill (page with <code>nextCursor</code>; bound with <code>freshness</code>)</td></tr>
    <tr><td><code>reddit</code></td><td>Full post search · sort: relevance|new|top|comment_count · timeframe: day|week|month|year|all</td></tr>
    <tr><td><code>linkedin</code></td><td>Public post search · sort: relevance|date · timeframe: day|week|month</td></tr>
    <tr><td><code>tiktok</code> · <code>youtube</code> · <code>threads</code> · <code>pinterest</code></td><td>Keyword search</td></tr>
    <tr><td><code>instagram</code></td><td>Keyword search of public reels — runs live, expect 15–60s</td></tr>
    <tr><td><code>facebook</code></td><td>Public post search — runs live, so expect 20–60s response times; public content only</td></tr>
    <tr><td><code>facebook-events</code></td><td>Events search</td></tr>
  </table>
  <p class="note"><code>freshness</code> limits results by age: presets <code>pd|pw|pm|py</code> or exact durations
  like <code>90min</code>, <code>2h</code>, <code>3d</code>, <code>1w</code> — the exact window is always enforced server-side;
  tight windows may return fewer than <code>count</code> results.
  <b>Pagination:</b> one page per request (<code>count</code> max 100); pass the response's <code>nextCursor</code> back as
  <code>cursor</code> and repeat while <code>hasMore</code> is true. Cursors are bound to their <code>platform</code>+<code>q</code>;
  bound a backfill with <code>freshness</code>. Available on <code>x</code> (by timestamp), <code>facebook</code> (by day),
  <code>reddit</code>, <code>linkedin</code>, <code>tiktok</code>, <code>youtube</code>, <code>threads</code>, <code>pinterest</code>; <code>instagram</code> is single-page.
  If a platform's primary backend is unavailable, queries automatically fall back through secondary providers,
  then a site-scoped web search (<code>source: "web"</code>) where the platform indexes well.</p>

  <h2 id="memories">Domain memories</h2>
  <p>
    Every browse response includes a <code>memories</code> array — learnings saved by agents from
    previous visits to that domain. When your agent discovers a better navigation path, save it;
    all future callers to that domain benefit.
  </p>
  <table>
    <tr><th></th><th>Route</th><th>Purpose</th></tr>
    <tr><td><span class="method">GET</span></td><td><code>/browse/memories?domain=example.com</code></td><td>Read learnings (omit domain to list all)</td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/browse/memories</code></td><td>Save <code>{ "domain", "learning", "strategy"? }</code></td></tr>
    <tr><td><span class="method">DELETE</span></td><td><code>/browse/memories/:id</code></td><td>Remove a learning</td></tr>
  </table>
  <p class="note">Also mounted at <code>/api/v1/browse/memories</code>. Free on both paths.
  A memory with a <code>strategy</code> field (<code>yt-dlp</code>, <code>github-api</code>) overrides how kamai fetches that domain.</p>

  <h2 id="brochure">PDF brochures</h2>
  <p>Generate multi-page corporate PDFs from structured JSON. Templates: <code>corporate-overview</code>, <code>product-showcase</code>, <code>event-invitation</code>.</p>
  <table>
    <tr><th></th><th>Route</th><th>Purpose</th></tr>
    <tr><td><span class="method">GET</span></td><td><code>/api/v1/brochure/templates</code></td><td><span class="free">free</span> — list templates + required fields</td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/api/v1/brochure/generate</code></td><td><span class="paid">paid</span> — render a new brochure</td></tr>
    <tr><td><span class="method">PATCH</span></td><td><code>/api/v1/brochure/:id</code></td><td><span class="paid">paid</span> — merge changes &amp; re-render</td></tr>
    <tr><td><span class="method">GET</span></td><td><code>/api/v1/brochure/:id/download</code></td><td><span class="free">free</span> — the PDF itself, no auth (shareable link)</td></tr>
  </table>
  <p class="note">Full content schema (sections, products, charts, contact info, images as URLs or base64) is in <a href="/skill.md">skill.md</a>.</p>

  <h2 id="pricing">Pricing &amp; credits</h2>
  <table>
    <tr><th>Request</th><th>Cost</th></tr>
    <tr><td>Browse (no actions)</td><td>$0.009</td></tr>
    <tr><td>Browse with actions</td><td>$0.013</td></tr>
    <tr><td>Search (web or image)</td><td>$0.003</td></tr>
    <tr><td>Brochure generate / update</td><td>$0.050</td></tr>
    <tr><td>Brochure templates &amp; downloads, memories, health</td><td>free</td></tr>
  </table>
  <p>
    Sister keys bypass payment entirely. Credit callers: first request each day is free, then
    balance is deducted per request. When balance runs out, the API returns
    <code>402</code> with machine-readable deposit instructions (USDC on Celo, min $0.10).
    Deposit via <span class="method">POST</span> <code>/api/v1/deposit</code> with your tx hash;
    check balance at <span class="method">GET</span> <code>/api/v1/deposit/balance</code>;
    manage your account and API key at <span class="method">GET</span> <code>/api/v1/account</code>.
  </p>

  <h2 id="endpoints">Endpoint summary</h2>
  <table>
    <tr><th></th><th>Route</th><th>Auth</th></tr>
    <tr><td><span class="method">POST</span></td><td><code>/api/v1/browse</code></td><td>key / wallet <span class="note">(legacy /browse: none)</span></td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/api/v1/search/web</code> · <code>/api/v1/search/news</code> · <code>/api/v1/search/image</code> · <code>/api/v1/search/social</code></td><td>key / wallet <span class="note">(legacy /search/*: none)</span></td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/api/v1/screenshot</code> <span class="note">· <code>GET /:id/image</code> is public</span></td><td>key / wallet</td></tr>
    <tr><td><span class="method">GET·POST·DEL</span></td><td><code>/browse/memories</code> · <code>/api/v1/browse/memories</code></td><td>none</td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/api/v1/brochure/generate</code></td><td>key / wallet</td></tr>
    <tr><td><span class="method">PATCH</span></td><td><code>/api/v1/brochure/:id</code></td><td>key / wallet</td></tr>
    <tr><td><span class="method">GET</span></td><td><code>/api/v1/brochure/templates</code> · <code>/api/v1/brochure/:id/download</code></td><td>none</td></tr>
    <tr><td><span class="method">POST·GET·DEL</span></td><td><code>/api/v1/session</code></td><td>rate-limited</td></tr>
    <tr><td><span class="method">GET·POST</span></td><td><code>/api/v1/account</code> · <code>/api/v1/deposit</code></td><td>wallet</td></tr>
    <tr><td><span class="method">GET</span></td><td><a href="/skill.md"><code>/skill.md</code></a></td><td>none</td></tr>
    <tr><td><span class="method">GET</span></td><td><a href="/health"><code>/health</code></a></td><td>none</td></tr>
  </table>

  <h2 id="errors">Errors &amp; limits</h2>
  <pre>{ "ok": false, "error": "Navigation timeout: 15000ms exceeded" }</pre>
  <ul class="note" style="padding-left:20px;font-size:13.5px">
    <li><code>401</code> — missing identity header on an authenticated route</li>
    <li><code>402</code> — insufficient credits; response includes deposit instructions</li>
    <li><code>400</code> — bad request (missing <code>url</code>/<code>q</code>, invalid action params)</li>
    <li>Rate limit: 60 req/min per IP — <code>X-RateLimit-Remaining</code> header on responses</li>
    <li>Charges apply only to successful (2xx) responses</li>
  </ul>

  <footer>
    kamai is part of the <a href="https://minai.work">minai</a> project
    <span class="sep">·</span>
    built by <a href="https://x.com/helloluis">@helloluis</a>
    <span class="sep">·</span>
    <a href="https://github.com/helloluis/kamai">github.com/helloluis/kamai</a>
  </footer>

</div>
</body>
</html>`;
}
