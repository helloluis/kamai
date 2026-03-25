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

// Default price per browse request in USD
export const PRICE_PER_REQUEST = parseFloat(process.env.PRICE_PER_REQUEST || '0.02');

// Convert USD amount to USDC base units (6 decimals)
export function usdToUsdcUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

// Format USDC units to USD string
export function usdcUnitsToUsd(units: bigint): string {
  return (Number(units) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
}