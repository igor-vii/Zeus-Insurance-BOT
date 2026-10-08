/**
 * SessionManager — Mode A MVP vertical slice (transport/session lifecycle).
 *
 * Manages ephemeral test sessions in memory.
 * No database. No persistence. Sessions expire in memory.
 *
 * Block A boundary: lifecycle/endpoint management only. This layer owns no
 * evidence and computes no verdicts; semantic evaluation lives exclusively
 * in the canonical EvidenceCollector → AssertionEngine pipeline.
 */

import type { SessionStatus, TestMode } from './TestSession';
import { TestSession } from './TestSession';
import { X402SellerAdapter } from '../adapters/seller/X402SellerAdapter';

export interface CreateSessionOptions {
  testMode: TestMode;
  testProfile: string;
  timeoutSeconds?: number;
  maxInteractions?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, TestSession>();
  private readonly sellerAdapter: X402SellerAdapter;
  private baseUrl = '';

  constructor(sellerAdapter: X402SellerAdapter) {
    this.sellerAdapter = sellerAdapter;
  }

  /**
   * Set the base URL after the seller adapter has started.
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  /**
   * Create a session using the canonical TestSession class.
   *
   * The seller adapter receives the session when start() is called by the
   * composition layer. SessionManager owns lifecycle/state only.
   */
  createSession(options: CreateSessionOptions): TestSession {
    const session = new TestSession({
      test_mode: options.testMode,
      test_profile: options.testProfile,
      timeout_seconds: options.timeoutSeconds,
      max_interactions: options.maxInteractions,
    });

    this.sessions.set(session.session_id, session);
    return session;
  }

  /**
   * Return the public endpoint for a session after the adapter has started.
   */
  getSessionEndpoint(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !this.baseUrl) return undefined;
    return `${this.baseUrl}${session.getEndpointPath()}`;
  }

  getSession(sessionId: string): TestSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): TestSession[] {
    return Array.from(this.sessions.values());
  }

  checkExpiry(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const wasActive = session.status === 'ACTIVE';
    session.checkExpiry();
    const statusAfterExpiry: SessionStatus = session.status;
    return wasActive && statusAfterExpiry === 'EXPIRED';
  }

  /**
   * Expose the adapter only to the bounded Mode A composition layer.
   */
  getSellerAdapter(): X402SellerAdapter {
    return this.sellerAdapter;
  }
}
