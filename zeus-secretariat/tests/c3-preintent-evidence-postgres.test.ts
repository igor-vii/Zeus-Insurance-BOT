import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@workspace/db/schema';
import { PostgresEvidenceStore } from '../../lib/db/src/secretariat/postgres-store';
import type { EvidenceRecord } from '../src/core/types';

const databaseUrl = process.env.DATABASE_URL;
const dbDescribe = databaseUrl ? describe : describe.skip;

dbDescribe('PostgresEvidenceStore pre-intent evidence (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  const store = new PostgresEvidenceStore(db);
  const operationId = `test-pre-intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    // Fail explicitly if the migration has not been applied to the test database.
    await pool.query('SELECT 1 FROM pre_intent_evidence LIMIT 0');
    await pool.query('SELECT 1 FROM payment_intents LIMIT 0');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pre_intent_evidence WHERE operation_id = $1', [operationId]).catch(() => undefined);
    await pool.end();
  });

  it('persists and restores early evidence without a payment-intent foreign key', async () => {
    const later: EvidenceRecord = {
      operationId,
      phase: 'DISCOVERY',
      timestamp: Date.now() + 10,
      event: 'DISCOVERY_ERROR',
      payload: { error: 'seller unavailable' },
    };
    const earlier: EvidenceRecord = {
      operationId,
      phase: 'FINAL',
      timestamp: Date.now(),
      event: 'OPERATION_CREATED',
      payload: { requestId: 'test-request' },
    };

    await store.append(later);
    await store.append(earlier);

    const restored = await store.getEvidence(operationId);
    expect(restored.map((record) => record.event)).toEqual([
      'OPERATION_CREATED',
      'DISCOVERY_ERROR',
    ]);
    expect(restored.map((record) => record.timestamp)).toEqual(
      [...restored.map((record) => record.timestamp)].sort((a, b) => a - b),
    );
  });
});
