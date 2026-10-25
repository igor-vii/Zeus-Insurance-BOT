import { AgentController } from './AgentController';

/**
 * ExecutionRegistry — maps participantId → AgentController.
 *
 * Minimal participant-aware execution routing.
 * ScenarioEngine uses this to resolve action.actor.
 */
export class ExecutionRegistry {
  private controllers = new Map<string, AgentController>();

  register(actorId: string, controller: AgentController): void {
    this.controllers.set(actorId, controller);
  }

  get(actorId: string): AgentController | undefined {
    return this.controllers.get(actorId);
  }

  has(actorId: string): boolean {
    return this.controllers.has(actorId);
  }
}
