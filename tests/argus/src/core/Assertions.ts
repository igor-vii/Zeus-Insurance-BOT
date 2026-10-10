import { Evidence } from './Evidence';

/**
 * AssertionKind — класс ассерта для Rule 1 validation.
 * - behavioral: проверяет invariant системы, ссылается минимум на одну observation с source = testSubject
 * - engine-behavior: проверяет infrastructure invariant, ссылается только на engine events
 * - mixed: проверяет смешанный invariant, ссылается и на observations, и на engine events
 */
export type AssertionKind = 'behavioral' | 'engine-behavior' | 'mixed';

/**
 * Verdict — результат проверки assertion
 */
export interface Verdict {
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  reason?: string;
}

/**
 * Assertion — функция проверки evidence → verdict
 * 
 * В Model V0 assertion — это данные + evaluate-функция, не класс.
 * evaluate не сериализуется, поэтому сценарии не могут быть частью внешнего конфигуратора
 * до миграции evaluate → serializable Assertion-class.
 */
export interface Assertion {
  id: string;
  invariantId: string;
  kind?: AssertionKind;  // по умолчанию 'behavioral'
  /**
   * Декларативный список source'ов, на которые ссылается assertion
   * в evaluate(). Фактические participantId + 'engine'.
   */
  referencedSources: string[];
  evaluate: (evidence: Evidence[]) => Verdict;
}
