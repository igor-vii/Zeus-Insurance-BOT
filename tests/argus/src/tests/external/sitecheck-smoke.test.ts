// ============================================================
// src/tests/external/sitecheck-smoke.test.ts
// ============================================================
//
// E2E-SITECHECK-SMOKE — Argus external-target smoke test (Phase 2).
//
// Purpose: prove that Argus can invoke a real public x402 target
// (Sitecheck) through the existing X402AgentAdapter + AgentController +
// ScenarioEngine + EvidenceCollector + AssertionEngine pipeline, capture
// observable evidence, and produce a correct verdict — WITHOUT touching
// Sitecheck internals and WITHOUT paying.
//
// Public contract observed in Phase-1 read-only recon (2026-09-28, live):
//   GET  https://api.sitecheck-api.workers.dev/                 -> 200 JSON catalog
//   GET  https://api.sitecheck-api.workers.dev/.well-known/x402 -> 200 JSON, x402Version 2,
//                                                                  resources[], endpoints[]
//   GET  /api/audit?url=https://example.com (no payment)        -> 402 + base64 'payment-required'
//   POST /api/audit                                             -> 404 plain text (GET-only resource)
//
// Root cause fixed in Phase 2 (minimal change): X402AgentAdapter.makeHttpRequest
// used a hardcoded POST verb; the Sitecheck audit resource is GET-only per its
// own discovery document. The adapter now reads an optional `method` from the
// existing transport options (`config.options.method`), defaulting to POST so
// all existing targets/fixtures are unchanged. This scenario configures
// method=GET through that existing mechanism. No new env vars, no new adapters,
// no engine changes.
//
// Expected transport result: ExchangeStatus.PAYMENT_REQUIRED with a parsed
// x402 v2 payment requirement. That is the SUCCESS criterion of this smoke
// run: it proves reachability + correct x402 observation/classification.
// It is NOT an application success and NOT a paid transaction.
// sendWithSignature is never called; no fake payment exists anywhere.
//
// Semantics preserved: UNKNOWN ≠ FAILURE, TIMEOUT ≠ FAILURE. Unexpected
// outcomes are reported honestly, never upgraded to PASS.
//
// Opt-out: set SKIP_EXTERNAL_TESTS=1 to skip (e.g. offline CI).

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
import type { Evidence } from '../../core/Evidence';
import type { ScenarioDefinition } from '../../core/ScenarioDefinition';

const BASE = 'https://api.sitecheck-api.workers.dev';
const AUDIT_URL = `${BASE}/api/audit?url=${encodeURIComponent('https://example.com')}`;
const DISCOVERY_URL = `${BASE}/.well-known/x402`;

const skip = process.env.SKIP_EXTERNAL_TESTS === '1';

/**
 * Minimal scenario definition: one buyer action against the external SUT.
 * Mirrors the existing S8 model (request_resource → 402), but with NO
 * payment resolver wired in: the smoke test deliberately does not pay.
 */
const SITECHECK_SMOKE: ScenarioDefinition = {
  id: 'SITECHECK-SMOKE',
  name: 'Sitecheck external x402 smoke',
  description:
    'Argus invokes the real public Sitecheck audit endpoint (GET, no payment) ' +
    'and must observe/classify the externally visible behavior: HTTP 402 with ' +
    'a parseable x402 v2 payment requirement.',
  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    { participantId: 'sitecheck-1', protocolRole: 'RESOURCE_SERVER', ownership: 'EXTERNAL' },
  ],
  topology: { edges: [{ from: 'client-1', to: 'sitecheck-1', kind: 'request' }] },
  testSubject: 'sitecheck-1',
  actions: [
    {
      actor: 'client-1',
      // Same app-level action name as S8 step 1 (HTTP request to protected resource).
      type: 'request_resource',
      payload: { resourceId: 'sitecheck-audit-example-com' },
    },
  ],
  faults: [],
  invariants: [
    {
      id: 'observable_external_behavior',
      description:
        'Argus must correctly classify the externally visible Sitecheck response as exactly one of: ' +
        'reachable+x402-payment-required / unreachable / error / unknown. ' +
        'A payment requirement observed and parsed (but NOT paid) is a valid, ' +
        'controlled negative result for this smoke run.',
    },
  ],
  assertions: [
    {
      id: 'assert_sitecheck_observed_and_classified',
      invariantId: 'observable_external_behavior',
      kind: 'mixed',
      referencedSources: ['engine'],
      evaluate: (evidence: Evidence[]) => {
        const eng = evidence.find(
          (e) => e.source === 'engine' && e.type === 'payment_required_no_resolver'
        );

        if (!eng) {
          // Nothing observed/classified yet by the engine path.
          // UNKNOWN ≠ FAILURE — do not upgrade, do not fabricate.
          return {
            status: 'INCONCLUSIVE' as const,
            reason: 'target interaction not observed/classified yet (UNKNOWN ≠ FAILURE)',
          };
        }

        const pr = eng.data.paymentRequired as
          | { raw?: string; scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string }
          | undefined;

        // Controlled negative result: payment required, parsed, NOT paid by design.
        // This is the expected, correctly-classified outcome of the smoke run.
        if (pr && pr.raw && pr.network && pr.amount && pr.payTo) {
          return { status: 'PASS' as const };
        }
        return {
          status: 'FAIL' as const,
          reason: 'x402 payment-required evidence present but structurally incomplete',
        };
      },
    },
  ],
  seed: 9001,
};

async function fetchRaw(url: string): Promise<{
  status: number;
  ct: string | null;
  headers: Record<string, string>;
  body: unknown;
}> {
  const res = await fetch(url);
  const ct = res.headers.get('content-type');
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = ct?.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, ct, headers, body };
}

describe.skipIf(skip)('E2E Sitecheck external smoke (real public target)', () => {
  it(
    'recon: GET / returns 200 JSON service catalog',
    async () => {
      const r = await fetchRaw(`${BASE}/`);
      expect(r.status).toBe(200);
      expect(r.ct).toContain('application/json');
      const b = r.body as Record<string, unknown>;
      expect(b.name).toBe('SiteCheck');
      expect(Array.isArray(b.endpoints)).toBe(true);
    },
    30_000
  );

  it(
    'recon: GET /.well-known/x402 is valid, parseable x402 discovery',
    async () => {
      const r = await fetchRaw(DISCOVERY_URL);
      expect(r.status).toBe(200);
      const b = r.body as Record<string, unknown>;
      expect(b.x402Version).toBe(2);
      expect(Array.isArray(b.resources)).toBe(true);
      expect(Array.isArray(b.endpoints)).toBe(true);
    },
    30_000
  );

  it(
    'smoke: Argus (X402AgentAdapter, method=GET via options) invokes real Sitecheck audit resource and observes x402 PAYMENT_REQUIRED without paying',
    async () => {
      // --- transport: existing adapter, method configured via options -----
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

      // --- execution: same model as S8 via ScenarioEngine ------------------
      const context: RunContext = {
        runId: generateRunId(),
        scenarioId: SITECHECK_SMOKE.id,
        seed: SITECHECK_SMOKE.seed,
        startedAt: new Date(),
        status: RunStatus.CREATED,
      };

      const registry = new ExecutionRegistry();
      controller.setParticipantId('client-1');
      registry.register('client-1', controller);

      const collector = new EvidenceCollector();
      const engine = new ScenarioEngine(
        SITECHECK_SMOKE,
        context,
        registry,
        new FaultInjector([]),
        collector
        // NO paymentResolver on purpose: the smoke test does not pay.
      );

      await engine.execute();
      await controller.disconnect();

      // --- direct exchange observation (adapter-level record) --------------
      const exchanges = adapter.getExchanges();
      expect(exchanges.length).toBe(1);
      const ex = exchanges[0];

      // Expected transport result per the public contract: 402 + x402 v2
      // payment requirement. Anything else is reported honestly below —
      // never upgraded to success.
      expect(ex.status).toBe(ExchangeStatus.PAYMENT_REQUIRED);
      expect(ex.metadata?.statusCode).toBe(402);

      const pr = ex.paymentRequired!;
      expect(pr).toBeDefined();
      // Required field verification per task spec (x402 v2 requirement):
      expect(pr.parsed.x402Version).toBe(2);
      // The public accepts[] array may list multiple schemes/networks; verify
      // the required values are actually returned by the target, not just the
      // first entry.
      const accepts = pr.parsed.accepts as Array<{
        scheme?: string;
        network?: string;
        amount?: string;
        asset?: string;
        maxTimeoutSeconds?: number;
      }>;
      expect(accepts.some((a) => a.scheme === 'exact')).toBe(true);
      expect(accepts.some((a) => a.network === 'eip155:8453')).toBe(true);
      // asset: the public requirement carries USDC contract addresses (an ERC-20
      // address contains no "USDC" substring), so verify against the known
      // identifiers returned by the target itself:
      //   Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
      //   Arc (eip155:5042) USDC: 0x3600000000000000000000000000000000000000
      // plus extra.name = "USD Coin"/"USDC".
      const KNOWN_USDC_ASSETS = [
        /^0x833589fcd6edb6e08f4c7c32d4f71b54bda02913$/i,
        /^0x3600000000000000000000000000000000000000$/i,
      ];
      expect(typeof pr.asset).toBe('string');
      expect(pr.asset.length).toBeGreaterThan(0);
      const assetIsUsdc =
        /usdc|usd coin/i.test(String((pr.parsed.accepts[0] as { extra?: { name?: string } }).extra?.name ?? '')) ||
        KNOWN_USDC_ASSETS.some((re) => re.test(pr.asset)) ||
        accepts.some((a) => KNOWN_USDC_ASSETS.some((re) => re.test(String(a.asset))));
      expect(assetIsUsdc).toBe(true);
      // amount/maxTimeoutSeconds: verify the observed values match the public
      // contract discovered in recon ($0.02 USDC = 20000, 300s) across any
      // listed accept-entry if the first-extracted value differs.
      const amountOk =
        pr.amount === '20000' || accepts.some((a) => a.amount === '20000');
      expect(amountOk).toBe(true);
      const timeoutOk =
        pr.maxTimeoutSeconds === 300 ||
        accepts.some((a) => a.maxTimeoutSeconds === 300);
      expect(timeoutOk).toBe(true);
      expect(pr.payTo).toMatch(/^0x/);

      // --- evidence records -------------------------------------------------
      // NOTE: in the PAYMENT_REQUIRED-without-resolver path the engine records
      // exactly one evidence item ('payment_required_no_resolver') and returns
      // before collectActionEvidence — that is the existing, unmodified engine
      // semantics. We assert what actually exists; nothing is fabricated.
      const records = collector.getAllRecords();
      const prRecord = records.find(
        (r) => r.source === 'engine' && r.type === 'payment_required_no_resolver'
      );
      expect(prRecord).toBeDefined();

      // --- verdict ------------------------------------------------------------
      // AssertionEngine consumes engine Evidence[]; adapter transport evidences
      // are kept as additional artifact data only.
      const adapterEvidence = adapter.getEvidences();
      const verdict = new AssertionEngine().evaluate(records, SITECHECK_SMOKE.assertions);
      // PASS here means "externally visible behavior correctly observed &
      // classified". It is NOT an application success of the paid operation.
      expect(verdict.status).toBe('PASS');

      // --- evidence artifact (external-run proof) ---------------------------
      const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence');
      mkdirSync(outDir, { recursive: true });
      const artifact = {
        generatedAt: new Date().toISOString(),
        baseline: { repo: 'Argus-Agent-Test-Lab', headCommit: 'b66fecd' },
        target: { url: AUDIT_URL, discoveryUrl: DISCOVERY_URL },
        request: {
          method: 'GET (via connectionConfig.options.method)',
          url: AUDIT_URL,
          paymentHeaderSent: false,
        },
        observedExchange: {
          id: ex.id,
          status: ex.status,
          statusCode: ex.metadata?.statusCode ?? null,
          error: ex.error ?? null,
          paymentRequired: pr
            ? {
                x402Version: pr.parsed.x402Version,
                scheme: pr.scheme,
                network: pr.network,
                amount: pr.amount,
                asset: pr.asset,
                payTo: pr.payTo,
                maxTimeoutSeconds: pr.maxTimeoutSeconds,
              }
            : null,
        },
        argusClassification: 'reachable + x402 payment-required (observed, parsed, NOT paid by design)',
        evidenceRecords: { engine: records, adapterTransport: adapterEvidence },
        verdict,
        semantics:
          'Real external target invoked over its public HTTP/x402 surface only. ' +
          'Payment requirement observed and classified; no payment attempted, no success fabricated, ' +
          'UNKNOWN/TIMEOUT never upgraded. PASS means "externally visible behavior correctly observed", ' +
          'not "transaction succeeded".',
      };
      writeFileSync(
        path.join(outDir, `sitecheck-smoke-${context.runId}.json`),
        JSON.stringify(artifact, null, 2)
      );
    },
    60_000
  );
});

// ============================================================
// КОНЕЦ ФАЙЛА
// ============================================================
