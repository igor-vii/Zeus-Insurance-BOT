/**
 * A1-R D-2 — saveOperation() dedup-guard regression (real PostgreSQL).
 *
 * Proves the repaired behavior end-to-end against a live PG server:
 *   1. Repeated saves of an operation whose last evidence record is already
 *      durable do NOT append duplicate STATE_TRANSITION observations.
 *   2. A genuinely NEW record IS appended exactly once.
 *   3. Concurrent identical saves on real PG do not duplicate (best-effort:
 *      reports what actually happens; no fabricated guarantees).
 *
 * Uses the REAL PostgresEvidenceStore over drizzle node-postgres. No mocking
 * of the method under test. Skips (never fakes) when DATABASE_URL is unset.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
// Real production store class via static import (bypasses @workspace/db barrel).
import { PostgresEvidenceStore } from "../../lib/db/src/secretariat/postgres-store";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

interface Harness {
  db: any;
  client: any;
}

let h: Harness | null = null;

async function freshClient(): Promise<any> {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
  await client.connect();
  return client;
}

function baseOp(opId: string, evidence: unknown[]) {
  return {
    operationId: opId,
    requestId: `req-${opId}`,
    clientId: `client-${opId}`,
    target: "https://seller.example/api",
    method: "POST",
    paymentPolicy: {},
    paymentState: "SETTLED",
    executionState: "PENDING",
    deliveryState: "PENDING",
    currentState: "EXECUTION_PENDING",
    timestamps: { createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
    evidence,
  } as any;
}

const recA = () => ({
  operationId: "op-ddup", phase: "EXECUTION", timestamp: 1_700_000_000_500,
  event: "STATE_TRANSITION", payload: { from: "SETTLED", to: "EXECUTION_PENDING" },
});
const recB = () => ({
  operationId: "op-ddup", phase: "EXECUTION", timestamp: 1_700_000_000_900,
  event: "STATE_TRANSITION", payload: { from: "EXECUTION_PENDING", to: "EXECUTION_CONFIRMED" },
});

describeIfDb("D-2 dedup-guard regression (REAL PostgreSQL)", () => {
  beforeAll(async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const client = await freshClient();
    // Isolated per-run rows only for OUR op ids; truncate nothing global.
    await client.query(
      `DELETE FROM payment_intents WHERE operation_id LIKE 'op-ddup%' OR operation_id LIKE 'op-conc%'`,
    );
    h = { db: drizzle(client), client };
  });

  afterAll(async () => {
    if (h?.client) await h.client.end();
  });

  async function seedIntent(opId: string, obs: unknown[]) {
    const now = new Date(1_700_000_000_000);
    await h!.client.query(
      `INSERT INTO payment_intents (
         payment_intent_id, operation_id, request_id, client_id,
         target, method, payment_policy, authorizer, pay_to, value, asset, network,
         nonce, valid_after, valid_before, payment_payload, payment_payload_hash,
         settlement_state, submit_attempt_at, reconciliation_observations,
         probe_count, version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,'1',$9,$10,$11,0,9999999999,$12,$13,
         'SETTLED',$14,$15::jsonb,0,1,$16,$16)
       ON CONFLICT (payment_intent_id) DO NOTHING`,
      [
        `pi-${opId}`, opId, `req-${opId}`, `client-${opId}`,
        "https://seller.example/api", "POST", "0xa", "0xb", "0xc", "base-sepolia",
        "0xn", "p", "h", now, JSON.stringify(obs), now,
      ],
    );
  }

  async function readObs(opId: string): Promise<unknown[]> {
    const r = await h!.client.query(
      `SELECT reconciliation_observations AS obs FROM payment_intents WHERE operation_id = $1`,
      [opId],
    );
    return (r.rows[0]?.obs ?? []) as unknown[];
  }

  it("repeated saveOperation with an already-present last record appends NO duplicates", async () => {
    await seedIntent("op-ddup", [recA()]);
    const store = new PostgresEvidenceStore(h!.db as never);

    await store.saveOperation(baseOp("op-ddup", [recA()]));
    await store.saveOperation(baseOp("op-ddup", [recA()]));
    await store.saveOperation(baseOp("op-ddup", [recA()]));

    const obs = await readObs("op-ddup");
    // Pre-fix on real PG this produced 4 entries (guard misread {rows}).
    expect(obs).toHaveLength(1);
    expect(obs[0]).toEqual(recA());
  });

  it("a genuinely new last record is appended exactly once, then deduped on retry", async () => {
    await seedIntent("op-ddup-b", []);
    const store = new PostgresEvidenceStore(h!.db as never);

    await store.saveOperation(baseOp("op-ddup-b", [recA()])); // fresh append
    let obs = await readObs("op-ddup-b");
    expect(obs).toHaveLength(1);

    await store.saveOperation(baseOp("op-ddup-b", [recA(), recB()])); // new tail → +1
    obs = await readObs("op-ddup-b");
    expect(obs).toHaveLength(2);

    await store.saveOperation(baseOp("op-ddup-b", [recA(), recB()])); // same tail → +0
    obs = await readObs("op-ddup-b");
    expect(obs).toHaveLength(2);
  });

  it("concurrent identical saves on real PG: report actual duplication outcome", async () => {
    await seedIntent("op-conc", []);
    const store = new PostgresEvidenceStore(h!.db as never);
    const op = baseOp("op-conc", [recA()]);

    // Two separate connections racing the guard+append pair (no transaction /
    // no unique constraint exists for this JSONB element). This test REPORTS
    // reality; it does not assert a guarantee the schema cannot provide.
    const c2 = await freshClient();
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const store2 = new PostgresEvidenceStore(drizzle(c2) as never);

    await Promise.all([store.saveOperation(op), store2.saveOperation(op)]);
    const obs = await readObs("op-conc");
    await c2.end();

    // Observed truth at this HEAD: guard is check-then-insert without lock, so
    // a race MAY yield 2 identical entries. We assert the weaker, honest bound:
    // at most one append per call, and every entry is the intended record.
    expect(obs.length).toBeGreaterThanOrEqual(1);
    expect(obs.length).toBeLessThanOrEqual(2);
    for (const e of obs) expect(e).toEqual(recA());
    if (obs.length === 2) {
      // Documenting the residual race honestly (NOT claimed fixed here).
      console.warn("CONCURRENT RACE OBSERVED: duplicate JSONB entry from unlocked check-then-append");
    }
  });
});
