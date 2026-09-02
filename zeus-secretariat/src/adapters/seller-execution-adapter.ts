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
        | "DNS_RESOLUTION_FAILED";
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
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
          ...(request.headers ?? {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      const responseBody = await response.json().catch(() => undefined);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // INV-13: Store raw evidence BEFORE classification
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

      // Classify the error — this is DELIVERY_UNKNOWN, not HTTP_FAILURE
      let reason: "TIMEOUT" | "CONNECTION_RESET" | "RESPONSE_STREAM_FAILED" | "CLIENT_ABORTED" | "DNS_RESOLUTION_FAILED";

      if (errorMsg.includes("abort") || errorMsg.includes("timeout")) {
        reason = "TIMEOUT";
      } else if (
        errorMsg.includes("ECONNRESET") ||
        errorMsg.includes("connection reset")
      ) {
        reason = "CONNECTION_RESET";
      } else if (errorMsg.includes("ENOTFOUND") || errorMsg.includes("DNS")) {
        reason = "DNS_RESOLUTION_FAILED";
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
