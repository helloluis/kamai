/**
 * POST /api/v1/deposit — verify a USDC deposit and credit the account.
 *
 * Client sends a tx hash of a USDC transfer to the kamAI wallet.
 * We verify it on-chain and add the amount to their credit balance.
 */
import { Router } from 'express';
import { verifyPayment } from '../../payment/verifier.js';
import { creditDeposit, isDepositUsed, getAccount } from '../../payment/credits.js';
import { MIN_DEPOSIT } from '../../payment/config.js';

const router = Router();

router.post('/', async (req, res) => {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    res.status(401).json({ ok: false, error: 'Missing x-api-key header' });
    return;
  }

  const { txHash } = req.body;
  if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "txHash" field' });
    return;
  }

  // Check if already used
  if (isDepositUsed(txHash)) {
    res.status(409).json({ ok: false, error: 'This transaction has already been credited' });
    return;
  }

  // Verify on-chain
  const result = await verifyPayment(txHash as `0x${string}`, 0); // 0 = accept any amount

  if (!result.valid) {
    res.status(400).json({
      ok: false,
      error: 'Payment verification failed',
      details: result.error,
    });
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

  // Credit the account
  try {
    creditDeposit(apiKey, txHash, amountUsd);
    const account = getAccount(apiKey);

    console.log(`[Deposit] $${amountUsd.toFixed(2)} from ${result.from} for key ${apiKey.slice(0, 12)}... (balance: $${account.balance_usd.toFixed(2)})`);

    res.json({
      ok: true,
      deposited: amountUsd,
      balance: account.balance_usd,
      txHash,
      from: result.from,
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** GET /api/v1/deposit/balance — check current balance */
router.get('/balance', (req, res) => {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    res.status(401).json({ ok: false, error: 'Missing x-api-key header' });
    return;
  }

  const account = getAccount(apiKey);
  res.json({
    ok: true,
    balance: account.balance_usd,
    totalDeposited: account.total_deposited_usd,
    totalSpent: account.total_spent_usd,
    requestCount: account.request_count,
  });
});

export default router;
