/**
 * A1-R D-2 — saveOperation() dedup-guard regression (sequential semantics).
 *
 * Role: the NORMAL PASSING GATE. It verifies the REPAIRED production code
 * (postgres-store.ts saveOperation() QueryResult normalization) end-to-end
 * against a live disposable PostgreSQL server:
 *   1. Repeated saves of an operation whose last evidence record is already
 *      durable do NOT append a duplicate observation.
 *   2. A genuinely NEW tail record IS appended exactly once.
 *   3. Saving that same tail again appends NOTHING further.
 *
 * The historical defect-reproduction diagnostic lives separately in
 * a1r-d1-gate-driver-shape.test.ts (driver-faithful double proving the broken
 * Array.isArray guard pre-fix). Do not merge those roles: this file must stay
 * green on the fixed code; the gate file documents the unfixed behavior.
 *
 * CONCURRENCY IS DELIBERATELY NOT TESTED HERE. The repaired guard is still an
 * unlocked check-then-append with no transaction and no UNIQUE constraint on
 * JSONB elements, so concurrent identical saves may duplicate. No concurrency
 * guarantee is claimed or asserted by this suite.
 *
 * Uses the REAL PostgresEvidenceStore over drizzle node-postgres against
 * DATABASE_URL. No mocking of the method under test. Skips (never fakes) when
 * DATABASE_URL is unset.
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

const recA = (opId: string) => ({
  operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_500,
  event: "STATE_TRANSITION", payload: { from: "SETTLED", to: "EXECUTION_PENDING" },
});
const recB = (opId: string) => ({
  operationId: opId, phase: "EXECUTION", timestamp: 1_700_000_000_900,
  event: "STATE_TRANSITION", payload: { from: "EXECUTION_PENDING", to: "EXECUTION_CONFIRMED" },
});

describeIfDb("D-2 dedup-guard regression (REAL PostgreSQL, sequential)", () => {
  beforeAll(async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const client = await freshClient();
    // Isolation: touch ONLY our own per-suite rows; never truncate shared tables.
    await client.query(
      `DELETE FROM payment_intents WHERE operation_id LIKE 'op-a1rd2%'`,
    );
    h = { db: drizzle(client), client };
  });

  afterAll(async () => {
    if (h?.client) {
      try {
        await h.client.query(
          `DELETE FROM payment_intents WHERE operation_id LIKE 'op-a1rd2%'`,
        );
      } finally {
        await h.client.end();
      }
    }
  });

  async function seedIntent(opId: string, obs: unknown[]) {
    const now = new Date(1_700_000_000_000);
    await h!.client.query(
      `INSERT INTO payment_intents (
         payment_intent_id, operation_id, request_id, client_id,
         target, method, payment_policy, authorizer, pay_to, value, asset, network,
         nonce, valid_after, valid_before, payment_payload, payment_payload_hash,
         settlement_state, submit_attempt_at, settled_at, reconciliation_observations,
         probe_count, version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,'1',$9,$10,$11,0,9999999999,$12,$13,
         'SETTLED',$14,$14,$15::jsonb,0,1,$14,$14)
       ON CONFLICT (payment_intent_id) DO UPDATE SET reconciliation_observations = EXCLUDED.reconciliation_observations`,
      [
        `pi-${opId}`, opId, `req-${opId}`, `client-${opId}`,
        "https://seller.example/api", "POST", "0xa", "0xb", "0xc", "base-sepolia",
        "0xn", "p", "h", now, JSON.stringify(obs),
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
    const opId = "op-a1rd2-dedup";
    await seedIntent(opId, [recA(opId)]);
    const store = new PostgresEvidenceStore(h!.db as never);

    await store.saveOperation(baseOp(opId, [recA(opId)]));
    await store.saveOperation(baseOp(opId, [recA(opId)]));
    await store.saveOperation(baseOp(opId, [recA(opId)]));

    const obs = await readObs(opId);
    // Pre-fix on real PG this produced 4 entries (guard misread {rows:[...]}
    // as an empty array, so present was always undefined). Post-fix: 1.
    expect(obs).toHaveLength(1);
    expect(obs[0]).toEqual(recA(opId));
  });

  it("a genuinely new last record is appended exactly once, then deduped on retry", async () => {
    const opId = "op-a1rd2-tail";
    await seedIntent(opId, []);
    const store = new PostgresEvidenceStore(h!.db as never);

    await store.saveOperation(baseOp(opId, [recA(opId)])); // fresh append
    let obs = await readObs(opId);
    expect(obs).toHaveLength(1);

    await store.saveOperation(baseOp(opId, [recA(opId), recB(opId)])); // new tail → +1
    obs = await readObs(opId);
    expect(obs).toHaveLength(2);

    await store.saveOperation(baseOp(opId, [recA(opId), recB(opId)])); // same tail → +0
    obs = await readObs(opId);
    expect(obs).toHaveLength(2);
    expect(obs[1]).toEqual(recB(opId));
  });
});
