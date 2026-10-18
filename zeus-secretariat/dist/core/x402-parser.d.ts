/**
 * Zeus Secretariat V0 - x402 Challenge Parser
 *
 * Parses x402 v2 Payment Requirements from HTTP 402 responses.
 * Priority: PAYMENT-REQUIRED header > JSON body.
 */
export interface X402Accept {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds?: number;
}
export interface X402Challenge {
    accepts: X402Accept[];
    metadata?: Record<string, unknown>;
}
export declare class X402Parser {
    /**
     * Parse payment requirements from a 402 Response.
     * Handles both Base64 headers and JSON bodies safely.
     */
    static parseResponse(response: Response): Promise<X402Accept[]>;
    /**
     * Parse from a pre-fetched JSON object.
     */
    static parseFromJSON(body: unknown): X402Accept[];
}
//# sourceMappingURL=x402-parser.d.ts.map