# Zeus Insurance — Дорожная карта

> Обновлена: 13.08.2026

## Статус

| Компонент | Статус |
|---|---|
| Мобильная покупка полиса (BOT Chain, MM Mobile) | ✅ РАБОТАЕТ |
| Скан полисов (deployBlock) | ✅ BOT: 19080279, XL: ~67300000 |
| API prepare-buy для агентов | ✅ РАБОТАЕТ |
| Стейкинг-продукт |  Код готов, не задеплоен |
| Treasury v1 | 🔴 Не начат |

## Актуальные адреса контрактов

### BOT Chain (chainId 677)

| Контракт | Адрес |
|---|---|
| ZeusInsuranceV2 | `0x2E592BEBbcC38FC3976125CB2E11312068670C45` |
| ZeusReserveV2 | `0x779Fcd0344c0DCaC0F8C45E2bB5Db72D6356AE56` |
| ZeusEscrowBOT | `0xa5404EaE15938Dc2cA1aad914CD868b86d8A0eC8` |
| USDT | `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C` |

Explorer: https://scan.botchain.ai/address/0x2E592BEBbcC38FC3976125CB2E11312068670C45

### X Layer (chainId 196)

| Контракт | Адрес |
|---|---|
| ZeusInsuranceV2 | `0xe43e55d96925a3FBFdB5DE0a4AeC1a4bab4dDdB0` |
| ZeusReserveV2 | `0x6D84aa31073D4C51b579e468bdb02cc11343296E` |
| ZeusEscrowBOT | `0x779Fcd0344c0DCaC0F8C45E2bB5Db72D6356AE56` ⚠️ |
| USDC | `0x74b7f16337b8972027f6196a17a631ac6de26d22` |

⚠️ Escrow на X Layer: код есть (9765 bytes), но все функции ревертятся. Требуется проверка.

Explorer: https://www.oklink.com/xlayer/address/0xe43e55d96925a3FBFdB5DE0a4AeC1a4bab4dDdB0

## Фазы

### Фаза 0 — Безопасность (СЕГОДНЯ)
- [ ] Отозвать токен ghp_Oc6m... (25+ появлений в чате)
- [ ] Аудит секретов в git-истории
- [x] Deploy-блоки для быстрого скана полисов

### Фаза 1 — Стабилизация (1–2 дня)
- [ ] Регрессия мобильной покупки (BOT + XL, разные суммы)
- [ ] API для агентов: keep-alive / платный план Railway
- [ ] Проверить x402-guard на prepare-buy
- [ ] Мониторинг /health
- [ ] Полный прогон тестов

### Фаза 2 — Стейкинг testnet (3–5 дней)
- [ ] Деплой: WatcherRegistry + Reserve#2 + ZeusStakingInsurance
- [ ] Резерв#2: стартовая ликвидность
- [ ] E2E: buy → slashing → claim → payout
- [ ] Фронтенд стейкинга

### Фаза 3 — Прод + Treasury v1 (1–2 недели)
- [ ] Mainnet деплой стейкинга
- [ ] Treasury: монолит со счетами продуктов + shared buffer
- [ ] Миграция резервов
- [ ] Мультичейн-дашборд солвентности

### Фаза 4 — Масштаб (постоянно)
- [ ] Новые сети (Base Mainnet и др.)
- [ ] Новые продукты над Treasury
- [ ] Экономика агентов (x402, SDK, маркетплейс)
- [ ] Децентрализация вотчеров

## Коммиты этой сессии

| SHA | Описание |
|---|---|
| 4ff9982 | fix(frontend): update ALL contract addresses + deployBlock |
| 4b0319e | fix(sdk): update X Layer insuranceAddress + deployBlock |
| 69d9c8d | fix(buy): correct network bot-chain-mainnet + ethers signer |
| 188bde6 | fix(buy): reconnect before createPolicy |
| 17f68a3 | fix(buy): 2s pause + retry for createPolicy |
| 5efb872 | fix(buy): proceed if sdk object exists |
