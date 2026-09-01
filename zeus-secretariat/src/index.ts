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
export type { PaymentSigner } from './core/payment-signer';
export type {
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

// Post-settlement execution engine (canonical V0 seller execution lifecycle)
export { PostSettlementEngine, InMemoryExecutionStore } from './core/post-settlement-engine';
export type { ExecutionAttempt, RecoveryJob, RecoveryJobType, RecoveryJobStatus, PostSettlementConfig, ExecutionStore, ExecutionObligationStatus, AtomicSettlementHandoff } from './core/post-settlement-engine';

// PostgreSQL execution store (production persistence for execution/recovery)
export { PostgresExecutionStore } from './store/postgres-execution-store';

// Seller execution adapter (HTTP implementation)
export { HttpSellerExecutionAdapter, MockSellerExecutionAdapter } from './adapters/seller-execution-adapter';
export type { SellerExecutionAdapter, SellerExecutionRequest, SellerExecutionResult } from './adapters/seller-execution-adapter';

// Reconciliation engine (B.3-A: canonical settlement verification)
export { ReconciliationEngine } from './core/reconciliation-engine';
export type { ReconciliationOutcome } from './core/reconciliation-engine';
// ReconciliationScheduleConfig and FinalityPolicy are exported from ./core/types

// Reconciliation worker (B.3-B2: durable polling worker)
export { ReconciliationWorker } from './core/reconciliation-worker';
export type { ReconciliationWorkerConfig } from './core/reconciliation-worker';

// Multi-RPC checker (required by ReconciliationEngine)
export { MultiRpcChecker } from './core/multi-rpc-checker';

// Shared store factory (R1: production composition primitive)
export { createSharedStores } from './store/factory';
export type { SharedStores } from './store/factory';

