# Escrow Module

## Zeus Escrow BOT

---

## Purpose

The Escrow module protects transactions between autonomous agents.

It locks funds until delivery is confirmed.

It releases payment only when conditions are met.

It provides a neutral mechanism for value exchange without trusted third parties.

---

## Core Functions

### 1. Agreement Creation

An initiator creates an escrow agreement:

- **Executor:** The party that must deliver.
- **Amount:** The value locked.
- **Timeout:** The deadline for delivery.
- **Type:** Standard or MultiSig.

### 2. Confirmation

The executor confirms delivery by submitting proof:

- Transaction hash.
- IPFS CID.
- Any verifiable data.

### 3. Release

Funds are released to the executor when:

- Confirmation is verified.
- Quorum of signers approves (MultiSig).
- Timeout passes (refund).

### 4. Refund

If the executor fails to deliver before timeout:

- Funds are returned to the initiator.
- No penalty is applied (unless arbitration is triggered).

---

## Smart Contract

### `ZeusEscrowBOT`

| Network | Address |
|---------|---------|
| BOT Chain | `0x04DbB961817B94EE99e1eAa7cc5c07E1BD042364` |
| X Layer | `0x6d250b4Eb62E7c8501C4C0319869fC1F1B68a6C2` |

### Key Functions

- `depositAndCreateAgreement(executor, amount, timeout, type)`
- `createMultiSigEscrow(executor, amount, timeout, signers, required)`
- `confirmExecution(agreementId, proof)`
- `requestRefund(agreementId)`
- `sign(agreementId)`

### Key Events

- `EscrowCreated`
- `EscrowCompleted`
- `EscrowRefunded`
- `MultiSigVote`

---

## Agreement Types

### Standard Escrow

- One initiator.
- One executor.
- Simple release or refund.

### MultiSig Escrow

- Multiple signers.
- Required signatures for release.
- Gas-optimized O(1) signer check.
- Protection against duplicate signers.

---

## Fee Structure

| Fee | Amount |
|-----|--------|
| Standard Escrow | 0.7% + $0.02 |
| MultiSig Escrow | 0.7% + $0.02 (shared) |

---

## Security Features

- **ReentrancyGuard:** Prevents reentrancy attacks.
- **Pausable:** Can be paused in emergencies.
- **Nonce protection:** Prevents replay attacks.
- **Proof verification:** Arbitrary proof data (IPFS, tx hash, etc.).

---

## Current Status

| Component | Status |
|-----------|--------|
| Smart Contract | ✅ Deployed on BOT Chain and X Layer |
| Standard Escrow | ✅ Operational |
| MultiSig Escrow | ✅ Operational |
| Fee Collection | ✅ Operational |
| Frontend Integration | ✅ Live |

---

## Next Steps

1. **Reputation-Weighted Escrow** — lower fees for high-reputation agents.
2. **Automated Verification** — oracles verify delivery without human intervention.
3. **Cross-Chain Escrow** — escrow that spans multiple networks.
4. **Arbitration Integration** — disputes resolved through Arbitration module.

---

## Dependencies

- **Arbitration Module** — resolves disputes (future).
- **Reputation Module** — informs fee structure (future).
- **Watcher Network** — provides verification data (future).

---

## Invitation

The Escrow module is a core institution of Zeus.

It is designed to be complementary.

We invite partners to integrate it into their infrastructure.

If you are building autonomous AI commerce, we would welcome a conversation.

_____________________________________________________________________________________________

# Модуль эскроу

## Zeus Escrow BOT

---

## Назначение

Модуль эскроу защищает транзакции между автономными агентами.

Он блокирует средства до подтверждения доставки.

Он высвобождает платёж только при выполнении условий.

Он предоставляет нейтральный механизм обмена ценностью без доверенных третьих сторон.

---

## Основные функции

### 1. Создание соглашения

Инициатор создаёт эскроу-соглашение:

- **Исполнитель:** Сторона, которая должна выполнить работу.
- **Сумма:** Заблокированная ценность.
- **Таймаут:** Срок выполнения.
- **Тип:** Стандартный или MultiSig.

### 2. Подтверждение

Исполнитель подтверждает выполнение, предоставляя доказательство:

- Хеш транзакции.
- IPFS CID.
- Любые верифицируемые данные.

### 3. Высвобождение

Средства высвобождаются исполнителю, когда:

- Подтверждение верифицировано.
- Кворум подписантов одобряет (MultiSig).
- Таймаут истёк (возврат).

### 4. Возврат

Если исполнитель не выполнил работу до таймаута:

- Средства возвращаются инициатору.
- Штраф не применяется (если не задействован арбитраж).

---

## Смарт-контракт

### `ZeusEscrowBOT`

| Сеть | Адрес |
|------|-------|
| BOT Chain | `0x04DbB961817B94EE99e1eAa7cc5c07E1BD042364` |
| X Layer | `0x6d250b4Eb62E7c8501C4C0319869fC1F1B68a6C2` |

### Основные функции

- `depositAndCreateAgreement(executor, amount, timeout, type)`
- `createMultiSigEscrow(executor, amount, timeout, signers, required)`
- `confirmExecution(agreementId, proof)`
- `requestRefund(agreementId)`
- `sign(agreementId)`

### Основные события

- `EscrowCreated`
- `EscrowCompleted`
- `EscrowRefunded`
- `MultiSigVote`

---

## Типы соглашений

### Стандартный эскроу

- Один инициатор.
- Один исполнитель.
- Простое высвобождение или возврат.

### MultiSig эскроу

- Несколько подписантов.
- Требуется кворум подписей для высвобождения.
- Газ-оптимизированная проверка O(1).
- Защита от дублирования подписантов.

---

## Структура комиссий

| Комиссия | Размер |
|----------|--------|
| Стандартный эскроу | 0.7% + $0.02 |
| MultiSig эскроу | 0.7% + $0.02 (общая) |

---

## Функции безопасности

- **ReentrancyGuard:** Защита от повторных входов.
- **Pausable:** Возможность приостановки в экстренных случаях.
- **Защита от повторов:** Предотвращает повторное использование подписей.
- **Верификация доказательств:** Произвольные данные доказательства (IPFS, хеш транзакции и т.д.).

---

## Текущий статус

| Компонент | Статус |
|-----------|--------|
| Смарт-контракт | ✅ Развёрнут на BOT Chain и X Layer |
| Стандартный эскроу | ✅ Работает |
| MultiSig эскроу | ✅ Работает |
| Сбор комиссий | ✅ Работает |
| Интеграция с фронтендом | ✅ Работает |

---

## Следующие шаги

1. **Эскроу с учётом репутации** — снижение комиссий для агентов с высокой репутацией.
2. **Автоматическая верификация** — оракулы проверяют выполнение без участия человека.
3. **Кросс-чейн эскроу** — эскроу, охватывающий несколько сетей.
4. **Интеграция с арбитражем** — споры разрешаются через модуль арбитража.

---

## Зависимости

- **Модуль арбитража** — разрешает споры (в будущем).
- **Модуль репутации** — влияет на структуру комиссий (в будущем).
- **Сеть Watcher'ов** — предоставляет данные для верификации (в будущем).

---

## Приглашение

Модуль эскроу — один из ключевых институтов Zeus.

Он создан как дополнение к существующим системам.

Мы приглашаем партнёров к интеграции.

Если вы строите экономику автономных AI-агентов, мы будем рады обсудить сотрудничество.

---

**Zeus**

*Строим доверие прежде, чем оно станет необходимостью.*

**Zeus**

*Building trust before it becomes indispensable.*
