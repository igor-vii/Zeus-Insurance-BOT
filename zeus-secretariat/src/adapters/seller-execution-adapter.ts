/**
 * Zeus Secretariat V0 — Phase 2.4: Post-Settlement Execution & Recovery
 *
 * SellerExecutionAdapter — boundary between Secretariat and seller HTTP endpoints.
 *
 * Critical taxonomy (INV-13: evidence before interpretation):
 *   SUCCESS          — seller responded 2xx with body
 *   HTTP_FAILURE     — seller responded 4xx/5xx (execution happened, failed)
 *   DELIVERY_UNKNOWN — cannot determine if execution happened (timeout, connection reset)
 *
 * HTTP 5xx ≠ timeout
 * timeout ≠ seller failure
 * connection lost ≠ execution did not happen
 */

import { egressFetch, EgressBlockedError } from "../core/egress-guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SellerExecutionRequest {
  /** Stable idempotency key — persisted, survives restarts (INV-9) */
  readonly idempotencyKey: string;
  /** Target URL */
  readonly url: string;
  /** HTTP method */
  readonly method: string;
  /** Request headers (merged with Idempotency-Key) */
  readonly headers?: Record<string, string>;
  /** Request body */
  readonly body?: unknown;
  /** Timeout in milliseconds */
  readonly timeoutMs?: number;
}

export type SellerExecutionResult =
  | {
      kind: "SUCCESS";
      statusCode: number;
      body?: unknown;
      headers: Record<string, string>;
      durationMs: number;
    }
  | {
      kind: "HTTP_FAILURE";
      statusCode: number;
      body?: unknown;
      headers: Record<string, string>;
      durationMs: number;
    }
  | {
      kind: "DELIVERY_UNKNOWN";
      reason:
        | "TIMEOUT"
        | "CONNECTION_RESET"
        | "RESPONSE_STREAM_FAILED"
        | "CLIENT_ABORTED"
        | "DNS_RESOLUTION_FAILED"
        // R7-B1 (external audit 2026-10-26): the egress guard refused the
        // destination — the request NEVER LEFT. Previously lumped into
        // RESPONSE_STREAM_FAILED, which hid the real cause.
        | "EGRESS_BLOCKED";
      error: string;
      durationMs: number;
    };

export interface SellerExecutionAdapter {
  execute(request: SellerExecutionRequest): Promise<SellerExecutionResult>;
}

// ---------------------------------------------------------------------------
// Real HTTP Seller Adapter
// ---------------------------------------------------------------------------

export class HttpSellerExecutionAdapter implements SellerExecutionAdapter {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 30_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async execute(request: SellerExecutionRequest): Promise<SellerExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // F-09 fix (external audit 2026-10-25): the execution/retrieval URL is
      // client-influenced (operation.target / discovered retrieval endpoint).
      // Validate against the egress policy and forbid redirects, same as the
      // discovery path.
      const response = await egressFetch(request.url, {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
          ...(request.headers ?? {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      // S7 live-matrix repair (2026-10-23) + R7-B1 (external audit
      // 2026-10-26): the body is read EXACTLY ONCE, as text, with the abort
      // signal still armed — the previous json()-then-text() sequence
      // consumed the stream and made EVERY non-JSON 2xx (text/plain,
      // empty-bodied 204 siblings, XML, …) throw "Body is unusable" on the
      // second read, misclassifying honest deliveries as
      // DELIVERY_UNKNOWN/RESPONSE_STREAM_FAILED. A lost mid-flight stream
      // still surfaces (text() itself throws) — the S7 guarantee stands.
      // The timeout is also NOT cleared until the body is fully consumed:
      // a hung body must not hang the worker past the deadline.
      let rawBody: string | null = null;
      let streamBroken = false;
      try {
        rawBody = await response.text();
      } catch {
        streamBroken = true;
      }
      clearTimeout(timeoutId);

      let responseBody: unknown;
      if (!streamBroken && rawBody !== null) {
        const trimmed = rawBody.trim();
        if (trimmed.length > 0) {
          try {
            responseBody = JSON.parse(trimmed);
          } catch {
            // Complete but non-JSON body — honest evidence, not a broken stream.
            responseBody = { raw: trimmed.slice(0, 2000) };
          }
        }
      }

      const durationMs = Date.now() - startTime;

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // INV-13: Store raw evidence BEFORE classification
      if (streamBroken) {
        return {
          kind: "DELIVERY_UNKNOWN",
          reason: "RESPONSE_STREAM_FAILED",
          error: `2xx status received but the response body stream failed (status ${response.status})`,
          durationMs,
        };
      }

      if (response.ok) {
        return {
          kind: "SUCCESS",
          statusCode: response.status,
          body: responseBody,
          headers: responseHeaders,
          durationMs,
        };
      }

      // 4xx/5xx — execution happened but failed (NOT the same as timeout!)
      return {
        kind: "HTTP_FAILURE",
        statusCode: response.status,
        body: responseBody,
        headers: responseHeaders,
        durationMs,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      // R7-B1: the undici "fetch failed" TypeError wraps the real cause
      // (ECONNRESET, ENOTFOUND, ECONNREFUSED, certificate errors, …) in
      // error.cause — the previous text-only classification could not see
      // any of them and dumped nearly everything into RESPONSE_STREAM_FAILED.
      // R7-B1: an EgressBlockedError means the request NEVER LEFT — that is
      // not a delivery unknown caused by the network, it is a policy refusal;
      // it gets its own honest reason.
      if (err instanceof EgressBlockedError) {
        return {
          kind: "DELIVERY_UNKNOWN",
          reason: "EGRESS_BLOCKED",
          error: errorMsg,
          durationMs,
        };
      }

      const causeCode =
        (err as { cause?: { code?: string } } | null)?.cause?.code ?? "";
      const haystack = `${errorMsg} ${causeCode}`.toLowerCase();

      // Classify the error — this is DELIVERY_UNKNOWN, not HTTP_FAILURE
      let reason: "TIMEOUT" | "CONNECTION_RESET" | "RESPONSE_STREAM_FAILED" | "CLIENT_ABORTED" | "DNS_RESOLUTION_FAILED" | "EGRESS_BLOCKED";

      if (causeCode === "ECONNRESET" || haystack.includes(" econnreset") || haystack.includes("econnreset") || haystack.includes("connection reset")) {
        reason = "CONNECTION_RESET";
      } else if (causeCode === "ENOTFOUND" || haystack.includes("enotfound") || causeCode === "EAI_AGAIN" || haystack.includes("dns")) {
        reason = "DNS_RESOLUTION_FAILED";
      } else if (haystack.includes("abort") || haystack.includes("timeout") || causeCode === "ETIMEDOUT" || causeCode === "UND_ERR_ABORTED") {
        reason = "TIMEOUT";
      } else if (causeCode === "ECONNREFUSED" || haystack.includes("econnrefused")) {
        // Refused at TCP level = nothing was delivered.
        reason = "CONNECTION_RESET";
      } else {
        reason = "RESPONSE_STREAM_FAILED";
      }

      return {
        kind: "DELIVERY_UNKNOWN",
        reason,
        error: errorMsg,
        durationMs,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Mock Seller Adapter (for testing)
// ---------------------------------------------------------------------------

export interface MockSellerBehavior {
  delayMs?: number;
  forceTimeout?: boolean;
  forceStatusCode?: number;
  responseBody?: unknown;
  forceConnectionReset?: boolean;
}

export class MockSellerExecutionAdapter implements SellerExecutionAdapter {
  private behavior: MockSellerBehavior;
  readonly callLog: SellerExecutionRequest[] = [];

  constructor(behavior: MockSellerBehavior = {}) {
    this.behavior = behavior;
  }

  setBehavior(behavior: MockSellerBehavior): void {
    this.behavior = behavior;
  }

  getCallCount(): number {
    return this.callLog.length;
  }

  getLastIdempotencyKey(): string | undefined {
    return this.callLog[this.callLog.length - 1]?.idempotencyKey;
  }

  async execute(request: SellerExecutionRequest): Promise<SellerExecutionResult> {
    this.callLog.push(request);
    const startTime = Date.now();

    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }

    if (this.behavior.forceTimeout) {
      return {
        kind: "DELIVERY_UNKNOWN",
        reason: "TIMEOUT",
        error: "simulated timeout",
        durationMs: Date.now() - startTime,
      };
    }

    if (this.behavior.forceConnectionReset) {
      return {
        kind: "DELIVERY_UNKNOWN",
        reason: "CONNECTION_RESET",
        error: "simulated connection reset",
        durationMs: Date.now() - startTime,
      };
    }

    const statusCode = this.behavior.forceStatusCode ?? 200;
    const durationMs = Date.now() - startTime;

    if (statusCode >= 200 && statusCode < 300) {
      return {
        kind: "SUCCESS",
        statusCode,
        body: this.behavior.responseBody ?? { ok: true },
        headers: { "x-mock": "true" },
        durationMs,
      };
    }

    return {
      kind: "HTTP_FAILURE",
      statusCode,
      body: this.behavior.responseBody ?? { error: "mock error" },
      headers: { "x-mock": "true" },
      durationMs,
    };
  }
}
