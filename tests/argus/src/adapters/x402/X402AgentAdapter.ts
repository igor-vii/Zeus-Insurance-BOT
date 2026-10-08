/**
 * X402AgentAdapter - x402 V2 Protocol Implementation of PaymentCapablePort
 * 
 * This adapter enables Argus to communicate with AI agents that implement
 * the x402 V2 payment protocol. It handles:
 * - Detecting HTTP 402 Payment Required responses
 * - Parsing payment requirements from the 'payment-required' header
 * - Retrying requests with a 'payment-signature' header
 * - Capturing payment responses from the 'payment-response' header
 * 
 * PRINCIPLES:
 * - Does NOT know about payment semantics (amounts, assets, networks)
 * - Does NOT sign payments or interact with PaymentAdapter
 * - Only handles x402 transport concerns (headers, status codes, parsing)
 * - Semantic interpretation happens in Argus Core / Secretariat
 */

import {
  AgentTargetPort,
  PaymentCapablePort,
  TargetConnectionConfig,
  ConnectionResult,
  Exchange,
  Evidence,
  MessageDirection,
  ExchangeStatus,
  RunId,
  Metadata,
  PaymentRequired,
  X402PaymentRequiredBody,
  X402Accept,
} from '../../core/AgentTargetPort';

/**
 * Generate a unique ID
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * L3 — outbound x402 observation wiring.
 *
 * Derive the canonical transport-level observation carrier
 * (`exchange.metadata.observations: string[]`) from facts Argus directly
 * observes at the HTTP boundary of a RESPONSE ACTUALLY RECEIVED from the SUT.
 *
 * Vocabulary reuses existing accepted observation names only:
 * - 'http_response_received' — an HTTP response was received (mirrors the
 *   existing MockTargetAdapter 'response_received' transport observation).
 * - 'payment_required_received' — the response carried HTTP status 402
 *   (the canonical inbound counterpart 'payment_required_issued' already
 *   exists in X402SellerAdapter / S9).
 *
 * These records state NOTHING about payment success, settlement, delivery,
 * or seller correctness — those are not observable from the HTTP response
 * itself. Transport/timeout paths (no HTTP response observed) produce no
 * observations.
 */
function deriveHttpObservations(response: { status: number }): string[] {
  const observations = ['http_response_received'];
  if (response.status === 402) {
    observations.push('payment_required_received');
  }
  return observations;
}

/**
 * Parse the 'payment-required' header (Base64-encoded JSON) into PaymentRequired.
 * Falls back to parsing the response body if header is missing.
 */
function parsePaymentRequired(
  response: { status: number; headers: Record<string, string>; data: unknown }
): PaymentRequired | null {
  // Try header first (lowercase key)
  const headerValue = response.headers['payment-required'];
  
  let rawBase64: string | undefined;
  let parsedBody: X402PaymentRequiredBody | undefined;

  if (headerValue) {
    rawBase64 = headerValue;
    try {
      const decoded = Buffer.from(headerValue, 'base64').toString('utf-8');
      const maybeBody = JSON.parse(decoded) as Partial<X402PaymentRequiredBody>;

      // Validate structure before accepting
      if (
        maybeBody.x402Version === 2 &&
        typeof maybeBody.resource === 'object' &&
        maybeBody.resource !== null &&
        typeof maybeBody.resource.url === 'string' &&
        Array.isArray(maybeBody.accepts) &&
        maybeBody.accepts.length > 0
      ) {
        parsedBody = maybeBody as X402PaymentRequiredBody;
      } else {
        // Header present but structurally invalid — fall through to body
        rawBase64 = undefined;
      }
    } catch {
      // Header present but not Base64/JSON — fall through to body
      rawBase64 = undefined;
    }
  }

  // Fallback: try response body
  if (!parsedBody && typeof response.data === 'object' && response.data !== null) {
    const body = response.data as Partial<X402PaymentRequiredBody>;
    if (
      body.x402Version === 2 &&
      typeof body.resource === 'object' &&
      body.resource !== null &&
      typeof body.resource.url === 'string' &&
      Array.isArray(body.accepts)
    ) {
      parsedBody = body as X402PaymentRequiredBody;
      // Encode body back to Base64 for raw field
      rawBase64 = Buffer.from(JSON.stringify(body)).toString('base64');
    }
  }

  if (!parsedBody || !rawBase64 || parsedBody.accepts.length === 0) {
    return null;
  }

  // Extract fields from the first accepted scheme
  const firstAccept = parsedBody.accepts[0];

  return {
    raw: rawBase64,
    parsed: parsedBody,
    scheme: firstAccept.scheme,
    network: firstAccept.network,
    amount: firstAccept.amount,
    asset: firstAccept.asset,
    payTo: firstAccept.payTo,
    maxTimeoutSeconds: firstAccept.maxTimeoutSeconds,
  };
}

export class X402AgentAdapter implements PaymentCapablePort {
  private id: string;
  private targetType: string;
  private connected: boolean = false;
  private config?: TargetConnectionConfig;
  private baseUrl?: string;
  private exchanges: Exchange[] = [];
  private evidences: Evidence[] = [];

  constructor(targetType: string = 'x402-target') {
    this.id = generateId('x402-adapter');
    this.targetType = targetType;
  }

  getId(): string {
    return this.id;
  }

  getTargetType(): string {
    return this.targetType;
  }

  async connect(config: TargetConnectionConfig): Promise<ConnectionResult> {
    if (config.transportType !== 'x402') {
      return {
        success: false,
        error: `Invalid transport type: expected 'x402', got '${config.transportType}'`,
      };
    }

    if (!config.endpoint) {
      return {
        success: false,
        error: 'x402 endpoint URL is required',
      };
    }

    try {
      // Validate URL format
      new URL(config.endpoint);

      this.config = config;
      this.baseUrl = config.endpoint;
      this.connected = true;

      return {
        success: true,
        connectionId: generateId('x402-conn'),
      };
    } catch (error) {
      return {
        success: false,
        error: `Invalid URL format: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  isConnected(): boolean {
    return this.connected && !!this.baseUrl;
  }

  async send(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    if (!this.isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const exchange: Exchange = {
      id: generateId('x402-exch'),
      runId,
      direction: MessageDirection.OUTBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.PENDING,
    };

    try {
      if (!this.baseUrl) {
        throw new Error('Base URL not configured');
      }

      const response = await this.makeHttpRequest(this.baseUrl, payload);

      // L3: externally observable HTTP facts become canonical transport-level
      // observations consumed by the existing ScenarioEngine translation loop.
      const observations = deriveHttpObservations(response);

      // Handle HTTP 402 Payment Required
      if (response.status === 402) {
        const paymentRequired = parsePaymentRequired(response);
        
        exchange.status = ExchangeStatus.PAYMENT_REQUIRED;
        exchange.payload = response.data;
        exchange.paymentRequired = paymentRequired ?? undefined;
        exchange.metadata = {
          statusCode: response.status,
          headers: response.headers,
          observations,
        } as Metadata;

        // If we couldn't parse payment requirements, record as failure
        if (!paymentRequired) {
          exchange.status = ExchangeStatus.FAILURE;
          exchange.error = 'Received 402 but could not parse payment requirements';
        }
      } else if (response.status >= 200 && response.status < 300) {
        exchange.status = ExchangeStatus.SUCCESS;
        exchange.payload = response.data;
        exchange.metadata = {
          statusCode: response.status,
          headers: response.headers,
          observations,
        } as Metadata;
      } else {
        exchange.status = ExchangeStatus.FAILURE;
        exchange.error = `HTTP ${response.status}: ${response.statusText || 'Unknown error'}`;
        exchange.metadata = {
          statusCode: response.status,
          headers: response.headers,
          observations,
        } as Metadata;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('timeout');

      exchange.status = isTimeout ? ExchangeStatus.TIMEOUT : ExchangeStatus.FAILURE;
      exchange.error = errorMessage;
      exchange.metadata = {
        errorType: error instanceof Error ? error.constructor.name : 'unknown',
      } as Metadata;
    }

    this.exchanges.push(exchange);
    return exchange;
  }

  async sendWithSignature(
    runId: RunId,
    type: string,
    payload: unknown,
    paymentSignature: string
  ): Promise<Exchange> {
    if (!this.isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const exchange: Exchange = {
      id: generateId('x402-exch'),
      runId,
      direction: MessageDirection.OUTBOUND,
      type,
      timestamp: Date.now(),
      payload,
      status: ExchangeStatus.PENDING,
    };

    try {
      if (!this.baseUrl) {
        throw new Error('Base URL not configured');
      }

      // Add payment-signature header
      const extraHeaders: Record<string, string> = {
        'payment-signature': paymentSignature,
      };

      const response = await this.makeHttpRequest(this.baseUrl, payload, extraHeaders);

      // Capture payment-response header if present
      const paymentResponseHeader = response.headers['payment-response'];
      // L3: same minimal wiring for the signed-retry response — only facts
      // directly observed at the HTTP boundary, nothing about payment
      // success/settlement/delivery.
      const metadata: Metadata = {
        statusCode: response.status,
        headers: response.headers,
        observations: deriveHttpObservations(response),
      };
      if (paymentResponseHeader) {
        metadata.paymentResponse = paymentResponseHeader;
      }

      // Handle HTTP 402 again (signature may have been rejected)
      if (response.status === 402) {
        const paymentRequired = parsePaymentRequired(response);
        
        exchange.status = ExchangeStatus.PAYMENT_REQUIRED;
        exchange.payload = response.data;
        exchange.paymentRequired = paymentRequired ?? undefined;
        exchange.metadata = metadata;

        if (!paymentRequired) {
          exchange.status = ExchangeStatus.FAILURE;
          exchange.error = 'Received 402 but could not parse payment requirements';
        }
      } else if (response.status >= 200 && response.status < 300) {
        exchange.status = ExchangeStatus.SUCCESS;
        exchange.payload = response.data;
        exchange.metadata = metadata;
      } else {
        exchange.status = ExchangeStatus.FAILURE;
        exchange.error = `HTTP ${response.status}: ${response.statusText || 'Unknown error'}`;
        exchange.metadata = metadata;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('timeout');

      exchange.status = isTimeout ? ExchangeStatus.TIMEOUT : ExchangeStatus.FAILURE;
      exchange.error = errorMessage;
      exchange.metadata = {
        errorType: error instanceof Error ? error.constructor.name : 'unknown',
      } as Metadata;
    }

    this.exchanges.push(exchange);
    return exchange;
  }

  async receive(runId: RunId, type: string, payload?: unknown): Promise<Exchange> {
    if (!this.isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const exchange: Exchange = {
      id: generateId('x402-exch'),
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
    description?: string
  ): Promise<Evidence> {
    const evidence: Evidence = {
      id: generateId('x402-evid'),
      runId,
      type,
      timestamp: Date.now(),
      data,
      description,
      metadata: {
        adapterType: 'x402',
        adapterId: this.id,
      } as Metadata,
    };

    this.evidences.push(evidence);
    return evidence;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.baseUrl = undefined;
    this.config = undefined;
  }

  /**
   * Make an HTTP request with timeout and optional extra headers
   */
  private async makeHttpRequest(
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; data: unknown }> {
    // HTTP method is configurable via transport options; default keeps the
    // existing POST behavior for all current targets/fixtures.
    const configuredMethod = typeof this.config?.options?.method === 'string'
      ? (this.config.options.method as string).toUpperCase()
      : undefined;
    const method = configuredMethod ?? 'POST';
    const configHeaders: Record<string, string> = (this.config?.options?.headers as Record<string, string>) ?? {};
    const additionalHeaders: Record<string, string> = extraHeaders ?? {};
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...configHeaders,
      ...additionalHeaders,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
      // GET/HEAD requests cannot carry a body (fetch throws otherwise);
      // query parameters live in the endpoint URL for such resources.
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) }),
    };

    const timeoutMs = this.config?.timeoutMs ?? 30000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let data: unknown;
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }

      throw error;
    }
  }

  /**
   * Get all recorded exchanges (for testing/inspection)
   */
  getExchanges(): Exchange[] {
    return [...this.exchanges];
  }

  /**
   * Get all recorded evidence (for testing/inspection)
   */
  getEvidences(): Evidence[] {
    return [...this.evidences];
  }

  /**
   * Reset adapter state (for testing)
   */
  reset(): void {
    this.connected = false;
    this.baseUrl = undefined;
    this.config = undefined;
    this.exchanges = [];
    this.evidences = [];
  }
}
