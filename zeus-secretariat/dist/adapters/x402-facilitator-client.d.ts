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
 */
export declare function encodePaymentSignature(payload: PaymentPayload): string;
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
     * Submit a signed payment to the x402 facilitator.
     *
     * Invariants enforced:
     *   - One submit per intentId (no blind resubmit even on timeout)
     *   - Network errors → UNKNOWN (never throw)
     *   - 4xx/5xx → REJECTED with reason
     *   - 200 → SUBMITTED with txHash
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