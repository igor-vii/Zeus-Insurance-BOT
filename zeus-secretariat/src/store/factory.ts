/**
 * BLOCK 8 R1: Shared Store Factory
 *
 * Production composition primitive for creating shared durable stores.
 * Accepts an existing DB dependency — does NOT create its own connection pool.
 *
 * Usage:
 *   import { db } from "@workspace/db";
 *   import { createSharedStores } from "@workspace/zeus-secretariat";
 *   const stores = createSharedStores(db);
 *   // Pass stores.evidenceStore to StateMachine, ReconciliationEngine, Worker, etc.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PostgresEvidenceStore } from './postgres-store';
import { PostgresExecutionStore } from './postgres-execution-store';

/**
 * Shared store instances for production composition.
 * All consumers should receive the SAME instances to ensure consistency.
 */
export interface SharedStores {
  readonly evidenceStore: PostgresEvidenceStore;
  readonly executionStore: PostgresExecutionStore;
}

/**
 * Create shared durable stores using an existing DB dependency.
 *
 * This factory does NOT:
 * - Create a new DB connection pool
 * - Read environment variables
 * - Start background services or workers
 * - Perform recovery or reconciliation
 * - Create StateMachine or ReconciliationEngine
 *
 * It is a pure construction primitive. The caller owns lifecycle management.
 *
 * @param db - Existing Drizzle database instance from @workspace/db
 * @returns SharedStores with evidenceStore and executionStore
 */
export function createSharedStores(db: NodePgDatabase): SharedStores {
  if (!db) {
    throw new Error(
      "createSharedStores requires a db instance. " +
      "Pass the existing @workspace/db instance, do not omit this parameter."
    );
  }

  return {
    evidenceStore: new PostgresEvidenceStore(db),
    executionStore: new PostgresExecutionStore(db),
  };
}
