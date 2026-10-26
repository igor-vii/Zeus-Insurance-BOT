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
import { createWalletClient, http, } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, xLayer } from 'viem/chains';
// D1-verified bindings (see UNVERIFIED_ASSUMPTIONS.md: D1 = FACT —
// DOMAIN_SEPARATOR() on-chain matches keccak(EIP712Domain(USD Coin, 2, chainId, token))).
const USDC_DOMAIN_BINDINGS = [
    {
        chain: base,
        chainAliases: new Set(['base', 'base-mainnet', 'eip155:8453', '8453']),
        verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    {
        chain: xLayer,
        chainAliases: new Set(['x-layer', 'xlayer', 'xlayer-mainnet', 'eip155:196', '196']),
        verifyingContract: '0x74b7F16337B8972027F6196A17a631aC6dE26d22',
    },
    {
        // Testnet — Circle native USDC (EIP-3009, domain "USD Coin"/"2").
        // Present so dev/test rigs keep working; production is fail-fast on
        // chains without a D1-verified binding.
        chain: baseSepolia,
        chainAliases: new Set(['base-sepolia', 'eip155:84532', '84532']),
        verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
];
function resolveUsdcDomain(request) {
    const network = String(request.network ?? '').trim().toLowerCase();
    const binding = USDC_DOMAIN_BINDINGS.find((b) => b.chainAliases.has(network));
    if (!binding) {
        throw new Error(`LocalEoaPaymentSigner: no USDC EIP-712 domain binding for network "${request.network}". ` +
            `Supported: ${[...USDC_DOMAIN_BINDINGS.flatMap((b) => b.chainAliases)].join(', ')}. ` +
            `Use the non-custodial (external signature) path for other networks.`);
    }
    return {
        name: 'USD Coin',
        version: '2',
        chainId: binding.chain.id,
        verifyingContract: binding.verifyingContract,
    };
}
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
    TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
export class LocalEoaPaymentSigner {
    signerType = 'LOCAL_EOA';
    walletClient;
    address;
    constructor(config) {
        // Create account from private key
        const account = privateKeyToAccount(config.privateKey);
        this.address = account.address;
        // Create wallet client
        this.walletClient = createWalletClient({
            account,
            transport: http(),
            chain: config.chain || base,
        });
    }
    /**
     * Get the payer address controlled by this signer.
     */
    async getAddress() {
        return this.address;
    }
    /**
     * Sign a payment authorization request using EIP-712 (signTypedData).
     *
     * Implements EIP-3009 TransferWithAuthorization structure for USDC compatibility.
     * This signature can be used directly with USDC contract's transferWithAuthorization.
     *
     * @param request - Validated payment authorization request
     * @returns PaymentSignatureResult with verified binding
     */
    async signPayment(request) {
        // Validate binding before signing
        if (!request.operationId || !request.payer || !request.nonce) {
            throw new Error('Invalid PaymentAuthorizationRequest: missing critical fields');
        }
        // Prepare EIP-3009 message structure
        const message = {
            from: request.payer,
            to: request.payTo,
            value: BigInt(request.amount), // Amount must be in smallest unit (e.g., 6 decimals for USDC)
            validAfter: BigInt(request.validAfter),
            validBefore: BigInt(request.validBefore),
            nonce: request.nonce,
        };
        // Sign using EIP-712 (signTypedData) — R7-C-signer: the domain is derived
        // from the request's network (fail-fast on unsupported networks), no
        // longer hardwired to Base.
        const domain = resolveUsdcDomain(request);
        const signature = await this.walletClient.signTypedData({
            account: this.walletClient.account,
            domain,
            types: TRANSFER_WITH_AUTHORIZATION_TYPES,
            primaryType: 'TransferWithAuthorization',
            message,
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
}
/**
 * Factory function to create LocalEoaPaymentSigner from environment.
 *
 * @param privateKeyEnvVar - Environment variable name containing private key
 * @returns LocalEoaPaymentSigner instance
 *
 * @throws Error if private key is not found or invalid
 */
export function createLocalEoaSignerFromEnv(privateKeyEnvVar = 'ZEUS_SIGNER_PRIVATE_KEY') {
    const privateKey = process.env[privateKeyEnvVar];
    if (!privateKey) {
        throw new Error(`Private key not found. Set ${privateKeyEnvVar} environment variable.`);
    }
    // Basic validation
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
        throw new Error(`Invalid private key format. Expected 0x-prefixed 64-character hex string.`);
    }
    return new LocalEoaPaymentSigner({
        privateKey,
    });
}
//# sourceMappingURL=local-eoa-signer.js.map