mkdir -p docs && cat > docs/x402-reference.md << 'EOF'
# x402 v2 — Reference (внешняя спецификация)

Источник: официальные документы x402 (Coinbase + x402 Foundation).
Сохранено как reference для Argus — сверка wire conformance.

Это НЕ наш код и НЕ наши решения. Это карта протокола x402 v2,
по которой мы сверяем наш Argus.

---

## PROTOCOL REALITY

### 1. Participant model

| Роль в протоколе | Кто это | Что делает |
|---|---|---|
| Client | Покупатель / агент / любой HTTP-клиент | Инициирует HTTP-запрос к ресурсу; при 402 выбирает option из accepts, создаёт и подписывает PaymentPayload, повторяет запрос с PAYMENT-SIGNATURE |
| Resource server | Продавец / владелец защищённого ресурса | Отдаёт 402 + PaymentRequired; проверяет payload (сам или через facilitator); выполняет работу (fulfill); инициирует settle; отдаёт ресурс + PAYMENT-RESPONSE |
| Facilitator | Опциональный, но recommended intermediary | POST /verify и POST /settle: проверка payload off-chain / по схеме; сабмит on-chain; возврат verification/settlement result resource server'у (не клиенту напрямую в каноническом flow) |

Термины buyer / seller / payer / payee в docs встречаются описательно:
- payer ≈ тот, чей ключ в authorization (from)
- payee ≈ payTo в PaymentRequirements
- buyer/seller ≈ client / resource server

### 2. Message / entity model

| Термин протокола | Что это |
|---|---|
| HTTP request | Обычный запрос к resource URL |
| PaymentRequired | Объект в 402 (часто header PAYMENT-REQUIRED, base64): версия, resource info, массив accepts[] |
| PaymentRequirements | Один элемент accepts[]: scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra |
| PaymentPayload | То, что клиент подписывает и кладёт в PAYMENT-SIGNATURE: resource, accepted requirements, payload (authorization и т.д.) |
| Verification | Проверка payload относительно requirements (локально или /verify) — ещё не обязательно движение денег |
| Settlement | Исполнение платежа on-chain (локально или /settle) → SettlementResponse / execution response |
| Protected resource response | Обычно 200 + тело ресурса + header PAYMENT-RESPONSE с settlement result |

В протоколе нет отдельной первоклассной сущности «transaction» в смысле бизнес-операции «оплата + доставка работы». Есть HTTP request lifecycle + payment verify/settle.

### 3. Граница x402 (что внутри протокола)

Внутри x402:

    Client → resource: HTTP request
    Resource → client: 402 + PaymentRequired / PAYMENT-REQUIRED
    Client → resource: тот же request + PAYMENT-SIGNATURE (PaymentPayload)
    Resource ↔ facilitator (optional): verify
    Resource: fulfill the request (работа сервера)
    Resource ↔ facilitator (optional): settle
    Resource → client: resource body + PAYMENT-RESPONSE (settlement outcome)

Схема (scheme) задаёт как двигаются деньги (exact, upto, batch-settlement, escrow-варианты и т.д.). От scheme зависит порядок verify vs settle и гарантии.

Важно из docs: для exact по умолчанию часто описывают порядок verify → perform work → settle (authorization flow). То есть протокол допускает, что работа начинается после verify, а on-chain settle идёт после/параллельно с fulfill — в зависимости от scheme и политики server'а. Это не «сначала железобетонный on-chain SETTLED, потом работа» как единственная норма.

### 4. Что должен уметь настоящий x402 client/agent

Минимально:
- Сделать HTTP request
- Распознать 402 и прочитать PaymentRequired / accepts[]
- Выбрать один PaymentRequirements
- Построить и подписать PaymentPayload по scheme/network
- Повторить request с PAYMENT-SIGNATURE
- (Опционально) прочитать PAYMENT-RESPONSE

Клиент не обязан сам ходить в facilitator и не обязан сам бродкастить tx в canonical facilitator-submitted flow.

### 5. Что должен уметь resource server / facilitator

Resource server:
- Отдавать корректный PaymentRequired
- Принять и проверить PaymentPayload (сам или через facilitator)
- Решить: fulfill или снова 402
- Инициировать settlement
- Вернуть ресурс и settlement result клиенту

Facilitator (optional):
- Verify payload vs requirements
- Settle on-chain
- Вернуть структурированный результат server'у

Facilitator не является обязательной частью протокола; server может verify/settle сам.

### 6. Протокольные данные vs непротокольные

Протокольные (wire / spec):
- PaymentRequired, PaymentRequirements, PaymentPayload
- Headers: PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE
- Verification response / Settlement response shapes
- Scheme-specific fields в extra / payload

Не протокольные (приложение / ops):
- Внутренние ID операций приложения
- Бизнес-статусы вроде «RECONCILING», «DELIVERY_UNKNOWN»
- Evidence store, audit log, observability
- Политики maxPrice, allowlists, insurance, escrow product logic
- Любая долгая state machine «operation» между несколькими HTTP-вызовами вне одного request/retry

### 7. Lifecycle одной операции (канон)

    HTTP request
      → 402 + PaymentRequired (requirements)
      → Client authorization / PaymentPayload
      → Payment submission (retry with PAYMENT-SIGNATURE)
      → Verification
      → Resource execution / fulfill   [server work]
      → Settlement                     [on-chain; order may vary by scheme]
      → 200 + resource + PAYMENT-RESPONSE

| Шаг | Обязательность в core x402 | Комментарий |
|---|---|---|
| 402 + requirements | Да, если ресурс платный и оплаты ещё нет | |
| PaymentPayload + retry | Да | |
| Facilitator | Нет (optional) | |
| Verify before fulfill | Типично для exact authorization flow | Не единственная возможная семантика всех schemes |
| On-chain settle before fulfill | Не зафиксировано как единственная норма | Зависит от scheme |
| Отдельный «delivery proof» layer | Нет в core x402 | Fulfill = отдать HTTP response/resource |
| Durable multi-step operation across crashes | Нет в core x402 | Это уже orchestration вне протокола |

---

## OUR MODEL (Argus + Secretariat) — концептуально

### Argus
- Независимая adversarial / integration test lab
- Может выступать client (покупатель/signer) и resource-side test double (seller, отдающий 402)
- Гоняет failure modes вокруг payment, verify, settle, ambiguous states
- Собирает evidence и вердикты PASS/FAIL

→ В терминах протокола Argus — тестовый участник и наблюдатель, не роль x402.

### Secretariat
- Resolution runtime: durable payment intent, reconciliation, инвариант «новый платёж только после proven NOT_SETTLED»
- Посредник между buyer и seller, discovery, policy, submit, settle path, post-settlement execution
- Evidence и recovery после crash/timeout

→ В терминах чистого x402 такой роли нет. x402 знает: client, resource server, optional facilitator. Secretariat по факту описания — application-level transaction orchestration / resolution layer вокруг или поверх x402, а не часть спецификации x402.

---

## Potential semantic mismatches

1. **«Settlement» в x402 vs у нас.** В протоколе settlement ≈ исполнение платежа (часто on-chain + PAYMENT-RESPONSE). У нас settlement связан с durable intent + reconciliation + запретом нового платежа до NOT_SETTLED. Это расширенная семантика, не тождество.

2. **«Execution / delivery».** В x402 fulfill = resource server выполняет работу и отдаёт HTTP-ответ. Отдельного протокольного состояния «delivery UNKNOWN» нет. Gap «payment settled ≠ work delivered» — реальная операционная проблема, но вне core x402 message model.

3. **Порядок verify / work / settle.** Канонические примеры допускают verify → work → settle. Модель «сначала железобетонный on-chain SETTLED, потом execution» — product policy, не правило x402.

4. **Facilitator vs Secretariat.** Facilitator = verify + settle service для resource server. Secretariat — orchestrator операции (intent, policy, recovery). Называть Secretariat «facilitator» — путаница с протокольным термином.

5. **Одна HTTP-операция x402 vs «операция» Secretariat.** x402 — один paid request/response. Secretariat — долгоживущая operation с БД, probes, CAS, multi-step recovery.

6. **Buyer/seller как агенты.** В x402 seller = resource server одного HTTP resource. Модель «агент-продавец / агент-покупатель + посредник» — шире, чем один x402 exchange.

---

## Короткий вывод разведки

    PROTOCOL REALITY
      Client / Resource server / (optional) Facilitator
      PaymentRequired → PaymentPayload → Verify → Fulfill → Settle → Response
      x402 = HTTP-native payment handshake + scheme-defined money movement
      ≠ durable business transaction OS
      ≠ delivery-proof protocol

    OUR MODEL
      Argus = test lab / adversarial client & seller harness (outside protocol roles)
      Secretariat = orchestration/resolution layer around payments (not an x402 role)

    Core mismatch risk:
      Using x402 words (settlement, facilitator, payment) for Secretariat's
      longer-lived operation/delivery semantics without marking them as app-level.
EOF
wc -l docs/x402-reference.md && head -5 docs/x402-reference.md
