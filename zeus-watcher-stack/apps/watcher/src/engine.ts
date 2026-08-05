import { Policy, VoteResult, WatcherVote } from '@zeus/shared';
import { apiWatcher } from './watchers/api';
import { logWatcher } from './watchers/logs';
import { gasWatcher } from './watchers/gas';
import { okxWatcher } from './watchers/okx';
import { rpcWatcher } from './watchers/rpc';
import { NETWORKS } from './config';

const WATCHERS = [apiWatcher, logWatcher, gasWatcher, okxWatcher, rpcWatcher];

export async function evaluatePolicy(policy: Policy): Promise<VoteResult> {
  const cfg = Object.values(NETWORKS).find(n => n.chainId === policy.chainId);
  const details: WatcherVote[] = [];
  let yes = 0, no = 0, abstain = 0;

  const results = await Promise.allSettled(
    WATCHERS.map(w => w.check(policy, cfg!))
  );

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (res.status === 'rejected') {
      details.push({ watcher: WATCHERS[i].name, vote: 'abstain', reason: res.reason.message });
      abstain++;
      continue;
    }
    details.push(res.value);
    if (res.value.vote === 'yes') yes++;
    else if (res.value.vote === 'no') no++;
    else abstain++;
  }

  return { policyId: policy.policyId, chainId: policy.chainId, yes, no, abstain, details };
}
