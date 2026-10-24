# pg-trail — B-BS-16 / B-BS-17 / B-BS-18 (run 2026-10-24T04:16Z)

> Повторный полный прогон **2026-10-24T05:14Z** — детерминированно тот же результат (гейт GREEN, канарейка GREEN, инварианты идентичны). Сырые артефакты повторного прогона: `gate.log` / `canary.log` / `full-dump.json` (обновлены 05:15-05:19Z). Живая матрица и история всех прогонов: `../matrix.json` и `../runs/*.json`.

Полные записи Secretariat в PostgreSQL по пост-денежному адверсариальному блоку r6-гейта
(`api-server/e2e/r6-argus-e2e.mjs`) и live-канарейке replay (`api-server/e2e/canary-live-replay.mjs`).
Это первая пара «гейт + канарейка», закрывающая дыру покрытия B-BS-01..15: все предыдущие
адверсариальные сценарии отбивали атаку ДО денег, и конвейер после сеттлмента не был
нагружен противником ни разу.

- Стек: реальный Secretariat (`/v1` на :8080, standalone-бандл) + embedded PostgreSQL 17.5
  (миграции 0000+0005..0010) + chain-faithful мок рельсы (:9977 — discovery /resource,
  facilitator /settle c single-use nonce, /seller, mock JSON-RPC /rpc).
- Гейт: `TOTAL: blocked=16/16 passed=4/4 leaked=0 | PG: ok=20 fail=0 — GATE: GREEN`.
- Канарейка B-BS-17-live: `VERDICT: GREEN — every replay rejected, ledger single-settle`.

## Сводка по PostgreSQL

| сценарий | интентов | SETTLED | наблюдений (rpc) | POLICY_REJECTED (evidence-log) | попыток доставки | recovery-задач | нонсов |
|---|---|---|---|---|---|---|---|
| B-BS-16 refuse | 1 | 1 | 2 | — | 1 (HTTP_FAILURE 500) | 1 (FAILED) | 1 |
| B-BS-16 recover | 1 | 1 | 2 | — | 2 (DELIVERY_UNKNOWN → SUCCESS) | 1 (COMPLETED) | 1 |
| B-BS-17 | 1 | 1 | 2 | — | 1 | 1 (COMPLETED) | 1 |
| B-BS-18 over | 0 | 0 | — | +1 (всего 5 за окно) | 0 | 0 | 0 |
| B-BS-18 boundary | 1 | 1 | 2 | — | 1 | 1 (COMPLETED) | 1 |

Ключевые инварианты, подтверждённые гейтом из БД:

- **B-BS-16 refuse**: ровно 1 попытка доставки (5xx — это окончательный ответ, слепой ретрай
  не выполняется), recovery-задача FAILED, ровно 1 сеттлмент с единственным tx, никакого
  фейкового COMPLETED: честная неудача доставки не превращается в успех.
- **B-BS-16 recover**: попытка #1 `DELIVERY_UNKNOWN/RESPONSE_STREAM_FAILED`, попытка #2
  `SUCCESS/200` с тем же `execution_id` (= тот же ключ идемпотентности), ровно 1 сеттлмент
  на обе попытки — recovery не перезаряжает.
- **B-BS-17**: ровно 1 интент, 1 сеттлмент, единственный tx; replay-вызовы идут МИМО
  Secretariat напрямую в фасилитатор и отбиваются `409 authorization_used` (EIP-3009
  authorizationState — single-use). В лиджере от replay не осталось следов.
- **B-BS-18**: over-нога не создала ни интента, ни сеттлмента — только pre-intent
  evidence-запись `POLICY_REJECTED`; счётчик dispatch-ов фасилитатора (rail-side proof)
  подтверждает ноль отправок на сеттлмент. Boundary-нога по цене РОВНО maxPrice проходит:
  инклюзивная граница, 1 сеттлмент + 1 доставка.

## Находка канарейки (первый же прогон)

Первый live-прогон канарейки закончился `VERDICT: LEAK — 3 replay(s) ACCEPTED`: живой мок
`argus-live-mock.mjs` принимал replay (200), хотя r6-мок в гейте уже был chain-faithful.
Diagnosis: коммит 2f9a28067 добавил replay-guard (F1 — «мок обязан зеркалить контракт рельсы»)
только во встроенный мок гейта, живой драйвер не трогал. Фикс: single-use nonce guard
(`409 authorization_used`) в `argus-live-mock.mjs` (коммит 2f21cd20a). Повторный прогон —
GREEN. Канарейка доказала свою usefulness в первый день: она поймала дефект фиделити мока,
который гейт не видел.

## Файлы

- `B-BS-16.md`, `B-BS-17.md`, `B-BS-18.md` — человекочитаемые трейлы (реальные строки БД);
- `full-dump.json` — сырые строки всех таблиц за прогон;
- `gate.log` — вердикты r6-гейта и PG-проверок;
- `canary.log` — лог live-канарейки B-BS-17.

Таблицы: `payment_intents` (интент + сеттлмент), `reconciliation_observations` (rpc-таблица:
наблюдения сверки; evidence-log: pre-intent отказы политики), `execution_attempts` (попытки
доставки), `recovery_jobs` (восстановление), `nonce_registry` (реестр нонсов).
