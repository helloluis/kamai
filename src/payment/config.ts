/**
 * Payment configuration for Celo USDC.
 */

// Celo Mainnet
export const CELO_CHAIN_ID = 42220;
export const CELO_NETWORK = `eip155:${CELO_CHAIN_ID}`;
export const CELO_RPC_URL = process.env.CELO_RPC_URL || 'https://forno.celo.org';

// USDC on Celo (native, 6 decimals)
export const USDC_ADDRESS = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as `0x${string}`;
export const USDC_DECIMALS = 6;

// cUSD on Celo (18 decimals)
export const CUSD_ADDRESS = '0x765DE816845861e75A25fCA122bb6898B8B1282a' as `0x${string}`;
export const CUSD_DECIMALS = 18;

// Payment recipient — the kamAI wallet
export const PAYMENT_RECIPIENT = (process.env.PAYMENT_RECIPIENT_ADDRESS || '') as `0x${string}`;

// ─── Pricing ───

/** Simple page load — navigate + extract, no actions */
export const PRICE_BROWSE = 0.009;

/** Browse with actions — type, click, submit, etc. */
export const PRICE_ACTIONS = 0.013;

/** Minimum deposit to create an account */
export const MIN_DEPOSIT = 0.10;

/** Sister app API keys get 50% discount */
export const SISTER_DISCOUNT = 0.5;

/**
 * Sister app identifiers (API keys that bypass payment).
 * Entries may be plain keys or `name:key` pairs — the name is used to
 * label the app on the /adm dashboard. Matching always uses the key part.
 */
export const SISTER_KEYS = new Set<string>();
/** API key → app name, for `name:key` entries in SISTER_API_KEYS. */
export const SISTER_KEY_NAMES = new Map<string, string>();
for (const entry of (process.env.SISTER_API_KEYS || '').split(',')) {
  const trimmed = entry.trim();
  if (!trimmed) continue;
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const name = trimmed.slice(0, colon).trim();
    const key = trimmed.slice(colon + 1).trim();
    if (key) {
      SISTER_KEYS.add(key);
      if (name) SISTER_KEY_NAMES.set(key, name);
    }
  } else {
    SISTER_KEYS.add(trimmed);
  }
}

// ─── Helpers ───

/** Convert USD amount to USDC base units (6 decimals) */
export function usdToUsdcUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

/** Format USDC units to USD string */
export function usdcUnitsToUsd(units: bigint): string {
  return (Number(units) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
}

/** Brochure PDF generation */
export const PRICE_BROCHURE = 0.05;

/** Web/image search via Brave proxy (Brave Pro: $5/mo flat → ~$0.0003/call, marked up) */
export const PRICE_SEARCH = 0.003;

/**
 * Screenshot capture. Sits just above browse ($0.009) because it is a browse
 * plus a render, and nowhere near brochure ($0.050). Upstream is ~$0.0002 of
 * VPS compute for embed/page routes; only the Reddit tier (Apify) costs real
 * money, and that is a small share of traffic.
 */
export const PRICE_SCREENSHOT = 0.015;

/**
 * Image generation floor. Every generation has real upstream cost
 * ($0.03-$0.19/image), so the 2x markup nearly always exceeds this — the
 * floor exists only to catch a provider mispricing to ~zero.
 */
export const PRICE_IMAGE = 0.02;

/** Get the price for a request based on whether it has actions */
export function getRequestPrice(hasActions: boolean, isSister: boolean): number {
  const base = hasActions ? PRICE_ACTIONS : PRICE_BROWSE;
  return isSister ? base * SISTER_DISCOUNT : base;
}