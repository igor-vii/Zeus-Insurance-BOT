# Arbitration Module

## Watcher-Based Dispute Resolution

---

## Purpose

The Arbitration module resolves disputes between autonomous agents without central authority.

It provides a mechanism for verifying claims.

It ensures that economic disagreements do not block transactions.

It operates through a network of independent watchers.

---

## Core Functions

### 1. Observation Submission

Any registered watcher can submit an observation.

- **Request ID:** Unique per observation.
- **Timestamp:** Time of the observation.
- **Status:** OK, TIMEOUT, ERROR, LATE.
- **Metadata Hash:** Proof of the observation.
- **Nonce:** Anti-replay protection.
- **Signature:** ECDSA signature from the watcher.

### 2. Vote Resolution

The contract automatically resolves votes when ≥3 observations are collected.

- **Quorum:** ≥3 observations.
- **Decision:** Payout approved if ≥2 TIMEOUT votes.
- **Rejection:** Otherwise.

### 3. Slashing Arbitration

Validators can be protected against slashing.

- **Quorum:** ≥2 watchers required.
- **Evidence:** On-chain evidence of slashing.
- **Payout:** Full coverage amount.

---

## Watcher Requirements

- **Registration:** Must be added by contract owner.
- **Independence:** Each watcher operates independently.
- **Signing:** Observations must be signed with ECDSA.
- **Nonce:** Anti-replay protection per watcher.

---

## Smart Contract

### `ZeusInsuranceV2` (Arbitration Functions)

| Network | Address |
|---------|---------|
| BOT Chain | `0x6D84aa31073D4C51b579e468bdb02cc11343296E` |
| X Layer | `0x7483bB3C605f3187808b028d9e086AbCa2a34676` |

### Key Functions

- `submitObservation(uint256 policyId, Observation calldata obs)`
- `reportSlashing(uint256 policyId, bytes32 evidenceHash)`

### Key Events

- `ObservationSubmitted`
- `VoteResolved`
- `SlashingReported`
- `SlashingResolved`

---

## Current Status

| Component | BOT Chain | X Layer |
|-----------|-----------|---------|
| Watcher Registration | ✅ | ✅ |
| Observation Submission | ✅ | ✅ |
| Vote Resolution | ✅ | ✅ |
| Slashing Arbitration | ✅ | ✅ |
| Watcher Count | 3 | 3 |

---

## Next Steps

1. **Economic Incentives** — reward watchers for accurate observations.
2. **Slashing for Watchers** — penalize watchers for false observations.
3. **Reputation Integration** — watcher reputation influences trust.

---

## Dependencies

- **Insurance Module** — arbitration is triggered by claims.
- **Escrow Module** — arbitration for escrow disputes (future).
- **Reputation Module** — informs trust in observations.

---

## Invitation

The Arbitration module is essential for autonomous commerce.

It provides a mechanism for dispute resolution without central authority.

We invite partners to explore integration.

If you are building autonomous AI commerce, we would welcome a conversation.
*Building trust before it becomes indispensable.*

___________________________________________________________________________________________________________

# Модуль арбитража

## Разрешение споров на основе Watcher'ов

---

## Назначение

Модуль арбитража разрешает споры между автономными агентами без центрального органа.

Он предоставляет механизм проверки заявлений.

Он гарантирует, что экономические разногласия не блокируют транзакции.

Он работает через сеть независимых наблюдателей.

---

## Основные функции

### 1. Отправка наблюдения

Любой зарегистрированный наблюдатель может отправить наблюдение.

- **Request ID:** Уникальный идентификатор наблюдения.
- **Timestamp:** Время наблюдения.
- **Status:** OK, TIMEOUT, ERROR, LATE.
- **Metadata Hash:** Доказательство наблюдения.
- **Nonce:** Защита от повторов.
- **Signature:** ECDSA-подпись от наблюдателя.

### 2. Разрешение голосования

Контракт автоматически разрешает голосование при сборе ≥3 наблюдений.

- **Кворум:** ≥3 наблюдения.
- **Решение:** Выплата одобрена, если ≥2 голосов TIMEOUT.
- **Отказ:** В противном случае.

### 3. Арбитраж по слэшингу

Валидаторы могут быть защищены от слэшинга.

- **Кворум:** ≥2 наблюдателя.
- **Доказательство:** Доказательство слэшинга в блокчейне.
- **Выплата:** Полная сумма покрытия.

---

## Требования к наблюдателю

- **Регистрация:** Должен быть добавлен владельцем контракта.
- **Независимость:** Каждый наблюдатель работает независимо.
- **Подпись:** Наблюдения должны быть подписаны с использованием ECDSA.
- **Nonce:** Защита от повторов для каждого наблюдателя.

---

## Смарт-контракт

### `ZeusInsuranceV2` (функции арбитража)

| Сеть | Адрес |
|------|-------|
| BOT Chain | `0x6D84aa31073D4C51b579e468bdb02cc11343296E` |
| X Layer | `0x7483bB3C605f3187808b028d9e086AbCa2a34676` |

### Основные функции

- `submitObservation(uint256 policyId, Observation calldata obs)`
- `reportSlashing(uint256 policyId, bytes32 evidenceHash)`

### Основные события

- `ObservationSubmitted`
- `VoteResolved`
- `SlashingReported`
- `SlashingResolved`

---

## Текущий статус

| Компонент | BOT Chain | X Layer |
|-----------|-----------|---------|
| Регистрация наблюдателей | ✅ | ✅ |
| Отправка наблюдений | ✅ | ✅ |
| Разрешение голосования | ✅ | ✅ |
| Арбитраж по слэшингу | ✅ | ✅ |
| Количество наблюдателей | 3 | 3 |

---

## Следующие шаги

1. **Экономические стимулы** — вознаграждение наблюдателей за точные наблюдения.
2. **Штрафы для наблюдателей** — наказание за ложные наблюдения.
3. **Интеграция с репутацией** — репутация наблюдателя влияет на доверие.

---

## Зависимости

- **Модуль страхования** — арбитраж инициируется заявками.
- **Модуль эскроу** — арбитраж для споров по эскроу (в будущем).
- **Модуль репутации** — влияет на доверие к наблюдениям.

---

## Приглашение

Модуль арбитража необходим для автономной коммерции.

Он предоставляет механизм разрешения споров без центрального органа.

Мы приглашаем партнёров к исследованию интеграции.

Если вы строите экономику автономных AI-агентов, мы будем рады обсудить сотрудничество.

---

**Zeus**

*Строим доверие прежде, чем оно станет необходимостью.*
