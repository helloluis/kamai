/**
 * Usage analytics + /adm admin dashboard.
 *
 * A global middleware logs every API request (paid and free/legacy) to a
 * local SQLite table: who called (app name), which endpoint, what they were
 * charged, and what the call cost US upstream (estimated provider fees).
 * Sister apps bypass payment, so without this their provider burn would be
 * invisible — this log is the per-app P&L.
 *
 * Identity → app name: `name:key` entries in SISTER_API_KEYS resolve to the
 * name; unnamed sister keys and wallets show a prefix; credit accounts show
 * their label or wallet prefix; anonymous callers show their IP.
 *
 * The dashboard is Basic-auth gated (ADMIN_USER/ADMIN_PASS env). Upstream $
 * figures are ESTIMATES from provider list prices, good enough for pricing
 * decisions — actual billed amounts live in the providers' consoles.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { SISTER_KEYS, SISTER_KEY_NAMES } from '../payment/config.js';
import { getAccountByApiKey } from '../payment/credits.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', '..', 'usage.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    detail TEXT,
    source TEXT,
    results INTEGER,
    charged_usd REAL NOT NULL DEFAULT 0,
    upstream_usd REAL NOT NULL DEFAULT 0,
    status INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_request_log_app ON request_log (app, created_at);
`);

try {
  db.exec('ALTER TABLE request_log ADD COLUMN note TEXT'); // provider fallback reasons
} catch { /* column already exists */ }

const stmtInsert = db.prepare(
  `INSERT INTO request_log (app, endpoint, detail, source, results, charged_usd, upstream_usd, status, note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// ─── Upstream cost estimates ───

/** Estimated upstream prices (USD) from provider list prices, Aug 2026. */
const APIFY_COST: Record<string, { start: number; perResult: number }> = {
  facebook: { start: 0.005, perResult: 0.0019 },
  instagram: { start: 0.001, perResult: 0.0027 },
  tiktok: { start: 0.006, perResult: 0.0037 },
  linkedin: { start: 0.00005, perResult: 0.002 },
  // trudax~reddit-scraper-lite bills an actor-start event per GB ($0.02 at the
  // 1024MB we request) plus a per-result event. This is the most expensive
  // upstream on the platform and it runs at a LOSS against PRICE_SCREENSHOT —
  // Reddit is the only route where that is true, and it is deliberate: no
  // other path reaches reddit.com from this server's IP at all.
  reddit: { start: 0.02, perResult: 0.002 },
};

/** Estimate what one served call cost us upstream. `fetched` counts billed results incl. over-fetch. */
export function estimateUpstream(
  source: string,
  opts: { platform?: string; fetched?: number; credits?: number } = {},
): number {
  switch (source) {
    case 'serper':
      return 0.001;
    case 'brave':
      return 0.005; // web / llm_context / images — Brave Pro effective rate
    case 'socialcrawl':
      return 0.008 * (opts.credits ?? 1); // ~$0.008 per SocialCrawl credit
    case 'apify': {
      const c = APIFY_COST[opts.platform ?? ''] ?? { start: 0.005, perResult: 0.002 };
      return c.start + c.perResult * (opts.fetched ?? 1);
    }
    // Screenshot routes. Self-hosted capture costs only VPS compute — a real
    // number rather than 0 so the /adm P&L doesn't read the whole price as
    // margin. Roughly 3s of a Chromium page on a shared box.
    case 'playwright':
      return 0.0005;
    case 'embed':
      return 0.0002; // embed pages are far lighter DOM than a full site
    case 'card':
      return 0.0002;
    default:
      return 0;
  }
}

// ─── Request logging middleware ───

/** What routes attach to res.locals.usage before responding. */
export interface UsageDetail {
  source?: string; // real provider that answered (serper|brave|socialcrawl|apify)
  results?: number;
  fetched?: number;
  credits?: number;
  upstream?: number;
  detail?: string; // platform or query, ≤80 chars
}

const LOGGED_PREFIXES = ['/api/v1/', '/browse', '/search'];

/** Resolve the caller to a display name for the dashboard. */
function resolveApp(req: Request): string {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) {
    const named = SISTER_KEY_NAMES.get(apiKey);
    if (named) return named;
    if (SISTER_KEYS.has(apiKey)) return `sister:${apiKey.slice(0, 6)}…`;
    const acct = getAccountByApiKey(apiKey);
    if (acct) return acct.label || `wallet:${acct.wallet.slice(0, 10)}…`;
    return `key:${apiKey.slice(0, 6)}…`;
  }
  const wallet = (req.headers['x-wallet-address'] as string | undefined)?.toLowerCase();
  if (wallet) {
    const named = SISTER_KEY_NAMES.get(wallet);
    if (named) return named;
    if (SISTER_KEYS.has(wallet)) return `sister:${wallet.slice(0, 8)}…`;
    return `wallet:${wallet.slice(0, 10)}…`;
  }
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  return `anon:${ip}`;
}

export function usageMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!LOGGED_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  // Capture the endpoint NOW — routers rewrite req.url during dispatch, so by
  // the time 'finish' fires the mount prefix is gone (/search/social → /social).
  const endpoint = req.path.replace(/^\/api\/v1/, '').replace(/\/+$/, '') || '/';
  res.on('finish', () => {
    try {
      const u = (res.locals.usage ?? {}) as UsageDetail;
      stmtInsert.run(
        resolveApp(req),
        endpoint,
        u.detail?.slice(0, 80) ?? null,
        u.source ?? null,
        u.results ?? null,
        (res.locals.chargedUsd as number) ?? 0,
        u.upstream ?? 0,
        res.statusCode,
        ((res.locals.usageNote as string) ?? null)?.slice(0, 200),
      );
    } catch {
      // Analytics must never break a request.
    }
  });
  next();
}

export function closeUsageDb(): void {
  db.close();
}

// ─── /adm dashboard ───

const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

function safeEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const admRouter = Router();

admRouter.use((req, res, next) => {
  if (!ADMIN_USER || !ADMIN_PASS) {
    res.status(503).send('Admin dashboard not configured (ADMIN_USER/ADMIN_PASS unset)');
    return;
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const colon = decoded.indexOf(':');
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1); // passwords may contain ':'
    if (colon > 0 && safeEq(user, ADMIN_USER) && safeEq(pass, ADMIN_PASS)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="kamai admin"');
  res.status(401).send('Unauthorized');
});

interface SummaryRow { app: string; requests: number; charged: number; upstream: number; last_seen: string }
interface BreakdownRow { app: string; endpoint: string; requests: number; charged: number; upstream: number }
interface RecentRow {
  created_at: string; app: string; endpoint: string; detail: string | null;
  source: string | null; results: number | null; charged_usd: number; upstream_usd: number; status: number; note: string | null;
}
interface TotalsRow { requests: number; charged: number; upstream: number }

function queries() {
  const summary = db.prepare(
    `SELECT app, COUNT(*) requests, COALESCE(SUM(charged_usd),0) charged,
            COALESCE(SUM(upstream_usd),0) upstream, MAX(created_at) last_seen
     FROM request_log GROUP BY app ORDER BY upstream DESC`,
  ).all() as SummaryRow[];
  const breakdown = db.prepare(
    `SELECT app, endpoint, COUNT(*) requests, COALESCE(SUM(charged_usd),0) charged,
            COALESCE(SUM(upstream_usd),0) upstream
     FROM request_log WHERE created_at >= datetime('now', '-30 days')
     GROUP BY app, endpoint ORDER BY app, upstream DESC`,
  ).all() as BreakdownRow[];
  const recent = db.prepare(
    `SELECT created_at, app, endpoint, detail, source, results, charged_usd, upstream_usd, status, note
     FROM request_log ORDER BY id DESC LIMIT 100`,
  ).all() as RecentRow[];
  const totals = db.prepare(
    `SELECT COUNT(*) requests, COALESCE(SUM(charged_usd),0) charged, COALESCE(SUM(upstream_usd),0) upstream
     FROM request_log`,
  ).get() as TotalsRow;
  return { summary, breakdown, recent, totals };
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const esc = (s: string | null) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

admRouter.get('/data.json', (_req, res) => {
  res.json({ ok: true, ...queries() });
});

admRouter.get('/', (_req, res) => {
  const { summary, breakdown, recent, totals } = queries();
  const net = totals.charged - totals.upstream;
  const netClass = net >= 0 ? 'pos' : 'neg';

  const summaryRows = summary.map((r) => {
    const n = r.charged - r.upstream;
    return `<tr><td>${esc(r.app)}</td><td class="num">${r.requests}</td><td class="num">${usd(r.charged)}</td>
      <td class="num">${usd(r.upstream)}</td><td class="num ${n >= 0 ? 'pos' : 'neg'}">${usd(n)}</td>
      <td class="dim">${esc(r.last_seen)}</td></tr>`;
  }).join('');

  const breakdownRows = breakdown.map((r) =>
    `<tr><td>${esc(r.app)}</td><td><code>${esc(r.endpoint)}</code></td><td class="num">${r.requests}</td>
     <td class="num">${usd(r.charged)}</td><td class="num">${usd(r.upstream)}</td></tr>`,
  ).join('');

  const recentRows = recent.map((r) =>
    `<tr><td class="dim">${esc(r.created_at)}</td><td>${esc(r.app)}</td><td><code>${esc(r.endpoint)}</code></td>
     <td class="dim">${esc(r.detail)}</td><td class="dim">${esc(r.source)}</td>
     <td class="num">${r.results ?? ''}</td><td class="num">${usd(r.charged_usd)}</td>
     <td class="num">${usd(r.upstream_usd)}</td><td class="num">${r.status}</td>
     <td class="dim">${esc(r.note)}</td></tr>`,
  ).join('');

  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>kamai admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 14px/1.45 -apple-system, system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 24px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 32px; color: #9da7b3; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; }
  th { color: #7d8590; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: #7d8590; font-size: 12px; }
  .pos { color: #3fb950; } .neg { color: #f85149; }
  code { background: #161b22; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .totals { display: flex; gap: 24px; margin-top: 12px; flex-wrap: wrap; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 18px; }
  .card .v { font-size: 20px; font-weight: 700; } .card .k { color: #7d8590; font-size: 12px; }
  .note { color: #7d8590; font-size: 12px; margin-top: 32px; }
</style></head><body>
<h1>kamai admin</h1>
<div class="totals">
  <div class="card"><div class="v">${totals.requests}</div><div class="k">requests (all time)</div></div>
  <div class="card"><div class="v">${usd(totals.charged)}</div><div class="k">charged to callers</div></div>
  <div class="card"><div class="v">${usd(totals.upstream)}</div><div class="k">upstream cost (est.)</div></div>
  <div class="card"><div class="v ${netClass}">${usd(net)}</div><div class="k">net</div></div>
</div>

<h2>Per app — all time</h2>
<table><tr><th>App</th><th class="num">Requests</th><th class="num">Charged</th><th class="num">Upstream (est.)</th><th class="num">Net</th><th>Last seen</th></tr>
${summaryRows || '<tr><td colspan="6" class="dim">No requests logged yet</td></tr>'}</table>

<h2>Per app × endpoint — last 30 days</h2>
<table><tr><th>App</th><th>Endpoint</th><th class="num">Requests</th><th class="num">Charged</th><th class="num">Upstream (est.)</th></tr>
${breakdownRows || '<tr><td colspan="5" class="dim">No requests in the last 30 days</td></tr>'}</table>

<h2>Recent requests</h2>
<table><tr><th>Time (UTC)</th><th>App</th><th>Endpoint</th><th>Detail</th><th>Provider</th><th class="num">Results</th><th class="num">Charged</th><th class="num">Upstream</th><th class="num">Status</th><th>Fallback reason</th></tr>
${recentRows || '<tr><td colspan="10" class="dim">No requests logged yet</td></tr>'}</table>

<p class="note">Upstream $ are estimates from provider list prices — actual billing lives in each provider's console.
Sister apps are charged $0 (they bypass payment), so their rows show pure cost. Data starts accumulating at deploy time; JSON at <code>/adm/data.json</code>.</p>
</body></html>`);
});
