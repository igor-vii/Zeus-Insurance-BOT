import { ethers } from 'ethers';

// ─────────────────────────────────────────────────────────────────────────────
// ZeusInsuranceV2 ABI — минимальный набор для Executor + Watcher
// ─────────────────────────────────────────────────────────────────────────────

export const ZEUS_INSURANCE_ABI = [
  // ── Write ─────────────────────────────────────────────────────────────────
  'function submitObservation(uint256 policyId, (bytes32 requestId, uint256 timestamp, uint8 status, bytes32 metadataHash, uint256 nonce, bytes signature) observation) external',
  'function reportSlashing(uint256 policyId, bytes32 evidenceHash) external',
  'function claimPayout(uint256 policyId) external',

  // ── Views ─────────────────────────────────────────────────────────────────
  'function policies(uint256) view returns (address buyer, address seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint256 maxRetries, uint8 status, uint8 coverageType)',
  'function nextPolicyId() view returns (uint256)',
  'function isWatcher(address) view returns (bool)',
  'function canClaim(uint256) view returns (bool)',
  'function canSlash(uint256) view returns (bool)',
  'function hasPendingClaims() view returns (bool)',
  'function getWatchers() view returns (address[] memory)',
  'function getCoverageType(uint256 policyId) view returns (uint8)',

  // ── Events ────────────────────────────────────────────────────────────────
  'event PayoutExecuted(uint256 indexed policyId, uint256 amount)',
  'event VoteResolved(bytes32 indexed requestId, uint8 decision, uint256 indexed policyId)',
  'event SlashingResolved(uint256 indexed policyId, bool approved)',
  'event ObservationSubmitted(bytes32 indexed requestId, address indexed watcher, uint8 status)',
  'event ClaimRejected(uint256 indexed policyId)',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// ZeusReserveV2 ABI — минимальный набор
// ─────────────────────────────────────────────────────────────────────────────

export const ZEUS_RESERVE_ABI = [
  'function payClaim(uint256 claimId, address claimant, uint256 amount) external',
  'function getReserveBalance() view returns (uint256)',
  'function remainingDailyPayout() view returns (uint256)',
  'function isAdequatelyFunded() view returns (bool)',
  'function fulfilledClaims(uint256) view returns (bool)',
  'function insuranceContract() view returns (address)',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Type helpers для Observation tuple (используется в worker.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservationTuple {
  requestId: string;      // bytes32
  timestamp: bigint;      // uint256
  status: number;         // uint8  (0 = reject, 1 = payout)
  metadataHash: string;    // bytes32
  nonce: bigint;          // uint256
  signature: string;      // bytes  (0x{r}{s}{v})
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider / Contract factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт ethers Provider с fallback на несколько RPC.
 * Если RPC один — возвращает JsonRpcProvider.
 */
export function getProvider(rpcs: string[]): ethers.JsonRpcProvider | ethers.FallbackProvider {
  if (rpcs.length === 0) {
    throw new Error('At least one RPC URL is required');
  }
  if (rpcs.length === 1) {
    return new ethers.JsonRpcProvider(rpcs[0]);
  }
  // FallbackProvider: достаточно 1 ответа для чтения, для записи используется первый
  return new ethers.FallbackProvider(
    rpcs.map(url => new ethers.JsonRpcProvider(url)),
    undefined,
    { quorum: 1 }
  );
}

/**
 * Инстанс Insurance-контракта (read-only, для write делай .connect(signer)).
 */
export function getInsuranceContract(
  address: string,
  provider: ethers.Provider
): ethers.Contract {
  return new ethers.Contract(address, ZEUS_INSURANCE_ABI, provider);
}

/**
 * Инстанс Reserve-контракта (read-only).
 */
export function getReserveContract(
  address: string,
  provider: ethers.Provider
): ethers.Contract {
  return new ethers.Contract(address, ZEUS_RESERVE_ABI, provider);
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy alias — чтобы не сломать старые импорты
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated используй getInsuranceContract */
export const getContract = getInsuranceContract;
