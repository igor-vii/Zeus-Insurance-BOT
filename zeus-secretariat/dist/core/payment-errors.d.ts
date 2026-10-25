/**
 * Zeus Secretariat V0 - Payment Signer Errors
 *
 * Structured error taxonomy for payment signing operations.
 */
/**
 * Base error for all payment signing errors.
 */
export declare class PaymentSigningError extends Error {
    constructor(message: string);
}
/**
 * Error thrown when attempting to reuse a nonce.
 */
export declare class NonceAlreadyUsedError extends PaymentSigningError {
    readonly nonce: string;
    constructor(message: string, nonce: string);
}
/**
 * Error thrown when signer binding verification fails.
 *
 * This happens when the returned signature does not match:
 * - operationId
 * - payer
 * - nonce
 */
export declare class SignerBindingError extends PaymentSigningError {
    readonly expected: {
        operationId: string;
        payer: string;
        nonce: string;
    };
    readonly actual: {
        operationId: string;
        payer: string;
        nonce: string;
    };
    constructor(message: string, expected: {
        operationId: string;
        payer: string;
        nonce: string;
    }, actual: {
        operationId: string;
        payer: string;
        nonce: string;
    });
}
/**
 * Error thrown when authorization request is invalid.
 */
export declare class InvalidAuthorizationError extends PaymentSigningError {
    readonly field?: string;
    readonly reason?: string;
    constructor(message: string, field?: string, reason?: string);
}
/**
 * Error thrown when signature status is unknown after crash/restart.
 */
export declare class SignatureUnknownError extends PaymentSigningError {
    readonly operationId: string;
    readonly nonce: string;
    constructor(message: string, operationId: string, nonce: string);
}
/**
 * Error thrown when policy validation has not occurred before signing.
 */
export declare class PolicyNotValidatedError extends PaymentSigningError {
    constructor(message: string);
}
//# sourceMappingURL=payment-errors.d.ts.map