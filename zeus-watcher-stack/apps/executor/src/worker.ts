import { Job } from 'bullmq';
import { ethers } from 'ethers';
import { NETWORKS } from '../../watcher/src/config';

const ABI = [
  'function submitObservation(uint256 policyId, (bytes32 requestId, uint256 timestamp, uint8 status, bytes32 metadataHash, uint256 nonce, bytes signature) obs) external',
  'function reportSlashing(uint256 policyId, bytes32 evidenceHash) external',
];

export async function relayWorker(job: Job) {
  const { name, data } = job;

  if (name === 'relay-observation') {
    const cfg = Object.values(NETWORKS).find(n => n.chainId === data.chainId);
    if (!cfg) throw new Error('Unknown chain');

    const provider = new ethers.JsonRpcProvider(cfg.rpcs[0]);
    // Relayer wallet — funded account, НЕ watcher (msg.sender не проверяется)
    const wallet = new ethers.Wallet(process.env.RELAYER_KEY!, provider);
    const contract = new ethers.Contract(cfg.insurance, ABI, wallet);

    const tx = await contract.submitObservation(data.policyId, {
      requestId: data.requestId,
      timestamp: data.timestamp,
      status: data.status,
      metadataHash: data.metadataHash,
      nonce: data.nonce,
      signature: data.signature,
    });

    const receipt = await tx.wait();
    return { txHash: tx.hash, status: receipt?.status };
  }

  if (name === 'relay-slashing') {
    // Slashing требует isWatcher[msg.sender] — значит релеер должен быть watcher'ом
    // Или мы используем отдельный watcher-key для executor
    // Это отдельная тема — требует доработки контракта или доверенного relayer
  }
}
