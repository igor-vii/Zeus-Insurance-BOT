import { Policy, NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider } from 'ethers';

export async function checkGasEconomics(policy: Policy, cfg: NetworkConfig): Promise<{
  shouldLog: boolean;
  reason: string;
}> {
  const provider = new JsonRpcProvider(cfg.rpcs[0]);
  const { maxFeePerGas } = await provider.getFeeData();
  if (!maxFeePerGas) return { shouldLog: false, reason: 'Gas price unavailable' };
  
  const gasCost = maxFeePerGas * 80000n;  // ~80k gas for observation
  const maxCost = BigInt(policy.premium) / 10n;  // 10% threshold
  
  if (gasCost > maxCost) {
    const ratio = Number(gasCost * 100n / BigInt(policy.premium));
    return {
      shouldLog: true,
      reason: `High gas cost: ${gasCost} wei (${ratio}% of premium ${policy.premium})`
    };
  }
  return { shouldLog: false, reason: 'Gas acceptable' };
}
