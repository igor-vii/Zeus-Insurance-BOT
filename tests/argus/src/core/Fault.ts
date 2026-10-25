/**
 * Fault targets are separate from dispatch triggers.
 *
 * L0-F2 runtime contract:
 * - active fault dispatch supports only participant targets;
 * - lifecycle/event triggers are declared-only;
 * - edge/infrastructure targets are declared-only;
 * - a participant-targeted active fault must target the action actor.
 */
export type FaultTarget =
  | { kind: 'participant'; participantId: string }
  | { kind: 'edge'; from: string; to: string }
  | { kind: 'infrastructure'; component: 'testSubject' };

/** Action triggers are the only runtime fault-dispatch triggers in L0-F2. */
export type FaultTrigger = string;

export interface Fault {
  target: FaultTarget;
  type: string;
  trigger: FaultTrigger;
  config: Record<string, unknown>;
  /** Metadata only; it never enables runtime dispatch. */
  approximated?: boolean;
}

/**
 * Lifecycle/event triggers are evidence declarations in L0-F2.
 * They are intentionally not recursive fault-dispatch inputs.
 */
export const L0F2_LIFECYCLE_TRIGGERS = new Set([
  'delivery_started',
  'payment_settled',
  'settlement_unknown',
  'delivery_sent',
]);

export const isActionTrigger = (trigger: string): boolean =>
  trigger.startsWith('action_');

/**
 * respond is baseline participant behavior, not a fault primitive.
 * It remains on the legacy Fault shape only as a compatibility bridge
 * for S7 and is dispatched through getRespondersForEvent(), not through
 * the active fault-dispatch path.
 */
export const isBaselineResponder = (fault: Fault): boolean =>
  fault.type === 'respond';
