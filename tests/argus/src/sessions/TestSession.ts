/**
 * TestSession — Mode A MVP vertical slice (transport/session LIFECYCLE only).
 *
 * In-memory session for testing an external BUYER agent.
 * Argus acts as ephemeral RESOURCE_SERVER / SELLER.
 *
 * Block A boundary: this class manages session ID, lifecycle, timeout/expiry
 * and endpoint path ONLY. It deliberately owns NO evidence model and computes
 * NO verdicts — semantic evidence/assertions/verdicts for Block A scenarios
 * (S8/S9) converge exclusively on the canonical pipeline:
 *   EvidenceCollector → AssertionEngine → RunResult.verdict
 * The former SessionEvidence / SessionResult / getResult() side-channel was
 * removed because it constituted a second evidence/verdict model.
 */

import { randomUUID } from 'crypto';

export type TestMode = 'BUYER' | 'SELLER';
export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'EXPIRED';

export interface CreateSessionRequest {
  test_mode: TestMode;
  test_profile: string;
  timeout_seconds?: number;
  max_interactions?: number;
}

export class TestSession {
  readonly session_id: string;
  readonly test_mode: TestMode;
  readonly test_profile: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly max_interactions: number;
  private readonly timeout_seconds: number;

  private _status: SessionStatus = 'ACTIVE';
  private _interactionCount = 0;

  constructor(req: CreateSessionRequest) {
    this.session_id = randomUUID();
    this.test_mode = req.test_mode;
    this.test_profile = req.test_profile;
    this.created_at = Date.now();
    this.timeout_seconds = req.timeout_seconds ?? 60;
    this.expires_at = this.created_at + this.timeout_seconds * 1000;
    this.max_interactions = req.max_interactions ?? 10;
  }

  get status(): SessionStatus {
    return this._status;
  }

  /** Lifecycle counter only — NOT an evidence store (see file header). */
  get interactionCount(): number {
    return this._interactionCount;
  }

  get isExpired(): boolean {
    return Date.now() >= this.expires_at;
  }

  get isComplete(): boolean {
    return this._status !== 'ACTIVE';
  }

  /**
   * Count an inbound interaction from the external BUYER SUT.
   * Transport/lifecycle bookkeeping only; stores nothing.
   */
  recordInteraction(): void {
    if (this._status !== 'ACTIVE') return;
    this._interactionCount += 1;
    if (this._interactionCount >= this.max_interactions) {
      this.complete();
    }
  }

  /**
   * Complete the session (lifecycle transition only — no verdict computed).
   */
  complete(): void {
    if (this._status !== 'ACTIVE') return;
    this._status = 'COMPLETED';
  }

  /**
   * Check expiry and auto-complete if expired.
   */
  checkExpiry(): void {
    if (this._status === 'ACTIVE' && this.isExpired) {
      this._status = 'EXPIRED';
    }
  }

  /**
   * Generate the session endpoint URL path.
   */
  getEndpointPath(): string {
    return `/sessions/${this.session_id}/resource`;
  }
}
