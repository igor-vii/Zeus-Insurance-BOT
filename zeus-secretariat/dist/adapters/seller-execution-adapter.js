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
import { egressFetch } from "../core/egress-guard.js";
// ---------------------------------------------------------------------------
// Real HTTP Seller Adapter
// ---------------------------------------------------------------------------
export class HttpSellerExecutionAdapter {
    defaultTimeoutMs;
    constructor(defaultTimeoutMs = 30_000) {
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    async execute(request) {
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
            clearTimeout(timeoutId);
            // S7 live-matrix repair (2026-10-23, Argus Agent Test Lab vs real
            // Secretariat): the previous `await response.json().catch(() => undefined)`
            // swallowed a broken body stream, so a 2xx response whose body was LOST
            // mid-flight (truncated chunked stream, socket destroyed after the
            // status line) was classified as SUCCESS — the delivery trail claimed
            // the resource was delivered when the client never received it. A lost
            // body is not a delivered body: fall back to text(); if the stream
            // itself is broken, classify DELIVERY_UNKNOWN/RESPONSE_STREAM_FAILED
            // (same vocabulary the catch-path uses) instead of SUCCESS.
            let responseBody;
            let streamBroken = false;
            try {
                responseBody = await response.json();
            }
            catch {
                try {
                    const raw = await response.text();
                    responseBody = raw.length > 0 ? { raw: raw.slice(0, 2000) } : undefined;
                }
                catch {
                    streamBroken = true;
                }
            }
            const durationMs = Date.now() - startTime;
            const responseHeaders = {};
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
        }
        catch (err) {
            clearTimeout(timeoutId);
            const durationMs = Date.now() - startTime;
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            // Classify the error — this is DELIVERY_UNKNOWN, not HTTP_FAILURE
            let reason;
            if (errorMsg.includes("abort") || errorMsg.includes("timeout")) {
                reason = "TIMEOUT";
            }
            else if (errorMsg.includes("ECONNRESET") ||
                errorMsg.includes("connection reset")) {
                reason = "CONNECTION_RESET";
            }
            else if (errorMsg.includes("ENOTFOUND") || errorMsg.includes("DNS")) {
                reason = "DNS_RESOLUTION_FAILED";
            }
            else {
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
export class MockSellerExecutionAdapter {
    behavior;
    callLog = [];
    constructor(behavior = {}) {
        this.behavior = behavior;
    }
    setBehavior(behavior) {
        this.behavior = behavior;
    }
    getCallCount() {
        return this.callLog.length;
    }
    getLastIdempotencyKey() {
        return this.callLog[this.callLog.length - 1]?.idempotencyKey;
    }
    async execute(request) {
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
//# sourceMappingURL=seller-execution-adapter.js.map