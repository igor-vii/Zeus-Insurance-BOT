import { describe, expect, it } from 'vitest';
import { validateFaultDispatch } from '../../core/validateScenario';
import { isActionTrigger, L0F2_LIFECYCLE_TRIGGERS } from '../../core/Fault';
import { S1_DuplicateRequest } from '../../scenarios/S1_DuplicateRequest';
import { S2_PaymentBeforeExecution } from '../../scenarios/S2_PaymentBeforeExecution';
import { S3_CrashAfterSettlement } from '../../scenarios/S3_CrashAfterSettlement';
import { S4_SellerTimeout } from '../../scenarios/S4_SellerTimeout';
import { S5_ConcurrentDuplicate } from '../../scenarios/S5_ConcurrentDuplicate';
import { S6_PaymentRetry } from '../../scenarios/S6_PaymentRetry';
import { S7_LostDelivery } from '../../scenarios/S7_LostDelivery';
import { ScenarioDefinition } from '../../core/ScenarioDefinition';

describe('L0-F2 fault dispatch contract', () => {
  it('accepts S1/S5 active action faults and treats lifecycle faults as declared-only', () => {
    for (const scenario of [
      S1_DuplicateRequest,
      S2_PaymentBeforeExecution,
      S3_CrashAfterSettlement,
      S4_SellerTimeout,
      S5_ConcurrentDuplicate,
      S6_PaymentRetry,
      S7_LostDelivery,
    ]) {
      const result = validateFaultDispatch(scenario);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it('rejects an active participant fault whose target differs from action actor', () => {
    const scenario: ScenarioDefinition = {
      ...S1_DuplicateRequest,
      faults: [{
        target: { kind: 'participant', participantId: 'resource-server-1' },
        type: 'duplicate_request',
        trigger: 'action_request_payment',
        config: {},
      }],
    };

    const result = validateFaultDispatch(scenario);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.rule).toBe('L0-F2: target equals actor');
  });

  it('rejects edge targets on active action-triggered faults', () => {
    const scenario: ScenarioDefinition = {
      ...S1_DuplicateRequest,
      faults: [{
        target: { kind: 'edge', from: 'resource-server-1', to: 'sut-1' },
        type: 'lost_delivery',
        trigger: 'action_request_payment',
        config: {},
      }],
    };

    const result = validateFaultDispatch(scenario);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.rule).toBe('L0-F2: active fault target');
  });

  it('rejects infrastructure targets on active action-triggered faults', () => {
    const scenario: ScenarioDefinition = {
      ...S1_DuplicateRequest,
      faults: [{
        target: { kind: 'infrastructure', component: 'testSubject' },
        type: 'crash',
        trigger: 'action_request_payment',
        config: {},
      }],
    };

    const result = validateFaultDispatch(scenario);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.rule).toBe('L0-F2: active fault target');
    expect(result.errors[0]?.message).toContain("'infrastructure' is declared-only");
  });

  it('S1 and S5 declare exactly the expected active participant faults targeting the actor', () => {
    for (const scenario of [S1_DuplicateRequest, S5_ConcurrentDuplicate]) {
      const action = scenario.actions[0];
      expect(action).toBeDefined();
      if (!action) continue;

      // Every declared fault in S1/S5 is an active action-triggered
      // participant fault whose target equals the action actor.
      const activeFaults = scenario.faults.filter(
        (fault) =>
          fault.type !== 'respond' &&
          isActionTrigger(fault.trigger) &&
          scenario.actions.some((a) => `action_${a.type}` === fault.trigger)
      );

      expect(activeFaults.length).toBeGreaterThan(0);

      for (const fault of activeFaults) {
        expect(fault.target.kind).toBe('participant');
        if (fault.target.kind === 'participant') {
          expect(fault.target.participantId).toBe(action.actor);
        }
      }

      // The expected active fault shape is present verbatim.
      const expectedType = scenario.id === 'S1' ? 'duplicate_request' : 'concurrent_request';
      expect(activeFaults).toHaveLength(1);
      expect(activeFaults[0]?.type).toBe(expectedType);
      expect(activeFaults[0]?.trigger).toBe(`action_${action.type}`);

      // No lifecycle trigger in S1/S5 ever goes through active dispatch:
      // every lifecycle-triggered fault (if declared) is non-participant
      // or baseline respond, i.e. excluded from getFaultsForEvent().
      const lifecycleFaults = scenario.faults.filter(
        (fault) => L0F2_LIFECYCLE_TRIGGERS.has(fault.trigger)
      );
      for (const fault of lifecycleFaults) {
        expect(isActionTrigger(fault.trigger)).toBe(false);
        const isActiveParticipantDispatchCandidate =
          fault.type !== 'respond' && fault.target.kind === 'participant';
        // Declared-only: even a participant-targeted lifecycle fault is
        // never dispatched because its trigger is not an action trigger.
        expect(isActiveParticipantDispatchCandidate && isActionTrigger(fault.trigger)).toBe(false);
      }

      // And validation confirms the whole scenario is dispatch-valid.
      const result = validateFaultDispatch(scenario);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });
});
