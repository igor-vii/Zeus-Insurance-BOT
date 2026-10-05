import { Router, type Response } from "express";
import { z } from "zod";
import type {
  CreateRequestResult,
  DurablePaymentIntent,
  Eip3009PaymentVerifier,
  ExecuteRequest,
  Operation,
  PaymentPayload,
  PaymentRequirement,
} from "zeus-secretariat";
import type { SecretariatComposition } from "../lib/secretariat-composition.js";
import { logger } from "../lib/logger.js";

const paymentPolicySchema = z.object({
  maxPrice: z.string().min(1),
  allowedNetworks: z.array(z.string()),
  allowedAssets: z.array(z.string()),
  allowedSellers: z.array(z.string()).optional(),
  authorizationMode: z.enum(["explicit", "policy-bound"]),
});

const createRequestSchema = z.object({
  target: z.string().url(),
  method: z.string().min(1),
  payload: z.unknown().optional(),
  clientId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  // [ARGUS-INTEGRATION PATCH #1]
  // Stage-A non-custodial mode requires the authorizer address; core
  // state-machine reads request.authorizer via requireNonEmpty(), but the
  // Zod schema dropped the field -> createPendingPaymentIntent threw and
  // every POST /v1/requests returned 500 (masked by the FK issue, see #3).
  // Minimal fix: accept the optional field so it reaches core unchanged.
  authorizer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  policy: paymentPolicySchema,
});

export type PublicRequestStatus =
  | "AWAITING_PAYMENT_SIGNATURE"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "UNRESOLVABLE"
  | "UNKNOWN";

export interface PublicRequestStatusResponse {
  requestId: string;
  status: PublicRequestStatus;
  paymentRequired?: PaymentRequirement;
  // [ARGUS-INTEGRATION PATCH #2] persisted DPI binding fields (public subset).
  paymentIntent?: {
    paymentIntentId: string;
    authorizer: string;
    payTo: string;
    value: string;
    asset: string;
    network: string;
    nonce: string;
    validAfter: number;
    validBefore: number;
    settlementState: string;
  };
  settlementTxHash?: string;
  outcome?: unknown;
  resolvedAt?: number;
  evidenceCount?: number;
}

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: {
      code,
      message,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

/**
 * [ARGUS-INTEGRATION PATCH #2 helper]
 * Derives the public payment requirement from the persisted DPI when the
 * discovery evidence round-trip did not survive persistence. Mirrors
 * Secretariat's own internal fallback (requirementFromIntent in the
 * state machine) — pure projection of fields already returned by core,
 * no business logic added at the boundary.
 */
function requirementFromPaymentIntent(
  intent: unknown,
): PaymentRequirement | undefined {
  const record = asRecord(intent);
  if (!record) return undefined;
  const requirement: PaymentRequirement = {
    amount: String(record.value ?? ""),
    asset: String(record.asset ?? ""),
    network: String(record.network ?? ""),
    payee: String(record.payTo ?? ""),
  };
  if (typeof record.validBefore === "number") {
    requirement.deadline = record.validBefore * 1000;
  }
  return requirement;
}

function paymentRequirementFromOperation(
  operation: Operation,
): PaymentRequirement | undefined {
  const evidence = operation.evidence.find(
    (record: {
      phase: string;
      event: string;
      payload: unknown;
    }) =>
      record.phase === "DISCOVERY" &&
      record.event === "PAYMENT_REQUIREMENT_RECEIVED",
  );
  const payload = asRecord(evidence?.payload);
  const requirement = payload?.requirement;
  return asRecord(requirement) as PaymentRequirement | undefined;
}

function settlementTxHashFromOperation(operation: Operation): string | undefined {
  const directHash = operation.settlementProof?.transactionHash;
  if (typeof directHash === "string") return directHash;

  const confirmed = operation.evidence.find(
    (record: {
      phase: string;
      event: string;
      payload: unknown;
    }) =>
      record.phase === "SETTLEMENT" &&
      record.event === "SETTLEMENT_CONFIRMED",
  );
  const confirmedPayload = asRecord(confirmed?.payload);
  const evidenceBundle = asRecord(confirmedPayload?.evidenceBundle);
  const authorizationUsed = asRecord(evidenceBundle?.authorizationUsed);
  if (typeof authorizationUsed?.transactionHash === "string") {
    return authorizationUsed.transactionHash;
  }

  const submitted = operation.evidence.find(
    (record: {
      phase: string;
      event: string;
      payload: unknown;
    }) =>
      record.phase === "PAYMENT" &&
      record.event === "PAYMENT_SUBMITTED",
  );
  const submittedPayload = asRecord(submitted?.payload);
  return typeof submittedPayload?.transactionHash === "string"
    ? submittedPayload.transactionHash
    : undefined;
}

function publicStatusForOperation(operation: Operation): PublicRequestStatus {
  const state = String(operation.currentState);

  if (state === "AWAITING_SIGNATURE" || state === "PENDING_SIGNATURE") {
    return "AWAITING_PAYMENT_SIGNATURE";
  }

  if (
    state === "SUCCESS" ||
    state === "DELIVERED" ||
    state === "EXECUTION_CONFIRMED" ||
    state === "RECOVERED"
  ) {
    return "COMPLETED";
  }

  if (
    state === "FAILED" ||
    state === "POLICY_REJECTED" ||
    state === "SETTLEMENT_FAILED" ||
    state === "NOT_SETTLED"
  ) {
    return "FAILED";
  }

  if (
    state === "UNRESOLVABLE" ||
    state === "UNRESOLVED_MANUAL" ||
    state === "INCIDENT"
  ) {
    return "UNRESOLVABLE";
  }

  if (
    state === "EXECUTION_UNKNOWN" ||
    state === "DELIVERY_UNKNOWN" ||
    operation.executionState === "UNKNOWN" ||
    operation.deliveryState === "UNKNOWN"
  ) {
    return "UNKNOWN";
  }

  return "PROCESSING";
}

function toPublicRequestStatus(
  operation: Operation,
  dpi?: DurablePaymentIntent | null,
): PublicRequestStatusResponse {
  const status = publicStatusForOperation(operation);
  const response: PublicRequestStatusResponse = {
    requestId: operation.requestId,
    status,
  };

  const paymentRequired =
    paymentRequirementFromOperation(operation) ??
    requirementFromPaymentIntent(dpi);
  if (paymentRequired) response.paymentRequired = paymentRequired;

  // [ARGUS-INTEGRATION PATCH #2] Expose the persisted DPI binding fields so a
  // black-box Stage-B client can sign the canonical EIP-3009 context.
  if (dpi) {
    response.paymentIntent = {
      paymentIntentId: dpi.paymentIntentId,
      authorizer: dpi.authorizer,
      payTo: dpi.payTo,
      value: dpi.value,
      asset: dpi.asset,
      network: dpi.network,
      nonce: dpi.nonce,
      validAfter: dpi.validAfter,
      validBefore: dpi.validBefore,
      settlementState: dpi.settlementState,
    };
  }

  const settlementTxHash = settlementTxHashFromOperation(operation);
  if (settlementTxHash) response.settlementTxHash = settlementTxHash;

  if (operation.resultData !== undefined) {
    response.outcome = operation.resultData;
  }

  if (status === "COMPLETED" || status === "FAILED" || status === "UNRESOLVABLE") {
    const resolvedAt =
      operation.timestamps.completedAt ?? operation.timestamps.failedAt;
    if (resolvedAt !== undefined) response.resolvedAt = resolvedAt;
  }

  if (Array.isArray(operation.evidence)) {
    response.evidenceCount = operation.evidence.length;
  }

  return response;
}

/**
 * Public Stage-A Secretariat API.
 *
 * This router deliberately receives the production Secretariat instance from
 * the composition root. It is only an HTTP adapter: all discovery, policy
 * validation, persistence, idempotency, and payment-intent creation remain in
 * Secretariat.createRequest().
 */
export function createRequestsRouter(
  secretariat: SecretariatComposition["secretariat"],
  paymentVerifier?: Pick<InstanceType<typeof Eip3009PaymentVerifier>, "verify">,
  // [ARGUS-INTEGRATION PATCH #2] read-only projection of the already
  // persisted DPI for the public GET response. No writes, no business logic.
  intentStore?: Pick<SecretariatComposition["stores"]["evidenceStore"], "getPaymentIntentByRequestId">,
): Router {
  const router = Router();

  router.post("/requests", async (request, response) => {
    const parsed = createRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(response, 400, "INVALID_REQUEST", "Request body is invalid");
      return;
    }

    const executeRequest: ExecuteRequest = parsed.data;

    let result: CreateRequestResult;
    try {
      result = await secretariat.createRequest(executeRequest);
    } catch (error) {
      logger.error({ err: error }, "Secretariat request creation failed");
      sendError(
        response,
        500,
        "SECRETARIAT_REQUEST_FAILED",
        "The request could not be created",
      );
      return;
    }

    if (result.status === "AWAITING_PAYMENT_SIGNATURE") {
      // [ARGUS-INTEGRATION PATCH #2]
      // The core already returns the persisted DPI in result.paymentIntent,
      // but the HTTP adapter dropped it. Stage-B clients (Argus S8) must sign
      // the EXACT canonical context (nonce/validAfter/validBefore/payTo/value)
      // or the EIP-3009 verifier rejects with NONCE_MISMATCH. Expose the DPI
      // binding fields so the black-box client can construct a valid x402 V2
      // payment payload without touching Secretariat internals.
      const paymentRequired =
        result.paymentRequired ?? requirementFromPaymentIntent(result.paymentIntent);
      response.status(201).json({
        requestId: result.requestId,
        status: result.status,
        paymentRequired,
        paymentIntent: result.paymentIntent,
      });
      return;
    }

    if (result.status === "REJECTED") {
      sendError(
        response,
        422,
        "REQUEST_REJECTED",
        "The request was rejected by the payment policy",
      );
      return;
    }

    sendError(
      response,
      409,
      "REQUEST_ALREADY_COMPLETED",
      "The request has already completed without a payment signature",
    );
  });

  router.get("/requests/:requestId", async (request, response) => {
    let operation: Operation | null;
    try {
      operation = await secretariat.getOperationByRequestId(
        request.params.requestId,
      );
    } catch (error) {
      logger.error({ err: error }, "Secretariat request status lookup failed");
      sendError(
        response,
        500,
        "SECRETARIAT_STATUS_LOOKUP_FAILED",
        "The request status could not be loaded",
      );
      return;
    }

    if (!operation) {
      sendError(
        response,
        404,
        "REQUEST_NOT_FOUND",
        "The request was not found",
      );
      return;
    }

    let dpi: DurablePaymentIntent | null = null;
    if (typeof intentStore?.getPaymentIntentByRequestId === "function") {
      try {
        dpi = await intentStore.getPaymentIntentByRequestId(request.params.requestId);
      } catch (error) {
        logger.warn({ err: error }, "DPI projection lookup failed");
      }
    }
    response.status(200).json(toPublicRequestStatus(operation, dpi));
  });

  router.post("/requests/:requestId/payment", async (request, response) => {
    if (!paymentVerifier) {
      sendError(
        response,
        503,
        "PAYMENT_VERIFICATION_UNAVAILABLE",
        "Payment verification is not configured",
      );
      return;
    }

    let verification;
    try {
      verification = await paymentVerifier.verify(
        request.params.requestId,
        request.body,
      );
    } catch (error) {
      logger.error({ err: error }, "Signed payment verification failed");
      sendError(
        response,
        500,
        "PAYMENT_VERIFICATION_FAILED",
        "The signed payment could not be verified",
      );
      return;
    }

    if (verification.status === "INVALID") {
      if (verification.code === "REQUEST_NOT_FOUND") {
        sendError(response, 404, "REQUEST_NOT_FOUND", "The request was not found");
        return;
      }
      if (verification.code === "PERSISTED_INTENT_LOOKUP_UNAVAILABLE") {
        sendError(
          response,
          503,
          "PAYMENT_VERIFICATION_UNAVAILABLE",
          "Payment verification is not configured correctly",
        );
        return;
      }

      response.status(422).json({
        error: {
          code: verification.code,
          message: verification.message,
          ...(verification.field ? { field: verification.field } : {}),
        },
      });
      return;
    }

    try {
      // Verification is complete before this canonical continuation is
      // entered. This endpoint does not persist or submit payment itself.
      await secretariat.submitSignedPayment(
        request.params.requestId,
        request.body as PaymentPayload,
      );
    } catch (error) {
      logger.error({ err: error }, "Signed payment continuation failed");
      const continuationCode =
        error instanceof Error &&
        error.message.startsWith("PAYMENT_PAYLOAD_RETRY_MISMATCH")
          ? "PAYMENT_PAYLOAD_RETRY_MISMATCH"
          : "PAYMENT_CONTINUATION_FAILED";
      sendError(
        response,
        409,
        continuationCode,
        continuationCode === "PAYMENT_PAYLOAD_RETRY_MISMATCH"
          ? "The payment payload does not match the previously accepted payload"
          : "The verified payment could not continue",
      );
      return;
    }

    let operation: Operation | null;
    try {
      operation = await secretariat.getOperationByRequestId(
        request.params.requestId,
      );
    } catch (error) {
      logger.error({ err: error }, "Payment status lookup failed");
      sendError(
        response,
        500,
        "SECRETARIAT_STATUS_LOOKUP_FAILED",
        "The payment status could not be loaded",
      );
      return;
    }

    if (!operation) {
      sendError(response, 404, "REQUEST_NOT_FOUND", "The request was not found");
      return;
    }

    let paymentDpi: DurablePaymentIntent | null = null;
    if (typeof intentStore?.getPaymentIntentByRequestId === "function") {
      try {
        paymentDpi = await intentStore.getPaymentIntentByRequestId(request.params.requestId);
      } catch (error) {
        logger.warn({ err: error }, "DPI projection lookup failed after payment");
      }
    }

    response.status(200).json(toPublicRequestStatus(operation, paymentDpi));
  });

  return router;
}