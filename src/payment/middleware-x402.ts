/**
 * Legacy x402 per-request payment middleware.
 * Kept for protocol compatibility — use creditPayment() for production.
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyPayment } from './verifier.js';
import {
  CELO_NETWORK,
  USDC_ADDRESS,
  PAYMENT_RECIPIENT,
  PRICE_BROWSE,
  usdToUsdcUnits,
} from './config.js';

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
        amount: usdToUsdcUnits(PRICE_BROWSE).toString(),
        payTo: PAYMENT_RECIPIENT,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '2',
          description: `kamAI browse request — $${PRICE_BROWSE} per request`,
        },
      },
    ],
  };
}

export function paymentRequired(priceUsd?: number) {
  const price = priceUsd ?? PRICE_BROWSE;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!PAYMENT_RECIPIENT) return next();

    const txHash =
      (req.headers['x-payment-tx'] as string) ||
      extractTxFromPaymentSignature(req.headers['payment-signature'] as string);

    if (!txHash) {
      const pr = buildPaymentRequired(req.path);
      const encoded = Buffer.from(JSON.stringify(pr)).toString('base64');
      res.status(402).setHeader('PAYMENT-REQUIRED', encoded).json(pr);
      return;
    }

    if (verifiedTxCache.has(txHash.toLowerCase())) return next();

    const result = await verifyPayment(txHash as `0x${string}`, price);
    if (!result.valid) {
      res.status(402).json({ ok: false, error: 'Payment verification failed', details: result.error, txHash });
      return;
    }

    verifiedTxCache.add(txHash.toLowerCase());
    const receipt = Buffer.from(JSON.stringify({ txHash, amount: result.amount, from: result.from, network: CELO_NETWORK })).toString('base64');
    res.setHeader('PAYMENT-RESPONSE', receipt);

    console.log(`[x402] Verified $${result.amount} from ${result.from} (tx: ${txHash.slice(0, 18)}...)`);
    next();
  };
}

function extractTxFromPaymentSignature(header?: string): string | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    return decoded.payload?.txHash || decoded.txHash || null;
  } catch {
    if (header.startsWith('0x') && header.length === 66) return header;
    return null;
  }
}

setInterval(() => {
  if (verifiedTxCache.size > 10000) {
    const entries = Array.from(verifiedTxCache);
    entries.slice(0, entries.length - 5000).forEach((h) => verifiedTxCache.delete(h));
  }
}, 300_000);