/**
 * A1-R D-1 Design-A pre-implementation gate — TESTED probe.
 *
 * Purpose: empirically establish the ACTUAL result shape of db.execute() under
 * drizzle node-postgres for the two query shapes used by
 * PostgresEvidenceStore.saveOperation()'s dedup guard (postgres-store.ts L626-634):
 *   1. SELECT EXISTS(...) AS present
 *   2. UPDATE ... RETURNING job_id-style / plain UPDATE
 * and, additionally, what a genuine QueryResult looks like for the attempt read.
 *
 * This is NOT a mock: it uses the real pg client + real drizzle node-postgres
 * wrapper against an isolated disposable PostgreSQL DB via DATABASE_URL.
 * Skipped (never faked) when DATABASE_URL is unset.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { sql } from "drizzle-orm";
// Static import of the REAL production store class (bypasses the @workspace/db
// barrel, which eagerly constructs a pg pool and throws without DATABASE_URL).
// The method under test (saveOperation) is NOT mocked.
import { PostgresEvidenceStore } from "../../lib/db/src/secretariat/postgres-store";

const describeIfDb = process.env["DATABASE_URL"] ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Driver-faithful probe double.
//
// This is NOT the method under test (saveOperation runs its REAL production
// code against this fake). It faithfully emulates the genuine drizzle
// node-postgres contract that was empirically established at HEAD c991e71 in
// Stage 2A ("driver-shape probe" test, real PG): db.execute() returns a
// QueryResult OBJECT { rows: [...], rowCount }, never a bare array — see
// postgres-store.ts D-2b comment and postgres-execution-store.ts REPAIR-3K.
// All other branches return [] exactly like the pre-existing FakeDb in
// a1-execution-fsm.test.ts.
// ---------------------------------------------------------------------------

class PgFaithfulDb {
  intents = new Map<string, any>();
  /** When true, EXISTS guard answers truthfully (true driver behavior). */
  truthfulExists = true;

  seedIntent(opId: string, obs: unknown[] = []) {
    const now = new Date(1_700_000_000_000);
    this.intents.set(opId, {
      paymentIntentId: `pi-${opId}`,
      operationId: opId,
      requestId: `req-${opId}`, clientId: `client-${opId}`,
      target: "https://seller.example/api", method: "POST", paymentPolicy: {},
      authorizer: "0xa", payTo: "0xb", value: "1", asset: "0xc", network: "base-sepolia",
      nonce: "0xn", validAfter: 0, validBefore: 9999999999,
      paymentPayload: "p", paymentPayloadHash: "h",
      settlementState: "SETTLED", txHash: null, facilitatorHttpStatus: null,
      facilitatorResponseBody: null, errorReason: null,
      submitAttemptAt: now, settledAt: now, notSettledAt: null,
      settledEvidenceBundle: null, notSettledEvidenceBundle: null,
      reconciliationObservations: obs, nextProbeAt: null, probeCount: 0, version: 1,
      createdAt: now, updatedAt: now,
    });
  }

  select() {
    return {
      from: (_t: unknown) => ({
        where: (clause: unknown) => ({
          limit: (_n: number) => {
            const row = [...this.intents.values()].find((r) => containsOpId(clause, r.operationId));
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    };
  }

  update(_t: unknown) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          for (const r of this.intents.values()) {
            if (containsOpId(clause, r.operationId)) Object.assign(r, values);
          }
          return Promise.resolve();
        },
      }),
    };
  }

  /** Emulates real QueryResult shape for every raw execute(). */
  async execute(query: unknown): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sqlText(query);
    if (text.includes("jsonb_array_elements")) {
      // SELECT EXISTS(... WHERE e = <record>::jsonb) AS present
      // observations array param comes FIRST in the query text; the record
      // param is the one bound right before "= ...::jsonb" inside EXISTS.
      const jsonStrs = [...text.matchAll(/'((?:\[|\{)[^']*)'::jsonb/g)].map((m) => m[1]);
      const existingStr = jsonStrs.find((x) => x.startsWith("[")) ?? "[]";
      const recStr = jsonStrs.find((x) => x.startsWith("{"));
      let present = false;
      try {
        const existing = JSON.parse(existingStr);
        const record = recStr ? JSON.parse(recStr) : null;
        present = record !== null && existing.some((e: unknown) => JSON.stringify(e) === JSON.stringify(record));
      } catch {
        present = false;
      }
      if (!this.truthfulExists) present = false; // simulate the broken Array.isArray read path separately
      return { rows: [{ present }], rowCount: 1 };
    }
    if (text.includes("UPDATE payment_intents") && text.includes("reconciliation_observations")) {
      const pid = text.match(/WHERE payment_intent_id = '([^']+)'/)?.[1];
      const rec = text.match(/\|\| '(\{.*?\})'::jsonb/s)?.[1];
      const row = [...this.intents.values()].find((r) => r.paymentIntentId === pid);
      if (row && rec) {
        // Real PG: jsonb_array || jsonb_object yields [object]. Same as the
        // pre-existing FakeDb behavior (a1-execution-fsm.test.ts arr.push()).
        const arr = (row.reconciliationObservations ?? []) as unknown[];
        arr.push(JSON.parse(rec));
        row.reconciliationObservations = arr;
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM execution_attempts")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function containsOpId(clause: unknown, opId: string): boolean {
  const q = clause as { params?: unknown[]; queryChunks?: unknown[] };
  const params = q.params ?? q.queryChunks ?? [];
  return params.some((p) => (p as { value?: unknown })?.value === opId || p === opId);
}

function sqlText(query: unknown): string {
  const q = query as { queryChunks?: Array<string | { value?: unknown }> };
  if (Array.isArray(q.queryChunks)) {
    return q.queryChunks.map((c) => (typeof c === "string" ? c : `'${String((c as any)?.value)}'`)).join("");
  }
  return String((query as any)?.text ?? "");
}

describeIfDb("D-1 gate: actual db.execute() result shape (real PG)", () => {
  let db: any;

  beforeAll(async () => {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const client = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
    await client.connect();
    db = drizzle(client);
    (globalThis as any).__d1gateClient = client;
  });

  afterAll(async () => {
    const client = (globalThis as any).__d1gateClient;
    if (client) await client.end();
  });

  it("SELECT EXISTS returns a non-array object with .rows[0].present", async () => {
    const q = sql`SELECT EXISTS (SELECT 1 FROM jsonb_array_elements('[]'::jsonb) AS e WHERE e = '{}'::jsonb) AS present`;
    const raw = await db.execute(q);
    // THE decisive assertion for the saveOperation dedup guard analysis:
    expect(Array.isArray(raw)).toBe(false);
    expect(Array.isArray((raw as any).rows)).toBe(true);
    expect((raw as any).rows[0]).toHaveProperty("present");
    expect((raw as any).rows[0].present).toBe(false);
    // And prove the production guard expression misreads it:
    const guardStyle = (Array.isArray(raw) ? raw : [])[0] as { present?: boolean } | undefined;
    expect(guardStyle).toBeUndefined(); // ⇒ guard can never see present=true on real PG
  });

  it("EXISTS=true case is likewise only visible via .rows", async () => {
    const q = sql`SELECT EXISTS (SELECT 1 FROM jsonb_array_elements('[{"a":1}]'::jsonb) AS e WHERE e = '{"a":1}'::jsonb) AS present`;
    const raw = await db.execute(q);
    expect((raw as any).rows[0].present).toBe(true);
    const guardStyle = (Array.isArray(raw) ? raw : [])[0];
    expect(guardStyle).toBeUndefined();
  });

  it("UPDATE ... || record::jsonb executes but reports rowCount, not array rows", async () => {
    // No table write to business tables — use a throwaway CTE-free scalar UPDATE
    // against a temp table created inside this same connection session.
    await db.execute(sql`CREATE TEMP TABLE d1gate_obs (id int, obs jsonb)`);
    await db.execute(sql`INSERT INTO d1gate_obs VALUES (1, '[]'::jsonb)`);
    const rec = JSON.stringify({ event: "STATE_TRANSITION", timestamp: 1 });
    const raw = await db.execute(sql`
      UPDATE d1gate_obs
      SET obs = COALESCE(obs, '[]'::jsonb) || ${rec}::jsonb
      WHERE id = 1
    `);
    expect(Array.isArray(raw)).toBe(false);
    expect((raw as any).rowCount).toBe(1);
    const sel = await db.execute(sql`SELECT obs FROM d1gate_obs WHERE id = 1`);
    const arr = (sel as any).rows[0].obs;
    expect(arr).toHaveLength(1); // single append happened
    // Second identical append WITHOUT any working dedup guard duplicates:
    await db.execute(sql`
      UPDATE d1gate_obs SET obs = COALESCE(obs, '[]'::jsonb) || ${rec}::jsonb WHERE id = 1
    `);
    const sel2 = await db.execute(sql`SELECT obs FROM d1gate_obs WHERE id = 1`);
    expect((sel2 as any).rows[0].obs).toHaveLength(2); // PROOF: no protection without guard
  });
});

// ===========================================================================
// Gate tests that run WITHOUT a PG server: they execute the REAL production
// saveOperation() code against a driver-faithful QueryResult double (shape
// empirically established on real PG in Stage 2A at HEAD c991e71). These
// prove/disprove the dedup-guard claims deterministically; the real-PG suite
// above remains the authoritative confirmation when DATABASE_URL is present.
// ===========================================================================

describe("D-1 gate: saveOperation dedup guard under driver-faithful result shape", () => {
  // Direct module import (bypasses @workspace/db barrel, which eagerly
  // constructs a pg pool and throws without DATABASE_URL). This loads the
  // REAL production PostgresEvidenceStore class — no mocking of the method
  // under test.

  const baseOp = (opId: string, evidence: unknown[]) => ({
    operationId: opId,
    requestId: `req-${opId}`,
    clientId: `c-${opId}`,
    target: "https://seller.example/api",
    method: "POST",
    paymentPolicy: {},
    paymentState: "SETTLED",
    executionState: "PENDING",
    deliveryState: "PENDING",
    currentState: "EXECUTION_PENDING",
    timestamps: { createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
    evidence,
  }) as any;

  it("REPRODUCES duplicate append: truthful EXISTS=true is invisible to the Array.isArray guard (postgres-store.ts L633)", async () => {
    const db = new PgFaithfulDb();
    const rec = { operationId: "op-x", phase: "EXECUTION", timestamp: 1_700_000_000_500, event: "STATE_TRANSITION", payload: { from: "SETTLED", to: "EXECUTION_PENDING" } };
    db.seedIntent("op-x", [rec]); // record ALREADY durably present
    const store = new PostgresEvidenceStore(db as never);

    await store.saveOperation(baseOp("op-x", [rec]));
    await store.saveOperation(baseOp("op-x", [rec]));

    const row = db.intents.get("op-x");
    // Production guard reads (Array.isArray(checkRows) ? checkRows : [])[0];
    // with the genuine {rows:[{present:true}]} shape this yields undefined →
    // !present?.present is true → append runs AGAIN → duplicate.
    expect(row.reconciliationObservations).toHaveLength(3); // DEFECT REPRODUCED: seeded 1 + TWO duplicate appends despite truthful present=true
  });

  it("CONTROL: with array-shaped results (FakeDb contract), the same guard DOES dedup — proving the defect is purely the result-shape read", async () => {
    class ArrayShapedDb extends PgFaithfulDb {
      override async execute(query: unknown): Promise<any> {
        const res = await super.execute(query);
        return res.rows; // legacy bare-array shape
      }
    }
    const db = new ArrayShapedDb();
    const rec = { operationId: "op-y", phase: "EXECUTION", timestamp: 1_700_000_000_500, event: "STATE_TRANSITION", payload: { from: "SETTLED", to: "EXECUTION_PENDING" } };
    db.seedIntent("op-y", [rec]);
    const store = new PostgresEvidenceStore(db as never);

    await store.saveOperation(baseOp("op-y", [rec]));
    await store.saveOperation(baseOp("op-y", [rec]));

    expect(db.intents.get("op-y").reconciliationObservations).toHaveLength(1); // dedup works on array shape: no append at all
  });
});
