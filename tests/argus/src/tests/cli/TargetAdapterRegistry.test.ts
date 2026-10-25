/**
 * Block B2 tests — TargetAdapterRegistry + env-driven target selection.
 * No real HTTP servers are started; adapters are only constructed,
 * never connected (construction is offline / side-effect free).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  TargetAdapterRegistry,
  readTargetSpecFromEnv,
} from '../../cli/TargetAdapterRegistry';
import { MockTargetAdapter } from '../../adapters/MockTargetAdapter';
import { HttpAgentAdapter } from '../../adapters/http/HttpAgentAdapter';
import { X402AgentAdapter } from '../../adapters/x402/X402AgentAdapter';

describe('TargetAdapterRegistry (B2)', () => {
  // Test B2-1 — registry: mock
  it('B2-1: create({kind:"mock"}) returns MockTargetAdapter', () => {
    const adapter = TargetAdapterRegistry.default().create({ kind: 'mock' });
    expect(adapter).toBeInstanceOf(MockTargetAdapter);
  });

  // Test B2-2 — registry: x402 with endpoint
  it('B2-2: create({kind:"x402", endpoint}) returns X402AgentAdapter', () => {
    const adapter = TargetAdapterRegistry.default().create({
      kind: 'x402',
      endpoint: 'http://x',
    });
    expect(adapter).toBeInstanceOf(X402AgentAdapter);
  });

  // Test B2-3 — registry: http with endpoint
  it('B2-3: create({kind:"http", endpoint}) returns HttpAgentAdapter', () => {
    const adapter = TargetAdapterRegistry.default().create({
      kind: 'http',
      endpoint: 'http://x',
    });
    expect(adapter).toBeInstanceOf(HttpAgentAdapter);
  });

  // Test B2-4 — registry: x402 without endpoint → throw
  it('B2-4: create({kind:"x402"}) without endpoint throws', () => {
    expect(() =>
      TargetAdapterRegistry.default().create({ kind: 'x402' })
    ).toThrow(/requires an endpoint/);
  });

  it('B2-4b: create({kind:"http"}) without endpoint throws', () => {
    expect(() =>
      TargetAdapterRegistry.default().create({ kind: 'http' })
    ).toThrow(/requires an endpoint/);
  });

  it('B2-4c: create with unknown kind throws', () => {
    expect(() =>
      TargetAdapterRegistry.default().create({ kind: 'grpc' as never })
    ).toThrow(/Unknown target kind 'grpc'/);
  });

  it('registry does not import anything from adapters/payment/*', () => {
    const src = readFileSync(
      resolve(__dirname, '../../cli/TargetAdapterRegistry.ts'),
      'utf-8'
    );
    // Only actual import specifiers are checked (comments may mention the
    // forbidden layer to document WHY it is forbidden).
    const importSpecifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1]
    );
    expect(importSpecifiers).toEqual([
      '../core/AgentTargetPort',
      '../adapters/MockTargetAdapter',
      '../adapters/http/HttpAgentAdapter',
      '../adapters/x402/X402AgentAdapter',
    ]);
    for (const spec of importSpecifiers) {
      expect(spec).not.toMatch(/payment/i);
    }
  });
});

describe('readTargetSpecFromEnv (B2)', () => {
  // Test B2-5 — env default
  it('B2-5: no ARGUS_TARGET_KIND → kind "mock", no endpoint', () => {
    const spec = readTargetSpecFromEnv({});
    expect(spec).toEqual({ kind: 'mock', endpoint: undefined });
  });

  it('B2-5b: explicit mock kind → mock, endpoint optional', () => {
    expect(readTargetSpecFromEnv({ ARGUS_TARGET_KIND: 'mock' }).kind).toBe('mock');
    expect(
      readTargetSpecFromEnv({ ARGUS_TARGET_KIND: 'X402 ', ARGUS_TARGET_ENDPOINT: 'http://sut' })
    ).toEqual({ kind: 'x402', endpoint: 'http://sut' });
  });

  // Test B2-6 — env x402/http without endpoint → throw
  it('B2-6: kind=x402 without endpoint throws with readable message', () => {
    expect(() => readTargetSpecFromEnv({ ARGUS_TARGET_KIND: 'x402' })).toThrow(
      /ARGUS_TARGET_ENDPOINT is required when ARGUS_TARGET_KIND='x402'/
    );
  });

  it('B2-6b: kind=http without endpoint throws', () => {
    expect(() => readTargetSpecFromEnv({ ARGUS_TARGET_KIND: 'http' })).toThrow(
      /ARGUS_TARGET_ENDPOINT is required when ARGUS_TARGET_KIND='http'/
    );
  });

  // Test B2-7 — env unknown kind → throw
  it('B2-7: unknown kind throws listing allowed values', () => {
    expect(() => readTargetSpecFromEnv({ ARGUS_TARGET_KIND: 'carrier-pigeon' })).toThrow(
      /Unknown ARGUS_TARGET_KIND 'carrier-pigeon'\. Allowed values: mock, http, x402/
    );
  });
});
