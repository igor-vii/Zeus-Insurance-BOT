/**
 * ZeusEscrowBOT contract constants for the API server.
 *
 * Deploy the contract and set ZEUS_ESCROW_BOT_ADDRESS (or the network-suffixed
 * ZEUS_ESCROW_BOT_ADDRESS_XLAYER / _X_LAYER / _BOT_CHAIN documented in
 * .env.example) in your environment. Until then, escrow calldata endpoints
 * will return a 503 with a clear message.
 *
 * R2 repair: .env.example documents the suffixed ZEUS_ESCROW_BOT_ADDRESS_XLAYER
 * key but this module only read the unsuffixed one — an operator following the
 * documented env file got the base-sepolia escrow (or an empty address) on the
 * X Layer deployment. Resolution order: suffixed (ACTIVE_NETWORK) → unsuffixed.
 */
function resolveEscrowAddress(): `0x${string}` {
  const prefix = "ZEUS_ESCROW_BOT_ADDRESS";
  const network = process.env["ZEUS_INSURANCE_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "x-layer";
  const upper = network.toUpperCase();
  const candidates =
    network === "base-sepolia"
      ? [prefix]
      : [`${prefix}_${upper.replace("-", "_")}`, `${prefix}_${upper.replace(/-/g, "")}`, prefix];
  for (const key of candidates) {
    const val = process.env[key];
    if (val) return val as `0x${string}`;
  }
  return "" as `0x${string}`;
}

export const ZEUS_ESCROW_BOT_ADDRESS = resolveEscrowAddress();

export const ZEUS_ESCROW_BOT_ABI = [
  {
    inputs: [{ internalType: "address", name: "_token", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "ReentrancyGuardReentrantCall",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "SafeERC20FailedOperation",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agreementId", type: "uint256" },
      { indexed: true, internalType: "address", name: "initiator", type: "address" },
      { indexed: true, internalType: "address", name: "executor", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "timeout", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "createdAt", type: "uint256" },
    ],
    name: "AgreementCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agreementId", type: "uint256" },
      { indexed: true, internalType: "address", name: "executor", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "proof", type: "bytes" },
    ],
    name: "ExecutionConfirmed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agreementId", type: "uint256" },
      { indexed: true, internalType: "address", name: "initiator", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "RefundIssued",
    type: "event",
  },
  {
    inputs: [],
    name: "agreementCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "agreements",
    outputs: [
      { internalType: "address", name: "initiator", type: "address" },
      { internalType: "address", name: "executor", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "timeout", type: "uint256" },
      { internalType: "uint256", name: "createdAt", type: "uint256" },
      { internalType: "enum ZeusEscrowBOT.AgreementStatus", name: "status", type: "uint8" },
      { internalType: "bytes", name: "proof", type: "bytes" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "agreementId", type: "uint256" },
      { internalType: "bytes", name: "proof", type: "bytes" },
    ],
    name: "confirmExecution",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "executor", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "timeout", type: "uint256" },
    ],
    name: "depositAndCreateAgreement",
    outputs: [{ internalType: "uint256", name: "agreementId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "agreementId", type: "uint256" }],
    name: "getAgreement",
    outputs: [
      {
        components: [
          { internalType: "address", name: "initiator", type: "address" },
          { internalType: "address", name: "executor", type: "address" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "uint256", name: "timeout", type: "uint256" },
          { internalType: "uint256", name: "createdAt", type: "uint256" },
          { internalType: "enum ZeusEscrowBOT.AgreementStatus", name: "status", type: "uint8" },
          { internalType: "bytes", name: "proof", type: "bytes" },
        ],
        internalType: "struct ZeusEscrowBOT.Agreement",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "agreementId", type: "uint256" }],
    name: "requestRefund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
