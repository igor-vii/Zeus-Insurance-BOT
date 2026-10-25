/**
 * Zeus Secretariat V0 - Local EOA Payment Signer
 *
 * DEVELOPMENT / TEST IMPLEMENTATION ONLY.
 *
 * This signer uses a local private key for signing payment authorizations.
 * It is NOT suitable for production use.
 *
 * Security Requirements:
 * - Private key MUST NOT be logged
 * - Private key MUST NOT be stored in evidence
 * - Private key MUST NOT be stored in operation records
 * - Private key should only be provided via environment variable
 */
import { PaymentSigner } from '../core/payment-signer.js';
import { PaymentAuthorizationRequest, PaymentSignatureResult } from '../core/payment-types.js';
import { type Chain } from 'viem';
export interface LocalEoaSignerConfig {
    /**
     * Private key for the local account.
     * MUST be provided via environment variable in production.
     * Format: 0x-prefixed hex string.
     */
    privateKey: string;
    /**
     * Optional chain configuration.
     * Defaults to Base Mainnet.
     */
    chain?: Chain;
}
export declare class LocalEoaPaymentSigner implements PaymentSigner {
    readonly signerType = "LOCAL_EOA";
    private readonly walletClient;
    private readonly address;
    constructor(config: LocalEoaSignerConfig);
    /**
     * Get the payer address controlled by this signer.
     */
    getAddress(): Promise<string>;
    /**
     * Sign a payment authorization request using EIP-712 (signTypedData).
     *
     * Implements EIP-3009 TransferWithAuthorization structure for USDC compatibility.
     * This signature can be used directly with USDC contract's transferWithAuthorization.
     *
     * @param request - Validated payment authorization request
     * @returns PaymentSignatureResult with verified binding
     */
    signPayment(request: PaymentAuthorizationRequest): Promise<PaymentSignatureResult>;
}
/**
 * Factory function to create LocalEoaPaymentSigner from environment.
 *
 * @param privateKeyEnvVar - Environment variable name containing private key
 * @returns LocalEoaPaymentSigner instance
 *
 * @throws Error if private key is not found or invalid
 */
export declare function createLocalEoaSignerFromEnv(privateKeyEnvVar?: string): LocalEoaPaymentSigner;
//# sourceMappingURL=local-eoa-signer.d.ts.map