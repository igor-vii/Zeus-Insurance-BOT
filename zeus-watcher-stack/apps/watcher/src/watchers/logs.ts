import { Policy, WatcherVote, NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider } from 'ethers';

// DeliveryConfirmed(uint256 indexed policyId, address indexed buyer, bytes32 indexed paymentHash, uint256 timestamp)
const DELIVERY_CONFIRMED_TOPIC = '';

export const logWatcher = {
  name: 'logs',
  async check(policy: Policy, cfg: NetworkConfig): Promise<WatcherVote> {
    try {
      const provider = new JsonRpcProvider(cfg.rpcs[0]);
      const current = await provider.getBlockNumber();
      const logs = await provider.getLogs({
        address: cfg.insurance,
        topics: [
          DELIVERY_CONFIRMED_TOPIC,
          '0x' + BigInt(policy.policyId).toString(16).padStart(64, '0'),
        ],
        fromBlock: Math.max(0, current - 50000),
        toBlock: current,
      });

      if (logs.length > 0) {
        // Delivery confirmed - vote NO (claim should be rejected)
        return { watcher: 'logs', vote: 'no', reason: 'DeliveryConfirmed event found' };
      }
      // No delivery confirmation - vote YES (claim should be approved)
      return { watcher: 'logs', vote: 'yes', reason: 'No delivery confirmation' };
    } catch (err: any) {
      return { watcher: 'logs', vote: 'abstain', reason: err.message };
    }
  }
};
