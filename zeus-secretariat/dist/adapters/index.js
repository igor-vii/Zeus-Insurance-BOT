/**
 * Zeus Secretariat V0 - Payment Adapters
 *
 * Adapters are network-specific implementations.
 * Core does not know about Solana, Base, X Layer, etc.
 * Adapter knows the specific network.
 */
import { keccak256, toBytes } from 'viem';
export class MockPaymentAdapter {
    network;
    simulateSettlement;
    settlementDelay;
    failProbability;
    constructor(config) {
        this.network = config.network;
        this.simulateSettlement = config.simulateSettlement ?? true;
        this.settlementDelay = config.settlementDelay ?? 100;
        this.failProbability = config.failProbability ?? 0;
    }
    async createAuthorization(requirement, signer, context) {
        // Delegate to external signer
        return await signer.signPayment(requirement, context);
    }
    async submit(requirement, authorization) {
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
    async observeSettlement(requirement, submissionResult) {
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
export { MockPaymentSigner, MockSignerFactory } from './mock-payment-signer.js';
export { LocalEoaPaymentSigner, createLocalEoaSignerFromEnv } from './local-eoa-signer.js';
// ---------------------------------------------------------------------------
// R0 repair: canonical V2 mock settlement adapter.
// MockPaymentAdapter is the LEGACY PaymentAdapter (submit(requirement,
// authorization) → {success}); the state machine's canonical path requires a
// SettlementAdapter (submit(dpi, v2Payload) → SubmitResult). This mock records
// submissions so tests can drive reconciliation against deterministic
// on-chain evidence.
// ---------------------------------------------------------------------------
export class MockSettlementAdapter {
    store;
    network;
    failProbability = 0;
    counter = 0;
    submissions = [];
    /**
     * @param store optional durable store — when provided, submit() persists
     *   SETTLEMENT_PENDING + txHash and marks the nonce SUBMITTED, mirroring
     *   X402FacilitatorClient behavior (the reconciliation engine needs the
     *   durable txHash to take the txHash-first path).
     */
    constructor(store, network = 'mock-network') {
        this.store = store;
        this.network = network;
    }
    async submit(intent, payload) {
        if (Math.random() < this.failProbability) {
            return { status: 'REJECTED', reason: 'Simulated submission failure' };
        }
        this.counter += 1;
        const txHash = `0xmocktx${this.counter.toString(16).padStart(60, '0')}`;
        this.submissions.push({ intent, payload, txHash });
        if (this.store && typeof this.store.updatePaymentIntentStatus === 'function') {
            await this.store.updatePaymentIntentStatus(intent.paymentIntentId, 'SETTLEMENT_PENDING', { txHash });
        }
        if (this.store && intent.nonce && typeof this.store.markNonceSubmitted === 'function') {
            await this.store.markNonceSubmitted(intent.nonce).catch(() => { });
        }
        return { status: 'SUBMITTED', txHash, rawResponse: { transactionHash: txHash, success: true } };
    }
    /** Deterministic settled receipt for a recorded submission (§7/§8 shapes). */
    buildSettledReceipt(txHash) {
        const rec = this.submissions.find((s) => s.txHash === txHash);
        if (!rec)
            return null;
        const intent = rec.intent;
        const pad = (a) => '0x' + String(a).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
        const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        // keccak256("AuthorizationUsed(address,bytes32)")
        const authUsedTopic = keccak256(toBytes('AuthorizationUsed(address,bytes32)'));
        return {
            confirmed: true,
            status: 'success',
            blockNumber: 50_000,
            confirmations: 12,
            logs: [
                {
                    address: intent.asset,
                    topics: [authUsedTopic, pad(intent.authorizer), pad(intent.nonce)],
                    data: '0x',
                    logIndex: 0,
                },
                {
                    address: intent.asset,
                    topics: [transferTopic, pad(intent.authorizer), pad(intent.payTo)],
                    data: '0x' + BigInt(intent.value).toString(16),
                    logIndex: 1,
                },
            ],
        };
    }
}
export { PaymentSigningError, NonceAlreadyUsedError, SignerBindingError, InvalidAuthorizationError, SignatureUnknownError, PolicyNotValidatedError, } from '../core/payment-errors.js';
export { CryptoNonceGenerator, InMemoryNonceRegistry, } from '../core/nonce-generator.js';
// Phase 2.3: Real Facilitator Settlement
export { X402FacilitatorClient, MockX402FacilitatorClient, encodePaymentSignature, } from "./x402-facilitator-client.js";
// Phase 2.4: Post-Settlement Execution
export { HttpSellerExecutionAdapter, MockSellerExecutionAdapter, } from "./seller-execution-adapter.js";
//# sourceMappingURL=index.js.map