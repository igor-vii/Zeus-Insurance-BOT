import { getClient } from "./chain.js";
import { encodeFunctionData, parseAbi } from "viem";

// ─── Network config ──────────────────────────────────────────────────────────
export const SUPPORTED_NETWORKS = {
  "base-sepolia": { chainId: 84532, rpc: process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org" },
  "x-layer":      { chainId: 196,   rpc: process.env["XLAYER_MAINNET_RPC_URL"] ?? "https://rpc.xlayer.tech" },
  "bot-chain":    { chainId: 677,   rpc: process.env["BOT_CHAIN_RPC_URL"] ?? "https://rpc.botchain.ai" },
} as const;

export type SupportedNetwork = keyof typeof SUPPORTED_NETWORKS;

// ─── Address resolver ────────────────────────────────────────────────────────
function getAddr(network: SupportedNetwork, type: "insurance" | "reserve"): `0x${string}` {
  const suffix = network === "base-sepolia" ? "" : `_${network.toUpperCase().replace("-", "_")}`;
  const key = type === "insurance" ? `ZEUS_INSURANCE_ADDRESS${suffix}` : `ZEUS_RESERVE_ADDRESS${suffix}`;
  const val = process.env[key];
  if (!val) throw new Error(`Missing env: ${key}`);
  return val as `0x${string}`;
}

export const getInsuranceAddress = (n: SupportedNetwork = "x-layer") => getAddr(n, "insurance");
export const getReserveAddress   = (n: SupportedNetwork = "x-layer") => getAddr(n, "reserve");

// ─── ZeusInsuranceV2 v2.4 ABI ────────────────────────────────────────────────
export const ZEUS_INSURANCE_ABI = parseAbi([
  // Write
  "function buyPolicy(address seller, uint256 amount, uint256 timeoutSeconds, uint256 maxRetries, uint256 premium) returns (uint256)",
  "function buySlashingProtection(address validator, uint256 amount, uint256 timeoutSeconds, uint256 premium) returns (uint256)",
  "function claimPayout(uint256 policyId)",
  "function submitObservation(uint256 policyId, (bytes32 requestId, uint256 timestamp, uint8 status, bytes32 metadataHash, uint256 nonce, bytes signature) observation)",
  "function submitSlashingVote(uint256 policyId, bytes32 evidenceHash, uint256 timestamp, uint256 nonce, bytes signature)",
  // View
  "function policies(uint256) view returns (address buyer, address seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint256 maxRetries, uint8 status, uint8 coverageType)",
  "function nextPolicyId() view returns (uint256)",
  "function isWatcher(address) view returns (bool)",
  "function canClaim(uint256) view returns (bool)",
  "function canSlash(uint256) view returns (bool)",
  "function hasPendingClaims() view returns (bool)",
  "function getCoverageType(uint256) view returns (uint8)",
  "function getWatchers() view returns (address[])",
  // Events
  "event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint8 coverageType)",
  "event PayoutExecuted(uint256 indexed policyId, uint256 amount)",
  "event ClaimRejected(uint256 indexed policyId)",
  "event PolicyExpired(uint256 indexed policyId)",
  "event SlashingResolved(uint256 indexed policyId, bool approved)",
  "event SlashingReported(uint256 indexed policyId, address indexed validator, bytes32 indexed evidenceHash)",
  "event VoteResolved(bytes32 indexed requestId, uint8 decision, uint256 indexed policyId)",
  "event ObservationSubmitted(bytes32 indexed requestId, address indexed watcher, uint8 status)",
] as const);

// ─── ZeusReserveV2 ABI ───────────────────────────────────────────────────────
export const ZEUS_RESERVE_ABI = parseAbi([
  "function payClaim(uint256 claimId, address claimant, uint256 amount)",
  "function getReserveBalance() view returns (uint256)",
  "function minReserveThreshold() view returns (uint256)",
  "function maxDailyPayout() view returns (uint256)",
  "function remainingDailyPayout() view returns (uint256)",
  "function isAdequatelyFunded() view returns (bool)",
  "function fulfilledClaims(uint256) view returns (bool)",
  "function insuranceContract() view returns (address)",
  "function hasPendingClaims() view returns (bool)",
] as const);

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function computePremium(amount: bigint, retries: number): bigint {
  const bps = BigInt(700 + (retries - 1) * 200);
  return (amount * bps) / 10_000n;
}

export function encodeBuyPolicy(
  seller: `0x${string}`,
  amount: bigint,
  timeoutSeconds: number,
  maxRetries: number,
  premium: bigint
) {
  return encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "buyPolicy",
    args: [seller, amount, BigInt(timeoutSeconds), BigInt(maxRetries), premium],
  });
}

export function encodeClaimPayout(policyId: bigint) {
  return encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "claimPayout",
    args: [policyId],
  });
}

export const ZEUS_INSURANCE_ADDRESS = "0x8D10C2c6C92b613C1938fe532f0e391044e76188";
export const ZEUS_RESERVE_ADDRESS = "0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c";

export const publicClient = getClient(677);

