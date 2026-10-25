# L0-F2 — Fault Dispatch Contract

## Runtime contract

L0-F2 freezes fault dispatch to one bounded model:

1. Only `action_<type>` engine events dispatch active faults.
2. Active faults support `participant` targets only.
3. For an active participant fault, `target.participantId === action.actor`.
4. Lifecycle/event triggers such as `delivery_started`, `payment_settled`, `settlement_unknown`, and `delivery_sent` are evidence-only.
5. No event-to-fault recursive dispatch is performed.
6. Edge and infrastructure targets are declared-only in L0-F2.
7. `respond` is baseline participant behavior, not an active fault primitive; its compatibility path is separate from fault dispatch.

## Scenario status

- S1: active action fault, participant target == actor.
- S5: active action fault, participant target == actor.
- S2/S3/S4/S6: lifecycle-triggered declarations; no active fault dispatch in L0-F2.
- S7: `respond` remains a separate baseline behavior path; `lost_delivery` remains declared-only because edge dispatch is not implemented.

## Explicit non-goals

L0-F2 does not add:

- recursive dispatch;
- seller lifecycle emitters;
- settlement/reconciliation lifecycle emitters;
- edge interception;
- infrastructure interception;
- new S2/S3/S4/S6/S7 semantics.

Those require separate bounded work items.
