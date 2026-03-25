/**
 * On-chain payment verifier for Celo USDC.
 *
 * Checks that a transaction hash corresponds to a valid USDC transfer
 * to our recipient address for the expected amount.
 */
import { createPublicClient, http, parseAbi, type Hash } from 'viem';
import { celo } from 'viem/chains';
import { USDC_ADDRESS, PAYMENT_RECIPIENT, USDC_DECIMALS, CELO_RPC_URL } from './config.js';

const client = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC_URL),
});

const erc20TransferEvent = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export interface PaymentVerification {
  valid: boolean;
  error?: string;
  from?: string;
  to?: string;
  amount?: string;
  txHash?: string;
}

/**
 * Verify a transaction hash is a valid USDC payment to our address.
 */
export async function verifyPayment(
  txHash: Hash,
  expectedAmountUsd: number,
): Promise<PaymentVerification> {
  if (!PAYMENT_RECIPIENT) {
    return { valid: false, error: 'Payment recipient not configured' };
  }

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      return { valid: false, error: 'Transaction failed on-chain', txHash };
    }

    // Find USDC Transfer event to our recipient
    const expectedAmount = BigInt(Math.round(expectedAmountUsd * 10 ** USDC_DECIMALS));
    const tolerance = expectedAmount / 20n; // 5% tolerance for gas/rounding

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;

      // Check if this is a Transfer event (topic0)
      const transferSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      if (log.topics[0] !== transferSig) continue;

      // Decode to/amount from topics and data
      const to = '0x' + (log.topics[2]?.slice(26) || '');
      const value = BigInt(log.data);

      if (to.toLowerCase() === PAYMENT_RECIPIENT.toLowerCase() && value >= expectedAmount - tolerance) {
        const from = '0x' + (log.topics[1]?.slice(26) || '');
        return {
          valid: true,
          from,
          to,
          amount: (Number(value) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS),
          txHash,
        };
      }
    }

    return { valid: false, error: 'No matching USDC transfer found in transaction', txHash };
  } catch (err: any) {
    return { valid: false, error: `Verification failed: ${err.message}`, txHash };
  }
}

/**
 * Check USDC balance of an address.
 */
export async function getUsdcBalance(address: `0x${string}`): Promise<bigint> {
  const data = await client.readContract({
    address: USDC_ADDRESS,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [address],
  });
  return data;
}