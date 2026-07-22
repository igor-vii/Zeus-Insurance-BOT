/**
 * ZeusEscrowBOT contract constants for the API server.
 *
 * Deploy the contract and set ZEUS_ESCROW_BOT_ADDRESS in your environment.
 * Until then, escrow calldata endpoints will return a 503 with a clear message.
 */
export const ZEUS_ESCROW_BOT_ADDRESS = (
  process.env["ZEUS_ESCROW_BOT_ADDRESS"] ?? ""
) as `0x${string}`;

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
