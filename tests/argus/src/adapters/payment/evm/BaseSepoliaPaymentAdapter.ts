import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  PaymentAdapter,
  Address,
  TxHash,
  Amount,
  Receipt,
  InsufficientBalanceError,
} from '../PaymentAdapter';
import { SigningBinding, validateSigningBinding } from '../SigningBinding';

// USDC на Base Sepolia
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const CHAIN_ID_BASE_SEPOLIA = 84532;
const NETWORK_BASE_SEPOLIA = `eip155:${CHAIN_ID_BASE_SEPOLIA}`;

// EIP-712 domain для USDC на Base Sepolia
const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: CHAIN_ID_BASE_SEPOLIA,
  verifyingContract: USDC_BASE_SEPOLIA,
} as const;

// EIP-712 types для EIP-3009 TransferWithAuthorization
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Base Sepolia PaymentAdapter.
 *
 * Управляет test wallet'ом Argus через приватный ключ из ENV.
 * Реализует:
 * - отправку ETH (send)
 * - наблюдение за подтверждением (waitForConfirmation)
 * - проверку баланса (getBalance)
 * - pre-flight check (assertSufficientBalance)
 * - подпись x402 payment requirements (signX402Payment)
 *
 * НЕ реализует:
 * - платёжную логику (это в Secretariat)
 * - работу с ERC-20 (пока только native ETH)
 */
export class BaseSepoliaPaymentAdapter implements PaymentAdapter {
  private readonly publicClient: any;
  private readonly walletClient: any;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly receiveAddresses: Map<string, Address>;

  constructor(config: {
    rpcUrl: string;
    privateKey: `0x${string}`;
    receiveAddresses?: Record<string, Address>;
  }) {
    this.account = privateKeyToAccount(config.privateKey);
    this.publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(config.rpcUrl),
    });
    this.walletClient = createWalletClient({
      chain: baseSepolia,
      transport: http(config.rpcUrl),
      account: this.account,
    });
    this.receiveAddresses = new Map(
      Object.entries(config.receiveAddresses ?? {})
    );
  }

  async send(from: Address, to: Address, amount: Amount): Promise<TxHash> {
    // В Мире A у Argus один test wallet. from должен совпадать
    // с this.account.address, иначе throw.
    if (from.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error(
        `Cannot send from ${from}: Argus manages only ${this.account.address}`
      );
    }

    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: baseSepolia,
      to,
      value: amount,
    });

    return hash;
  }

  getReceiveAddress(forRole: string): Address {
    const addr = this.receiveAddresses.get(forRole);
    if (!addr) {
      throw new Error(
        `No receive address configured for role: ${forRole}`
      );
    }
    return addr;
  }

  async getBalance(address: Address): Promise<Amount> {
    return await this.publicClient.getBalance({ address });
  }

  async waitForConfirmation(txHash: TxHash): Promise<Receipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    return {
      txHash,
      blockNumber: receipt.blockNumber,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      gasUsed: receipt.gasUsed,
    };
  }

  async assertSufficientBalance(
    address: Address,
    threshold: Amount
  ): Promise<void> {
    const balance = await this.getBalance(address);
    if (balance < threshold) {
      throw new InsufficientBalanceError(address, balance, threshold);
    }
  }

  getArgusAddress(): Address {
    return this.account.address;
  }

  /**
   * Подписать x402 payment через EIP-3009, используя EXACT SigningBinding.
   *
   * Возвращает Base64-encoded JSON x402 V2 PaymentPayload:
   * {
   *   x402Version: 2,
   *   accepted: { scheme, network, asset, amount, payTo, maxTimeoutSeconds },
   *   payload: {
   *     signature: '0x...',
   *     authorization: {
   *       from, to, value, validAfter, validBefore, nonce  // = exact binding
   *     }
   *   }
   * }
   */
  async signX402Payment(binding: SigningBinding): Promise<string> {
    // Structural validation на Argus-side boundary.
    validateSigningBinding(binding);

    // Network guard: подпись допустима только для canonical Base Sepolia.
    if (binding.network !== NETWORK_BASE_SEPOLIA) {
      throw new Error(
        `SigningBinding network '${binding.network}' is not supported by ` +
        `BaseSepoliaPaymentAdapter (expected '${NETWORK_BASE_SEPOLIA}')`
      );
    }

    // Asset guard: EIP-712 domain зафиксирован под canonical USDC
    // на Base Sepolia — подписывать binding для другого asset нельзя.
    if (binding.asset.toLowerCase() !== USDC_BASE_SEPOLIA.toLowerCase()) {
      throw new Error(
        `SigningBinding asset '${binding.asset}' does not match canonical ` +
        `Base Sepolia USDC (${USDC_BASE_SEPOLIA})`
      );
    }

    // Authorizer guard: в Мире A у Argus один test wallet; подпись
    // выдаётся только от его адреса.
    if (binding.from.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error(
        `SigningBinding from ${binding.from} does not match the Argus test ` +
        `wallet ${this.account.address}`
      );
    }

    // Window guard: binding должен быть ещё действителен на момент подписи.
    const nowSec = Math.floor(Date.now() / 1000);
    if (BigInt(binding.validBefore) <= BigInt(nowSec)) {
      throw new Error(
        `SigningBinding validBefore (${binding.validBefore}) is already in the past`
      );
    }

    // EXACT binding: nonce / validAfter / validBefore НЕ генерируются
    // локально — они принадлежат durable payment intent внешнего слоя.
    const authorization = {
      from: binding.from as Address,
      to: binding.to as Address,
      value: BigInt(binding.value),
      validAfter: BigInt(binding.validAfter),
      validBefore: BigInt(binding.validBefore),
      nonce: binding.nonce as `0x${string}`,
    };

    const signature = await this.account.signTypedData({
      domain: USDC_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    });

    // accepted.maxTimeoutSeconds is a property of the selected x402
    // PaymentRequirements, not the durable authorization validity window.
    const maxTimeoutSeconds = binding.maxTimeoutSeconds;

    const payload = {
      x402Version: 2,
      accepted: {
        scheme: binding.scheme,
        network: binding.network,
        asset: binding.asset,
        amount: binding.value,
        payTo: binding.to,
        maxTimeoutSeconds,
      },
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }
}
