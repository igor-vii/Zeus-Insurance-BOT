/**
 * Zeus Secretariat V0 - Payment Signer Errors
 *
 * Structured error taxonomy for payment signing operations.
 */
/**
 * Base error for all payment signing errors.
 */
export class PaymentSigningError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PaymentSigningError';
    }
}
/**
 * Error thrown when attempting to reuse a nonce.
 */
export class NonceAlreadyUsedError extends PaymentSigningError {
    nonce;
    constructor(message, nonce) {
        super(message);
        this.name = 'NonceAlreadyUsedError';
        this.nonce = nonce;
    }
}
/**
 * Error thrown when signer binding verification fails.
 *
 * This happens when the returned signature does not match:
 * - operationId
 * - payer
 * - nonce
 */
export class SignerBindingError extends PaymentSigningError {
    expected;
    actual;
    constructor(message, expected, actual) {
        super(message);
        this.name = 'SignerBindingError';
        this.expected = expected;
        this.actual = actual;
    }
}
/**
 * Error thrown when authorization request is invalid.
 */
export class InvalidAuthorizationError extends PaymentSigningError {
    field;
    reason;
    constructor(message, field, reason) {
        super(message);
        this.name = 'InvalidAuthorizationError';
        this.field = field;
        this.reason = reason;
    }
}
/**
 * Error thrown when signature status is unknown after crash/restart.
 */
export class SignatureUnknownError extends PaymentSigningError {
    operationId;
    nonce;
    constructor(message, operationId, nonce) {
        super(message);
        this.name = 'SignatureUnknownError';
        this.operationId = operationId;
        this.nonce = nonce;
    }
}
/**
 * Error thrown when policy validation has not occurred before signing.
 */
export class PolicyNotValidatedError extends PaymentSigningError {
    constructor(message) {
        super(message);
        this.name = 'PolicyNotValidatedError';
    }
}
//# sourceMappingURL=payment-errors.js.map