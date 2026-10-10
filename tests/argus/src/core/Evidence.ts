/**
 * Evidence — что реально произошло. Два класса источников.
 *
 * Observation:
 * - source = testSubject: система/участник, чьё поведение наблюдаем.
 * - actorId = participantId: участник, инициировавший действие, если известен.
 *
 * EngineEvent:
 * - source = 'engine'.
 *
 * Evidence не делает hierarchy и не фильтрует по source.
 */
export type Evidence = Observation | EngineEvent;

export interface Observation {
  /** The system/participant being observed (scenario.testSubject). */
  source: string;
  /** Participant that initiated the action, when transport identity is available. */
  actorId?: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface EngineEvent {
  source: 'engine';
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}
