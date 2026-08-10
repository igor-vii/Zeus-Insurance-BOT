export interface Policy {
  id: string;
  chainId: number;
  policyId: string;
  contract: string;
  buyer: string;
  seller: string;
  amount: string;
  premium: string;
  retryDeadline: number;
  isActive: boolean;
  isPaidOut: boolean;
  isExpired: boolean;
}

export interface WatcherVote {
  watcher: string;
  vote: 'yes' | 'no' | 'abstain';
  reason: string;
  signature?: string;
  timestamp?: number;
}

export interface VoteResult {
  policyId: string;
  chainId: number;
  yes: number;
  no: number;
  abstain: number;
  details: WatcherVote[];
}

export interface NetworkConfig {
  chainId: number;
  rpcs: string[];
  insurance: string;
  graphUrl?: string;
  quorum: number;
  gasThresholdGwei: number;
  minProfitMultiplier: number;
  supportedWatchers?: string[];
}
