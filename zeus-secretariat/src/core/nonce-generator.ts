/**
 * Zeus Secretariat V0 - Crypto Nonce Generator
 * 
 * Generates cryptographically secure nonces for payment authorizations.
 * Format: 0x + 64 hex characters (bytes32-compatible for EIP-3009).
 */

import { NonceGenerator } from './payment-types.js';
import { NonceAlreadyUsedError } from './payment-errors.js';
import { randomBytes } from 'crypto';

export class CryptoNonceGenerator implements NonceGenerator {
  /**
   * Generate a cryptographically secure nonce.
   * Uses Node.js crypto.randomBytes for security.
   * 
   * @returns 0x-prefixed 64-character hex string (32 bytes)
   */
  generate(): string {
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
  private nonceMap: Map<string, string> = new Map();

  async reserveNonce(operationId: string, nonce: string): Promise<void> {
    // R0 repair: throw the CANONICAL NonceAlreadyUsedError from
    // payment-errors.ts. This file previously declared its own duplicate
    // class, so `instanceof` checks (and rejects.toThrow(Class) assertions)
    // against the exported canonical error always failed.
    if (this.nonceMap.has(nonce)) {
      throw new NonceAlreadyUsedError(
        `Nonce ${nonce} already reserved for operation ${this.nonceMap.get(nonce)}`
      );
    }
    this.nonceMap.set(nonce, operationId);
  }

  async isNonceReserved(nonce: string): Promise<boolean> {
    return this.nonceMap.has(nonce);
  }

  async getOperationForNonce(nonce: string): Promise<string | null> {
    return this.nonceMap.get(nonce) ?? null;
  }

  /**
   * Clear all reserved nonces (for testing only).
   */
  clear(): void {
    this.nonceMap.clear();
  }
}
