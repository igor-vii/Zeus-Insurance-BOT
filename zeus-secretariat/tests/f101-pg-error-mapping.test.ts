/**
 * F-101 fix — error-mapping unit tests for PostgresEvidenceStore.createIntentWithNonce.
 *
 * The fix routes BOTH writes (nonce reservation + intent insert) through ONE
 * drizzle transaction and maps the surviving 23505 error back to the canonical
 * failure by constraint name:
 *   nonce_registry_pkey                          → NONCE_ALREADY_RESERVED
 *   pi_operation_id_unique / pi_client_request_unique /
 *   payment_intents_pkey                         → DUPLICATE_OPERATION_ID
 *   (no constraint exposed)                      → probe the registry, then map
 *
 * These tests use a fake drizzle `NodePgDatabase` so they run WITHOUT a live
 * PostgreSQL connection. The live-transaction semantics themselves are pinned
 * by tests/durable-storage.test.ts ("AB-F101") on the PG stand.
 */

import { describe, it, expect } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import type { PostgresEvidenceStore as PostgresEvidenceStoreType } from '@workspace/db';
import type { DurablePaymentIntent } from '../src/core/types';

const HAS_DB = !!process.env['DATABASE_URL'];
const describeIfDb = HAS_DB ? describe : describe.skip;

/** Wrap a raw PG error the way drizzle's node-postgres driver does. */
function drizzleWrap(pgError: { code: string; constraint?: string; detail?: string }): Error {
  const err: any = new Error(`drizzle error (${pgError.code})`);
  err.cause = pgError;
  return err;
}

interface FakeDbOptions {
  /** Table whose INSERT the fake makes fail; undefined → no failure. */
  failingTable?: 'nonce_registry' | 'payment_intents';
  /** PG `constraint` field on the failure; null → driver hides it (code 23505 only). */
  constraint?: string | null;
  /** Rows returned by the fake select() probe (getNonce fallback path). */
  nonceProbeRows?: unknown[];
}

function makeFakeDb(opts: FakeDbOptions) {
  const calls: { phase: string; table: string }[] = [];
  let phase = 'outside-tx';

  const executeInsert = (table: unknown) => {
    const name = getTableName(table as never);
    return () => {
      calls.push({ phase, table: name });
      if (name === opts.failingTable) {
        return Promise.reject(
          drizzleWrap({ code: '23505', constraint: opts.constraint ?? undefined }),
        );
      }
      return Promise.resolve(undefined);
    };
  };

  const txInsert = (table: unknown) => ({ values: executeInsert(table) });
  const dbInsert = (table: unknown) => ({ values: executeInsert(table) });

  const db: any = {
    transaction: async (fn: (tx: any) => Promise<void>) => {
      const prev = phase;
      phase = 'in-tx';
      try {
        await fn({ insert: txInsert });
      } finally {
        phase = prev;
      }
    },
    insert: dbInsert,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => opts.nonceProbeRows ?? [],
        }),
      }),
    }),
  };

  return { db, calls };
}

function makeIntent(overrides: Partial<DurablePaymentIntent> = {}): DurablePaymentIntent {
  const now = Date.now();
  return {
    paymentIntentId: `intent-${now}-${Math.random().toString(36).slice(2)}`,
    operationId: `op-${now}-${Math.random().toString(36).slice(2)}`,
    settlementState: 'AUTHORIZED',
    authorizer: '0xPayer',
    payTo: '0xPayee',
    value: '1000000',
    asset: '0xUSDC',
    network: 'base-sepolia',
    nonce: `0x${now.toString(16)}${Math.random().toString(16).slice(2, 10)}`,
    validAfter: Math.floor(now / 1000) - 3600,
    validBefore: Math.floor(now / 1000) + 3600,
    paymentPayload: 'base64payload',
    paymentPayloadHash: '0xhash',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Shape a real nonce_registry row as drizzle returns it (dates as Date). */
function nonceRow(nonce: string, operationId: string) {
  return { nonce, operationId, status: 'RESERVED', payer: '0xPayer', createdAt: new Date(), updatedAt: new Date() };
}

describeIfDb('F-101: PostgresEvidenceStore.createIntentWithNonce error mapping', () => {
  it('maps pi_operation_id_unique to DUPLICATE_OPERATION_ID and issues BOTH inserts inside ONE transaction', async () => {
    const dbMod = await import('@workspace/db');
    const { db, calls } = makeFakeDb({ failingTable: 'payment_intents', constraint: 'pi_operation_id_unique' });
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent();

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toThrow(
      'DUPLICATE_OPERATION_ID',
    );
    // Atomic contract: nonce reservation + intent insert issued against the
    // SAME transaction, in that order.
    expect(calls.map((c) => `${c.phase}:${c.table}`)).toEqual([
      'in-tx:nonce_registry',
      'in-tx:payment_intents',
    ]);
  });

  it('maps nonce_registry_pkey to NONCE_ALREADY_RESERVED and never reaches the intent insert', async () => {
    const dbMod = await import('@workspace/db');
    const { db, calls } = makeFakeDb({ failingTable: 'nonce_registry', constraint: 'nonce_registry_pkey' });
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent();

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toThrow(
      'NONCE_ALREADY_RESERVED',
    );
    expect(calls.map((c) => c.table)).toEqual(['nonce_registry']);
  });

  it('maps pi_client_request_unique to DUPLICATE_OPERATION_ID (constraint name is authoritative)', async () => {
    const dbMod = await import('@workspace/db');
    const { db } = makeFakeDb({
      failingTable: 'payment_intents',
      constraint: 'pi_client_request_unique',
      nonceProbeRows: [],
    });
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent();

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toThrow(
      'DUPLICATE_OPERATION_ID',
    );
  });

  it('falls back to a registry probe when the driver hides the constraint name (nonce clash)', async () => {
    // Realistic shape: a PREVIOUSLY COMMITTED nonce row exists; the nonce
    // insert fails with 23505 but the driver drops the constraint field; the
    // transaction rolls back; the post-rollback probe finds the committed row.
    const dbMod = await import('@workspace/db');
    const { db, calls } = makeFakeDb({
      failingTable: 'nonce_registry',
      constraint: null,
      nonceProbeRows: [nonceRow('pre-existing', 'older-op')],
    });
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent();

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toThrow(
      'NONCE_ALREADY_RESERVED',
    );
    expect(calls.map((c) => c.table)).toEqual(['nonce_registry']);
  });

  it('falls back to DUPLICATE_OPERATION_ID when the constraint is hidden and the registry is clean', async () => {
    const dbMod = await import('@workspace/db');
    const { db } = makeFakeDb({
      failingTable: 'payment_intents',
      constraint: null,
      nonceProbeRows: [],
    });
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent();

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toThrow(
      'DUPLICATE_OPERATION_ID',
    );
  });

  it('rethrows non-23505 errors untouched (no masking)', async () => {
    const dbMod = await import('@workspace/db');
    const calls: string[] = [];
    const boom = new Error('connection reset');
    const db: any = {
      transaction: async (fn: (tx: any) => Promise<void>) => {
        await fn({
          insert: (table: unknown) => ({
            values: () => {
              calls.push(getTableName(table as never));
              return boom.code === undefined ? Promise.reject(boom) : Promise.resolve();
            },
          }),
        });
      },
    };
    // Simulate a non-23505 failure on the intent insert.
    db.transaction = async (fn: (tx: any) => Promise<void>) => {
      await fn({
        insert: (table: unknown) => ({
          values: () => {
            calls.push(getTableName(table as never));
            if (getTableName(table as never) === 'payment_intents') return Promise.reject(boom);
            return Promise.resolve();
          },
        }),
      });
    };
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent();

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toBe(boom);
  });

  it('skips the nonce insert entirely when the intent carries no nonce', async () => {
    const dbMod = await import('@workspace/db');
    const { db, calls } = makeFakeDb({});
    const store = new dbMod.PostgresEvidenceStore(db) as PostgresEvidenceStoreType;
    const intent = makeIntent({ nonce: '' });

    await expect(store.createIntentWithNonce(intent, intent.authorizer)).resolves.toBeUndefined();
    expect(calls.map((c) => c.table)).toEqual(['payment_intents']);
  });
});
