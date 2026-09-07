import { Router, type Response } from "express";
import { z } from "zod";
import type {
  CreateRequestResult,
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
): PublicRequestStatusResponse {
  const status = publicStatusForOperation(operation);
  const response: PublicRequestStatusResponse = {
    requestId: operation.requestId,
    status,
  };

  const paymentRequired = paymentRequirementFromOperation(operation);
  if (paymentRequired) response.paymentRequired = paymentRequired;

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
      response.status(201).json({
        requestId: result.requestId,
        status: result.status,
        paymentRequired: result.paymentRequired,
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

    response.status(200).json(toPublicRequestStatus(operation));
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

    response.status(200).json(toPublicRequestStatus(operation));
  });

  return router;
}