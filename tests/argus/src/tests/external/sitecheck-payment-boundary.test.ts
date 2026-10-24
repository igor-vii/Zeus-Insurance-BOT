// ============================================================
// src/tests/external/sitecheck-payment-boundary.test.ts
// ============================================================
//
// E2E-SITECHECK-BOUNDARY — Argus Phase 3: first real external behavioral
// test of Sitecheck through its public interface.
//
// The Phase-2 smoke test proved the CAPABILITY of Argus (reach an opaque
// x402 target, use GET for a GET-only resource, observe HTTP 402, parse
// x402 v2 requirements, produce evidence + verdict). This scenario goes one
// step further and answers the narrow behavioral question:
//
//   Can Argus drive a real public Sitecheck resource up to the payment
//   boundary and produce structured evidence proving what actually happened?
//
// Scope (black-box, public HTTP/x402 surface ONLY):
//   1. discover Sitecheck's public x402 requirements (GET /.well-known/x402)
//   2. request the protected audit resource via the FULL Argus pipeline
//      (X402AgentAdapter -> AgentController -> ScenarioEngine ->
//       EvidenceCollector -> AssertionEngine), method=GET via existing
//       connectionConfig.options, NO payment resolver
//   3. receive HTTP 402
//   4. observe/parse the x402 v2 payment requirement
//   5. cross-check the requirement against the discovery entry for
//      GET /api/audit (deterministic selection by path+method)
//   6. produce evidence records + artifact
//   7. classify the execution as PAYMENT_REQUIRED — NOT success, NOT failure
//
// SEMANTIC RULE: this is a successful OBSERVATION OF THE PAYMENT BOUNDARY,
// not a successful Sitecheck audit. No payment is performed: no signing, no
// wallet, no broadcast, no payment resolver, no private key. If the live
// target behavior changes, the result is classified honestly
// (EXTERNAL TARGET BEHAVIOR / TEST ASSUMPTION / ARGUS BUG), never upgraded.
// UNKNOWN ≠ FAILURE, TIMEOUT ≠ FAILURE.
//
// Reuses everything that exists: adapter, controller, engine, collector,
// assertion engine, TargetConnectionConfig.options, ExchangeStatus,
// PaymentRequired parsing. No new adapter, no engine changes, no new env
// variables, no production code touched.
//
// Opt-out: SKIP_EXTERNAL_TESTS=1 (same convention as sitecheck-smoke).

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { X402AgentAdapter } from '../../adapters/x402/X402AgentAdapter';
import { AgentController } from '../../core/AgentController';
import { ScenarioEngine } from '../../core/ScenarioEngine';
import { ExecutionRegistry } from '../../core/ExecutionRegistry';
import { FaultInjector } from '../../core/FaultInjector';
import { EvidenceCollector } from '../../core/EvidenceCollector';
import { AssertionEngine } from '../../core/AssertionEngine';
import { RunContext, RunStatus, generateRunId } from '../../core/RunLifecycle';
import { ExchangeStatus } from '../../core/AgentTargetPort';
import type { PaymentRequired } from '../../core/AgentTargetPort';
import type { ScenarioDefinition } from '../../core/ScenarioDefinition';

const BASE = 'https://api.sitecheck-api.workers.dev';
const AUDIT_URL = `${BASE}/api/audit?url=${encodeURIComponent('https://example.com')}`;
const DISCOVERY_URL = `${BASE}/.well-known/x402`;

const skip = process.env.SKIP_EXTERNAL_TESTS === '1';

/** USDC contract addresses advertised by the target itself (public values). */
const KNOWN_USDC_ASSETS = [
  /^0x833589fcd6edb6e08f4c7c32d4f71b54bda02913$/i, // Base mainnet USDC
  /^0x3600000000000000000000000000000000000000$/i, // Arc (eip155:5042) native USDC address
];

// ------------------------------------------------------------
// Public fetch helpers (raw observable data, black-box only)
// ------------------------------------------------------------

async function fetchRaw(url: string, init?: RequestInit): Promise<{
  status: number;
  ct: string | null;
  headers: Record<string, string>;
  body: unknown;
}> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type');
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = ct?.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, ct, headers, body };
}

/**
 * Shape of the public /.well-known/x402 document AS ACTUALLY SERVED by
 * Sitecheck (observed live in Phase-1 recon and re-verified here):
 *   resources: string[]           — plain URL list (no per-resource payment fields)
 *   endpoints: object[]           — { url, method, price, amount, description, networks[] }
 *   networks:  object[]           — chain descriptors
 * We model only what is publicly exposed; nothing is invented.
 */
interface DiscoveryEndpoint {
  url?: string;
  method?: string;
  price?: string;
  amount?: string;
  description?: string;
  networks?: string[];
  scheme?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  [k: string]: unknown;
}

interface DiscoveryDoc {
  version?: string;
  x402Version?: number;
  name?: string;
  description?: string;
  resources?: unknown[];
  endpoints?: DiscoveryEndpoint[];
  networks?: unknown[];
  [k: string]: unknown;
}

/**
 * Deterministically select the discovery entry corresponding to
 * GET /api/audit. Selection rule: endpoint whose url path is exactly
 * '/api/audit' AND method 'GET'. Ambiguity (>1 match) is reported, never
 * guessed between.
 */
function selectAuditDiscovery(doc: DiscoveryDoc): {
  endpoint: DiscoveryEndpoint | null;
  ambiguity: string | null;
} {
  const endpoints = (doc.endpoints ?? []).filter((e) => {
    if (String(e.method).toUpperCase() !== 'GET') return false;
    try {
      return typeof e.url === 'string' && new URL(e.url).pathname === '/api/audit';
    } catch {
      return false;
    }
  });

  const ambiguity =
    endpoints.length > 1 ? `multiple GET /api/audit endpoints (${endpoints.length})` : null;

  return {
    endpoint: endpoints.length === 1 ? endpoints[0] : null,
    ambiguity,
  };
}

/** Flatten every payment-option view found in a discovery endpoint entry. */
function collectDiscoveryOptions(entry: DiscoveryEndpoint): Array<{
  scheme?: string;
  network?: string;
  networks?: string[];
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
}> {
  const out: Array<{
    scheme?: string;
    network?: string;
    networks?: string[];
    amount?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
  }> = [];
  // direct fields on the endpoint entry (as actually served: method/price/amount/networks[]).
  // Index-signature values are `unknown`; narrow explicitly.
  out.push({
    scheme: typeof entry.scheme === 'string' ? entry.scheme : undefined,
    network: typeof entry.network === 'string' ? entry.network : undefined,
    networks: Array.isArray(entry.networks) ? (entry.networks as string[]) : undefined,
    amount: typeof entry.amount === 'string' ? entry.amount : undefined,
    asset: typeof entry.asset === 'string' ? entry.asset : undefined,
    payTo: typeof entry.payTo === 'string' ? entry.payTo : undefined,
    maxTimeoutSeconds: typeof entry.maxTimeoutSeconds === 'number' ? entry.maxTimeoutSeconds : undefined,
  });
  // nested accepts[] arrays (mirrors x402 requirement shape), if ever exposed
  for (const key of ['accepts', 'payment', 'requirements']) {
    const arr = entry[key];
    if (Array.isArray(arr)) {
      for (const a of arr) {
        if (a && typeof a === 'object') out.push(a as (typeof out)[0]);
      }
    } else if (arr && typeof arr === 'object') {
      out.push(arr as (typeof out)[0]);
    }
  }
  return out;
}

/**
 * Consistency check between the 402-observed requirement and the discovery
 * entry for GET /api/audit. Only fields actually exposed by BOTH sides are
 * compared; absent discovery fields are recorded as "not-exposed" — we do not
 * invent fields Sitecheck does not publish.
 */
function compareRequirementVsDiscovery(
  pr: PaymentRequired,
  discEntry: DiscoveryEndpoint,
  discOpts: Array<{
    scheme?: string;
    network?: string;
    networks?: string[];
    amount?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
  }>
): Record<string, { expected: unknown; observed: unknown; consistent: boolean | 'not-exposed' }> {
  const norm = (v: unknown) => String(v).toLowerCase();

  const fieldMatch = (field: 'scheme' | 'asset' | 'payTo' | 'maxTimeoutSeconds') => {
    const values = discOpts.map((o) => o[field]).filter((v) => v !== undefined);
    const observed = pr.parsed.accepts.map((a) => a[field]).concat([pr[field] as never]);
    if (values.length === 0) {
      return { expected: null, observed, consistent: 'not-exposed' as const };
    }
    const consistent = observed.some((o) => values.some((v) => norm(v) === norm(o)));
    return { expected: values, observed, consistent };
  };

  // network(s): discovery exposes networks[] (list), requirement exposes per-accept network.
  const netValues = discOpts.flatMap((o) => (o.networks ? o.networks : o.network ? [o.network] : []));
  const netObserved = pr.parsed.accepts.map((a) => a.network).concat([pr.network]);
  const networkRes: { expected: unknown; observed: unknown; consistent: boolean | 'not-exposed' } =
    netValues.length === 0
      ? { expected: null, observed: netObserved, consistent: 'not-exposed' }
      : {
          expected: netValues,
          observed: netObserved,
          // consistency direction used here: every offered accept-network must be
          // among the advertised discovery networks (no unadvertised network served).
          consistent: netObserved.every((n) => netValues.some((v) => norm(v) === norm(n))),
        };

  // amount: discovery exposes amount string; verify overlap with observed accepts.
  const amountValues = discOpts.map((o) => o.amount).filter((v) => v !== undefined);
  const amountObserved = pr.parsed.accepts.map((a) => a.amount).concat([pr.amount]);
  const amountRes: { expected: unknown; observed: unknown; consistent: boolean | 'not-exposed' } =
    amountValues.length === 0
      ? { expected: null, observed: amountObserved, consistent: 'not-exposed' }
      : {
          expected: amountValues,
          observed: amountObserved,
          consistent: amountObserved.some((a) => amountValues.some((v) => norm(v) === norm(a))),
        };

  return {
    // HTTP method: discovery entry vs the request Argus actually made (GET) — checked separately.
    method: {
      expected: discEntry.method,
      observed: 'GET',
      consistent: String(discEntry.method).toUpperCase() === 'GET',
    },
    scheme: fieldMatch('scheme'),
    network: networkRes,
    amount: amountRes,
    asset: fieldMatch('asset'),
    payTo: fieldMatch('payTo'),
    maxTimeoutSeconds: fieldMatch('maxTimeoutSeconds'),
  };
}

// ------------------------------------------------------------
// Argus scenario definition (existing model, same shape as S8/smoke)
// ------------------------------------------------------------

const SITECHECK_BOUNDARY: ScenarioDefinition = {
  id: 'SITECHECK-BOUNDARY',
  name: 'Sitecheck payment-boundary behavioral test (no payment)',
  description:
    'Drive the real public Sitecheck audit resource (GET) up to the x402 ' +
    'payment boundary via the standard Argus pipeline with NO payment ' +
    'resolver; observe, parse and classify HTTP 402 as PAYMENT_REQUIRED.',
  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    { participantId: 'sitecheck-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' },
  ],
  topology: { edges: [{ from: 'client-1', to: 'sitecheck-1', kind: 'request' }] },
  testSubject: 'sitecheck-1',
  actions: [
    {
      actor: 'client-1',
      type: 'request_resource',
      payload: { resourceId: 'sitecheck-audit-example-com' },
    },
  ],
  faults: [],
  invariants: [
    {
      id: 'boundary_observed_not_paid',
      description:
        'Argus must reach the payment boundary, observe a valid x402 v2 ' +
        'requirement, classify the outcome as PAYMENT_REQUIRED, and must NOT ' +
        'submit any payment. Paid execution is therefore NOT tested.',
    },
  ],
  assertions: [
    {
      id: 'assert_payment_boundary_classified',
      invariantId: 'boundary_observed_not_paid',
      kind: 'mixed',
      referencedSources: ['engine'],
      evaluate: (evidence) => {
        const eng = evidence.find(
          (e) => e.source === 'engine' && e.type === 'payment_required_no_resolver'
        );
        if (!eng) {
          // Nothing observed/classified yet. UNKNOWN ≠ FAILURE — report honestly.
          return {
            status: 'INCONCLUSIVE' as const,
            reason: 'payment boundary not observed/classified yet (UNKNOWN ≠ FAILURE)',
          };
        }
        const pr = eng.data.paymentRequired as PaymentRequired | undefined;
        if (
          pr &&
          pr.raw &&
          pr.parsed?.x402Version === 2 &&
          Array.isArray(pr.parsed.accepts) &&
          pr.parsed.accepts.length > 0 &&
          pr.payTo &&
          pr.amount
        ) {
          return { status: 'PASS' as const };
        }
        return {
          status: 'FAIL' as const,
          reason: 'payment-required evidence present but structurally incomplete/malformed',
        };
      },
    },
  ],
  seed: 9101,
};

describe.skipIf(skip)('E2E Sitecheck payment-boundary behavioral test (real public target)', () => {
  // --------------------------------------------------------------
  // Test 1 — discovery
  // --------------------------------------------------------------
  it(
    'T1 discovery: public /.well-known/x402 exposes a deterministic GET /api/audit entry',
    async () => {
      const r = await fetchRaw(DISCOVERY_URL);
      expect(r.status).toBe(200);
      const doc = r.body as DiscoveryDoc;
      expect(doc.x402Version).toBe(2);

      const sel = selectAuditDiscovery(doc);
      expect(sel.ambiguity).toBeNull();
      expect(sel.endpoint).not.toBeNull();
      // HTTP method exposed for the audit resource must be GET.
      expect(String(sel.endpoint!.method).toUpperCase()).toBe('GET');
      // The audit resource URL is advertised in the plain resources[] list too.
      expect((doc.resources ?? []).some((x) => typeof x === 'string' && x.includes('/api/audit'))).toBe(true);

      const opts = collectDiscoveryOptions(sel.endpoint!);
      // At least one advertised network must be Base mainnet (eip155:8453),
      // and an amount must be publicly exposed. scheme is NOT exposed per
      // endpoint in the current discovery doc — we assert only what exists.
      const netValues = opts.flatMap((o) => (o.networks ? o.networks : o.network ? [o.network] : []));
      expect(netValues).toContain('eip155:8453');
      expect(opts.some((o) => typeof o.amount === 'string' && /^\d+$/.test(o.amount))).toBe(true);
    },
    30_000
  );

  // --------------------------------------------------------------
  // Test 2 — payment boundary via the full Argus pipeline
  // --------------------------------------------------------------
  it(
    'T2 boundary: Argus pipeline (GET, no payment resolver) reaches HTTP 402 and classifies PAYMENT_REQUIRED with valid x402 v2 requirements',
    async () => {
      const adapter = new X402AgentAdapter('sitecheck-x402-target');
      const controller = new AgentController(adapter, {
        connectionConfig: {
          transportType: 'x402',
          endpoint: AUDIT_URL,
          options: { method: 'GET' },
        },
        runId: `run_${Date.now()}_client-1`,
        timeoutMs: 30_000,
      });

      const connectResult = await controller.connect();
      expect(connectResult.success).toBe(true);

      const context: RunContext = {
        runId: generateRunId(),
        scenarioId: SITECHECK_BOUNDARY.id,
        seed: SITECHECK_BOUNDARY.seed,
        startedAt: new Date(),
        status: RunStatus.CREATED,
      };

      const registry = new ExecutionRegistry();
      controller.setParticipantId('client-1');
      registry.register('client-1', controller);

      const collector = new EvidenceCollector();
      const engine = new ScenarioEngine(
        SITECHECK_BOUNDARY,
        context,
        registry,
        new FaultInjector([]),
        collector
        // NO paymentResolver on purpose: the boundary IS the terminal state.
      );

      await engine.execute();
      await controller.disconnect();

      // --- transport observation ------------------------------------------
      const exchanges = adapter.getExchanges();
      expect(exchanges.length).toBe(1);
      const ex = exchanges[0];

      // Classification of the actual observed status (never upgraded):
      expect(ex.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);
      expect(ex.metadata?.statusCode).toBe(402);

      const pr = ex.paymentRequired!;
      expect(pr).toBeDefined();

      // Requirement internally valid per the existing Argus parser output:
      expect(pr.parsed.x402Version).toBe(2);
      expect(pr.parsed.resource?.url).toContain('/api/audit');
      expect(Array.isArray(pr.parsed.accepts)).toBe(true);
      expect(pr.parsed.accepts.length).toBeGreaterThan(0);

      // Required observable fields (values as returned by the live target):
      expect(pr.parsed.accepts.some((a) => a.scheme === 'exact')).toBe(true);
      expect(pr.parsed.accepts.some((a) => a.network === 'eip155:8453')).toBe(true);
      const usdcOk =
        /usdc|usd coin/i.test(String((pr.parsed.accepts[0] as { extra?: { name?: string } }).extra?.name ?? '')) ||
        KNOWN_USDC_ASSETS.some((re) => re.test(String(pr.asset))) ||
        pr.parsed.accepts.some((a) => KNOWN_USDC_ASSETS.some((re) => re.test(String(a.asset))));
      expect(usdcOk).toBe(true);
      expect(pr.parsed.accepts.every((a) => /^\d+$/.test(String(a.amount)))).toBe(true);
      expect(Number(pr.amount)).toBeGreaterThan(0);
      expect(pr.parsed.accepts.every((a) => typeof a.maxTimeoutSeconds === 'number' && a.maxTimeoutSeconds > 0)).toBe(true);
      expect(pr.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // --- engine evidence record -----------------------------------------
      const records = collector.getAllRecords();
      const prRecord = records.find(
        (r) => r.source === 'engine' && r.type === 'payment_required_no_resolver'
      );
      expect(prRecord).toBeDefined();

      // --- verdict through the existing AssertionEngine --------------------
      const verdict = new AssertionEngine().evaluate(records, SITECHECK_BOUNDARY.assertions);
      // PASS here means "payment boundary correctly observed & classified".
      expect(verdict.status).toBe('PASS');

      // --- no payment attempted -------------------------------------------
      // Only one exchange occurred (the initial unauthenticated GET); a paid
      // retry would have produced additional signed exchanges. No resolver was
      // wired anywhere in this run, so no payment-response header could exist.
      expect(exchanges.length).toBe(1);
      const paymentHeaders = adapter
        .getExchanges()
        .map((e) => JSON.stringify(e.metadata?.headers ?? {}))
        .filter((s) => /payment-response/i.test(s));
      expect(paymentHeaders.length).toBe(0);

      // stash for T3-style artifact writing (single-run artifact below)
      writeArtifact(context.runId, {
        request: { method: 'GET', url: AUDIT_URL, paymentHeaderSent: false },
        exchange: {
          id: ex.id,
          status: ex.status,
          statusCode: ex.metadata?.statusCode ?? null,
          error: ex.error ?? null,
          x402RelevantHeaders: pickX402Headers(ex),
        },
        decodedRequirement: {
          x402Version: pr.parsed.x402Version,
          resourceUrl: pr.parsed.resource?.url,
          accepts: pr.parsed.accepts,
          selected: {
            scheme: pr.scheme,
            network: pr.network,
            amount: pr.amount,
            asset: pr.asset,
            payTo: pr.payTo,
            maxTimeoutSeconds: pr.maxTimeoutSeconds,
          },
        },
        engineEvidence: records,
        verdict,
      });
    },
    60_000
  );

  // --------------------------------------------------------------
  // Test 3 — discovery/resource consistency
  // --------------------------------------------------------------
  it(
    'T3 consistency: the 402 payment requirement matches the deterministic GET /api/audit discovery entry',
    async () => {
      // discovery side (public fetch)
      const d = await fetchRaw(DISCOVERY_URL);
      expect(d.status).toBe(200);
      const doc = d.body as DiscoveryDoc;
      const sel = selectAuditDiscovery(doc);
      expect(sel.ambiguity).toBeNull();
      expect(sel.endpoint).not.toBeNull();
      const discEntry = sel.endpoint!;
      const discOpts = collectDiscoveryOptions(discEntry);

      // resource side (Argus adapter, same mechanism as T2)
      const adapter = new X402AgentAdapter('sitecheck-x402-consistency');
      await adapter.connect({
        transportType: 'x402',
        endpoint: AUDIT_URL,
        options: { method: 'GET' },
      });
      const ex = await adapter.send(`run_${Date.now()}`, 'request_resource', {
        resourceId: 'sitecheck-audit-example-com',
      });
      expect(ex.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);
      const pr = ex.paymentRequired!;

      // resource URL identity: 402 requirement points at the same resource path
      expect(pr.parsed.resource.url).toContain('/api/audit');

      // x402 version consistency
      expect(pr.parsed.x402Version).toBe(doc.x402Version);

      const cmp = compareRequirementVsDiscovery(pr, discEntry, discOpts);

      // Fields that MUST be comparable and consistent on the current public contract:
      expect(cmp.method.consistent).toBe(true); // discovery GET vs actual GET → 402
      expect(cmp.network.consistent).toBe(true); // served accepts ⊆ advertised networks
      expect(cmp.amount.consistent).toBe(true); // advertised amount matches a served accept
      // Fields the discovery doc does NOT expose per-endpoint today (scheme,
      // asset, payTo, maxTimeoutSeconds): recorded honestly as 'not-exposed';
      // we do not invent fields Sitecheck does not publish. If it ever starts
      // publishing them, they are automatically compared for consistency.
      for (const field of ['scheme', 'asset', 'payTo', 'maxTimeoutSeconds'] as const) {
        const res = cmp[field];
        if (res.consistent === 'not-exposed') continue;
        expect(`${field}=${JSON.stringify(res.expected)} vs ${JSON.stringify(res.observed)}`).toBeTruthy();
        expect(res.consistent).toBe(true);
      }

      writeArtifact(`consistency_${Date.now()}`, {
        discoveryEntry: discEntry,
        discoveryOptions: discOpts,
        comparison: cmp,
        notExposedFields: Object.entries(cmp)
          .filter(([, v]) => v.consistent === 'not-exposed')
          .map(([k]) => k),
      });
    },
    60_000
  );
});

// ------------------------------------------------------------
// Artifact helpers (external-evidence convention; dir is gitignored)
// ------------------------------------------------------------

function pickX402Headers(ex: { metadata?: Record<string, unknown> }): Record<string, string> {
  const headers = (ex.metadata?.headers ?? {}) as Record<string, string>;
  const keep: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    if (/payment|x402|content-type|cache-control/i.test(k)) keep[k] = headers[k];
  }
  return keep;
}

function artifactDir(): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

let currentArtifact: Record<string, unknown> | null = null;
function writeArtifact(id: string, data: Record<string, unknown>): void {
  // Merge all phase outputs into ONE per-file artifact so the run produces a
  // single self-describing evidence bundle.
  currentArtifact = {
    ...(currentArtifact ?? {}),
    [`section_${id}`]: data,
  };
  const out = {
    generatedAt: new Date().toISOString(),
    scenario: SITECHECK_BOUNDARY.id,
    baseline: { repo: 'Argus-Agent-Test-Lab' },
    target: { url: AUDIT_URL, discoveryUrl: DISCOVERY_URL },
    classification:
      'PAYMENT_REQUIRED — payment boundary successfully OBSERVED; paid execution NOT attempted and NOT tested. ' +
      'No payment header sent, no resolver wired, no signature, no broadcast.',
    semantics:
      'PASS means externally visible behavior correctly observed and classified. It is NOT an application ' +
      'success of the underlying audit operation. UNKNOWN ≠ FAILURE, TIMEOUT ≠ FAILURE.',
    ...currentArtifact,
  };
  writeFileSync(
    path.join(artifactDir(), `sitecheck-boundary-${id.split('_')[0]}-artifact.json`),
    JSON.stringify(out, null, 2)
  );
  writeFileSync(
    path.join(artifactDir(), 'sitecheck-boundary-latest.json'),
    JSON.stringify(out, null, 2)
  );
}

// ============================================================
// КОНЕЦ ФАЙЛА
// ============================================================
