import { WatcherVote } from '@zeus/shared';

export const apiWatcher = {
  name: 'api',
  async check(): Promise<WatcherVote> {
    return { watcher: 'api', vote: 'abstain', reason: 'stub: endpoint not implemented' };
  }
};
