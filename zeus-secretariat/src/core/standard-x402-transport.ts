/**
 * R9-A1 — Standard x402 v2 client transport (third-party sellers).
 *
 * Decision memo: docs/payment-protocol-a1-decision.md (Option B, implemented
 * as a transport adapter — the "прослойка"). Audit origin: secretariat-audit.md
 * finding A1 — the Secretariat was a pay-then-prove client that could only buy
 * from Zeus-approved sellers, because a standard x402 seller insists on
 * receiving the PAYMENT-SIGNATURE itself and letting ITS OWN facilitator
 * verify + settle before the route executes.
 *
 * What this module does (canonical x402 v2 client flow):
 *   1. Sends the REAL request with the signed PaymentPayload in the
 *      `PAYMENT-SIGNATURE` header (base64 JSON, canonical v2 shape — the same
 *      encoding the Zeus flow already uses for facilitator wires).
 *   2. The seller's middleware verifies + settles via ITS facilitator and
 *      executes the route; the SAME response carries `PAYMENT-RESPONSE`
 *      (base64 JSON: {success, transaction, errorReason?}) and the route body.
 *   3. Classifies honestly:
 *        2xx + valid receipt(success=true, transaction) → SUBMITTED(txHash)
 *        2xx without/invalid receipt                    → UNKNOWN (reconciler owns)
 *        402 (middleware re-challenge / verify refused)  → REJECTED (nothing settled)
 *        408/409/429/5xx/network/timeout                → UNKNOWN (reconciler owns)
 *        other 4xx                                      → REJECTED (definitive refusal)
 *
 * Money-safety invariants (mirrors X402FacilitatorClient discipline):
 *   - NEVER throws on network errors — returns UNKNOWN so the
 *     ReconciliationEngine stays the single truth owner.
 *   - One submit per intent: durable CAS (transitionToSubmitting) BEFORE the
 *     network call; ambiguous outcomes land in durable RECONCILING.
 *   - The seller's claimed tx is NOT trusted: it is persisted as the intent's
 *     txHash and verified by the normal reconciliation machinery
 *     (multi-RPC receipt consensus + AuthorizationUsed nonce-scan fallback).
 *   - The seller's response body (the paid result) is durably captured in the
 *     intent's facilitatorResponseBody under the STANDARD_PAID_CALL marker so
 *     a crash right after the paid call cannot lose the result — the
 *     SettlementFeedbackService completes the operation from this marker.
 *
 * Claim boundary (full text: docs/standard-x402-transport.md):
 *   - EVM "exact" scheme only; networks whose USDC EIP-712 domain is pinned
 *     (D1: eip155:196 "USD Coin"/"2"; base-sepolia test coverage).
 *   - A 200 WITHOUT a settlement receipt is treated as UNKNOWN, never as
 *     delivery — we do not accept unpaywalled results.
 *   - Settlement truth comes ONLY from on-chain reconciliation.
 */

import type {
  DurablePaymentIntent,
  DurableEvidenceStore,
} from "./types.js";
import type { PaymentPayload, SubmitResult } from "../adapters/x402-facilitator-client.js";
import { encodePaymentSignature } from "../adapters/x402-facilitator-client.js";
import { egressFetch } from "./egress-guard.js";

// ---------------------------------------------------------------------------
// Marker contract (durably persisted in intent.facilitatorResponseBody)
// ---------------------------------------------------------------------------

/** Marker `kind` value — the scanner and feedback service key on this. */
export const STANDARD_PAID_CALL_MARKER = "STANDARD_PAID_CALL" as const;

/**
 * Durable record of the atomic paid call. Persisted as
 * intent.facilitatorResponseBody (the seller's middleware acted as the
 * verifying facilitator — the field is semantically exact).
 */
export interface StandardPaidCallRecord {
  readonly kind: typeof STANDARD_PAID_CALL_MARKER;
  readonly sellerHttpStatus: number;
  /** Parsed PAYMENT-RESPONSE receipt when present and well-formed. */
  readonly paymentResponse: StandardPaymentReceipt | null;
  /** The route result body (the paid "document"), when a body was received. */
  readonly sellerBody: unknown;
  readonly capturedAt: number;
  readonly note?: string;
}

export function isStandardPaidCallRecord(value: unknown): value is StandardPaidCallRecord {
  return (
    typeof value === "object" && value !== null &&
    (value as { kind?: unknown }).kind === STANDARD_PAID_CALL_MARKER
  );
}

// ---------------------------------------------------------------------------
// PAYMENT-RESPONSE receipt parsing (strict — same family as the facilitator
// client's canonical settle-body discipline: anything not explicitly
// confirming settlement is NOT a settlement)
// ---------------------------------------------------------------------------

export interface StandardPaymentReceipt {
  readonly success: true;
  readonly transaction: string;
  readonly errorReason?: string;
}

function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Strictly parse the PAYMENT-RESPONSE header. Returns null for anything that
 * is not an explicit success receipt with a well-formed transaction hash —
 * ambiguity is owned by the reconciler, never by optimistic parsing.
 */
export function parsePaymentResponseHeader(header: string | null): StandardPaymentReceipt | null {
  if (!header) return null;
  try {
    const json = base64ToUtf8(header);
    const parsed = JSON.parse(json) as { success?: unknown; transaction?: unknown; errorReason?: unknown };
    if (parsed.success !== true) return null;
    if (typeof parsed.transaction !== "string" || !TX_RE.test(parsed.transaction)) return null;
    return {
      success: true,
      transaction: parsed.transaction,
      ...(typeof parsed.errorReason === "string" ? { errorReason: parsed.errorReason } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface StandardTransportConfig {
  /** Paid-call timeout in milliseconds (default: 30000). */
  readonly timeoutMs?: number;
}

/** Target of the paid call — the EXACT discovered request (F-19 discipline). */
export interface StandardTransportTarget {
  readonly url: string;
  readonly method: string;
  /** Pre-serialized JSON body for body-bearing methods (undefined for GET/HEAD). */
  readonly body?: string;
}

export class StandardX402Transport {
  private readonly config: Required<StandardTransportConfig>;
  private readonly store: DurableEvidenceStore;

  constructor(config: StandardTransportConfig, store: DurableEvidenceStore) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 30_000,
    };
    this.store = store;
  }

  /**
   * Durable CAS bookkeeping on any non-definitive outcome — mirrors
   * X402FacilitatorClient.reconcileAmbiguous (F-112/H-7): CAS-guarded ONLY;
   * a lost CAS means a concurrent writer owns the state and we do nothing.
   */
  private async reconcileAmbiguous(
    paymentIntentId: string,
    extra: Partial<Pick<DurablePaymentIntent, "facilitatorHttpStatus" | "facilitatorResponseBody" | "errorReason" | "txHash">>,
  ): Promise<void> {
    await this.store.compareAndSetState(
      paymentIntentId, "SUBMITTING", "RECONCILING",
      extra as Partial<DurablePaymentIntent>,
    ).catch(() => {
      // CAS lost — a concurrent writer owns the durable state. Never overwrite.
    });
  }

  /**
   * Execute the atomic paid call against a standard x402 v2 seller.
   *
   * Invariants:
   *   - durable SUBMITTING CAS before the network call (one submit per intent)
   *   - network errors → UNKNOWN (never throw)
   *   - 2xx + strict receipt → SUBMITTED with the seller's tx claim persisted
   *     (verified later by reconciliation — never trusted inline)
   *   - the seller body is durably captured under the STANDARD_PAID_CALL marker
   */
  async submit(
    intent: DurablePaymentIntent,
    payload: PaymentPayload,
    target: StandardTransportTarget,
  ): Promise<SubmitResult> {
    // P0-1: durable CAS — SUBMITTING before any network exposure.
    const marked = await this.store.transitionToSubmitting(intent.paymentIntentId);
    if (!marked) {
      return {
        status: "REJECTED",
        reason: "CAS_FAILED: could not transition to SUBMITTING — state already changed",
        rawResponse: null,
      };
    }

    const isBodyless = ["GET", "HEAD"].includes(target.method.toUpperCase());
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await egressFetch(target.url, {
        method: target.method,
        headers: {
          "Content-Type": "application/json",
          // Canonical x402 v2 client payment header (base64 canonical JSON —
          // same encoding as the Zeus facilitator wire).
          "PAYMENT-SIGNATURE": encodePaymentSignature(payload),
          // INV-11: stable idempotency key — mirrors the Zeus seller leg.
          "Idempotency-Key": intent.operationId,
        },
        body: isBodyless ? undefined : (target.body ?? undefined),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      // Nothing settled BEFORE the request reached the wire can be assumed;
      // a lost/aborted request MAY still have landed — reconciler owns truth.
      const errorMsg = err instanceof Error ? err.message : "Unknown network error";
      await this.reconcileAmbiguous(intent.paymentIntentId, {
        errorReason: `STANDARD_TRANSPORT_NETWORK_ERROR: ${errorMsg}`,
      });
      return { status: "UNKNOWN", error: `NETWORK_ERROR: ${errorMsg}` };
    }
    clearTimeout(timeoutId);

    // Read the body EXACTLY ONCE (R7-B1 discipline) with the signal armed.
    let sellerBody: unknown = null;
    let bodyParseError: string | undefined;
    try {
      const text = await response.text();
      if (text.length > 0) {
        try {
          sellerBody = JSON.parse(text);
        } catch {
          sellerBody = text; // non-JSON body — still the seller's answer
        }
      }
    } catch (err: unknown) {
      bodyParseError = err instanceof Error ? err.message : "body read failed";
    }

    const receipt = parsePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE"));
    const record: StandardPaidCallRecord = {
      kind: STANDARD_PAID_CALL_MARKER,
      sellerHttpStatus: response.status,
      paymentResponse: receipt,
      sellerBody,
      capturedAt: Date.now(),
      ...(bodyParseError ? { note: bodyParseError } : {}),
    };

    // -----------------------------------------------------------------
    // 2xx — the protocol verdict lives in PAYMENT-RESPONSE, not in HTTP.
    // -----------------------------------------------------------------
    if (response.ok) {
      if (!receipt) {
        // A 200 without an explicit settlement receipt is CONTRADICTORY (the
        // reference middleware settles before the route). Fail closed:
        // reconciler owns the outcome via the nonce-scan; the body is
        // retained for forensics but is NOT delivered as a result.
        await this.reconcileAmbiguous(intent.paymentIntentId, {
          facilitatorHttpStatus: response.status,
          facilitatorResponseBody: record,
          errorReason: "STANDARD_TRANSPORT_AMBIGUOUS: 2xx without a canonical PAYMENT-RESPONSE receipt",
        });
        return {
          status: "UNKNOWN",
          error: "STANDARD_TRANSPORT_AMBIGUOUS: 2xx response without a canonical PAYMENT-RESPONSE receipt",
        };
      }

      // SUBMITTED — seller's settlement CLAIM. On-chain truth is owned by the
      // ReconciliationEngine (tx receipt consensus + nonce-scan fallback).
      try {
        await this.store.recordSubmissionResult(
          intent.paymentIntentId, "SETTLEMENT_PENDING",
          receipt.transaction, response.status, record,
        );
        if (intent.nonce) {
          await this.store.markNonceSubmitted(intent.nonce);
        }
      } catch (bookkeepingErr: unknown) {
        // F-112/H-8: post-payment bookkeeping failures must not blur the
        // outcome — best-effort durable CAS, result stays SUBMITTED.
        const bookMsg = bookkeepingErr instanceof Error ? bookkeepingErr.message : "unknown bookkeeping error";
        await this.store.compareAndSetState(
          intent.paymentIntentId, "SUBMITTING", "SETTLEMENT_PENDING",
          {
            txHash: receipt.transaction,
            facilitatorResponseBody: record,
            errorReason: `SETTLE_OK_BOOKKEEPING_FAILED: ${bookMsg}`,
          } as Partial<DurablePaymentIntent>,
        ).catch(() => {});
      }

      return { status: "SUBMITTED", txHash: receipt.transaction, rawResponse: record };
    }

    // -----------------------------------------------------------------
    // Non-2xx — mirror X402FacilitatorClient classification:
    //   402 = the seller's middleware re-challenged / refused verification —
    //   the canonical pre-settle refusal: nothing settled, but the durable
    //   state still goes to RECONCILING (CAS-guarded) so the reconciler — the
    //   single truth owner — confirms the nonce is unused.
    //   408/409/429/5xx = transient/ambiguous → UNKNOWN.
    //   other 4xx = definitive refusal → REJECTED.
    // -----------------------------------------------------------------
    const reason = `STANDARD_TRANSPORT: HTTP ${response.status} — seller refused the payment`;
    const ambiguous =
      response.status === 408 || response.status === 409 || response.status === 429 ||
      response.status >= 500;

    await this.reconcileAmbiguous(intent.paymentIntentId, {
      facilitatorHttpStatus: response.status,
      facilitatorResponseBody: record,
      errorReason: ambiguous
        ? `STANDARD_TRANSPORT_AMBIGUOUS: HTTP ${response.status}`
        : `STANDARD_TRANSPORT_REJECTED: HTTP ${response.status}`,
    });

    if (ambiguous) {
      return { status: "UNKNOWN", error: reason };
    }
    return { status: "REJECTED", reason, rawResponse: record };
  }
}
