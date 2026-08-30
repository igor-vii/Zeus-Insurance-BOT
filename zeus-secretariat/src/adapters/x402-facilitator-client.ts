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
  DurablePaymentIntent,
  SettlementState,
  DurableEvidenceStore,
} from "../core/types";
import { allowNewPayment } from "../core/types";

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
 * Facilitator-specific request envelope.
 * This is a boundary DTO — NOT an internal payment model.
 * Constructed from canonical PaymentPayload at the adapter edge only.
 */
interface FacilitatorSettleRequest {
  readonly paymentHeader: string;
  readonly resource: string;
  readonly network: string;
}

/**
 * Encode canonical PaymentPayload as base64 PAYMENT-SIGNATURE for HTTP transport.
 *
 * Flow: PaymentPayload → deterministic JSON → UTF-8 bytes → Base64
 */
export function encodePaymentSignature(payload: PaymentPayload): string {
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
 * Build facilitator-specific request DTO from canonical PaymentPayload.
 * This is the ONLY place where V1-shaped wire format is constructed.
 */
function buildFacilitatorRequest(payload: PaymentPayload): FacilitatorSettleRequest {
  const paymentHeader = encodePaymentSignature(payload);
  return {
    paymentHeader,
    resource: payload.resource?.url ?? "",
    network: payload.accepted.network,
  };
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

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(`${this.config.baseUrl}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(buildFacilitatorRequest(payload)),
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
        await this.store.recordSubmissionResult(
          intent.paymentIntentId, "SETTLEMENT_PENDING",
          txHash || undefined, response.status, responseBody,
        );

        if (intent.nonce) {
          await this.store.markNonceSubmitted(intent.nonce);
        }

        return { status: "SUBMITTED", txHash, rawResponse: responseBody };
      }

      // §5 + P1-1: Facilitator error → RECONCILING (not FAILED)
      const reason = (responseBody as any)?.error ?? (responseBody as any)?.message ?? `HTTP ${response.status}`;

      await this.store.compareAndSetState(
        intent.paymentIntentId, "SUBMITTING", "RECONCILING",
        { facilitatorHttpStatus: response.status, errorReason: reason } as Partial<DurablePaymentIntent>,
      ).catch(() => this.store.updatePaymentIntentStatus(intent.paymentIntentId, "RECONCILING", {
        facilitatorHttpStatus: response.status, errorReason: reason,
      }));

      return { status: "UNKNOWN", error: `FACILITATOR_AMBIGUOUS: HTTP ${response.status} — ${reason}` };
    } catch (err: unknown) {
      // P0-1: Timeout/network error → RECONCILING via DB
      const errorMsg = err instanceof Error ? err.message : "Unknown network error";

      await this.store.compareAndSetState(
        intent.paymentIntentId, "SUBMITTING", "RECONCILING",
        { errorReason: `NETWORK_ERROR: ${errorMsg}` } as Partial<DurablePaymentIntent>,
      ).catch(() => this.store.updatePaymentIntentStatus(intent.paymentIntentId, "RECONCILING", {
        errorReason: `NETWORK_ERROR: ${errorMsg}`,
      })).catch(() => {});

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
      await new Promise((resolve) =>
        setTimeout(resolve, this.behavior.delayMs),
      );
    }

    // Simulate timeout
    if (this.behavior.forceTimeout) {
      await this.store
        .updatePaymentIntentStatus(intent.paymentIntentId, "RECONCILING")
        .catch(() => {});
      return {
        status: "UNKNOWN",
        error: "NETWORK_ERROR: simulated timeout",
      };
    }

    // Simulate HTTP error
    if (this.behavior.forceStatus && this.behavior.forceStatus >= 400) {
      await this.store.updatePaymentIntentStatus(intent.paymentIntentId, "RECONCILING");
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
      intent.paymentIntentId,
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
