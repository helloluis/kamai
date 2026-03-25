/**
 * HD wallet — derives unique deposit addresses per customer.
 *
 * Uses BIP-44 derivation: m/44'/60'/0'/0/{index}
 * Each account gets a deterministic index based on their wallet address.
 * The WALLET_SEED env var holds the mnemonic (never logged, never committed).
 */
import { mnemonicToAccount } from 'viem/accounts';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reuse the credits DB for deposit address mapping
const db = new Database(join(__dirname, '..', '..', 'credits.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS deposit_addresses (
    wallet TEXT PRIMARY KEY,
    deposit_address TEXT NOT NULL UNIQUE,
    derivation_index INTEGER NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const stmtGetByWallet = db.prepare('SELECT deposit_address, derivation_index FROM deposit_addresses WHERE wallet = ?');
const stmtGetByDeposit = db.prepare('SELECT wallet FROM deposit_addresses WHERE deposit_address = ?');
const stmtGetMaxIndex = db.prepare('SELECT MAX(derivation_index) as max_idx FROM deposit_addresses');
const stmtInsert = db.prepare('INSERT OR IGNORE INTO deposit_addresses (wallet, deposit_address, derivation_index) VALUES (?, ?, ?)');

function getSeed(): string {
  const seed = process.env.WALLET_SEED;
  if (!seed) throw new Error('WALLET_SEED not configured');
  return seed;
}

/**
 * Derive a deposit address for a customer wallet.
 * Returns the same address on repeated calls (deterministic).
 */
export function getDepositAddress(customerWallet: string): { depositAddress: string; derivationIndex: number } {
  const normalized = customerWallet.toLowerCase();

  // Check if already assigned
  const existing = stmtGetByWallet.get(normalized) as { deposit_address: string; derivation_index: number } | undefined;
  if (existing) {
    return { depositAddress: existing.deposit_address, derivationIndex: existing.derivation_index };
  }

  // Derive next index
  const { max_idx } = stmtGetMaxIndex.get() as { max_idx: number | null };
  const nextIndex = (max_idx ?? -1) + 1;

  // Derive address from seed
  const account = mnemonicToAccount(getSeed(), { addressIndex: nextIndex });
  const depositAddress = account.address.toLowerCase();

  // Store mapping
  stmtInsert.run(normalized, depositAddress, nextIndex);

  console.log(`[Wallet] Derived deposit address #${nextIndex} for ${normalized.slice(0, 10)}...`);

  return { depositAddress, derivationIndex: nextIndex };
}

/**
 * Look up which customer wallet owns a deposit address.
 * Used when scanning on-chain transfers to auto-credit accounts.
 */
export function resolveDepositAddress(depositAddress: string): string | null {
  const row = stmtGetByDeposit.get(depositAddress.toLowerCase()) as { wallet: string } | undefined;
  return row?.wallet ?? null;
}

/**
 * Get the master wallet address (index 0, used as the sweep destination).
 */
export function getMasterAddress(): string {
  const account = mnemonicToAccount(getSeed(), { addressIndex: 0 });
  return account.address;
}

/**
 * Validate that the configured seed produces the expected master address.
 * Call at startup to catch misconfiguration early.
 */
export function validateSeed(expectedAddress: string): boolean {
  try {
    const master = getMasterAddress();
    return master.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}
