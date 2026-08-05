import cron from 'node-cron';
import { fetchExpiringPolicies } from './graph';
import { evaluatePolicy } from './engine';
import { createSigner } from './signer';
import { NETWORKS } from './config';

const signer = createSigner(process.env.PRIVATE_KEY!);

async function tick() {
  for (const [name, cfg] of Object.entries(NETWORKS)) {
    console.log(`[${name}] Polling...`);
    
    const policies = cfg.graphUrl
      ? await fetchExpiringPolicies(cfg.graphUrl)
      : []; // fallback: можно добавить RPC-сканирование здесь

    for (const policy of policies) {
      const result = await evaluatePolicy(policy);
      console.log(`Policy ${policy.policyId}: ${result.yes}Y ${result.no}N ${result.abstain}A`);

      if (result.no > 0) continue; // Veto

      const batch = await Promise.all(
        result.details.map(async (d) => {
          if (d.vote === 'abstain' || !d.signature) return null;
          const signed = await signer.signVote(policy.chainId, policy.policyId, d.watcher, d.vote === 'yes');
          return { watcher: d.watcher, vote: d.vote === 'yes', signature: signed.signature, timestamp: signed.timestamp };
        })
      );

      const votes = batch.filter(Boolean);
      if (votes.length === 0) continue;

      await fetch(`${process.env.API_URL}/votes/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: policy.chainId, policyId: policy.policyId, votes }),
      });
    }
  }
}

// Run immediately, then every 2 minutes
tick();
cron.schedule('*/2 * * * *', tick);
