/**
 * Статусы выполнения тестового прогона (технические, не бизнес-вердикты)
 */
export enum RunStatus {
  CREATED = 'CREATED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED' // Технический сбой выполнения, не FAIL вердикт теста
}

/**
 * Контекст выполнения одного прогона
 */
export interface RunContext {
  runId: string;
  scenarioId: string;
  seed: number;
  startedAt: Date;
  status: RunStatus;
  finishedAt?: Date;
}

/**
 * Результат выполнения прогона
 */
export interface RunResult {
  runId: string;
  scenarioId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  evidenceCount: number;
  verdict?: {
    status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    reason?: string;
  };
}

/**
 * Генерация уникального ID прогона
 */
export function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
