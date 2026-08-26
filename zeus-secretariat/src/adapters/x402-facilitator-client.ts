/**
 * Zeus Secretariat V0 — Phase 2.3: Real x402 Facilitator Settlement
 *
 * Implements the SettlementAdapter interface for real x402 facilitator interaction.
 * Handles submit, timeout detection, and UNKNOWN status propagation.
 *
 * Critical invariant: NEVER throw on network errors — return UNKNOWN status instead.
 * This allows the ReconciliationEngine to resolve the truth later.
 */

import type {
  PaymentIntent,
  SettlementState,
  DurableEvidenceStore,
} from "../core/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface PaymentPayload {
  /** x402 payment header value (base64-encoded authorization) */
  readonly paymentHeader: string;
  /** Target resource URL */
  readonly resource: string;
  /** Network identifier (e.g., "base-sepolia", "base") */
  readonly network: string;
}

export type SubmitResult =
  | { status: "SUBMITTED"; txHash: string; rawResponse: unknown }
  | { status: "REJECTED"; reason: string; rawResponse: unknown }
  | { status: "UNKNOWN"; error: string };

export interface SettlementAdapter {
  submit(intent: DurablePaymentIntent, payload: PaymentPayload): Promise<SubmitResult>;
}

// ---------------------------------------------------------------------------
// X402FacilitatorClient
// ---------------------------------------------------------------------------

export class X402FacilitatorClient implements SettlementAdapter {
  private readonly config: Required<FacilitatorConfig>;
  private readonly store: DurableEvidenceStore;

  /** Track submitted intents to prevent double-submit (INV: one submit per intent) */
  private readonly submittedIntents: Set<string> = new Set();

  constructor(config: FacilitatorConfig, store: DurableEvidenceStore) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      apiKey: config.apiKey ?? "",
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 0,
    };
    this.store = store;
  }

  /**
   * Submit a signed payment to the x402 facilitator.
   *
   * Invariants enforced:
   *   - One submit per intentId (no blind resubmit even on timeout)
   *   - Network errors → UNKNOWN (never throw)
   *   - 4xx/5xx → REJECTED with reason
   *   - 200 → SUBMITTED with txHash
   */
  async submit(
    intent: DurablePaymentIntent,
    payload: PaymentPayload,
  ): Promise<SubmitResult> {
    // P0-1 + P1-3: DB-level guard — NOT in-memory Set.
    // The in-memory Set is ONLY an optimization cache, never a safety boundary.
    const dbIntent = await this.store.getPaymentIntentByOperationId(intent.operationId);

    if (!dbIntent) {
      return { status: "REJECTED", reason: "INTENT_NOT_FOUND in DB", rawResponse: null };
    }

    // §3: Economic safety — check persisted state
    if (!allowNewPayment(dbIntent.settlementState) && dbIntent.settlementState !== "AUTHORIZED") {
      // Already past AUTHORIZED — cannot re-submit
      if (["SUBMITTING", "SUBMITTED", "SETTLEMENT_PENDING", "RECONCILING", "SETTLED", "UNRESOLVED_MANUAL"].includes(dbIntent.settlementState)) {
        return {
          status: "REJECTED",
          reason: `DB_STATE_GUARD: persisted state is ${dbIntent.settlementState}, cannot re-submit`,
          rawResponse: null,
        };
      }
    }

    // P0-1: Atomically mark SUBMITTING BEFORE network call
    const storeWithSubmitting = this.store as any;
    if (typeof storeWithSubmitting.atomicallyMarkSubmitting === "function") {
      const marked = await storeWithSubmitting.atomicallyMarkSubmitting(intent.paymentIntentId);
      if (!marked) {
        // State was not AUTHORIZED — another worker already moved it
        return {
          status: "REJECTED",
          reason: "CAS_FAILED: could not transition to SUBMITTING — state already changed",
          rawResponse: null,
        };
      }
    }

    // Optimization cache only (P1-3: NOT a safety boundary)
    this.submittedIntents.add(intent.intentId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(`${this.config.baseUrl}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          paymentHeader: payload.paymentHeader,
          resource: payload.resource,
          network: payload.network,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseBody = await response.json().catch(() => ({}));

      if (response.ok) {
        const txHash =
          (responseBody as any)?.transactionHash ??
          (responseBody as any)?.txHash ??
          (responseBody as any)?.transaction_hash ??
          "";

        // P0-1: Transition SUBMITTING → SETTLEMENT_PENDING atomically
        if (typeof storeWithSubmitting.markSubmittedWithTxHash === "function") {
          await storeWithSubmitting.markSubmittedWithTxHash(
            intent.paymentIntentId, txHash, response.status, responseBody,
          );
        } else {
          await this.store.updateSettlementState(intent.paymentIntentId, "SETTLEMENT_PENDING", {
            txHash: txHash || undefined,
            facilitatorHttpStatus: response.status,
            facilitatorResponseBody: responseBody,
          });
        }

        if (intent.nonce) {
          await this.store.markNonceSubmitted(intent.nonce);
        }

        return { status: "SUBMITTED", txHash, rawResponse: responseBody };
      }

      // §5 + P1-1: Facilitator error → RECONCILING (not FAILED)
      const reason = (responseBody as any)?.error ?? (responseBody as any)?.message ?? `HTTP ${response.status}`;

      if (typeof storeWithSubmitting.markReconcilingAfterSubmitError === "function") {
        await storeWithSubmitting.markReconcilingAfterSubmitError(intent.paymentIntentId, response.status, reason);
      } else {
        await this.store.updateSettlementState(intent.paymentIntentId, "RECONCILING", {
          facilitatorHttpStatus: response.status,
          errorReason: reason,
        });
      }

      return { status: "UNKNOWN", error: `FACILITATOR_AMBIGUOUS: HTTP ${response.status} — ${reason}` };
    } catch (err: unknown) {
      // P0-1: Timeout/network error → RECONCILING via DB
      const errorMsg = err instanceof Error ? err.message : "Unknown network error";

      const storeWithRecon = this.store as any;
      if (typeof storeWithRecon.markReconcilingAfterSubmitError === "function") {
        await storeWithRecon.markReconcilingAfterSubmitError(intent.paymentIntentId, null, `NETWORK_ERROR: ${errorMsg}`).catch(() => {});
      } else {
        await this.store.updateSettlementState(intent.paymentIntentId, "RECONCILING", {
          errorReason: `NETWORK_ERROR: ${errorMsg}`,
        }).catch(() => {});
      }

      return { status: "UNKNOWN", error: `NETWORK_ERROR: ${errorMsg}` };
    }
  }
  /**
   * Check if an intent has already been submitted (for external callers).
   */
  hasBeenSubmitted(intentId: string): boolean {
    return this.submittedIntents.has(intentId);
  }

  /**
   * Reset submission tracking (for testing only).
   */
  resetSubmissionTracking(): void {
    this.submittedIntents.clear();
  }
}

// ---------------------------------------------------------------------------
// Mock Facilitator (for testing — simulates real API behavior)
// ---------------------------------------------------------------------------

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

export class MockX402FacilitatorClient implements SettlementAdapter {
  private readonly store: DurableEvidenceStore;
  private behavior: MockFacilitatorBehavior;
  private readonly submittedIntents: Set<string> = new Set();

  constructor(store: DurableEvidenceStore, behavior: MockFacilitatorBehavior = {}) {
    this.store = store;
    this.behavior = behavior;
  }

  setBehavior(behavior: MockFacilitatorBehavior): void {
    this.behavior = behavior;
  }

  async submit(
    intent: DurablePaymentIntent,
    _payload: PaymentPayload,
  ): Promise<SubmitResult> {
    if (this.submittedIntents.has(intent.intentId)) {
      return {
        status: "REJECTED",
        reason: "ALREADY_SUBMITTED",
        rawResponse: null,
      };
    }

    this.submittedIntents.add(intent.intentId);

    // Simulate network delay
    if (this.behavior.delayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.behavior.delayMs),
      );
    }

    // Simulate timeout
    if (this.behavior.forceTimeout) {
      await this.store
        .updateSettlementState(intent.intentId, "UNKNOWN")
        .catch(() => {});
      return {
        status: "UNKNOWN",
        error: "NETWORK_ERROR: simulated timeout",
      };
    }

    // Simulate HTTP error
    if (this.behavior.forceStatus && this.behavior.forceStatus >= 400) {
      await this.store.updateSettlementState(intent.intentId, "RECONCILING");
      return {
        status: "REJECTED",
        reason: `FACILITATOR_ERROR: HTTP ${this.behavior.forceStatus}`,
        rawResponse: { error: "simulated error" },
      };
    }

    // Success
    const txHash =
      this.behavior.txHash ?? `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

    await this.store.updateSettlementState(
      intent.intentId,
      "SETTLEMENT_PENDING",
      { txHash },
    );

    if (intent.nonce) {
      await this.store.markNonceSubmitted(intent.nonce);
    }

    return {
      status: "SUBMITTED",
      txHash,
      rawResponse: { transactionHash: txHash, success: true },
    };
  }

  hasBeenSubmitted(intentId: string): boolean {
    return this.submittedIntents.has(intentId);
  }

  resetSubmissionTracking(): void {
    this.submittedIntents.clear();
  }
}
