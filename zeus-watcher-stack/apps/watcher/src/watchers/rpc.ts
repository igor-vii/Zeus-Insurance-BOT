import { Policy, WatcherVote, NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';

const SELECTORS = { policies: '0x0d8e3e8c' };

function encodeUint256(value: string | number): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

export const rpcWatcher = {
  name: 'rpc',
  async check(policy: Policy, cfg: NetworkConfig): Promise<WatcherVote> {
    if (cfg.rpcs.length < 2) {
      return { watcher: 'rpc', vote: 'abstain', reason: 'No alternative RPC' };
    }
    try {
      const p1 = new JsonRpcProvider(cfg.rpcs[0]);
      const p2 = new JsonRpcProvider(cfg.rpcs[1]);
      const data = SELECTORS.policies + encodeUint256(policy.policyId);

      const [r1, r2] = await Promise.all([
        p1.call({ to: cfg.insurance, data }),
        p2.call({ to: cfg.insurance, data }),
      ]);

      const h1 = keccak256(toUtf8Bytes(r1));
      const h2 = keccak256(toUtf8Bytes(r2));

      if (h1 === h2) return { watcher: 'rpc', vote: 'no', reason: 'RPCs agree' };
      return { watcher: 'rpc', vote: 'yes', reason: 'RPC mismatch detected' };
    } catch (err: any) {
      return { watcher: 'rpc', vote: 'abstain', reason: err.message };
    }
  }
};
