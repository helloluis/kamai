/**
 * GET /api/v1/spend — a caller's running tab.
 *
 * Sister apps are never debited, but they still accrue real cost, and until now
 * the only way to see it was the operator-only /adm dashboard. This is the
 * self-service view: the same number an external customer would be billed, at
 * the published rate, across four windows.
 *
 * Amounts come from request_log.billable_usd, which is computed PER REQUEST as
 * max(floor, 2 x upstream). Summing upstream first and marking up after would
 * ignore the floor on every cheap call and understate the tab.
 */
import { Router } from 'express';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SISTER_KEYS, SISTER_KEY_NAMES } from '../../payment/config.js';
import { getAccountByApiKey } from '../../payment/credits.js';
import { publishedRates, MARKUP } from '../../payment/pricing.js';
import { measuredCostPerRun } from '../apifyCost.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', '..', '..', 'usage.db'), { readonly: true });

const router = Router();

/**
 * Resolve the caller to the same label the usage log stores, so the tab lines
 * up exactly with what /adm shows for them. Kept in step with resolveApp() in
 * usage.ts — if these two disagree, a caller sees someone else's spend or none
 * of their own.
 */
function resolveApp(req: any): string | null {
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
  return null;
}

const windowStmt = db.prepare(
  `SELECT COUNT(*) requests,
          COALESCE(SUM(billable_usd), 0) tab,
          COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) failed
   FROM request_log
   WHERE app = ? AND created_at >= ? AND created_at < ?`,
);
const allTimeStmt = db.prepare(
  `SELECT COUNT(*) requests, COALESCE(SUM(billable_usd), 0) tab,
          MIN(created_at) since,
          COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) failed
   FROM request_log WHERE app = ?`,
);
const byEndpointStmt = db.prepare(
  `SELECT endpoint, detail, COUNT(*) requests, COALESCE(SUM(billable_usd), 0) tab
   FROM request_log
   WHERE app = ? AND created_at >= ?
   GROUP BY endpoint, detail ORDER BY tab DESC LIMIT 25`,
);

/** SQLite's datetime() is UTC, and created_at is written by it — match that. */
function utcDayStart(offsetDays = 0): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function windowFor(app: string, from: string, to: string) {
  const r = windowStmt.get(app, from, to) as { requests: number; tab: number; failed: number };
  return { requests: r.requests, failedRequests: r.failed, tabUsd: +r.tab.toFixed(4) };
}

router.get('/', (req, res) => {
  const app = resolveApp(req);
  if (!app) {
    res.status(401).json({
      ok: false,
      error: 'Send x-api-key or x-wallet-address to see your spend.',
    });
    return;
  }

  const todayStart = utcDayStart(0);
  const yesterdayStart = utcDayStart(-1);
  const weekStart = utcDayStart(-7);
  const farFuture = '9999-12-31 23:59:59';

  const all = allTimeStmt.get(app) as { requests: number; tab: number; since: string | null; failed: number };

  res.json({
    ok: true,
    app,
    currency: 'USD',
    pricing: {
      model: 'cost-plus',
      markupPct: (MARKUP - 1) * 100,
      note: 'price = max(endpoint floor, 2 x measured upstream cost), applied per request',
    },
    billed: !!(req.headers['x-api-key'] && !SISTER_KEYS.has(req.headers['x-api-key'] as string)),
    windows: {
      today: windowFor(app, todayStart, farFuture),
      yesterday: windowFor(app, yesterdayStart, todayStart),
      last7Days: windowFor(app, weekStart, farFuture),
      allTime: {
        requests: all.requests,
        failedRequests: all.failed,
        tabUsd: +all.tab.toFixed(4),
        since: all.since,
      },
    },
    topEndpoints7d: (byEndpointStmt.all(app, weekStart) as Array<{
      endpoint: string; detail: string | null; requests: number; tab: number;
    }>).map((r) => ({
      endpoint: r.endpoint,
      variant: r.detail && r.detail.length <= 20 ? r.detail : undefined,
      requests: r.requests,
      tabUsd: +r.tab.toFixed(4),
    })),
  });
});

/** GET /api/v1/spend/rates — the published price list. Public. */
router.get('/rates', (_req, res) => {
  res.json({
    ok: true,
    model: 'cost-plus',
    markupPct: (MARKUP - 1) * 100,
    note: 'price = max(endpoint floor, 2 x measured upstream). Social search is priced per platform because upstream cost varies ~7x between them.',
    rates: publishedRates((p) => measuredCostPerRun(p)),
  });
});

export function closeSpendDb(): void {
  db.close();
}

export default router;
