/**
 * Zeus Secretariat V0 - Payment Adapters
 * 
 * Adapters are network-specific implementations.
 * Core does not know about Solana, Base, X Layer, etc.
 * Adapter knows the specific network.
 */

export interface MockPaymentAdapterConfig {
  network: string;
  simulateSettlement?: boolean;
  settlementDelay?: number;
  failProbability?: number;
}

export class MockPaymentAdapter {
  readonly network: string;
  private readonly simulateSettlement: boolean;
  private readonly settlementDelay: number;
  private readonly failProbability: number;

  constructor(config: MockPaymentAdapterConfig) {
    this.network = config.network;
    this.simulateSettlement = config.simulateSettlement ?? true;
    this.settlementDelay = config.settlementDelay ?? 100;
    this.failProbability = config.failProbability ?? 0;
  }

  async createAuthorization(
    requirement: any,
    signer: any,
    context: any
  ): Promise<any> {
    // Delegate to external signer
    return await signer.signPayment(requirement, context);
  }

  async submit(
    requirement: any,
    authorization: any
  ): Promise<any> {
    // Simulate submission failure based on probability
    if (Math.random() < this.failProbability) {
      return {
        success: false,
        errorMessage: 'Simulated submission failure',
      };
    }

    // Generate mock transaction hash
    const txHash = `0x${Math.random().toString(16).substring(2, 66)}`;

    return {
      success: true,
      transactionHash: txHash,
      rawData: {
        network: this.network,
        amount: requirement.amount,
        asset: requirement.asset,
        payee: requirement.payee,
      },
    };
  }

  async observeSettlement(
    requirement: any,
    submissionResult: any
  ): Promise<any> {
    if (!this.simulateSettlement) {
      return {
        settled: false,
      };
    }

    // Simulate settlement delay
    await new Promise(resolve => setTimeout(resolve, this.settlementDelay));

    // Simulate settlement failure based on probability
    if (Math.random() < this.failProbability) {
      return {
        settled: false,
        transactionHash: submissionResult.transactionHash,
      };
    }

    return {
      settled: true,
      transactionHash: submissionResult.transactionHash,
      blockNumber: Math.floor(Math.random() * 1000000),
      timestamp: Date.now(),
      amount: requirement.amount,
      asset: requirement.asset,
      confirmations: 12,
    };
  }
}

// Export signers
export { MockPaymentSigner, MockSignerFactory } from './mock-payment-signer';
export { LocalEoaPaymentSigner, createLocalEoaSignerFromEnv } from './local-eoa-signer';

// Export core signer interfaces and types
export { PaymentSigner } from '../core/payment-signer';
export {
  PaymentAuthorizationRequest,
  PaymentSignatureResult,
  SignedPaymentAuthorization,
  PaymentAuthorizationState,
  NonceGenerator,
  NonceRegistry,
} from '../core/payment-types';
export {
  PaymentSigningError,
  NonceAlreadyUsedError,
  SignerBindingError,
  InvalidAuthorizationError,
  SignatureUnknownError,
  PolicyNotValidatedError,
} from '../core/payment-errors';
export {
  CryptoNonceGenerator,
  InMemoryNonceRegistry,
} from '../core/nonce-generator';

// Phase 2.3: Real Facilitator Settlement
export {
  X402FacilitatorClient,
  MockX402FacilitatorClient,
  type FacilitatorConfig,
  type PaymentPayload,
  type SubmitResult,
  type SettlementAdapter,
  type MockFacilitatorBehavior,
} from "./x402-facilitator-client";
