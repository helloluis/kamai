/**
 * POST /api/v1/deposit — verify a USDC deposit and credit the account.
 * GET  /api/v1/deposit/balance — check current balance.
 *
 * Identity: x-wallet-address header (required).
 */
import { Router } from 'express';
import { verifyPayment } from '../../payment/verifier.js';
import { creditDeposit, isDepositUsed, getAccount, resolveWallet } from '../../payment/credits.js';
import { MIN_DEPOSIT } from '../../payment/config.js';

const router = Router();

router.post('/', async (req, res) => {
  const wallet = resolveWallet(
    (req.headers['x-wallet-address'] as string) || (req.headers['x-api-key'] as string) || '',
  );
  if (!wallet) {
    res.status(401).json({ ok: false, error: 'Missing x-wallet-address or x-api-key header' });
    return;
  }

  const { txHash } = req.body;
  if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "txHash" field' });
    return;
  }

  if (isDepositUsed(txHash)) {
    res.status(409).json({ ok: false, error: 'This transaction has already been credited' });
    return;
  }

  const result = await verifyPayment(txHash as `0x${string}`, 0);
  if (!result.valid) {
    res.status(400).json({ ok: false, error: 'Payment verification failed', details: result.error });
    return;
  }

  const amountUsd = parseFloat(result.amount || '0');
  if (amountUsd < MIN_DEPOSIT) {
    res.status(400).json({
      ok: false,
      error: `Minimum deposit is $${MIN_DEPOSIT.toFixed(2)}. Received: $${amountUsd.toFixed(2)}`,
    });
    return;
  }

  try {
    creditDeposit(wallet, txHash, amountUsd);
    const account = getAccount(wallet);

    console.log(`[Deposit] $${amountUsd.toFixed(2)} from ${result.from} → ${wallet.slice(0, 10)}... (balance: $${account.balance_usd.toFixed(2)})`);

    res.json({
      ok: true,
      deposited: amountUsd,
      balance: account.balance_usd,
      wallet,
      txHash,
      from: result.from,
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/balance', (req, res) => {
  const wallet = resolveWallet(
    (req.headers['x-wallet-address'] as string) || (req.headers['x-api-key'] as string) || '',
  );
  if (!wallet) {
    res.status(401).json({ ok: false, error: 'Missing x-wallet-address or x-api-key header' });
    return;
  }

  const account = getAccount(wallet);
  res.json({
    ok: true,
    wallet: account.wallet,
    balance: account.balance_usd,
    totalDeposited: account.total_deposited_usd,
    totalSpent: account.total_spent_usd,
    requestCount: account.request_count,
    apiKey: account.api_key,
  });
});

export default router;
