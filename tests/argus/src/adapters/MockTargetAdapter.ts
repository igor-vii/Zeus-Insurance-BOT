/**
 * MockTargetAdapter - Mock Implementation of AgentTargetAdapter
 * 
 * This is a test/mock implementation that simulates a target agent
 * without requiring actual network connections or external dependencies.
 * 
 * Used for:
 * - Unit testing the AgentTargetAdapter contract
 * - Testing Argus Core without external dependencies
 * - Demonstrating the adapter pattern
 */

import {
  AgentTargetPort,
  TargetConnectionConfig,
  ConnectionResult,
  Exchange,
  Evidence,
  MessageDirection,
  ExchangeStatus,
  RunId,
} from '../core/AgentTargetPort';

/**
 * Generate a unique ID (simplified for mock purposes)
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Configuration specific to the mock target
 */
export interface MockTargetConfig extends TargetConnectionConfig {
  /** Simulate connection delay in ms */
  connectionDelayMs?: number;
  
  /** Simulate failure rate (0.0 - 1.0) */
  failureRate?: number;

  /** Pre-programmed responses for specific message types */
  cannedResponses?: Record<string, unknown>;

  /**
   * R2 lifecycle-observation plumbing (see docs/evidence-source-map.md):
   * per-action-type list of lifecycle observations that the simulated source
   * (Sut / settlement layer) is configured to report on a successful response.
   *
   * This does NOT invent facts: each type here must be a fact the simulated
   * source would legitimately report (e.g. a facilitator/settlement layer
   * answering "payment_settled" or "settlement_unknown" about a payment).
   * The mock merely relays what the scenario configures the source to say.
   * Unknown/invalid observation types are ignored by the mock itself;
   * validation lives in core/validateScenario (L0-F2 boundary).
   */
  lifecycleObservations?: Record<string, string[]>;
}

/**
 * Lifecycle observation types that represent an external economic/delivery
 * fact reported by the simulated source. Kept as a narrow allow-list so that
 * no speculative lifecycle emitter can enter the evidence path through the
 * mock: a type may appear here only if a canonical scenario assertion already
 * consumes it (docs/evidence-source-map.md, section 2).
 *
 * Deliberately absent (no legitimate source yet — see R1 map):
 * delivery_received (edge-mediated), recovery_completed (crash/restart),
 * forward_request, unhandled_exception.
 */
export const MOCK_LIFECYCLE_OBSERVATION_TYPES: ReadonlySet<string> = new Set([
  'payment_settled',
  'settlement_unknown',
  'success',
  'failed',
  'delivery_started',
  'delivery_sent',
  'delivery_completed',
  'delivery_unknown',
]);

/**
 * Internal state for tracking payment intents by idempotency key
 */
interface PaymentIntent {
  id: string;
  amount: number;
}

/**
 * Mock implementation of AgentTargetPort
 */
export class MockTargetAdapter implements AgentTargetPort {
  private id: string;
  private targetType: string;
  private connected: boolean = false;
  private config?: MockTargetConfig;
  private exchanges: Exchange[] = [];
  private evidences: Evidence[] = [];
  // NOTE: Map operations below are synchronous. Because send() has no
  // await between has() and set(), there is no race window inside a
  // single event loop. This invariant must hold if this adapter is ever
  // wrapped in real async I/O (e.g., HTTP). For S5 concurrency, the
  // target of the test is the SUT, not this mock.
  private paymentIntents: Map<string, PaymentIntent> = new Map();

  constructor(targetType: string = 'mock-target') {
    this.id = generateId('adapter');
    this.targetType = targetType;
  }

  getId(): string {
    return this.id;
  }

  getTargetType(): string {
    return this.targetType;
  }

  async connect(config: TargetConnectionConfig): Promise<ConnectionResult> {
    const mockConfig = config as MockTargetConfig;
    
    // Simulate connection delay
    const delay = (mockConfig.options?.connectionDelayMs as number | undefined) ?? 0;
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    // Simulate potential failure
    const failureRate = (mockConfig.options?.failureRate as number | undefined) ?? 0;
    if (Math.random() < failureRate) {
      return {
        success: false,
        error: 'Simulated connection failure',
      };
    }
    
    this.config = mockConfig;
    this.connected = true;
    
    return {
      success: true,
      connectionId: generateId('conn'),
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    if (!this.connected) {
      throw new Error('Not connected. Call connect() first.');
    }

    let responsePayload: unknown = {};
    let observations: string[] = [];

    // Lifecycle observations the simulated source is configured to report.
    // Filtered through the canonical allow-list so a misconfigured mock cannot
    // inject arbitrary/speculative evidence types into the evidence path.
    const configuredLifecycle = (
      (this.config?.options?.lifecycleObservations as Record<string, string[]> | undefined)?.[type] ?? []
    ).filter((t) => MOCK_LIFECYCLE_OBSERVATION_TYPES.has(t));

    switch (type) {
      case 'request_payment': {
        const idempotencyKey = (payload as any)?.idempotencyKey;
        const amount = (payload as any)?.amount ?? 100;

        if (idempotencyKey && this.paymentIntents.has(idempotencyKey)) {
          // Target already has a payment_intent for this key - idempotency works
          const existing = this.paymentIntents.get(idempotencyKey)!;
          responsePayload = {
            payment_intent: existing,
            reused: true,
            idempotencyKey,
          };
          observations = ['payment_intent_reused', 'response_received'];
        } else {
          // Target creates a new payment_intent
          const newIntent: PaymentIntent = { id: generateId('pi'), amount };
          if (idempotencyKey) {
            this.paymentIntents.set(idempotencyKey, newIntent);
          }
          responsePayload = {
            payment_intent: newIntent,
            reused: false,
            idempotencyKey,
          };
          observations = ['payment_intent_created'];
        }
        // The settlement layer of the simulated Sut answers with its own
        // economic state for this request (settled / UNKNOWN / ...), if the
        // scenario configures it to report one. Appended after intent facts.
        observations.push(...configuredLifecycle);
        break;
      }

      default:
        responsePayload = payload ?? {};
        observations = [...configuredLifecycle];
    }

    const exchange: Exchange = {
      id: generateId('exch'),
      runId,
      direction: MessageDirection.OUTBOUND,
      type,
      timestamp: Date.now(),
      payload: responsePayload,
      status: ExchangeStatus.SUCCESS,
      metadata: { observations },
    };

    this.exchanges.push(exchange);
    return exchange;
  }

  async receive(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    if (!this.connected) {
      throw new Error('Not connected. Call connect() first.');
    }
    
    // Check for canned response
    let responsePayload = payload;
    const cannedResponses = this.config?.options?.cannedResponses as Record<string, unknown> | undefined;
    if (cannedResponses && cannedResponses[type]) {
      responsePayload = cannedResponses[type];
    }
    
    const exchange: Exchange = {
      id: generateId('exch'),
      runId,
      direction: MessageDirection.INBOUND,
      type,
      timestamp: Date.now(),
      payload: responsePayload,
      status: ExchangeStatus.SUCCESS,
    };
    
    this.exchanges.push(exchange);
    return exchange;
  }

  async captureEvidence(
    runId: RunId,
    type: string,
    data: unknown,
    description?: string
  ): Promise<Evidence> {
    const evidence: Evidence = {
      id: generateId('evid'),
      runId,
      type,
      timestamp: Date.now(),
      data,
      description,
    };
    
    this.evidences.push(evidence);
    return evidence;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = undefined;
  }

  /**
   * Get all exchanges for this adapter (for testing/inspection)
   */
  getExchanges(): Exchange[] {
    return [...this.exchanges];
  }

  /**
   * Get all evidence for this adapter (for testing/inspection)
   */
  getEvidences(): Evidence[] {
    return [...this.evidences];
  }

  /**
   * Reset the mock state (for testing)
   */
  reset(): void {
    this.connected = false;
    this.config = undefined;
    this.exchanges = [];
    this.evidences = [];
  }
}
