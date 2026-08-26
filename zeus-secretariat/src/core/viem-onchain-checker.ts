/**
 * Zeus Secretariat V0 - Real On-Chain Checker (P0-4)
 *
 * section 6: Blockchain is System of Record
 * section 7: SETTLED proof requires full evidence bundle
 * authorizationState == true alone is NOT sufficient for SETTLED
 */

import { createPublicClient, http, parseAbiItem, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import type { RpcProviderConfig, FinalityPolicy } from "./types";
import { DEFAULT_FINALITY_POLICY } from "./types";

// EIP-3009 AuthorizationUsed(address authorizer, bytes32 nonce)
const AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"
);

// ERC-20 Transfer(address from, address to, uint256 value)
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// authorizationState(address,bytes32) function selector
const AUTH_STATE_ABI = parseAbiItem(
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"
);

export interface TransactionCheckResult {
  confirmed: boolean;
  blockNumber?: number;
  status: "success" | "reverted" | "pending";
  logs?: Array<{ address: string; topics: string[]; data: string; logIndex: number }>;
  confirmations?: number;
}

export interface AuthorizationUsedResult {
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
}

export interface TransferMatchResult {
  from: string;
  to: string;
  value: bigint;
  tokenContract: string;
}

export class ViemOnChainChecker {
  private readonly client: PublicClient;
  private readonly finalityPolicy: FinalityPolicy;

  constructor(rpcUrl: string, finalityPolicy: FinalityPolicy = DEFAULT_FINALITY_POLICY) {
    this.client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    this.finalityPolicy = finalityPolicy;
  }

  async getBlockNumber(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  /** section 6: Check authorizationState(authorizer, nonce) */
  async checkAuthorizationState(tokenContract: `0x${string}`, authorizer: `0x${string}`, nonce: `0x${string}`): Promise<boolean> {
    return await this.client.readContract({
      address: tokenContract,
      abi: [AUTH_STATE_ABI],
      functionName: "authorizationState",
      args: [authorizer, nonce],
    });
  }

  /** section 6: Find AuthorizationUsed event to recover txHash */
  async findAuthorizationUsed(
    tokenContract: `0x${string}`,
    authorizer: `0x${string}`,
    nonce: `0x${string}`,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<AuthorizationUsedResult | null> {
    const logs = await this.client.getLogs({
      address: tokenContract,
      event: AUTHORIZATION_USED_EVENT,
      args: { authorizer, nonce },
      fromBlock,
      toBlock,
    });
    if (logs.length === 0) return null;
    const log = logs[0];
    return {
      transactionHash: log.transactionHash!,
      blockNumber: Number(log.blockNumber!),
      logIndex: log.logIndex!,
    };
  }

  /** section 7 + 8: Get receipt and verify Transfer matching */
  async verifySettledProof(
    txHash: `0x${string}`,
    expectedFrom: `0x${string}`,
    expectedTo: `0x${string}`,
    expectedMinValue: bigint,
    expectedTokenContract: `0x${string}`,
  ): Promise<{
    receiptStatus: number;
    blockNumber: number;
    confirmations: number;
    transfer: TransferMatchResult | null;
    authorizationUsed: AuthorizationUsedResult | null;
  } | null> {
    const receipt = await this.client.getTransactionReceipt({ hash: txHash });
    if (!receipt) return null;

    const chainHead = await this.getBlockNumber();
    const blockNumber = Number(receipt.blockNumber);
    const confirmations = chainHead - blockNumber;
    const receiptStatus = receipt.status === "success" ? 1 : 0;

    // section 9: Reverted tx = no settlement
    if (receiptStatus === 0) {
      return { receiptStatus, blockNumber, confirmations, transfer: null, authorizationUsed: null };
    }

    // Find AuthorizationUsed in logs
    let authorizationUsed: AuthorizationUsedResult | null = null;
    for (const log of receipt.logs) {
      if (log.topics.length >= 3 && log.address.toLowerCase() === expectedTokenContract.toLowerCase()) {
        // Check if this is AuthorizationUsed event
        try {
          const decoded = await this.client.decodeEventLog({
            abi: [AUTHORIZATION_USED_EVENT],
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (decoded.eventName === "AuthorizationUsed") {
            authorizationUsed = {
              transactionHash: txHash,
              blockNumber,
              logIndex: log.logIndex ?? 0,
            };
          }
        } catch { /* not this event */ }
      }
    }

    // section 8: Find matching Transfer
    let transfer: TransferMatchResult | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== expectedTokenContract.toLowerCase()) continue;
      try {
        const decoded = await this.client.decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        if (decoded.eventName === "Transfer") {
          const args = decoded.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
          if (
            args.from.toLowerCase() === expectedFrom.toLowerCase() &&
            args.to.toLowerCase() === expectedTo.toLowerCase() &&
            args.value >= expectedMinValue
          ) {
            transfer = {
              from: args.from,
              to: args.to,
              value: args.value,
              tokenContract: log.address.toLowerCase(),
            };
          }
        }
      } catch { /* not Transfer */ }
    }

    return { receiptStatus, blockNumber, confirmations, transfer, authorizationUsed };
  }

  getFinalityPolicy(): FinalityPolicy { return this.finalityPolicy; }
}
