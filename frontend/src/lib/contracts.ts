import type { SupportedChainId } from "@/lib/wagmi";

// ─── Per-network contract addresses ──────────────────────────────────────────

export const CONTRACT_ADDRESSES: Record<SupportedChainId, {
  insurance: `0x${string}`;
  reserve:   `0x${string}`;
  token:     `0x${string}`;
  escrow:    `0x${string}`;
  deployBlock: bigint;
}> = {
  // X Layer Mainnet (chain 196)
  196: {
    insurance:   "0x8D10C2c6C92b613C1938fe532f0e391044e76188" as `0x${string}`,
    reserve:     "0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c" as `0x${string}`,
    token:       "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C" as `0x${string}`, // USDT on X Layer
    escrow:      "0x0d4AD4C6b60F445d0e478E0AF48075340AC51Cf5" as `0x${string}`,
    deployBlock: 1_000_000n,
  },
  // BOT Chain Mainnet (chain 677)
  677: {
    insurance:   "0x8D10C2c6C92b613C1938fe532f0e391044e76188" as `0x${string}`,
    reserve:     "0xadED902c2C6dD7D1B5b72A6a0A3358a9b9d4A79c" as `0x${string}`,
    token:       "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C" as `0x${string}`, // USDT on BOT Chain Mainnet
    escrow:      "0x0d4AD4C6b60F445d0e478E0AF48075340AC51Cf5" as `0x${string}`,
    deployBlock: 44_268_060n,
  },
};

/** Returns addresses for the given chainId, falling back to BOT Chain Mainnet. */
export function getContracts(chainId?: number) {
  return CONTRACT_ADDRESSES[(chainId as SupportedChainId) ?? 677] ?? CONTRACT_ADDRESSES[677];
}

// ─── Legacy single-chain exports (BOT Chain Mainnet defaults) ─────────────────────────
export const ZEUS_INSURANCE_ADDRESS = CONTRACT_ADDRESSES[677].insurance;
export const ZEUS_RESERVE_ADDRESS   = CONTRACT_ADDRESSES[677].reserve;
export const USDC_ADDRESS           = CONTRACT_ADDRESSES[677].token; // kept for compat
export const INSURANCE_DEPLOY_BLOCK = CONTRACT_ADDRESSES[677].deployBlock;

// ─── ZeusInsuranceV2 ABI ─────────────────────────────────────────────────────
export const ZEUS_INSURANCE_ABI = [
  {
    inputs: [{ internalType: "address", name: "_usdc", type: "address" }, { internalType: "address", name: "_reserve", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }], name: "OwnableInvalidOwner", type: "error" },
  { inputs: [{ internalType: "address", name: "account", type: "address" }], name: "OwnableUnauthorizedAccount", type: "error" },
  { inputs: [], name: "ReentrancyGuardReentrantCall", type: "error" },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "claimId", type: "uint256" },
      { indexed: true, internalType: "address", name: "claimant", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "ClaimApproved",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "policyId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "PayoutExecuted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "policyId", type: "uint256" },
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "premium", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "retryDeadline", type: "uint256" },
    ],
    name: "PolicyCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "uint256", name: "policyId", type: "uint256" }],
    name: "PolicyExpired",
    type: "event",
  },
  {
    inputs: [
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "timeoutSeconds", type: "uint256" },
      { internalType: "uint256", name: "maxRetries", type: "uint256" },
    ],
    name: "buyInsurance",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "policyId", type: "uint256" }],
    name: "claimPayout",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "claimId", type: "uint256" },
      { internalType: "address", name: "claimant", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "isClaimApproved",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "claimId", type: "uint256" }],
    name: "markClaimFulfilled",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "nextPolicyId",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "policies",
    outputs: [
      { internalType: "address", name: "buyer", type: "address" },
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "premium", type: "uint256" },
      { internalType: "uint256", name: "retryDeadline", type: "uint256" },
      { internalType: "uint256", name: "maxRetries", type: "uint256" },
      { internalType: "bool", name: "isActive", type: "bool" },
      { internalType: "bool", name: "isPaidOut", type: "bool" },
      { internalType: "bool", name: "isExpired", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "policyId", type: "uint256" }],
    name: "getPolicy",
    outputs: [
      {
        components: [
          { internalType: "address", name: "buyer", type: "address" },
          { internalType: "address", name: "seller", type: "address" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "uint256", name: "premium", type: "uint256" },
          { internalType: "uint256", name: "retryDeadline", type: "uint256" },
          { internalType: "uint256", name: "maxRetries", type: "uint256" },
          { internalType: "bool", name: "isActive", type: "bool" },
          { internalType: "bool", name: "isPaidOut", type: "bool" },
          { internalType: "bool", name: "isExpired", type: "bool" },
        ],
        internalType: "struct ZeusInsuranceV2.Policy",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "reserve",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_reserve", type: "address" }],
    name: "setReserve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── ZeusReserveV2 ABI ───────────────────────────────────────────────────────
export const ZEUS_RESERVE_ABI = [
  {
    inputs: [{ internalType: "address", name: "_usdc", type: "address" }, { internalType: "address", name: "initialOwner", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  { inputs: [{ internalType: "uint256", name: "claimId", type: "uint256" }], name: "ClaimAlreadyFulfilled", type: "error" },
  { inputs: [{ internalType: "uint256", name: "claimId", type: "uint256" }], name: "ClaimNotApproved", type: "error" },
  { inputs: [{ internalType: "uint256", name: "attempted", type: "uint256" }, { internalType: "uint256", name: "remaining", type: "uint256" }], name: "DailyPayoutLimitExceeded", type: "error" },
  { inputs: [{ internalType: "uint256", name: "available", type: "uint256" }, { internalType: "uint256", name: "required", type: "uint256" }], name: "InsufficientReserve", type: "error" },
  { inputs: [{ internalType: "address", name: "addr", type: "address" }], name: "NotAContract", type: "error" },
  { inputs: [{ internalType: "address", name: "caller", type: "address" }], name: "NotInsuranceContract", type: "error" },
  { inputs: [], name: "ReserveBelowThreshold", type: "error" },
  { inputs: [], name: "TransferFailed", type: "error" },
  { inputs: [], name: "ZeroAddress", type: "error" },
  { inputs: [], name: "ZeroAmount", type: "error" },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "claimId", type: "uint256" },
      { indexed: true, internalType: "address", name: "claimant", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "ClaimPaid",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "oldContract", type: "address" },
      { indexed: true, internalType: "address", name: "newContract", type: "address" },
    ],
    name: "InsuranceContractUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "oldValue", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newValue", type: "uint256" },
    ],
    name: "MaxDailyPayoutUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "oldValue", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "newValue", type: "uint256" },
    ],
    name: "MinReserveThresholdUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "ReserveDeposited",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "ReserveWithdrawn",
    type: "event",
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "dailyPayouts",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "fulfilledClaims",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getReserveBalance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "isAdequatelyFunded",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "insuranceContract",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxDailyPayout",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "minReserveThreshold",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "remainingDailyPayout",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_contract", type: "address" }],
    name: "setInsuranceContract",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "usdc",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── ERC-20 minimal ABI ───────────────────────────────────────────────────────
export const ERC20_ABI = [
  {
    inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }, { internalType: "address", name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** USDT uses 6 decimals on both X Layer and BOT Chain */
export const TOKEN_DECIMALS = 6;
/** @deprecated use TOKEN_DECIMALS */
export const USDC_DECIMALS = TOKEN_DECIMALS;

/** Format a raw token amount (6 decimals) to a human-readable string. */
export function formatUsdc(raw: bigint | undefined, decimals = 2): string {
  if (raw === undefined) return "–";
  const divisor = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(TOKEN_DECIMALS, "0").slice(0, decimals);
  return `${whole.toLocaleString()}.${fracStr}`;
}
/** Alias */
export const formatToken = formatUsdc;

/** Parse a human-readable token string (e.g. "100.50") to a bigint (6 decimals). */
export function parseUsdc(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const fracPadded = frac.padEnd(TOKEN_DECIMALS, "0").slice(0, TOKEN_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fracPadded || "0");
}
/** Alias */
export const parseToken = parseUsdc;

/** Standard policy premium: base 7% + 2% per extra retry */
export function computePremium(amount: bigint, retries: number): bigint {
  const bps = BigInt(700 + (retries - 1) * 200);
  return (amount * bps) / 10_000n;
}

// ─── Slashing protection premium ──────────────────────────────────────────────

export type ValidatorRisk = "active" | "new" | "slashed";

/**
 * Returns the premium rate in basis points for slashing protection.
 * BOT Chain (677): base 15%, +3% for new validators, +5% for previously slashed.
 * X Layer (196):   base 12%, +3% for new validators, +5% for previously slashed.
 */
export function computeSlashingPremiumBps(chainId: number, risk: ValidatorRisk): number {
  const base = chainId === 677 ? 1500 : 1200;
  if (risk === "slashed") return base + 500;
  if (risk === "new")     return base + 300;
  return base;
}

export function computeSlashingPremium(amount: bigint, chainId: number, risk: ValidatorRisk): bigint {
  const bps = BigInt(computeSlashingPremiumBps(chainId, risk));
  return (amount * bps) / 10_000n;
}

/** Returns the payment token symbol for a given chainId. */
export function getTokenSymbol(chainId: number): string {
  if (chainId === 677) return "USDT"; // BOT Chain
  if (chainId === 196) return "USDC"; // X Layer
  return "USDC";                       // default
}
