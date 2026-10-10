/**
 * B6-B Evidence Vocabulary Extensions.
 *
 * Extends the existing Evidence model with buyer-side protocol events
 * required to distinguish payment from delivery in external SUT testing.
 *
 * These types are consumed by B6-B acceptance assertions.
 * They do NOT replace or modify the existing Observation/EngineEvent types.
 *
 * Key semantic boundary:
 *   payment accepted ≠ work delivered
 *   timeout after payment = UNKNOWN / DELIVERY_UNKNOWN, NOT FAILURE
 */

import type { EngineEvent } from './Evidence';

// ---------------------------------------------------------------------------
// B6-B Evidence Types
// ---------------------------------------------------------------------------

/** Payment signature was submitted to the external SUT. */
export interface PaymentSignatureSubmittedEvent extends EngineEvent {
  source: 'engine';
  type: 'payment_signature_submitted';
  data: {
    actionType: string;
    /** HTTP status code of the retry response, if available. */
    httpStatus?: number;
    /** Whether PAYMENT-RESPONSE header was present in the response. */
    paymentResponsePresent?: boolean;
  };
}

/** External SUT accepted the payment (returned 200-class response). */
export interface PaymentAcceptedEvent extends EngineEvent {
  source: 'engine';
  type: 'payment_accepted';
  data: {
    actionType: string;
    httpStatus: number;
    /** Raw PAYMENT-RESPONSE header value, if present. NOT settlement proof. */
    paymentResponseHeader?: string;
    /** Whether the response body contained a resource/delivery indicator. */
    responseBodyPresent?: boolean;
  };
}

/** External SUT rejected the payment (returned 402 or error after signature). */
export interface PaymentRejectedEvent extends EngineEvent {
  source: 'engine';
  type: 'payment_rejected';
  data: {
    actionType: string;
    httpStatus: number;
    /** Rejection reason from response body, if available. */
    rejectionDetail?: string;
  };
}

/** External SUT returned a response after payment acceptance. */
export interface SellerResponseReceivedEvent extends EngineEvent {
  source: 'engine';
  type: 'seller_response_received';
  data: {
    actionType: string;
    httpStatus: number;
    /** Whether the response indicates successful resource delivery. */
    deliveryIndicated?: boolean;
    /** Response body summary for assertion inspection. */
    bodySummary?: string;
  };
}

/** No response received from external SUT within timeout after payment. */
export interface TimeoutNoResponseEvent extends EngineEvent {
  source: 'engine';
  type: 'timeout_no_response';
  data: {
    actionType: string;
    /** Timeout duration in milliseconds. */
    timeoutMs: number;
    /** Whether payment was already accepted before timeout. */
    paymentWasAccepted: boolean;
  };
}

/** Union of all B6-B extended evidence types. */
export type B6BEvidence =
  | PaymentSignatureSubmittedEvent
  | PaymentAcceptedEvent
  | PaymentRejectedEvent
  | SellerResponseReceivedEvent
  | TimeoutNoResponseEvent;

// ---------------------------------------------------------------------------
// B6-B Verdict Extensions
// ---------------------------------------------------------------------------

/**
 * Extended verdict statuses for B6-B.
 *
 * DELIVERY_UNKNOWN: payment was accepted but delivery cannot be confirmed.
 * This is distinct from FAILURE (protocol/payment error) and UNKNOWN
 * (insufficient evidence overall).
 */
export type B6BVerdictStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'DELIVERY_UNKNOWN';

/**
 * Determine B6-B verdict from collected evidence.
 *
 * Rules:
 * - payment_accepted + seller_response_received + deliveryIndicated → PASS
 * - payment_rejected → FAIL
 * - payment_signature_submitted + payment_accepted + NO seller_response_received → DELIVERY_UNKNOWN
 * - payment_signature_submitted + timeout_no_response + paymentWasAccepted → DELIVERY_UNKNOWN
 * - payment_signing_failed → FAIL
 * - no evidence at all → UNKNOWN
 */
export function computeB6BVerdict(evidence: Array<{ type: string; data: Record<string, unknown> }>): {
  status: B6BVerdictStatus;
  summary: string;
} {
  const types = evidence.map(e => e.type);

  const hasPaymentAccepted = types.includes('payment_accepted');
  const hasSellerResponse = types.includes('seller_response_received');
  const hasTimeout = types.includes('timeout_no_response');
  const hasRejection = types.includes('payment_rejected');
  const hasSigningFailed = types.includes('payment_signing_failed');
  const hasSignatureSubmitted = types.includes('payment_signature_submitted');

  // Check delivery indication in seller response
  const sellerResponseEvents = evidence.filter(e => e.type === 'seller_response_received');
  const deliveryIndicated = sellerResponseEvents.some(
    e => (e.data as { deliveryIndicated?: boolean }).deliveryIndicated === true
  );

  if (hasSigningFailed) {
    return { status: 'FAIL', summary: 'Payment signing failed.' };
  }

  if (hasRejection) {
    const rejectionEvent = evidence.find(e => e.type === 'payment_rejected');
    const detail = (rejectionEvent?.data as { rejectionDetail?: string })?.rejectionDetail;
    return {
      status: 'FAIL',
      summary: `Payment rejected by SUT${detail ? `: ${detail}` : ''}.`,
    };
  }

  if (hasPaymentAccepted && hasSellerResponse && deliveryIndicated) {
    return { status: 'PASS', summary: 'Payment accepted and delivery confirmed.' };
  }

  if (hasPaymentAccepted && hasSellerResponse && !deliveryIndicated) {
    return {
      status: 'DELIVERY_UNKNOWN',
      summary: 'Payment accepted but seller response did not confirm delivery.',
    };
  }

  if (hasPaymentAccepted && hasTimeout) {
    return {
      status: 'DELIVERY_UNKNOWN',
      summary: 'Payment accepted but no response received within timeout.',
    };
  }

  if (hasPaymentAccepted && !hasSellerResponse && !hasTimeout) {
    return {
      status: 'DELIVERY_UNKNOWN',
      summary: 'Payment accepted but no seller response or timeout evidence recorded.',
    };
  }

  if (hasSignatureSubmitted && !hasPaymentAccepted) {
    return {
      status: 'UNKNOWN',
      summary: 'Payment signature submitted but acceptance not confirmed.',
    };
  }

  return { status: 'UNKNOWN', summary: 'Insufficient evidence to determine outcome.' };
}
