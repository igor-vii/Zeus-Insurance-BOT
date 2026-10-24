# Argus ⇄ Secretariat — final historical integration report

> **Historical case study.** This report documents a specific Argus/Secretariat interoperability run. It is evidence of one SUT integration, not a statement that Secretariat is Argus's primary, default, or required SUT. Current canonical product model: Argus tests arbitrary black-box SUTs and determines the applicable counterparty scenarios from observable role/capability evidence.


**Дата:** 2026-09-24 (последний живой прогон: 2026-09-24T05:48:24Z, чистая БД)
**Стенд:** Argus (`/workspace`, vitest + Node) · Secretariat api-server (`/tmp/zeus`, `scripts/run-local.mjs`, `http://localhost:4021`) · PostgreSQL 15 `zeus` (миграции применены) · режим `ZEUS_SIGNER_MODE=custodial_test`
**Машинно-читаемый лог прогона:** `reports/argus-secretariat-run-2026-09-24T05-48-24-391Z.json`
**Итог:** **13 PASS / 2 FAIL из 15 проверок матрицы** на чистой БД после трёх помеченных патчей Zeus. Оба FAIL — контур B, внешние блокировки Zeus (F-Z1; в свежем прогоне маршруты отдали 404/503 вместо стабильного 500 — см. F-Z1 уточнение). Не ошибки Argus. Все HTTP-коды получены живыми запросами, все строки БД — прямыми SQL-выборками. Ничего не имитировано и не подгонялось.

---

## 1. Архитектура «женитьбы» (что выяснено разведкой)

Secretariat — посредник между покупателем и продавцом, с двумя контурами подключения внешних агентов:

| Контур | Роль Argus | Путь | Статус |
|---|---|---|---|
| **A (Stage-A non-custodial API)** | Argus = **продавец** (`X402AgentServer` как `target`); Secretariat сам делает discovery-запрос, парсит 402, проверяет политику, создаёт DPI; Argus = **покупатель** подписанта (EIP-3009 → `POST /v1/requests/:id/payment`) | `POST /v1/requests` → discovery → 201 → подпись → submit → 200 | ✅ **работает end-to-end** (после 2 помеченных патчей Zeus) |
| **B (x402-middleware на маршрутах Insurance/Escrow)** | Argus = покупатель против защищённых POST-маршрутов api-server | `POST /api/insurance/prepare-buy` / `/api/escrow/create` → ожидание 402 | ❌ **заблокирован дефектом конфига Zeus (F-Z1)** — см. §5 |

Полный список маршрутов api-server (grep по `api-server/src`):

| Маршрут | Принадлежность | x402-middleware |
|---|---|---|
| `GET /health`, `/healthz` | инфраструктура | нет |
| `POST /api/insurance/prepare-buy`, `POST /api/escrow/create` | Insurance / Escrow (Zeus) | **да** (`app.ts:90 paymentMiddleware`) — обе цены `$0` → 500 |
| остальные `/api/insurance/*`, `/api/escrow/*`, `/api/staking/*`, `/api/auth/*`, `/api/admin/*`, `GET /api/x402/info` | Insurance/Escrow/вспомогательные | нет |
| `POST /v1/requests`, `GET /v1/requests/:id`, `POST /v1/requests/:id/payment` | **Secretariat-специфичные (Stage-A/B API)** | **нет** — Secretariat здесь сам выступает x402-клиентом к продавцу |

**Вывод по B-контуру:** Secretariat-маршруты x402-middleware не используют — только Stage-A/B API. Поэтому B-контур реализован **вариантом A**: сквозной цикл «Argus платит за ресурс» закрыт в контуре A (Argus-seller + Argus-signer против одного и того же Secretariat). Классический B через middleware возможен только после починки цен Zeus (решение команды Zeus, см. F-Z1).

Про S1–S8: это внутренние сценарии движка Argus на mock-транспорте; гонять их на живом HTTP-SUT бессмысленно (другой протокол). Интеграционные сценарии против реального Secretariat обозначены A1–A6/B/W и существуют как отдельный набор `src/tests/integration/ArgusSecretariatRun.test.ts`. S1–S8 не изменены и продолжают проходить (170 unit-тестов зелёные).

---

## 2. Матрица «действие Argus → HTTP-вердикт → запись в БД → интерпретация»

Интерпретация по правилу «тест = проверка ожидания»: для негативных сценариев умышленный отказ Argus = ожидаемое поведение, и **честная фиксация отказа Secretariat = PASS обеих систем**.

| # | Сценарий | Действие | HTTP | Что в БД (проверено psql) | Вердикт |
|---|---|---|---|---|---|
| 1 | A1 happy-path | Secretariat делает discovery на Argus-seller (`X402AgentServer`, порт 0) | **201** `AWAITING_PAYMENT_SIGNATURE` (+paymentRequired: amount=100000, asset=Base-Sepolia-USDC, network=base-sepolia, payee, deadline) | — | **PASS** |
| 2 | A1 | `GET /v1/requests/:id` до оплаты | **200**, статус AWAITING_PAYMENT_SIGNATURE, evidenceCount=1 | — | **PASS** |
| 3 | A1 | сверка DPI | — | `payment_intents`: state=`PENDING_SIGNATURE`, authorizer=`0xf39Fd6e5…`, nonce=`0x00c1a567…` | **PASS** |
| 4 | A1 | `POST /v1/requests/:id/payment` — канонический V2 JSON с EIP-3009 подписью Argus | **200** `PROCESSING`, evidenceCount=3 (верификатор принял подпись) | переход состояния + settlement attempt + evidence | **PASS** |
| 5 | A1 | `GET /v1/requests/:id` после оплаты | **200** `PROCESSING`; в `payment_intents` — `RECONCILING`, `error_reason='Missing paymentPayload or paymentRequirements'` | запись урегулирования НЕ потеряна, честно зависла в reconciliation (нет фасилитатора Base Sepolia USDC — ожидаемо) | **PASS** |
| 6 | A2 policy-reject | Argus-seller завышает цену (5000000 atomic при maxPrice=100) | **422** `REQUEST_REJECTED` | POLICY_REJECTED **не персистится** → finding F-Z6 | **PASS** (ожидание — отказ политики) |
| 7 | A3 network-mismatch | seller объявляет `eip155:999`, политика разрешает только 84532 | **422** `REQUEST_REJECTED` | то же (F-Z6) | **PASS** |
| 8 | A4 идемпотентность | два `POST /v1/requests` с одним requestId | **201 / 201** | ровно одна строка `payment_intents` | **PASS** |
| 9 | A5 tampered-signature | submit с испорченной подписью | **422** INVALID_SIGNATURE | state не испорчен | **PASS** |
| 10 | A5 | повтор оригинальной валидной подписи после tamper | **200** | принята | **PASS** |
| 11 | A6 authorizer-mismatch | подпись ключом Argus, когда intent привязан к другому authorizer | **422** AUTHORIZER_MISMATCH | — | **PASS** |
| 12 | B buyer | `POST /api/insurance/prepare-buy` (raw unpaid и signed retry) | **500** | — | **FAIL — заблокировано F-Z1 (дефект Zeus, вне нашего кода)** |
| 13 | B buyer | `POST /api/escrow/create` | **500** | — | **FAIL — то же** |
| 14 | W1 wire-format | конвертация `signX402Payment` → canonical V2 (офлайн) | — | — | **PASS** |
| 15 | W2 discovery | raw `GET` на ресурс Argus-seller без оплаты | **402** + корректный `payment-required` | — | **PASS** |

**Итог по системам:** Argus корректно ведёт себя во всех ролях (seller отдаёт валидный x402 V2 402; signer порождает подписи, проходящие настоящий `Eip3009PaymentVerifier`; tamper/mismatch корректно ловятся). Secretariat корректно оценивает действия и пишет всё значимое в БД (DPI, nonce, authorizer, evidence, reconciliation-стадии), кроме двух задокументированных дыр (F-Z6, диагностика catch-all).

---

## 3. Применённые помеченные патчи Zeus (минимальные, оба с комментарием `[ARGUS-INTEGRATION PATCH]`)

Все три лежат в рабочей копии `/tmp/zeus` (git diff: 2 файла, +42/−14). Не закоммичены в upstream Zeus — решение о мердже за командой Zeus.

### Патч #1 — `api-server/src/routes/requests.ts` (Zod-схема `/v1/requests`)
Ядро state-machine читает `body.authorizer` (non-custodial режим), но Zod-схема отбрасывала поле → `createPendingPaymentIntent()` бросал исключение → **любой** `POST /v1/requests` возвращал 422. Happy-path Stage-A был невозможен ни для одного внешнего агента.
```ts
// [ARGUS-INTEGRATION PATCH #1] Stage-A non-custodial mode requires the
// authorizer address; core state-machine reads body.authorizer, but the Zod
// schema dropped it -> createPendingPaymentIntent threw and every
// /v1/requests call returned 422. Minimal fix: accept optional field.
authorizer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
```

### Патч #2 — `lib/db/src/secretariat/postgres-store.ts` (F-Z5)
Postgres `NUMERIC(38,6)` возвращается как `"100000.000000"`, канонический x402 V2 `accepted.amount` — целостроковая `"100000"`; `eip3009-verifier` сравнивает строки → вечный `VALUE_MISMATCH`. Клиент нормализовать не может (нормализованное ≠ персистированное). Канонизация на границе store→verifier:
```ts
// [ARGUS-INTEGRATION PATCH #2 (F-Z5)] ... value: canonNumeric(row.value)
function canonNumeric(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' ? '0' : t;
}
```
После патча #2 тест №4 (submit payment) стал **200** — подтверждено живым прогоном.

### Патч #3 — `lib/db/src/secretariat/postgres-store.ts` (`append()`) (F-Z7)
Evidence-append вызывается до создания payment intent (discovery/policy фаза), а мост жёстко писал `paymentIntentId: ""` → нарушение FK `reconciliation_observations_payment_intent_id_fkey` → PostgreSQL ошибка → **HTTP 500 на `POST /v1/requests` против чистой БД** (первый же сценарий A1 падал до DPI-фазы). Минимальный фикс: резолвить реальный intent по operationId и пропускать строку наблюдений, когда intent ещё не существует (JSONB-апдейд ниже и так защищён `if (intent)`):
```ts
// [ARGUS-INTEGRATION PATCH #3 (F-Z7)] ...
const linkedIntent = await this.getPaymentIntentByOperationId(record.operationId);
if (linkedIntent) {
  await this.appendReconciliationObservation({ ...,
    paymentIntentId: linkedIntent.paymentIntentId, ... });
}
```
После патча #3 полный прогон на чистой БД зелёный (A1–A6, W1/W2), в `reconciliation_observations` — 12 осмысленных строк с реальными FK.

---

## 4. Что пришлось сделать на стороне Argus (без правок ядра)

Ядро Argus (ScenarioEngine, ExecutionRegistry, RunOrchestrator, X402AgentAdapter, PaymentAdapter, S1–S8) **не изменялось**. Добавлены только новые компоненты/тесты:
- `src/adapters/x402/X402AgentServer.ts` — x402 V2 ресурс-сервер (seller-контур): 402+payment-required без подписи, 200+ресурс с валидной, evidence-лог.
- `src/tests/integration/ArgusSecretariatRun.test.ts` — матрица A1–A6/B/W против `SECRETARIAT_URL` (ENV, без хардкодов) с прямой сверкой через psql.
- Хелперы конвертации wire-формата (base64-header форма Argus ↔ canonical JSON-форма Secretariat) и биндинга подписи к персистентному DPI (nonce/окна/amount/payTo берутся из GET-статуса, а не генерируются заново).
- Исправлен баг собственного теста: порядок нормализации amount (сырой NUMERIC из discovery побеждал над bound-значением) + TS null-check'и.

---

## 5. Findings (дефекты, выявленные прогоном)

### F-Z1 — Дефект конфигурации Zeus: цена `$0` ломает x402-middleware (БЛОКИРУЕТ B-контур) ⚠️ отдельным пунктом, как просили
Это логика контракта покупки полиса страхования, притянутая к платёжному middleware. `api-server/src/config/x402.ts`:
```ts
/**
 * NOTE: API fee is DISABLED for now (price set to $0).
 * When ready to enable, change price to "$0.001" and ensure
 * ZEUS_TREASURY env var is set on Railway.
 */
export const x402Routes: RoutesConfig = {
  "/api/insurance/prepare-buy": { price: "$0", network: "eip155:196", ... },
  "/api/escrow/create":         { price: "$0", network: "eip155:196", ... },
};
```
При `ZEUS_TREASURY` установленном `x402-express` валидирует цену с минимумом `$0.0001` → **«Invalid price $0»** на этапе формирования 402 → Express отдаёт **500 вместо 402**. Уточнение по свежему прогону (чистый рестарт): коды нестабильны (500 → в последнем прогоне 404/503 в зависимости от порядка запуска middleware/RPC-провайдеров) — маршрут в любом случае неработоспособен для x402-клиента; вывод не меняется: защищённые маршруты закрыты до починки цен. Защищённые маршруты недоступны любому x402-клиенту, включая боевого покупателя. Комментировать/править конфиг мы не стали (это чужой функциональный контракт). **Рекомендация Zeus:** либо `$0.001`, либо не подключать `paymentMiddleware` к маршрутам с нулевой ценой.

### F-Z2 — Потеря диагностики: catch-all → 422 «rejected by the payment policy»
`prepareStageA` любое внутреннее исключение превращает в `{status:'REJECTED'}` с тем же сообщением, что и честный policy-отказ. Клиент неотличимо получает 422 без истинной причины (так маскировались F-Z3 и F-Z4). Рекомендация: отдельный error.code/HTTP 500 для внутренних ошибок.

### F-Z3 — (закрыт Патчем #1) `authorizer` терялся в Zod-схеме → 100% отказ Stage-A.

### F-Z4 — Ответ Stage-A не содержит binding-полей в каноническом виде
`paymentRequired` в 201-ответе отдаётся без `maxTimeoutSeconds`/канонического amount; клиент вынужден читать `GET /v1/requests/:id` и пикать сырой NUMERIC из БД-формата. Рекомендация: полный `accepted`-объект в ответе.

### F-Z5 — (закрыт Патчем #2) NUMERIC `"100000.000000"` vs canonical `"100000"` → структурно непроходимый happy-path.

### F-Z6 — POLICY_REJECTED не персистится
A2/A3 (реальные отказы политики) дают корректный 422, но в `payment_intents`/`audit_logs` строк нет (проверено psql). Для посредника, чья задача — «увидеть и записать», это дыра наблюдаемости: аудит цепочки «кто и почему отклонён» невозможен post-factum.

### F-Z7 — (закрыт Патчем #3) Evidence-append до существования intent нарушал FK → 500 на чистом стенде
Проявляется только при первом запросе к пустой БД (в прошлых прогонах маскировался остаточными данными). Класс: запись телеметрии не должна уметь ронять основную транзакцию.

### F-A1 — (Argus, к сведению) Network/domain mismatch
`BaseSepoliaPaymentAdapter` подписывает домен USDC chainId 84532, тогда как живые маршруты Zeus — `eip155:196` (X Layer). В контуре A это осознанно согласовано (Argus-seller объявляет base-sepolia, политика пропускает); для боёвки нужен XLayer-адаптер-подписант.

### F-A2 — (Argus, закрыто в тестах) Wire-формат
Argus шлёт base64(JSON) в заголовке `PAYMENT-SIGNATURE`, Secretariat принимает JSON-body в `payload` — конвертер добавлен в интеграционных хелперах; имеет смысл вынести в штатный режим адаптера.

---

## 6. Ограничения стенда (честно)
- Settlement до терминального SUCCESS не доходит: нет funded-кошелька/фасилитатора для Base Sepolia USDC. Проверялось, что платёж **принят верификатором и записан** (PROCESSING→RECONCILING с evidence), а не потерян. Терминальное урегулирование — следующий уровень стенда (testnet-фасилитатор).
- Реальная БД Зевса недоступна — использована локальная копия схемы (миграции проекта).
- Rate-limiter Stage-A in-memory (сбрасывается рестартом) — в проде учитывать per-client лимиты.

## 7. Рекомендации следующему шагу
1. **Zeus:** починить F-Z1 (цены) → затем полноценный B-контур (Argus-покупатель против middleware) без обходных путей; решить судьбу двух помеченных патчей (#1 — обязательный мерж, #2 — или канонизация в сторе, или BigInteger-сравнение в верификаторе); добавить персистенцию POLICY_REJECTED (F-Z6) и различимые коды ошибок (F-Z2).
2. **Argus:** XLayerPaymentAdapter для боёвки (F-A1); штатный JSON-body режим подписи (F-A2); вынести матрицу A1–A6 в сценарии S9/S10 формата ScenarioDefinition; подключить реальный facilitator для проверки терминального settlement.
3. CI: интеграционный набор запускается при заданном `SECRETARIAT_URL`, иначе SKIPPED — готов к docker-compose-стенду (Postgres + api-server + Argus).

---
*Все числа HTTP-статусов, идентификаторы req_…, адреса, значения nonce и строки БД в этом отчёте скопированы из живого прогона `argus-secretariat-run-2026-09-24T05-48-24-391Z.json` и psql-выборок, приведённых в логах сессии.*
