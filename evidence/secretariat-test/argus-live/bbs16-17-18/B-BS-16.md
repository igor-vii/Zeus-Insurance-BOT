# B-BS-16 — PostgreSQL trail: paid but not delivered (run 2026-10-24T04:16Z)

> Повторный полный прогон **2026-10-24T05:14Z** — детерминированно тот же результат (гейт GREEN, канарейка GREEN, инварианты идентичны). Сырые артефакты повторного прогона: `gate.log` / `canary.log` / `full-dump.json` (обновлены 05:15-05:19Z). Живая матрица и история всех прогонов: `../matrix.json` и `../runs/*.json`.

Адверсариальный продавец взял оплату, но не отдал ресурс. Две ноги против живого Secretariat:

- **refuse** — продавец отвечает 500 на каждую попытку: ожидание — честный FAILED,
  ровно 1 сеттлмент, ровно 1 попытка доставки (окончательный ответ не ретраится слепо).
- **recover** — ответ потерян в полёте (обрыв 2xx): ожидание — `DELIVERY_UNKNOWN`,
  recovery-ретрай с тем же ключом идемпотентности, доставка, ровно 1 сеттлмент на 2 попытки.

## Нога refuse: payment_intents (1)

| payment_intent | operation | client_id | settlement_state | value | tx_hash | facilitator_http | error_reason | created_at | settled_at |
|---|---|---|---|---|---|---|---|---|---|
| `pi_1792815407013_qokwj1mqiro` | `op_1792815407011_n9j55cc07u` | `argus-B-BS-16-1792815407009-4l4575` | **SETTLED** | 10000.000000 | `0xsettle1a16c201fcd…` | 200 | — | 2026-10-24T04:16:47.014Z | 2026-10-24T04:16:47.063Z |

Оплата прошла и зафиксирована: деньги ушли, интент SETTLED, единственный tx.

## Нога refuse: execution_attempts (1) и recovery_jobs (1)

| started_at | attempt | operation | status | url | http | error_reason |
|---|---|---|---|---|---|---|
| 2026-10-24T04:16:51.625Z | #1 `attempt-1792815411621-edc4sgbfozb` | `op_1792815407011_n9j55cc07u` | **HTTP_FAILURE** | POST http://127.0.0.1:9977/seller | **500** | — |

| created_at | job | operation | type | status | attempt | last_error |
|---|---|---|---|---|---|---|
| 2026-10-24T04:16:51.622Z | `job-1792815411621-a13uccd0qy9` | `op_1792815407011_n9j55cc07u` | EXECUTION | **FAILED** | 1/3 | HTTP 500 |

Ровно одна попытка: HTTP 500 — это **окончательный** ответ сервера, конвейер не устраивает
слепых ретраев определённого отказа. Recovery-задача честно закрыта FAILED. Никакого
фейкового COMPLETED: клиент получит отказ, а не «всё хорошо».

## Нога recover: payment_intents (1)

| payment_intent | operation | client_id | settlement_state | value | tx_hash | facilitator_http | created_at | settled_at |
|---|---|---|---|---|---|---|---|---|
| `pi_1792815412112_8umbg9wk7m4` | `op_1792815412110_xdxfupiof2` | `argus-B-BS-16-1792815412108-o90e5d` | **SETTLED** | 10000.000000 | `0xsettle1a16c2033ad…` | 200 | 2026-10-24T04:16:52.113Z | 2026-10-24T04:16:52.150Z |

## Нога recover: execution_attempts (2) — recovery без перезарядки

| started_at | attempt | execution_id | status | http | error_reason |
|---|---|---|---|---|---|
| 2026-10-24T04:16:56.640Z | #1 `attempt-1792815416637-d0mj2p3hbz` | `op_1792815412110_xdxfupiof2` | **DELIVERY_UNKNOWN** | — | **RESPONSE_STREAM_FAILED** |
| 2026-10-24T04:17:01.667Z | #2 `attempt-retry-1792815416653-ymbzq844imp` | `op_1792815412110_xdxfupiof2` | **SUCCESS** | 200 | — |

| created_at | job | status | attempt | last_error |
|---|---|---|---|---|
| 2026-10-24T04:16:56.638Z | `job-1792815416637-1bpyy1yw7p6` | **COMPLETED** | 2/3 | DELIVERY_UNKNOWN — retry attempt created |

Обе попытки принадлежат одному `execution_id` — recovery-ретрай выполняется с тем же ключом
идемпотентности. Интент при этом один, tx один: **recovery никогда не перезаряжает** — деньги
списываются один раз, хотя попыток доставки две. Именно это и есть семантика «lost response»:
сервер мог обработать платёж и умер перед ответом — ретрай безопасен только при том же
ключе идемпотентности.

## rpc-наблюдения (по 2 на ногу)

| observed_at | intent | provider | result |
|---|---|---|---|
| 2026-10-24T04:16:47.062Z | `pi_…qokwj1mqiro` | mock-a | SETTLED_FOUND |
| 2026-10-24T04:16:47.062Z | `pi_…qokwj1mqiro` | mock-b | SETTLED_FOUND |
| 2026-10-24T04:16:52.149Z | `pi_…8umbg9wk7m4` | mock-a | SETTLED_FOUND |
| 2026-10-24T04:16:52.149Z | `pi_…8umbg9wk7m4` | mock-b | SETTLED_FOUND |

Оба провайдера независимо подтвердили сеттлмент.

## nonce_registry (2)

| nonce | operation | status | payer |
|---|---|---|---|
| `0x9e989cc01e95…` | `op_1792815407011_n9j55cc07u` | **SETTLED** | `0xf39Fd6e51aad…` |
| `0x796cd7dac22d…` | `op_1792815412110_xdxfupiof2` | **SETTLED** | `0xf39Fd6e51aad…` |

## Вердикт гейта

```
OK B-BS-16 refuse:ok(attempts=1[HTTP_FAILURE:500] job=FAILED intents=1 tx=single)
      recover:ok(attempts=2[DELIVERY_UNKNOWN:RESPONSE_STREAM_FAILED,SUCCESS:200] job=COMPLETED intents=1 tx=single)
```

Event-цепочка refuse-ноги (JSONB `reconciliation_observations` интента):
`… POLICY_VALIDATION_PASSED → PAYMENT_SUBMITTED → SETTLEMENT_CONFIRMED → EXECUTION_INITIATED → EXECUTION_HTTP_FAILURE → (FAILED)` —
деньги списаны, доставка честно провалена, состояние не выдумано.

Event-цепочка recover-ноги:
`… SETTLEMENT_CONFIRMED → EXECUTION_INITIATED → EXECUTION_RETRY_CREATED → EXECUTION_SUCCESS → (COMPLETED)` —
решение о recovery записано в трейл (INV-13) до интерпретации, доставка завершена.
