import { Router, type Response } from "express";
import { z } from "zod";
import type { CreateRequestResult, ExecuteRequest } from "zeus-secretariat";
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

  return router;
}