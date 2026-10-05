/**
 * Zeus Secretariat V0 - Seller Capability Resolver
 *
 * Determines recovery capabilities based on trusted sources.
 * Priority: Registry > Discovery > Headers > NONE
 */
import { SellerCapabilities, Operation } from './types.js';
export interface CapabilitySource {
    getCapability(url: string): Promise<SellerCapabilities | null>;
}
export declare class SellerCapabilityResolver {
    private readonly sources;
    constructor(sources?: CapabilitySource[]);
    /**
     * Resolve seller capability and snapshot it in the operation.
     * Once snapped, capability is immutable during the operation lifecycle.
     */
    resolveAndSnapshot(operation: Operation, responseHeaders?: Headers): Promise<void>;
}
//# sourceMappingURL=capability-resolver.d.ts.map