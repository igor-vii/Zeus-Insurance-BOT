/**
 * F-101 regression tests (external audit 2026-10-25, Major).
 *
 * createIntentWithNonce() must be ATOMIC for every EvidenceStore
 * implementation: a failure while creating the payment intent must roll back
 * the nonce reservation created in the same call, leaving no orphan nonce
 * that permanently diverges from the intent table.
 *
 * The PostgreSQL store is covered by tests/durable-storage.test.ts
 * ("AB-F101"); this suite pins the same invariant on the in-memory store so
 * dev/test semantics cannot drift from production semantics again.
 */

import { describe, it, expect } from '@jest/globals';
import { InMemoryEvidenceStore } from '../src/store/in-memory-store';
import type { DurablePaymentIntent } from '../src/core/types';

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

describe('F-101: InMemoryEvidenceStore.createIntentWithNonce atomicity', () => {
  it('reserves the nonce and creates the intent together (happy path)', async () => {
    const store = new InMemoryEvidenceStore();
    const intent = makeIntent();

    await store.createIntentWithNonce(intent, intent.authorizer);

    const nonceRecord = await store.getNonce(intent.nonce);
    expect(nonceRecord).not.toBeNull();
    expect(nonceRecord!.status).toBe('RESERVED');
    expect(nonceRecord!.operationId).toBe(intent.operationId);
    expect(await store.getPaymentIntentByOperationId(intent.operationId)).not.toBeNull();
  });

  it('rolls back the nonce reservation when the intent insert fails (duplicate operationId)', async () => {
    const store = new InMemoryEvidenceStore();
    const now = Date.now();
    const operationId = `op-dup-${now}`;

    const first = makeIntent({ operationId });
    await store.createIntentWithNonce(first, first.authorizer);

    // Same operationId, fresh nonce → intent creation must fail...
    const conflicting = makeIntent({ operationId });
    await expect(
      store.createIntentWithNonce(conflicting, conflicting.authorizer),
    ).rejects.toThrow('DUPLICATE_OPERATION_ID');

    // ...and the just-created nonce reservation must NOT survive as an orphan.
    expect(await store.getNonce(conflicting.nonce)).toBeNull();

    // The nonce value is free again for a later operation.
    await expect(
      store.reserveNonce(conflicting.nonce, `op-other-${now}`, '0xOther'),
    ).resolves.toBeUndefined();
  });

  it('rejects a pre-reserved nonce with NONCE_ALREADY_RESERVED and creates NO intent', async () => {
    const store = new InMemoryEvidenceStore();
    const now = Date.now();
    const holderOp = `op-holder-${now}`;

    const preNonce = `0xpre${now}`;
    await store.reserveNonce(preNonce, holderOp, '0xHolder');

    const intent = makeIntent({ nonce: preNonce });
    await expect(store.createIntentWithNonce(intent, intent.authorizer)).rejects.toThrow(
      'NONCE_ALREADY_RESERVED',
    );
    expect(await store.getPaymentIntentByOperationId(intent.operationId)).toBeNull();
    // Holder's reservation is untouched.
    const held = await store.getNonce(preNonce);
    expect(held!.operationId).toBe(holderOp);
  });

  it('creates the intent alone when the intent carries no nonce', async () => {
    const store = new InMemoryEvidenceStore();
    const intent = makeIntent({ nonce: '' });

    await store.createIntentWithNonce(intent, intent.authorizer);

    expect(await store.getPaymentIntentByOperationId(intent.operationId)).not.toBeNull();
  });
});
