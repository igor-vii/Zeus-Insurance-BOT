/**
 * Zeus Secretariat V0 - In-Memory Evidence Store (MVP Implementation)
 *
 * For production, replace with PostgreSQL/SQLite implementation.
 * This is a minimal implementation for testing and development.
 */
export class InMemoryEvidenceStore {
    operations = new Map();
    evidence = new Map();
    // -----------------------------------------------------------------------
    // R0 repair: durable payment-intent + nonce layer. The state-machine's
    // canonical V2 path requires createPaymentIntent/getPaymentIntentByOperationId/
    // updatePaymentIntentStatus/nonce methods on its store. Without them the
    // in-memory store — the package's own dev/test implementation — could not
    // drive the canonical flow at all ("B.1 persistence required" crash).
    // -----------------------------------------------------------------------
    intents = new Map(); // key: paymentIntentId
    nonces = new Map();
    findIntentByOperationId(operationId) {
        for (const rec of this.intents.values()) {
            if (rec.intent.operationId === operationId)
                return rec;
        }
        return null;
    }
    async createPaymentIntent(intent) {
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
    async getPaymentIntentByOperationId(operationId) {
        const rec = this.findIntentByOperationId(operationId);
        return rec ? { ...rec.intent, payer: rec.intent.authorizer } : null;
    }
    async getPaymentIntentByRequestId(requestId) {
        for (const rec of this.intents.values()) {
            if (rec.intent.requestId === requestId)
                return { ...rec.intent, payer: rec.intent.authorizer };
        }
        return null;
    }
    /** R0 repair: required by ReconciliationEngine.getIntentById(). */
    async getPaymentIntentById(paymentIntentId) {
        const rec = this.intents.get(paymentIntentId);
        return rec ? { ...rec.intent, payer: rec.intent.authorizer } : null;
    }
    async updatePaymentIntentAuthorization(paymentIntentId, fields) {
        const rec = this.intents.get(paymentIntentId);
        if (!rec)
            throw new Error("INTENT_NOT_FOUND");
        rec.intent = { ...rec.intent, paymentPayload: fields.paymentPayload, paymentPayloadHash: fields.paymentPayloadHash, updatedAt: Date.now() };
    }
    async updatePaymentIntentStatus(paymentIntentId, status, extra) {
        const rec = this.intents.get(paymentIntentId);
        if (!rec)
            throw new Error("INTENT_NOT_FOUND");
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
    // F-108/F-109 (external audit 2026-10-26): CAS-guarded atomic authorization —
    // same contract as PostgresEvidenceStore.authorizePaymentIntent(). JS is
    // single-threaded, but the check-then-act shape is kept honest anyway: the
    // state test and the payload binding are decided against the CURRENT record,
    // never the caller's stale snapshot.
    async authorizePaymentIntent(paymentIntentId, fields, expectedState = "PENDING_SIGNATURE") {
        const rec = this.intents.get(paymentIntentId);
        if (!rec)
            throw new Error("INTENT_NOT_FOUND: " + paymentIntentId);
        const conflict = () => new Error(`PAYMENT_INTENT_AUTHORIZATION_CONFLICT: intent is ${rec.intent.settlementState} with a different payload`);
        // Terminal monotonicity mirrors compareAndSetState/PostgresEvidenceStore.
        if (["SETTLED", "NOT_SETTLED", "UNRESOLVED_MANUAL"].includes(rec.intent.settlementState)) {
            if (rec.intent.paymentPayloadHash === fields.paymentPayloadHash)
                return false;
            throw conflict();
        }
        if (rec.intent.settlementState === expectedState) {
            rec.intent = {
                ...rec.intent,
                paymentPayload: fields.paymentPayload,
                paymentPayloadHash: fields.paymentPayloadHash,
                settlementState: "AUTHORIZED",
                updatedAt: Date.now(),
            };
            return true;
        }
        if (rec.intent.paymentPayloadHash === fields.paymentPayloadHash)
            return false;
        throw conflict();
    }
    async compareAndSetState(paymentIntentId, expectedState, newState) {
        const rec = this.intents.get(paymentIntentId);
        if (!rec)
            return false;
        // §19/§21 terminal monotonicity mirrors PostgresEvidenceStore.
        if (["SETTLED", "NOT_SETTLED", "UNRESOLVED_MANUAL"].includes(rec.intent.settlementState))
            return false;
        if (rec.intent.settlementState !== expectedState)
            return false;
        rec.intent = { ...rec.intent, settlementState: newState, updatedAt: Date.now() };
        return true;
    }
    async reserveNonce(nonce, operationId, payer) {
        if (this.nonces.has(nonce))
            throw new Error("NONCE_ALREADY_RESERVED: " + nonce);
        this.nonces.set(nonce, { operationId, status: "RESERVED", payer, createdAt: Date.now(), updatedAt: Date.now() });
    }
    async getNonce(nonce) {
        const n = this.nonces.get(nonce);
        return n ? { nonce, operationId: n.operationId, status: n.status, payer: n.payer, createdAt: n.createdAt, updatedAt: n.updatedAt } : null;
    }
    async markNonceSigned(nonce) {
        const n = this.nonces.get(nonce);
        if (n) {
            n.status = "SIGNED";
            n.updatedAt = Date.now();
        }
    }
    async markNonceSubmitted(nonce) {
        const n = this.nonces.get(nonce);
        if (n) {
            n.status = "SUBMITTED";
            n.updatedAt = Date.now();
        }
    }
    async markNonceSettled(nonce) {
        const n = this.nonces.get(nonce);
        if (n) {
            n.status = "SETTLED";
            n.updatedAt = Date.now();
        }
    }
    async createIntentWithNonce(intent, payer) {
        // F-101 (external audit 2026-10-25): mirror the PostgresEvidenceStore's
        // transactional semantics — nonce reservation and intent creation are ONE
        // atomic step. If intent creation fails, the just-created reservation is
        // rolled back so no orphan nonce diverges from the intent table.
        if (intent.nonce && this.nonces.has(intent.nonce)) {
            throw new Error("NONCE_ALREADY_RESERVED: " + intent.nonce);
        }
        if (!intent.nonce) {
            await this.createPaymentIntent(intent);
            return;
        }
        await this.reserveNonce(intent.nonce, intent.operationId, payer);
        try {
            await this.createPaymentIntent(intent);
        }
        catch (err) {
            const rec = this.nonces.get(intent.nonce);
            if (rec && rec.operationId === intent.operationId && rec.status === "RESERVED") {
                this.nonces.delete(intent.nonce);
            }
            throw err;
        }
    }
    async saveSettledEvidenceBundle(paymentIntentId, bundle) {
        const rec = this.intents.get(paymentIntentId);
        if (rec)
            rec.settledEvidenceBundle = bundle;
    }
    async saveNotSettledEvidenceBundle(paymentIntentId, bundle) {
        const rec = this.intents.get(paymentIntentId);
        if (rec)
            rec.notSettledEvidenceBundle = bundle;
    }
    getSettledBundle(paymentIntentId) {
        return this.intents.get(paymentIntentId)?.settledEvidenceBundle;
    }
    // R0 repair: reconciliation observation log required by ReconciliationEngine.
    reconObservations = new Map(); // key: paymentIntentId
    async appendReconciliationObservation(obs) {
        const key = obs.paymentIntentId ?? obs.attemptId;
        const list = this.reconObservations.get(key) ?? [];
        list.push(obs);
        this.reconObservations.set(key, list);
        // Mirror into the owning intent's jsonb field, mirroring PostgresEvidenceStore.
        const rec = obs.paymentIntentId ? this.intents.get(obs.paymentIntentId) : null;
        if (rec) {
            const arr = rec.intent.reconciliationObservations ?? [];
            arr.push(obs);
            rec.intent.reconciliationObservations = arr;
        }
    }
    async getReconciliationObservations(paymentIntentId) {
        return [...(this.reconObservations.get(paymentIntentId) ?? [])];
    }
    // R0 repair: durable reconciliation job registry (observeSettlement
    // RECONCILING branch creates a probe job via createReconciliationJob).
    reconJobs = new Map();
    async createReconciliationJob(paymentIntentId, nextProbeAt) {
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
    async getSettledIntentsWithoutObligation(limit = 100) {
        const out = [];
        for (const rec of this.intents.values()) {
            if (rec.intent.settlementState === 'SETTLED') {
                out.push({ ...rec.intent, payer: rec.intent.authorizer });
                if (out.length >= limit)
                    break;
            }
        }
        return out;
    }
    async append(record) {
        const records = this.evidence.get(record.operationId) ?? [];
        records.push(record);
        this.evidence.set(record.operationId, records);
    }
    async getOperation(operationId) {
        return this.operations.get(operationId) ?? null;
    }
    async getOperationByRequestId(requestId) {
        for (const operation of this.operations.values()) {
            if (operation.requestId === requestId)
                return operation;
        }
        return null;
    }
    async saveOperation(operation) {
        this.operations.set(operation.operationId, operation);
    }
    async getEvidence(operationId) {
        return this.evidence.get(operationId) ?? [];
    }
    async getOperationsByStatus(status) {
        const result = [];
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
    clear() {
        this.operations.clear();
        this.evidence.clear();
    }
    /**
     * Get all operations - useful for debugging
     */
    getAllOperations() {
        return Array.from(this.operations.values());
    }
}
//# sourceMappingURL=in-memory-store.js.map