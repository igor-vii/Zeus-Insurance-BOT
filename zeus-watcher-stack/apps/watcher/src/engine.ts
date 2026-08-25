import { Policy } from '@zeus/shared';
import { ObservationSigner } from './signer';
import { logWatcher } from './watchers/logs';
import { txHashWatcher } from './watchers/tx-hash';
import { checkGasEconomics } from './watchers/gas';
import { checkRpcHealth } from './watchers/rpc';
import { NETWORKS } from './config';

const SENSORS = [logWatcher, txHashWatcher];

export interface ObservationResult {
  policyId: string;
  chainId: number;
  observation: {
    requestId: string;
    timestamp: number;
    status: number;
    metadataHash: string;
    nonce: number;
    signature: string;
  } | null; // null = abstain (не отправляем на цепь)
  reason: string;
}

export async function evaluateAndSign(
  policy: Policy,
  signer: ObservationSigner
): Promise<ObservationResult> {
  const cfg = Object.values(NETWORKS).find(n => n.chainId === policy.chainId)!;
  
  // Pre-gate: check RPC health
  const rpcOk = await checkRpcHealth(cfg);
  if (!rpcOk) {
    return { 
      policyId: policy.policyId, 
      chainId: policy.chainId, 
      observation: null, 
      reason: 'RPC down: abstain this cycle' 
    };
  }
  
  // Gas check (logging only, not voting)
  const gasCheck = await checkGasEconomics(policy, cfg);
  if (gasCheck.shouldLog) {
    console.warn(`[gas-check] policyId=${policy.policyId} chainId=${policy.chainId} ${gasCheck.reason}`);
  }
  
  // Call only sensors
  const results = await Promise.allSettled(
    SENSORS.map(s => s.check(policy, cfg))
  );
  
  const logs = results[0]?.status === 'fulfilled' ? results[0].value.vote : 'abstain';
  const txhash = results[1]?.status === 'fulfilled' ? results[1].value.vote : 'abstain';
  
  let status: number;
  let reason: string;
  
  // Conditional logic based on RPC count
  if (cfg.rpcs.length === 1) {
    // Single RPC: require consensus from both sensors (Model A)
    if (logs === 'yes' && txhash === 'no') {
      status = 1;  // both see failure → payout
      reason = 'Payout: both sensors confirm failure';
    } else if (logs === 'no' && txhash === 'yes') {
      status = 0;  // both see success → reject
      reason = 'Rejected: both sensors confirm success';
    } else {
      return { 
        policyId: policy.policyId, 
        chainId: policy.chainId, 
        observation: null, 
        reason: 'Retry: sensors disagree or insufficient data' 
      };
    }
  } else {
    // Dual RPC: Model B (any failure from different sources)
    if (logs === 'yes' || txhash === 'no') {
      status = 1;  // at least one sensor sees failure → payout
      reason = `Payout: ${logs === 'yes' ? 'logWatcher' : 'txHashWatcher'} detected failure`;
    } else if (logs === 'no' && txhash === 'yes') {
      status = 0;  // both see success → reject
      reason = 'Rejected: both sensors confirm success';
    } else {
      return { 
        policyId: policy.policyId, 
        chainId: policy.chainId, 
        observation: null, 
        reason: 'Retry: insufficient data' 
      };
    }
  }
  
  const timestamp = Math.floor(Date.now() / 1000);
  const obs = await signer.signObservation({
    policyId: policy.policyId,
    buyer: policy.buyer,
    seller: policy.seller,
    timestamp,
    status,
  });
  
  return {
    policyId: policy.policyId,
    chainId: policy.chainId,
    observation: obs,
    reason,
  };
}
