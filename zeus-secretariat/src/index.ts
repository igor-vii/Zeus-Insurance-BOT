/**
 * Zeus Secretariat V0
 * 
 * Independent implementation with its own architecture and state machine.
 * Reuses proven x402 implementation patterns where useful, but does not import
 * Syra's architecture, dependencies, retry semantics, or economic assumptions.
 */

// Core types
export * from './core/types';

// Payment signer boundary (Phase 2.1)
export { PaymentSigner } from './core/payment-signer';
export {
  PaymentAuthorizationRequest,
  PaymentSignatureResult,
  SignedPaymentAuthorization,
  PaymentAuthorizationState,
  NonceGenerator,
  NonceRegistry,
} from './core/payment-types';
export {
  PaymentSigningError,
  NonceAlreadyUsedError,
  SignerBindingError,
  InvalidAuthorizationError,
  SignatureUnknownError,
  PolicyNotValidatedError,
} from './core/payment-errors';
export {
  CryptoNonceGenerator,
  InMemoryNonceRegistry,
} from './core/nonce-generator';

// State machine
export * from './core/state-machine';

// Evidence store
export * from './store';

// Adapters
export * from './adapters';
