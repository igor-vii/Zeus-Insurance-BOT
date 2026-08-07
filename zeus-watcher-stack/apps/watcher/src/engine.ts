import { Policy } from '@zeus/shared';
import { ObservationSigner } from './signer';
import { apiWatcher } from './watchers/api';
import { logWatcher } from './watchers/logs';
import { gasWatcher } from './watchers/gas';
import { okxWatcher } from './watchers/okx';
import { rpcWatcher } from './watchers/rpc';
import { txHashWatcher } from './watchers/tx-hash';
import { NETWORKS } from './config';

const WATCHERS = [apiWatcher, logWatcher, gasWatcher, okxWatcher, rpcWatcher, txHashWatcher];

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
  
  let yes = 0, no = 0;
  const reasons: string[] = [];

  const results = await Promise.allSettled(
    WATCHERS.map(w => w.check(policy, cfg))
  );

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const name = WATCHERS[i].name;
    if (res.status === 'rejected') {
      reasons.push(`${name}: abstain (${res.reason.message})`);
      continue;
    }
    if (res.value.vote === 'yes') { yes++; reasons.push(`${name}: yes`); }
    else if (res.value.vote === 'no') { no++; reasons.push(`${name}: no`); }
    else reasons.push(`${name}: abstain`);
  }

  // Вето: если хоть один watcher сказал "no" — отправляем status=0 (reject)
  // Если >=2 yes (контракту нужно 2 из 3 для payout) — отправляем status=1
  // Но мы не знаем, сколько уже голосов on-chain. Отправляем наш вердикт.
  let status: number;
  let reason: string;

  if (no > 0) {
    status = 0;
    reason = `Vetoed: ${reasons.join('; ')}`;
  } else if (yes >= 2) {
    status = 1;
    reason = `Payout: ${reasons.join('; ')}`;
  } else {
    return { policyId: policy.policyId, chainId: policy.chainId, observation: null, reason: `Abstain: ${reasons.join('; ')}` };
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
