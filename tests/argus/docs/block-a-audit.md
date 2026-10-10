# Block A — Canonical Vocabulary + Action Forensic Audit (final, после approve)

## Canonical ProtocolRole

    type ProtocolRole = 'CLIENT' | 'RESOURCE_SERVER' | 'FACILITATOR';

`Participant.protocolRole` — OPTIONAL. Отсутствие поля = app-level participant
(не protocol participant). Facilitator опционален в протоколе x402, поэтому
роль может отсутствовать в сценарии.

## КЛЮЧЕВОЕ ПРАВИЛО: protocolRole — per-scenario, не глобальная роль participantId

Один participantId может играть разные роли в разных сценариях:

| participant | S1–S7 | S8 | обоснование по фактическому поведению |
|---|---|---|---|
| buyer-1 | CLIENT | CLIENT | единственный actor всех actions; инициирует HTTP-запросы; в S8 получает 402 и ретраит с подписью |
| sut-1 | **FACILITATOR** | **RESOURCE_SERVER** | S1–S7: topology `buyer-1 →(request) sut-1 →(forward) seller-1` — «forward» есть действие посредника, sut-1 НЕ отдаёт protected resource сам, а пересылает к seller-1. S8: sut-1 сам отдаёт 402 + PaymentRequired + payTo, сам проверяет подпись (viem.verifyTypedData), `/do-something` — protected resource, seller-1 отсутствует |
| seller-1 | **RESOURCE_SERVER** | (нет участника) | отдаёт protected resource (delivery_sent / delivery_completed). Отсутствие собственного HTTP endpoint в текущем wiring — техническое ограничение, не отсутствие роли |

Wiring per-participant адаптеров (registry.create(spec) создаёт один адаптер
на всех ARGUS-участников) — техническое ограничение текущего этапа,
не семантическое.

## Action audit — решения по rename (approve учтён)

- `request_resource` (S8) — **НЕ переименован**. Фиксация:
  «request_resource — app-level имя для x402 step 1; canonical rename
  отложен в подблок A1».
- `request_payment` (S1–S7) — **НЕ переименован**. Обоснование:
  canonical x402 equivalent = NONE (orchestrator-level action), rename
  семантически неверен. MockTargetAdapter — вторичное препятствие.

### Полная таблица action audit

Все actions во всех S1–S8 исходят только от buyer-1. Уникальных имён — два.

| scenario | actor | action name | payload | FACT: что фактически делает | layer | canonical x402 equivalent | rename needed? |
|---|---|---|---|---|---|---|---|
| S1 | buyer-1 | request_payment | requestId, idempotencyKey, amount:100 | Дедуп-повтор HTTP-вызова к sut-1 (fault duplicate_request); SUT возвращает payment_intent created/reused | orchestrator+business | NONE | NO |
| S2 | buyer-1 | request_payment | req-2,key-2,100 | То же; проверяется порядок settled vs success | orchestrator | NONE | NO |
| S3 | buyer-1 | request_payment | req-3,key-3,100 | То же; crash после settlement | orchestrator | NONE | NO |
| S4 | buyer-1 | request_payment | req-4,key-4,100 | То же; hang seller | orchestrator | NONE | NO |
| S5 | buyer-1 | request_payment | req-5,key-5,100 | 5 параллельных идентичных вызовов | orchestrator | NONE | NO |
| S6 | buyer-1 | request_payment | req-6,key-6,100 | Adversarial retry с новой authorization на UNKNOWN | orchestrator | NONE | NO |
| S7 | buyer-1 | request_payment | req-7,key-7,100 | То же + lost response на edge | orchestrator | NONE | NO |
| S8 | buyer-1 | request_resource | resourceId:'res-1' | HTTP-запрос к protected endpoint → 402 → sign (PaymentAdapter) → повтор с payment header | x402 | HTTP request to protected resource (x402 v2 step 1) | NO (rename отложен в A1) |

### Сводка

- **Повторяющиеся actions:** `request_payment` — S1–S7 (различаются только payload id/key/seed). `request_resource` — уникален (S8).
- **Дубликаты под разными именами:** нет. Гипотеза `request_payment ≡ request_resource` отвергнута — разные semantics (durable intent vs x402 resource fetch), разные assertions-источники.
- **Классы:**
  - (a) уже x402: `request_resource` (S8).
  - (c) orchestrator-level: `request_payment` ×7.
  - (d) business-level: payload-поля `amount` / `idempotencyKey` внутри (c).
  - (e) fault-injection pseudo-actions: `respond` (S7), триггеры `delivery_started`, `settlement_unknown`, `payment_settled`, `recovery_completed` — app-level events, не actions.

## Findings (зафиксированы, НЕ изменены в Block A)

1. HTTP method POST hardcoded в `X402AgentAdapter.ts:371` — finding.
2. `metadata.observations` не заполняются в Http/X402AgentAdapter —
   known limitation для следующего блока (блокирует behavioral-assertions
   S1–S7 против внешнего транспорта).

## Изменённые файлы (Block A, включая коррекцию ролей)

- `src/core/Participant.ts` — ProtocolRole union, optional protocolRole, документация per-scenario правила.
- `src/scenarios/S1–S7` — buyer-1=CLIENT, sut-1=FACILITATOR, seller-1=RESOURCE_SERVER (обоснования в комментариях).
- `src/scenarios/S8` — buyer-1=CLIENT, sut-1=RESOURCE_SERVER.
- `src/tests/core/ScenarioEngine.test.ts` — canonical литералы в фикстурах (приведение типов, поведение не менялось).
- `src/tests/core/Participant.test.ts` — guard-тесты canonical vocabulary + per-scenario роли S1–S8.
