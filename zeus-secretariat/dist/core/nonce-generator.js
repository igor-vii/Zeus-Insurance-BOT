/**
 * Zeus Secretariat V0 - Crypto Nonce Generator
 *
 * Generates cryptographically secure nonces for payment authorizations.
 * Format: 0x + 64 hex characters (bytes32-compatible for EIP-3009).
 */
import { randomBytes } from 'crypto';
export class CryptoNonceGenerator {
    /**
     * Generate a cryptographically secure nonce.
     * Uses Node.js crypto.randomBytes for security.
     *
     * @returns 0x-prefixed 64-character hex string (32 bytes)
     */
    generate() {
        // Generate 32 random bytes (256 bits)
        const bytes = randomBytes(32);
        // Convert to hex and prefix with 0x
        return '0x' + bytes.toString('hex');
    }
}
/**
 * In-memory nonce registry for testing.
 * NOT suitable for production - use persistent storage.
 */
export class InMemoryNonceRegistry {
    nonceMap = new Map();
    async reserveNonce(operationId, nonce) {
        if (this.nonceMap.has(nonce)) {
            throw new NonceAlreadyUsedError(`Nonce ${nonce} already reserved for operation ${this.nonceMap.get(nonce)}`);
        }
        this.nonceMap.set(nonce, operationId);
    }
    async isNonceReserved(nonce) {
        return this.nonceMap.has(nonce);
    }
    async getOperationForNonce(nonce) {
        return this.nonceMap.get(nonce) ?? null;
    }
    /**
     * Clear all reserved nonces (for testing only).
     */
    clear() {
        this.nonceMap.clear();
    }
}
/**
 * Error thrown when attempting to reuse a nonce.
 */
export class NonceAlreadyUsedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NonceAlreadyUsedError';
    }
}
//# sourceMappingURL=nonce-generator.js.map