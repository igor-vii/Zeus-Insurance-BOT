/**
 * Zeus Secretariat V0 — Phase 2.3: Real x402 Facilitator Settlement
 *
 * Implements the SettlementAdapter interface for real x402 facilitator interaction.
 * Handles submit, timeout detection, and UNKNOWN status propagation.
 *
 * Critical invariant: NEVER throw on network errors — return UNKNOWN status instead.
 * This allows the ReconciliationEngine to resolve the truth later.
 */
import type { DurablePaymentIntent, DurableEvidenceStore } from "../core/types.js";
export interface FacilitatorConfig {
    /** Base URL of the x402 facilitator (e.g., https://x402.coinbase.com) */
    readonly baseUrl: string;
    /** API key or bearer token for authentication */
    readonly apiKey?: string;
    /** Request timeout in milliseconds (default: 30000) */
    readonly timeoutMs?: number;
    /** Maximum retry attempts for transient errors (default: 0 — no blind retries) */
    readonly maxRetries?: number;
}
/**
 * Canonical x402 V2 PaymentPayload.
 *
 * This is the single internal representation of a signed payment payload
 * within Zeus Secretariat. All payment flows use this structure.
 *
 * Facilitator-specific wire formats are constructed at the adapter boundary,
 * not stored as alternative internal models.
 */
export interface PaymentPayload {
    readonly x402Version: 2;
    readonly resource?: {
        url: string;
        description?: string;
        mimeType?: string;
    };
    readonly accepted: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        maxTimeoutSeconds: number;
        extra?: {
            assetTransferMethod?: string;
            name?: string;
            version?: string;
            [key: string]: unknown;
        };
    };
    readonly payload: {
        signature: string;
        authorization: {
            from: string;
            to: string;
            value: string;
            validAfter: string;
            validBefore: string;
            nonce: string;
        };
    };
    readonly extensions?: Record<string, unknown>;
}
/**
 * Encode canonical PaymentPayload as base64 PAYMENT-SIGNATURE for HTTP transport.
 *
 * Flow: PaymentPayload → deterministic JSON → UTF-8 bytes → Base64
 *
 * Still exported for clients that must speak the legacy v1 header flow
 * (PAYMENT-SIGNATURE style) — the /settle wire itself no longer base64-wraps
 * the payload (see FacilitatorSettleRequest below).
 */
export declare function encodePaymentSignature(payload: PaymentPayload): string;
/**
 * F-112/C-1 (external audit 2026-10-26, Major): canonical x402 v2 /settle wire
 * format. The previous envelope `{paymentHeader, resource, network}` was a
 * private V1-shaped contract: it carried NO paymentRequirements (the
 * facilitator could not know payTo/asset/amount without decoding the header)
 * and no protocol version, so ANY spec-conformant facilitator (Coinbase CDP
 * v2, Radius, or a Zeus facilitator built on the x402 reference stack)
 * answers 400 and every real settle would have landed in RECONCILING.
 *
 * The canonical v2 remote-facilitator contract (docs.cdp.coinbase.com v2
 * x402 facilitator; docs.radiustech.xyz facilitator API; docs.x402.org) is:
 *   POST /settle { x402Version, paymentPayload, paymentRequirements }
 * where paymentPayload is the decoded canonical PaymentPayload and
 * paymentRequirements is derived from `accepted` + resource.
 */
export interface FacilitatorSettleRequest {
    readonly x402Version: number;
    readonly paymentPayload: PaymentPayload;
    readonly paymentRequirements: {
        readonly scheme: string;
        readonly network: string;
        readonly asset: string;
        readonly amount: string;
        readonly payTo: string;
        readonly maxTimeoutSeconds: number;
        readonly resource?: {
            url: string;
            description?: string;
            mimeType?: string;
        };
        readonly extra?: Record<string, unknown>;
    };
}
/**
 * Build the canonical x402 v2 /settle request DTO from canonical PaymentPayload.
 * This is the ONLY place where the facilitator wire envelope is constructed.
 */
export declare function buildFacilitatorRequest(payload: PaymentPayload): FacilitatorSettleRequest;
export type SubmitResult = {
    status: "SUBMITTED";
    txHash: string;
    rawResponse: unknown;
} | {
    status: "REJECTED";
    reason: string;
    rawResponse: unknown;
} | {
    status: "UNKNOWN";
    error: string;
};
export interface SettlementAdapter {
    submit(intent: DurablePaymentIntent, payload: PaymentPayload): Promise<SubmitResult>;
}
export declare class X402FacilitatorClient implements SettlementAdapter {
    private readonly config;
    private readonly store;
    /** Track submitted intents to prevent double-submit (INV: one submit per intent) */
    private readonly submittedIntents;
    constructor(config: FacilitatorConfig, store: DurableEvidenceStore);
    /**
     * Record the durable SUBMITTING → RECONCILING transition on any
     * non-definitive facilitator outcome. CAS-guarded ONLY: if the CAS loses,
     * another writer (reconciler/Stage B) already owns the state and a blind
     * overwrite would break fencing — so we do NOTHING durably (F-112/H-7).
     */
    private reconcileAmbiguous;
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
    submit(intent: DurablePaymentIntent, payload: PaymentPayload): Promise<SubmitResult>;
    /**
     * Check if an intent has already been submitted (for external callers).
     */
    hasBeenSubmitted(intentId: string): boolean;
    /**
     * Reset submission tracking (for testing only).
     */
    resetSubmissionTracking(): void;
}
export interface MockFacilitatorBehavior {
    /** Delay before responding (ms) */
    delayMs?: number;
    /** Force timeout (abort after delayMs) */
    forceTimeout?: boolean;
    /** Force specific HTTP status */
    forceStatus?: number;
    /** Custom txHash to return */
    txHash?: string;
}
export declare class MockX402FacilitatorClient implements SettlementAdapter {
    private readonly store;
    private behavior;
    private readonly submittedIntents;
    constructor(store: DurableEvidenceStore, behavior?: MockFacilitatorBehavior);
    setBehavior(behavior: MockFacilitatorBehavior): void;
    submit(intent: DurablePaymentIntent, _payload: PaymentPayload): Promise<SubmitResult>;
    hasBeenSubmitted(intentId: string): boolean;
    resetSubmissionTracking(): void;
}
//# sourceMappingURL=x402-facilitator-client.d.ts.map