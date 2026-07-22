// ─── Deployed addresses (Base Sepolia testnet) ───────────────────────────────
export const ZEUS_INSURANCE_ADDRESS =
  "0x58038Df01A824C94F3D2fEd6d4e1bEf2211Ad8F4" as const;

export const ZEUS_RESERVE_ADDRESS =
  "0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47" as const;

// ─── ZeusInsuranceV2 ABI (subset used by server) ─────────────────────────────
export const ZEUS_INSURANCE_ABI = [
  // ── Functions ────────────────────────────────────────────────────────────────
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
    inputs: [{ internalType: "uint256", name: "policyId", type: "uint256" }],
    name: "getPolicy",
    outputs: [
      {
        components: [
          { internalType: "address", name: "buyer",         type: "address" },
          { internalType: "address", name: "seller",        type: "address" },
          { internalType: "uint256", name: "amount",        type: "uint256" },
          { internalType: "uint256", name: "premium",       type: "uint256" },
          { internalType: "uint256", name: "retryDeadline", type: "uint256" },
          { internalType: "uint256", name: "maxRetries",    type: "uint256" },
          { internalType: "uint8",   name: "status",        type: "uint8"   },
        ],
        internalType: "struct ZeusInsuranceV2.Policy",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  // ── Events ────────────────────────────────────────────────────────────────────
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: "uint256", name: "policyId",      type: "uint256" },
      { indexed: true,  internalType: "address", name: "buyer",         type: "address" },
      { indexed: true,  internalType: "address", name: "seller",        type: "address" },
      { indexed: false, internalType: "uint256", name: "amount",        type: "uint256" },
      { indexed: false, internalType: "uint256", name: "premium",       type: "uint256" },
      { indexed: false, internalType: "uint256", name: "retryDeadline", type: "uint256" },
    ],
    name: "PolicyCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: "uint256", name: "policyId", type: "uint256" },
      { indexed: true,  internalType: "address", name: "buyer",    type: "address" },
      { indexed: false, internalType: "uint256", name: "amount",   type: "uint256" },
    ],
    name: "ClaimPaid",
    type: "event",
  },
] as const;

// ─── ZeusReserveV2 ABI (subset used by server) ───────────────────────────────
export const ZEUS_RESERVE_ABI = [
  {
    inputs: [],
    name: "getReserveBalance",
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
    name: "maxDailyPayout",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
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
    inputs: [],
    name: "isAdequatelyFunded",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Premium = (7% + 2% × (retries−1)) of amount — mirrors frontend logic */
export function computePremium(amount: bigint, retries: number): bigint {
  const bps = BigInt(700 + (retries - 1) * 200);
  return (amount * bps) / 10_000n;
}
