/**
 * Zeus Secretariat V0 - Crypto Nonce Generator
 *
 * Generates cryptographically secure nonces for payment authorizations.
 * Format: 0x + 64 hex characters (bytes32-compatible for EIP-3009).
 */
import { NonceGenerator } from './payment-types.js';
export declare class CryptoNonceGenerator implements NonceGenerator {
    /**
     * Generate a cryptographically secure nonce.
     * Uses Node.js crypto.randomBytes for security.
     *
     * @returns 0x-prefixed 64-character hex string (32 bytes)
     */
    generate(): string;
}
/**
 * In-memory nonce registry for testing.
 * NOT suitable for production - use persistent storage.
 */
export declare class InMemoryNonceRegistry {
    private nonceMap;
    reserveNonce(operationId: string, nonce: string): Promise<void>;
    isNonceReserved(nonce: string): Promise<boolean>;
    getOperationForNonce(nonce: string): Promise<string | null>;
    /**
     * Clear all reserved nonces (for testing only).
     */
    clear(): void;
}
/**
 * Error thrown when attempting to reuse a nonce.
 */
export declare class NonceAlreadyUsedError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=nonce-generator.d.ts.map