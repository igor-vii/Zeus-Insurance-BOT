/**
 * Zeus Secretariat V0 — Phase 2.3: Real x402 Facilitator Settlement
 *
 * Implements the SettlementAdapter interface for real x402 facilitator interaction.
 * Handles submit, timeout detection, and UNKNOWN status propagation.
 *
 * Critical invariant: NEVER throw on network errors — return UNKNOWN status instead.
 * This allows the ReconciliationEngine to resolve the truth later.
 */
import { allowNewPayment } from "../core/types.js";
/**
 * Encode canonical PaymentPayload as base64 PAYMENT-SIGNATURE for HTTP transport.
 *
 * Flow: PaymentPayload → deterministic JSON → UTF-8 bytes → Base64
 *
 * Still exported for clients that must speak the legacy v1 header flow
 * (PAYMENT-SIGNATURE style) — the /settle wire itself no longer base64-wraps
 * the payload (see FacilitatorSettleRequest below).
 */
export function encodePaymentSignature(payload) {
    const json = JSON.stringify(payload);
    const utf8Bytes = new TextEncoder().encode(json);
    // Convert Uint8Array to binary string for btoa
    let binary = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
        binary += String.fromCharCode(utf8Bytes[i]);
    }
    return btoa(binary);
}
/**
 * Build the canonical x402 v2 /settle request DTO from canonical PaymentPayload.
 * This is the ONLY place where the facilitator wire envelope is constructed.
 */
export function buildFacilitatorRequest(payload) {
    return {
        x402Version: payload.x402Version,
        paymentPayload: payload,
        paymentRequirements: {
            scheme: payload.accepted.scheme,
            network: payload.accepted.network,
            asset: payload.accepted.asset,
            amount: payload.accepted.amount,
            payTo: payload.accepted.payTo,
            maxTimeoutSeconds: payload.accepted.maxTimeoutSeconds,
            ...(payload.resource ? { resource: payload.resource } : {}),
            ...(payload.accepted.extra ? { extra: payload.accepted.extra } : {}),
        },
    };
}
// ---------------------------------------------------------------------------
// X402FacilitatorClient
// ---------------------------------------------------------------------------
export class X402FacilitatorClient {
    config;
    store;
    /** Track submitted intents to prevent double-submit (INV: one submit per intent) */
    submittedIntents = new Set();
    constructor(config, store) {
        this.config = {
            baseUrl: config.baseUrl.replace(/\/$/, ""),
            apiKey: config.apiKey ?? "",
            timeoutMs: config.timeoutMs ?? 30_000,
            maxRetries: config.maxRetries ?? 0,
        };
        this.store = store;
    }
    /**
     * Record the durable SUBMITTING → RECONCILING transition on any
     * non-definitive facilitator outcome. CAS-guarded ONLY: if the CAS loses,
     * another writer (reconciler/Stage B) already owns the state and a blind
     * overwrite would break fencing — so we do NOTHING durably (F-112/H-7).
     */
    async reconcileAmbiguous(paymentIntentId, extra) {
        await this.store.compareAndSetState(paymentIntentId, "SUBMITTING", "RECONCILING", extra).catch(() => {
            // CAS lost — the durable state was moved by a concurrent writer that
            // is now the single owner. Never overwrite it unconditionally.
        });
    }
    /**
     * Submit a signed payment to the x402 facilitator.
     *
     * Invariants enforced:
     *   - One submit per intentId (no blind resubmit even on timeout)
     *   - Network errors → UNKNOWN (never throw)
     *   - 200 + body.success === false → REJECTED (protocol-level refusal)
     *   - 4xx (except 408/409/429) → REJECTED — the facilitator definitively
     *     refused the payload; reconciling cannot change the answer.
     *   - 409/408/429/5xx → UNKNOWN → RECONCILING (ambiguity: 409 means the
     *     authorization may already be used on-chain — only the reconciler's
     *     truth-scan may decide).
     *   - 200 + success → SUBMITTED with txHash (post-settle bookkeeping
     *     failures NEVER blur the result into NETWORK_ERROR — money may
     *     already have moved, F-112/H-8).
     */
    async submit(intent, payload) {
        // P0-1 + P1-3: DB-level guard — NOT in-memory Set.
        // The in-memory Set is ONLY an optimization cache, never a safety boundary.
        const dbIntent = await this.store.getPaymentIntentByOperationId(intent.operationId);
        if (!dbIntent) {
            return { status: "REJECTED", reason: "INTENT_NOT_FOUND in DB", rawResponse: null };
        }
        // §3: Economic safety — check persisted state
        if (!allowNewPayment(dbIntent.settlementState) && dbIntent.settlementState !== "AUTHORIZED") {
            // Already past AUTHORIZED — cannot re-submit
            if (["PENDING_SIGNATURE", "SUBMITTING", "SUBMITTED", "SETTLEMENT_PENDING", "RECONCILING", "SETTLED", "UNRESOLVED_MANUAL"].includes(dbIntent.settlementState)) {
                return {
                    status: "REJECTED",
                    reason: `DB_STATE_GUARD: persisted state is ${dbIntent.settlementState}, cannot re-submit`,
                    rawResponse: null,
                };
            }
        }
        // P0-1: Atomically mark SUBMITTING BEFORE network call
        const marked = await this.store.transitionToSubmitting(intent.paymentIntentId);
        if (!marked) {
            return {
                status: "REJECTED",
                reason: "CAS_FAILED: could not transition to SUBMITTING — state already changed",
                rawResponse: null,
            };
        }
        // Optimization cache only (P1-3: NOT a safety boundary)
        this.submittedIntents.add(intent.paymentIntentId);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
        let response;
        try {
            response = await fetch(`${this.config.baseUrl}/settle`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                body: JSON.stringify(buildFacilitatorRequest(payload)),
                signal: controller.signal,
            });
        }
        catch (err) {
            // F-112 hygiene: release the timer on the network-error path too.
            clearTimeout(timeoutId);
            // P0-1: Timeout/network error → RECONCILING via DB
            const errorMsg = err instanceof Error ? err.message : "Unknown network error";
            await this.reconcileAmbiguous(intent.paymentIntentId, {
                errorReason: `NETWORK_ERROR: ${errorMsg}`,
            });
            return { status: "UNKNOWN", error: `NETWORK_ERROR: ${errorMsg}` };
        }
        clearTimeout(timeoutId);
        const responseBody = await response.json().catch(() => ({}));
        const body = responseBody;
        // -----------------------------------------------------------------
        // 2xx — the HTTP layer succeeded; the PROTOCOL verdict lives in the body.
        // F-112/H-5: the x402 settle contract answers {success: boolean,
        // transaction, errorReason} — a 200 with success:false is a definitive
        // refusal (e.g. insufficient_funds), NOT a settlement.
        // -----------------------------------------------------------------
        if (response.ok) {
            if (body.success === false) {
                const reason = body.errorReason ?? body.error ?? body.message ?? "FACILITATOR_SETTLE_FAILED";
                await this.reconcileAmbiguous(intent.paymentIntentId, {
                    facilitatorHttpStatus: response.status,
                    facilitatorResponseBody: responseBody,
                    errorReason: `FACILITATOR_REJECTED: ${reason}`,
                });
                return { status: "REJECTED", reason, rawResponse: responseBody };
            }
            // Spec field is `transaction` (v2); keep legacy aliases for Zeus mocks.
            const txHash = body.transaction ?? body.transactionHash ?? body.txHash ?? body.transaction_hash ?? "";
            // P0-1: Transition SUBMITTING → SETTLEMENT_PENDING atomically.
            // F-112/H-8: this is POST-SETTLEMENT bookkeeping. If it fails, money
            // may ALREADY have moved — the outcome must stay SUBMITTED (with a
            // best-effort durable SETTLEMENT_PENDING CAS), never blurred into a
            // NETWORK_ERROR/RECONCILING state that implies "we do not know if the
            // money moved".
            try {
                await this.store.recordSubmissionResult(intent.paymentIntentId, "SETTLEMENT_PENDING", txHash || undefined, response.status, responseBody);
                if (intent.nonce) {
                    await this.store.markNonceSubmitted(intent.nonce);
                }
            }
            catch (bookkeepingErr) {
                const bookMsg = bookkeepingErr instanceof Error ? bookkeepingErr.message : "unknown bookkeeping error";
                await this.store.compareAndSetState(intent.paymentIntentId, "SUBMITTING", "SETTLEMENT_PENDING", { txHash: txHash || undefined, errorReason: `SETTLE_OK_BOOKKEEPING_FAILED: ${bookMsg}` }).catch(() => { });
            }
            return { status: "SUBMITTED", txHash, rawResponse: responseBody };
        }
        // -----------------------------------------------------------------
        // Non-2xx — classify definitive refusal vs genuine ambiguity.
        // F-112/H-6: a 4xx is the facilitator's FINAL answer about THIS payload
        // (invalid signature, expired, malformed) — the caller must see REJECTED.
        // 409 (authorization_used) is the exception: the authorization may have
        // settled on-chain earlier — only the reconciler may resolve it.
        // 408/429/5xx are transient/infrastructural → UNKNOWN → RECONCILING.
        // §5: in EVERY non-2xx branch the durable state still goes to
        // RECONCILING (CAS-guarded) — the reconciler remains the truth owner.
        // -----------------------------------------------------------------
        const reason = body.errorReason ?? body.error ?? body.message ?? `HTTP ${response.status}`;
        const replayish = response.status === 409 ||
            /authorization[_ ]?used|already[_ ]?used|duplicate[_ ]?settlement/i.test(reason);
        const definitiveRefusal = response.status >= 400 && response.status < 500 &&
            response.status !== 408 && response.status !== 429 && !replayish;
        await this.reconcileAmbiguous(intent.paymentIntentId, {
            facilitatorHttpStatus: response.status,
            facilitatorResponseBody: responseBody,
            errorReason: definitiveRefusal
                ? `FACILITATOR_REJECTED: ${reason}`
                : `FACILITATOR_AMBIGUOUS: HTTP ${response.status} — ${reason}`,
        });
        if (definitiveRefusal) {
            return { status: "REJECTED", reason, rawResponse: responseBody };
        }
        return { status: "UNKNOWN", error: `FACILITATOR_AMBIGUOUS: HTTP ${response.status} — ${reason}` };
    }
    /**
     * Check if an intent has already been submitted (for external callers).
     */
    hasBeenSubmitted(intentId) {
        return this.submittedIntents.has(intentId);
    }
    /**
     * Reset submission tracking (for testing only).
     */
    resetSubmissionTracking() {
        this.submittedIntents.clear();
    }
}
export class MockX402FacilitatorClient {
    store;
    behavior;
    submittedIntents = new Set();
    constructor(store, behavior = {}) {
        this.store = store;
        this.behavior = behavior;
    }
    setBehavior(behavior) {
        this.behavior = behavior;
    }
    async submit(intent, _payload) {
        if (this.submittedIntents.has(intent.paymentIntentId)) {
            return {
                status: "REJECTED",
                reason: "ALREADY_SUBMITTED",
                rawResponse: null,
            };
        }
        this.submittedIntents.add(intent.paymentIntentId);
        // Simulate network delay
        if (this.behavior.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, this.behavior.delayMs));
        }
        // Simulate timeout
        if (this.behavior.forceTimeout) {
            await this.store
                .updatePaymentIntentStatus(intent.paymentIntentId, "RECONCILING")
                .catch(() => { });
            return {
                status: "UNKNOWN",
                error: "NETWORK_ERROR: simulated timeout",
            };
        }
        // Simulate HTTP error — F-112/H-6: the mock MUST mirror the real
        // client's status classification so unit tests stop lying about prod
        // behavior: 4xx (except 408/409/429) is a definitive REJECTED; 409 and
        // 5xx are ambiguous → UNKNOWN (durable RECONCILING, reconciler owns it).
        if (this.behavior.forceStatus && this.behavior.forceStatus >= 400) {
            const s = this.behavior.forceStatus;
            const replayish = s === 409;
            const definitive = s < 500 && s !== 408 && s !== 429 && !replayish;
            await this.store.updatePaymentIntentStatus(intent.paymentIntentId, "RECONCILING");
            return definitive
                ? {
                    status: "REJECTED",
                    reason: `FACILITATOR_ERROR: HTTP ${s}`,
                    rawResponse: { error: "simulated error" },
                }
                : {
                    status: "UNKNOWN",
                    error: `FACILITATOR_AMBIGUOUS: HTTP ${s} — simulated error`,
                };
        }
        // Success
        const txHash = this.behavior.txHash ?? `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
        await this.store.updatePaymentIntentStatus(intent.paymentIntentId, "SETTLEMENT_PENDING", { txHash });
        if (intent.nonce) {
            await this.store.markNonceSubmitted(intent.nonce);
        }
        return {
            status: "SUBMITTED",
            txHash,
            rawResponse: { transactionHash: txHash, success: true },
        };
    }
    hasBeenSubmitted(intentId) {
        return this.submittedIntents.has(intentId);
    }
    resetSubmissionTracking() {
        this.submittedIntents.clear();
    }
}
//# sourceMappingURL=x402-facilitator-client.js.map