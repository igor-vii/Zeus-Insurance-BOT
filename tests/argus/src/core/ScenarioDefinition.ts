import { Participant } from './Participant';
import { Topology } from './Topology';
import { Fault } from './Fault';
import { Assertion } from './Assertions';

/**
 * Определение действия в сценарии
 */
export interface Action {
  actor: string;                  // participantId
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Инвариант сценария
 */
export interface Invariant {
  id: string;
  description: string;
}

/**
 * Каноническое определение сценария тестирования
 */
export interface ScenarioDefinition {
  id: string;
  name: string;
  description?: string;
  participants: Participant[];
  topology: Topology;
  testSubject: string;
  actions: Action[];
  faults: Fault[];
  invariants: Invariant[];
  assertions: Assertion[];
  seed: number;
}
