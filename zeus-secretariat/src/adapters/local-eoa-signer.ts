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

import { PaymentSigner } from '../core/payment-signer';
import {
  PaymentAuthorizationRequest,
  PaymentSignatureResult,
} from '../core/payment-types';
import {
  createWalletClient,
  http,
  type Address,
  type WalletClient,
  type Transport,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface LocalEoaSignerConfig {
  /**
   * Private key for the local account.
   * MUST be provided via environment variable in production.
   * Format: 0x-prefixed hex string.
   */
  privateKey: string;

  /**
   * Optional chain configuration.
   * Defaults to a generic EVM chain.
   */
  chain?: Chain;
}

export class LocalEoaPaymentSigner implements PaymentSigner {
  readonly signerType = 'LOCAL_EOA';

  private readonly walletClient: WalletClient<Transport, Chain | undefined>;
  private readonly address: Address;

  constructor(config: LocalEoaSignerConfig) {
    // Create account from private key
    const account = privateKeyToAccount(config.privateKey as Address);
    
    this.address = account.address;

    // Create wallet client
    this.walletClient = createWalletClient({
      account,
      transport: http(),
      chain: config.chain,
    });
  }

  /**
   * Get the payer address controlled by this signer.
   */
  async getAddress(): Promise<string> {
    return this.address;
  }

  /**
   * Sign a payment authorization request.
   * 
   * For Phase 2.1, we create a simple signature over the authorization data.
   * Future phases will implement proper EIP-3009 TransferWithAuthorization.
   * 
   * @param request - Validated payment authorization request
   * @returns PaymentSignatureResult with verified binding
   */
  async signPayment(
    request: PaymentAuthorizationRequest
  ): Promise<PaymentSignatureResult> {
    // Prepare data to sign
    // This is a simplified approach for Phase 2.1
    // Phase 2.2 will implement proper EIP-712 domain-separated signing
    
    const messageToSign = this.prepareMessageToSign(request);
    
    // Get the account from wallet client
    const account = this.walletClient.account;
    if (!account) {
      throw new Error('No account configured in wallet client');
    }
    
    // Sign the message using viem
    const signature = await this.walletClient.signMessage({
      account,
      message: messageToSign,
    });

    return {
      operationId: request.operationId,
      signerType: this.signerType,
      payer: this.address,
      nonce: request.nonce,
      signature: signature,
      signedAt: new Date().toISOString(),
    };
  }

  /**
   * Prepare the message to sign.
   * 
   * This creates a human-readable message containing all critical fields.
   * Future implementation will use EIP-712 domain-separated typed data.
   */
  private prepareMessageToSign(request: PaymentAuthorizationRequest): string {
    return (
      `Zeus Secretariat Payment Authorization\n\n` +
      `Operation ID: ${request.operationId}\n` +
      `Network: ${request.network}\n` +
      `Asset: ${request.asset}\n` +
      `Amount: ${request.amount}\n` +
      `From: ${request.payer}\n` +
      `To: ${request.payTo}\n` +
      `Nonce: ${request.nonce}\n` +
      `Valid After: ${new Date(request.validAfter * 1000).toISOString()}\n` +
      `Valid Before: ${new Date(request.validBefore * 1000).toISOString()}`
    );
  }
}

/**
 * Factory function to create LocalEoaPaymentSigner from environment.
 * 
 * @param privateKeyEnvVar - Environment variable name containing private key
 * @returns LocalEoaPaymentSigner instance
 * 
 * @throws Error if private key is not found or invalid
 */
export function createLocalEoaSignerFromEnv(
  privateKeyEnvVar: string = 'ZEUS_SIGNER_PRIVATE_KEY'
): LocalEoaPaymentSigner {
  const privateKey = process.env[privateKeyEnvVar];
  
  if (!privateKey) {
    throw new Error(
      `Private key not found. Set ${privateKeyEnvVar} environment variable.`
    );
  }

  // Basic validation
  if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
    throw new Error(
      `Invalid private key format. Expected 0x-prefixed 64-character hex string.`
    );
  }

  return new LocalEoaPaymentSigner({
    privateKey,
  });
}
