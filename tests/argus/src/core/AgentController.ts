// ============================================================
// src/core/AgentController.ts
// ============================================================

/**
 * AgentController - Universal Orchestration Layer for Agent Interactions
 *
 * Controller manages the lifecycle of a single test interaction between
 * Argus and a target agent through the universal AgentTargetPort.
 *
 * ARCHITECTURAL PRINCIPLES:
 * - Controller is target-agnostic (doesn't know any specific target like HTTP, MCP, etc.)
 * - Controller does NOT implement automatic retry
 * - Controller does NOT determine PASS/FAIL/INCONCLUSIVE verdicts
 * - Controller treats timeout as an observed outcome, not a semantic verdict
 * - Controller uses only the universal AgentTargetPort interface
 * - Controller does NOT collect evidence (ScenarioEngine does that)
 * - Controller does NOT know about actor
 */

import {
  AgentTargetPort,
  TargetConnectionConfig,
  ConnectionResult,
  Exchange,
  RunId,
  ExchangeStatus,
} from './AgentTargetPort';

/**
 * Outcome of a controller-managed interaction
 * Represents the observed result without semantic interpretation
 */
export interface InteractionOutcome {
  /** The run identifier */
  runId: RunId;

  /** Status of the interaction */
  status: ExchangeStatus;

  /** The exchange record if available */
  exchange?: Exchange;

  /** Error message if status is FAILURE or TIMEOUT */
  error?: string;

  /** Duration of the interaction in milliseconds */
  durationMs?: number;
}

/**
 * Configuration for the AgentController
 */
export interface ControllerConfig {
  /** Connection configuration for the target port */
  connectionConfig: TargetConnectionConfig;

  /** Default timeout in milliseconds for interactions */
  timeoutMs?: number;

  /** Optional run identifier (generated if not provided) */
  runId?: RunId;

  /** Runtime participant identity associated with this controller's target observations. */
  participantId?: string;
}

/**
 * AgentController manages the lifecycle of agent interactions
 *
 * Lifecycle:
 *   connect → act/send → observe/receive → disconnect
 *
 * The controller is responsible for:
 * - Managing connection lifecycle
 * - Executing actions with timeout support
 * - Proper cleanup on failure
 *
 * The controller does NOT:
 * - Implement automatic retry
 * - Determine semantic verdicts (PASS/FAIL/INCONCLUSIVE)
 * - Know about specific targets or protocols
 * - Contain business/economic logic
 * - Collect evidence
 * - Know about actor
 */
export class AgentController {
  private readonly port: AgentTargetPort;
  private readonly config: ControllerConfig;
  private isConnectedFlag: boolean = false;
  private currentRunId?: RunId;

  constructor(port: AgentTargetPort, config: ControllerConfig) {
    this.port = port;
    this.config = {
      ...config,
      timeoutMs: config.timeoutMs ?? 30000,
    };
    this.currentRunId = config.runId;
  }

  getRunId(): RunId | undefined {
    return this.currentRunId;
  }

  getParticipantId(): string | undefined {
    return this.config.participantId;
  }

  setParticipantId(participantId: string): void {
    this.config.participantId = participantId;
  }

  private bindParticipantIdentity(exchange: Exchange): Exchange {
    const participantId = this.config.participantId;
    if (!participantId) return exchange;
    exchange.metadata = { ...(exchange.metadata ?? {}), participantId };
    return exchange;
  }

  async connect(): Promise<ConnectionResult> {
    const result = await this.port.connect(this.config.connectionConfig);
    if (result.success) {
      this.isConnectedFlag = true;
    }
    return result;
  }

  isConnected(): boolean {
    return this.isConnectedFlag && this.port.isConnected();
  }

  /**
   * Execute an action with timeout support.
   * Returns raw outcome without evidence collection.
   */
  async act(type: string, payload?: unknown): Promise<InteractionOutcome> {
    if (!this.currentRunId) {
      throw new Error('RunId not set. Call setRunId() before act().');
    }

    if (!this.isConnected()) {
      return {
        runId: this.currentRunId,
        status: ExchangeStatus.FAILURE,
        error: 'Not connected to target',
      };
    }

    const startTime = Date.now();

    try {
      const actionPromise = this.port.send(this.currentRunId, type, payload);
      const timeoutPromise = new Promise<Exchange>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Action timeout after ${this.config.timeoutMs}ms`));
        }, this.config.timeoutMs);
      });

      const exchange = this.bindParticipantIdentity(
        await Promise.race([actionPromise, timeoutPromise])
      );
      const durationMs = Date.now() - startTime;

      return {
        runId: this.currentRunId,
        status: exchange.status,
        exchange,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = errorMessage.includes('timeout');

      return {
        runId: this.currentRunId,
        status: isTimeout ? ExchangeStatus.TIMEOUT : ExchangeStatus.FAILURE,
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Observe a response/observation from the target.
   * Returns raw outcome without evidence collection.
   */
  async observe(type: string, payload?: unknown): Promise<InteractionOutcome> {
    if (!this.currentRunId) {
      throw new Error('RunId not set. Call setRunId() before observe().');
    }

    if (!this.isConnected()) {
      return {
        runId: this.currentRunId,
        status: ExchangeStatus.FAILURE,
        error: 'Not connected to target',
      };
    }

    const startTime = Date.now();

    try {
      const exchange = this.bindParticipantIdentity(
        await this.port.receive(this.currentRunId, type, payload)
      );
      const durationMs = Date.now() - startTime;

      return {
        runId: this.currentRunId,
        status: exchange.status,
        exchange,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        runId: this.currentRunId,
        status: ExchangeStatus.FAILURE,
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Execute a complete interaction lifecycle:
   * connect → act → observe → disconnect
   *
   * Returns raw outcome without evidence collection.
   */
  async executeInteraction(
    actionType: string,
    actionPayload?: unknown,
    observeType?: string
  ): Promise<InteractionOutcome> {
    if (!this.currentRunId) {
      throw new Error('RunId not set. Call setRunId() before executing interaction.');
    }

    let connected = false;

    try {
      const connectResult = await this.connect();
      if (!connectResult.success) {
        return {
          runId: this.currentRunId,
          status: ExchangeStatus.FAILURE,
          error: `Connection failed: ${connectResult.error}`,
        };
      }
      connected = true;

      const actOutcome = await this.act(actionType, actionPayload);
      if (actOutcome.status !== ExchangeStatus.SUCCESS) {
        return actOutcome;
      }

      if (observeType) {
        const observeOutcome = await this.observe(observeType);
        if (observeOutcome.status !== ExchangeStatus.SUCCESS) {
          return observeOutcome;
        }

        return {
          runId: this.currentRunId,
          status: ExchangeStatus.SUCCESS,
          exchange: observeOutcome.exchange,
          durationMs: (actOutcome.durationMs ?? 0) + (observeOutcome.durationMs ?? 0),
        };
      }

      return actOutcome;
    } finally {
      if (connected) {
        await this.disconnect();
      }
    }
  }

  setRunId(runId: RunId): void {
    this.currentRunId = runId;
  }

  /**
   * Execute an action with a payment signature.
   *
   * Only works if the underlying port implements PaymentCapablePort.
   * Controller does NOT know about x402, PaymentAdapter, or payment semantics.
   * It only knows: "if the port supports sendWithSignature, call it".
   *
   * @param type - original action type
   * @param payload - original action payload
   * @param paymentSignature - Base64-encoded payment signature
   * @throws Error if the port does not support sendWithSignature
   */
  async actWithSignature(
    type: string,
    payload: unknown,
    paymentSignature: string
  ): Promise<InteractionOutcome> {
    if (!this.currentRunId) {
      throw new Error('RunId not set. Call setRunId() before actWithSignature().');
    }

    if (!this.isConnected()) {
      return {
        runId: this.currentRunId,
        status: ExchangeStatus.FAILURE,
        error: 'Not connected to target',
      };
    }

    // Check if port supports sendWithSignature (PaymentCapablePort)
    const port = this.port as unknown as { sendWithSignature?: Function };
    if (typeof port.sendWithSignature !== 'function') {
      throw new Error(
        'Port does not support sendWithSignature (not a PaymentCapablePort)'
      );
    }

    const startTime = Date.now();

    try {
      const actionPromise = port.sendWithSignature(
        this.currentRunId,
        type,
        payload,
        paymentSignature
      ) as Promise<Exchange>;

      const timeoutPromise = new Promise<Exchange>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Action timeout after ${this.config.timeoutMs}ms`));
        }, this.config.timeoutMs);
      });

      const exchange = this.bindParticipantIdentity(
        await Promise.race([actionPromise, timeoutPromise])
      );
      const durationMs = Date.now() - startTime;

      return {
        runId: this.currentRunId,
        status: exchange.status,
        exchange,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = errorMessage.includes('timeout');

      return {
        runId: this.currentRunId,
        status: isTimeout ? ExchangeStatus.TIMEOUT : ExchangeStatus.FAILURE,
        error: errorMessage,
        durationMs,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.isConnectedFlag = false;
    await this.port.disconnect();
  }
}

// ============================================================
// КОНЕЦ ФАЙЛА
// ============================================================
