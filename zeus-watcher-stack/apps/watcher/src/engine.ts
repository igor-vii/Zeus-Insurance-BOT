import { Policy } from '@zeus/shared';
import { ObservationSigner } from './signer';
import { logWatcher } from './watchers/logs';
import { txHashWatcher } from './watchers/tx-hash';
import { checkGasEconomics } from './watchers/gas';
import { checkRpcHealth } from './watchers/rpc';
import { NETWORKS } from './config';
import pino from 'pino';

const logger = pino();

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
    logger.warn({ policyId: policy.policyId, chainId: policy.chainId }, gasCheck.reason);
  }
  
  // Call only sensors
  const results = await Promise.allSettled(
    SENSORS.map(s => s.check(policy, cfg))
  );
  
  const sensorVotes: Record<string, 'yes' | 'no' | 'abstain'> = {};
  const reasons: string[] = [];
  
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const name = SENSORS[i].name;
    
    if (res.status === 'rejected') {
      sensorVotes[name] = 'abstain';
      reasons.push(`${name}: abstain (${res.reason?.message || 'error'})`);
    } else {
      sensorVotes[name] = res.value.vote;
      reasons.push(`${name}: ${res.value.vote}`);
    }
  }
  
  const logs = sensorVotes['logs'] || 'abstain';
  const txhash = sensorVotes['txhash'] || 'abstain';
  
  let status: number;
  let reason: string;
  
  // Decision logic (CORRECTED)
  // logs: yes = "no delivery seen" (failure), no = "delivery confirmed" (success)
  // txhash: yes = "payment confirmed" (success), no = "payment not found" (failure)
  
  if (logs === 'yes' || txhash === 'no') {
    // logs sees failure OR txhash sees no payment
    status = 1;
    reason = `Payout: ${reasons.join('; ')}`;
  } else if (logs === 'no' && txhash === 'yes') {
    // logs confirms delivery AND txhash confirms payment
    status = 0;
    reason = `Rejected: ${reasons.join('; ')}`;
  } else {
    // Abstain - unclear situation
    return { 
      policyId: policy.policyId, 
      chainId: policy.chainId, 
      observation: null, 
      reason: `Abstain: ${reasons.join('; ')}` 
    };
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
