import { Job } from 'bullmq';
import { prisma } from './db';
import { getProvider, getContract } from './blockchain';
import { NETWORKS } from '../../watcher/src/config';

export async function claimWorker(job: Job<{ chainId: number; policyId: string }>) {
  const { chainId, policyId } = job.data;
  const cfg = Object.values(NETWORKS).find(n => n.chainId === chainId);
  if (!cfg) throw new Error('Unknown chain');

  const provider = getProvider(cfg.rpcs);
  const contract = getContract(cfg.insurance, provider);

  // 1. Re-check on-chain
  const policy = await contract.policies(policyId);
  const [,, amount, premium, retryDeadline, , isActive, isPaidOut, isExpired] = policy;

  const now = Math.floor(Date.now() / 1000);
  if (!isActive || isPaidOut || isExpired || Number(retryDeadline) > now) {
    await prisma.policy.updateMany({
      where: { id: `${chainId}:${policyId}` },
      data: { status: 'failed' }
    });
    throw new Error('Policy state changed or deadline not reached');
  }

  // 2. Economic guard
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const estimatedGas = await contract.claimPayout.estimateGas(policyId).catch(() => 150_000n);
  const gasCost = gasPrice * estimatedGas;
  const minProfit = (gasCost * 15n) / 10n;

  if (premium < minProfit) {
    await job.moveToDelayed(Date.now() + 3_600_000);
    return { status: 'delayed', reason: 'unprofitable', gasCost: gasCost.toString() };
  }

  // 3. In production: use KMS or AWS signer here
  // const wallet = new ethers.Wallet(process.env.EXECUTOR_KEY!, provider);
  // const tx = await contract.connect(wallet).claimPayout(policyId, { ... });
  
  // Placeholder: log and mark as claimed (replace with real send)
  console.log(`Would claim ${policyId} on chain ${chainId}`);
  
  await prisma.claim.create({
    data: {
      policyId: `${chainId}:${policyId}`,
      status: 'pending',
    }
  });

  return { status: 'pending', reason: 'Waiting for KMS integration' };
}
