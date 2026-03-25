/**
 * Payment Middleware — credit-based with x402 fallback.
 *
 * Flow:
 * 1. Check API key → get account
 * 2. First request of the day → free (no charge)
 * 3. Has credits → deduct and proceed
 * 4. No credits → return 402 Payment Required
 *
 * Sister apps (minai, beanie) get 50% discount.
 */
import type { Request, Response, NextFunction } from 'express';
import { getAccount, canAfford, chargeRequest } from './credits.js';
import {
  CELO_NETWORK,
  USDC_ADDRESS,
  PAYMENT_RECIPIENT,
  SISTER_KEYS,
  MIN_DEPOSIT,
  getRequestPrice,
  usdToUsdcUnits,
} from './config.js';

export function creditPayment() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
      res.status(401).json({ ok: false, error: 'Missing x-api-key header' });
      return;
    }

    // Determine pricing
    const hasActions = Array.isArray(req.body?.actions) && req.body.actions.length > 0;
    const isSister = SISTER_KEYS.has(apiKey);
    const cost = getRequestPrice(hasActions, isSister);

    // Check if user can afford it (includes daily freebie check)
    if (!canAfford(apiKey, cost)) {
      const account = getAccount(apiKey);
      res.status(402).json({
        ok: false,
        error: 'Insufficient credits',
        balance: account.balance_usd,
        cost,
        minimumDeposit: MIN_DEPOSIT,
        depositEndpoint: '/api/v1/deposit',
        depositInfo: {
          network: CELO_NETWORK,
          asset: USDC_ADDRESS,
          payTo: PAYMENT_RECIPIENT,
          minimumAmount: usdToUsdcUnits(MIN_DEPOSIT).toString(),
          description: `Send at least $${MIN_DEPOSIT.toFixed(2)} USDC on Celo to ${PAYMENT_RECIPIENT}, then POST the tx hash to /api/v1/deposit`,
        },
      });
      return;
    }

    // Charge after the request succeeds (attach to res.on('finish'))
    const url = req.body?.url || 'unknown';

    res.on('finish', () => {
      // Only charge for successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const { charged, wasFree } = chargeRequest(apiKey, url, cost, hasActions);
        if (wasFree) {
          console.log(`[Credits] FREE daily request for ${apiKey.slice(0, 12)}... → ${url}`);
        } else if (charged > 0) {
          const discount = isSister ? ' (sister 50% off)' : '';
          console.log(`[Credits] -$${charged.toFixed(3)}${discount} from ${apiKey.slice(0, 12)}... → ${url}`);
        }
      }
    });

    // Add pricing info to response headers
    res.setHeader('X-Request-Cost', cost.toFixed(3));
    if (isSister) res.setHeader('X-Sister-Discount', '50%');

    next();
  };
}

/**
 * Legacy x402 per-request payment (kept for protocol compatibility).
 * Use creditPayment() for production.
 */
export { paymentRequired } from './middleware-x402.js';