/**
 * TargetAdapterRegistry — selection mechanism for TargetAdapters (Block B2).
 *
 * Terminology:
 * - SUT (System Under Test) — the agent Argus connects to via AgentTargetPort.
 * - TargetAdapter — an implementation of AgentTargetPort (Mock / HTTP / X402).
 *
 * PRINCIPLES:
 * - Depends ONLY on core/AgentTargetPort and the three existing adapters.
 * - Knows NOTHING about payments: no imports from src/adapters/payment/*,
 *   no PaymentAdapter, no SigningBinding, no EIP-3009.
 * - Uses the existing AdapterFactory type from core/AgentTargetPort as the
 *   registration shape. No new factory type is introduced.
 * - MockTargetAdapter remains a test SUT simulator; this registry simply
 *   makes it one selectable option among others instead of the only one.
 */

import {
  AgentTargetPort,
  AdapterFactory,
  TargetConnectionConfig,
} from '../core/AgentTargetPort';
import { MockTargetAdapter } from '../adapters/MockTargetAdapter';
import { HttpAgentAdapter } from '../adapters/http/HttpAgentAdapter';
import { X402AgentAdapter } from '../adapters/x402/X402AgentAdapter';

export type TargetKind = 'mock' | 'http' | 'x402';

export interface TargetAdapterSpec {
  kind: TargetKind;
  /** SUT URL. Required for kind='http' | 'x402'. */
  endpoint?: string;
  options?: Record<string, unknown>;
}

/**
 * Resolve env-driven target configuration.
 *
 *   ARGUS_TARGET_KIND     = mock | http | x402   (default: mock)
 *   ARGUS_TARGET_ENDPOINT = <url>                (required if kind != mock)
 *
 * Throws on unknown kind or missing endpoint for http/x402.
 * The CLI turns these errors into process.exit(1) with a readable message.
 */
export function readTargetSpecFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TargetAdapterSpec {
  const rawKind = env.ARGUS_TARGET_KIND?.trim().toLowerCase();
  const kind: TargetKind = rawKind ? (rawKind as TargetKind) : 'mock';

  if (kind !== 'mock' && kind !== 'http' && kind !== 'x402') {
    throw new Error(
      `Unknown ARGUS_TARGET_KIND '${env.ARGUS_TARGET_KIND}'. ` +
        `Allowed values: mock, http, x402.`
    );
  }

  const endpoint = env.ARGUS_TARGET_ENDPOINT?.trim() || undefined;

  if ((kind === 'http' || kind === 'x402') && !endpoint) {
    throw new Error(
      `ARGUS_TARGET_ENDPOINT is required when ARGUS_TARGET_KIND='${kind}' ` +
        `(SUT URL to connect to).`
    );
  }

  return { kind, endpoint };
}

/**
 * Build a connection config compatible with the selected adapter's connect().
 * transportType matches the kind ('mock' | 'http' | 'x402'); endpoint is
 * carried through for HTTP/X402 adapters (ignored by Mock).
 */
export function buildConnectionConfig(spec: TargetAdapterSpec): TargetConnectionConfig {
  return {
    transportType: spec.kind,
    ...(spec.endpoint ? { endpoint: spec.endpoint } : {}),
    ...(spec.options ? { options: spec.options } : {}),
  };
}

export class TargetAdapterRegistry {
  private factories = new Map<TargetKind, AdapterFactory>();

  /**
   * Register a factory under a kind. Existing AdapterFactory signature from
   * core/AgentTargetPort is reused: (targetType: string) => AgentTargetPort.
   */
  register(kind: TargetKind, factory: AdapterFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  /**
   * Create the TargetAdapter for the given spec.
   * Throws for unknown kinds and for http/x402 without endpoint.
   */
  create(spec: TargetAdapterSpec): AgentTargetPort {
    const factory = this.factories.get(spec.kind);
    if (!factory) {
      const known = Array.from(this.factories.keys()).join(', ');
      throw new Error(
        `Unknown target kind '${spec.kind}'. Registered kinds: ${known}.`
      );
    }

    if ((spec.kind === 'http' || spec.kind === 'x402') && !spec.endpoint) {
      throw new Error(
        `Target adapter '${spec.kind}' requires an endpoint (SUT URL).`
      );
    }

    // targetType carries the kind; endpoint/options reach the adapter later
    // via connect(buildConnectionConfig(spec)) — adapters take endpoint at
    // connect()-time, not construction-time (see their current signatures).
    return factory(spec.kind);
  }

  /** Registry with the three built-in adapters pre-registered. */
  static default(): TargetAdapterRegistry {
    return new TargetAdapterRegistry()
      .register('mock', (targetType: string) => new MockTargetAdapter(targetType))
      .register('http', (targetType: string) => new HttpAgentAdapter(targetType))
      .register('x402', (targetType: string) => new X402AgentAdapter(targetType));
  }
}
