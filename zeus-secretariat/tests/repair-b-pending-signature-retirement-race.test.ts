import { PostgresEvidenceStore } from "../../lib/db/src/secretariat/postgres-store";

type SqlQuery = {
  queryChunks?: unknown[];
};

class ConditionalRetirementDb {
  settlementState: "PENDING_SIGNATURE" | "AUTHORIZED";
  jobStatus: "PENDING" | "COMPLETED" = "PENDING";
  operationState = "AWAITING_SIGNATURE";
  readonly executedQueries: SqlQuery[] = [];

  constructor(settlementState: "PENDING_SIGNATURE" | "AUTHORIZED") {
    this.settlementState = settlementState;
  }

  async execute(query: SqlQuery): Promise<Array<{ job_id: string }>> {
    this.executedQueries.push(query);
    if (this.settlementState !== "PENDING_SIGNATURE" || this.jobStatus !== "PENDING") {
      return [];
    }
    this.jobStatus = "COMPLETED";
    return [{ job_id: "job-pending-signature" }];
  }
}

function queryText(query: SqlQuery): string {
  return JSON.stringify(query.queryChunks ?? []);
}

describe("Repair B: pending-signature retirement is conditional on current DPI state", () => {
  test("atomically completes only while the DPI is still PENDING_SIGNATURE", async () => {
    const pendingDb = new ConditionalRetirementDb("PENDING_SIGNATURE");
    const pendingStore = new PostgresEvidenceStore(pendingDb as any);

    const completedBeforeStageB = await pendingStore.completePendingReconciliationJob(
      "job-pending-signature",
    );
    expect(completedBeforeStageB).toBe(true);
    expect(pendingDb.jobStatus).toBe("COMPLETED");
    expect(pendingDb.settlementState).toBe("PENDING_SIGNATURE");
    expect(pendingDb.operationState).toBe("AWAITING_SIGNATURE");

    const stageBDb = new ConditionalRetirementDb("AUTHORIZED");
    const stageBStore = new PostgresEvidenceStore(stageBDb as any);
    const completedAfterStageB = await stageBStore.completePendingReconciliationJob(
      "job-pending-signature",
    );
    expect(completedAfterStageB).toBe(false);
    expect(stageBDb.jobStatus).toBe("PENDING");
    expect(stageBDb.settlementState).toBe("AUTHORIZED");
    expect(stageBDb.operationState).toBe("AWAITING_SIGNATURE");

    expect(pendingDb.executedQueries).toHaveLength(1);
    expect(stageBDb.executedQueries).toHaveLength(1);
    for (const query of [...pendingDb.executedQueries, ...stageBDb.executedQueries]) {
      const text = queryText(query);
      expect(text).toContain("payment_intents");
      expect(text).toContain("settlement_state");
      expect(text).toContain("PENDING_SIGNATURE");
      expect(text).toContain("FOR UPDATE");
      expect(text).toContain("UPDATE reconciliation_jobs");
    }
  });
});