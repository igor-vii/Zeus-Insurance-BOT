# Role & participantId inventory (R2.5-A)

> **Historical inventory.** This document records a past rename audit and its Secretariat-era terminology. Do not treat Secretariat as the canonical SUT. Current Argus architecture is black-box and SUT-agnostic: the SUT role is discovered from observable behavior and the opposite-side counterparty is selected accordingly.


Read-only инвентаризация для будущего rename (R2.5-B). Ничего в этом блоке не изменено.

## 1. Что проверялось

- Все вхождения `buyer-1` / `seller-1` / `sut-1` как participantId: `src/scenarios/*.ts`, `src/core/*.ts`, `src/adapters/**`, `src/tests/**`, `tools/**`, docs, корневые файлы (`README.md`, `ROADMAP-2026-09-13.md`, `ROADMAP-2026-09-18.md`, `.env.example`, `package.json`, `vercel.json`, `tsconfig.json`, `.gitignore`).
- Все упоминания экономических слов: `buyer`, `seller`, `payer`, `payee`, `client`, `resource server`, `facilitator`, `secretariat`, `counterparty`, `agent`.
- `protocolRole`: где определён, где используется, где сравнивается, где нарушается канон.
- Канонизация: `ProtocolRole = 'CLIENT' | 'RESOURCE_SERVER' | 'FACILITATOR'`; запрещённые литералы; тест `Participant.test.ts`.
- Особые случаи: S8 (`sut-1` = RESOURCE_SERVER), R2-тест `LifecycleObservationPlumbing.test.ts`, assertions с `source === 'buyer-1'/'seller-1'`.

Инструменты: `grep -rIn` по всем перечисленным путям (case-sensitive + word-boundary проверки), чтение `src/core/Participant.ts`, `src/tests/core/Participant.test.ts`, всех восьми сценариев, `docs/block-a-audit.md`, `docs/evidence-source-map.md`.

## 2. Canonical baseline

- Ветка: `qwen-code-7f970829-ae14-42ad-b3f8-1c29caf266b1`, HEAD = **f447082** («chore: install dev dependencies…»).
- История: `f89d551` — R2 plumbing; `7eec78e` — R1 evidence-source-map; база `9c58801 (main)`.
- Рабочее дерево на момент инвентаризации содержало **uncommitted изменения вне моего хода**: `M src/scenarios/S2_PaymentBeforeExecution.ts`, `M src/scenarios/S4_SellerTimeout.ts` (+14 строк каждый — добавлены seller-action `deliver` и перенос fault на `action_deliver`, т.е. фактически реализован Decision 3(a)), untracked `src/tests/scenarios/S2-S4-SellerAction.test.ts`, untracked `dist/`, изменён `node_modules/.vite/vitest/results.json`. Инвентаризация выполнена по фактическому состоянию рабочего дерева; эти файлы помечены ⚠️ WT (worktree-only).
- `docs/scenario-catalogue.md` в main **отсутствует** (проверено).
- `.gitignore`, `package.json`, `vercel.json`, `tsconfig.json`, `.env.example`, `README.md` — ноль вхождений имён участников.
- `tools/sut-server/server.ts` — ноль вхождений `buyer/seller/sut-1` (экономические слова тоже отсутствуют).

## 3. buyer-1 — вхождения

Итого строк с `buyer-1` (grep -c по файлам): **scenarios=32, core=0, adapters=0, tests=45, docs=17, root-md=0** (HEAD-состояние сценариев — 29; +3 строки в WT S2/S4/S2-S4-test). Файлы: все S1–S8 (6/3/3/3/4/4/3/3), ScenarioEngine.test (9), sitecheck-smoke/payment-boundary (по 6), FaultInjector.test (3), EvidenceCollector.test (2), AssertionEngine.test (1), Participant.test (2), LifecycleObservationPlumbing.test (2), X402FullFlow.test (2), AgentController.test (1), S1-S7.test (1), S2-S4-SellerAction.test⚠️WT (5); docs: block-a-audit (13), evidence-source-map (4).

Ключевые места (полный список воспроизводится `grep -rn "buyer-1" src docs`):

| Файл | Строки | Контекст | Классификация |
|---|---|---|---|
| src/scenarios/S1–S8 | 9–47 (каждый) | `{ participantId: 'buyer-1', protocolRole: 'CLIENT', ownership: 'ARGUS' }` | protocol-role-as-participantId (CLIENT) |
| src/scenarios/S1,S2,S5,S6,S7,S3,S4 | topology | `{ from: 'buyer-1', to: 'sut-1', kind: 'request' }` | participantId-opaque (rename обязателен) |
| src/scenarios/* | actions | `actor: 'buyer-1'` (все действия всех S1–S8) | protocol-role-as-participantId |
| src/scenarios/S1,S5,S6 | faults | `target: { kind: 'participant', participantId: 'buyer-1' }` | participantId-opaque |
| src/scenarios/S1 | 66,70 | комментарии «buyer-1 sends request_payment…» | economic-role (комментарий) |
| src/tests/core/ScenarioEngine.test.ts | 152–362 | `registry.register('buyer-1', …)`, participants, `actor: 'buyer-1'`, fault targets, `{ type: 'BUY_ACTION' }` | participantId-opaque; BUY_ACTION — см. §6/§11 |
| src/tests/core/FaultInjector.test.ts | 97–127 | fault target + `getFaultsForEvent(…, 'buyer-1')` | participantId-opaque |
| src/tests/core/EvidenceCollector.test.ts | 42,58 | `source: 'buyer-1'` в evidenti-записи | participantId-opaque |
| src/tests/core/AssertionEngine.test.ts | 60 | `source: 'buyer-1'` | participantId-opaque |
| src/tests/core/Participant.test.ts | 71–75 | тест «buyer-1 is CLIENT in all scenarios» | protocol-role-as-participantId (гард канона) |
| src/tests/core/LifecycleObservationPlumbing.test.ts ⚠️ | 65, 293 | `registry.register(opts?.actor ?? 'buyer-1', controller)` | participantId-opaque (§5.2, risk list) |
| src/tests/core/AgentController.test.ts | 377 | комментарий-страховка «не ссылаться на 'sut-1','buyer-1','seller-1'» | documentation-текст |
| src/tests/integration/X402FullFlow.test.ts | 63,117 | `controllers.set('buyer-1', controller)` | participantId-opaque |
| src/tests/external/sitecheck-smoke / payment-boundary | 75–404 | participants/actor/topology/`run_${Date.now()}_buyer-1`/`setParticipantId`/`register` | participantId-opaque + runId-строки |
| src/tests/scenarios/S2-S4-SellerAction.test.ts ⚠️WT | 85,107,168,277–278 | ключи `'buyer-1:request_payment'`, getFaultsForEvent | participantId-opaque |
| docs/block-a-audit.md | 17,18,36,40–47,69,70 | таблицы ролей и действий | documentation-текст |
| docs/evidence-source-map.md | 117,155,165–166 | S6-fault на buyer-1, Decision 3(c) | documentation-текст |

Ни в одном assertion canonical-сценариев нет `source === 'buyer-1'` (источник наблюдений — `sut-1`/`seller-1`/`engine`); `buyer-1` встречается как `source:` только в юнит-тестах EvidenceCollector/AssertionEngine.

## 4. seller-1 — вхождения

Итого строк: **scenarios=36, core=0, adapters=1, tests=35+17(WT)=52, docs=8, root-md=3** (HEAD-состояние тестов — 35 без WT-файла). Файлы: S1–S7 (3/7/3/6/3/3/11), PaymentAdapter.ts (1, JSDoc), ScenarioEngine.test (3), FaultInjector.test (4), FaultDispatchContract.test (2), Participant.test (4), LifecycleObservationPlumbing.test (2), X402FullFlow.test (1), signingBinding.test (1), PaymentAdapterFactory.test (1), AgentController.test (1), S2-S4-SellerAction.test⚠️WT (17); docs: block-a-audit (3), evidence-source-map (5), ROADMAP-2026-09-13 (3).

| Файл | Строки | Контекст | Классификация |
|---|---|---|---|
| src/scenarios/S1–S7 | 11–26 | `{ participantId: 'seller-1', protocolRole: 'RESOURCE_SERVER', ownership: 'ARGUS' }` + комментарий Block A | protocol-role-as-participantId (RESOURCE_SERVER) |
| src/scenarios/S1–S7 | topology | `{ from: 'sut-1', to: 'seller-1', kind: 'forward' }`; S7: `{ from: 'seller-1', to: 'sut-1', kind: 'response' }` | participantId-opaque |
| src/scenarios/S2 ⚠️WT, S4 ⚠️WT | 44/43, 52/51 | `actor: 'seller-1'`, fault `participantId: 'seller-1'` (появились в worktree, не в HEAD) | protocol-role-as-participantId |
| src/scenarios/S2 | 74,88 | `referencedSources: ['sut-1','seller-1']`, `e.source === 'seller-1' && e.type === 'delivery_completed'` | participantId-opaque (assertion) |
| src/scenarios/S7 | 6,46,51–60,79,81 | fault edge `{from:'seller-1',to:'sut-1'}`, `sellerSent = e.source === 'seller-1' && e.type === 'delivery_sent'` | participantId-opaque + economic-role (локальная переменная `sellerSent`) |
| src/adapters/payment/PaymentAdapter.ts | 41 | JSDoc «forRole — participantId (например, 'seller-1')» | documentation-текст (единственное вхождение имени в adapters) |
| src/core/FaultInjector.ts | 54 | комментарий «Compatibility path for S7's baseline seller response» | economic-role (комментарий) |
| src/tests/core/ScenarioEngine.test.ts | 153–166 | register, RESOURCE_SERVER, `{ actor: 'seller-1', type: 'SELL_ACTION' }` | participantId-opaque; SELL_ACTION — §6/§11 |
| src/tests/core/FaultInjector.test.ts | 105–121 | participant-targeted faults, `getFaultsForEvent('payment_settled','seller-1')===0` | participantId-opaque |
| src/tests/core/FaultDispatchContract.test.ts | 34,50 | participant и edge targets на seller-1 | participantId-opaque |
| src/tests/core/Participant.test.ts | 40,86–91 | optional-role тест + гард «seller-1 (S1–S7) is RESOURCE_SERVER» | protocol-role-as-participantId |
| src/tests/core/LifecycleObservationPlumbing.test.ts | 206,212 | fault target seller-1 / spy-проверка | participantId-opaque (§5.2) |
| src/tests/integration/X402FullFlow.test.ts | 44 | `'seller-1': '0x7099…'` — маппинг payTo-адресов | participantId-opaque (экономический смысл: получатель платежа) |
| src/tests/adapters/payment/*.test.ts | 32,25 | `getReceiveAddress('seller-1')`, binding map | participantId-opaque |
| src/tests/scenarios/S2-S4-SellerAction.test.ts ⚠️WT | 7–241 | весь файл построен вокруг seller-1 | participantId-opaque |
| docs/block-a-audit.md | 18,19,69 | роль-таблица | documentation-текст |
| docs/evidence-source-map.md | 81,153–159,195 | #10 delivery_sent, Decision 3 | documentation-текст |
| ROADMAP-2026-09-13.md | 20,35,40 | referencedSources-планирование | documentation-текст |

## 5. sut-1 — вхождения

Итого строк: **scenarios=63, core=2, adapters=0, tests=58, docs=7, root-md=2**. Файлы: S1–S8 (8/7/8/10/8/6/13/3), Participant.ts (2, только JSDoc), ScenarioEngine.test (22), EvidenceCollector.test (12), AssertionEngine.test (5), FaultInjector.test (9), LifecycleObservationPlumbing.test (4), Participant.test (2), FaultDispatchContract.test (1), AgentController.test (1); docs: block-a-audit (4), evidence-source-map (3), ROADMAP-2026-09-13 (2).

- `src/core/Participant.ts:8,22` — только JSDoc-примеры «sut-1: FACILITATOR в S1–S7, RESOURCE_SERVER в S8». participantId в ядре кода **не хардкодится нигде, кроме комментариев** (подтверждено grep по src/core, src/adapters, src/api).
- Сценарии S1–S7: `{ participantId: 'sut-1', protocolRole: 'FACILITATOR', ownership: 'EXTERNAL' }`; S8: `protocolRole: 'RESOURCE_SERVER'` — **особый случай §5.1**.
- Assertions большинства сценариев читают `e.source === 'sut-1'` (S1:73, S2:77/80, S3:67/76, S4:76–88, S5:65/81, S6:64, S7:85/90/96) — это testSubject-ассоциация, rename **не требуется** (имя не меняется).
- Тесты: ScenarioEngine (22 строки), EvidenceCollector (12), LifecycleObservationPlumbing (153,170 — `expect(source).toBe('sut-1')`), остальные — registry/orchestrator wiring.
- Классификация повсеместно: participantId-opaque / метка внешнего объекта (не экономическая роль).

## 6. Экономические термины — вхождения

Подсчёт whole-word (`grep -w`), без суффикса `-1`:

| Слово | src | docs+root | tools | Характер вхождений |
|---|---|---|---|---|
| buyer | 83 | 30 | 0 | почти всё — `buyer-1`/`buyerSide`; чистое слово: PaymentAdapter.ts:6,68,80 («Argus как buyer», «buyer-side economic layer»), SigningBinding.ts:3,7,24,77,112 (Secretariat-терминология), комментарии сценариев → economic-role |
| seller | 108 | 46 | 0 | `seller-1` + `sellerSent`/`SellerTimeout` (имя файла S4), FaultInjector.ts:54, PaymentAdapter.ts:7 («Argus как seller»), descriptions сценариев → economic-role |
| payer | 0 | 2 | 0 | только тексты (docs/x402-reference.md и др.) → documentation-текст |
| payee | 0 | 2 | 0 | только тексты + поле `payTo` (не совпадение слова) → documentation-текст |
| client | 0 | 16 | 0 | только тексты; в коде — только UPPER_SNAKE `CLIENT` (канон) → documentation-текст |
| facilitator | 1 | 13 | 0 | src: MockTargetAdapter.ts:50 (JSDoc про settlement-слой) → economic-role в комментарии; UPPER_SNAKE `FACILITATOR` — канон |
| secretariat | 1 | 3 | 0 | src: SigningBinding.ts:3 (комментарий «buyer-side economic layer (Secretariat)») → application-role |
| counterparty | 0 | 0 | 0 | отсутствует |
| agent | — | — | — | системное слово (AgentController, Argus-Agent); как protocolRole нигде не используется |
| resource server | — | — | — | `RESOURCE_SERVER` — канон; lowercase «resource server» только в docs (block-a-audit, x402-reference) |

Проверка нарушений канона в коде:
- `role: 'buyer'` / `role: 'seller'` — **не встречается**;
- `protocolRole === 'BUYER'/'SELLER'/'PAYER'/'PAYEE'` — **не встречается** (единственные вхождения FORBIDDEN-литералов — сам список запретов и `@ts-expect-error`-случаи в Participant.test.ts:21–34, это страж, а не нарушение);
- `source === 'buyer-1'` в assertions канонических сценариев — нет; есть `source === 'seller-1'` (S2:88, S7:81) и в R2/R2-WT тестах — часть rename-плана, нарушением канона не является.

## 7. protocolRole — состояние канона

- **Определён:** `src/core/Participant.ts:12` — `export type ProtocolRole = 'CLIENT' | 'RESOURCE_SERVER' | 'FACILITATOR';`. Поле `protocolRole?: ProtocolRole` опционально (undefined = app-level участник). Документированы принципы: Role ≠ Name, Role ≠ Ownership, per-scenario роли.
- **Используется (задание):** только декларации участников в `src/scenarios/S1–S8` (см. §3–5) и в тестах (`sitecheck-*`, `ScenarioEngine.test`, `S2-S4-SellerAction.test`⚠️WT).
- **Используется (сравнения/lookup):** runtime-потребителей в `src/core` **нет** — движок, FaultInjector, AssertionEngine, RunOrchestrator по `protocolRole` не ветвятся (grep подтверждает: ни switch, ни `protocolRole ===` вне Participant.ts/сценариев). Сравнения — только в `Participant.test.ts` (гарды: canonical-значения, отсутствие forbidden, buyer-1=CLIENT везде, sut-1 per-scenario, seller-1=RESOURCE_SERVER в S1–S7).
- **Где не используется, но мог бы:** там, где участникам можно было бы вообще не задавать протокольную роль (app-level) — сейчас всем каноническим участникам она задана; расхождений нет.
- **Нарушения канона:** **0 мест.**

## 8. Mapping table

| Старое имя | Протокольная роль | Новое имя | Обоснование |
|---|---|---|---|
| buyer-1 | CLIENT (все S1–S8) | **client-1** | имя должно отражать протокольную роль, а не экономическую |
| seller-1 | RESOURCE_SERVER (S1–S7) | **resource-server-1** | то же |
| sut-1 | FACILITATOR (S1–S7), RESOURCE_SERVER (S8) | **sut-1 (не менять)** | не роль, а метка внешнего объекта (System Under Test); роль меняется между сценариями — переименование под одну роль было бы ошибкой |

Формат participantId — kebab-case (`client-1`, `resource-server-1`, `sut-1`); ProtocolRole остаётся UPPER_SNAKE (`CLIENT`, `RESOURCE_SERVER`, `FACILITATOR`). Одиночный дефис в `resource-server-1` соответствует существующему стилю `sitecheck-1`.

Смежные идентификаторы, которые mapping **не** затрагивает автоматически (вынесено в открытые вопросы §11): `BUY_ACTION`/`SELL_ACTION` (типы действий в двух юнит-тестах), имена файлов `S4_SellerTimeout.ts`, `S2-S4-SellerAction.test.ts`, описание S4 «Seller фактически…», локальные переменные (`sellerSent`), заголовок-терминология Secretariat.

## 9. Risk list

Места, где rename меняет строковые значения (семантика сохраняется — тот же участник, другое имя; менять нужно все, синхронно одним коммитом):

1. **Assertions с source-сравнением:** S2:88 `e.source === 'seller-1'`; S7:81 `e.source === 'seller-1'` → `'resource-server-1'`. `source === 'sut-1'` — не трогаем.
2. **`referencedSources`:** S2:74 `['sut-1','seller-1']`, S7:79 `['seller-1','sut-1']`, S4:73 `['sut-1','seller-1']` (⚠️WT-версии включают и seller-1).
3. **Fault targets:** `{kind:'participant', participantId:'buyer-1'}` — S1:45, S5:42, S6:42 (+S2:52, S4:51 ⚠️WT seller-1); `{kind:'edge', from:'seller-1', to:'sut-1'}` — S7:60, FaultDispatchContract.test.ts:50.
4. **Topology edges:** `from:'buyer-1'` — S1–S8 (8 файлов); `to:'seller-1'` — S1–S7; `from:'seller-1'` — S7:27; sitecheck-тесты `edges:[{from:'buyer-1',…}]`.
5. **Actors действий:** `actor:'buyer-1'` во всех S1–S8; `actor:'seller-1'` (⚠️WT S2/S4).
6. **Registry/controller wiring в тестах:** `registry.register('buyer-1'|'seller-1', …)` — ScenarioEngine.test (×4), LifecycleObservationPlumbing.test:65,293, X402FullFlow.test:63,117 (`controllers.set`), sitecheck-* (:209–210, :403–404 `controller.setParticipantId('buyer-1')`), S2-S4-SellerAction.test⚠️WT.
7. **RunId-строки:** `` run_${Date.now()}_buyer-1 `` — sitecheck-smoke:192, sitecheck-payment-boundary:387 (rename косметический, но иначе имена разойдутся в отчётах).
8. **Evidence fixtures в юнит-тестах:** `source:'buyer-1'` — EvidenceCollector.test:42,58, AssertionEngine.test:60.
9. **Payment-конфиг:** `'seller-1': '0x7099…'` — X402FullFlow.test:44, signingBinding.test:32, `getReceiveAddress('seller-1')` — PaymentAdapterFactory.test:25 (ключи маппинга адресов).
10. **Тест-гарды канона:** Participant.test.ts:71–95 (`find(p => p.participantId === 'buyer-1'/'seller-1')`) — переименовать вместе, иначе гарды тихо перестанут находить участников (`find` вернёт undefined, `expect(undefined?.protocolRole)` может дать ложный проход без strict-режима — проверить при rename).
11. **Комментарий-страховка:** AgentController.test.ts:377 перечисляет старые имена — обновить текст.
12. **JSDoc-пример:** PaymentAdapter.ts:41 «например, 'seller-1'».
13. **Docs:** evidence-source-map.md (~24 строки), block-a-audit.md (~15 строк), ROADMAP-2026-09-13.md (3 строки) — по §5.3 сохранять старое имя в скобках.

Объём risk list: **13 позиций**.

## 10. Особые случаи

### 10.1 sut-1 в S8
В S8 `sut-1` имеет `protocolRole: 'RESOURCE_SERVER'` (сам отдаёт 402/protected resource, seller-1 отсутствует), в S1–S7 — `FACILITATOR`. Это **не ошибка**: `sut-1` — метка внешнего объекта, не роль. **sut-1 не переименовывается.** Канон зафиксирован в Participant.ts:6–9 и защищён тестом Participant.test.ts («sut-1 role is PER-SCENARIO»).

### 10.2 LifecycleObservationPlumbing.test.ts (R2-тест)
Хардкоды: `:65` (`registry.register(opts?.actor ?? 'buyer-1', …)`), `:293` (то же), `:153/:170` (`expect(source).toBe('sut-1')` — не меняется), `:206/:212` (fault target/spy `'seller-1'`). Все `buyer-1`/`seller-1` позиции включены в risk list (п.6, п.9 через harness).

### 10.3 docs/evidence-source-map.md
При переименовании в docs сохранять прежнее имя в скобках для преемственности чтения: `client-1 (buyer-1)`, `resource-server-1 (seller-1)`; `sut-1` без скобок. То же применимо к block-a-audit.md и ROADMAP-докам.

### 10.4 Изменения в рабочем дереве (не мои)
S2/S4 в worktree уже содержат seller-action `deliver` (`actor:'seller-1'`) и перенос fault на `action_deliver`, плюс untracked `S2-S4-SellerAction.test.ts` — это фактически принятый вариант Decision 3(a)/seller-action, появившийся вне рамок R2.5-A. Для R2.5-B важно: эти файлы добавляют ~20 новых позиций `seller-1` в risk list; их статус (коммитить/откатывать) — решение архитектора, здесь только фиксирую факт.

## 11. Открытые вопросы

1. **`BUY_ACTION` / `SELL_ACTION`** (ScenarioEngine.test.ts:165–166,187,191) — экономические литералы в типах действий. Не protocolRole, но семантически buyer/seller. Менять ли (`CLIENT_ACTION`/`RESOURCE_SERVER_ACTION` или нейтральные) — за архитектором.
2. **Имена файлов и классов:** `S4_SellerTimeout.ts`, `S2-S4-SellerAction.test.ts`, id/description сценариев («Seller фактически отвечает…») — входят ли в scope rename?
3. **Локальные идентификаторы:** `sellerSent`, `sellerController`, переменная `buyer` в Participant.test — минимальный cosmetic-слой; включать или оставить?
4. **`payTo`/`authorizer`**-терминология PaymentAdapter/SigningBinding (buyer-side/seller-side комментарии) — это доменная лексика Secretariat-слоя; подтверждение, что она НЕ трогается.
5. **Судьба WT-изменений S2/S4 и нового теста** (п.10.4) — до rename или после; иначе R2.5-B будет рефакторить незакоммиченный код.
6. **Sitecheck-внешние тесты** используют `buyer-1` против реального endpoint; изменение runId-строк может повлиять на парсинг внешних отчётов — нужна ли совместимость?
7. **Строгий порядок применения rename** (core-гарды vs сценарии vs docs) — чтобы `Participant.test.ts` не остался с молча проходящими `find(...)===undefined`.

---
*Документ создан в блоке R2.5-A. Код, тесты, сценарии и существующие docs не изменялись. Ничего не коммитилось и не пушилось.*
