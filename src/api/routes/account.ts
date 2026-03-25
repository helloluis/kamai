/**
 * Account management routes.
 *
 * POST /api/v1/account/generate-key — generate/regenerate an API key for a wallet.
 * GET  /api/v1/account               — get account info.
 */
import { Router } from 'express';
import { resolveWallet, getAccount, generateApiKey } from '../../payment/credits.js';
import { getDepositAddress } from '../../payment/wallet.js';

const router = Router();

/** GET /api/v1/account — get account info */
router.get('/', (req, res) => {
  const wallet = resolveWallet(
    (req.headers['x-wallet-address'] as string) || (req.headers['x-api-key'] as string) || '',
  );
  if (!wallet) {
    res.status(401).json({ ok: false, error: 'Missing x-wallet-address or x-api-key header' });
    return;
  }

  const account = getAccount(wallet);
  const { depositAddress } = getDepositAddress(wallet);
  res.json({
    ok: true,
    wallet: account.wallet,
    depositAddress,
    apiKey: account.api_key,
    balance: account.balance_usd,
    totalDeposited: account.total_deposited_usd,
    totalSpent: account.total_spent_usd,
    requestCount: account.request_count,
    createdAt: account.created_at,
  });
});

/** POST /api/v1/account/generate-key — generate a new API key */
router.post('/generate-key', (req, res) => {
  const walletHeader = req.headers['x-wallet-address'] as string | undefined;
  if (!walletHeader || !walletHeader.startsWith('0x') || walletHeader.length !== 42) {
    res.status(401).json({
      ok: false,
      error: 'x-wallet-address header required (must be a valid 0x address). API keys cannot generate new keys — use the wallet that owns the account.',
    });
    return;
  }

  const wallet = walletHeader.toLowerCase();
  const key = generateApiKey(wallet);

  console.log(`[Account] Generated API key for ${wallet.slice(0, 10)}...`);

  res.json({
    ok: true,
    wallet,
    apiKey: key,
    note: 'This key is linked to your wallet. Any agent using this key shares your credit balance. Regenerating will invalidate the previous key.',
  });
});

export default router;
