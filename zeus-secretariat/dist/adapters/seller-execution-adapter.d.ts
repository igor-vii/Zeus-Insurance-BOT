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
export type SellerExecutionResult = {
    kind: "SUCCESS";
    statusCode: number;
    body?: unknown;
    headers: Record<string, string>;
    durationMs: number;
} | {
    kind: "HTTP_FAILURE";
    statusCode: number;
    body?: unknown;
    headers: Record<string, string>;
    durationMs: number;
} | {
    kind: "DELIVERY_UNKNOWN";
    reason: "TIMEOUT" | "CONNECTION_RESET" | "RESPONSE_STREAM_FAILED" | "CLIENT_ABORTED" | "DNS_RESOLUTION_FAILED";
    error: string;
    durationMs: number;
};
export interface SellerExecutionAdapter {
    execute(request: SellerExecutionRequest): Promise<SellerExecutionResult>;
}
export declare class HttpSellerExecutionAdapter implements SellerExecutionAdapter {
    private readonly defaultTimeoutMs;
    constructor(defaultTimeoutMs?: number);
    execute(request: SellerExecutionRequest): Promise<SellerExecutionResult>;
}
export interface MockSellerBehavior {
    delayMs?: number;
    forceTimeout?: boolean;
    forceStatusCode?: number;
    responseBody?: unknown;
    forceConnectionReset?: boolean;
}
export declare class MockSellerExecutionAdapter implements SellerExecutionAdapter {
    private behavior;
    readonly callLog: SellerExecutionRequest[];
    constructor(behavior?: MockSellerBehavior);
    setBehavior(behavior: MockSellerBehavior): void;
    getCallCount(): number;
    getLastIdempotencyKey(): string | undefined;
    execute(request: SellerExecutionRequest): Promise<SellerExecutionResult>;
}
//# sourceMappingURL=seller-execution-adapter.d.ts.map