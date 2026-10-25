/**
 * Zeus facilitator — public surface.
 *
 * The canonical x402 v2 remote-facilitator contract:
 *   POST /verify {x402Version, paymentPayload, paymentRequirements} → {isValid, ...}
 *   POST /settle same → {success, transaction, errorReason?}
 */
export {
  FACILITATOR_NETWORKS,
  ConfigError,
  loadConfigFromEnv,
  type FacilitatorConfig,
  type FacilitatorNetwork,
} from "./config.js";
export type { ChainRpc } from "./rpc.js";
export {
  EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
  getBalance,
  isAuthorizationUsed,
  splitSignature,
  verifyOffChain,
  verifyRequest,
  type VerifiedAuthorization,
  type VerifyFailureReason,
  type VerifyOutcome,
} from "./verify.js";
export {
  NonceGuard,
  SettleExecutor,
  createViemRpc,
  encodeSettleCalldata,
  type SettleOutcome,
} from "./settle.js";
export {
  ZeusFacilitator,
  main,
  type FacilitatorDeps,
} from "./server.js";
export type {
  CanonicalPaymentPayload,
  CanonicalPaymentRequirements,
  FacilitatorRequest,
  SettleFailure,
  SettleSuccess,
  TransferWithAuthorization,
  VerifyResponse,
  X402Version,
} from "./types.js";
