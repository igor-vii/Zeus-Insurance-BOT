import {
  PaymentAdapter,
  Address,
  TxHash,
  Amount,
  Receipt,
  NotImplementedError,
} from '../PaymentAdapter';
import { SigningBinding } from '../SigningBinding';

/**
 * Solana PaymentAdapter — заготовка.
 *
 * Solana — не EVM, реализуется через @solana/web3.js.
 * Интерфейс PaymentAdapter частично не подходит (другие типы
 * адресов, txHash). Реализовать при переходе на Solana,
 * возможно с отдельным интерфейсом.
 *
 * ВАЖНО: Address = `0x${string}` в нашем интерфейсе НЕ подходит
 * для Solana. Пока оставляем как заглушку — реальная типизация
 * Solana будет отдельно.
 */
export class SolanaPaymentAdapter implements PaymentAdapter {
  async send(_from: Address, _to: Address, _amount: Amount): Promise<TxHash> {
    throw new NotImplementedError('solana');
  }
  getReceiveAddress(_forRole: string): Address {
    throw new NotImplementedError('solana');
  }
  async getBalance(_address: Address): Promise<Amount> {
    throw new NotImplementedError('solana');
  }
  async waitForConfirmation(_txHash: TxHash): Promise<Receipt> {
    throw new NotImplementedError('solana');
  }
  async assertSufficientBalance(
    _address: Address,
    _threshold: Amount
  ): Promise<void> {
    throw new NotImplementedError('solana');
  }
  async signX402Payment(_binding: SigningBinding): Promise<string> {
    throw new NotImplementedError('solana');
  }
}
