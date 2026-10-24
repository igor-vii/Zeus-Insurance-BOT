/**
 * HttpAgentAdapter - HTTP Protocol Implementation of AgentTargetPort
 * 
 * This adapter enables Argus to communicate with any AI agent via HTTP API.
 * It is protocol-specific but target-agnostic - the same adapter works with
 * any HTTP-based target agent through configuration.
 * 
 * PRINCIPLES:
 * - Does NOT know about any specific target, payment, or business semantics
 * - Only handles HTTP transport concerns (URL, method, headers, status codes)
 * - Returns raw response data; interpretation happens in Argus Core
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

/**
 * HTTP-specific connection options
 */
export interface HttpConnectionOptions {
  /** HTTP method (default: POST) */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  
  /** HTTP headers to include in requests */
  headers?: Record<string, string>;
  
  /** Whether to include credentials (cookies, auth headers) */
  withCredentials?: boolean;
  
  /** Expected content type (default: 'application/json') */
  contentType?: string;
  
  /** Custom request transformer function (serialized as config) */
  transformRequest?: string;
  
  /** Custom response transformer function (serialized as config) */
  transformResponse?: string;
}

/**
 * Extended config for HTTP connections
 */
interface HttpConnectionConfig extends TargetConnectionConfig {
  transportType: 'http';
  endpoint?: string;
  options?: HttpConnectionOptions & Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Generate a unique ID
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * HTTP Adapter implementation
 */
export class HttpAgentAdapter implements AgentTargetPort {
  private id: string;
  private targetType: string;
  private connected: boolean = false;
  private config?: HttpConnectionConfig;
  private baseUrl?: string;
  private exchanges: Exchange[] = [];
  private evidences: Evidence[] = [];

  constructor(targetType: string = 'http-target') {
    this.id = generateId('http-adapter');
    this.targetType = targetType;
  }

  getId(): string {
    return this.id;
  }

  getTargetType(): string {
    return this.targetType;
  }

  async connect(config: TargetConnectionConfig): Promise<ConnectionResult> {
    if (config.transportType !== 'http') {
      return {
        success: false,
        error: `Invalid transport type: expected 'http', got '${config.transportType}'`,
      };
    }

    const httpConfig = config as HttpConnectionConfig;

    if (!httpConfig.endpoint) {
      return {
        success: false,
        error: 'HTTP endpoint URL is required',
      };
    }

    try {
      // Validate URL format
      new URL(httpConfig.endpoint);
      
      this.config = httpConfig;
      this.baseUrl = httpConfig.endpoint;
      this.connected = true;

      return {
        success: true,
        connectionId: generateId('http-conn'),
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
      id: generateId('http-exch'),
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
      
      exchange.status = ExchangeStatus.SUCCESS;
      exchange.payload = response.data;
      exchange.metadata = {
        statusCode: response.status,
        headers: response.headers,
      } as Metadata;

    } catch (error) {
      exchange.status = ExchangeStatus.FAILURE;
      exchange.error = error instanceof Error ? error.message : String(error);
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

    // For HTTP, receive typically means processing an incoming response
    // or polling for new data. Here we simulate receiving by making a GET request
    // or returning provided payload.
    
    const exchange: Exchange = {
      id: generateId('http-exch'),
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
      id: generateId('http-evid'),
      runId,
      type,
      timestamp: Date.now(),
      data,
      description,
      metadata: {
        adapterType: 'http',
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
   * Make an HTTP request with configured options
   */
  private async makeHttpRequest(
    url: string,
    body?: unknown
  ): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
    const method = this.config?.options?.method ?? 'POST';
    const headers: Record<string, string> = {
      'Content-Type': this.config?.options?.contentType ?? 'application/json',
      ...this.config?.options?.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
    };

    if (this.config?.options?.withCredentials) {
      fetchOptions.credentials = 'include';
    }

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

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return {
        status: response.status,
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
