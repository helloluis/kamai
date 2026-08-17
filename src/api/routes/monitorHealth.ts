/**
 * GET /api/health — the machine-readable health contract (o.b11.dev/integrate).
 *
 * Deliberately NOT the existing /health, which answers "is the process up".
 * That one returned ok:true for the entire 22 hours the Instagram actor was
 * dead, which is precisely the failure this endpoint exists to catch: kamai
 * can be perfectly alive and still be returning nothing for half its channels.
 *
 * Two rules that look like bugs and are not:
 *   1. An unhealthy service still answers HTTP 200. The body carries the
 *      verdict; a non-200 is reserved for "this endpoint is broken", which is
 *      a different alert with a different fix.
 *   2. Nothing defaults to ok. An empty check list and a thrown query both
 *      report down, because silence reading as health is the whole problem.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { Router } from 'express';

import { getAllHealth } from '../actorHealth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read-only handle: this endpoint is polled every 60s forever and must never
// be able to write to, lock, or otherwise disturb the live usage database.
const db = new Database(join(__dirname, '..', '..', '..', 'usage.db'), {
  readonly: true,
});

type HealthState = 'ok' | 'warn' | 'down';

interface Check {
  key: string;
  label: string;
  state: HealthState;
  detail: string;
  value?: number;
  since?: string;
}

const RANK: Record<HealthState, number> = { ok: 0, warn: 1, down: 2 };

/** Constant-time compare; hashing first sidesteps the equal-length requirement. */
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/** Turn a thrown query into a `down` check rather than a 500. */
function guard(key: string, label: string, produce: () => Check[]): Check[] {
  try {
    return produce();
  } catch (err) {
    return [
      {
        key: `${key}.error`,
        label,
        state: 'down',
        detail: `Health query failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}

/**
 * Per-platform search actors. kamai already probes these on a backoff
 * schedule; this just exposes what it already knows, so an actor that has
 * quietly stopped working becomes an alert instead of a row in a table nobody
 * reads.
 */
function actorChecks(): Check[] {
  const rows = getAllHealth();
  if (rows.length === 0) {
    return [
      {
        key: 'actor.none',
        label: 'Search actors',
        state: 'down',
        detail: 'No actor health rows at all — the health scheduler has never run.',
      },
    ];
  }

  return rows.map((a) => {
    const staleHours = a.checkedAt
      ? (Date.now() - Date.parse(a.checkedAt)) / 3_600_000
      : Infinity;

    let state: HealthState = 'ok';
    let detail = `Collecting normally (${a.latencyMs}ms).`;

    if (!a.ok) {
      state = 'down';
      const fails = a.consecutiveFailures ?? 0;
      detail =
        `${a.actor} is failing` +
        (fails ? ` (${fails} consecutive)` : '') +
        (a.error ? ` — ${a.error.slice(0, 140)}` : '');
    } else if (staleHours > 48) {
      // A healthy actor that has not been probed in two days is not evidence
      // of health; it is evidence the prober stopped.
      state = 'warn';
      detail = `Last probed ${Math.floor(staleHours)}h ago — the actor health scheduler may have stopped.`;
    }

    return {
      key: `actor.${a.platform}`,
      label: `${a.platform} search actor`,
      state,
      detail,
      value: a.latencyMs,
      ...(state !== 'ok' && a.firstFailedAt ? { since: a.firstFailedAt } : {}),
    };
  });
}

interface EndpointRow {
  endpoint: string;
  n: number;
  errs: number;
}

/**
 * Per-endpoint error rate over 24h. Only endpoints with real traffic are
 * judged — 4 requests of which 4 failed says nothing, and would alert forever
 * on a path nobody uses.
 */
function endpointChecks(): Check[] {
  const rows = db
    .prepare(
      `SELECT endpoint,
              COUNT(*) AS n,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errs
         FROM request_log
        WHERE created_at > datetime('now', '-24 hours')
        GROUP BY endpoint
       HAVING n >= 20`,
    )
    .all() as EndpointRow[];

  return rows.map((r) => {
    const ratio = r.errs / r.n;
    let state: HealthState = 'ok';
    let detail = `${r.n} requests, ${r.errs} failed.`;
    if (ratio > 0.5) {
      state = 'down';
      detail = `${r.errs} of ${r.n} requests failed (${Math.round(ratio * 100)}%).`;
    } else if (ratio > 0.15) {
      state = 'warn';
      detail = `${r.errs} of ${r.n} requests failed (${Math.round(ratio * 100)}%).`;
    }
    return {
      key: `endpoint.${r.endpoint.replace(/^\//, '').replace(/[/:]/g, '-')}`,
      label: r.endpoint,
      state,
      detail,
      value: r.n,
    };
  });
}

/**
 * The usage.db write path. Every request logs a row, so the newest row's age
 * is a proxy for "are we still recording anything at all" — a silent failure
 * that would otherwise make every other check here look artificially healthy,
 * since they all read from this table.
 */
function writePathCheck(): Check[] {
  const row = db
    .prepare(`SELECT created_at FROM request_log ORDER BY id DESC LIMIT 1`)
    .get() as { created_at: string } | undefined;

  if (!row) {
    return [
      {
        key: 'writepath',
        label: 'Usage write path',
        state: 'down',
        detail: 'request_log is empty — nothing has ever been recorded.',
      },
    ];
  }

  const ageHours = (Date.now() - Date.parse(`${row.created_at}Z`)) / 3_600_000;
  let state: HealthState = 'ok';
  let detail = 'Recording requests normally.';
  if (ageHours > 24) {
    state = 'down';
    detail = `Nothing logged for ${Math.floor(ageHours)}h — either every caller stopped or writes are failing.`;
  } else if (ageHours > 6) {
    state = 'warn';
    detail = `Nothing logged for ${Math.floor(ageHours)}h.`;
  }

  return [
    {
      key: 'writepath',
      label: 'Usage write path',
      state,
      detail,
      value: Math.round(ageHours * 10) / 10,
      ...(state !== 'ok' ? { since: `${row.created_at.replace(' ', 'T')}Z` } : {}),
    },
  ];
}

/**
 * Upstream spend anomaly. kamai bills real money to Apify and friends, so a
 * runaway loop is expensive in a way an error rate never shows — a retry storm
 * that succeeds every time looks perfectly healthy and costs a fortune.
 *
 * Compared against the median of the previous 7 days rather than a fixed
 * threshold, so it adapts as usage grows instead of needing a hand-tuned
 * number that goes stale.
 */
function spendCheck(): Check[] {
  const today = (
    db
      .prepare(
        `SELECT COALESCE(SUM(upstream_usd), 0) AS s
           FROM request_log
          WHERE created_at > datetime('now', '-24 hours')`,
      )
      .get() as { s: number }
  ).s;

  const prior = (
    db
      .prepare(
        `SELECT COALESCE(SUM(upstream_usd), 0) AS s
           FROM request_log
          WHERE created_at > datetime('now', '-8 days')
            AND created_at < datetime('now', '-24 hours')
          GROUP BY date(created_at)
          ORDER BY s`,
      )
      .all() as Array<{ s: number }>
  ).map((r) => r.s);

  const usd = Math.round(today * 100) / 100;

  // Too little history to judge against — report the number without a verdict
  // rather than inventing a threshold.
  if (prior.length < 3) {
    return [
      {
        key: 'spend.upstream',
        label: 'Upstream spend (24h)',
        state: 'ok',
        detail: `$${usd} in the last 24h; not enough history to compare.`,
        value: usd,
      },
    ];
  }

  const median = prior[Math.floor(prior.length / 2)];
  const ratio = median > 0 ? today / median : 0;

  let state: HealthState = 'ok';
  let detail = `$${usd} in the last 24h, against a $${Math.round(median * 100) / 100} daily median.`;
  if (ratio > 3) {
    state = 'down';
    detail = `$${usd} in the last 24h — ${ratio.toFixed(1)}× the $${Math.round(median * 100) / 100} daily median.`;
  } else if (ratio > 2) {
    state = 'warn';
    detail = `$${usd} in the last 24h — ${ratio.toFixed(1)}× the $${Math.round(median * 100) / 100} daily median.`;
  }

  return [{ key: 'spend.upstream', label: 'Upstream spend (24h)', state, detail, value: usd }];
}

const router = Router();

router.get('/', (req, res) => {
  // Fail closed: an unset token would publish actor names, error strings and
  // spend figures to anyone who found the URL.
  const expected = process.env.MONITOR_TOKEN?.trim();
  if (!expected) {
    res.status(503).json({ error: 'MONITOR_TOKEN is not configured' });
    return;
  }

  const header = req.get('x-monitor-token')?.trim();
  const query = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const presented = header || query || '';

  if (!presented || !secretsMatch(presented, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const checks: Check[] = [
    ...guard('actor', 'Search actors', actorChecks),
    ...guard('endpoint', 'Endpoints', endpointChecks),
    ...guard('writepath', 'Usage write path', writePathCheck),
    ...guard('spend', 'Upstream spend', spendCheck),
  ];

  // An empty list is the absence of evidence, not health.
  const status: HealthState = checks.length
    ? checks.reduce<HealthState>((worst, c) => (RANK[c.state] > RANK[worst] ? c.state : worst), 'ok')
    : 'down';

  res.set('cache-control', 'no-store').status(200).json({
    app: 'kamai',
    status,
    generatedAt: new Date().toISOString(),
    release: process.env.GIT_SHA || undefined,
    checks: checks.length
      ? checks
      : [
          {
            key: 'health.empty',
            label: 'Health checks',
            state: 'down' as const,
            detail: 'No checks were produced.',
          },
        ],
  });
});

export default router;
