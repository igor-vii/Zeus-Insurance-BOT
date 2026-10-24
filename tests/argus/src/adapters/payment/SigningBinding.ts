/**
 * SigningBinding — инструкция на подпись платежа, выдаваемая ВНЕШНИМ
 * buyer-side economic layer (Secretariat).
 *
 * Ключевое отличие от PaymentRequired:
 * - PaymentRequired — то, что пришло от Target/Seller (402);
 * - SigningBinding   — durable payment intent из buyer-side economic layer:
 *   nonce, validAfter, validBefore принадлежат ему, а НЕ адаптеру.
 *
 * Цепочка:
 *   Target/Seller --402--> PaymentRequired
 *        --external source--> SigningBinding
 *        --> PaymentAdapter.signX402Payment(binding) --> PaymentPayload
 *        --> HTTP retry (PAYMENT-SIGNATURE header)
 *
 * ВАЖНО (межсистемный контракт):
 * Способ доставки SigningBinding из Secretariat в Argus (wire boundary)
 * здесь НЕ фиксируется — это решение cross-system этапа. На данном этапе
 * готовится только Argus-side интерфейс: signX402Payment принимает
 * готовый SigningBinding и обязуется НЕ генерировать локально
 * nonce / validAfter / validBefore.
 */
export interface SigningBinding {
  /** authorizer (адрес подписанта, buyer-side) */
  from: string;
  /** payTo (адрес получателя, seller-side) */
  to: string;
  /** amount в atomic units (string, как в x402) */
  value: string;
  /** nonce из durable payment intent (0x + 64 hex для EIP-3009) */
  nonce: string;
  /** начало окна действия (unix seconds, decimal string) */
  validAfter: string;
  /** конец окна действия (unix seconds, decimal string) */
  validBefore: string;
  /** сетевой идентификатор, e.g. 'eip155:84532' */
  network: string;
  /** адрес asset-контракта, e.g. USDC на Base Sepolia */
  asset: string;
  /** схема платежа, e.g. 'exact' */
  scheme: string;
  /** maxTimeoutSeconds from the selected x402 PaymentRequirements */
  maxTimeoutSeconds: number;
}

/**
 * Минимальная структурная валидация SigningBinding на Argus-side boundary.
 * Не интерпретирует экономику — только проверяет форму.
 */
export function validateSigningBinding(b: SigningBinding): void {
  const require = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`Invalid SigningBinding: ${msg}`);
  };

  require(/^0x[0-9a-fA-F]{40}$/.test(b.from), '`from` must be a 0x address');
  require(/^0x[0-9a-fA-F]{40}$/.test(b.to), '`to` must be a 0x address');
  require(/^\d+$/.test(b.value), '`value` must be a non-negative decimal string');
  require(/^0x[0-9a-fA-F]{64}$/.test(b.nonce), '`nonce` must be 0x + 32 bytes hex');
  require(/^\d+$/.test(b.validAfter), '`validAfter` must be a decimal string');
  require(/^\d+$/.test(b.validBefore), '`validBefore` must be a decimal string');
  require(
    BigInt(b.validBefore) > BigInt(b.validAfter),
    '`validBefore` must be greater than `validAfter`'
  );
  require(typeof b.network === 'string' && b.network.length > 0, '`network` is required');
  require(
    /^0x[0-9a-fA-F]{40}$/.test(b.asset),
    '`asset` must be a 0x address'
  );
  require(typeof b.scheme === 'string' && b.scheme.length > 0, '`scheme` is required');
  require(Number.isInteger(b.maxTimeoutSeconds) && b.maxTimeoutSeconds >= 0, '`maxTimeoutSeconds` must be a non-negative integer');
}

/**
 * Источник durable payment intent (nonce / validAfter / validBefore).
 *
 * В целевой архитектуре этот источник — внешний buyer-side economic
 * layer (Secretariat). Механизм доставки (wire boundary) фиксируется
 * на cross-system этапе и ЗДЕСЬ НЕ проектируется.
 *
 * На текущем Argus-этапе в тестовой среде допускается детерминированный
 * placeholder (см. defaultSigningIntentSource), который передаёт эти
 * поля в PaymentAdapter как внешние — adapter по-прежнему ничего не
 * генерирует локально.
 */
export type SigningIntentSource = (paymentRequired: {
  maxTimeoutSeconds: number;
}) => { nonce: string; validAfter: string; validBefore: string };

/**
 * Детерминированный TEST-ONLY placeholder источника intent.
 *
 * Используется RunOrchestrator, когда внешний bindingSource не передан.
 * Это НЕ имитация Secretariat: значения формируются вне PaymentAdapter,
 * поэтому контракт "adapter подписывает exact binding" сохраняется.
 * Nonce детерминирован (не randomBytes), чтобы unit-тесты были
 * воспроизводимыми.
 */
export const defaultSigningIntentSource: SigningIntentSource = (paymentRequired) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const window = paymentRequired.maxTimeoutSeconds > 0 ? paymentRequired.maxTimeoutSeconds : 60;
  return {
    nonce: `0x${'0'.repeat(64)}`,
    validAfter: String(nowSec),
    validBefore: String(nowSec + window),
  };
};

/**
 * Derive SigningBinding из PaymentRequired (402 от Target) плюс
 * durable intent-поля (nonce / validAfter / validBefore), которые
 * принадлежат ВНЕШНЕМУ buyer-side economic layer.
 *
 * ГДЕ ЖИВЁТ ЭТОТ ФУНКЦИОНАЛ (design reasoning, см. §4.3 задания):
 * - PaymentResolver (callback в ScenarioEngine) НЕ меняется:
 *   он по-прежнему получает PaymentRequired и возвращает строку.
 * - Единственное место, где PaymentRequired превращается в
 *   SigningBinding — RunOrchestrator (композиционный корень),
 *   который строит resolver поверх PaymentAdapter.
 * - Когда wire boundary с Secretariat будет зафиксирован
 *   (cross-system этап), bindingSource подменится на реальный
 *   источник intent-полей. Сам PaymentAdapter менять не придётся.
 *
 * Поля 402 (scheme/network/asset/value/to) переходят как есть;
 * intent-поля (nonce/window) приходят ИЗВНЕ — adapter никогда не
 * генерирует их локально.
 */
export function deriveSigningBinding(
  pr: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
  },
  from: string,
  intent: { nonce: string; validAfter: string; validBefore: string }
): SigningBinding {
  return {
    from,
    to: pr.payTo,
    value: pr.amount,
    nonce: intent.nonce,
    validAfter: intent.validAfter,
    validBefore: intent.validBefore,
    network: pr.network,
    asset: pr.asset,
    scheme: pr.scheme,
    maxTimeoutSeconds: pr.maxTimeoutSeconds,
  };
}
