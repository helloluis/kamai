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
import { measuredCostPerRun } from './apifyCost.js';
import { priceFor, floorForEndpoint } from '../payment/pricing.js';

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

try {
  // What the caller owes at the published rate: max(floor, 2 x upstream).
  // Stored per row because the markup is applied per REQUEST — summing first
  // and marking up after would ignore the floor on every cheap call.
  // Sister apps are never debited, but this is still populated so their tab is
  // a real number rather than an afterthought.
  db.exec('ALTER TABLE request_log ADD COLUMN billable_usd REAL NOT NULL DEFAULT 0');
} catch { /* column already exists */ }

const stmtInsert = db.prepare(
  `INSERT INTO request_log (app, endpoint, detail, source, results, charged_usd, upstream_usd, status, note, billable_usd)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// ─── Upstream cost estimates ───

/**
 * COLD-START FALLBACK ONLY — superseded by measuredCostPerRun() as soon as
 * src/api/apifyCost.ts has pulled real invoices. These list-price figures
 * understated actual spend by 1.8x (LinkedIn) to 15x (TikTok).
 */
const APIFY_COST: Record<string, { start: number; perResult: number }> = {
  facebook: { start: 0.0025, perResult: 0.0025 }, // scraper_one~facebook-posts-search
  instagram: { start: 0, perResult: 0.00125 }, // scraping_solutions~...-pro-no-cookies
  youtube: { start: 0.0013, perResult: 0.004 }, // streamers~youtube-scraper
  tiktok: { start: 0, perResult: 0.0003 }, // apidojo~tiktok-scraper
  linkedin: { start: 0.00005, perResult: 0.002 },
  // danek~twitter-scraper: no start fee, $0.00024 per dataset item.
  x: { start: 0, perResult: 0.00024 },
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
      // News search walks multiple Google-News pages (one Serper credit each);
      // `credits` carries the page count. Web/image are single-call (credits=1).
      return 0.001 * Math.max(opts.credits ?? 1, 1);
    case 'brave':
      return 0.005; // web / llm_context / images — Brave Pro effective rate
    case 'socialcrawl':
      return 0.008 * (opts.credits ?? 1); // ~$0.008 per SocialCrawl credit
    case 'apify': {
      // Prefer the cost Apify actually billed for this actor. The static table
      // below understated real spend by up to 15x (TikTok) because it was
      // derived from list prices rather than invoices.
      const real = measuredCostPerRun(opts.platform ?? '');
      if (real !== null) return real;
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

const LOGGED_PREFIXES = ['/api/v1/', '/browse', '/search', '/screenshot'];

/**
 * Collapse per-resource paths so the dashboard groups by endpoint rather than
 * accumulating one distinct row per generated id. Without this, every capture
 * and every brochure creates its own `endpoint` value and the per-endpoint
 * rollups become useless.
 */
function normalizeEndpoint(path: string): string {
  return path
    .replace(/^\/api\/v1/, '')
    .replace(/\/+$/, '')
    .replace(
      /\/(screenshot|brochure|image)\/[0-9a-f]{8}-[0-9a-f-]{20,}(\/\w+)?$/i,
      (_m, kind, tail) => `/${kind}/:id${tail || ''}`,
    ) || '/';
}

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
  const endpoint = normalizeEndpoint(req.path);
  // setImmediate: this global middleware registers its 'finish' listener
  // BEFORE the route-level creditPayment does, but creditPayment's listener is
  // the one that settles res.locals.chargedUsd (max(floor, 2x upstream)).
  // Without the deferral, rows log the pre-settlement floor prediction and the
  // /adm Settled/Receivable columns drift from what was actually debited.
  res.on('finish', () => setImmediate(() => {
    try {
      const u = (res.locals.usage ?? {}) as UsageDetail;
      const ok2xx = res.statusCode >= 200 && res.statusCode < 300;
      // Failed requests are never billable, even though some of them still
      // cost us real upstream money (a Reddit capture that dies after Apify
      // has already run). That loss belongs in upstream, not in a tab.
      const billable = ok2xx
        ? priceFor((res.locals.priceFloor as number) ?? 0, u.upstream)
        : 0;
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
        billable,
      );
    } catch {
      // Analytics must never break a request.
    }
  }));
  next();
}

/**
 * Price historical rows that predate billable_usd.
 *
 * Without this every tab starts at $0 and the Receivable bucket looks empty
 * until new traffic arrives. Only touches rows still at 0, so it is safe to run
 * on every boot and never overwrites a settled figure.
 */
export function backfillBillable(): number {
  const rows = db
    .prepare(
      `SELECT id, endpoint, upstream_usd, status FROM request_log
       WHERE billable_usd = 0 AND status >= 200 AND status < 300`,
    )
    .all() as Array<{ id: number; endpoint: string; upstream_usd: number; status: number }>;
  if (!rows.length) return 0;

  const upd = db.prepare(`UPDATE request_log SET billable_usd = ? WHERE id = ?`);
  const run = db.transaction((batch: typeof rows) => {
    let priced = 0;
    for (const r of batch) {
      const floor = floorForEndpoint(r.endpoint);
      const price = priceFor(floor, r.upstream_usd);
      if (price > 0) {
        upd.run(price, r.id);
        priced++;
      }
    }
    return priced;
  });
  const n = run(rows);
  if (n > 0) console.log(`[Usage] priced ${n} historical request(s) at the published rate`);
  return n;
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

interface SummaryRow { app: string; requests: number; charged: number; upstream: number; billable: number; last_seen: string }
interface BreakdownRow { app: string; endpoint: string; requests: number; charged: number; upstream: number; billable: number }
interface RecentRow {
  created_at: string; app: string; endpoint: string; detail: string | null;
  source: string | null; results: number | null; charged_usd: number; upstream_usd: number;
  billable_usd: number; status: number; note: string | null;
}
interface TotalsRow { requests: number; charged: number; upstream: number; billable: number }

function queries() {
  const summary = db.prepare(
    `SELECT app, COUNT(*) requests, COALESCE(SUM(charged_usd),0) charged,
            COALESCE(SUM(upstream_usd),0) upstream,
            COALESCE(SUM(billable_usd),0) billable, MAX(created_at) last_seen
     FROM request_log GROUP BY app ORDER BY billable DESC`,
  ).all() as SummaryRow[];
  const breakdown = db.prepare(
    `SELECT app, endpoint, COUNT(*) requests, COALESCE(SUM(charged_usd),0) charged,
            COALESCE(SUM(upstream_usd),0) upstream, COALESCE(SUM(billable_usd),0) billable
     FROM request_log WHERE created_at >= datetime('now', '-30 days')
     GROUP BY app, endpoint ORDER BY app, billable DESC`,
  ).all() as BreakdownRow[];
  const recent = db.prepare(
    `SELECT created_at, app, endpoint, detail, source, results, charged_usd, upstream_usd,
            billable_usd, status, note
     FROM request_log ORDER BY id DESC LIMIT 100`,
  ).all() as RecentRow[];
  const totals = db.prepare(
    `SELECT COUNT(*) requests, COALESCE(SUM(charged_usd),0) charged,
            COALESCE(SUM(upstream_usd),0) upstream, COALESCE(SUM(billable_usd),0) billable
     FROM request_log`,
  ).get() as TotalsRow;
  const last30 = db.prepare(
    `SELECT app, COUNT(*) requests, COALESCE(SUM(billable_usd),0) billable,
            COALESCE(SUM(upstream_usd),0) upstream
     FROM request_log WHERE created_at >= datetime('now', '-30 days')
     GROUP BY app`,
  ).all() as Array<{ app: string; requests: number; billable: number; upstream: number }>;
  // Upstream is several SEPARATE vendor bills (Apify, SocialCrawl, Brave,
  // Serper) plus self-hosted compute — collapsing them into one number invites
  // comparing the sum against a single vendor's balance, which is what happened.
  const providers = db.prepare(
    `SELECT COALESCE(source,'self') provider, COUNT(*) requests,
            COALESCE(SUM(upstream_usd),0) upstream
     FROM request_log WHERE upstream_usd > 0
     GROUP BY source ORDER BY upstream DESC`,
  ).all() as Array<{ provider: string; requests: number; upstream: number }>;
  return {
    summary, breakdown, recent, totals,
    sisters: sisterConsumption(last30),
    providers: providerBreakdown(providers),
  };
}

/** Which vendor each `source` value is actually billed by. */
const PROVIDER_VENDOR: Record<string, string> = {
  apify: 'Apify',
  socialcrawl: 'SocialCrawl',
  brave: 'Brave',
  serper: 'Serper',
  openai: 'OpenAI',
  ideogram: 'Ideogram',
  dashscope: 'Alibaba DashScope',
  page: 'self-hosted',
  embed: 'self-hosted',
  card: 'self-hosted',
  playwright: 'self-hosted',
  self: 'self-hosted',
};

interface ProviderRow { vendor: string; requests: number; upstreamUsd: number }

/** Group raw `source` rows into the vendor that actually invoices for them. */
function providerBreakdown(
  rows: Array<{ provider: string; requests: number; upstream: number }>,
): ProviderRow[] {
  const byVendor = new Map<string, ProviderRow>();
  for (const r of rows) {
    const vendor = PROVIDER_VENDOR[r.provider] ?? r.provider;
    const v = byVendor.get(vendor) ?? { vendor, requests: 0, upstreamUsd: 0 };
    v.requests += r.requests;
    v.upstreamUsd += r.upstream;
    byVendor.set(vendor, v);
  }
  return [...byVendor.values()]
    .map((v) => ({ ...v, upstreamUsd: +v.upstreamUsd.toFixed(4) }))
    .sort((a, b) => b.upstreamUsd - a.upstreamUsd);
}

export interface SisterConsumption {
  app: string;
  requests: number;
  billableUsd: number;
  upstreamUsd: number;
}

/**
 * Consumption per NAMED sister app over the window.
 *
 * Driven off the names in SISTER_API_KEYS rather than off whatever appears in
 * the log, so an app that has gone quiet still shows — a sister at $0 is
 * usually a broken integration, which is exactly what you want to notice.
 * Names are deduped because one app can hold several keys (beaniebot has two).
 */
function sisterConsumption(
  rows: Array<{ app: string; requests: number; billable: number; upstream: number }>,
): SisterConsumption[] {
  const byApp = new Map(rows.map((r) => [r.app, r]));
  const names = [...new Set(SISTER_KEY_NAMES.values())];
  return names
    .map((name) => {
      const r = byApp.get(name);
      return {
        app: name,
        requests: r?.requests ?? 0,
        billableUsd: +(r?.billable ?? 0).toFixed(4),
        upstreamUsd: +(r?.upstream ?? 0).toFixed(4),
      };
    })
    .sort((a, b) => b.billableUsd - a.billableUsd);
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const esc = (s: string | null) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

admRouter.get('/data.json', (_req, res) => {
  res.json({ ok: true, ...queries() });
});

/**
 * Daily receivables (billable - charged) per sister app per vendor, for the
 * dashboard chart. Filtering by app/vendor happens client-side; the date range
 * bounds the query. Apps = named sister apps (current env config) plus any
 * app that historically appears in the log under a sister name.
 */
admRouter.get('/receivables.json', (req, res) => {
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const to = dayRe.test(String(req.query.to)) ? String(req.query.to) : today;
  const from = dayRe.test(String(req.query.from)) ? String(req.query.from) : defaultFrom;

  const sisterNames = [...new Set(SISTER_KEY_NAMES.values())];
  if (sisterNames.length === 0) {
    res.json({ ok: true, from, to, rows: [], apps: [], vendors: [] });
    return;
  }
  const placeholders = sisterNames.map(() => '?').join(',');
  const raw = db.prepare(
    `SELECT date(created_at) AS day, app, COALESCE(source, 'self') AS source,
            COALESCE(SUM(billable_usd), 0) AS billable,
            COALESCE(SUM(charged_usd), 0) AS charged
     FROM request_log
     WHERE app IN (${placeholders}) AND date(created_at) >= ? AND date(created_at) <= ?
     GROUP BY day, app, source ORDER BY day ASC`,
  ).all(...sisterNames, from, to) as Array<{ day: string; app: string; source: string; billable: number; charged: number }>;

  const rows = raw.map((r) => ({
    day: r.day,
    app: r.app,
    vendor: PROVIDER_VENDOR[r.source] ?? r.source,
    receivable: +Math.max(0, r.billable - r.charged).toFixed(4),
  })).filter((r) => r.receivable > 0);

  res.json({
    ok: true,
    from,
    to,
    rows,
    // Full app list (not just in-range) so chip order and colors stay stable
    // across date-range changes — color follows the entity, never the filter.
    apps: [...new Set([...sisterNames, ...rows.map((r) => r.app)])].sort(),
    vendors: [...new Set(rows.map((r) => r.vendor))].sort(),
  });
});

admRouter.get('/', (_req, res) => {
  const { summary, breakdown, recent, totals, sisters, providers } = queries();
  // Receivable, not "net". Sister apps are never debited, so charged is ~$0
  // and a charged-minus-cost "net" just showed the whole upstream bill as a
  // loss. What the business actually holds is: cost already incurred, plus the
  // tab those apps have run up at the published rate but not yet settled.
  const receivable = totals.billable - totals.charged;
  const margin = totals.billable - totals.upstream;
  const marginClass = margin >= 0 ? 'pos' : 'neg';

  const summaryRows = summary.map((r) => {
    const owed = r.billable - r.charged;
    return `<tr><td>${esc(r.app)}</td><td class="num">${r.requests}</td>
      <td class="num">${usd(r.upstream)}</td><td class="num">${usd(r.billable)}</td>
      <td class="num">${usd(r.charged)}</td><td class="num acc">${usd(owed)}</td>
      <td class="dim">${esc(r.last_seen)}</td></tr>`;
  }).join('');

  const breakdownRows = breakdown.map((r) =>
    `<tr><td>${esc(r.app)}</td><td><code>${esc(r.endpoint)}</code></td><td class="num">${r.requests}</td>
     <td class="num">${usd(r.upstream)}</td><td class="num">${usd(r.billable)}</td></tr>`,
  ).join('');

  const recentRows = recent.map((r) =>
    `<tr><td class="dim">${esc(r.created_at)}</td><td>${esc(r.app)}</td><td><code>${esc(r.endpoint)}</code></td>
     <td class="dim">${esc(r.detail)}</td><td class="dim">${esc(r.source)}</td>
     <td class="num">${r.results ?? ''}</td><td class="num">${usd(r.upstream_usd)}</td>
     <td class="num">${usd(r.billable_usd)}</td><td class="num">${r.status}</td>
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
  .pos { color: #3fb950; } .neg { color: #f85149; } .acc { color: #d29922; }
  code { background: #161b22; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .totals { display: flex; gap: 24px; margin-top: 12px; flex-wrap: wrap; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 18px; }
  .card .v { font-size: 20px; font-weight: 700; } .card .k { color: #7d8590; font-size: 12px; }
  .card.sister { min-width: 150px; }
  .card .k2 { color: #c9d1d9; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 2px; }
  .note { color: #7d8590; font-size: 12px; margin-top: 32px; }
  .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .filters input[type=date] { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 12px; color-scheme: dark; }
  .btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  .btn:hover { background: #30363d; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid #30363d; border-radius: 999px; font-size: 12px; cursor: pointer; user-select: none; color: #c9d1d9; margin: 2px; }
  .chip .sw { width: 10px; height: 10px; border-radius: 3px; }
  .chip.off { opacity: .35; }
  .chartcard { margin-top: 12px; padding: 16px 18px; }
  .tip { position: fixed; pointer-events: none; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; font-size: 12px; color: #e6edf3; display: none; z-index: 10; box-shadow: 0 4px 16px rgba(0,0,0,.5); white-space: nowrap; }
  .tip b { font-variant-numeric: tabular-nums; }
  .rvempty { color: #7d8590; font-size: 13px; padding: 40px 0; text-align: center; }
  details.rvtable { margin-top: 10px; } details.rvtable summary { cursor: pointer; color: #7d8590; font-size: 12px; }
</style></head><body>
<h1>kamai admin</h1>

<h2>Sister apps — last 30 days</h2>
<div class="totals">
${sisters.map((s) => `
  <div class="card sister">
    <div class="k2">${esc(s.app)}</div>
    <div class="v acc">${usd(s.billableUsd)}</div>
    <div class="k">${s.requests.toLocaleString()} request${s.requests === 1 ? '' : 's'} · ${usd(s.upstreamUsd)} cost</div>
  </div>`).join('') || '<div class="card"><div class="k">No sister apps configured</div></div>'}
</div>

<h2>Receivables by day</h2>
<div class="card chartcard">
  <div class="filters">
    <input type="date" id="rvfrom"> <span class="dim">to</span> <input type="date" id="rvto">
    <button class="btn" data-days="7">7d</button>
    <button class="btn" data-days="30">30d</button>
    <button class="btn" data-days="90">90d</button>
    <span class="dim" style="margin-left:10px">Apps:</span> <span id="rvapps"></span>
    <span class="dim" style="margin-left:10px">Providers:</span> <span id="rvvendors"></span>
  </div>
  <div id="rvchart"><div class="rvempty">Loading…</div></div>
  <details class="rvtable"><summary>Table view</summary><div id="rvtabledata"></div></details>
</div>
<div class="tip" id="rvtip"></div>
<script>
(function () {
  // Categorical palette — validated for CVD separation and >=3:1 contrast on
  // this card surface (#161b22). Slots assigned to apps alphabetically and
  // never re-assigned on filter; a 9th+ app folds into neutral "other".
  var PAL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  var OTHER = '#768390';
  var DATA = { rows: [], apps: [], vendors: [], from: '', to: '' };
  var offApps = {}, offVendors = {};
  var elChart = document.getElementById('rvchart');
  var elTip = document.getElementById('rvtip');
  var elFrom = document.getElementById('rvfrom');
  var elTo = document.getElementById('rvto');

  function colorOf(app) {
    var i = DATA.apps.indexOf(app);
    return i >= 0 && i < PAL.length ? PAL[i] : OTHER;
  }
  function usd(v) { return '$' + (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4)); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function fetchData(from, to) {
    var q = [];
    if (from) q.push('from=' + from);
    if (to) q.push('to=' + to);
    fetch('/adm/receivables.json' + (q.length ? '?' + q.join('&') : ''))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        DATA = d;
        elFrom.value = d.from; elTo.value = d.to;
        renderChips();
        draw();
      })
      .catch(function () {
        elChart.innerHTML = '<div class="rvempty">Failed to load receivables.</div>';
      });
  }

  function chip(label, color, isOff, onClick) {
    var c = document.createElement('span');
    c.className = 'chip' + (isOff ? ' off' : '');
    if (color) c.innerHTML = '<span class="sw" style="background:' + color + '"></span>' + esc(label);
    else c.textContent = label;
    c.onclick = onClick;
    return c;
  }

  function renderChips() {
    var apps = document.getElementById('rvapps');
    apps.innerHTML = '';
    DATA.apps.forEach(function (a) {
      apps.appendChild(chip(a, colorOf(a), offApps[a], function () {
        offApps[a] = !offApps[a]; renderChips(); draw();
      }));
    });
    var vends = document.getElementById('rvvendors');
    vends.innerHTML = '';
    DATA.vendors.forEach(function (v) {
      vends.appendChild(chip(v, null, offVendors[v], function () {
        offVendors[v] = !offVendors[v]; renderChips(); draw();
      }));
    });
  }

  function dayList(from, to) {
    var out = [], d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
    while (d <= end && out.length < 400) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  function topRect(x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    return 'M' + x + ' ' + (y + h) + ' L' + x + ' ' + (y + r) +
      ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
      ' L' + (x + w - r) + ' ' + y +
      ' Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) +
      ' L' + (x + w) + ' ' + (y + h) + ' Z';
  }

  function draw() {
    var rows = DATA.rows.filter(function (r) { return !offApps[r.app] && !offVendors[r.vendor]; });
    var days = dayList(DATA.from, DATA.to);
    var apps = DATA.apps.filter(function (a) { return !offApps[a]; });
    var byDay = {};
    days.forEach(function (d) { byDay[d] = {}; });
    rows.forEach(function (r) {
      if (!byDay[r.day]) return;
      byDay[r.day][r.app] = (byDay[r.day][r.app] || 0) + r.receivable;
    });
    var maxTotal = 0;
    days.forEach(function (d) {
      var t = 0; apps.forEach(function (a) { t += byDay[d][a] || 0; });
      if (t > maxTotal) maxTotal = t;
    });
    if (maxTotal <= 0) {
      elChart.innerHTML = '<div class="rvempty">No receivables in this range.</div>';
      document.getElementById('rvtabledata').innerHTML = '';
      return;
    }
    var pow = Math.pow(10, Math.floor(Math.log(maxTotal) / Math.LN10));
    var m = maxTotal / pow;
    var nice = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;

    var W = 960, H = 300, L = 58, R = 8, T = 14, B = 26;
    var pw = W - L - R, ph = H - T - B;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;display:block" role="img" aria-label="Daily receivables, stacked by sister app">';
    // recessive grid + y labels
    for (var g = 0; g <= 4; g++) {
      var gy = T + ph - (ph * g / 4);
      svg += '<line x1="' + L + '" y1="' + gy + '" x2="' + (W - R) + '" y2="' + gy + '" stroke="#21262d" stroke-width="1"/>';
      svg += '<text x="' + (L - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="11" fill="#7d8590" style="font-variant-numeric:tabular-nums">$' + (nice * g / 4).toFixed(2) + '</text>';
    }
    var slot = pw / days.length;
    var bw = Math.min(slot * 0.66, 44);
    var tickStep = Math.ceil(days.length / 12);
    days.forEach(function (d, i) {
      var x = L + slot * i + (slot - bw) / 2;
      var yCursor = T + ph;
      var stack = [];
      apps.forEach(function (a) { var v = byDay[d][a] || 0; if (v > 0) stack.push([a, v]); });
      stack.forEach(function (pair, si) {
        var h = pair[1] / nice * ph;
        var y = yCursor - h;
        var isTop = si === stack.length - 1;
        // 2px surface gap between stacked segments; keep at least 1px of mark
        var gh = Math.max(h - (si < stack.length - 1 ? 2 : 0), 1);
        var attrs = ' class="seg" data-app="' + esc(pair[0]) + '" data-day="' + d + '" data-v="' + pair[1].toFixed(4) + '" fill="' + colorOf(pair[0]) + '"';
        if (isTop) svg += '<path d="' + topRect(x, y, bw, gh, 4) + '"' + attrs + '/>';
        else svg += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + gh + '"' + attrs + '/>';
        yCursor = y;
      });
      if (i % tickStep === 0) {
        svg += '<text x="' + (L + slot * i + slot / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#7d8590">' + d.slice(5) + '</text>';
      }
    });
    svg += '</svg>';
    elChart.innerHTML = svg;

    elChart.querySelectorAll('.seg').forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        var total = 0;
        apps.forEach(function (a) { total += byDay[el.dataset.day][a] || 0; });
        var share = total > 0 ? Math.round(parseFloat(el.dataset.v) / total * 100) : 0;
        elTip.innerHTML = esc(el.dataset.app) + ' &middot; ' + el.dataset.day +
          '<br><b>' + usd(parseFloat(el.dataset.v)) + '</b> <span class="dim">(' + share + '% of day)</span>';
        elTip.style.display = 'block';
        elTip.style.left = (e.clientX + 14) + 'px';
        elTip.style.top = (e.clientY - 10) + 'px';
      });
      el.addEventListener('mouseleave', function () { elTip.style.display = 'none'; });
    });

    // table view — same data, day x app
    var tbl = '<table><tr><th>Day</th>';
    apps.forEach(function (a) { tbl += '<th class="num">' + esc(a) + '</th>'; });
    tbl += '<th class="num">Total</th></tr>';
    days.forEach(function (d) {
      var t = 0;
      var cells = apps.map(function (a) { var v = byDay[d][a] || 0; t += v; return '<td class="num">' + (v > 0 ? usd(v) : '') + '</td>'; }).join('');
      if (t > 0) tbl += '<tr><td class="dim">' + d + '</td>' + cells + '<td class="num acc">' + usd(t) + '</td></tr>';
    });
    tbl += '</table>';
    document.getElementById('rvtabledata').innerHTML = tbl;
  }

  elFrom.addEventListener('change', function () { fetchData(elFrom.value, elTo.value); });
  elTo.addEventListener('change', function () { fetchData(elFrom.value, elTo.value); });
  document.querySelectorAll('.btn[data-days]').forEach(function (b) {
    b.addEventListener('click', function () {
      var days = parseInt(b.dataset.days, 10);
      var to = new Date().toISOString().slice(0, 10);
      var from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      fetchData(from, to);
    });
  });
  fetchData();
})();
</script>

<h2>Upstream cost by vendor — all time</h2>
<div class="totals">
${providers.map((p) => `
  <div class="card">
    <div class="k2">${esc(p.vendor)}</div>
    <div class="v">${usd(p.upstreamUsd)}</div>
    <div class="k">${p.requests.toLocaleString()} request${p.requests === 1 ? '' : 's'}</div>
  </div>`).join('') || '<div class="card"><div class="k">No upstream spend yet</div></div>'}
</div>
<p class="note" style="margin-top:8px">Each vendor is a <b>separate</b> subscription with its own balance — Apify, SocialCrawl, Brave and Serper are billed independently. The all-time "upstream cost" below is their sum, not any single vendor's bill.</p>

<h2>All time</h2>
<div class="totals">
  <div class="card"><div class="v">${totals.requests}</div><div class="k">requests (all time)</div></div>
  <div class="card"><div class="v">${usd(totals.upstream)}</div><div class="k">upstream cost (actual)</div></div>
  <div class="card"><div class="v">${usd(totals.billable)}</div><div class="k">billable @ published rate</div></div>
  <div class="card"><div class="v">${usd(totals.charged)}</div><div class="k">settled (paid)</div></div>
  <div class="card"><div class="v acc">${usd(receivable)}</div><div class="k">receivable</div></div>
  <div class="card"><div class="v ${marginClass}">${usd(margin)}</div><div class="k">margin @ 100% markup</div></div>
</div>

<h2>Per app — all time</h2>
<table><tr><th>App</th><th class="num">Requests</th><th class="num">Upstream</th><th class="num">Billable</th><th class="num">Settled</th><th class="num">Receivable</th><th>Last seen</th></tr>
${summaryRows || '<tr><td colspan="6" class="dim">No requests logged yet</td></tr>'}</table>

<h2>Per app × endpoint — last 30 days</h2>
<table><tr><th>App</th><th>Endpoint</th><th class="num">Requests</th><th class="num">Upstream</th><th class="num">Billable</th></tr>
${breakdownRows || '<tr><td colspan="5" class="dim">No requests in the last 30 days</td></tr>'}</table>

<h2>Recent requests</h2>
<table><tr><th>Time (UTC)</th><th>App</th><th>Endpoint</th><th>Detail</th><th>Provider</th><th class="num">Results</th><th class="num">Upstream</th><th class="num">Billable</th><th class="num">Status</th><th>Fallback reason</th></tr>
${recentRows || '<tr><td colspan="10" class="dim">No requests logged yet</td></tr>'}</table>

<p class="note"><b>Receivable</b> = billable &minus; settled: what callers have run up at the published rate but not paid.
Sister apps are never debited, so essentially all of it is theirs — it is an internal tab, not a debt anyone will collect.
<b>Billable</b> is cost-plus: <code>max(endpoint floor, 2 &times; upstream)</code> applied per request.
<b>Upstream</b> for Apify is reconciled against real invoices every 6h, not estimated.
Callers can self-serve the same figures at <code>/api/v1/spend</code>; JSON here at <code>/adm/data.json</code>.</p>
</body></html>`);
});
