/**
 * Payment Middleware — credit-based with wallet-first identity.
 *
 * Identity resolution (checked in order):
 *   1. x-wallet-address header → wallet address directly
 *   2. x-api-key header → look up linked wallet
 *
 * Flow:
 *   1. Resolve identity → get wallet
 *   2. First request of the day → free (no charge)
 *   3. Has credits → deduct and proceed
 *   4. No credits → return 402 with deposit instructions
 *
 * Sister wallets/keys get 50% discount.
 */
import type { Request, Response, NextFunction } from 'express';
import { resolveWallet, getAccount, canAfford, chargeRequest } from './credits.js';
import {
  CELO_NETWORK,
  USDC_ADDRESS,
  PAYMENT_RECIPIENT,
  SISTER_KEYS,
  MIN_DEPOSIT,
  getRequestPrice,
  usdToUsdcUnits,
} from './config.js';

/** Resolve the caller's wallet from request headers. */
function getCallerWallet(req: Request): string | null {
  const walletHeader = req.headers['x-wallet-address'] as string | undefined;
  if (walletHeader) return resolveWallet(walletHeader);

  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) return resolveWallet(apiKey);

  return null;
}

/** Check if the caller is a sister app. */
function isSisterCaller(req: Request): boolean {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const wallet = (req.headers['x-wallet-address'] as string)?.toLowerCase();
  return (apiKey ? SISTER_KEYS.has(apiKey) : false) || (wallet ? SISTER_KEYS.has(wallet) : false);
}

// Demo wallet — gets free requests (used by the landing page "try it" feature)
const DEMO_WALLET = '0x0000000000000000000000000000000000000000';

export function creditPayment() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const wallet = getCallerWallet(req);
    if (!wallet) {
      res.status(401).json({
        ok: false,
        error: 'Missing identity. Send x-wallet-address or x-api-key header.',
      });
      return;
    }

    // Demo wallet bypasses payment (rate-limited by the frontend)
    if (wallet === DEMO_WALLET) {
      return next();
    }

    // Sister apps bypass payment entirely (identified by x-api-key in SISTER_API_KEYS)
    const sister = isSisterCaller(req);
    if (sister) {
      res.setHeader('X-Sister', 'true');
      return next();
    }

    // Determine pricing
    const hasActions = Array.isArray(req.body?.actions) && req.body.actions.length > 0;
    const cost = getRequestPrice(hasActions, false);

    // Check if user can afford it (includes daily freebie check)
    if (!canAfford(wallet, cost)) {
      const account = getAccount(wallet);
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

    // Charge after the request succeeds
    const url = req.body?.url || 'unknown';

    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const { charged, wasFree } = chargeRequest(wallet, url, cost, hasActions);
        if (wasFree) {
          console.log(`[Credits] FREE daily request for ${wallet.slice(0, 10)}... → ${url}`);
        } else if (charged > 0) {
          const discount = sister ? ' (sister 50% off)' : '';
          console.log(`[Credits] -$${charged.toFixed(3)}${discount} from ${wallet.slice(0, 10)}... → ${url}`);
        }
      }
    });

    // Add pricing info to response headers
    res.setHeader('X-Request-Cost', cost.toFixed(3));
    if (sister) res.setHeader('X-Sister-Discount', '50%');

    next();
  };
}

export { paymentRequired } from './middleware-x402.js';