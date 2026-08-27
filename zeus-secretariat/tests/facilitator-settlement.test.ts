/**
 * Zeus Secretariat V0 — Phase 2.3 Tests
 *
 * Test AC: Real Submission — successful submit to Mock Facilitator
 * Test AD: Timeout Handling — network timeout → UNKNOWN (not FAILED)
 * Test AE: Reconciliation Success — find tx by nonce after timeout
 * Test AF: No Blind Resubmit — second submit blocked for same intent
 */

import {
  MockX402FacilitatorClient,
  type PaymentPayload,
} from "../src/adapters/x402-facilitator-client";
import { ReconciliationEngine } from "../src/core/reconciliation-engine";
import { MockMultiRpcChecker } from "../src/core/multi-rpc-checker";

// Legacy MockOnChainChecker adapter
class MockOnChainChecker {
  private txResults: Map<string, any> = new Map();
  private nonceResults: Map<string, any> = new Map();
  setTxResult(txHash: string, result: any) { this.txResults.set(txHash.toLowerCase(), result); }
  setNonceResult(nonce: string, result: any) { this.nonceResults.set(nonce.toLowerCase(), result); }
  async checkTransaction(txHash: string) { return this.txResults.get(txHash.toLowerCase()) ?? null; }
  async checkNonceUsage(_payer: string, nonce: string) { return this.nonceResults.get(nonce.toLowerCase()) ?? null; }
}
import type {
  DurablePaymentIntent,
  DurableEvidenceStore,
  EvidenceRecord,
  Operation,
  OperationStatus,
} from "../src/core/types";

// ---------------------------------------------------------------------------
// In-Memory Durable Store (for unit tests without PostgreSQL)
// ---------------------------------------------------------------------------

class InMemoryDurableStore implements DurableEvidenceStore {
  private intents: Map<string, DurablePaymentIntent> = new Map();
  private nonces: Map<string, { nonce: string; operationId: string; status: string; payer: string; createdAt: number; updatedAt: number }> = new Map();
  private evidence: Map<string, EvidenceRecord[]> = new Map();
  private operations: Map<string, Operation> = new Map();

  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }

  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, operation);
  }

  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return this.evidence.get(operationId) ?? [];
  }

  async getOperationsByStatus(status: OperationStatus): Promise<Operation[]> {
    return Array.from(this.operations.values()).filter(
      (op) => op.currentState === status,
    );
  }

  async createPaymentIntent(intent: any): Promise<void> {
    if (this.intents.has(intent.paymentIntentId)) {
      throw new Error("DUPLICATE_INTENT");
    }
    // Check operationId uniqueness
    for (const existing of this.intents.values()) {
      if (existing.operationId === intent.operationId) {
        throw new Error("DUPLICATE_OPERATION_ID");
      }
    }
    this.intents.set(intent.paymentIntentId, { ...intent });
  }

  async getPaymentIntentByOperationId(operationId: string): Promise<any> {
    for (const intent of this.intents.values()) {
      if (intent.operationId === operationId) return { ...intent };
    }
    return null;
  }

  async updatePaymentIntentStatus(
    intentId: string,
    status: any,
    extra?: any,
  ): Promise<void> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("INTENT_NOT_FOUND");
    intent.status = status;
    if (extra?.txHash) intent.txHash = extra.txHash;
    if (extra?.signature) intent.signature = extra.signature;
    if (extra?.facilitatorResponse) intent.facilitatorResponse = extra.facilitatorResponse;
    intent.updatedAt = Date.now();
  }

  async reserveNonce(nonce: string, operationId: string, payer: string): Promise<void> {
    if (this.nonces.has(nonce)) {
      throw new Error("NONCE_ALREADY_RESERVED");
    }
    this.nonces.set(nonce, {
      nonce,
      operationId,
      status: "RESERVED",
      payer,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async getNonce(nonce: string) {
    const n = this.nonces.get(nonce);
    return n ? { ...n, status: n.status as any } : null;
  }

  async markNonceSigned(nonce: string): Promise<void> {
    const n = this.nonces.get(nonce);
    if (n) { n.status = "SIGNED"; n.updatedAt = Date.now(); }
  }

  async markNonceSubmitted(nonce: string): Promise<void> {
    const n = this.nonces.get(nonce);
    if (n) { n.status = "SUBMITTED"; n.updatedAt = Date.now(); }
  }

  async markNonceSettled(nonce: string): Promise<void> {
    const n = this.nonces.get(nonce);
    if (n) { n.status = "SETTLED"; n.updatedAt = Date.now(); }
  }

  async createIntentWithNonce(intent: any, payer: string): Promise<void> {
    if (intent.nonce) {
      await this.reserveNonce(intent.nonce, intent.operationId, payer);
    }
    await this.createPaymentIntent(intent);
  }

  async transitionToSubmitting(id: string): Promise<boolean> {
    return this.compareAndSetState(id, "AUTHORIZED", "SUBMITTING");
  }

  async recordSubmissionResult(id: string, newState: any, txHash?: string, httpStatus?: number, body?: unknown): Promise<boolean> {
    return this.compareAndSetState(id, "SUBMITTING", newState, { txHash: txHash ?? undefined } as any);
  }

  async getPaymentIntentById(id: string): Promise<any> {
    for (const i of this.intents.values()) {
      if ((i as any).paymentIntentId === id) return JSON.parse(JSON.stringify(i));
    }
    return null;
  }

  async getNonTerminalIntents(): Promise<any[]> {
    const nonTerminal = ["SUBMITTING", "SUBMITTED", "SETTLEMENT_PENDING", "RECONCILING"];
    return Array.from(this.intents.values())
      .filter((i: any) => nonTerminal.includes(i.settlementState ?? i.status))
      .map((i: any) => JSON.parse(JSON.stringify(i)));
  }

  async compareAndSetState(id: string, expected: any, next: any, extra?: any): Promise<boolean> {
    const intent = this.intents.get(id);
    if (!intent) return false;
    if ((intent as any).settlementState !== expected && (intent as any).status !== expected) return false;
    if ((intent as any).settlementState !== undefined) (intent as any).settlementState = next;
    else (intent as any).status = next;
    if (extra?.txHash) (intent as any).txHash = extra.txHash;
    return true;
  }

  async canCreateNewPayment(operationId: string): Promise<boolean> {
    for (const i of this.intents.values()) {
      if ((i as any).operationId === operationId) {
        const state = (i as any).settlementState ?? (i as any).status;
        return state === "NOT_SETTLED";
      }
    }
    return true;
  }

  async appendReconciliationObservation(obs: any): Promise<void> {}
  async getReconciliationObservations(id: string): Promise<any[]> { return []; }
  async saveSettledEvidenceBundle(id: string, bundle: any): Promise<void> {
    const i = this.intents.get(id);
    if (i) (i as any).settledEvidenceBundle = bundle;
  }
  async saveNotSettledEvidenceBundle(id: string, bundle: any): Promise<void> {
    const i = this.intents.get(id);
    if (i) (i as any).notSettledEvidenceBundle = bundle;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<DurablePaymentIntent> = {}): DurablePaymentIntent {
  const now = Math.floor(Date.now() / 1000);
  return {
    paymentIntentId: `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    operationId: `op-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    settlementState: "AUTHORIZED",
    authorizer: "0xPayer",
    payTo: "0xPayee",
    value: "1000000",
    asset: "0xUSDC",
    network: "base-sepolia",
    nonce: `0x${Date.now().toString(16)}`,
    validAfter: now - 3600,
    validBefore: now + 3600,
    paymentPayload: "base64payload",
    paymentPayloadHash: "0xhash",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const mockPayload: PaymentPayload = {
  paymentHeader: "base64-encoded-auth",
  resource: "https://api.example.com/service",
  network: "base-sepolia",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 2.3: Real Facilitator Settlement & Reconciliation", () => {
  let store: InMemoryDurableStore;

  beforeEach(() => {
    store = new InMemoryDurableStore();
  });

  // ---- Test AC: Real Submission ----

  test("AC: successful submission returns SUBMITTED with txHash", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      delayMs: 10,
      txHash: "0xabc123",
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    const result = await facilitator.submit(intent, mockPayload);

    expect(result.status).toBe("SUBMITTED");
    if (result.status === "SUBMITTED") {
      expect((result as any).evidence?.authorizationUsed?.transactionHash ?? (result as any).txHash).toBe("0xabc123");
    }

    // Verify DB updated to SETTLEMENT_PENDING
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("SETTLEMENT_PENDING");
    expect((updated as any).txHash).toBe("0xabc123");

    // Verify nonce marked as submitted
    const nonceRecord = await store.getNonce(intent.nonce!);
    expect(nonceRecord!.status).toBe("SUBMITTED");
  });

  // ---- Test AD: Timeout Handling ----

  test("AD: timeout returns UNKNOWN (not FAILED), does not throw", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      delayMs: 10,
      forceTimeout: true,
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    // Must NOT throw
    const result = await facilitator.submit(intent, mockPayload);

    expect(result.status).toBe("UNKNOWN");
    if (result.status === "UNKNOWN") {
      expect(result.error).toContain("NETWORK_ERROR");
    }

    // Verify DB updated to UNKNOWN
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("UNKNOWN");
  });

  // ---- Test AE: Reconciliation Success ----

  test("AE: reconciliation finds settled tx by nonce after timeout", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      forceTimeout: true,
    });

    const intent = makeIntent({ nonce: "0xdeadbeef1234" });
    await store.createPaymentIntent(intent);

    // Step 1: Submit → UNKNOWN (timeout)
    const submitResult = await facilitator.submit(intent, mockPayload);
    expect(submitResult.status).toBe("UNKNOWN");

    // Step 2: Simulate that the tx actually went through on-chain
    const chainChecker = new MockOnChainChecker();
    chainChecker.setNonceResult("0xdeadbeef1234", {
      used: true,
      txHash: "0xfound_via_nonce_0x1234",
      blockNumber: 12345678,
    });

    // Step 3: Reconcile
    const engine = new ReconciliationEngine(store, chainChecker);
    const reconResult = await engine.reconcile(intent.paymentIntentId ?? intent.operationId);

    expect(reconResult.status).toBe("SETTLED");
    if (reconResult.status === "SETTLED") {
      expect((reconResult as any).evidence?.authorizationUsed?.transactionHash ?? (reconResult as any).txHash).toBe("0xfound_via_nonce_0x1234");
      expect((reconResult as any).evidence?.authorizationUsed?.blockNumber ?? (reconResult as any).blockNumber).toBe(12345678);
    }

    // Verify DB updated to SETTLED
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("SETTLED");
    expect((updated as any).txHash).toBe("0xfound_via_nonce_0x1234");

    // Verify nonce marked as settled
    const nonceRecord = await store.getNonce("0xdeadbeef1234");
    expect(nonceRecord!.status).toBe("SETTLED");
  });

  // ---- Test AF: No Blind Resubmit ----

  test("AF: second submit for same intent is blocked", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      delayMs: 10,
      txHash: "0xfirst_tx",
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    // First submit succeeds
    const result1 = await facilitator.submit(intent, mockPayload);
    expect(result1.status).toBe("SUBMITTED");

    // Second submit must be blocked
    const result2 = await facilitator.submit(intent, mockPayload);
    expect(result2.status).toBe("REJECTED");
    if (result2.status === "REJECTED") {
      expect(result2.reason).toContain("ALREADY_SUBMITTED");
    }
  });

  // ---- Test AG: Reconciliation by txHash ----

  test("AG: reconciliation confirms settled tx by txHash", async () => {
    const intent = makeIntent({
      settlementState: "RECONCILING",
      txHash: "0xknown_tx_hash",
    });
    await store.createPaymentIntent(intent);

    const chainChecker = new MockOnChainChecker();
    chainChecker.setTxResult("0xknown_tx_hash", {
      confirmed: true,
      blockNumber: 99999,
      status: "success",
    });

    const engine = new ReconciliationEngine(store, chainChecker);
    const result = await engine.reconcile(intent.paymentIntentId ?? intent.operationId);

    expect(result.status).toBe("SETTLED");
    if (result.status === "SETTLED") {
      expect((result as any).evidence?.authorizationUsed?.transactionHash ?? (result as any).txHash).toBe("0xknown_tx_hash");
    }
  });

  // ---- Test AH: Reconciliation detects reverted tx ----

  test("AH: reconciliation detects reverted transaction", async () => {
    const intent = makeIntent({
      settlementState: "RECONCILING",
      txHash: "0xreverted_tx",
    });
    await store.createPaymentIntent(intent);

    const chainChecker = new MockOnChainChecker();
    chainChecker.setTxResult("0xreverted_tx", {
      confirmed: false,
      status: "reverted",
    });

    const engine = new ReconciliationEngine(store, chainChecker);
    const result = await engine.reconcile(intent.paymentIntentId ?? intent.operationId);

    expect(result.status).toBe("NOT_SETTLED");
    if (result.status === "NOT_SETTLED") {
      expect((result as any).reason ?? (result as any).evidence ? 'see evidence' : 'unknown').toContain("reverted");
    }

    // Verify DB updated to FAILED
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("FAILED");
  });

  // ---- Test AI: Facilitator rejection ----

  test("AI: facilitator HTTP error returns REJECTED", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      forceStatus: 500,
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    const result = await facilitator.submit(intent, mockPayload);

    expect(result.status).toBe("REJECTED");
    if (result.status === "REJECTED") {
      expect((result as any).reason ?? (result as any).evidence ? 'see evidence' : 'unknown').toContain("FACILITATOR_ERROR");
      expect((result as any).reason ?? (result as any).evidence ? 'see evidence' : 'unknown').toContain("500");
    }

    // Verify DB updated to FAILED
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("FAILED");
  });
});
