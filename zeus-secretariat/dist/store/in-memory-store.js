"use strict";
/**
 * Zeus Secretariat V0 - In-Memory Evidence Store (MVP Implementation)
 *
 * For production, replace with PostgreSQL/SQLite implementation.
 * This is a minimal implementation for testing and development.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryEvidenceStore = void 0;
class InMemoryEvidenceStore {
    operations = new Map();
    evidence = new Map();
    async append(record) {
        const records = this.evidence.get(record.operationId) ?? [];
        records.push(record);
        this.evidence.set(record.operationId, records);
    }
    async getOperation(operationId) {
        return this.operations.get(operationId) ?? null;
    }
    async saveOperation(operation) {
        this.operations.set(operation.operationId, operation);
    }
    async getEvidence(operationId) {
        return this.evidence.get(operationId) ?? [];
    }
    async getOperationsByStatus(status) {
        const result = [];
        for (const operation of this.operations.values()) {
            if (operation.currentState === status) {
                result.push(operation);
            }
        }
        return result;
    }
    /**
     * Clear all data - useful for testing
     */
    clear() {
        this.operations.clear();
        this.evidence.clear();
    }
    /**
     * Get all operations - useful for debugging
     */
    getAllOperations() {
        return Array.from(this.operations.values());
    }
}
exports.InMemoryEvidenceStore = InMemoryEvidenceStore;
//# sourceMappingURL=in-memory-store.js.map