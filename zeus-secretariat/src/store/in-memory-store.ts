/**
 * Zeus Secretariat V0 - In-Memory Evidence Store (MVP Implementation)
 * 
 * For production, replace with PostgreSQL/SQLite implementation.
 * This is a minimal implementation for testing and development.
 */

import {
  EvidenceStore,
  EvidenceRecord,
  Operation,
  OperationStatus,
  DurablePaymentIntent,
  SettlementState,
  NonceRecord,
} from '../core/types.js';

/** Durable-intent record shape used by the in-memory durable layer (R0 repair). */
interface InMemoryIntentRecord {
  intent: DurablePaymentIntent;
  settledEvidenceBundle?: unknown;
  notSettledEvidenceBundle?: unknown;
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly operations: Map<string, Operation> = new Map();
  private readonly evidence: Map<string, EvidenceRecord[]> = new Map();

  // -----------------------------------------------------------------------
  // R0 repair: durable payment-intent + nonce layer. The state-machine's
  // canonical V2 path requires createPaymentIntent/getPaymentIntentByOperationId/
  // updatePaymentIntentStatus/nonce methods on its store. Without them the
  // in-memory store — the package's own dev/test implementation — could not
  // drive the canonical flow at all ("B.1 persistence required" crash).
  // -----------------------------------------------------------------------
  private readonly intents = new Map<string, InMemoryIntentRecord>(); // key: paymentIntentId
  private readonly nonces = new Map<string, { operationId: string; status: string; payer: string; createdAt: number; updatedAt: number }>();

  private findIntentByOperationId(operationId: string): InMemoryIntentRecord | null {
    for (const rec of this.intents.values()) {
      if (rec.intent.operationId === operationId) return rec;
    }
    return null;
  }

  async createPaymentIntent(intent: DurablePaymentIntent): Promise<void> {
    if (this.intents.has(intent.paymentIntentId)) {
      throw new Error("DUPLICATE_OPERATION_ID: " + intent.operationId);
    }
    for (const rec of this.intents.values()) {
      if (rec.intent.operationId === intent.operationId) {
        throw new Error("DUPLICATE_OPERATION_ID: " + intent.operationId);
      }
    }
    this.intents.set(intent.paymentIntentId, { intent: { ...intent } });
  }

  async getPaymentIntentByOperationId(operationId: string): Promise<DurablePaymentIntent | null> {
    const rec = this.findIntentByOperationId(operationId);
    return rec ? { ...rec.intent, payer: rec.intent.authorizer } : null;
  }

  async getPaymentIntentByRequestId(requestId: string): Promise<DurablePaymentIntent | null> {
    for (const rec of this.intents.values()) {
      if (rec.intent.requestId === requestId) return { ...rec.intent, payer: rec.intent.authorizer };
    }
    return null;
  }

  /** R0 repair: required by ReconciliationEngine.getIntentById(). */
  async getPaymentIntentById(paymentIntentId: string): Promise<DurablePaymentIntent | null> {
    const rec = this.intents.get(paymentIntentId);
    return rec ? { ...rec.intent, payer: rec.intent.authorizer } : null;
  }

  async updatePaymentIntentAuthorization(
    paymentIntentId: string,
    fields: Pick<DurablePaymentIntent, "paymentPayload" | "paymentPayloadHash">,
  ): Promise<void> {
    const rec = this.intents.get(paymentIntentId);
    if (!rec) throw new Error("INTENT_NOT_FOUND");
    rec.intent = { ...rec.intent, paymentPayload: fields.paymentPayload, paymentPayloadHash: fields.paymentPayloadHash, updatedAt: Date.now() };
  }

  async updatePaymentIntentStatus(
    paymentIntentId: string,
    status: SettlementState,
    extra?: Partial<Pick<DurablePaymentIntent, "txHash" | "facilitatorHttpStatus" | "facilitatorResponseBody" | "errorReason">>,
  ): Promise<void> {
    const rec = this.intents.get(paymentIntentId);
    if (!rec) throw new Error("INTENT_NOT_FOUND");
    rec.intent = {
      ...rec.intent,
      settlementState: status,
      txHash: extra?.txHash ?? rec.intent.txHash,
      facilitatorHttpStatus: extra?.facilitatorHttpStatus ?? rec.intent.facilitatorHttpStatus,
      facilitatorResponseBody: extra?.facilitatorResponseBody ?? rec.intent.facilitatorResponseBody,
      errorReason: extra?.errorReason ?? rec.intent.errorReason,
      updatedAt: Date.now(),
    };
  }

  async compareAndSetState(
    paymentIntentId: string,
    expectedState: SettlementState,
    newState: SettlementState,
  ): Promise<boolean> {
    const rec = this.intents.get(paymentIntentId);
    if (!rec) return false;
    // §19/§21 terminal monotonicity mirrors PostgresEvidenceStore.
    if (["SETTLED", "NOT_SETTLED", "UNRESOLVED_MANUAL"].includes(rec.intent.settlementState)) return false;
    if (rec.intent.settlementState !== expectedState) return false;
    rec.intent = { ...rec.intent, settlementState: newState, updatedAt: Date.now() };
    return true;
  }

  async reserveNonce(nonce: string, operationId: string, payer: string): Promise<void> {
    if (this.nonces.has(nonce)) throw new Error("NONCE_ALREADY_RESERVED: " + nonce);
    this.nonces.set(nonce, { operationId, status: "RESERVED", payer, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async getNonce(nonce: string): Promise<NonceRecord | null> {
    const n = this.nonces.get(nonce);
    return n ? { nonce, operationId: n.operationId, status: n.status as NonceRecord["status"], payer: n.payer, createdAt: n.createdAt, updatedAt: n.updatedAt } : null;
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

  async createIntentWithNonce(intent: DurablePaymentIntent, payer: string): Promise<void> {
    if (intent.nonce) await this.reserveNonce(intent.nonce, intent.operationId, payer);
    try {
      await this.createPaymentIntent(intent);
    } catch (err) {
      throw err;
    }
  }

  async saveSettledEvidenceBundle(paymentIntentId: string, bundle: unknown): Promise<void> {
    const rec = this.intents.get(paymentIntentId);
    if (rec) rec.settledEvidenceBundle = bundle;
  }

  async saveNotSettledEvidenceBundle(paymentIntentId: string, bundle: unknown): Promise<void> {
    const rec = this.intents.get(paymentIntentId);
    if (rec) rec.notSettledEvidenceBundle = bundle;
  }

  getSettledBundle(paymentIntentId: string): unknown {
    return this.intents.get(paymentIntentId)?.settledEvidenceBundle;
  }

  // R0 repair: reconciliation observation log required by ReconciliationEngine.
  private readonly reconObservations = new Map<string, any[]>(); // key: paymentIntentId

  async appendReconciliationObservation(obs: any): Promise<void> {
    const key = obs.paymentIntentId ?? obs.attemptId;
    const list = this.reconObservations.get(key) ?? [];
    list.push(obs);
    this.reconObservations.set(key, list);
    // Mirror into the owning intent's jsonb field, mirroring PostgresEvidenceStore.
    const rec = obs.paymentIntentId ? this.intents.get(obs.paymentIntentId) : null;
    if (rec) {
      const arr = (rec.intent.reconciliationObservations as unknown[]) ?? [];
      arr.push(obs);
      (rec.intent as any).reconciliationObservations = arr;
    }
  }

  async getReconciliationObservations(paymentIntentId: string): Promise<any[]> {
    return [...(this.reconObservations.get(paymentIntentId) ?? [])];
  }

  // R0 repair: durable reconciliation job registry (observeSettlement
  // RECONCILING branch creates a probe job via createReconciliationJob).
  private readonly reconJobs = new Map<string, any>();

  async createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string> {
    const jobId = `rj-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Idempotent: one active job per intent (mirrors the 0007 unique index).
    for (const job of this.reconJobs.values()) {
      if (job.paymentIntentId === paymentIntentId && ['PENDING', 'RUNNING'].includes(job.status)) {
        return job.jobId;
      }
    }
    this.reconJobs.set(jobId, { jobId, paymentIntentId, status: 'PENDING', nextProbeAt, createdAt: Date.now() });
    return jobId;
  }

  /** R0 repair: scanner for PostSettlementEngine.ensureExecutionObligations().
   *  Returns SETTLED intents; the engine filters out ones that already have
   *  execution attempts (the in-memory store cannot see the execution store). */
  async getSettledIntentsWithoutObligation(limit = 100): Promise<DurablePaymentIntent[]> {
    const out: DurablePaymentIntent[] = [];
    for (const rec of this.intents.values()) {
      if (rec.intent.settlementState === 'SETTLED') {
        out.push({ ...rec.intent, payer: rec.intent.authorizer });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }

  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async getOperationByRequestId(requestId: string): Promise<Operation | null> {
    for (const operation of this.operations.values()) {
      if (operation.requestId === requestId) return operation;
    }
    return null;
  }

  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, operation);
  }

  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return this.evidence.get(operationId) ?? [];
  }

  async getOperationsByStatus(status: OperationStatus): Promise<Operation[]> {
    const result: Operation[] = [];
    for (const operation of this.operations.values()) {
      if (operation.currentState === status) {
        result.push(operation);
      }
    }
    return result;
  }

  /**
   * Clear all data - useful for testing
   */
  clear(): void {
    this.operations.clear();
    this.evidence.clear();
  }

  /**
   * Get all operations - useful for debugging
   */
  getAllOperations(): Operation[] {
    return Array.from(this.operations.values());
  }
}
