# Insurance Module

## Zeus Insurance V2

---

## Purpose

The Insurance module reduces the economic cost of uncertainty in autonomous AI commerce.

It converts execution risk into measurable premium.

It provides confidence to agents that failures will not result in financial loss.

---

## Core Functions

### 1. Policy Purchase

Agents purchase insurance policies for specific transactions or time periods.

- **Standard Insurance:** Covers API failures, timeouts, and non-delivery.
- **Slashing Protection:** Covers validator penalties in PoS networks.

### 2. Premium Calculation

Premium is calculated based on:

- Transaction amount.
- Historical reliability of the insured party.
- Network conditions.
- Risk score.

### 3. Claim Processing

Claims are processed through:

- **Timeout-based:** Buyer claims after retry deadline.
- **Oracle-based:** Watcher quorum confirms failure.

### 4. Payout Execution

Payments are executed from the Reserve module.

- **Daily cap:** Limits total daily payouts.
- **Per-validator cap:** Prevents single-entity drain.

---

## Smart Contract

### `ZeusInsuranceV2`

| Network | Address |
|---------|---------|
| BOT Chain | `0x6D84aa31073D4C51b579e468bdb02cc11343296E` |
| X Layer | `0x7483bB3C605f3187808b028d9e086AbCa2a34676` |

### Key Functions

- `buyPolicy(address seller, uint256 amount, uint256 timeout, uint256 retries, uint256 premium)`
- `buySlashingProtection(address validator, uint256 amount, uint256 timeout, uint256 premium)`
- `claimPayout(uint256 policyId)`
- `reportSlashing(uint256 policyId, bytes32 evidenceHash)`
- `submitObservation(uint256 policyId, Observation calldata obs)`

### Key Events

- `PolicyCreated`
- `PayoutExecuted`
- `SlashingReported`
- `SlashingResolved`

---

## Watcher Integration

The Insurance module relies on a network of independent watchers.

Each watcher:

- Monitors service health.
- Verifies delivery status.
- Submits signed observations.

**Quorum:** ≥3 watchers required for payout approval.

---

## Current Status

| Component | Status |
|-----------|--------|
| Smart Contract | ✅ Deployed on BOT Chain and X Layer |
| Watcher Network | ✅ Operational (3 watchers per network) |
| Premium Calculation | ⚠️ Fixed rate (7–25%), dynamic pricing in development |
| Slashing Protection | ✅ Deployed |
| API Integration | ✅ Live |

---

## Next Steps

1. **Dynamic Premiums** — risk-adjusted pricing based on historical performance.
2. **Cross-Chain Policies** — insurance that spans multiple networks.
3. **Reputation Integration** — premiums influenced by agent reputation.
4. **Automated Claims** — fully autonomous claim processing.

---

## Dependencies

- **Reserve Module** — provides liquidity for payouts.
- **Reputation Module** — informs premium pricing.
- **Watcher Network** — provides oracle data.

---

## Invitation

The Insurance module is the first institution of Zeus.

It is designed to be complementary.

We invite partners to integrate it into their infrastructure.

If you are building autonomous AI commerce, we would welcome a conversation.

---

**Zeus**

*Building trust before it becomes indispensable.*
_________________________________________________________________________________________________

# Модуль страхования

## Zeus Insurance V2

---

## Назначение

Модуль страхования снижает экономическую стоимость неопределённости в автономной AI-коммерции.

Он превращает исполнительский риск в измеримую премию.

Он даёт агентам уверенность, что сбои не приведут к финансовым потерям.

---

## Основные функции

### 1. Покупка полиса

Агенты покупают страховые полисы для конкретных транзакций или периодов времени.

- **Стандартное страхование:** Покрывает сбои API, таймауты и неисполнение.
- **Защита от слэшинга:** Покрывает штрафы валидаторов в PoS-сетях.

### 2. Расчёт премии

Премия рассчитывается на основе:

- Суммы транзакции.
- Исторической надёжности застрахованной стороны.
- Состояния сети.
- Оценки риска.

### 3. Обработка заявок

Заявки обрабатываются через:

- **На основе таймаута:** Покупатель подаёт заявку после истечения срока повторных попыток.
- **На основе оракула:** Кворум наблюдателей подтверждает сбой.

### 4. Выполнение выплат

Выплаты осуществляются из модуля резерва.

- **Дневной лимит:** Ограничивает общую сумму дневных выплат.
- **Лимит на одного валидатора:** Предотвращает истощение резерва одним участником.

---

## Смарт-контракт

### `ZeusInsuranceV2`

| Сеть | Адрес |
|------|-------|
| BOT Chain | `0x6D84aa31073D4C51b579e468bdb02cc11343296E` |
| X Layer | `0x7483bB3C605f3187808b028d9e086AbCa2a34676` |

### Основные функции

- `buyPolicy(address seller, uint256 amount, uint256 timeout, uint256 retries, uint256 premium)`
- `buySlashingProtection(address validator, uint256 amount, uint256 timeout, uint256 premium)`
- `claimPayout(uint256 policyId)`
- `reportSlashing(uint256 policyId, bytes32 evidenceHash)`
- `submitObservation(uint256 policyId, Observation calldata obs)`

### Основные события

- `PolicyCreated`
- `PayoutExecuted`
- `SlashingReported`
- `SlashingResolved`

---

## Интеграция с Watcher

Модуль страхования полагается на сеть независимых наблюдателей.

Каждый наблюдатель:

- Мониторит состояние сервиса.
- Проверяет статус доставки.
- Отправляет подписанные наблюдения.

**Кворум:** ≥3 наблюдателя для одобрения выплаты.

---

## Текущий статус

| Компонент | Статус |
|-----------|--------|
| Смарт-контракт | ✅ Развёрнут на BOT Chain и X Layer |
| Сеть Watcher'ов | ✅ Работает (3 наблюдателя на сеть) |
| Расчёт премии | ⚠️ Фиксированная ставка (7–25%), динамическое ценообразование в разработке |
| Защита от слэшинга | ✅ Развёрнута |
| Интеграция с API | ✅ Работает |

---

## Следующие шаги

1. **Динамические премии** — ценообразование с учётом исторической надёжности.
2. **Кросс-чейн полисы** — страхование, охватывающее несколько сетей.
3. **Интеграция с репутацией** — влияние репутации агента на размер премии.
4. **Автоматические заявки** — полностью автономная обработка страховых случаев.

---

## Зависимости

- **Модуль резерва** — обеспечивает ликвидность для выплат.
- **Модуль репутации** — влияет на ценообразование.
- **Сеть Watcher'ов** — предоставляет данные оракула.

---

## Приглашение

Модуль страхования — первый институт Zeus.

Он создан как дополнение к существующим системам.

Мы приглашаем партнёров к интеграции.

Если вы строите экономику автономных AI-агентов, мы будем рады обсудить сотрудничество.

---

**Zeus**

*Строим доверие прежде, чем оно станет необходимостью.*
