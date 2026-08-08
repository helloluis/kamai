/**
 * Persistent actor health + failure log.
 *
 * Health state used to live in a plain in-memory Map, which had three costs:
 *
 *  1. Every restart re-probed every actor from scratch, including ones that
 *     had been failing for days — and runActorHealthChecks() does TWO runs per
 *     actor (initial plus a 20s retry). Across ~22 restarts in one day that
 *     alone accounted for most of Instagram's 66 billed runs against a single
 *     successful request.
 *  2. A fixed 1h re-probe meant a permanently dead actor was retried 24x/day
 *     forever, at full run cost each time, with no escalation.
 *  3. There was no history, so "this actor is dead, replace it" was a judgement
 *     call rather than a number.
 *
 * This module persists health across restarts, backs off exponentially while an
 * actor keeps failing, and keeps a failure log so the decision to swap an actor
 * is evidence-based. Re-probing still happens — that is what heals the circuit
 * when a vendor recovers — it just gets cheaper the longer something stays down.
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', '..', 'usage.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS actor_health (
    platform TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    latency_ms INTEGER,
    checked_at TEXT,
    first_failed_at TEXT,
    next_probe_at TEXT
  );
  CREATE TABLE IF NOT EXISTS actor_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    actor TEXT NOT NULL,
    error TEXT,
    latency_ms INTEGER,
    origin TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_actor_failures ON actor_failures (platform, created_at);
`);

/** Where a failure was observed — a live call failing matters more than a probe. */
export type FailureOrigin = 'health-check' | 'live-call' | 'probe';

export interface ActorHealth {
  platform: string;
  actor: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: string;
  consecutiveFailures?: number;
  nextProbeAt?: string;
  firstFailedAt?: string;
}

/**
 * Backoff schedule. Starts at the old fixed 1h so a blip still recovers fast,
 * then doubles per consecutive failure to a 24h ceiling: 1h, 2h, 4h, 8h, 16h,
 * 24h… A dead actor therefore costs ~1 probe/day instead of 24.
 */
const BASE_REPROBE_MS = 60 * 60 * 1000;
const MAX_REPROBE_MS = 24 * 60 * 60 * 1000;

function backoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(BASE_REPROBE_MS * 2 ** (n - 1), MAX_REPROBE_MS);
}

const getStmt = db.prepare(`SELECT * FROM actor_health WHERE platform = ?`);
const allStmt = db.prepare(`SELECT * FROM actor_health ORDER BY platform`);
const upsertStmt = db.prepare(`
  INSERT INTO actor_health
    (platform, actor, ok, consecutive_failures, last_error, latency_ms, checked_at, first_failed_at, next_probe_at)
  VALUES (@platform, @actor, @ok, @consecutive_failures, @last_error, @latency_ms, @checked_at, @first_failed_at, @next_probe_at)
  ON CONFLICT(platform) DO UPDATE SET
    actor = @actor, ok = @ok, consecutive_failures = @consecutive_failures,
    last_error = @last_error, latency_ms = @latency_ms, checked_at = @checked_at,
    first_failed_at = @first_failed_at, next_probe_at = @next_probe_at
`);
const logFailStmt = db.prepare(
  `INSERT INTO actor_failures (platform, actor, error, latency_ms, origin) VALUES (?, ?, ?, ?, ?)`,
);
const failCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM actor_failures WHERE platform = ? AND created_at >= datetime('now', ?)`,
);
const recentFailuresStmt = db.prepare(
  `SELECT error, origin, created_at FROM actor_failures WHERE platform = ? ORDER BY id DESC LIMIT ?`,
);

interface Row {
  platform: string; actor: string; ok: number; consecutive_failures: number;
  last_error: string | null; latency_ms: number | null; checked_at: string | null;
  first_failed_at: string | null; next_probe_at: string | null;
}

function toHealth(r: Row): ActorHealth {
  return {
    platform: r.platform,
    actor: r.actor,
    ok: !!r.ok,
    latencyMs: r.latency_ms ?? 0,
    error: r.last_error ?? undefined,
    checkedAt: r.checked_at ?? new Date(0).toISOString(),
    consecutiveFailures: r.consecutive_failures,
    nextProbeAt: r.next_probe_at ?? undefined,
    firstFailedAt: r.first_failed_at ?? undefined,
  };
}

/** Record an outcome. Failures also append to the failure log for later analysis. */
export function recordOutcome(
  platform: string,
  actor: string,
  ok: boolean,
  latencyMs: number,
  error: string | undefined,
  origin: FailureOrigin,
): void {
  const prev = getStmt.get(platform) as Row | undefined;
  const now = new Date();
  const consecutive = ok ? 0 : (prev?.consecutive_failures ?? 0) + 1;

  upsertStmt.run({
    platform,
    actor,
    ok: ok ? 1 : 0,
    consecutive_failures: consecutive,
    last_error: ok ? null : (error ?? '').slice(0, 300),
    latency_ms: Math.round(latencyMs),
    checked_at: now.toISOString(),
    // Retained across a recovery so "how long has this been flaky" survives.
    first_failed_at: ok ? null : (prev?.first_failed_at ?? now.toISOString()),
    next_probe_at: ok ? null : new Date(now.getTime() + backoffMs(consecutive)).toISOString(),
  });

  if (!ok) {
    logFailStmt.run(platform, actor, (error ?? '').slice(0, 300), Math.round(latencyMs), origin);
  }
}

/**
 * Should a live call attempt this actor now? Healthy and never-seen actors
 * always pass; a failing one passes only once its backoff window has elapsed.
 */
export function shouldAttempt(platform: string): boolean {
  const r = getStmt.get(platform) as Row | undefined;
  if (!r || r.ok) return true;
  if (!r.next_probe_at) return true;
  return Date.now() >= Date.parse(r.next_probe_at);
}

/** Is this actor known-bad right now? Used to skip the costly retry. */
export function isKnownFailing(platform: string): boolean {
  const r = getStmt.get(platform) as Row | undefined;
  return !!r && !r.ok && (r.consecutive_failures ?? 0) >= 2;
}

/** True when a scheduled health check should actually spend money on this actor. */
export function dueForHealthCheck(platform: string): boolean {
  return shouldAttempt(platform);
}

export function getAllHealth(): ActorHealth[] {
  return (allStmt.all() as Row[]).map(toHealth);
}

/**
 * Per-actor report with an explicit recommendation, so replacing an actor is a
 * decision backed by numbers rather than a hunch.
 */
export function actorReport(
  costPerRun?: (platform: string) => number | null,
  /** Real override env var for a platform — the caller owns the registry. */
  envVarFor?: (platform: string) => string | null,
): Array<{
  platform: string; actor: string; ok: boolean; consecutiveFailures: number;
  failures24h: number; failures7d: number; firstFailedAt?: string; nextProbeAt?: string;
  lastError?: string; wastedUsd?: number; recommendation: string;
}> {
  return (allStmt.all() as Row[]).map((r) => {
    const f24 = (failCountStmt.get(r.platform, '-1 day') as { n: number }).n;
    const f7 = (failCountStmt.get(r.platform, '-7 days') as { n: number }).n;
    const per = costPerRun?.(r.platform) ?? null;
    const downHours = r.first_failed_at
      ? (Date.now() - Date.parse(r.first_failed_at)) / 3_600_000
      : 0;

    let recommendation = 'healthy';
    if (!r.ok) {
      if (r.consecutive_failures >= 10 || downHours >= 72) {
        // Must be the registry's real actorEnv: the platform names do not map
        // to it (facebook -> APIFY_FB_…, tiktok -> APIFY_TT_…), so guessing
        // would print an env var that does nothing.
        const env = envVarFor?.(r.platform) ?? null;
        recommendation =
          `REPLACE — failing ${r.consecutive_failures}x over ${downHours.toFixed(0)}h` +
          (env ? `; set ${env} to an alternative actor` : '');
      } else if (r.consecutive_failures >= 3) {
        recommendation = `WATCH — ${r.consecutive_failures} consecutive failures, backing off to ${new Date(r.next_probe_at ?? Date.now()).toISOString()}`;
      } else {
        recommendation = 'transient — still probing on the short backoff';
      }
    }
    return {
      platform: r.platform,
      actor: r.actor,
      ok: !!r.ok,
      consecutiveFailures: r.consecutive_failures,
      failures24h: f24,
      failures7d: f7,
      firstFailedAt: r.first_failed_at ?? undefined,
      nextProbeAt: r.next_probe_at ?? undefined,
      lastError: r.last_error ?? undefined,
      wastedUsd: per !== null ? +(f7 * per).toFixed(4) : undefined,
      recommendation,
    };
  });
}

export function recentFailures(platform: string, limit = 10): Array<{ error: string; origin: string; created_at: string }> {
  return recentFailuresStmt.all(platform, limit) as Array<{ error: string; origin: string; created_at: string }>;
}

export function closeActorHealthDb(): void {
  db.close();
}
