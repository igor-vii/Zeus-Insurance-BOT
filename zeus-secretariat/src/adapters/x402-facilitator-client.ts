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
  PaymentIntentStatus,
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
  submit(intent: PaymentIntent, payload: PaymentPayload): Promise<SubmitResult>;
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
    intent: PaymentIntent,
    payload: PaymentPayload,
  ): Promise<SubmitResult> {
    // INV: No blind resubmit — check both in-memory and DB
    if (this.submittedIntents.has(intent.intentId)) {
      return {
        status: "REJECTED",
        reason: "ALREADY_SUBMITTED: intent already submitted to facilitator",
        rawResponse: null,
      };
    }

    // Check DB for existing submission (survives restart)
    const existing = await this.store.getPaymentIntentByOperationId(
      intent.operationId,
    );
    if (
      existing &&
      (existing.status === "SUBMITTED" ||
        existing.status === "SETTLEMENT_PENDING" ||
        existing.status === "SETTLED")
    ) {
      this.submittedIntents.add(intent.intentId);
      return {
        status: "REJECTED",
        reason: `ALREADY_SUBMITTED: intent status is ${existing.status}`,
        rawResponse: null,
      };
    }

    // Mark as submitted BEFORE the network call (optimistic lock)
    this.submittedIntents.add(intent.intentId);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(`${this.config.baseUrl}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
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

        // Update DB: mark as SETTLEMENT_PENDING
        await this.store.updatePaymentIntentStatus(
          intent.intentId,
          "SETTLEMENT_PENDING",
          {
            txHash: txHash || undefined,
            facilitatorResponse: responseBody,
          },
        );

        // Mark nonce as submitted
        if (intent.nonce) {
          await this.store.markNonceSubmitted(intent.nonce);
        }

        return {
          status: "SUBMITTED",
          txHash,
          rawResponse: responseBody,
        };
      }

      // 4xx/5xx — rejected by facilitator
      const reason =
        (responseBody as any)?.error ??
        (responseBody as any)?.message ??
        `HTTP ${response.status}`;

      await this.store.updatePaymentIntentStatus(intent.intentId, "FAILED", {
        facilitatorResponse: responseBody,
      });

      return {
        status: "REJECTED",
        reason: `FACILITATOR_ERROR: ${reason}`,
        rawResponse: responseBody,
      };
    } catch (err: unknown) {
      // Timeout or network error → UNKNOWN (critical: do NOT throw)
      const errorMsg =
        err instanceof Error ? err.message : "Unknown network error";

      // Update DB: mark as UNKNOWN for reconciliation
      await this.store
        .updatePaymentIntentStatus(intent.intentId, "UNKNOWN")
        .catch(() => {
          // If DB update also fails, we still return UNKNOWN
          // The reconciliation engine will find it by nonce later
        });

      return {
        status: "UNKNOWN",
        error: `NETWORK_ERROR: ${errorMsg}`,
      };
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
    intent: PaymentIntent,
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
        .updatePaymentIntentStatus(intent.intentId, "UNKNOWN")
        .catch(() => {});
      return {
        status: "UNKNOWN",
        error: "NETWORK_ERROR: simulated timeout",
      };
    }

    // Simulate HTTP error
    if (this.behavior.forceStatus && this.behavior.forceStatus >= 400) {
      await this.store.updatePaymentIntentStatus(intent.intentId, "FAILED");
      return {
        status: "REJECTED",
        reason: `FACILITATOR_ERROR: HTTP ${this.behavior.forceStatus}`,
        rawResponse: { error: "simulated error" },
      };
    }

    // Success
    const txHash =
      this.behavior.txHash ?? `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

    await this.store.updatePaymentIntentStatus(
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
