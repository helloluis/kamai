/**
 * Shared result normalization for the search endpoints.
 *
 * Two jobs, both about making heterogeneous provider output uniform:
 *
 *  1. `normalizePublishedAt` — every provider reports time differently
 *     (ISO strings, unix seconds, "2 hours ago", "Aug 5, 2026", nothing at
 *     all). Callers can't sort or threshold on that, so every result on every
 *     endpoint passes through here and comes out as ISO 8601 or null.
 *
 *  2. `isNewsSource` — a news query run against any index drags in app-store
 *     listings, corporate FAQ/support pages, retailer product pages and job
 *     boards. They match the keywords but they aren't reporting, and they're
 *     usually undated so they'd otherwise outrank real coverage. This is a
 *     blocklist, not an allowlist: it keeps long-tail and regional outlets
 *     that no curated list would include.
 *
 * Lives in its own module because both search.ts and apifySearch.ts need it
 * and search.ts already imports from apifySearch.ts.
 */

// ─── Timestamps ───

/**
 * Relative-age units as they appear in provider `date`/`age` strings.
 * Includes Brave's shorthand ("2h", "3d"). Bare "m" is deliberately absent —
 * it's ambiguous between minute and month, and guessing wrong is a 30x error.
 */
const AGE_UNITS_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  mo: 2_592_000_000,
  month: 2_592_000_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
};

/** Unix timestamps below this are seconds, above are milliseconds (~1973 in ms). */
const UNIX_SECONDS_CEILING = 1e11;

/**
 * Normalize a provider timestamp to ISO 8601, or null when it can't be trusted.
 *
 * Accepts ISO strings, unix epoch numbers (seconds or ms), relative strings
 * ("2 hours ago", "3d", "yesterday") and absolute dates ("Aug 5, 2026").
 * All relative values resolve against the caller-supplied `nowMs` so every
 * item in one response shares a single clock.
 *
 * Relative strings are inherently lossy ("2 hours ago" could be 2h00 or 2h59);
 * we take the stated value, which is the earliest the item could be. That
 * biases freshness filters toward INCLUDING borderline items rather than
 * dropping fresh ones.
 */
export function normalizePublishedAt(raw: unknown, nowMs: number): string | null {
  if (raw == null) return null;

  // Unix epoch — several Apify actors emit these.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw < UNIX_SECONDS_CEILING ? raw * 1000 : raw;
    return ms <= nowMs + AGE_UNITS_MS.day ? new Date(ms).toISOString() : null;
  }

  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  if (s === 'just now' || s === 'now' || s === 'today') return new Date(nowMs).toISOString();
  if (s === 'yesterday') return new Date(nowMs - AGE_UNITS_MS.day).toISOString();

  // "2 hours ago", "1 day ago", "45 minutes ago" — also Brave's "2h"/"3d" shorthand.
  const rel = s.match(/^(\d+)\s*([a-z]+?)s?(?:\s+ago)?$/);
  if (rel) {
    const unit = AGE_UNITS_MS[rel[2]];
    if (unit) return new Date(nowMs - parseInt(rel[1], 10) * unit).toISOString();
  }

  // Numeric epoch that arrived as a string.
  if (/^\d{10,13}$/.test(s)) return normalizePublishedAt(parseInt(s, 10), nowMs);

  // Absolute date — ISO 8601 or "Aug 5, 2026".
  const abs = Date.parse(raw);
  if (Number.isNaN(abs)) return null;

  // Date-only strings carry no time, and Date.parse resolves them
  // inconsistently: bare ISO ("2026-08-05") is spec'd as UTC midnight, while
  // "Aug 5, 2026" is parsed in the server's local zone. Left alone, the same
  // article would land on different days depending on where kamai runs.
  // Re-anchor both at 12:00 UTC so the error is bounded at ±12h either way
  // and identical on every host.
  if (!/\d{1,2}:\d{2}/.test(raw)) {
    const d = new Date(abs);
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s);
    const utcNoon = Date.UTC(
      iso ? d.getUTCFullYear() : d.getFullYear(),
      iso ? d.getUTCMonth() : d.getMonth(),
      iso ? d.getUTCDate() : d.getDate(),
      12,
    );
    return utcNoon <= nowMs + AGE_UNITS_MS.day ? new Date(utcNoon).toISOString() : null;
  }

  // Reject timestamps more than a day ahead — parser misfires and provider
  // junk — while tolerating small clock skew between us and the publisher.
  return abs <= nowMs + AGE_UNITS_MS.day ? new Date(abs).toISOString() : null;
}

/**
 * Sort newest-first, in place. Items with no resolvable timestamp sink to the
 * bottom rather than the top — an undated page can't be shown to be recent,
 * and undated pages are exactly what we don't want leading a news feed.
 */
export function sortByRecency<T extends { publishedAt: string | null }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
  });
}

// ─── News source filtering ───

/**
 * Never-news hosts. Matched on the host and every parent domain, so one entry
 * covers its subdomains. Grouped by why they show up in news results at all.
 */
const BLOCKED_HOSTS = new Set([
  // App stores and software listings — the "app store review page" problem.
  'apps.apple.com', 'itunes.apple.com', 'play.google.com', 'apps.microsoft.com',
  'chromewebstore.google.com', 'addons.mozilla.org', 'apkpure.com', 'apkmirror.com',
  'sourceforge.net', 'download.cnet.com',
  // Retail and marketplaces — product pages matching brand keywords.
  'amazon.com', 'amazon.co.uk', 'amazon.in', 'ebay.com', 'etsy.com', 'walmart.com',
  'target.com', 'bestbuy.com', 'alibaba.com', 'aliexpress.com', 'temu.com',
  'shopee.com', 'lazada.com', 'shopee.ph', 'lazada.com.ph',
  // Job boards.
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'jobstreet.com',
  'linkedin.com', 'upwork.com', 'fiverr.com',
  // Review/UGC/Q&A — opinions, not reporting.
  'yelp.com', 'tripadvisor.com', 'trustpilot.com', 'g2.com', 'capterra.com',
  'quora.com', 'stackoverflow.com', 'stackexchange.com', 'reddit.com',
  'producthunt.com', 'sitejabber.com',
  // Social platforms — /search/social is the endpoint for these.
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'pinterest.com', 'threads.net', 'youtube.com', 'youtu.be', 't.me', 'vk.com',
  // Reference and databases — evergreen by construction.
  'wikipedia.org', 'wiktionary.org', 'fandom.com', 'imdb.com', 'crunchbase.com',
  'zoominfo.com', 'scribd.com', 'slideshare.net', 'coursehero.com', 'goodreads.com',
]);

/** Support/docs SaaS platforms — always a help centre, never an outlet. */
const BLOCKED_HOST_SUFFIXES = [
  '.zendesk.com', '.freshdesk.com', '.intercom.help', '.helpscoutdocs.com',
  '.gitbook.io', '.readthedocs.io', '.notion.site', '.atlassian.net',
  '.myshopify.com', '.wixsite.com', '.hubspot.com', '.statuspage.io',
];

/**
 * Subdomain labels that mark a corporate property rather than an outlet —
 * "the FAQs of corporate partners". Only checked as the leading label.
 */
const BLOCKED_SUBDOMAINS = new Set([
  'support', 'help', 'helpdesk', 'faq', 'faqs', 'docs', 'doc', 'documentation',
  'kb', 'knowledgebase', 'status', 'careers', 'jobs', 'shop', 'store',
  'community', 'forum', 'forums', 'developer', 'developers', 'account',
  'accounts', 'login', 'signin', 'billing', 'legal', 'investor', 'investors',
]);

/**
 * Path segments that mark a non-editorial page even on a legitimate outlet.
 * Deliberately excludes "reviews" — app-store reviews are already blocked by
 * host, and tech outlets publish genuine editorial reviews under /reviews/.
 */
const BLOCKED_PATH_SEGMENTS = new Set([
  'faq', 'faqs', 'support', 'help', 'terms', 'privacy', 'legal', 'pricing',
  'careers', 'jobs', 'contact', 'contact-us', 'about-us', 'customer-service',
  'returns', 'shipping', 'warranty', 'signup', 'sign-up', 'register', 'login',
  'sitemap', 'cart', 'checkout', 'subscribe', 'newsletter-signup',
]);

/** Operator escape hatch: extra hosts to block without a redeploy. */
const ENV_BLOCKED = new Set(
  (process.env.NEWS_BLOCKED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean),
);

/**
 * True when a URL plausibly points at news reporting.
 *
 * Blocklist semantics: unknown domains PASS. That's deliberate — a regional
 * outlet nobody curated is exactly the coverage a news search should surface,
 * and the cost of letting some junk through is lower than silently dropping
 * legitimate reporting.
 */
export function isNewsSource(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (BLOCKED_HOSTS.has(host) || ENV_BLOCKED.has(host)) return false;
  for (const blocked of BLOCKED_HOSTS) {
    if (host.endsWith(`.${blocked}`)) return false;
  }
  for (const blocked of ENV_BLOCKED) {
    if (host.endsWith(`.${blocked}`)) return false;
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return false;
  }

  const labels = host.split('.');
  if (labels.length > 2 && BLOCKED_SUBDOMAINS.has(labels[0])) return false;

  for (const seg of u.pathname.toLowerCase().split('/')) {
    if (seg && BLOCKED_PATH_SEGMENTS.has(seg)) return false;
  }
  return true;
}
