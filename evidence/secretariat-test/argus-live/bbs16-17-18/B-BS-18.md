# B-BS-18 — PostgreSQL trail: over budget (run 2026-10-24T04:16Z)

> Повторный полный прогон **2026-10-24T05:14Z** — детерминированно тот же результат (гейт GREEN, канарейка GREEN, инварианты идентичны). Сырые артефакты повторного прогона: `gate.log` / `canary.log` / `full-dump.json` (обновлены 05:15-05:19Z). Живая матрица и история всех прогонов: `../matrix.json` и `../runs/*.json`.

Адаптация Lab Block D S11 «Over Budget» на x402-рельсы. Две ноги client-side политики:

- **over** — честный challenge от продавца стоит ДОРОЖЕ `policy.maxPrice` (200000 против
  cap 100000): ожидание — отказ ДО денег, `422 REQUEST_REJECTED`, ноль dispatch-ов на
  сеттлмент (rail-side proof по счётчику фасилитатора).
- **boundary** — challenge стоит РОВНО `maxPrice` (100000): инклюзивная граница, полный
  проход с одним сеттлментом и одной доставкой.

Это client-side probe: бюджет агента защищается на этапе policy verification, ещё до
подписания и отправки платёжного payload.

## Нога over: строк в PostgreSQL — ноль интентов

Отказ зафиксирован pre-intent evidence-записью в таблице `reconciliation_observations`
(результат `POLICY_REJECTED`, провайдер `evidence-log`). За окно прогона таких строк пять:
четыре от stage-a (B-BS-01..04) и пятая — от over-ноги B-BS-18:

| observed_at | observation_id | attempt_id (operation) | provider | result |
|---|---|---|---|---|
| 2026-10-24T04:17:01.797Z | `evlog|op_1792815421794_8cq27lotr66|…|POLICY_REJECTED|…` | `op_1792815421794_8cq27lotr66` | evidence-log | **POLICY_REJECTED** |

`payment_intents` для over-ноги: **0 строк**. Интент не создан, платёжный payload не
подписан, `nonce_registry` — 0 строк, `execution_attempts` — 0 строк. Отказ произошёл до
движения денег, и БД это отражает отсутствием денежных сущностей при наличии evidence-записи.

Rail-side proof (счётчик dispatch-ов фасилитатора из гейта): ноль вызовов settle,
инициированных over-ногой — пассивное отсутствие логов SUT не принимается как доказательство,
считает сама рельса.

## Нога boundary: payment_intents (1)

| payment_intent | operation | client_id | settlement_state | value | tx_hash | facilitator_http | created_at | settled_at |
|---|---|---|---|---|---|---|---|---|
| `pi_1792815421808_9yqq7v8rlz` | `op_1792815421805_eqhisidjxll` | `argus-B-BS-18B-1792815421803-a9h42v` | **SETTLED** | **100000.000000** (= maxPrice) | `0xsettle1a16c205989…` | 200 | 2026-10-24T04:17:01.808Z | 2026-10-24T04:17:01.843Z |

Граница инклюзивная: цена РОВНО по cap не отклоняется. Сравнение value — числовое
(decimal(38,6)), не строковое.

## execution_attempts (1), recovery_jobs (1)

| started_at | attempt | operation | status | http |
|---|---|---|---|---|
| 2026-10-24T04:17:06.693Z | #1 `attempt-1792815426690-exkk9mf9n99` | `op_1792815421805_eqhisidjxll` | **SUCCESS** | 200 |

| created_at | job | status | attempt |
|---|---|---|---|
| 2026-10-24T04:17:06.691Z | `job-1792815426690-6hrf2ds1gjt` | **COMPLETED** | 1/3 |

## rpc-наблюдения (2) и nonce_registry (1)

| observed_at | intent | provider | result |
|---|---|---|---|
| 2026-10-24T04:17:01.841Z | `pi_…9yqq7v8rlz` | mock-a | SETTLED_FOUND |
| 2026-10-24T04:17:01.842Z | `pi_…9yqq7v8rlz` | mock-b | SETTLED_FOUND |

| nonce | operation | status | payer |
|---|---|---|---|
| `0xcaebc168c7d6…` | `op_1792815421805_eqhisidjxll` | **SETTLED** | `0xf39Fd6e51aad…` |

## Вердикт гейта

```
OK B-BS-18 policyRejected=5 boundaryValue=100000.000000 state=SETTLED tx=single successAttempts=1
over-budget B-BS-18   → PASSED
```

Симметрия legs: сверху капы — отказ без денежного следа; ровно на капе — полный честный
проход. Обе стороны границы проверены, политика бюджета работает и не бывает слишком
строгой (не отсекает разрешённую цену).
