import { describe, it, expect } from 'vitest';
import { AssertionEngine } from '../../core/AssertionEngine';
import { Assertion, Verdict } from '../../core/Assertions';
import { Evidence, Observation, EngineEvent } from '../../core/Evidence';

describe('AssertionEngine', () => {
  const engine = new AssertionEngine();

  it('should return INCONCLUSIVE when evidence is missing', () => {
    const emptyEvidence: Evidence[] = [];
    const inconclusiveAssertion: Assertion = {
      id: 'assert-1',
      invariantId: 'inv-1',
      referencedSources: [],
      evaluate: (evidence: Evidence[]): Verdict => {
        if (evidence.length === 0) {
          return { status: 'INCONCLUSIVE', reason: 'No evidence provided' };
        }
        return { status: 'PASS' };
      }
    };

    const result = engine.evaluate(emptyEvidence, [inconclusiveAssertion]);

    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('should aggregate multiple assertions (FAIL overrides)', () => {
    const evidence: Evidence[] = [
      {
        source: 'sut-1',
        type: 'event_a',
        data: {},
        timestamp: Date.now()
      } as Observation
    ];

    const passAssertion: Assertion = {
      id: 'pass-assert',
      invariantId: 'inv-pass',
      referencedSources: ['sut-1'],
      evaluate: (): Verdict => ({ status: 'PASS' })
    };

    const failAssertion: Assertion = {
      id: 'fail-assert',
      invariantId: 'inv-fail',
      referencedSources: ['sut-1'],
      evaluate: (): Verdict => ({ status: 'FAIL', reason: 'Violation detected' })
    };

    const result = engine.evaluate(evidence, [passAssertion, failAssertion]);

    expect(result.status).toBe('FAIL');
  });

  it('should work with Observation and EngineEvent', () => {
    const evidence: Evidence[] = [
      {
        source: 'client-1',
        type: 'payment_initiated',
        data: { amount: 100 },
        timestamp: Date.now()
      } as Observation,
      {
        source: 'engine',
        type: 'run_started',
        data: { runId: 'run-1' },
        timestamp: Date.now()
      } as EngineEvent
    ];

    const engineEventAssertion: Assertion = {
      id: 'engine-assert',
      invariantId: 'inv-engine',
      referencedSources: ['engine'],
      evaluate: (evidence: Evidence[]): Verdict => {
        const hasEngineEvent = evidence.some(e => e.source === 'engine');
        if (hasEngineEvent) {
          return { status: 'PASS' };
        }
        return { status: 'FAIL', reason: 'No engine event found' };
      }
    };

    const result = engine.evaluate(evidence, [engineEventAssertion]);

    expect(result.status).toBe('PASS');
  });

  it('should be deterministic', () => {
    const evidence: Evidence[] = [
      {
        source: 'sut-1',
        type: 'test_event',
        data: { value: 42 },
        timestamp: Date.now()
      } as Observation
    ];

    const deterministicAssertion: Assertion = {
      id: 'det-assert',
      invariantId: 'inv-det',
      referencedSources: ['sut-1'],
      evaluate: (evidence: Evidence[]): Verdict => {
        const hasEvent = evidence.some(e => e.type === 'test_event');
        if (hasEvent) {
          return { status: 'PASS' };
        }
        return { status: 'FAIL' };
      }
    };

    const result1 = engine.evaluate(evidence, [deterministicAssertion]);
    const result2 = engine.evaluate(evidence, [deterministicAssertion]);

    expect(result1.status).toBe(result2.status);
    expect(result1.status).toBe('PASS');
  });
});
