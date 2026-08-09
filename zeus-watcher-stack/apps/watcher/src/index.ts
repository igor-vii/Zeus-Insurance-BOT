import cron from 'node-cron';
import { fetchExpiringPolicies } from './graph';
import { evaluateAndSign } from './engine';
import { ObservationSigner } from './signer';
import { NETWORKS } from './config';

const signer = new ObservationSigner(process.env.WATCHER_PRIVATE_KEY!);

async function tick() {
  for (const [name, cfg] of Object.entries(NETWORKS)) {
    console.log(`[${name}] Polling...`);

    const policies = cfg.graphUrl
      ? await fetchExpiringPolicies(cfg.graphUrl)
      : [];

    for (const policy of policies) {
      const result = await evaluateAndSign(policy, signer);
      console.log(`Policy ${policy.policyId}: ${result.reason}`);

      if (result.observation === null) continue; // abstain — не отправляем

      await fetch(`${process.env.API_URL}/observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: result.chainId,
          policyId: result.policyId,
          observation: result.observation,
        }),
      });
    }
  }
}

// Run immediately, then every 2 minutes
tick();
cron.schedule('*/2 * * * *', tick);
