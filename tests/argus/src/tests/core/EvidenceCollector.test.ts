import { describe, it, expect, beforeEach } from 'vitest';
import { EvidenceCollector } from '../../core/EvidenceCollector';
import { Observation, EngineEvent } from '../../core/Evidence';

describe('EvidenceCollector', () => {
  let collector: EvidenceCollector;

  beforeEach(() => {
    collector = new EvidenceCollector();
  });

  it('should collect evidence with correct fields', () => {
    const observation: Observation = {
      source: 'sut-1',
      type: 'payment_sent',
      data: { amount: 100 },
      timestamp: Date.now()
    };

    const record = collector.collect(observation, 'run-123');

    expect(record.runId).toBe('run-123');
    expect(record.source).toBe('sut-1');
    expect(record.type).toBe('payment_sent');
    expect(record.data).toEqual({ amount: 100 });
  });

  it('should collect evidence from different sources', () => {
    const obs1: Observation = {
      source: 'sut-1',
      type: 'delivery_completed',
      data: {},
      timestamp: Date.now()
    };
    const obs2: EngineEvent = {
      source: 'engine',
      type: 'timeout',
      data: {},
      timestamp: Date.now()
    };
    const obs3: Observation = {
      source: 'client-1',
      type: 'response_sent',
      data: {},
      timestamp: Date.now()
    };

    collector.collect(obs1, 'run-123');
    collector.collect(obs2, 'run-123');
    collector.collect(obs3, 'run-123');

    const evidence = collector.getEvidenceSet('run-123');
    expect(evidence.length).toBe(3);

    const sources = evidence.map(e => e.source);
    expect(sources).toContain('sut-1');
    expect(sources).toContain('engine');
    expect(sources).toContain('client-1');
  });

  it('should filter by runId', () => {
    const obs1: Observation = {
      source: 'sut-1',
      type: 'event_a',
      data: {},
      timestamp: Date.now()
    };
    const obs2: Observation = {
      source: 'sut-1',
      type: 'event_b',
      data: {},
      timestamp: Date.now()
    };

    collector.collect(obs1, 'run-1');
    collector.collect(obs2, 'run-2');

    const run1Evidence = collector.getEvidenceSet('run-1');
    const run2Evidence = collector.getEvidenceSet('run-2');

    expect(run1Evidence.length).toBe(1);
    expect(run1Evidence[0].source).toBe('sut-1');
    expect(run2Evidence.length).toBe(1);
    expect(run2Evidence[0].source).toBe('sut-1');
  });

  it('should preserve observation order', () => {
    const obs1: Observation = {
      source: 'sut-1',
      type: 'A',
      data: {},
      timestamp: Date.now()
    };
    const obs2: Observation = {
      source: 'sut-1',
      type: 'B',
      data: {},
      timestamp: Date.now()
    };
    const obs3: Observation = {
      source: 'sut-1',
      type: 'C',
      data: {},
      timestamp: Date.now()
    };

    collector.collect(obs1, 'run-123');
    collector.collect(obs2, 'run-123');
    collector.collect(obs3, 'run-123');

    const evidence = collector.getEvidenceSet('run-123');
    expect(evidence[0].type).toBe('A');
    expect(evidence[1].type).toBe('B');
    expect(evidence[2].type).toBe('C');
  });

  it('should NOT calculate verdict', () => {
    const obs: Observation = {
      source: 'sut-1',
      type: 'test',
      data: {},
      timestamp: Date.now()
    };

    const record = collector.collect(obs, 'run-123');

    // Record is just EvidenceRecord, no verdict property
    expect(record).toHaveProperty('id');
    expect(record).toHaveProperty('source');
    expect(record).toHaveProperty('type');
    expect(record).not.toHaveProperty('verdict');
  });
});
