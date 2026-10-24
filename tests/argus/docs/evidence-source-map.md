# Evidence Source Map (R1)

Архитектурный документ. Не код, не спецификация реализации. Фиксирует, для каждого
evidence-типа, встречающегося в assertions сценариев S1–S8: откуда он по смыслу приходит,
кто его потребитель, есть ли механизм эмиссии сейчас и что нужно для замкнутости цикла
«источник → EvidenceCollector → assertion».

Это вход для блока R2. Ни один decision-required в этом документе не выбирается —
они вынесены в раздел 3 как решения архитектора.

Проверено по состоянию main (commit `9c58801`, "test: close L0-F2 coverage gaps").

---

## Раздел 1 — Классификация механизмов

Четыре механизма появления evidence в EvidenceCollector.

### O — Observation (внешний мир сообщил)

Внешний Sut (или seller) сообщил состояние. Адаптер цели (`MockTargetAdapter`,
`HttpAgentAdapter`, `X402AgentAdapter`) передал это как
`exchange.metadata.observations: string[]`. `ScenarioEngine.performAction()` читает
`metadata.observations` и записывает каждую строку в `EvidenceCollector` с
`source = scenario.testSubject`; если адаптер указал `metadata.participantId`,
он сохраняется как `actorId`.

Примеры сегодня: `payment_intent_created`, `payment_intent_reused`,
`response_received` (эмитятся только `MockTargetAdapter` в ветке `request_payment`).

Ограничение механизма: observation может прийти **только как ответ на action**
(buyer → sut). Состояния, которые внешний мир «сообщает сам, без запроса»
(settlement-notify, timeout-уведомление), текущим путём не проходят — нужен либо
polling/push-канал в адаптере, либо другой механизм.

### I — Internal evidence (Argus вывел сам)

Движок (Argus) сам выводит состояние и записывает его напрямую в `EvidenceCollector`
с `source = 'engine'` или с конкретным компонентом. Эмиссия не зависит от внешнего мира.

Примеры сегодня (`ScenarioEngine.performAction`, PAYMENT_REQUIRED-ветка):
`payment_required_no_resolver`, `payment_signed_and_retried`, `payment_signing_failed`.
Также engine-событие `action_<type>` после каждого выполненного действия.

### F — Fault-triggered (событие от применения fault)

Событие создаётся применением fault из `FaultInjector`: примитивы `delayed_response`
и `hang` эмитят `delivery_started` / `delivery_completed` через emit-callback с
`source = target.participantId`. По контракту L0-F2 (`docs/l0-f2-fault-dispatch-contract.md`)
активный dispatch работает **только для `action_*` триггеров и participant-целей**,
причём `target.participantId === action.actor`. Lifecycle-триггеры
(`delivery_started`, `payment_settled`, `settlement_unknown`, `delivery_sent`) —
declared-only, рекурсивного dispatch нет. Отдельная совместимая дорожка — baseline
responder `respond` (S7), диспатчится через `getRespondersForEvent()`, не через fault-dispatch.

### E — Edge-mediated (через границу между участниками)

Событие проходит через ребро топологии (границу между двумя участниками) и может быть
перехвачено, задропнуто или искажено на этой границе. **Сейчас такого механизма нет**:
edge-цели faults declared-only (L0-F2 п.6); в S7 `lost_delivery` объявлен, но
«семантически не имеет наблюдаемого эффекта» (комментарий в самом сценарии).

---

## Раздел 2 — Таблица Evidence Source Map

Все типы, которые встречаются в assertions сценариев S1–S8. «Есть сейчас?» — проверено
grep-ом по `src/` (эмитент ≠ декларация в trigger/config).

| # | Evidence type | Кто ждёт (сценарии) | Источник по смыслу | Механизм | Потребитель | Есть сейчас? | Что нужно для замкнутости |
|---|---------------|--------------------|--------------------|----------|-------------|--------------|---------------------------|
| 1 | `payment_intent_created` | S1, S5 | Sut | O | S1 `assert_no_duplicate` (sut-1, idempotencyKey='key-1'); S5 `assert_concurrent_single_intent` (sut-1, key='key-5') | Да — `MockTargetAdapter` (O), записывается с source=testSubject | Ничего (для mock-режима; HTTP/Sut-адаптеры должны передавать observations — см. примечание A) |
| 2 | `payment_intent_reused` | S1 (косвенно, комментарий) | Sut | O | S1 — ожидание второй волны при повторном key | Частично — `MockTargetAdapter` эмитит, но ни одна assertion не матчит тип | Расширить адаптер (для реального Sut); assertions не требуют |
| 3 | `response_received` | S1 (косвенно, комментарий) | Sut | O | пока никем в assertions не матчится | Частично — эмитится `MockTargetAdapter`, потребителя нет | Ничего (тип уже эмитится; consumer появится с assertions) |
| 4 | `payment_settled` | S2, S3, S4, S6, S7 | Sut (платёжный провайдер/ledger) | O (по смыслу) | S2 gate; S3 счётчик (0/1/>1); S4 gate+счётчик; S6 основной счётчик PASS/FAIL; S7 anti-duplicate | **R3: да** — Sut-observation-канал (`options.lifecycleObservations`); Decision 1-adjacent вариант (a) принят архитектором; сконфигурирован в S2-harness (PASS-путь). Реальный Sut-адаптер — ещё нет | Зависит от Decision 1-adjacent: через Sut-канал — расширить адаптер; ledger-poll внутри Argus — internal. Минимальный путь: расширить адаптер |
| 5 | `settlement_unknown` | S6 (как trigger faults) | Sut или Argus | O / I / F — нерешено (Decision 1) | S6 использует тип только как lifecycle-trigger объявления; активных assertions на сам тип нет | **R3: да (observation от Sut)** — Decision 1 принят в варианте (a): канал принимает `settlement_unknown` дословно (UNKNOWN≠FAILURE сохранён); как fault-trigger в S6 по-прежнему declared-only (L0-F2) → S6 BLOCKED | См. Decision 1: расширить адаптер (a) / правило движка (b) / lifecycle dispatch + fault primitive (c) |
| 6 | `success` | S2, S4 (антиусловие), S7 (нет) | Sut | O (спорно — Decision 2) | S2 PASS требует success после settled; S4 FAIL при любом success | **R3: да (observation от Sut)** — Decision 2 принят в варианте (a): `success` эмитит только Sut; в S2-harness сконфигурирован PASS-путь; S4 Sut намеренно молчит (антиусловие сохранено) | См. Decision 2: если наблюдает Sut — расширить адаптер (канал готов); internal-вывод запрещён логикой S4 |
| 7 | `failed` | S4, S7 (антиусловия) | Sut | O (спорно — Decision 2) | S4 FAIL при failed при молчащем seller; S7 FAIL при failed, если seller реально ответил | **R3: да (Sut-канал)** — Decision 2 (a); эмиссия конфигурируется harness там, где Sut реально сообщает failure; спекулятивных эмиссий нет | См. Decision 2: расширить адаптер (Sut-канал готов); internal недопустим (ломает антиусловия) |
| 8 | `delivery_started` | S2, S4 (как trigger faults) | seller (начало обработки заказа) | F (частично) / E | trigger в faults S2 (`delayed_response`), S4 (`hang`) | **R3: да** — Decision 3(a) реализован: seller-action `deliver` от resource-server-1; faults перенесены на `action_deliver`, FaultInjector эмитит `delivery_started` через существующий emit-путь (lifecycle dispatch НЕ вводился) | Seller-action (a) либо lifecycle dispatch (b) — Decision 3 |
| 9 | `delivery_completed` | S2 | seller (ответ окончен) | F | S2 `sellerReallyResponded` — условие PASS | **R3: да** — эмитится `FaultInjector.delayed_response` на `action_deliver` (seller-action), source = resource-server-1; S2 `sellerReallyResponded` находится | То же, что #8 (Decision 3) |
| 10 | `delivery_sent` | S7 | seller | F (respond-baseline) | S7 `sellerSent` — gate условия | **Да (частично)** — baseline responder `respond` с `config.emit='delivery_sent'` эмитит с source=resource-server-1 (seller-1) через отдельную совместимую дорожку L0-F2 | Ничего для эмиссии; содержательность требует edge-mediator для #11/#12 |
| 11 | `delivery_received` | S7 | Sut (получил ответ через edge) | E | S7 антиусловие: sut получил то, что должен был потерять | **Нет** — механизма пересечения границы нет | Edge-mediator |
| 12 | `delivery_unknown` | S4, S7 | Sut (вывод: терминальное состояние не наступило к таймауту) | I или E-опосредованно — нерешено | S4 PASS-цель; S7 PASS-цель | **Частично (R3)** — тип доступен как observation от Sut через `options.lifecycleObservations` (в allow-list с R2); канонический S4 Sut его не сообщает → S4 остаётся INCONCLUSIVE; PASS достижим при конфигурации наблюдения | Открытый вопрос (раздел 4, Q1): internal-правило движка (timeout→UNKNOWN) либо результат edge-наблюдения |
| 13 | `recovery_completed` | S3 | Sut (после crash+restart) | O (по смыслу) / инфраструктурный | S3 `recovery` — gate | **Нет** — crash fault (`infrastructure` target) declared-only, restart-цикла нет | Не определено (вне L0-F2; infrastructure interception — non-goal). Для mock — расширение адаптера; по сути — lifecycle-работа движка |
| 14 | `forward_request` | S3 | Argus (retry к seller после recovery) | I | S3 `resumedForward` (source='engine', timestamp > recovery) | **Нет** — engine эмитит только `action_<type>`; forward-шаг отдельным событием не пишется | Ничего критичного: переписать assertion на `action_request_payment` либо добавить internal-эмиссию forward (движок, без новых механизмов) |
| 15 | `payment_required_no_resolver` | S8-окружение (engine-diagnostic) | Argus | I | diagnostics; явных assertions в S1–S8 нет | **Да** — `ScenarioEngine.performAction` | Ничего |
| 16 | `payment_signed_and_retried` | S8 | Argus | I | S8 `assert_payment_flow_completed` (source='engine') — единственный PASS-gate | **Да** — `ScenarioEngine` PAYMENT_REQUIRED-ветка | Ничего |
| 17 | `payment_signing_failed` | S8 (неявно: отсутствие #16 ⇒ FAIL) | Argus | I | косвенный потребитель S8 | **Да** — `ScenarioEngine` catch-ветка | Ничего |
| 18 | `unhandled_exception` | S5 (антиусловие) | Sut | O | S5 `assert_no_unhandled_errors` (FAIL при наличии) | **Частично (R3)** — тип доступен как observation от Sut через `options.lifecycleObservations` (в allow-list с R2); канонический S4 Sut его не сообщает → S4 остаётся INCONCLUSIVE; PASS достижим при конфигурации наблюдения; assertion PASS'ит по умолчанию | Расширить адаптер (передача ошибок Sut как observations) + решить валидность пассивного PASS (раздел 4, Q4) |

Примечание A: «есть сейчас» считается по наличию рабочего пути эмиссии в mock-режиме.
Для реального Sut все O-типы требуют, чтобы `HttpAgentAdapter`/`X402AgentAdapter`
наполняли `metadata.observations` — это одно и то же «расширить адаптер».

Итого по таблице: 18 типов.

Примечание B (R2, факт реализации): в `MockTargetAdapter` добавлен конфигурируемый
Sut-канал lifecycle-наблюдений (`options.lifecycleObservations`, allow-list
`MOCK_LIFECYCLE_OBSERVATION_TYPES`: payment_settled, settlement_unknown, success,
failed, delivery_started, delivery_sent, delivery_completed, delivery_unknown).
Наблюдения проходят по существующему пути metadata.observations → ScenarioEngine →
EvidenceCollector без переименования (identity сохраняется, source=testSubject).
Канал — механизм переноса факта, а не источник факта: ни один канонический сценарий
его пока не конфигурирует, спекулятивных эмиссий нет (строки #4/#5 помечены как
«канал есть», #6/#7 — «эмиссии нет»). Delivery-типы #8–#12 статус не меняют:
seller-актор, edge-mediator и lifecycle dispatch по-прежнему отсутствуют.
Тесты: `src/tests/core/LifecycleObservationPlumbing.test.ts`.

Примечание C (R3, факты реализации):
- **Decision 3(a) реализован**: в S2 и S4 добавлено действие `deliver` от
  `resource-server-1`; faults `delayed_response` (S2) и `hang` (S4) перенесены с
  lifecycle-триггеров на `action_deliver` (target.participantId === action.actor —
  L0-F2 соблюдён, lifecycle dispatch НЕ вводился). delivery_started/delivery_completed
  эмитятся FaultInjector через существующий emit-путь с source = participant цели.
- **Decisions 1/2 реализованы через Sut-observation-канал** (вариант (a)): harness
  конфигурирует `options.lifecycleObservations` (сценарий остаётся декларативным;
  структурных полей в ScenarioDefinition не добавлялось). S2 даёт PASS при
  `payment_settled` + `success` от Sut и `delivery_completed` от resource-server-1
  (тест в `S2-S4-SellerAction.test.ts`).
- Статусы после R3: **S2 — PASS достижим**; **S4 — INCONCLUSIVE** (canonical hang
  duration_ms:-1 никогда не завершается in-process; PASS требует `delivery_unknown`,
  который остаётся без источника — строка #12); **S6 — BLOCKED** (`settlement_unknown`
  доступен как observation, но fault на lifecycle-триггере остаётся declared-only).
- Allow-list R2 не расширялся за пределы Decisions 1/2.
Тесты R3: `src/tests/scenarios/S2-S4-SellerAction.test.ts`.

---

## Раздел 3 — Три decision-required

Ниже — варианты. Выбор за архитектором; R2 без выбора не начинает реализацию.

### Decision 1 — `settlement_unknown`: observation или internal?

S6 хочет fault `retry` на client-1 (buyer-1) с триггером `settlement_unknown`. Чтобы триггер стал
живым, кто-то должен сначала эмитить `settlement_unknown`.

- **(a) Sut сообщает → observation.** Работает через расширение адаптера: Sut отдаёт
  UNKNOWN-статус settlement в `metadata.observations`. Плюсы: честная семантика
  («платёжная система не подтвердила»). Минусы: UNKNOWN — часто отсутствие сообщения,
  а не сообщение; нужен polling/push-канал. И отдельно: даже с эмиссией, fault на
  lifecycle-триггере остаётся declared-only (см. Decision 3, вариант b).
- **(b) Argus выводит → internal evidence.** Правило движка: «settled запрошен,
  подтверждение не получено за N мс ⇒ UNKNOWN с source='engine'». Дёшево, но Argus
  присваивает себе знание о внешнем мире — размывает Temporal Trust Boundary.
- **(c) Fault.** Settlement-провайдер моделируется fault'ом, эмитящим UNKNOWN.
  Требует lifecycle dispatch — вне L0-F2, дорого.

Не выбран.

### Decision 2 — `success` / `failed`: observation или internal?

S2 PASS требует наличие `success` (после `payment_settled` и после реального ответа
seller). S4 FAIL'ит при любом `success`/`failed`, если seller молчал.

- **(a) Sut сообщает → observation.** Единственный способ дать S2 материал для PASS,
  не испортив S4: Sut эмитит success/failed только когда реально получил ответ seller.
- **(b) Argus выводит → internal.** Критическое предупреждение: **S4 фейлит, если есть
  success/failed при молчащем seller. Если Argus сам выставит success — S4 упадёт.**
  Значит для S4 нужно, чтобы success выставлял только Sut. Internal-вариант допустим
  лишь с условием «никогда без seller-response evidence», что фактически дублирует (a).
- **(c) Fault.** Терминальные состояния как эффект injected-поведения — возможен, но
  смешивает причину (fault) и наблюдаемое состояние Sut.

Не выбран. Обязательное ограничение к любому выбору: source у success/failed обязан
быть `sut-1` (assertions матчат `e.source === 'sut-1'`), поэтому internal-эмиссия с
`source='engine'` эти assertions не удовлетворит вообще.

### Decision 3 — S4 trigger: `delivery_started` или seller-action?

Fault `hang` в S4 нацелен на resource-server-1, триггер `delivery_started` — lifecycle, не
диспатчится (L0-F2 п.1, п.3: активный participant-fault требует `target.participantId
=== action.actor`, а actor всех действий — client-1). Значит hang resource-server-1 сейчас
недостижим и `delivery_started`/`delivery_completed`/terminal-цепочка S2/S4 не запускаются.

- **(a) Перенести fault на action от seller:** ввести seller-действие (seller как актёр
  действия, например `deliver`), fault `hang`/`delayed_response` на participant resource-server-1
  с триггером `action_deliver`. Минимальное изменение, работает через существующий
  L0-F2-механизм. **Но: требует нового актора действия — это структурное изменение
  сценария, которое в R2 запрещено.** Значит decision 3 — решение архитектора, а не Квена.
- **(b) Ввести lifecycle dispatch:** события диспатчат faults по lifecycle-триггерам.
  Прямо против L0-F2 (non-goals: recursive dispatch, seller lifecycle emitters). Дорого.
- **(c) Заменить fault на другой, доступный через action от client-1** (например, hang на
  client-1 с `action_request_payment`): технически работает сразу, но тогда молчит buyer,
  а не seller — меняется смысл S4 («Seller Timeout»).

Не выбран.

---

## Раздел 4 — Открытые вопросы

Не решается из текущего main; фиксируются как backlog для R2/R3.

1. **`delivery_unknown` — Sut сообщает или Argus выводит из timeout?**
   Семантически UNKNOWN — состояние Sut (он не получил ответа). Но Sut может и не уметь
   сообщать «не знаю». Альтернатива — движок по таймауту пишет UNKNOWN сам. Сейчас
   источник не определён; без него S4 и S7 не имеют пути к PASS.
2. **S6 fault retry — если `settlement_unknown` признать observation, как запускается
   fault?** Observation-эмиссия решает только порождение самого типа; fault `retry` висит на
   lifecycle-триггере и по L0-F2 не диспатчится. Нужен либо dispatch от evidence-события
   (запрещённый non-goal), либо перестройка S6 на action-триггер — тот же класс проблемы,
   что Decision 3.
3. **`recovery_completed` и `forward_request` — нужны только для S3, отложены.**
   S3 требует crash/restart lifecycle (infrastructure target — declared-only). Оба типа
   не блокируют остальные сценарии; реализация привязана к lifecycle-работе движка.
4. **`unhandled_exception` (S5, пассивный негатив) — сейчас никто не эмитит; валиден ли
   PASS по умолчанию?** Assertion `assert_no_unhandled_errors` PASS'ит, когда evidence
   пусто, — это «PASS от отсутствия доказательств». Противоречит духу
   evidence-and-verdicts (UNRESOLVED при недостатке данных). Требуется решение: либо
   адаптер начинает эмитить exception-наблюдения, либо assertion получает precondition.
5. **Проверить, что seller-действие не сломает S1/S5.** Если по Decision 3(a) вводится
   новое действие от resource-server-1, оно станет новым `action_deliver` engine-событием и новым
   каналом observations; S1/S5 матчают только `payment_intent_created`/`unhandled_exception`
   с source=sut-1 — формально не конфликтуют, но регрессию надо прогнать после решения.

---

## Раздел 5 — Заключение

В таблице 18 evidence-типов (17 из задания + `unhandled_exception` из раздела 4 S5).

Разкладка по стоимости замкнутости (по колонке «Что нужно», с учётом того, что три
decision-required могут её сдвинуть):

- **Закрываются без нового механизма — 6:** `payment_intent_created`,
  `payment_intent_reused`, `response_received` (уже эмитятся в mock),
  `payment_required_no_resolver`, `payment_signed_and_retried`, `payment_signing_failed`
  (все эмитятся движком). Плюс `forward_request` — переписывание assertion на
  существующее `action_*` без нового механизма (учтено ниже как «движок», не как новый механизм).
- **Требуют расширения адаптеров (O-канал от Sut/seller) — 5:** `payment_settled`,
  `settlement_unknown` (вариант a), `success`, `failed`, `unhandled_exception`.
  Итоговое число зависит от Decisions 1–2: если любой из них выберет internal/fault,
  тип уходит из этой корзины в корзину решений архитектора.
- **Требуют seller-action (изменение структуры сценария, R2-запрещено) — 2:**
  `delivery_started`, `delivery_completed` (через Decision 3, вариант a).
- **Требуют edge-mediator — 2:** `delivery_received`, содержательная часть `delivery_sent`
  в S7 (сам тип эмитится baseline-respond, но без edge-перехвата пара sent/received
  неполна).
- **Требуют fault-primitive / lifecycle или infrastructure-работы движка — 2:**
  `recovery_completed` (crash/restart), `settlement_unknown` (если Decision 1=c).
- **Остаются нерешёнными (источник не определён) — 3:** `delivery_unknown`
  (Q1 раздела 4), `settlement_unknown` (Decision 1), `success`/`failed` как пара
  (Decision 2; засчитано здесь как один нерешённый класс + `delivery_unknown`).

Главный вывод R1: ни один из пяти «спящих» сценариев (S2, S3, S4, S6, S7) не замыкается
текущими механизмами полностью; три из них упираются не в код, а в архитектурные решения
(Decisions 1–3), которые R2 выполнять не вправе.
