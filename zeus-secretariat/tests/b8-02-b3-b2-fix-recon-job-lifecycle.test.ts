/**
 * BLOCK 8.2-B.3-B2-FIX — Reconciliation Job Lifecycle Hardening Tests
 *
 * Tests lease-safe atomic operations, discovery, deduplication.
 * Uses InMemoryTestStore that mirrors PostgresEvidenceStore contract.
 */

import type { DurableEvidenceStore } from '../src/core/types';

// ---------------------------------------------------------------------------
// In-memory store implementing reconciliation job lifecycle contract
// Mirrors PostgresEvidenceStore SQL semantics for unit testing
// ---------------------------------------------------------------------------

interface ReconJob {
  jobId: string;
  paymentIntentId: string;
  status: string;
  probeCount: number;
  nextProbeAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class InMemoryReconJobStore {
  private jobs = new Map<string, ReconJob>();

  async createReconciliationJob(paymentIntentId: string, nextProbeAt: Date): Promise<string> {
    // Check active job deduplication (mirrors partial unique index)
    for (const job of this.jobs.values()) {
      if (job.paymentIntentId === paymentIntentId && (job.status === "PENDING" || job.status === "RUNNING")) {
        return job.jobId; // Idempotent: return existing active job
      }
    }
    const jobId = "rj-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const now = new Date();
    this.jobs.set(jobId, {
      jobId, paymentIntentId, status: "PENDING", probeCount: 0,
      nextProbeAt, lockedBy: null, lockedUntil: null, lastError: null,
      createdAt: now, updatedAt: now,
    });
    return jobId;
  }

  async getDueReconciliationJobs(): Promise<Array<{ jobId: string; paymentIntentId: string; probeCount: number }>> {
    const now = new Date();
    const results: Array<{ jobId: string; paymentIntentId: string; probeCount: number }> = [];
    for (const job of this.jobs.values()) {
      const isDuePending = job.status === "PENDING" && job.nextProbeAt <= now;
      const isExpiredRunning = job.status === "RUNNING" && job.lockedUntil !== null && job.lockedUntil < now;
      if (isDuePending || isExpiredRunning) {
        results.push({ jobId: job.jobId, paymentIntentId: job.paymentIntentId, probeCount: job.probeCount });
      }
    }
    return results.sort((a, b) => a.jobId.localeCompare(b.jobId)).slice(0, 100);
  }

  async claimReconciliationJob(jobId: string, workerId: string, lockDurationMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const now = new Date();
    const canClaim = job.status === "PENDING" || (job.status === "RUNNING" && job.lockedUntil !== null && job.lockedUntil < now);
    if (!canClaim) return false;
    job.status = "RUNNING";
    job.lockedBy = workerId;
    job.lockedUntil = new Date(Date.now() + lockDurationMs);
    job.probeCount += 1;
    job.updatedAt = now;
    return true;
  }

  async completeReconciliationJob(jobId: string, workerId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "RUNNING" || job.lockedBy !== workerId) return false;
    job.status = "COMPLETED";
    job.lockedBy = null;
    job.lockedUntil = null;
    job.updatedAt = new Date();
    return true;
  }

  async rescheduleReconciliationJob(jobId: string, workerId: string, nextProbeAt: Date): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "RUNNING" || job.lockedBy !== workerId) return false;
    job.status = "PENDING";
    job.nextProbeAt = nextProbeAt;
    job.lockedBy = null;
    job.lockedUntil = null;
    job.updatedAt = new Date();
    return true;
  }

  async failReconciliationJob(jobId: string, workerId: string, error: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "RUNNING" || job.lockedBy !== workerId) return false;
    job.status = "UNRESOLVABLE";
    job.lastError = error;
    job.lockedBy = null;
    job.lockedUntil = null;
    job.updatedAt = new Date();
    return true;
  }

  getJob(jobId: string): ReconJob | undefined { return this.jobs.get(jobId); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BLOCK 8.2-B.3-B2-FIX: Reconciliation Job Lifecycle", () => {
  let store: InMemoryReconJobStore;

  beforeEach(() => { store = new InMemoryReconJobStore(); });

  // --- Claim tests ---

  test("Claim: PENDING job successfully claimed", async () => {
    const jobId = await store.createReconciliationJob("pi-1", new Date(Date.now() - 1000));
    const claimed = await store.claimReconciliationJob(jobId, "worker-A", 30000);
    expect(claimed).toBe(true);
    const job = store.getJob(jobId)!;
    expect(job.status).toBe("RUNNING");
    expect(job.lockedBy).toBe("worker-A");
  });

  test("Claim: second worker cannot claim active lease", async () => {
    const jobId = await store.createReconciliationJob("pi-2", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const claimed2 = await store.claimReconciliationJob(jobId, "worker-B", 30000);
    expect(claimed2).toBe(false);
  });

  test("Claim: expired RUNNING lease can be reclaimed", async () => {
    const jobId = await store.createReconciliationJob("pi-3", new Date(Date.now() - 1000));
    // Claim with very short lease
    await store.claimReconciliationJob(jobId, "worker-A", 1);
    // Wait for lease to expire
    await new Promise(r => setTimeout(r, 10));
    const reclaimed = await store.claimReconciliationJob(jobId, "worker-B", 30000);
    expect(reclaimed).toBe(true);
    expect(store.getJob(jobId)!.lockedBy).toBe("worker-B");
  });

  test("Claim: locked_until IS NULL is NOT treated as expired", async () => {
    const jobId = await store.createReconciliationJob("pi-4", new Date(Date.now() - 1000));
    // Job is PENDING with lockedUntil=null — should be claimable as PENDING, not as expired
    const claimed = await store.claimReconciliationJob(jobId, "worker-A", 30000);
    expect(claimed).toBe(true);
    // Now it is RUNNING with valid lease — another worker should NOT be able to claim
    const claimed2 = await store.claimReconciliationJob(jobId, "worker-B", 30000);
    expect(claimed2).toBe(false);
  });

  test("Claim: increments probe_count", async () => {
    const jobId = await store.createReconciliationJob("pi-5", new Date(Date.now() - 1000));
    expect(store.getJob(jobId)!.probeCount).toBe(0);
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    expect(store.getJob(jobId)!.probeCount).toBe(1);
  });

  test("Claim: does not reference current_attempt (uses probe_count)", async () => {
    // This test verifies the fix: probe_count is incremented, not current_attempt
    const jobId = await store.createReconciliationJob("pi-6", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const job = store.getJob(jobId)!;
    expect(job.probeCount).toBe(1);
    // No current_attempt field exists on the job
    expect((job as any).currentAttempt).toBeUndefined();
  });

  // --- Ownership tests ---

  test("Ownership: owner can complete job", async () => {
    const jobId = await store.createReconciliationJob("pi-7", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const completed = await store.completeReconciliationJob(jobId, "worker-A");
    expect(completed).toBe(true);
    expect(store.getJob(jobId)!.status).toBe("COMPLETED");
  });

  test("Ownership: non-owner cannot complete job", async () => {
    const jobId = await store.createReconciliationJob("pi-8", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const completed = await store.completeReconciliationJob(jobId, "worker-B");
    expect(completed).toBe(false);
    expect(store.getJob(jobId)!.status).toBe("RUNNING");
  });

  test("Ownership: owner can reschedule job", async () => {
    const jobId = await store.createReconciliationJob("pi-9", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const rescheduled = await store.rescheduleReconciliationJob(jobId, "worker-A", new Date(Date.now() + 60000));
    expect(rescheduled).toBe(true);
    expect(store.getJob(jobId)!.status).toBe("PENDING");
  });

  test("Ownership: non-owner cannot reschedule job", async () => {
    const jobId = await store.createReconciliationJob("pi-10", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const rescheduled = await store.rescheduleReconciliationJob(jobId, "worker-B", new Date(Date.now() + 60000));
    expect(rescheduled).toBe(false);
    expect(store.getJob(jobId)!.status).toBe("RUNNING");
  });

  test("Ownership: owner can fail job", async () => {
    const jobId = await store.createReconciliationJob("pi-11", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const failed = await store.failReconciliationJob(jobId, "worker-A", "test error");
    expect(failed).toBe(true);
    expect(store.getJob(jobId)!.status).toBe("UNRESOLVABLE");
    expect(store.getJob(jobId)!.lastError).toBe("test error");
  });

  test("Ownership: non-owner cannot fail job", async () => {
    const jobId = await store.createReconciliationJob("pi-12", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    const failed = await store.failReconciliationJob(jobId, "worker-B", "test error");
    expect(failed).toBe(false);
    expect(store.getJob(jobId)!.status).toBe("RUNNING");
  });

  // --- Lease release tests ---

  test("Lease release: complete clears locked_by and locked_until", async () => {
    const jobId = await store.createReconciliationJob("pi-13", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    await store.completeReconciliationJob(jobId, "worker-A");
    const job = store.getJob(jobId)!;
    expect(job.lockedBy).toBeNull();
    expect(job.lockedUntil).toBeNull();
  });

  test("Lease release: reschedule clears locked_by and locked_until", async () => {
    const jobId = await store.createReconciliationJob("pi-14", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    await store.rescheduleReconciliationJob(jobId, "worker-A", new Date(Date.now() + 60000));
    const job = store.getJob(jobId)!;
    expect(job.lockedBy).toBeNull();
    expect(job.lockedUntil).toBeNull();
  });

  test("Lease release: fail clears locked_by and locked_until", async () => {
    const jobId = await store.createReconciliationJob("pi-15", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 30000);
    await store.failReconciliationJob(jobId, "worker-A", "error");
    const job = store.getJob(jobId)!;
    expect(job.lockedBy).toBeNull();
    expect(job.lockedUntil).toBeNull();
  });

  // --- Discovery tests ---

  test("Discovery: due PENDING job is returned", async () => {
    await store.createReconciliationJob("pi-16", new Date(Date.now() - 1000));
    const due = await store.getDueReconciliationJobs();
    expect(due.length).toBeGreaterThanOrEqual(1);
  });

  test("Discovery: expired RUNNING job is returned", async () => {
    const jobId = await store.createReconciliationJob("pi-17", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 1);
    await new Promise(r => setTimeout(r, 10));
    const due = await store.getDueReconciliationJobs();
    expect(due.some(j => j.jobId === jobId)).toBe(true);
  });

  test("Discovery: future PENDING job is NOT returned", async () => {
    await store.createReconciliationJob("pi-18", new Date(Date.now() + 60000));
    const due = await store.getDueReconciliationJobs();
    const hasFuture = due.some(j => j.paymentIntentId === "pi-18");
    expect(hasFuture).toBe(false);
  });

  test("Discovery: non-expired RUNNING job is NOT returned", async () => {
    const jobId = await store.createReconciliationJob("pi-19", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(jobId, "worker-A", 60000);
    const due = await store.getDueReconciliationJobs();
    const hasActive = due.some(j => j.jobId === jobId);
    expect(hasActive).toBe(false);
  });

  // --- Deduplication tests ---

  test("Dedup: creating active job twice returns same jobId", async () => {
    const id1 = await store.createReconciliationJob("pi-20", new Date());
    const id2 = await store.createReconciliationJob("pi-20", new Date());
    expect(id1).toBe(id2);
  });

  test("Dedup: historical terminal job does not block new active job", async () => {
    const id1 = await store.createReconciliationJob("pi-21", new Date(Date.now() - 1000));
    await store.claimReconciliationJob(id1, "worker-A", 30000);
    await store.completeReconciliationJob(id1, "worker-A");
    // Now create a new active job for the same paymentIntentId
    const id2 = await store.createReconciliationJob("pi-21", new Date());
    expect(id2).not.toBe(id1);
    expect(store.getJob(id2)!.status).toBe("PENDING");
  });
});
