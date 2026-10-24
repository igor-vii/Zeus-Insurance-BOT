import { describe, it, expect } from 'vitest';
import type { Participant, ProtocolRole } from '../../core/Participant';

import { S1_DuplicateRequest } from '../../scenarios/S1_DuplicateRequest';
import { S2_PaymentBeforeExecution } from '../../scenarios/S2_PaymentBeforeExecution';
import { S3_CrashAfterSettlement } from '../../scenarios/S3_CrashAfterSettlement';
import { S4_SellerTimeout } from '../../scenarios/S4_SellerTimeout';
import { S5_ConcurrentDuplicate } from '../../scenarios/S5_ConcurrentDuplicate';
import { S6_PaymentRetry } from '../../scenarios/S6_PaymentRetry';
import { S7_LostDelivery } from '../../scenarios/S7_LostDelivery';
import { S8_X402Payment } from '../../scenarios/S8_X402Payment';

/**
 * Block A guard: ProtocolRole принимает только canonical x402 значения.
 * Compile-time проверка: недопустимые литералы не присваиваются типу
 * (строки ниже с @ts-expect-error должны быть ошибками компиляции —
 * typecheck их и ловит). Runtime-часть проверяет canonical-значения
 * в утверждённых сценариях S1–S8.
 */
const CANONICAL: ProtocolRole[] = ['CLIENT', 'RESOURCE_SERVER', 'FACILITATOR'];
const FORBIDDEN = ['BUYER', 'SELLER', 'PAYER', 'PAYEE', 'INTERMEDIARY',
  'AGENT', 'PROVIDER', 'REQUESTER', 'COUNTERPARTY'];

describe('ProtocolRole (canonical x402 vocabulary)', () => {
  it('accepts only CLIENT | RESOURCE_SERVER | FACILITATOR (compile-time)', () => {
    const c: ProtocolRole = 'CLIENT';
    const r: ProtocolRole = 'RESOURCE_SERVER';
    const f: ProtocolRole = 'FACILITATOR';
    // @ts-expect-error BUYER is not a canonical ProtocolRole
    const bad1: ProtocolRole = 'BUYER';
    // @ts-expect-error SELLER is not a canonical ProtocolRole
    const bad2: ProtocolRole = 'SELLER';
    // @ts-expect-error INTERMEDIARY is not a canonical ProtocolRole
    const bad3: ProtocolRole = 'INTERMEDIARY';
    void [c, r, f, bad1, bad2, bad3];
    expect(CANONICAL).toHaveLength(3);
  });

  it('protocolRole is optional — absence means app-level participant', () => {
    const p: Participant = { participantId: 'resource-server-1', ownership: 'ARGUS' };
    expect(p.protocolRole).toBeUndefined();
  });
});

describe('S1–S8 canonical protocolRole (Block A)', () => {
  const scenarios = [
    S1_DuplicateRequest, S2_PaymentBeforeExecution, S3_CrashAfterSettlement,
    S4_SellerTimeout, S5_ConcurrentDuplicate, S6_PaymentRetry,
    S7_LostDelivery, S8_X402Payment,
  ];

  it('every assigned protocolRole is canonical', () => {
    for (const s of scenarios) {
      for (const p of s.participants) {
        if (p.protocolRole !== undefined) {
          expect(CANONICAL, `${s.id}/${p.participantId}: ${p.protocolRole}`)
            .toContain(p.protocolRole);
        }
      }
    }
  });

  it('no forbidden legacy role literals anywhere in S1–S8', () => {
    for (const s of scenarios) {
      for (const p of s.participants) {
        expect(FORBIDDEN, `${s.id}/${p.participantId}`).not.toContain(p.protocolRole);
      }
    }
  });

  it('client-1 is CLIENT in all scenarios', () => {
    for (const s of scenarios) {
      const client = s.participants.find((p) => p.participantId === 'client-1');
      expect(client?.protocolRole, s.id).toBe('CLIENT');
    }
  });

  it('sut-1 role is PER-SCENARIO: FACILITATOR in S1–S7, RESOURCE_SERVER in S8', () => {
    for (const s of scenarios) {
      const sut = s.participants.find((p) => p.participantId === 'sut-1');
      const expected = s.id === 'S8' ? 'RESOURCE_SERVER' : 'FACILITATOR';
      expect(sut?.protocolRole, s.id).toBe(expected);
    }
  });

  it('resource-server-1 (S1–S7) is RESOURCE_SERVER — отдаёт protected resource (delivery)', () => {
    const withSeller = scenarios.filter((s) =>
      s.participants.some((p) => p.participantId === 'resource-server-1'));
    expect(withSeller.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    for (const s of withSeller) {
      const resourceServer = s.participants.find((p) => p.participantId === 'resource-server-1');
      expect(resourceServer?.protocolRole, s.id).toBe('RESOURCE_SERVER');
    }
  });
});
