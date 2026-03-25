/**
 * x402 Payment Middleware for Express.
 *
 * Implements the x402 protocol flow on Celo:
 * 1. If no payment header → return 402 with PAYMENT-REQUIRED header
 * 2. If payment header present → verify tx on-chain → allow or reject
 *
 * Supports two modes:
 * - x402 standard: PAYMENT-SIGNATURE header with tx hash
 * - Simple mode: x-payment-tx header with just the tx hash (easier for LLM agents)
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyPayment } from './verifier.js';
import {
  CELO_NETWORK,
  USDC_ADDRESS,
  PAYMENT_RECIPIENT,
  PRICE_PER_REQUEST,
  usdToUsdcUnits,
} from './config.js';

// Cache of verified tx hashes to avoid re-checking
const verifiedTxCache = new Set<string>();

function buildPaymentRequired(path: string): object {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { method: 'POST', url: path },
    accepts: [
      {
        scheme: 'exact',
        network: CELO_NETWORK,
        asset: USDC_ADDRESS,
        amount: usdToUsdcUnits(PRICE_PER_REQUEST).toString(),
        payTo: PAYMENT_RECIPIENT,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '2',
          description: `kamAI browse request — $${PRICE_PER_REQUEST} per request`,
        },
      },
    ],
  };
}

export function paymentRequired(priceUsd?: number) {
  const price = priceUsd ?? PRICE_PER_REQUEST;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip payment check if no recipient configured (free mode)
    if (!PAYMENT_RECIPIENT) return next();

    // Check for payment proof in headers
    const txHash =
      (req.headers['x-payment-tx'] as string) || // Simple mode
      extractTxFromPaymentSignature(req.headers['payment-signature'] as string); // x402 mode

    if (!txHash) {
      // No payment — return 402
      const paymentRequired = buildPaymentRequired(req.path);
      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');
      res.status(402)
        .setHeader('PAYMENT-REQUIRED', encoded)
        .json(paymentRequired);
      return;
    }

    // Check cache first
    if (verifiedTxCache.has(txHash.toLowerCase())) {
      return next();
    }

    // Verify on-chain
    const result = await verifyPayment(txHash as `0x${string}`, price);

    if (!result.valid) {
      res.status(402).json({
        ok: false,
        error: 'Payment verification failed',
        details: result.error,
        txHash,
      });
      return;
    }

    // Cache successful verification
    verifiedTxCache.add(txHash.toLowerCase());

    // Add payment info to response headers
    const receipt = Buffer.from(JSON.stringify({
      txHash,
      amount: result.amount,
      from: result.from,
      network: CELO_NETWORK,
    })).toString('base64');
    res.setHeader('PAYMENT-RESPONSE', receipt);

    console.log(`[Payment] Verified $${result.amount} from ${result.from} (tx: ${txHash.slice(0, 18)}...)`);
    next();
  };
}

/**
 * Extract tx hash from a base64-encoded PAYMENT-SIGNATURE header.
 */
function extractTxFromPaymentSignature(header?: string): string | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    return decoded.payload?.txHash || decoded.txHash || null;
  } catch {
    // Maybe it's just a raw tx hash
    if (header.startsWith('0x') && header.length === 66) return header;
    return null;
  }
}

// Clean up cache periodically (keep last 10k entries)
setInterval(() => {
  if (verifiedTxCache.size > 10000) {
    const entries = Array.from(verifiedTxCache);
    entries.slice(0, entries.length - 5000).forEach((h) => verifiedTxCache.delete(h));
  }
}, 300_000);