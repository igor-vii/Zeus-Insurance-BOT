/**
 * SUT Server — минимальная HTTP-фикстура, эмулирующая x402 V2 flow.
 *
 * Это НЕ production-сервер и НЕ часть публичного API Argus:
 * tools/ не компилируется в dist (tsconfig include: ["src"]).
 *
 * Контракт (см. ТЗ Block C):
 *   POST /do-something без payment-signature → 402 + payment-required (Base64)
 *   POST /do-something с payment-signature   → офчейн-проверка подписи
 *                                                (viem.verifyTypedData)
 *                                                → 200 + payment-response | 402 | 400
 *
 * Запрещено и отсутствует by design: on-chain транзакции, подписание чего-либо,
 * чтение private key из env, состояние между запросами, >1 эндпоинта, GET/PUT/DELETE.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAddress, verifyTypedData } from 'viem';

// ─── Canonical параметры (фикстуры) ──────────────────────────────────────────

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const CHAIN_ID_BASE_SEPOLIA = 84532;
const NETWORK_BASE_SEPOLIA = `eip155:${CHAIN_ID_BASE_SEPOLIA}`;
const SCHEME = 'exact';
const PAYMENT_AMOUNT = '1000'; // atomic units USDC = 0.001 USDC
const MAX_TIMEOUT_SECONDS = 60;

// EIP-712 domain для USDC на Base Sepolia (EIP-3009)
const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: CHAIN_ID_BASE_SEPOLIA,
  verifyingContract: USDC_BASE_SEPOLIA,
} as const;

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

const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function b64decode(s: string): unknown {
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** payment-required envelope, который SUT выдаёт на 402. */
export function buildPaymentRequired(sutWallet: string, resourceUrl: string = 'http://127.0.0.1/do-something'): string {
  return b64encode({
    x402Version: 2,
    resource: {
      url: resourceUrl,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: SCHEME,
        network: NETWORK_BASE_SEPOLIA,
        amount: PAYMENT_AMOUNT,
        asset: USDC_BASE_SEPOLIA,
        payTo: sutWallet,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
    ],
  });
}

interface ValidationResult {
  ok: boolean;
  status?: number; // 400 — битая структура; 402 — платёжно невалидно
  reason?: string;
}

/**
 * Офчейн-проверка payment-signature (Base64 x402 V2 PaymentPayload)
 * против выданного payment requirement. Никакого состояния, никакого on-chain.
 */
export async function validatePaymentSignature(headerValue: string, sutWallet: string): Promise<ValidationResult> {
  // 1. Base64 → JSON
  let parsed: any;
  try {
    parsed = b64decode(headerValue);
  } catch {
    return { ok: false, status: 400, reason: 'payment-signature is not valid Base64 JSON' };
  }

  // 2. Структура: x402Version === 2, accepted, payload.signature, payload.authorization
  if (
    typeof parsed !== 'object' || parsed === null ||
    parsed.x402Version !== 2 ||
    typeof parsed.accepted !== 'object' || parsed.accepted === null ||
    typeof parsed.payload !== 'object' || parsed.payload === null ||
    typeof parsed.payload.signature !== 'string' || !parsed.payload.signature.startsWith('0x') ||
    typeof parsed.payload.authorization !== 'object' || parsed.payload.authorization === null
  ) {
    return { ok: false, status: 400, reason: 'malformed x402 V2 PaymentPayload structure' };
  }

  const accepted = parsed.accepted;
  const auth = parsed.payload.authorization;

  // 3. accepted соответствует выданному payment requirement
  if (
    accepted.scheme !== SCHEME ||
    accepted.network !== NETWORK_BASE_SEPOLIA ||
    String(accepted.asset ?? '').toLowerCase() !== USDC_BASE_SEPOLIA.toLowerCase() ||
    String(accepted.payTo ?? '').toLowerCase() !== sutWallet.toLowerCase()
  ) {
    return { ok: false, status: 402, reason: 'accepted does not match issued payment requirement' };
  }

  // 4. authorization
  if (typeof auth.from !== 'string' || !isAddress(auth.from)) {
    return { ok: false, status: 402, reason: 'authorization.from is not a valid address' };
  }
  if (typeof auth.to !== 'string' || !isAddress(auth.to) || auth.to.toLowerCase() !== sutWallet.toLowerCase()) {
    return { ok: false, status: 402, reason: 'authorization.to does not match SUT wallet' };
  }
  if (String(auth.value) !== PAYMENT_AMOUNT) {
    return { ok: false, status: 402, reason: `authorization.value must equal amount (${PAYMENT_AMOUNT})` };
  }
  if (typeof auth.nonce !== 'string' || !NONCE_RE.test(auth.nonce)) {
    return { ok: false, status: 402, reason: 'authorization.nonce must be 0x + 64 hex' };
  }
  let validAfter: bigint, validBefore: bigint;
  try {
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return { ok: false, status: 402, reason: 'authorization validity window is not numeric' };
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (validAfter > nowSec || validBefore <= nowSec) {
    return { ok: false, status: 402, reason: 'authorization window is not currently valid' };
  }

  // 5. Проверка подписи через viem.verifyTypedData (офчейн).
  // ВАЖНО: viem.verifyTypedData возвращает Promise — обязателен await,
  // иначе truthy-объект Promise пропустит любую невалидную подпись.
  try {
    const signerMatches = await verifyTypedData({
      domain: USDC_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter,
        validBefore,
        nonce: auth.nonce,
      },
      signature: parsed.payload.signature,
      address: auth.from,
    });
    if (!signerMatches) {
      return { ok: false, status: 402, reason: 'signature does not verify against authorization.from' };
    }
  } catch {
    return { ok: false, status: 402, reason: 'signature verification failed' };
  }

  return { ok: true };
}

// ─── Server factory ──────────────────────────────────────────────────────────

export interface SutServerOptions {
  /** Адрес получателя оплаты (payTo). Для фикстуры — любой адрес тестового кошелька. */
  sutWallet: string;
}

export function createSutServer(opts: SutServerOptions): Server {
  const sutWallet = opts.sutWallet;
  if (!isAddress(sutWallet)) {
    throw new Error(`SUT wallet address is not a valid EVM address: ${sutWallet}`);
  }

  return createServer(async (req, res) => {
    // Единственный эндпоинт: POST /do-something
    if (req.method !== 'POST' || req.url !== '/do-something') {
      respondJson(res, 404, { error: 'not found' });
      return;
    }

    const rawBody = await readBody(req);
    const signatureHeader = req.headers['payment-signature'];

    // Запрос без payment-signature → 402 + payment-required
    if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
      const host = req.headers.host ?? '127.0.0.1';
      const resourceUrl = `http://${host}${req.url ?? '/do-something'}`;
      respondJson(res, 402, { error: 'Payment required' }, { 'payment-required': buildPaymentRequired(sutWallet, resourceUrl) });
      return;
    }

    // Запрос с payment-signature → офчейн-валидация
    const result = await validatePaymentSignature(signatureHeader, sutWallet);
    if (!result.ok) {
      respondJson(res, result.status ?? 402, { error: result.reason ?? 'payment invalid' });
      return;
    }

    let echo: unknown = null;
    try { echo = rawBody.length > 0 ? JSON.parse(rawBody) : null; } catch { echo = rawBody; }

    respondJson(
      res,
      200,
      { result: 'ok', echo },
      { 'payment-response': b64encode({
        success: true,
        transaction: '0x' + '12'.repeat(32),
        network: NETWORK_BASE_SEPOLIA,
      }) },
    );
  });
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

function parsePortFromArgv(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      const p = Number(argv[i + 1]);
      if (Number.isInteger(p) && p > 0 && p < 65536) return p;
      throw new Error(`Invalid --port value: ${argv[i + 1]}`);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  // Приоритет: CLI-флаг > env > default 3001
  const port = parsePortFromArgv(process.argv.slice(2))
    ?? (process.env.SUT_PORT ? Number(process.env.SUT_PORT) : 3001);

  // payTo для фикстуры: опциональный PUBLIC-адрес из env; по умолчанию —
  // детерминированный placeholder. Private key НИКОГДА не читается (§3.5).
  const sutWallet = process.env.SUT_WALLET_ADDRESS ?? '0x0000000000000000000000000000000000000001';

  const server = createSutServer({ sutWallet });
  server.listen(port, () => {
    console.log(`[sut-server] listening on http://127.0.0.1:${port}/do-something (payTo=${sutWallet})`);
  });
}

// Запускать main() только при прямом запуске файла (не при импорте в тестах).
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  main().catch((err) => {
    console.error('[sut-server] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
