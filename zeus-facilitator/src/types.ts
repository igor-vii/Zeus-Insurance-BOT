/**
 * Zeus facilitator — canonical x402 v2 types.
 *
 * These mirror the shapes the rest of the repo already speaks:
 *   - zeus-secretariat/src/adapters/x402-facilitator-client.ts (F-112) builds
 *     exactly this /settle envelope;
 *   - tests/secretariat-sandbox/drivers/argus-live-mock.mjs enforces the same
 *     response contract on the E2E mock.
 *
 * Keeping the definitions local (not imported from the patched x402 package)
 * makes the facilitator's wire contract explicit and reviewable.
 */

export type X402Version = 2;

/** Canonical v2 payment payload (the decoded PAYMENT-SIGNATURE object). */
export interface CanonicalPaymentPayload {
  readonly x402Version: X402Version;

  readonly resource?: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };

  readonly accepted: {
    readonly scheme: string;
    readonly network: string;
    readonly amount: string;
    readonly asset: string;
    readonly payTo: string;
    readonly maxTimeoutSeconds: number;
    readonly extra?: {
      readonly assetTransferMethod?: string;
      readonly name?: string;
      readonly version?: string;
      readonly [key: string]: unknown;
    };
  };

  readonly payload: {
    readonly signature: string;
    readonly authorization: {
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: string;
    };
  };

  readonly extensions?: Record<string, unknown>;
}

/** paymentRequirements derived from `accepted` + resource (F-112 envelope). */
export interface CanonicalPaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly resource?: { url: string; description?: string; mimeType?: string };
  readonly extra?: Record<string, unknown>;
}

/** POST /verify and POST /settle request envelope (canonical v2). */
export interface FacilitatorRequest {
  readonly x402Version: number;
  readonly paymentPayload: CanonicalPaymentPayload;
  readonly paymentRequirements: CanonicalPaymentRequirements;
}

/** POST /verify response (canonical v2 remote-facilitator contract). */
export type VerifyResponse =
  | { readonly isValid: true; readonly payer: string }
  | { readonly isValid: false; readonly invalidReason: string };

/**
 * POST /settle response. `transaction` is the canonical v2 field name;
 * `transactionHash` is included as a compatibility alias (the repo's own
 * client reads transactionHash ?? txHash ?? transaction_hash, and the E2E
 * mock asserts transactionHash).
 */
export interface SettleSuccess {
  readonly success: true;
  readonly transaction: string;
  readonly transactionHash: string;
  readonly network: string;
  readonly payer: string;
}

export interface SettleFailure {
  readonly success: false;
  readonly errorReason: string;
  readonly network: string;
  /** Set when the transaction was broadcast but did not land successfully. */
  readonly transaction?: string;
}

/** EIP-3009 TransferWithAuthorization authorization tuple. */
export interface TransferWithAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}
