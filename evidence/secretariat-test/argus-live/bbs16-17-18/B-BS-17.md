# B-BS-17 — PostgreSQL trail: replay использованного нонса (run 2026-10-24T04:16Z)

> Повторный полный прогон **2026-10-24T05:14Z** — детерминированно тот же результат (гейт GREEN, канарейка GREEN, инварианты идентичны). Сырые артефакты повторного прогона: `gate.log` / `canary.log` / `full-dump.json` (обновлены 05:15-05:19Z). Живая матрица и история всех прогонов: `../matrix.json` и `../runs/*.json`.

Атака: наблюдатель сеттлмента (продавец, перехват трафика, утёкший лог) перепредъявляет
УЖЕ исполненный EIP-3009 платёжный payload напрямую в фасилитатор в надежде на второй
сеттлмент. Secretariat специально НЕ в цикле replay: настоящий double-spend его обходит.

Контракт здорового стека: **каждый replay должен быть отклонён** (single-use nonce —
EIP-3009 authorizationState), лиджер хранит ровно один сеттлмент.

## Прогон 1 — канарейка поймала течь в моке (LEAK)

```
[canary] settle: http=200 tx=0xsettle1a16aab020ebc36
[canary] replay 1/3: http=200 ACCEPTED
[canary] replay 2/3: http=200 ACCEPTED
[canary] replay 3/3: http=200 ACCEPTED
[canary] ledger: settledIntents=1 distinctTx=1
[canary] VERDICT: LEAK — 3 replay(s) were ACCEPTED (double-spend!)
```

Разбор: гейт-мок r6 уже был chain-faithful (409 на used nonce), а живой драйвер
`tests/secretariat-sandbox/drivers/argus-live-mock.mjs` — нет: он принимал replay (200).
То есть находка канарейки — дефект фиделити мока (Lab Block D, finding F1: «мок обязан
зеркалить контракт рельсы»), а не Секретариата: лиджер и в этом прогоне хранил ровно
1 сеттлмент. Фикс: single-use nonce guard в живом моке (коммит 2f21cd20a).

## Прогон 2 (после фикса) — GREEN

```
[canary] settle: http=200 tx=0xsettle1a16c20705b86f4
[canary] replay 1/3: http=409 REJECTED authorization_used
[canary] replay 2/3: http=409 REJECTED authorization_used
[canary] replay 3/3: http=409 REJECTED authorization_used
[canary] ledger: settledIntents=1 distinctTx=1
[canary] VERDICT: GREEN — every replay rejected, ledger single-settle
```

## payment_intents (1)

| payment_intent | operation | client_id | settlement_state | value | tx_hash | facilitator_http | created_at | settled_at |
|---|---|---|---|---|---|---|---|---|
| `pi_1792815416692_fezmrie3pds` | `op_1792815416689_0f3hv6eh82hc` | `argus-B-BS-17-1792815416687-i0c93v` | **SETTLED** | 10000.000000 | `0xsettle1a16c204599…` | 200 | 2026-10-24T04:16:56.693Z | 2026-10-24T04:16:56.740Z |

## execution_attempts (1), recovery_jobs (1)

| started_at | attempt | operation | status | http |
|---|---|---|---|---|
| 2026-10-24T04:17:01.675Z | #1 `attempt-1792815421662-l6crbgx2p3` | `op_1792815416689_0f3hv6eh82hc` | **SUCCESS** | 200 |

| created_at | job | status | attempt |
|---|---|---|---|
| 2026-10-24T04:17:01.663Z | `job-1792815421662-i96qjwgzzwj` | **COMPLETED** | 1/3 |

## rpc-наблюдения (2)

| observed_at | intent | provider | result |
|---|---|---|---|
| 2026-10-24T04:16:56.738Z | `pi_…fezmrie3pds` | mock-a | SETTLED_FOUND |
| 2026-10-24T04:16:56.739Z | `pi_…fezmrie3pds` | mock-b | SETTLED_FOUND |

## nonce_registry (1)

| nonce | operation | status | payer |
|---|---|---|---|
| `0x425b72a6be5f…` | `op_1792815416689_0f3hv6eh82hc` | **SETTLED** | `0xf39Fd6e51aad…` |

## Вердикт гейта

```
OK B-BS-17 intents=1 settled=1 tx=single verified>=1 attempts=1
replay     B-BS-17   → BLOCKED
```

В лиджере от трёх replay-вызовов не осталось ни строки: ни второго интента, ни второго
нонса, ни второй попытки доставки. Рельса (chain-faithful фасилитатор) отбивает replay
`409 authorization_used` — ровно как EIP-3009 `authorizationState` на реальной цепи.
