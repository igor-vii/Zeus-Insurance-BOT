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
import { keccak256, toBytes } from "viem";

// Legacy MockOnChainChecker adapter
// R0 repair: ReconciliationEngine now requires the §6/§14 MultiRpcChecker
// interface (MultiRpcResult observations + agreement). The old ad-hoc checker
// is preserved below ONLY as a data holder; tests use MockMultiRpcChecker.
class MockOnChainChecker {
  private txResults: Map<string, any> = new Map();
  private nonceResults: Map<string, any> = new Map();
  setTxResult(txHash: string, result: any) { this.txResults.set(txHash.toLowerCase(), result); }
  setNonceResult(nonce: string, result: any) { this.nonceResults.set(nonce.toLowerCase(), result); }
  async checkTransaction(txHash: string) { return this.txResults.get(txHash.toLowerCase()) ?? null; }
  async checkNonceUsage(_payer: string, nonce: string) { return this.nonceResults.get(nonce.toLowerCase()) ?? null; }
}

// ---------------------------------------------------------------------------
// R0 repair helpers — canonical EIP-3009 receipt fixtures for the engine's
// §7 Transfer matching + §8 AuthorizationUsed log scan.
// ---------------------------------------------------------------------------
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

function topicFromAddress(address: string): string {
  return "0x" + address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function settledReceiptFixture(intent: DurablePaymentIntent, blockNumber: number) {
  return {
    confirmed: true,
    status: "success" as const,
    blockNumber,
    confirmations: 12, // DEFAULT_FINALITY_POLICY.requiredConfirmations
    logs: [
      {
        address: intent.asset,
        topics: [AUTHORIZATION_USED_TOPIC, topicFromAddress(intent.authorizer), topicFromAddress(intent.nonce)],
        data: "0x",
        logIndex: 0,
      },
      {
        address: intent.asset,
        topics: [TRANSFER_TOPIC, topicFromAddress(intent.authorizer), topicFromAddress(intent.payTo)],
        data: "0x" + BigInt(intent.value).toString(16),
        logIndex: 1,
      },
    ],
  };
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
    // R0 repair: DurablePaymentIntent's canonical field is `settlementState`
    // (mirrors PostgresEvidenceStore). The fake previously wrote `intent.status`,
    // so every state transition silently vanished and downstream reads saw the
    // stale AUTHORIZED state.
    intent.settlementState = status;
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
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "base-sepolia",
    amount: "1000000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xSellerAddress",
    maxTimeoutSeconds: 300,
  },
  payload: {
    signature: "0xmock-signature",
    authorization: {
      from: "0xPayerAddress",
      to: "0xSellerAddress",
      value: "1000000",
      validAfter: "0",
      validBefore: "1700000000",
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
    },
  },
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
    // R0 repair: in production the nonce row exists BEFORE submit (Stage A
    // reserves it atomically with the intent). Reserve it the same way so the
    // SUBMITTED transition is exercised against a real lifecycle.
    await store.createIntentWithNonce(intent, intent.authorizer);

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

    // R0 repair: per the frozen reconciliation spec (RECONCILIATION_PROTOCOL_SPEC_V0.1.md
    // §timeout table + types.ts §2 "UNKNOWN is internal-only"), a network timeout
    // persists RECONCILING — never FAILED and never the internal-only UNKNOWN label.
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("RECONCILING");
  });

  // ---- Test AE: Reconciliation Success ----

  test("AE: reconciliation finds settled tx by nonce after timeout", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      forceTimeout: true,
    });

    // R0 repair: §7 Transfer matching compares 40-hex addresses, so the intent
    // uses real-shaped addresses and the mock receipt carries canonical
    // AuthorizationUsed + Transfer logs.
    const intent = makeIntent({
      nonce: "0xdeadbeef1234",
      authorizer: "0x1111111111111111111111111111111111111111",
      payTo: "0x2222222222222222222222222222222222222222",
      asset: "0x3333333333333333333333333333333333333333",
    });
    await store.createIntentWithNonce(intent, intent.authorizer);

    // Step 1: Submit → UNKNOWN (timeout), DB persists RECONCILING (spec §timeout)
    const submitResult = await facilitator.submit(intent, mockPayload);
    expect(submitResult.status).toBe("UNKNOWN");

    // Step 2: Simulate that the tx actually went through on-chain
    const chainChecker = new MockMultiRpcChecker();
    chainChecker.setAuthResult("0xdeadbeef1234", true);
    chainChecker.setAuthorizationUsedEvent("0xdeadbeef1234", {
      transactionHash: "0xfound_via_nonce_0x1234",
      blockNumber: 12345678,
      logIndex: 0,
    });
    chainChecker.setTxResult(
      "0xfound_via_nonce_0x1234",
      settledReceiptFixture(intent, 12345678) as any,
    );

    // Step 3: Reconcile — spec §10: true → recover tx via logs → success+Transfer → SETTLED
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
    // R0 repair: real-shaped addresses so §7-8 log matching applies.
    const intent = makeIntent({
      settlementState: "RECONCILING",
      txHash: "0xknown_tx_hash",
      authorizer: "0x1111111111111111111111111111111111111111",
      payTo: "0x2222222222222222222222222222222222222222",
      asset: "0x3333333333333333333333333333333333333333",
    });
    await store.createPaymentIntent(intent);

    const chainChecker = new MockMultiRpcChecker();
    chainChecker.setTxResult("0xknown_tx_hash", settledReceiptFixture(intent, 99999) as any);

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

    const chainChecker = new MockMultiRpcChecker();
    chainChecker.setTxResult("0xreverted_tx", {
      confirmed: false,
      status: "reverted",
    } as any);

    const engine = new ReconciliationEngine(store, chainChecker);
    const result = await engine.reconcile(intent.paymentIntentId ?? intent.operationId);

    expect(result.status).toBe("NOT_SETTLED");
    if (result.status === "NOT_SETTLED") {
      // R0 repair: the original assertion wrapped the value in a ternary
      // ((reason ?? evidence) ? 'see evidence' : 'unknown') which could never
      // contain the substring. Assert the reason directly (spec §9).
      expect((result as any).reason).toContain("reverted");
    }

    // R0 repair: per types.ts §2 "FAILED is NOT a valid settlement state" and
    // spec §9, a reverted transaction is terminal NOT_SETTLED.
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("NOT_SETTLED");
  });

  // ---- Test AI: Facilitator rejection ----

  // F-112/H-6: status classification now mirrors the REAL client — a 5xx is
  // transient/infrastructural ambiguity (UNKNOWN → RECONCILING), while a 4xx
  // is the facilitator's definitive refusal (REJECTED). The old test asserted
  // REJECTED for 500 — that was the mock contradicting the real adapter.
  test("AI: facilitator HTTP 500 returns UNKNOWN (transient), durable RECONCILING", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      forceStatus: 500,
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    const result = await facilitator.submit(intent, mockPayload);

    expect(result.status).toBe("UNKNOWN");
    if (result.status === "UNKNOWN") {
      expect((result as any).error).toContain("FACILITATOR_AMBIGUOUS");
      expect((result as any).error).toContain("500");
    }

    // R0 repair: per spec §timeout table "HTTP 500 → RECONCILING (blockchain
    // has priority)" — the DB must NOT be FAILED.
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("RECONCILING");
  });

  // F-112/H-6: definitive 4xx refusal — the caller sees REJECTED, the durable
  // state still routes through the reconciler (§5: blockchain has priority).
  test("AI-2: facilitator HTTP 400 returns REJECTED (definitive), durable RECONCILING", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      forceStatus: 400,
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    const result = await facilitator.submit(intent, mockPayload);

    expect(result.status).toBe("REJECTED");
    if (result.status === "REJECTED") {
      expect((result as any).reason).toContain("FACILITATOR_ERROR");
      expect((result as any).reason).toContain("400");
    }

    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("RECONCILING");
  });

  // F-112/H-6: 409 authorization_used is REPLAYISH — the authorization may
  // have settled on-chain earlier, so the caller must see UNKNOWN (the
  // reconciler's truth-scan decides), never a flat REJECTED.
  test("AI-3: facilitator HTTP 409 returns UNKNOWN (replay ambiguity)", async () => {
    const facilitator = new MockX402FacilitatorClient(store, {
      forceStatus: 409,
    });

    const intent = makeIntent();
    await store.createPaymentIntent(intent);

    const result = await facilitator.submit(intent, mockPayload);

    expect(result.status).toBe("UNKNOWN");
    const updated = await store.getPaymentIntentByOperationId(intent.operationId);
    expect(updated!.settlementState).toBe("RECONCILING");
  });
});
