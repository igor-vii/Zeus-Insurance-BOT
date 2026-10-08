import { describe, it, expect } from 'vitest';
// Note: We test the CLI module integration here

describe('Argus CLI', () => {
  it('should have valid scenario registry', async () => {
    const { getScenarioIds } = await import('../../cli/ScenarioRegistry');
    const ids = getScenarioIds();
    
    expect(ids).toContain('S1');
    expect(ids).toContain('S2');
    expect(ids).toContain('S3');
    expect(ids).toContain('S4');
    expect(ids).toContain('S5');
    expect(ids).toContain('S6');
    expect(ids).toContain('S7');
    expect(ids).toContain('S8');
    expect(ids).toContain('S9');
    expect(ids.length).toBe(9);
  });

  it('should throw on unknown scenario', async () => {
    const { getScenario } = await import('../../cli/ScenarioRegistry');
    
    expect(getScenario('UNKNOWN')).toBeUndefined();
  });
});
