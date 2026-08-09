import { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const REGISTRY_ABI = [
  { type: 'function', name: 'submitObservation', stateMutability: 'nonpayable',
    inputs: [
      { name: 'eventId', type: 'bytes32' },
      { name: 'status', type: 'uint8' },
    ],
    outputs: [],
  },
] as const;

interface InsuredPosition {
  positionId: string;
  validatorPubkey: string; // 0x-prefixed BLS pubkey
  expiry: number;
}

const CFG = {
  clRpc: process.env.CONSENSUS_RPC_URL || 'https://beaconcha.in/CL', // any CL client
  apiServer: process.env.API_SERVER_URL || 'http://localhost:3001',
  registry: (process.env.WATCHER_REGISTRY_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
  chainRpc: process.env.BOT_CHAIN_MAINNET_RPC_URL || 'https://rpc.botchain.ai',
  pollMs: Number(process.env.STAKING_POLL_INTERVAL_MS || 60_000),
};

const account = privateKeyToAccount(process.env.WATCHER_PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({ account, transport: http(CFG.chainRpc) });

const reported = new Set<string>();

/** eventId must match contract: keccak256(abi.encode(positionId)) */
function eventIdFor(positionId: string): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }], [BigInt(positionId)]));
}

async function fetchInsuredPositions(): Promise<InsuredPosition[]> {
  const res = await fetch(`${CFG.apiServer}/api/staking/positions`);
  if (!res.ok) return [];
  return (await res.json()) as InsuredPosition[];
}

async function isSlashed(pubkey: string): Promise<boolean> {
  try {
    const res = await fetch(`${CFG.clRpc}/eth/v2/beacon/validators/${pubkey}`);
    if (!res.ok) return false;
    const json: any = await res.json();
    const v = json?.data?.validator;
    return v?.slashed === true || v?.slashed === 'true';
  } catch {
    return false;
  }
}

async function reportSlashing(positionId: string): Promise<void> {
  const eventId = eventIdFor(positionId);
  const hash = await wallet.writeContract({
    address: CFG.registry,
    abi: REGISTRY_ABI,
    functionName: 'submitObservation',
    args: [eventId, 1],
    chain: null as any,
  });
  console.log(`[consensus-monitor] slashing reported pos=${positionId} tx=${hash}`);
}

async function tick(): Promise<void> {
  const positions = await fetchInsuredPositions();
  const now = Math.floor(Date.now() / 1000);

  for (const pos of positions) {
    if (reported.has(pos.positionId)) continue;
    if (now > pos.expiry) continue;

    if (await isSlashed(pos.validatorPubkey)) {
      reported.add(pos.positionId);
      await reportSlashing(pos.positionId).catch((e) => {
        reported.delete(pos.positionId);
        console.error('[consensus-monitor] report failed:', e.message);
      });
    }
  }
}

export function startConsensusMonitor(): void {
  console.log('[consensus-monitor] started, poll', CFG.pollMs, 'ms');
  setInterval(() => tick().catch((e) => console.error('[consensus-monitor] tick error:', e.message)), CFG.pollMs);
}

// Direct run support
if (require.main === module) startConsensusMonitor();
