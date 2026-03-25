/**
 * Credit system — SQLite-backed balance tracking per API key.
 *
 * - Users deposit USDC on Celo → verified on-chain → credits added
 * - Each browse request deducts from balance
 * - First API call each day is free
 * - Sister apps (minai, beanie) get 50% discount
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_DEPOSIT, USDC_DECIMALS } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', '..', 'credits.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    api_key TEXT PRIMARY KEY,
    label TEXT,
    balance_usd REAL NOT NULL DEFAULT 0,
    total_deposited_usd REAL NOT NULL DEFAULT 0,
    total_spent_usd REAL NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_request_at TEXT
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    amount_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'verified',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (api_key) REFERENCES accounts(api_key)
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT NOT NULL,
    url TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    had_actions INTEGER NOT NULL DEFAULT 0,
    was_free INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_log (api_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_deposits_key ON deposits (api_key);
`);

// ─── Prepared statements ───

const stmtGetAccount = db.prepare('SELECT * FROM accounts WHERE api_key = ?');
const stmtCreateAccount = db.prepare(
  'INSERT OR IGNORE INTO accounts (api_key, label) VALUES (?, ?)',
);
const stmtAddBalance = db.prepare(
  `UPDATE accounts SET
    balance_usd = balance_usd + ?,
    total_deposited_usd = total_deposited_usd + ?
  WHERE api_key = ?`,
);
const stmtDeductBalance = db.prepare(
  `UPDATE accounts SET
    balance_usd = MAX(0, balance_usd - ?),
    total_spent_usd = total_spent_usd + ?,
    request_count = request_count + 1,
    last_request_at = datetime('now')
  WHERE api_key = ?`,
);
const stmtInsertDeposit = db.prepare(
  'INSERT INTO deposits (api_key, tx_hash, amount_usd) VALUES (?, ?, ?)',
);
const stmtCheckDeposit = db.prepare('SELECT id FROM deposits WHERE tx_hash = ?');
const stmtInsertUsage = db.prepare(
  'INSERT INTO usage_log (api_key, url, cost_usd, had_actions, was_free) VALUES (?, ?, ?, ?, ?)',
);
const stmtLastFreeToday = db.prepare(
  `SELECT id FROM usage_log
   WHERE api_key = ? AND was_free = 1 AND created_at >= date('now')
   LIMIT 1`,
);

// ─── Public API ───

export interface Account {
  api_key: string;
  label: string | null;
  balance_usd: number;
  total_deposited_usd: number;
  total_spent_usd: number;
  request_count: number;
  created_at: string;
  last_request_at: string | null;
}

/** Get or create an account for an API key. */
export function getAccount(apiKey: string): Account {
  stmtCreateAccount.run(apiKey, null);
  return stmtGetAccount.get(apiKey) as Account;
}

/** Check if the user already used their free daily request. */
export function hasUsedDailyFree(apiKey: string): boolean {
  return !!stmtLastFreeToday.get(apiKey);
}

/** Check if a tx hash has already been used as a deposit. */
export function isDepositUsed(txHash: string): boolean {
  return !!stmtCheckDeposit.get(txHash);
}

/** Credit an account after a verified deposit. */
export function creditDeposit(apiKey: string, txHash: string, amountUsd: number): void {
  if (amountUsd < MIN_DEPOSIT) {
    throw new Error(`Minimum deposit is $${MIN_DEPOSIT.toFixed(2)}`);
  }
  stmtCreateAccount.run(apiKey, null);
  stmtInsertDeposit.run(apiKey, txHash, amountUsd);
  stmtAddBalance.run(amountUsd, amountUsd, apiKey);
}

/** Deduct credits for a request. Returns the actual cost charged. */
export function chargeRequest(
  apiKey: string,
  url: string,
  costUsd: number,
  hadActions: boolean,
): { charged: number; wasFree: boolean } {
  // Check daily freebie
  const usedFree = hasUsedDailyFree(apiKey);
  if (!usedFree) {
    stmtInsertUsage.run(apiKey, url, 0, hadActions ? 1 : 0, 1);
    return { charged: 0, wasFree: true };
  }

  // Charge from balance
  stmtDeductBalance.run(costUsd, costUsd, apiKey);
  stmtInsertUsage.run(apiKey, url, costUsd, hadActions ? 1 : 0, 0);
  return { charged: costUsd, wasFree: false };
}

/** Check if account has enough balance for a request. */
export function canAfford(apiKey: string, costUsd: number): boolean {
  const account = getAccount(apiKey);
  // First daily request is always free
  if (!hasUsedDailyFree(apiKey)) return true;
  return account.balance_usd >= costUsd;
}

/** Close the database (for graceful shutdown). */
export function closeCreditsDb(): void {
  db.close();
}