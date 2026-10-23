import { ScenarioDefinition } from './ScenarioDefinition';
import { Assertion, AssertionKind } from './Assertions';

/**
 * Ошибка валидации сценария.
 */
export interface ValidationError {
  assertionId: string;
  rule: string;
  message: string;
}

/**
 * Результат валидации сценария.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Проверка Rule 1 для одного assertion.
 *
 * validSources — множество легальных source'ов для этого сценария:
 * - testSubject (наблюдения target'а)
 * - 'engine' (engine events)
 * - participantId любого участника с ownership === 'ARGUS'
 *   (эмиссия через respond-fault)
 *
 * Возвращает массив ошибок (пустой, если assertion валиден).
 */
function validateAssertion(
  assertion: Assertion,
  validSources: Set<string>,
  testSubject: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  const sources = assertion.referencedSources;

  // Переходный период: если поле отсутствует — проверка не запускается.
  if (sources === undefined) {
    return errors;
  }

  const kind: AssertionKind = assertion.kind ?? 'behavioral';
  const hasTestSubject = sources.includes(testSubject);
  const hasEngine = sources.includes('engine');

  // Проверка на нелегальные источники.
  const invalid = sources.filter((s) => !validSources.has(s));
  if (invalid.length > 0) {
    const validList = Array.from(validSources).join("', '");
    errors.push({
      assertionId: assertion.id,
      rule: `Rule 1: ${kind}`,
      message: `unknown source(s) in referencedSources: ${invalid.join(', ')} (valid sources for this scenario: '${validList}')`,
    });
  }

  if (kind === 'behavioral') {
    if (!hasTestSubject) {
      errors.push({
        assertionId: assertion.id,
        rule: 'Rule 1: behavioral',
        message: `behavioral assertion '${assertion.id}' missing reference to testSubject '${testSubject}'`,
      });
    }
  } else if (kind === 'engine-behavior') {
    if (hasTestSubject) {
      errors.push({
        assertionId: assertion.id,
        rule: 'Rule 1: engine-behavior',
        message: `engine-behavior assertion '${assertion.id}' must NOT reference testSubject '${testSubject}'`,
      });
    }
    if (!hasEngine) {
      errors.push({
        assertionId: assertion.id,
        rule: 'Rule 1: engine-behavior',
        message: `engine-behavior assertion '${assertion.id}' must reference 'engine'`,
      });
    }
  } else if (kind === 'mixed') {
    if (!hasTestSubject) {
      errors.push({
        assertionId: assertion.id,
        rule: 'Rule 1: mixed',
        message: `mixed assertion '${assertion.id}' missing reference to testSubject '${testSubject}'`,
      });
    }
    if (!hasEngine) {
      errors.push({
        assertionId: assertion.id,
        rule: 'Rule 1: mixed',
        message: `mixed assertion '${assertion.id}' missing reference to 'engine'`,
      });
    }
  }

  return errors;
}

/**
 * Валидация сценария. Проверяет Rule 1 для всех assertions.
 *
 * Легальные source'ы:
 * - testSubject
 * - 'engine'
 * - participantId любого участника с ownership === 'ARGUS'
 */
export function validateScenario(
  scenario: ScenarioDefinition
): ValidationResult {
  const errors: ValidationError[] = [];
  const testSubject = scenario.testSubject;

  const validSources = new Set<string>();
  validSources.add(testSubject);
  validSources.add('engine');
  for (const participant of scenario.participants) {
    if (participant.ownership === 'ARGUS') {
      validSources.add(participant.participantId);
    }
  }

  for (const assertion of scenario.assertions) {
    errors.push(...validateAssertion(assertion, validSources, testSubject));
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}


/**
 * L0-F2 fault-dispatch contract validation.
 *
 * This is intentionally separate from assertion-source validation so legacy
 * scenarios may retain declared-only lifecycle faults without becoming
 * runtime-invalid. Callers that want an executable L0-F2 scenario should
 * require this result to be valid.
 */
export function validateFaultDispatch(scenario: ScenarioDefinition): ValidationResult {
  const errors: ValidationError[] = [];

  for (const [index, fault] of scenario.faults.entries()) {
    // respond is baseline participant behavior, not an active fault.
    if (fault.type === 'respond') {
      continue;
    }

    const action = fault.trigger.startsWith('action_')
      ? scenario.actions.find((candidate) => `action_${candidate.type}` === fault.trigger)
      : undefined;

    // Lifecycle/event triggers are declared-only in L0-F2.
    if (!action) {
      continue;
    }

    if (fault.target.kind !== 'participant') {
      errors.push({
        assertionId: `fault[${index}]`,
        rule: 'L0-F2: active fault target',
        message: `active fault trigger '${fault.trigger}' requires participant target; '${fault.target.kind}' is declared-only`,
      });
      continue;
    }

    if (fault.target.participantId !== action.actor) {
      errors.push({
        assertionId: `fault[${index}]`,
        rule: 'L0-F2: target equals actor',
        message: `active fault '${fault.type}' targets '${fault.target.participantId}' but action actor is '${action.actor}'`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
