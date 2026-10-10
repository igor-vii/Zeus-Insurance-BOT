import { Evidence } from './Evidence';
import { Assertion, Verdict } from './Assertions';

/**
 * Результат работы движка ассертов
 */
export interface AssertionEngineResult {
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  reasons: string[];
  details: Array<{
    assertionId: string;
    verdict: Verdict;
  }>;
}

/**
 * Движок оценки ассертов
 */
export class AssertionEngine {
  /**
   * Оценка набора ассертов против доказательств
   */
  public evaluate(
    evidence: Evidence[],
    assertions: Assertion[]
  ): AssertionEngineResult {
    const details: Array<{
      assertionId: string;
      verdict: Verdict;
    }> = [];

    // Оцениваем каждый ассерт
    for (const assertion of assertions) {
      const verdict = assertion.evaluate(evidence);
      details.push({
        assertionId: assertion.id,
        verdict
      });
    }

    // Агрегируем результаты (по умолчанию ALL — все должны пройти)
    const finalStatus = this.aggregateResults(details);
    const reasons = details
      .filter(d => d.verdict.reason)
      .map(d => d.verdict.reason!);

    return {
      status: finalStatus,
      reasons,
      details
    };
  }

  /**
   * Агрегация результатов: все должны быть PASS для общего PASS
   */
  private aggregateResults(
    details: Array<{ verdict: Verdict }>
  ): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
    const hasFail = details.some(d => d.verdict.status === 'FAIL');
    const hasPass = details.every(d => d.verdict.status === 'PASS');
    const hasInconclusive = details.some(d => d.verdict.status === 'INCONCLUSIVE');

    if (hasFail) {
      return 'FAIL';
    }
    
    if (hasInconclusive) {
      return 'INCONCLUSIVE';
    }
    
    return hasPass ? 'PASS' : 'INCONCLUSIVE';
  }
}
