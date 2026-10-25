/**
 * Zeus Secretariat V0 - Seller Capability Resolver
 *
 * Determines recovery capabilities based on trusted sources.
 * Priority: Registry > Discovery > Headers > NONE
 */
export class SellerCapabilityResolver {
    sources;
    constructor(sources = []) {
        this.sources = sources;
    }
    /**
     * Resolve seller capability and snapshot it in the operation.
     * Once snapped, capability is immutable during the operation lifecycle.
     */
    async resolveAndSnapshot(operation, responseHeaders) {
        // If already snapped, do not overwrite (immutability of capability during lifecycle)
        if (operation.sellerCapability)
            return;
        let cap = null;
        // 1. Check trusted registry/discovery sources
        for (const source of this.sources) {
            const c = await source.getCapability(operation.target);
            if (c) {
                cap = c;
                break;
            }
        }
        // 2. Fallback to response headers (hint only)
        if (!cap && responseHeaders) {
            const recovery = responseHeaders.get('X-Recovery-Capability');
            if (recovery && ['EXECUTION_IDEMPOTENT', 'RESULT_RETRIEVAL', 'SIGNED_RECEIPT'].includes(recovery)) {
                cap = {
                    recoveryCapability: recovery,
                    resultRetrievalEndpoint: responseHeaders.get('X-Result-Retrieval-Endpoint') || undefined,
                    idempotencyHeader: responseHeaders.get('X-Idempotency-Header') || undefined,
                };
            }
        }
        // 3. Default to NONE
        operation.sellerCapability = cap || { recoveryCapability: 'NONE' };
    }
}
//# sourceMappingURL=capability-resolver.js.map