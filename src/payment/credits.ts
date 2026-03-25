/**
 * Credit system — SQLite-backed balance tracking per wallet address.
 *
 * - Wallet address is the primary account identity
 * - Optional API key links to a wallet (for multi-agent orgs)
 * - Users deposit USDC on Celo → verified on-chain → credits added
 * - Each browse request deducts from balance
 * - First API call each day is free
 * - Sister wallets/keys get 50% discount
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { MIN_DEPOSIT } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', '..', 'credits.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    wallet TEXT PRIMARY KEY,
    api_key TEXT UNIQUE,
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
    wallet TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    amount_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'verified',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (wallet) REFERENCES accounts(wallet)
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    url TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    had_actions INTEGER NOT NULL DEFAULT 0,
    was_free INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_api_key ON accounts (api_key);
  CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_log (wallet, created_at);
  CREATE INDEX IF NOT EXISTS idx_deposits_wallet ON deposits (wallet);
`);

// ─── Prepared statements ───

const stmtGetByWallet = db.prepare('SELECT * FROM accounts WHERE wallet = ?');
const stmtGetByApiKey = db.prepare('SELECT * FROM accounts WHERE api_key = ?');
const stmtCreateAccount = db.prepare(
  'INSERT OR IGNORE INTO accounts (wallet, label) VALUES (?, ?)',
);
const stmtSetApiKey = db.prepare('UPDATE accounts SET api_key = ? WHERE wallet = ?');
const stmtAddBalance = db.prepare(
  `UPDATE accounts SET
    balance_usd = balance_usd + ?,
    total_deposited_usd = total_deposited_usd + ?
  WHERE wallet = ?`,
);
const stmtDeductBalance = db.prepare(
  `UPDATE accounts SET
    balance_usd = MAX(0, balance_usd - ?),
    total_spent_usd = total_spent_usd + ?,
    request_count = request_count + 1,
    last_request_at = datetime('now')
  WHERE wallet = ?`,
);
const stmtInsertDeposit = db.prepare(
  'INSERT INTO deposits (wallet, tx_hash, amount_usd) VALUES (?, ?, ?)',
);
const stmtCheckDeposit = db.prepare('SELECT id FROM deposits WHERE tx_hash = ?');
const stmtInsertUsage = db.prepare(
  'INSERT INTO usage_log (wallet, url, cost_usd, had_actions, was_free) VALUES (?, ?, ?, ?, ?)',
);
const stmtLastFreeToday = db.prepare(
  `SELECT id FROM usage_log
   WHERE wallet = ? AND was_free = 1 AND created_at >= date('now')
   LIMIT 1`,
);

// ─── Public API ───

export interface Account {
  wallet: string;
  api_key: string | null;
  label: string | null;
  balance_usd: number;
  total_deposited_usd: number;
  total_spent_usd: number;
  request_count: number;
  created_at: string;
  last_request_at: string | null;
}

/**
 * Resolve an identity (wallet address or API key) to a wallet address.
 * Creates the account if it's a wallet address that doesn't exist yet.
 */
export function resolveWallet(identity: string): string | null {
  const normalized = identity.trim().toLowerCase();

  // Looks like a wallet address
  if (normalized.startsWith('0x') && normalized.length === 42) {
    stmtCreateAccount.run(normalized, null);
    return normalized;
  }

  // Try as API key
  const account = stmtGetByApiKey.get(identity) as Account | undefined;
  return account?.wallet ?? null;
}

/** Get account by wallet address. */
export function getAccount(wallet: string): Account {
  stmtCreateAccount.run(wallet.toLowerCase(), null);
  return stmtGetByWallet.get(wallet.toLowerCase()) as Account;
}

/** Get account by API key. */
export function getAccountByApiKey(apiKey: string): Account | null {
  return (stmtGetByApiKey.get(apiKey) as Account) ?? null;
}

/** Generate a new API key for a wallet. Replaces any existing key. */
export function generateApiKey(wallet: string): string {
  const normalized = wallet.toLowerCase();
  stmtCreateAccount.run(normalized, null);
  const key = 'kam_' + randomBytes(24).toString('base64url');
  stmtSetApiKey.run(key, normalized);
  return key;
}

/** Check if the user already used their free daily request. */
export function hasUsedDailyFree(wallet: string): boolean {
  return !!stmtLastFreeToday.get(wallet);
}

/** Check if a tx hash has already been used as a deposit. */
export function isDepositUsed(txHash: string): boolean {
  return !!stmtCheckDeposit.get(txHash);
}

/** Credit an account after a verified deposit. */
export function creditDeposit(wallet: string, txHash: string, amountUsd: number): void {
  if (amountUsd < MIN_DEPOSIT) {
    throw new Error(`Minimum deposit is $${MIN_DEPOSIT.toFixed(2)}`);
  }
  const normalized = wallet.toLowerCase();
  stmtCreateAccount.run(normalized, null);
  stmtInsertDeposit.run(normalized, txHash, amountUsd);
  stmtAddBalance.run(amountUsd, amountUsd, normalized);
}

/** Deduct credits for a request. Returns the actual cost charged. */
export function chargeRequest(
  wallet: string,
  url: string,
  costUsd: number,
  hadActions: boolean,
): { charged: number; wasFree: boolean } {
  const usedFree = hasUsedDailyFree(wallet);
  if (!usedFree) {
    stmtInsertUsage.run(wallet, url, 0, hadActions ? 1 : 0, 1);
    return { charged: 0, wasFree: true };
  }

  stmtDeductBalance.run(costUsd, costUsd, wallet);
  stmtInsertUsage.run(wallet, url, costUsd, hadActions ? 1 : 0, 0);
  return { charged: costUsd, wasFree: false };
}

/** Check if account has enough balance for a request. */
export function canAfford(wallet: string, costUsd: number): boolean {
  const account = getAccount(wallet);
  if (!hasUsedDailyFree(wallet)) return true;
  return account.balance_usd >= costUsd;
}

/** Close the database (for graceful shutdown). */
export function closeCreditsDb(): void {
  db.close();
}