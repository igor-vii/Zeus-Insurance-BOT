"use strict";
/**
 * Zeus Secretariat V0 - State Machine Implementation
 *
 * Core invariant: After payment is submitted, we CANNOT blindly retry.
 * We must first determine settlement status before any recovery action.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Secretariat = void 0;
// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function generateOperationId() {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}
function now() {
    return Date.now();
}
// ============================================================================
// STATE MACHINE TRANSITIONS
// ============================================================================
const VALID_TRANSITIONS = {
    CREATED: ['DISCOVERING', 'FAILED'],
    DISCOVERING: ['PAYMENT_REQUIRED', 'SUCCESS', 'FAILED'],
    PAYMENT_REQUIRED: ['AUTHORIZED', 'POLICY_REJECTED', 'FAILED'],
    AUTHORIZED: ['PAYMENT_SUBMITTED', 'FAILED'],
    PAYMENT_SUBMITTED: ['SETTLEMENT_UNKNOWN', 'SETTLED', 'SETTLEMENT_FAILED'],
    SETTLEMENT_UNKNOWN: ['SETTLED', 'SETTLEMENT_FAILED'],
    SETTLED: ['EXECUTION_PENDING', 'EXECUTION_UNKNOWN'],
    EXECUTION_PENDING: ['EXECUTION_CONFIRMED', 'EXECUTION_UNKNOWN', 'FAILED'],
    EXECUTION_CONFIRMED: ['DELIVERED', 'FAILED'],
    DELIVERED: ['SUCCESS'],
    SUCCESS: [], // Terminal state
    FAILED: [], // Terminal state
    POLICY_REJECTED: [], // Terminal state
    SETTLEMENT_FAILED: ['FAILED'],
    EXECUTION_UNKNOWN: ['RECOVERY_PENDING', 'FAILED'],
    RECOVERY_PENDING: ['RECOVERED', 'SUCCESS', 'UNRESOLVABLE', 'FAILED'],
    RECOVERED: [], // Terminal state
    UNRESOLVABLE: [], // Terminal state
};
function isValidTransition(from, to) {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
class Secretariat {
    config;
    constructor(config) {
        this.config = config;
    }
    // ==========================================================================
    // MAIN ENTRY POINT: Execute an operation
    // ==========================================================================
    async execute(request) {
        const operationId = generateOperationId();
        const requestId = request.requestId ?? generateRequestId();
        // Create initial operation
        const operation = this.createOperation(operationId, requestId, request);
        // Persist initial state
        await this.persistOperation(operation);
        try {
            // Step 1: Discovery
            await this.discoveryPhase(operation);
            // Step 2: Check if payment required
            if (operation.currentState === 'PAYMENT_REQUIRED') {
                // Step 3: Policy validation
                const policyValid = await this.validatePolicy(operation);
                if (!policyValid) {
                    return await this.failOperation(operation, 'POLICY_REJECTED', 'Payment policy validation failed');
                }
                // Step 4: Payment authorization
                await this.authorizePayment(operation);
                // Step 5: Payment submission
                await this.submitPayment(operation);
                // Step 6: Settlement observation
                await this.observeSettlement(operation);
            }
            // Step 7: Execution observation
            if (operation.currentState === 'SETTLED' || operation.currentState === 'EXECUTION_PENDING') {
                await this.observeExecution(operation);
            }
            // Step 8: Delivery
            if (operation.currentState === 'EXECUTION_CONFIRMED') {
                await this.deliver(operation);
            }
            // Return final result
            return this.buildResult(operation);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return await this.failOperation(operation, 'FAILED', errorMessage);
        }
    }
    // ==========================================================================
    // OPERATION CREATION
    // ==========================================================================
    createOperation(operationId, requestId, request) {
        const operation = {
            operationId,
            requestId,
            target: request.target,
            method: request.method,
            requestPayload: request.payload,
            paymentPolicy: request.policy,
            paymentState: 'NOT_STARTED',
            executionState: 'NOT_STARTED',
            deliveryState: 'NOT_STARTED',
            currentState: 'CREATED',
            timestamps: {
                createdAt: now(),
                updatedAt: now(),
            },
            evidence: [],
        };
        // Record creation evidence
        this.recordEvidence(operation, 'FINAL', 'OPERATION_CREATED', {
            requestId,
            target: request.target,
            method: request.method,
        });
        return operation;
    }
    // ==========================================================================
    // PHASE 1: DISCOVERY
    // ==========================================================================
    async discoveryPhase(operation) {
        this.transitionState(operation, 'DISCOVERING');
        this.recordEvidence(operation, 'DISCOVERY', 'DISCOVERY_STARTED', {
            target: operation.target,
        });
        try {
            // Make initial request to discover if payment is required
            const response = await fetch(operation.target, {
                method: operation.method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
            });
            if (response.status === 402) {
                // Payment required - parse payment requirement
                await this.handlePaymentRequired(operation, response);
            }
            else if (response.ok) {
                // No payment required - direct success
                await this.handleDirectSuccess(operation, response);
            }
            else {
                // Other error
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        }
        catch (error) {
            this.recordEvidence(operation, 'DISCOVERY', 'DISCOVERY_ERROR', {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async handlePaymentRequired(operation, response) {
        this.transitionState(operation, 'PAYMENT_REQUIRED');
        operation.timestamps.paymentRequiredAt = now();
        // Parse payment requirement from response
        const paymentRequirement = await this.parsePaymentRequirement(response);
        this.recordEvidence(operation, 'DISCOVERY', 'PAYMENT_REQUIREMENT_RECEIVED', {
            requirement: paymentRequirement,
        });
        // Discover seller capabilities
        operation.sellerCapability = await this.discoverSellerCapabilities(response, paymentRequirement);
        this.recordEvidence(operation, 'DISCOVERY', 'SELLER_CAPABILITIES_DISCOVERED', {
            capabilities: operation.sellerCapability,
        });
    }
    async handleDirectSuccess(operation, response) {
        const body = await response.json().catch(() => null);
        operation.resultData = body;
        operation.executionState = 'CONFIRMED';
        operation.deliveryState = 'DELIVERED';
        operation.executionEvidence = {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            timestamp: now(),
            source: 'HTTP_RESPONSE',
        };
        this.transitionState(operation, 'SUCCESS');
        operation.timestamps.completedAt = now();
        this.recordEvidence(operation, 'FINAL', 'DIRECT_SUCCESS', {
            statusCode: response.status,
        });
    }
    // ==========================================================================
    // PHASE 2: POLICY VALIDATION
    // ==========================================================================
    async validatePolicy(operation) {
        this.recordEvidence(operation, 'POLICY', 'POLICY_VALIDATION_STARTED', {});
        const policy = operation.paymentPolicy;
        const requirement = await this.getPaymentRequirementFromEvidence(operation);
        if (!requirement) {
            this.recordEvidence(operation, 'POLICY', 'POLICY_VALIDATION_FAILED', {
                reason: 'No payment requirement found',
            });
            return false;
        }
        // Check max price
        if (parseFloat(requirement.amount) > parseFloat(policy.maxPrice)) {
            this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
                reason: 'Amount exceeds maxPrice',
                required: requirement.amount,
                maxAllowed: policy.maxPrice,
            });
            return false;
        }
        // Check allowed networks
        if (!policy.allowedNetworks.includes(requirement.network)) {
            this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
                reason: 'Network not allowed',
                required: requirement.network,
                allowed: policy.allowedNetworks,
            });
            return false;
        }
        // Check allowed assets
        if (!policy.allowedAssets.includes(requirement.asset)) {
            this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
                reason: 'Asset not allowed',
                required: requirement.asset,
                allowed: policy.allowedAssets,
            });
            return false;
        }
        // Check allowed sellers (if specified)
        if (policy.allowedSellers && !policy.allowedSellers.includes(requirement.payee)) {
            this.recordEvidence(operation, 'POLICY', 'POLICY_REJECTED', {
                reason: 'Seller not allowed',
                required: requirement.payee,
                allowed: policy.allowedSellers,
            });
            return false;
        }
        this.recordEvidence(operation, 'POLICY', 'POLICY_VALIDATION_PASSED', {
            amount: requirement.amount,
            network: requirement.network,
            asset: requirement.asset,
            payee: requirement.payee,
        });
        return true;
    }
    // ==========================================================================
    // PHASE 3: PAYMENT AUTHORIZATION
    // ==========================================================================
    async authorizePayment(operation) {
        this.transitionState(operation, 'AUTHORIZED');
        operation.timestamps.authorizedAt = now();
        const requirement = await this.getPaymentRequirementFromEvidence(operation);
        if (!requirement) {
            throw new Error('No payment requirement found for authorization');
        }
        // Get adapter for the network
        const adapter = this.getAdapterForNetwork(requirement.network);
        // Create signing context
        const context = {
            operationId: operation.operationId,
            requirement,
        };
        // Sign payment using external signer
        const authorization = await adapter.createAuthorization(requirement, this.config.signer, context);
        // Create payment intent record
        const paymentIntent = {
            operationId: operation.operationId,
            requirement,
            amount: requirement.amount,
            asset: requirement.asset,
            network: requirement.network,
            authorization,
            createdAt: now(),
            status: 'AUTHORIZED',
        };
        this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_AUTHORIZED', {
            intent: paymentIntent,
        });
        operation.paymentState = 'AUTHORIZED';
    }
    // ==========================================================================
    // PHASE 4: PAYMENT SUBMISSION
    // CRITICAL: After this point, we cannot blindly retry
    // ==========================================================================
    async submitPayment(operation) {
        this.transitionState(operation, 'PAYMENT_SUBMITTED');
        operation.timestamps.paymentSubmittedAt = now();
        const requirement = await this.getPaymentRequirementFromEvidence(operation);
        if (!requirement) {
            throw new Error('No payment requirement found for submission');
        }
        const authorization = await this.getAuthorizationFromEvidence(operation);
        if (!authorization) {
            throw new Error('No payment authorization found for submission');
        }
        // Get adapter for the network
        const adapter = this.getAdapterForNetwork(requirement.network);
        // Submit payment
        const submissionResult = await adapter.submit(requirement, authorization);
        if (!submissionResult.success) {
            this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_SUBMISSION_FAILED', {
                error: submissionResult.errorMessage,
            });
            throw new Error(submissionResult.errorMessage ?? 'Payment submission failed');
        }
        this.recordEvidence(operation, 'PAYMENT', 'PAYMENT_SUBMITTED', {
            transactionHash: submissionResult.transactionHash,
            rawData: submissionResult.rawData,
        });
        operation.paymentState = 'SUBMITTED';
    }
    // ==========================================================================
    // PHASE 5: SETTLEMENT OBSERVATION
    // CRITICAL: Must determine settlement status before any recovery action
    // ==========================================================================
    async observeSettlement(operation) {
        const requirement = await this.getPaymentRequirementFromEvidence(operation);
        if (!requirement) {
            throw new Error('No payment requirement found for settlement observation');
        }
        const submissionResult = await this.getSubmissionResultFromEvidence(operation);
        if (!submissionResult) {
            throw new Error('No submission result found for settlement observation');
        }
        // Get adapter for the network
        const adapter = this.getAdapterForNetwork(requirement.network);
        // Observe settlement
        const observation = await adapter.observeSettlement(requirement, submissionResult);
        if (observation.settled) {
            this.transitionState(operation, 'SETTLED');
            operation.timestamps.settledAt = now();
            operation.paymentState = 'SETTLED';
            // Create settlement proof
            operation.settlementProof = {
                transactionHash: observation.transactionHash,
                blockNumber: observation.blockNumber,
                timestamp: observation.timestamp ?? now(),
                amount: observation.amount ?? requirement.amount,
                asset: observation.asset ?? requirement.asset,
                source: adapter.network,
                rawData: observation.rawData,
            };
            this.recordEvidence(operation, 'SETTLEMENT', 'SETTLEMENT_CONFIRMED', {
                observation,
                proof: operation.settlementProof,
            });
        }
        else {
            // Settlement unknown - CRITICAL STATE
            this.transitionState(operation, 'SETTLEMENT_UNKNOWN');
            operation.paymentState = 'UNKNOWN';
            this.recordEvidence(operation, 'SETTLEMENT', 'SETTLEMENT_UNKNOWN', {
                observation,
                warning: 'Cannot proceed until settlement status is determined',
            });
            // Do NOT retry payment - wait for settlement confirmation
            throw new Error('Settlement status unknown - recovery required');
        }
    }
    // ==========================================================================
    // PHASE 6: EXECUTION OBSERVATION
    // This is a SEPARATE axis from payment state
    // Payment can be SETTLED while execution is UNKNOWN
    // ==========================================================================
    async observeExecution(operation) {
        this.transitionState(operation, 'EXECUTION_PENDING');
        try {
            // Attempt to get execution result
            const response = await fetch(operation.target, {
                method: operation.method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
            });
            if (response.ok) {
                const body = await response.json().catch(() => null);
                operation.resultData = body;
                operation.executionState = 'CONFIRMED';
                operation.executionEvidence = {
                    statusCode: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                    body,
                    timestamp: now(),
                    source: 'HTTP_RESPONSE',
                };
                this.transitionState(operation, 'EXECUTION_CONFIRMED');
                operation.timestamps.executionConfirmedAt = now();
                this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_CONFIRMED', {
                    statusCode: response.status,
                });
            }
            else {
                // Execution failed or unknown
                this.transitionState(operation, 'EXECUTION_UNKNOWN');
                operation.executionState = 'UNKNOWN';
                this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_UNKNOWN', {
                    statusCode: response.status,
                    statusText: response.statusText,
                });
                // Trigger recovery based on seller capabilities
                await this.handleRecovery(operation);
            }
        }
        catch (error) {
            // Network error - execution unknown
            this.transitionState(operation, 'EXECUTION_UNKNOWN');
            operation.executionState = 'UNKNOWN';
            this.recordEvidence(operation, 'EXECUTION', 'EXECUTION_NETWORK_ERROR', {
                error: error instanceof Error ? error.message : String(error),
            });
            // Trigger recovery based on seller capabilities
            await this.handleRecovery(operation);
        }
    }
    // ==========================================================================
    // PHASE 7: RECOVERY
    // Based on seller capabilities - NO blind retry
    // ==========================================================================
    async handleRecovery(operation) {
        if (!operation.sellerCapability) {
            this.recordEvidence(operation, 'RECOVERY', 'NO_CAPABILITIES_KNOWN', {});
            this.transitionState(operation, 'UNRESOLVABLE');
            operation.error = 'No seller capabilities known - cannot recover';
            return;
        }
        const capability = operation.sellerCapability.recoveryCapability;
        this.recordEvidence(operation, 'RECOVERY', 'RECOVERY_ATTEMPT_STARTED', {
            capability,
        });
        this.transitionState(operation, 'RECOVERY_PENDING');
        switch (capability) {
            case 'RESULT_RETRIEVAL':
                await this.recoverViaResultRetrieval(operation);
                break;
            case 'EXECUTION_IDEMPOTENT':
                await this.recoverViaIdempotentRetry(operation);
                break;
            case 'SIGNED_RECEIPT':
                await this.recoverViaSignedReceipt(operation);
                break;
            case 'NONE':
            default:
                this.recordEvidence(operation, 'RECOVERY', 'NO_RECOVERY_PATH', {
                    capability,
                });
                this.transitionState(operation, 'UNRESOLVABLE');
                operation.error = 'No recovery path available';
                break;
        }
    }
    async recoverViaResultRetrieval(operation) {
        const endpoint = operation.sellerCapability?.resultRetrievalEndpoint;
        if (!endpoint) {
            this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVAL_NO_ENDPOINT', {});
            this.transitionState(operation, 'UNRESOLVABLE');
            operation.error = 'No result retrieval endpoint available';
            return;
        }
        try {
            const url = `${endpoint}/${operation.operationId}`;
            const response = await fetch(url, { method: 'GET' });
            if (response.ok) {
                const body = await response.json().catch(() => null);
                operation.resultData = body;
                operation.executionState = 'CONFIRMED';
                operation.executionEvidence = {
                    statusCode: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                    body,
                    timestamp: now(),
                    source: 'RESULT_RETRIEVAL',
                };
                this.transitionState(operation, 'RECOVERED');
                operation.timestamps.completedAt = now();
                this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVED', {
                    endpoint: url,
                });
            }
            else {
                this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVAL_FAILED', {
                    statusCode: response.status,
                });
                this.transitionState(operation, 'UNRESOLVABLE');
                operation.error = 'Result retrieval failed';
            }
        }
        catch (error) {
            this.recordEvidence(operation, 'RECOVERY', 'RESULT_RETRIEVAL_ERROR', {
                error: error instanceof Error ? error.message : String(error),
            });
            this.transitionState(operation, 'UNRESOLVABLE');
            operation.error = 'Result retrieval error';
        }
    }
    async recoverViaIdempotentRetry(operation) {
        const headerName = operation.sellerCapability?.idempotencyHeader ?? 'Idempotency-Key';
        try {
            const response = await fetch(operation.target, {
                method: operation.method,
                headers: {
                    'Content-Type': 'application/json',
                    [headerName]: operation.operationId,
                },
                body: operation.requestPayload ? JSON.stringify(operation.requestPayload) : undefined,
            });
            if (response.ok) {
                const body = await response.json().catch(() => null);
                operation.resultData = body;
                operation.executionState = 'CONFIRMED';
                operation.executionEvidence = {
                    statusCode: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                    body,
                    timestamp: now(),
                    source: 'HTTP_RESPONSE',
                };
                this.transitionState(operation, 'SUCCESS');
                operation.timestamps.completedAt = now();
                this.recordEvidence(operation, 'RECOVERY', 'IDEMPOTENT_RETRY_SUCCESS', {
                    idempotencyKey: operation.operationId,
                });
            }
            else {
                this.recordEvidence(operation, 'RECOVERY', 'IDEMPOTENT_RETRY_FAILED', {
                    statusCode: response.status,
                });
                this.transitionState(operation, 'UNRESOLVABLE');
                operation.error = 'Idempotent retry failed';
            }
        }
        catch (error) {
            this.recordEvidence(operation, 'RECOVERY', 'IDEMPOTENT_RETRY_ERROR', {
                error: error instanceof Error ? error.message : String(error),
            });
            this.transitionState(operation, 'UNRESOLVABLE');
            operation.error = 'Idempotent retry error';
        }
    }
    async recoverViaSignedReceipt(operation) {
        // TODO: Implement signed receipt verification
        this.recordEvidence(operation, 'RECOVERY', 'SIGNED_RECEIPT_NOT_IMPLEMENTED', {});
        this.transitionState(operation, 'UNRESOLVABLE');
        operation.error = 'Signed receipt verification not implemented in V0';
    }
    // ==========================================================================
    // PHASE 8: DELIVERY
    // ==========================================================================
    async deliver(operation) {
        operation.deliveryState = 'DELIVERED';
        operation.timestamps.deliveredAt = now();
        this.recordEvidence(operation, 'DELIVERY', 'DELIVERY_COMPLETED', {});
        this.transitionState(operation, 'SUCCESS');
        operation.timestamps.completedAt = now();
    }
    // ==========================================================================
    // FAILURE HANDLING
    // ==========================================================================
    async failOperation(operation, status, error) {
        operation.currentState = status;
        operation.error = error;
        operation.timestamps.failedAt = now();
        operation.timestamps.updatedAt = now();
        this.recordEvidence(operation, 'FINAL', 'OPERATION_FAILED', {
            status,
            error,
        });
        await this.persistOperation(operation);
        return this.buildResult(operation);
    }
    // ==========================================================================
    // STATE TRANSITION
    // ==========================================================================
    transitionState(operation, newState) {
        if (!isValidTransition(operation.currentState, newState)) {
            throw new Error(`Invalid state transition: ${operation.currentState} → ${newState}`);
        }
        const oldState = operation.currentState;
        operation.currentState = newState;
        operation.timestamps.updatedAt = now();
        this.recordEvidence(operation, 'FINAL', 'STATE_TRANSITION', {
            from: oldState,
            to: newState,
        });
    }
    // ==========================================================================
    // EVIDENCE RECORDING
    // ==========================================================================
    recordEvidence(operation, phase, event, payload) {
        const record = {
            operationId: operation.operationId,
            phase,
            timestamp: now(),
            event,
            payload,
        };
        operation.evidence.push(record);
    }
    // ==========================================================================
    // PERSISTENCE
    // ==========================================================================
    async persistOperation(operation) {
        await this.config.evidenceStore.saveOperation(operation);
        // Also append latest evidence
        if (operation.evidence.length > 0) {
            const latestEvidence = operation.evidence[operation.evidence.length - 1];
            await this.config.evidenceStore.append(latestEvidence);
        }
    }
    // ==========================================================================
    // RESULT BUILDING
    // ==========================================================================
    buildResult(operation) {
        return {
            operationId: operation.operationId,
            status: this.mapToFinalStatus(operation.currentState),
            paymentStatus: operation.paymentState,
            executionStatus: operation.executionState,
            data: operation.resultData,
            settlementProof: operation.settlementProof,
            executionEvidence: operation.executionEvidence,
            evidence: [...operation.evidence],
            error: operation.error,
        };
    }
    mapToFinalStatus(state) {
        switch (state) {
            case 'SUCCESS':
            case 'DELIVERED':
            case 'EXECUTION_CONFIRMED':
                return 'SUCCESS';
            case 'RECOVERED':
                return 'RECOVERED';
            case 'UNRESOLVABLE':
                return 'UNRESOLVABLE';
            default:
                return 'FAILED';
        }
    }
    // ==========================================================================
    // HELPERS
    // ==========================================================================
    getAdapterForNetwork(network) {
        const adapter = this.config.adapters.get(network);
        if (!adapter) {
            throw new Error(`No payment adapter found for network: ${network}`);
        }
        return adapter;
    }
    async parsePaymentRequirement(response) {
        // Parse x402 payment requirement from response headers/body
        // This is where Syra patterns can be reused as reference
        const paymentHeader = response.headers.get('X-Payment-Required');
        if (!paymentHeader) {
            throw new Error('402 response missing payment requirement');
        }
        // Simple parsing - in real implementation use Syra's proven parsing logic
        const parts = paymentHeader.split(';').map(p => p.trim());
        const requirement = {};
        for (const part of parts) {
            const [key, value] = part.split('=').map(s => s.replace(/['"]/g, ''));
            if (key && value) {
                requirement[key] = value;
            }
        }
        return {
            amount: requirement.amount ?? '0',
            asset: requirement.asset ?? 'unknown',
            network: requirement.network ?? 'unknown',
            payee: requirement.payee ?? 'unknown',
            ...requirement,
        };
    }
    async discoverSellerCapabilities(response, requirement) {
        // Discover capabilities from response headers
        const recoveryCapability = response.headers.get('X-Recovery-Capability') ?? 'NONE';
        const resultRetrievalEndpoint = response.headers.get('X-Result-Retrieval-Endpoint') ?? undefined;
        const idempotencyHeader = response.headers.get('X-Idempotency-Header') ?? undefined;
        return {
            recoveryCapability,
            resultRetrievalEndpoint,
            idempotencyHeader,
        };
    }
    async getPaymentRequirementFromEvidence(operation) {
        const evidence = operation.evidence.find(e => e.phase === 'DISCOVERY' && e.event === 'PAYMENT_REQUIREMENT_RECEIVED');
        if (!evidence || typeof evidence.payload !== 'object' || evidence.payload === null) {
            return null;
        }
        return evidence.payload.requirement;
    }
    async getAuthorizationFromEvidence(operation) {
        const evidence = operation.evidence.find(e => e.phase === 'PAYMENT' && e.event === 'PAYMENT_AUTHORIZED');
        if (!evidence || typeof evidence.payload !== 'object' || evidence.payload === null) {
            return null;
        }
        const intent = evidence.payload.intent;
        return intent?.authorization;
    }
    async getSubmissionResultFromEvidence(operation) {
        const evidence = operation.evidence.find(e => e.phase === 'PAYMENT' && e.event === 'PAYMENT_SUBMITTED');
        if (!evidence || typeof evidence.payload !== 'object' || evidence.payload === null) {
            return null;
        }
        return {
            success: true,
            transactionHash: evidence.payload.transactionHash,
            rawData: evidence.payload.rawData,
        };
    }
    // ==========================================================================
    // GETTERS FOR EXTERNAL ACCESS
    // ==========================================================================
    async getOperation(operationId) {
        return await this.config.evidenceStore.getOperation(operationId);
    }
    async getEvidence(operationId) {
        return await this.config.evidenceStore.getEvidence(operationId);
    }
}
exports.Secretariat = Secretariat;
//# sourceMappingURL=state-machine.js.map