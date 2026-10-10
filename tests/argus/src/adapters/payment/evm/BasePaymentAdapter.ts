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
 * Base (mainnet) PaymentAdapter — заготовка.
 *
 * Реализовать при переходе на Base mainnet. Структура —
 * как у BaseSepoliaPaymentAdapter, но с chain: base (mainnet)
 * и реальными деньгами.
 */
export class BasePaymentAdapter implements PaymentAdapter {
  async send(_from: Address, _to: Address, _amount: Amount): Promise<TxHash> {
    throw new NotImplementedError('base');
  }
  getReceiveAddress(_forRole: string): Address {
    throw new NotImplementedError('base');
  }
  async getBalance(_address: Address): Promise<Amount> {
    throw new NotImplementedError('base');
  }
  async waitForConfirmation(_txHash: TxHash): Promise<Receipt> {
    throw new NotImplementedError('base');
  }
  async assertSufficientBalance(
    _address: Address,
    _threshold: Amount
  ): Promise<void> {
    throw new NotImplementedError('base');
  }
  async signX402Payment(_binding: SigningBinding): Promise<string> {
    throw new NotImplementedError('base');
  }
}
