import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * Shared viem public client — Base Sepolia testnet.
 * Uses sepolia.base.org (official Base RPC).
 * eth_getLogs block-range limit (2 000 blocks) is handled by pagination
 * in chain-sync.ts — no need for an archive/premium RPC.
 */
export const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});
