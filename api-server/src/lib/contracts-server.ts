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
// A2/A5 repair: the resolver used to build `..._X_LAYER`, while .env.example
// documents `..._XLAYER` — deployments following the documented env file could
// never resolve. Accept both spellings (dash-expanded first — the only spelling
// the old resolver ever read — then the compact .env.example form).
function getAddr(network: SupportedNetwork, type: "insurance" | "reserve"): `0x${string}` {
  const prefix = type === "insurance" ? "ZEUS_INSURANCE_ADDRESS" : "ZEUS_RESERVE_ADDRESS";
  const keys = network === "base-sepolia"
    ? [prefix]
    : [
        `${prefix}_${network.toUpperCase().replace("-", "_")}`,
        `${prefix}_${network.toUpperCase().replace(/-/g, "")}`,
      ];
  for (const key of keys) {
    const val = process.env[key];
    if (val) return val as `0x${string}`;
  }
  throw new Error(`Missing env: set one of [${keys.join(", ")}]`);
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

// A4 repair: contract addresses are deployment configuration, not source code.
// Resolve from env for the ACTIVE network at module init — a deployment with
// missing address config must fail fast at boot, not route payments to a
// hardcoded address baked into a previous build.
export const ACTIVE_NETWORK: SupportedNetwork =
  (process.env["ZEUS_INSURANCE_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "x-layer") as SupportedNetwork;

export const ZEUS_INSURANCE_ADDRESS = getAddr(ACTIVE_NETWORK, "insurance");
export const ZEUS_RESERVE_ADDRESS = getAddr(ACTIVE_NETWORK, "reserve");

// R2 repair: the default client was pinned to BOT Chain (677) while the
// resolved addresses follow ACTIVE_NETWORK — e.g. /reserve multicalls read the
// X Layer reserve address through the BOT Chain client. Route reads through
// the client of the SAME chain the addresses belong to.
export const publicClient = getClient(SUPPORTED_NETWORKS[ACTIVE_NETWORK].chainId);

