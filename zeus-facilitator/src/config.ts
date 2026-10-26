/**
 * Zeus facilitator — network registry and runtime config.
 *
 * Two-facilitator architecture (user decision, 2026-10-26):
 *   - EXTERNAL FREE facilitator (x402 library default / Coinbase CDP) covers
 *     base, base-sepolia and other major networks — used in dev/test where it
 *     is free and requires no infrastructure.
 *   - THIS (Zeus-operated) facilitator covers the networks the free one does
 *     NOT support — first and foremost X Layer (eip155:196) native USDC.
 *
 * The registry deliberately pins the EIP-712 domain per network. D1
 * (UNVERIFIED_ASSUMPTIONS row D1, verified on-chain 2026-10-26): USDC on
 * X Layer enforces name "USD Coin" / version "2" — its on-chain
 * DOMAIN_SEPARATOR matches exactly these values.
 */
import type { Address, Hex } from "viem";

export interface FacilitatorNetwork {
  /** CAIP-2 network id as spoken by the x402 v2 config in this repo. */
  readonly id: string;
  readonly chainId: number;
  /** EIP-3009 (FiatToken) USDC contract — the verifying contract. */
  readonly usdc: Address;
  readonly domain: { readonly name: string; readonly version: string };
  readonly testnet: boolean;
  /** Native gas asset symbol (log/observability only). */
  readonly gasSymbol: string;
}

export const FACILITATOR_NETWORKS: Readonly<Record<string, FacilitatorNetwork>> = Object.freeze({
  "eip155:196": Object.freeze({
    id: "eip155:196",
    chainId: 196,
    usdc: "0x74b7F16337b8972027F6196A17a631aC6dE26d22" as Address,
    domain: Object.freeze({ name: "USD Coin", version: "2" }),
    testnet: false,
    gasSymbol: "OKB",
  }),
  // Staging network: same wire contract, free testnet USDC.
  // Domain verified against the LIVE contract (local anvil fork of
  // sepolia.base.org, 2026-10-27): DOMAIN_SEPARATOR() ==
  // 0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818 ==
  // keccak256(abi.encode(EIP712Domain-typehash, keccak("USDC"), keccak("2"),
  // 84532, 0x036CbD…CF7e)). NOTE: Circle's Base Sepolia USDC was initialized
  // with name "USDC" (NOT "USD Coin" — that is the X Layer / Base-mainnet
  // value); the official x402 SDK chain config agrees (usdcName: "USDC"
  // for 84532). Signing/verifying with "USD Coin" here would never recover
  // the payer and transferWithAuthorization would revert on-chain.
  "eip155:84532": Object.freeze({
    id: "eip155:84532",
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
    domain: Object.freeze({ name: "USDC", version: "2" }),
    testnet: true,
    gasSymbol: "ETH",
  }),
});

export interface FacilitatorConfig {
  readonly network: FacilitatorNetwork;
  /** One or more JSON-RPC endpoints (first is primary, rest are fallbacks). */
  readonly rpcUrls: readonly string[];
  /** Gas payer for broadcasting transferWithAuthorization. MUST be a dedicated
   * key — NEVER the Secretariat signer key (F-116: the two roles must never
   * share a key; they authorize different things). */
  readonly gasPrivateKey: Hex;
  /** Optional static bearer key; empty = unauthenticated (firewalled deploys). */
  readonly apiKey: string;
  readonly port: number;
  /** Refuse to serve a network marked testnet when NODE_ENV=production. */
  readonly nodeEnv: string;
  /** Receipt wait budget in ms (200 + success:false is pre-flight only). */
  readonly receiptTimeoutMs: number;
  /** Require payer balance >= value during verification. */
  readonly checkPayerBalance: boolean;
}

export class ConfigError extends Error {}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const networkId = (env["ZEUS_FACILITATOR_NETWORK"] ?? "eip155:196").trim();
  const network = FACILITATOR_NETWORKS[networkId];
  if (!network) {
    throw new ConfigError(
      `ZEUS_FACILITATOR_NETWORK '${networkId}' is not in the registry: ${Object.keys(FACILITATOR_NETWORKS).join(", ")}`,
    );
  }

  const nodeEnv = (env["NODE_ENV"] ?? "development").trim();
  if (nodeEnv === "production" && network.testnet) {
    throw new ConfigError(
      `refusing testnet network ${networkId} with NODE_ENV=production (custodial_test lesson F-113/C-4)`,
    );
  }

  const rpcUrls = requireEnv(env, "ZEUS_FACILITATOR_RPC_URLS")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (rpcUrls.length === 0) throw new ConfigError("ZEUS_FACILITATOR_RPC_URLS is required");

  const gasPrivateKey = requireEnv(env, "ZEUS_FACILITATOR_GAS_PRIVATE_KEY") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(gasPrivateKey)) {
    throw new ConfigError("ZEUS_FACILITATOR_GAS_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }

  const port = Number.parseInt(env["PORT"] ?? "3001", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError("PORT must be an integer in (0, 65535]");
  }

  const receiptTimeoutMs = Number.parseInt(env["ZEUS_FACILITATOR_RECEIPT_TIMEOUT_MS"] ?? "45000", 10);
  if (!Number.isInteger(receiptTimeoutMs) || receiptTimeoutMs <= 0) {
    throw new ConfigError("ZEUS_FACILITATOR_RECEIPT_TIMEOUT_MS must be a positive integer");
  }

  return {
    network,
    rpcUrls,
    gasPrivateKey,
    apiKey: (env["ZEUS_FACILITATOR_API_KEY"] ?? "").trim(),
    port,
    nodeEnv,
    receiptTimeoutMs,
    checkPayerBalance: (env["ZEUS_FACILITATOR_CHECK_PAYER_BALANCE"] ?? "true").trim() !== "false",
  };
}
