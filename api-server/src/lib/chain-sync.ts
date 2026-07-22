import { parseAbiItem } from "viem";
import { publicClient } from "./chain.js";
import {
  ZEUS_INSURANCE_ADDRESS,
  ZEUS_INSURANCE_ABI,
} from "./contracts-server.js";
import { upsertPolicies, type CachedPolicy } from "./policy-cache.js";
import { logger } from "./logger.js";

const CHUNK_SIZE = 2000n;

/**
 * Block at which ZeusInsuranceV2 (0xE0b89E0DEa7Fc7AEa7CEcC62a0A14d52de42Ce3b)
 * was deployed on Base Sepolia. Scanning from 0 wastes thousands of RPC
 * requests — start here instead.
 * Verified via eth_getTransactionReceipt of creation tx 0x769f8682...
 */
const DEPLOY_BLOCK = 43_540_426n;

const POLICY_CREATED_EVENT = parseAbiItem(
  "event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline)",
);

/**
 * Fetches all PolicyCreated logs for a buyer using 2 000-block chunks.
 * Public RPCs (including publicnode.com) cap eth_getLogs range — pagination
 * keeps every request within limits regardless of the RPC being used.
 */
async function fetchPolicyCreatedLogs(buyer: `0x${string}`) {
  const latestBlock = await publicClient.getBlockNumber();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];

  let cursor = DEPLOY_BLOCK;
  while (cursor <= latestBlock) {
    const chunkEnd =
      cursor + CHUNK_SIZE - 1n < latestBlock
        ? cursor + CHUNK_SIZE - 1n
        : latestBlock;

    const chunk = await publicClient.getLogs({
      address: ZEUS_INSURANCE_ADDRESS,
      event: POLICY_CREATED_EVENT,
      args: { buyer },
      fromBlock: cursor,
      toBlock: chunkEnd,
    });

    all.push(...chunk);
    cursor = chunkEnd + 1n;
  }

  return all;
}

/**
 * Fetches all policies for a buyer from the chain (event log + multicall),
 * writes results to the cache, and returns the policy list.
 */
export async function fetchAndCachePolicies(buyer: string): Promise<CachedPolicy[]> {
  const logs = await fetchPolicyCreatedLogs(buyer as `0x${string}`);

  const ids = [
    ...new Set(
      logs.map((l) => l.args.policyId).filter((id): id is bigint => id !== undefined),
    ),
  ].sort((a, b) => (b > a ? 1 : -1));

  if (ids.length === 0) return [];

  const results = await publicClient.multicall({
    contracts: ids.map((id) => ({
      address: ZEUS_INSURANCE_ADDRESS,
      abi: ZEUS_INSURANCE_ABI,
      functionName: "getPolicy" as const,
      args: [id] as const,
    })),
  });

  const policies: CachedPolicy[] = [];
  for (let i = 0; i < ids.length; i++) {
    const r = results[i];
    if (r.status !== "success") continue;
    const p = r.result as {
      buyer: string; seller: string; amount: bigint; premium: bigint;
      retryDeadline: bigint; maxRetries: bigint;
      // V2 contract: PolicyStatus enum (0=Active,1=Claimed,2=Rejected,3=Expired)
      status?: number;
      // Legacy boolean fields (V1 compat — may be absent)
      isActive?: boolean; isPaidOut?: boolean; isExpired?: boolean;
    };
    // Derive booleans from enum when present (new contract), or use raw booleans (old)
    const status = p.status ?? (p.isActive ? 0 : p.isPaidOut ? 1 : p.isExpired ? 3 : 0);
    policies.push({
      id: ids[i].toString(),
      buyer: p.buyer,
      seller: p.seller,
      amount: p.amount.toString(),
      premium: p.premium.toString(),
      retryDeadline: p.retryDeadline.toString(),
      maxRetries: p.maxRetries.toString(),
      isActive:  status === 0,
      isPaidOut: status === 1,
      isExpired: status === 3,
    });
  }

  void upsertPolicies(policies);
  return policies;
}

/**
 * Fetches a single policy from the chain and updates the cache.
 */
export async function fetchAndCachePolicy(id: string): Promise<CachedPolicy | null> {
  try {
    const p = (await publicClient.readContract({
      address: ZEUS_INSURANCE_ADDRESS,
      abi: ZEUS_INSURANCE_ABI,
      functionName: "getPolicy",
      args: [BigInt(id)],
    })) as {
      buyer: string; seller: string; amount: bigint; premium: bigint;
      retryDeadline: bigint; maxRetries: bigint;
      status?: number;
      isActive?: boolean; isPaidOut?: boolean; isExpired?: boolean;
    };

    const status = p.status ?? (p.isActive ? 0 : p.isPaidOut ? 1 : p.isExpired ? 3 : 0);
    const policy: CachedPolicy = {
      id,
      buyer: p.buyer,
      seller: p.seller,
      amount: p.amount.toString(),
      premium: p.premium.toString(),
      retryDeadline: p.retryDeadline.toString(),
      maxRetries: p.maxRetries.toString(),
      isActive:  status === 0,
      isPaidOut: status === 1,
      isExpired: status === 3,
    };

    void upsertPolicies([policy]);
    return policy;
  } catch (err) {
    logger.warn({ err, id }, "[chain-sync] fetchAndCachePolicy failed");
    return null;
  }
}
