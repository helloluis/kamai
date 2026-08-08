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
import { resolveWallet, getAccount, canAfford, chargeRequest, hasUsedDailyFree } from './credits.js';
import { priceFor } from './pricing.js';
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

export function creditPayment(costOverride?: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The floor for this endpoint. The final price is cost-plus —
    // max(floor, 2 x measured upstream) — and can only be settled once the
    // request has run and we know which provider answered. usage.ts reads this
    // to compute billable_usd for every caller, sister apps included.
    const floor = costOverride ??
      getRequestPrice(Array.isArray(req.body?.actions) && req.body.actions.length > 0, false);
    res.locals.priceFloor = floor;

    // Sister apps bypass payment entirely — check FIRST before wallet resolution
    if (isSisterCaller(req)) {
      res.setHeader('X-Sister', 'true');
      res.locals.chargedUsd = 0;
      return next();
    }

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
      res.locals.chargedUsd = 0;
      return next();
    }

    // Affordability is gated on the floor, but the debit is the settled
    // cost-plus price, which can be higher (an Instagram social search costs
    // ~$0.46 against a $0.003 floor). A caller can therefore end a request
    // slightly negative; the next call is refused until they top up. That is
    // standard for metered billing and beats pre-charging the worst case,
    // which would block every small-balance caller from cheap requests.
    const cost = floor;

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

    // Predicted charge for usage analytics (first request of the day is free,
    // mirroring chargeRequest's logic). Set now so the usage middleware's
    // finish listener sees it regardless of listener ordering. Corrected below
    // once the settled price is known.
    res.locals.chargedUsd = hasUsedDailyFree(wallet) ? cost : 0;

    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const hasActions = Array.isArray(req.body?.actions) && req.body.actions.length > 0;
        // Settle at the published rate now that the provider — and therefore
        // the real cost — is known.
        const upstream = (res.locals.usage as { upstream?: number } | undefined)?.upstream;
        const settled = priceFor(floor, upstream);
        res.locals.chargedUsd = hasUsedDailyFree(wallet) ? settled : 0;
        const { charged, wasFree } = chargeRequest(wallet, url, settled, hasActions);
        if (wasFree) {
          console.log(`[Credits] FREE daily request for ${wallet.slice(0, 10)}... → ${url}`);
        } else if (charged > 0) {
          console.log(`[Credits] -$${charged.toFixed(4)} from ${wallet.slice(0, 10)}... → ${url}`);
        }
      }
    });

    // Floor, not the settled price — the real figure isn't known until the
    // response is on its way out, by which point headers are already sent.
    res.setHeader('X-Request-Price-Floor', floor.toFixed(4));
    res.setHeader('X-Pricing', 'cost-plus:100%');

    next();
  };
}

export { paymentRequired } from './middleware-x402.js';