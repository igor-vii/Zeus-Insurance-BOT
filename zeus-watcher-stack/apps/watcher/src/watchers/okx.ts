import { Policy, WatcherVote } from '@zeus/shared';

export const okxWatcher = {
  name: 'okx',
  async check(policy: Policy): Promise<WatcherVote> {
    try {
      const apiUrl = process.env.API_URL;
      const resp = await fetch(`${apiUrl}/api/okx/evaluate/${policy.policyId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return { watcher: 'okx', vote: 'abstain', reason: `HTTP ${resp.status}` };
      const data = await resp.json();
      if (data.failed === true) return { watcher: 'okx', vote: 'yes', reason: 'OKX: failure confirmed' };
      if (data.failed === false) return { watcher: 'okx', vote: 'no', reason: 'OKX: success' };
      return { watcher: 'okx', vote: 'abstain', reason: 'OKX: inconclusive' };
    } catch (err: any) {
      return { watcher: 'okx', vote: 'abstain', reason: err.message };
    }
  }
};
