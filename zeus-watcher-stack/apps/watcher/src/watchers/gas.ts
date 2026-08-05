import { Policy, WatcherVote, NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider } from 'ethers';

export const gasWatcher = {
  name: 'gas',
  async check(policy: Policy, cfg: NetworkConfig): Promise<WatcherVote> {
    try {
      const provider = new JsonRpcProvider(cfg.rpcs[0]);
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? 0n;
      const gwei = Number(gasPrice) / 1e9;

      const estimatedGas = 150_000n;
      const cost = gasPrice * estimatedGas;
      const minProfit = (cost * BigInt(Math.floor(cfg.minProfitMultiplier * 100))) / 100n;

      if (policy.premium && BigInt(policy.premium) < minProfit) {
        return { watcher: 'gas', vote: 'no', reason: `Unprofitable: premium ${policy.premium} < min ${minProfit}` };
      }
      return { watcher: 'gas', vote: 'abstain', reason: `Gas ${gwei.toFixed(2)} Gwei acceptable` };
    } catch (err: any) {
      return { watcher: 'gas', vote: 'abstain', reason: err.message };
    }
  }
};
