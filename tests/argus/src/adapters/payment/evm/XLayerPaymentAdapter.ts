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
 * X Layer PaymentAdapter — заготовка.
 *
 * X Layer — EVM-совместимый, реализуется через viem
 * с custom chain definition.
 */
export class XLayerPaymentAdapter implements PaymentAdapter {
  async send(_from: Address, _to: Address, _amount: Amount): Promise<TxHash> {
    throw new NotImplementedError('xlayer');
  }
  getReceiveAddress(_forRole: string): Address {
    throw new NotImplementedError('xlayer');
  }
  async getBalance(_address: Address): Promise<Amount> {
    throw new NotImplementedError('xlayer');
  }
  async waitForConfirmation(_txHash: TxHash): Promise<Receipt> {
    throw new NotImplementedError('xlayer');
  }
  async assertSufficientBalance(
    _address: Address,
    _threshold: Amount
  ): Promise<void> {
    throw new NotImplementedError('xlayer');
  }
  async signX402Payment(_binding: SigningBinding): Promise<string> {
    throw new NotImplementedError('xlayer');
  }
}
