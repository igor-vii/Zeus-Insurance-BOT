import { Job } from 'bullmq';
import { ethers } from 'ethers';
import { NETWORKS } from '../../watcher/src/config.js';
import {
  getProvider,
  getInsuranceContract,
  type ObservationTuple,
} from './blockchain.js';

// ─── Env guard ───────────────────────────────────────────────────────────────

const RELAYER_KEY = process.env.RELAYER_KEY;
if (!RELAYER_KEY) {
  throw new Error('RELAYER_KEY environment variable is required');
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export async function relayWorker(job: Job) {
  const { name, data } = job;

  // ── 1. relay-observation ─────────────────────────────────────────────────
  if (name === 'relay-observation') {
    const cfg = Object.values(NETWORKS).find(n => n.chainId === data.chainId);
    if (!cfg) throw new Error(`Unknown chain: ${data.chainId}`);

    const provider = getProvider(cfg.rpcs);
    const contract = getInsuranceContract(cfg.insurance, provider);
    const wallet = new ethers.Wallet(RELAYER_KEY, provider);
    const writeContract = contract.connect(wallet);

    // Проверяем, что полис всё ещё активен (дешёвая read-only проверка)
    const policy = await contract.policies(data.policyId);
    if (Number(policy.status) !== 0) { // 0 = Active
      throw new Error(`Policy ${data.policyId} not active (status=${policy.status})`);
    }

    const observation: ObservationTuple = {
      requestId: data.requestId,
      timestamp: BigInt(data.timestamp),
      status: data.status,
      metadataHash: data.metadataHash,
      nonce: BigInt(data.nonce),
      signature: data.signature,
    };

    const tx = await writeContract.submitObservation(data.policyId, observation);
    const receipt = await tx.wait();

    return {
      txHash: tx.hash,
      status: receipt?.status,
      blockNumber: receipt?.blockNumber,
    };
  }

  // ── 2. relay-slashing ────────────────────────────────────────────────────
  if (name === 'relay-slashing') {
    const cfg = Object.values(NETWORKS).find(n => n.chainId === data.chainId);
    if (!cfg) throw new Error(`Unknown chain: ${data.chainId}`);

    const provider = getProvider(cfg.rpcs);
    const contract = getInsuranceContract(cfg.insurance, provider);
    const wallet = new ethers.Wallet(RELAYER_KEY, provider);
    const writeContract = contract.connect(wallet);

    // Проверяем, что slashing ещё возможен
    const canSlash = await contract.canSlash(data.policyId);
    if (!canSlash) {
      throw new Error(`Policy ${data.policyId} cannot be slashed`);
    }

    // ВАЖНО: reportSlashing требует isWatcher[msg.sender].
    // Если relayer НЕ зарегистрирован как watcher — tx revert.
    // Решения:
    //   A) Зарегистрировать relayer-адрес как watcher в контракте
    //   B) Использовать watcher-key для подписи + relayer для газа (meta-tx)
    //   C) Отправлять slashing с того же ключа, что и observation (если он watcher)
    const tx = await writeContract.reportSlashing(data.policyId, data.evidenceHash);
    const receipt = await tx.wait();

    return {
      txHash: tx.hash,
      status: receipt?.status,
      blockNumber: receipt?.blockNumber,
    };
  }

  throw new Error(`Unknown job name: ${name}`);
}
