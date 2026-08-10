import { WatcherVote } from '@zeus/shared';

export const okxWatcher = {
  name: 'okx',
  async check(): Promise<WatcherVote> {
    return { watcher: 'okx', vote: 'abstain', reason: 'stub: endpoint not implemented' };
  }
};
