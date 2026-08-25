/**
 * Zeus Secretariat V0 - In-Memory Evidence Store (MVP Implementation)
 * 
 * For production, replace with PostgreSQL/SQLite implementation.
 * This is a minimal implementation for testing and development.
 */

import {
  EvidenceStore,
  EvidenceRecord,
  Operation,
  OperationStatus,
} from '../core/types';

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly operations: Map<string, Operation> = new Map();
  private readonly evidence: Map<string, EvidenceRecord[]> = new Map();

  async append(record: EvidenceRecord): Promise<void> {
    const records = this.evidence.get(record.operationId) ?? [];
    records.push(record);
    this.evidence.set(record.operationId, records);
  }

  async getOperation(operationId: string): Promise<Operation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async saveOperation(operation: Operation): Promise<void> {
    this.operations.set(operation.operationId, operation);
  }

  async getEvidence(operationId: string): Promise<EvidenceRecord[]> {
    return this.evidence.get(operationId) ?? [];
  }

  async getOperationsByStatus(status: OperationStatus): Promise<Operation[]> {
    const result: Operation[] = [];
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
  clear(): void {
    this.operations.clear();
    this.evidence.clear();
  }

  /**
   * Get all operations - useful for debugging
   */
  getAllOperations(): Operation[] {
    return Array.from(this.operations.values());
  }
}
