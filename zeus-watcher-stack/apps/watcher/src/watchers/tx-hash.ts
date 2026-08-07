import { Policy, WatcherVote, NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider } from 'ethers';

export const txHashWatcher = {
  name: 'txhash',
  async check(policy: Policy, cfg: NetworkConfig): Promise<WatcherVote> {
    try {
      const paymentHash = policy.metadata?.paymentHash;
      if (!paymentHash) {
        return { watcher: 'txhash', vote: 'abstain', reason: 'No paymentHash in metadata' };
      }

      const provider = new JsonRpcProvider(cfg.rpcs[0]);
      const tx = await provider.getTransaction(paymentHash);
      if (!tx) {
        return { watcher: 'txhash', vote: 'yes', reason: 'Transaction not found' };
      }

      if (tx.to?.toLowerCase() !== cfg.insurance.toLowerCase()) {
        return { watcher: 'txhash', vote: 'yes', reason: 'Transaction not to insurance contract' };
      }

      const receipt = await provider.getTransactionReceipt(paymentHash);
      if (!receipt || receipt.confirmations < 1) {
        return { watcher: 'txhash', vote: 'yes', reason: 'Transaction not confirmed' };
      }

      return { watcher: 'txhash', vote: 'no', reason: 'Payment transaction confirmed' };
    } catch (err: any) {
      return { watcher: 'txhash', vote: 'abstain', reason: err.message };
    }
  }
};
