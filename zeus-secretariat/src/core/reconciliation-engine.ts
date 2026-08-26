/**
 * Zeus Secretariat V0 — Phase 2.3: Reconciliation Engine
 *
 * Resolves UNKNOWN payment statuses by checking on-chain state.
 * Uses nonce as the primary anchor when txHash is unavailable.
 *
 * Three possible outcomes:
 *   SETTLED     — transaction confirmed on-chain
 *   NOT_SETTLED — transaction rejected or nonce unused
 *   UNRESOLVED  — data unavailable, requires manual audit
 */

import type {
  DurableEvidenceStore,
  PaymentIntent,
  NonceRecord,
  EvidenceRecord,
} from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconciliationResult =
  | { status: "SETTLED"; txHash: string; blockNumber?: number }
  | { status: "NOT_SETTLED"; reason: string }
  | { status: "UNRESOLVED"; reason: string };

export interface OnChainChecker {
  /**
   * Check if a transaction is confirmed on-chain.
   * Returns null if unable to determine (network error, RPC down, etc.)
   */
  checkTransaction(txHash: string): Promise<{
    confirmed: boolean;
    blockNumber?: number;
    status: "success" | "reverted" | "pending";
  } | null>;

  /**
   * Check if a nonce has been used by scanning for AuthorizationUsed events.
   * Returns null if unable to determine.
   */
  checkNonceUsage(
    payer: string,
    nonce: string,
  ): Promise<{
    used: boolean;
    txHash?: string;
    blockNumber?: number;
  } | null>;
}

// ---------------------------------------------------------------------------
// Mock On-Chain Checker (for testing)
// ---------------------------------------------------------------------------

export class MockOnChainChecker implements OnChainChecker {
  private txResults: Map<string, { confirmed: boolean; blockNumber?: number; status: "success" | "reverted" | "pending" }> = new Map();
  private nonceResults: Map<string, { used: boolean; txHash?: string; blockNumber?: number }> = new Map();

  setTxResult(txHash: string, result: { confirmed: boolean; blockNumber?: number; status: "success" | "reverted" | "pending" }): void {
    this.txResults.set(txHash.toLowerCase(), result);
  }

  setNonceResult(nonce: string, result: { used: boolean; txHash?: string; blockNumber?: number }): void {
    this.nonceResults.set(nonce.toLowerCase(), result);
  }

  async checkTransaction(txHash: string) {
    return this.txResults.get(txHash.toLowerCase()) ?? null;
  }

  async checkNonceUsage(_payer: string, nonce: string) {
    return this.nonceResults.get(nonce.toLowerCase()) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Viem-based On-Chain Checker (production)
// ---------------------------------------------------------------------------

export class ViemOnChainChecker implements OnChainChecker {
  private readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async checkTransaction(txHash: string) {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionReceipt",
          params: [txHash],
          id: 1,
        }),
      });

      const data = (await response.json()) as any;
      const receipt = data?.result;

      if (!receipt) return null; // tx not found yet

      const status = receipt.status === "0x1" ? "success" : "reverted";
      return {
        confirmed: status === "success",
        blockNumber: parseInt(receipt.blockNumber, 16),
        status,
      };
    } catch {
      return null; // RPC error → cannot determine
    }
  }

  async checkNonceUsage(payer: string, nonce: string) {
    // In production, this would scan for AuthorizationUsed(payer, nonce) events
    // using eth_getLogs with the appropriate topic filter.
    // For now, we rely on txHash-based checking as primary method.
    // Full event scanning requires knowing the facilitator contract address.
    try {
      // Placeholder: real implementation would use viem getLogs
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// ReconciliationEngine
// ============================================================================

export class ReconciliationEngine {
  private readonly store: DurableEvidenceStore;
  private readonly chainChecker: OnChainChecker;

  constructor(store: DurableEvidenceStore, chainChecker: OnChainChecker) {
    this.store = store;
    this.chainChecker = chainChecker;
  }

  /**
   * Reconcile a payment intent with unknown status.
   *
   * Strategy:
   *   1. If txHash available → check transaction receipt on-chain
   *   2. If no txHash but nonce available → check nonce usage via events
   *   3. If neither available → UNRESOLVED (manual audit needed)
   */
  async reconcile(
    intentId: string,
    operationId: string,
  ): Promise<ReconciliationResult> {
    const intent = await this.store.getPaymentIntentByOperationId(operationId);

    if (!intent) {
      return { status: "UNRESOLVED", reason: "Intent not found in database" };
    }

    // Strategy 1: Check by txHash
    if (intent.txHash) {
      const txResult = await this.chainChecker.checkTransaction(intent.txHash);

      if (txResult === null) {
        // RPC unavailable — cannot determine
        return {
          status: "UNRESOLVED",
          reason: `RPC unavailable for txHash ${intent.txHash}`,
        };
      }

      if (txResult.confirmed) {
        // Transaction confirmed on-chain!
        await this.store.updatePaymentIntentStatus(intentId, "SETTLED", {
          txHash: intent.txHash,
        });

        if (intent.nonce) {
          await this.store.markNonceSettled(intent.nonce);
        }

        await this.appendEvidence(operationId, "RECONCILIATION_SETTLED", {
          txHash: intent.txHash,
          blockNumber: txResult.blockNumber,
        });

        return {
          status: "SETTLED",
          txHash: intent.txHash,
          blockNumber: txResult.blockNumber,
        };
      }

      if (txResult.status === "reverted") {
        await this.store.updatePaymentIntentStatus(intentId, "FAILED");

        await this.appendEvidence(operationId, "RECONCILIATION_REVERTED", {
          txHash: intent.txHash,
        });

        return {
          status: "NOT_SETTLED",
          reason: `Transaction ${intent.txHash} reverted on-chain`,
        };
      }

      // Still pending
      return {
        status: "UNRESOLVED",
        reason: `Transaction ${intent.txHash} still pending`,
      };
    }

    // Strategy 2: Check by nonce
    if (intent.nonce) {
      const nonceResult = await this.chainChecker.checkNonceUsage(
        intent.payer,
        intent.nonce,
      );

      if (nonceResult === null) {
        return {
          status: "UNRESOLVED",
          reason: `Cannot check nonce ${intent.nonce} — RPC unavailable or event scan not implemented`,
        };
      }

      if (nonceResult.used && nonceResult.txHash) {
        // Found the transaction via nonce!
        await this.store.updatePaymentIntentStatus(intentId, "SETTLED", {
          txHash: nonceResult.txHash,
        });

        await this.store.markNonceSettled(intent.nonce);

        await this.appendEvidence(operationId, "RECONCILIATION_SETTLED_VIA_NONCE", {
          nonce: intent.nonce,
          txHash: nonceResult.txHash,
          blockNumber: nonceResult.blockNumber,
        });

        return {
          status: "SETTLED",
          txHash: nonceResult.txHash,
          blockNumber: nonceResult.blockNumber,
        };
      }

      if (!nonceResult.used) {
        // Nonce was never used — payment was not settled
        await this.store.updatePaymentIntentStatus(intentId, "FAILED");

        await this.appendEvidence(operationId, "RECONCILIATION_NONCE_UNUSED", {
          nonce: intent.nonce,
        });

        return {
          status: "NOT_SETTLED",
          reason: `Nonce ${intent.nonce} was never used on-chain`,
        };
      }
    }

    // Strategy 3: No anchors available
    return {
      status: "UNRESOLVED",
      reason: "No txHash or nonce available for reconciliation",
    };
  }

  /**
   * Reconcile all intents with UNKNOWN status.
   * Used for batch recovery after restart.
   */
  async reconcileAllUnknown(): Promise<Map<string, ReconciliationResult>> {
    const results = new Map<string, ReconciliationResult>();

    // Get all operations in SETTLEMENT_UNKNOWN state
    const unknownOps = await this.store.getOperationsByStatus("SETTLEMENT_UNKNOWN" as any);

    for (const op of unknownOps) {
      const result = await this.reconcile(op.operationId, op.operationId);
      results.set(op.operationId, result);
    }

    return results;
  }

  private async appendEvidence(
    operationId: string,
    event: string,
    payload: unknown,
  ): Promise<void> {
    const record: EvidenceRecord = {
      operationId,
      phase: "SETTLEMENT",
      timestamp: Date.now(),
      event,
      payload,
    };
    await this.store.append(record);
  }
}
