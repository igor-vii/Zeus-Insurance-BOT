// ============================================================
// src/core/EvidenceCollector.ts
// ============================================================

import { Evidence, Observation } from './Evidence';

function isObservation(evidence: Evidence): evidence is Observation {
  return 'actorId' in evidence;
}

/**
 * Внутренняя запись evidence.
 * В Model V0 Evidence = Observation | EngineEvent.
 * Коллектор хранит их как есть, без интерпретации.
 */
export interface EvidenceRecord {
  /** Уникальный идентификатор записи */
  id: string;
  /** Source: observed participant (typically scenario.testSubject), or 'engine'. */
  source: string;
  /** Actor: participant that initiated the action, when known. */
  actorId?: string;
  /** Type: semantic event type */
  type: string;
  /** Data: observation data */
  data: Record<string, unknown>;
  /** Timestamp в миллисекундах */
  timestamp: number;
  /** Run ID */
  runId: string;
}

/**
 * EvidenceCollector — сбор evidence во время test run.
 *
 * Принципы:
 * - Сохраняет ВСЕ observations (не фильтрует, не делает hierarchy).
 * - Не интерпретирует — что получил, то и записал.
 * - Assertions сами решают, какие observations им нужны.
 */
export class EvidenceCollector {
  private records: EvidenceRecord[] = [];
  private idCounter = 0;

  /**
   * Собрать evidence.
   * Принимает Evidence (Observation | EngineEvent) + runId.
   */
  collect(evidence: Evidence, runId: string): EvidenceRecord {
    const record: EvidenceRecord = {
      id: `ev_${this.idCounter++}`,
      source: evidence.source,
      ...(isObservation(evidence) && evidence.actorId
        ? { actorId: evidence.actorId }
        : {}),
      type: evidence.type,
      data: evidence.data,
      timestamp: evidence.timestamp,
      runId,
    };
    this.records.push(record);
    return record;
  }

  /**
   * Получить все evidence для run.
   */
  getEvidenceSet(runId: string): EvidenceRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  /**
   * Получить все evidence (для отладки).
   */
  getAllRecords(): EvidenceRecord[] {
    return [...this.records];
  }

  /**
   * Получить evidence по типу для run.
   */
  getByType(runId: string, type: string): EvidenceRecord[] {
    return this.records.filter(
      (r) => r.runId === runId && r.type === type
    );
  }

  /**
   * Получить evidence по source для run.
   */
  getBySource(runId: string, source: string): EvidenceRecord[] {
    return this.records.filter(
      (r) => r.runId === runId && r.source === source
    );
  }

  /**
   * Количество evidence для run.
   */
  count(runId: string): number {
    return this.records.filter((r) => r.runId === runId).length;
  }

  /**
   * Очистить коллектор.
   */
  clear(): void {
    this.records = [];
    this.idCounter = 0;
  }
}

// ============================================================
// КОНЕЦ ФАЙЛА
// ============================================================
