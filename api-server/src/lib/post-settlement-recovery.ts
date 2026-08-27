/**
 * PostSettlementEngine startup recovery.
 *
 * Called once during api-server bootstrap to process any pending execution jobs
 * left over from a previous run (crash recovery).
 *
 * Uses the existing PostSettlementEngine.recoverPendingJobs() lifecycle.
 * Does NOT introduce new polling/cron/queue infrastructure.
 */

import { PostSettlementEngine } from "zeus-secretariat";
import { PostgresEvidenceStore } from "zeus-secretariat";
import { PostgresExecutionStore } from "zeus-secretariat";
import { HttpSellerExecutionAdapter } from "zeus-secretariat";
import { logger } from "../lib/logger.js";

export async function recoverPostSettlementJobs(): Promise<void> {
  const sellerUrl = process.env["ZEUS_SELLER_URL"];
  if (!sellerUrl) {
    logger.info("ZEUS_SELLER_URL not set — PostSettlementEngine recovery skipped");
    return;
  }

  try {
    const paymentStore = new PostgresEvidenceStore();
    const executionStore = new PostgresExecutionStore();
    const sellerAdapter = new HttpSellerExecutionAdapter(
      parseInt(process.env["ZEUS_SELLER_TIMEOUT_MS"] ?? "30000", 10),
    );

    const engine = new PostSettlementEngine(paymentStore, executionStore, sellerAdapter, {
      workerId: `api-server-${process.pid}`,
      sellerUrl,
      sellerMethod: process.env["ZEUS_SELLER_METHOD"] ?? "POST",
      lockDurationMs: parseInt(process.env["ZEUS_EXECUTION_LOCK_MS"] ?? "60000", 10),
      maxExecutionAttempts: parseInt(process.env["ZEUS_MAX_EXECUTION_ATTEMPTS"] ?? "3", 10),
    });

    const recovered = await engine.recoverPendingJobs();
    if (recovered.length > 0) {
      logger.info(`PostSettlementEngine: recovered ${recovered.length} pending jobs`, { results: recovered });
    }
  } catch (e) {
    logger.warn("PostSettlementEngine: recovery failed", e);
  }
}
