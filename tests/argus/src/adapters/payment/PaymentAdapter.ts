/**
 * PaymentAdapter — интерфейс для работы с test wallet'ами
 * в реальной сети.
 *
 * Ответственность:
 * - Отправка платежей (Argus как buyer)
 * - Получение адреса для приёма (Argus как seller)
 * - Наблюдение за подтверждением в сети
 * - Pre-flight check баланса
 * - Подпись x402 payment requirements (EIP-3009)
 *
 * НЕ ответственность:
 * - Платёжная логика (это в Secretariat)
 * - Работа с authorization (это в Secretariat)
 * - Facilitator интеграция (это в Secretariat)
 * - Отправка HTTP-запросов (это в AgentTargetPort)
 */

import { SigningBinding } from './SigningBinding';

export type Address = `0x${string}`;
export type TxHash = `0x${string}`;
export type Amount = bigint;

export interface Receipt {
  txHash: TxHash;
  blockNumber: bigint;
  status: 'success' | 'reverted';
  gasUsed: bigint;
}

export interface PaymentAdapter {
  /**
   * Отправить платёж в сети.
   * От имени одного адреса другому.
   */
  send(from: Address, to: Address, amount: Amount): Promise<TxHash>;

  /**
   * Получить адрес для приёма платежа.
   * forRole — participantId (например, 'resource-server-1').
   * Адрес определяется по маппингу в адаптере
   * (например, из ENV или из конфига).
   */
  getReceiveAddress(forRole: string): Address;

  /**
   * Получить баланс адреса в сети.
   */
  getBalance(address: Address): Promise<Amount>;

  /**
   * Дождаться подтверждения транзакции.
   */
  waitForConfirmation(txHash: TxHash): Promise<Receipt>;

  /**
   * Pre-flight check: убедиться, что баланс >= threshold.
   * Бросает InsufficientBalanceError, если меньше.
   */
  assertSufficientBalance(
    address: Address,
    threshold: Amount
  ): Promise<void>;

  /**
   * Подписать x402 payment через EIP-3009 TransferWithAuthorization,
   * используя EXACT SigningBinding, выданный внешним buyer-side
   * economic layer (Secretariat).
   *
   * Вызывается верхним уровнем (RunOrchestrator -> PaymentResolver),
   * когда X402AgentAdapter вернул PAYMENT_REQUIRED. Адаптер НЕ платит
   * и НЕ отправляет транзакцию — он только создаёт подпись.
   *
   * ГАРАНТИИ:
   * - nonce / validAfter / validBefore НЕ генерируются локально:
   *   authorization = exact входной binding;
   * - результат — Base64-encoded JSON x402 V2 PaymentPayload с accepted.
   *
   * @param binding - инструкция на подпись от buyer-side economic layer
   * @returns Base64-encoded PAYMENT-SIGNATURE payload
   */
  signX402Payment(binding: SigningBinding): Promise<string>;
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly address: Address,
    public readonly balance: Amount,
    public readonly threshold: Amount
  ) {
    super(
      `Insufficient balance at ${address}: ` +
      `have ${balance}, need >= ${threshold}`
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class NotImplementedError extends Error {
  constructor(network: string) {
    super(`Not implemented for network: ${network}`);
    this.name = 'NotImplementedError';
  }
}
