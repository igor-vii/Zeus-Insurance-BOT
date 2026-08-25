/**
 * Zeus Secretariat V0 - In-Memory Evidence Store (MVP Implementation)
 *
 * For production, replace with PostgreSQL/SQLite implementation.
 * This is a minimal implementation for testing and development.
 */
import { EvidenceStore, EvidenceRecord, Operation, OperationStatus } from '../core/types';
export declare class InMemoryEvidenceStore implements EvidenceStore {
    private readonly operations;
    private readonly evidence;
    append(record: EvidenceRecord): Promise<void>;
    getOperation(operationId: string): Promise<Operation | null>;
    saveOperation(operation: Operation): Promise<void>;
    getEvidence(operationId: string): Promise<EvidenceRecord[]>;
    getOperationsByStatus(status: OperationStatus): Promise<Operation[]>;
    /**
     * Clear all data - useful for testing
     */
    clear(): void;
    /**
     * Get all operations - useful for debugging
     */
    getAllOperations(): Operation[];
}
//# sourceMappingURL=in-memory-store.d.ts.map