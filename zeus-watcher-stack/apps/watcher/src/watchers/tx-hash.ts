import { Policy, WatcherVote, NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider } from 'ethers';

/**
 * txHashWatcher — проверяет наличие подтверждённой транзакции оплаты.
 * Пока paymentHash не передаётся в policy (нет metadata), возвращает abstain.
 * Когда paymentHash станет доступен через graph/cache — активируется логика проверки.
 */
export const txHashWatcher = {
  name: 'txhash',
  async check(policy: Policy, cfg: NetworkConfig): Promise<WatcherVote> {
    try {
      // TODO: получить paymentHash из policy cache или subgraph
      // Сейчас metadata отсутствует в типе Policy — абстрагируемся
      const paymentHash = (policy as any).paymentHash as string | undefined;
      
      if (!paymentHash || !/^0x[a-fA-F0-9]{64}$/.test(paymentHash)) {
        return { watcher: 'txhash', vote: 'abstain', reason: 'No paymentHash available' };
      }

      const rpcUrl = cfg.rpcs.length > 1 ? cfg.rpcs[1] : cfg.rpcs[0];
      const provider = new JsonRpcProvider(rpcUrl);
      const tx = await provider.getTransaction(paymentHash);
      if (!tx) {
        return { watcher: 'txhash', vote: 'no', reason: 'Transaction not found' };
      }

      if (tx.to?.toLowerCase() !== cfg.insurance.toLowerCase()) {
        return { watcher: 'txhash', vote: 'no', reason: 'Transaction not to insurance contract' };
      }

      const receipt = await provider.getTransactionReceipt(paymentHash);
      if (!receipt) {
        return { watcher: 'txhash', vote: 'no', reason: 'Receipt not available' };
      }

      // ethers v6: confirmations — это bigint
      const confirmations = typeof receipt.confirmations === 'bigint' 
        ? Number(receipt.confirmations) 
        : receipt.confirmations;
      
      const resolvedConfirmations = typeof confirmations === 'function' ? await confirmations() : confirmations;
      if (resolvedConfirmations < 1) {
        return { watcher: 'txhash', vote: 'no', reason: 'Transaction not confirmed' };
      }

      return { watcher: 'txhash', vote: 'yes', reason: `Payment confirmed (${resolvedConfirmations} blocks)` };
    } catch (err: any) {
      return { watcher: 'txhash', vote: 'abstain', reason: err.message };
    }
  }
};
