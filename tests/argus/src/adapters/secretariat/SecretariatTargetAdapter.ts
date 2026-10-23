/**
 * SecretariatTargetAdapter — live SUT adapter for the Zeus Secretariat /v1
 * boundary (POST /v1/requests, POST /v1/requests/:id/payment,
 * GET /v1/requests/:id).
 *
 * This is the "next stage" wiring promised by
 * evidence/secretariat-test/argus/README.md: instead of the MockTargetAdapter
 * simulating a facilitator, this adapter drives the REAL Secretariat process
 * and maps what actually comes back over HTTP into the canonical observation
 * vocabulary consumed by the S1–S7 assertions:
 *
 *   payment_intent_created  ← 201 create for a requestId not seen before
 *   payment_intent_reused   ← duplicate create resolved to the SAME operation
 *                             (409 REQUEST_ALREADY_COMPLETED, or 201 carrying
 *                             an already-seen requestId — the PG unique
 *                             arbiter guarantees one operation per clientId)
 *   failed                  ← 422 REQUEST_REJECTED / payment 422 / hard errors
 *   payment_settled         ← settlement observed exactly once per distinct
 *                             settlementTxHash (dedup across retries)
 *   recovery_completed      ← the adapter observed a real Secretariat outage
 *                             (connection refused during a crash/restart)
 *                             followed by a successful poll — a boundary fact,
 *                             not a synthetic event
 *   success                 ← public status COMPLETED
 *   delivery_unknown        ← public status UNKNOWN / UNRESOLVABLE, or the
 *                             poll deadline expired without a terminal state
 *
 * Observations all carry source = scenario.testSubject (sut-1) via the engine;
 * `data` is the exchange payload, which intentionally includes the scenario's
 * idempotencyKey so behavioral assertions can match on it.
 *
 * Client behavior mirrors the R6 adversarial E2E client: sign EIP-3009
 * TransferWithAuthorization over the PERSISTED paymentIntent binding returned
 * by Stage A, submit the x402 v2 payload to Stage B, poll until terminal.
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
  Metadata,
} from '../../core/AgentTargetPort';

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CreateResponse {
  requestId?: string;
  operationId?: string;
  status?: string;
  paymentIntent?: {
    payTo: string;
    value: string;
    nonce: string;
    validAfter: string;
    validBefore: string;
  };
  error?: { code?: string; message?: string };
}

interface PollResponse {
  requestId?: string;
  status?: string;
  settlementTxHash?: string;
  outcome?: unknown;
  error?: { code?: string };
}

export class SecretariatTargetAdapter implements AgentTargetPort {
  private id: string;
  private targetType: string;
  private connected = false;
  private config?: TargetConnectionConfig;
  private exchanges: Exchange[] = [];
  private evidences: Evidence[] = [];

  // Logical-request registry: clientId → requestId of the operation the
  // Secretariat actually created. Synchronous updates only (single event loop
  // between await resumption and write) — safe for the S5 concurrent race.
  private seenLogical = new Map<string, string>();
  // Distinct settlements already reported (S6: a retried payment must not
  // produce a second payment_settled observation).
  private reportedTx = new Set<string>();

  constructor(targetType: string = 'secretariat') {
    this.id = generateId('sec-adapter');
    this.targetType = targetType;
  }

  getId(): string {
    return this.id;
  }

  getTargetType(): string {
    return this.targetType;
  }

  async connect(config: TargetConnectionConfig): Promise<ConnectionResult> {
    const endpoint = config.endpoint ?? process.env.SECRETARIAT_URL ?? 'http://127.0.0.1:8080';
    try {
      new URL(endpoint);
    } catch (error) {
      return {
        success: false,
        error: `Invalid Secretariat URL '${endpoint}': ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.config = { ...config, endpoint };
    this.connected = true;
    return { success: true, connectionId: generateId('sec-conn') };
  }

  isConnected(): boolean {
    return this.connected;
  }

  private get baseUrl(): string {
    return this.config?.endpoint ?? process.env.SECRETARIAT_URL ?? 'http://127.0.0.1:8080';
  }

  private get resourceUrl(): string {
    return process.env.SECRETARIAT_RESOURCE_URL ?? `${this.baseUrl.replace(/\/$/, '')}/resource`;
  }

  private get scenarioTag(): string {
    return process.env.ARGUS_LIVE_SCENARIO ?? 'LIVE';
  }

  private get crashTolerant(): boolean {
    return process.env.ARGUS_LIVE_CRASH === '1';
  }

  private get pollDeadlineMs(): number {
    return Number.parseInt(process.env.ARGUS_LIVE_POLL_DEADLINE_MS ?? '20000', 10);
  }

  private get clientKey(): string {
    const key = process.env.SECRETARIAT_CLIENT_KEY;
    if (!key) throw new Error('SECRETARIAT_CLIENT_KEY is required for the secretariat target');
    return key;
  }

  async send(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    if (!this.isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (type !== 'request_payment') {
      // Non-economic actions are echoed back untouched (same contract as the
      // mock adapter's default branch).
      const exchange: Exchange = {
        id: generateId('sec-exch'),
        runId,
        direction: MessageDirection.OUTBOUND,
        type,
        timestamp: Date.now(),
        payload: payload ?? {},
        status: ExchangeStatus.SUCCESS,
        metadata: { observations: [] } as Metadata,
      };
      this.exchanges.push(exchange);
      return exchange;
    }

    const p = (payload ?? {}) as {
      requestId?: string;
      idempotencyKey?: string;
      amount?: number;
    };
    const idempotencyKey = p.idempotencyKey ?? `key-${generateId('k')}`;
    // Logical operation identity = the scenario's request identity. S6 models
    // payment retries as fresh idempotency keys over the SAME logical request,
    // so ARGUS_LIVE_LOGICAL_KEY pins all of its actions to one logical op;
    // otherwise the scenario's requestId is the logical identity.
    const logicalRequest = process.env.ARGUS_LIVE_LOGICAL_KEY ?? p.requestId ?? idempotencyKey;
    const runStamp = process.env.ARGUS_LIVE_RUN_STAMP ?? 'dev';
    const clientId = `argus-live-${runStamp}-${this.scenarioTag}-${logicalRequest}`;

    const observations: string[] = [];
    let finalStatus: string | undefined;
    let txHash: string | undefined;
    let outcome: unknown;
    let reused = false;
    let rejectedCode: string | undefined;

    try {
      // ---------------- Stage A: discovery + policy + intent creation -------
      const created = await this.postJson('/v1/requests', {
        target: this.resourceUrl,
        method: 'POST',
        payload: { prompt: this.scenarioTag },
        clientId,
        authorizer: await this.clientAddress(),
        policy: {
          maxPrice: process.env.SECRETARIAT_MAX_PRICE ?? '100000',
          allowedNetworks: [process.env.SECRETARIAT_NETWORK ?? 'base-sepolia'],
          allowedAssets: [process.env.SECRETARIAT_ASSET ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
          allowedSellers: [process.env.SECRETARIAT_SELLER_ADDR ?? '0xcccccccccccccccccccccccccccccccccccccccc'],
          authorizationMode: 'explicit',
        },
      });
      const createBody = created.body as CreateResponse;
      const requestId = createBody?.requestId;
      const known = this.seenLogical.get(clientId);

      // Reuse detection is by REQUEST-ID EQUALITY, not by clientId presence:
      // a 201 carrying a NEW requestId means the SUT created a SECOND
      // operation for the same logical request (the S1/S5 defect the live
      // matrix exists to catch). Counting it as a creation keeps the harness
      // honest — the PG assert cross-checks intent rows per clientId.
      if (created.status === 201 && requestId && (!known || requestId !== known)) {
        this.seenLogical.set(clientId, requestId);
        if (known) reused = false; // second NEW operation — defect signal
        observations.push('payment_intent_created');
      } else if (created.status === 201 && requestId && requestId === known) {
        // Same operation returned again (PG unique arbiter resolved the race,
        // or an honest duplicate create hit the existing AWAITING_SIGNATURE
        // operation). True reuse.
        reused = true;
        observations.push('payment_intent_reused');
      } else if (created.status === 409) {
        // The logical request already completed without us paying again.
        reused = true;
        observations.push('payment_intent_reused');
      } else {
        rejectedCode = createBody?.error?.code ?? `HTTP_${created.status}`;
        observations.push('failed');
      }

      // ---------------- Stage B: sign the PERSISTED intent binding ----------
      if (created.status === 201 && createBody?.paymentIntent && requestId) {
        const pi = createBody.paymentIntent;
        const signature = await this.signEip3009({
          payTo: pi.payTo,
          value: pi.value,
          nonceHex: pi.nonce,
          validAfter: pi.validAfter,
          validBefore: pi.validBefore,
        });
        const payRes = await this.postJson(`/v1/requests/${requestId}/payment`, {
          x402Version: 2,
          accepted: {
            scheme: 'exact',
            network: process.env.SECRETARIAT_NETWORK ?? 'base-sepolia',
            amount: pi.value,
            asset: process.env.SECRETARIAT_ASSET ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            payTo: pi.payTo,
            maxTimeoutSeconds: 300,
            extra: { name: 'USD Coin', version: '2' },
          },
          payload: {
            signature,
            authorization: {
              from: await this.clientAddress(),
              to: pi.payTo,
              value: pi.value,
              validAfter: String(pi.validAfter),
              validBefore: String(pi.validBefore),
              nonce: pi.nonce,
            },
          },
        });
        if (payRes.status !== 200) {
          const errBody = payRes.body as { error?: { code?: string } };
          rejectedCode = errBody?.error?.code ?? `HTTP_${payRes.status}`;
          observations.push('failed');
        }
      }

      // ---------------- Poll to terminal (crash-tolerant in S3 mode) --------
      const pollId = requestId ?? known;
      if (pollId && !rejectedCode) {
        const deadline = Date.now() + this.pollDeadlineMs;
        let outageStarted = false;
        let recoveredAfterOutage = false;

        while (Date.now() < deadline) {
          let body: PollResponse | null = null;
          try {
            const res = await this.getJson(`/v1/requests/${pollId}`);
            body = res.body as PollResponse;
            if (outageStarted) {
              recoveredAfterOutage = true;
              outageStarted = false;
            }
          } catch {
            if (!outageStarted) {
              outageStarted = true;
            }
            await sleep(500);
            continue;
          }

          if (body?.settlementTxHash) txHash = body.settlementTxHash;
          if (body?.outcome !== undefined) outcome = body.outcome;
          const st = body?.status ?? '';

          if (
            st === 'COMPLETED' || st === 'FAILED' ||
            st === 'UNRESOLVABLE' || st === 'UNKNOWN'
          ) {
            finalStatus = st;
            break;
          }
          await sleep(400);
        }

        if (!finalStatus) finalStatus = 'PROCESSING_AT_DEADLINE';

        if (txHash && !this.reportedTx.has(txHash)) {
          this.reportedTx.add(txHash);
          observations.push('payment_settled');
        } else if (!txHash && finalStatus === 'COMPLETED') {
          // Completed without a visible tx hash — still exactly one settlement
          // for this requestId from the client's point of view.
          observations.push('payment_settled');
        }

        if (recoveredAfterOutage) {
          observations.push('recovery_completed');
        }

        if (finalStatus === 'COMPLETED') observations.push('success');
        else if (finalStatus === 'FAILED') observations.push('failed');
        else observations.push('delivery_unknown');
      }
    } catch (error) {
      observations.push('failed');
      rejectedCode = rejectedCode ?? 'ADAPTER_ERROR';
      finalStatus = finalStatus ?? 'ADAPTER_ERROR';
      if (process.env.ARGUS_DEBUG_ADAPTER === '1') {
        console.error(`[sec-adapter] ${type} error:`, error instanceof Error ? `${error.message} :: ${(error as { cause?: string }).cause ?? ''}` : error);
      }
      const exchange = this.buildExchange(runId, type, {
        idempotencyKey,
        logicalRequest,
        clientId,
        finalStatus,
        rejectedCode,
        error: error instanceof Error ? error.message : String(error),
      }, observations);
      this.exchanges.push(exchange);
      return exchange;
    }

    const exchange = this.buildExchange(runId, type, {
      idempotencyKey,
      logicalRequest,
      clientId,
      reused,
      rejectedCode: rejectedCode ?? null,
      requestId: this.seenLogical.get(clientId) ?? null,
      finalStatus: finalStatus ?? null,
      settlementTxHash: txHash ?? null,
      outcome: outcome ?? null,
    }, observations);

    this.exchanges.push(exchange);
    return exchange;
  }

  private buildExchange(
    runId: RunId,
    type: string,
    payload: Record<string, unknown>,
    observations: string[],
  ): Exchange {
    return {
      id: generateId('sec-exch'),
      runId,
      direction: MessageDirection.OUTBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.SUCCESS,
      metadata: { observations } as Metadata,
    };
  }

  private async clientAddress(): Promise<string> {
    const { privateKeyToAccount } = await import('viem/accounts');
    return privateKeyToAccount(this.clientKey as `0x${string}`).address;
  }

  private async signEip3009(b: {
    payTo: string;
    value: string;
    nonceHex: string;
    validAfter: string;
    validBefore: string;
  }): Promise<string> {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(this.clientKey as `0x${string}`);
    const chainId = Number.parseInt(process.env.SECRETARIAT_CHAIN_ID ?? '84532', 10);
    return await account.signTypedData({
      domain: {
        name: process.env.SECRETARIAT_ASSET_NAME ?? 'USD Coin',
        version: process.env.SECRETARIAT_ASSET_VERSION ?? '2',
        chainId,
        verifyingContract: (process.env.SECRETARIAT_ASSET ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: b.payTo as `0x${string}`,
        value: BigInt(b.value),
        validAfter: BigInt(b.validAfter),
        validBefore: BigInt(b.validBefore),
        nonce: b.nonceHex as `0x${string}`,
      },
    });
  }

  private async postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
      return { status: res.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'GET' });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  }

  async receive(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    const exchange: Exchange = {
      id: generateId('sec-exch'),
      runId,
      direction: MessageDirection.INBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.SUCCESS,
    };
    this.exchanges.push(exchange);
    return exchange;
  }

  async captureEvidence(
    runId: RunId,
    type: string,
    data: unknown,
    description?: string,
  ): Promise<Evidence> {
    const evidence: Evidence = {
      id: generateId('sec-evid'),
      runId,
      type,
      timestamp: Date.now(),
      data,
      description,
      metadata: { adapterType: 'secretariat', adapterId: this.id } as Metadata,
    };
    this.evidences.push(evidence);
    return evidence;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = undefined;
  }
}
