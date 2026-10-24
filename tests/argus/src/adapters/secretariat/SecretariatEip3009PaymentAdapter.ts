/**
 * SecretariatEip3009PaymentAdapter — buyer-side PaymentAdapter for the live
 * Secretariat target (S8 x402 step 2).
 *
 * The orchestrator's PaymentResolver chain is:
 *   PAYMENT_REQUIRED (persisted intent from Stage A)
 *     -> external bindingSource (RunOrchestrator) -> SigningBinding
 *     -> THIS adapter.signX402Payment(binding) -> Base64 x402 V2 payload
 *     -> ScenarioEngine -> AgentController.actWithSignature()
 *     -> SecretariatTargetAdapter.sendWithSignature() -> Stage B.
 *
 * Contract kept (SigningBinding.ts):
 * - nonce / validAfter / validBefore are NOT generated here — they arrive in
 *   the exact SigningBinding derived from the PERSISTED Secretariat intent.
 * - The signature covers exactly the binding fields (EIP-3009
 *   TransferWithAuthorization, same domain as the SecretariatTargetAdapter).
 * - Economic transfer methods are intentionally unsupported: this adapter
 *   only signs; settlement happens inside the Secretariat via the facilitator.
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  PaymentAdapter,
  Address,
  Amount,
  TxHash,
  Receipt,
  NotImplementedError,
} from '../payment/PaymentAdapter';
import { SigningBinding } from '../payment/SigningBinding';

export class SecretariatEip3009PaymentAdapter implements PaymentAdapter {
  async send(_from: Address, _to: Address, _amount: Amount): Promise<TxHash> {
    throw new NotImplementedError('secretariat-eip3009 (settlement is the Secretariat\'s job)');
  }

  getReceiveAddress(_forRole: string): Address {
    throw new NotImplementedError('secretariat-eip3009 (receive address not used in scenarios)');
  }

  async getBalance(_address: Address): Promise<Amount> {
    throw new NotImplementedError('secretariat-eip3009');
  }

  async waitForConfirmation(_txHash: TxHash): Promise<Receipt> {
    throw new NotImplementedError('secretariat-eip3009');
  }

  async assertSufficientBalance(_address: Address, _threshold: Amount): Promise<void> {
    throw new NotImplementedError('secretariat-eip3009');
  }

  /** Buyer (authorizer) address — the same wallet the target adapter uses. */
  getArgusAddress(): Address {
    return privateKeyToAccount(this.privateKey).address;
  }

  /**
   * Sign the EXACT SigningBinding issued from the persisted Secretariat
   * intent and return the Base64 x402 V2 PaymentPayload (accepted + payload)
   * that Stage B expects verbatim.
   */
  async signX402Payment(binding: SigningBinding): Promise<string> {
    const account = privateKeyToAccount(this.privateKey);
    const chainId = Number.parseInt(process.env.SECRETARIAT_CHAIN_ID ?? '84532', 10);
    const signature = await account.signTypedData({
      domain: {
        name: process.env.SECRETARIAT_ASSET_NAME ?? 'USD Coin',
        version: process.env.SECRETARIAT_ASSET_VERSION ?? '2',
        chainId,
        verifyingContract: binding.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: binding.from as `0x${string}`,
        to: binding.to as `0x${string}`,
        value: BigInt(binding.value),
        validAfter: BigInt(binding.validAfter),
        validBefore: BigInt(binding.validBefore),
        nonce: binding.nonce as `0x${string}`,
      },
    });

    const payload = {
      x402Version: 2,
      accepted: {
        scheme: binding.scheme,
        network: process.env.SECRETARIAT_NETWORK ?? 'base-sepolia',
        amount: binding.value,
        asset: binding.asset,
        payTo: binding.to,
        maxTimeoutSeconds: binding.maxTimeoutSeconds,
        extra: { name: process.env.SECRETARIAT_ASSET_NAME ?? 'USD Coin', version: process.env.SECRETARIAT_ASSET_VERSION ?? '2' },
      },
      payload: {
        signature,
        authorization: {
          from: binding.from,
          to: binding.to,
          value: binding.value,
          validAfter: binding.validAfter,
          validBefore: binding.validBefore,
          nonce: binding.nonce,
        },
      },
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  private get privateKey(): `0x${string}` {
    const key = process.env.SECRETARIAT_CLIENT_KEY;
    if (!key) {
      throw new Error('SECRETARIAT_CLIENT_KEY is required for the secretariat payment adapter');
    }
    return key as `0x${string}`;
  }
}
