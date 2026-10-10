/**
 * Block C — unit-тесты SUT Server фикстуры (tools/sut-server/server.ts).
 *
 * Вариант D (post-review): тест НЕ импортирует фикстуру напрямую
 * (фикстура живёт в tools/, вне src/rootDir — прямой импорт требовал бы
 * правок vitest.config.ts / ambient-деклараций, что выходило за scope).
 * Вместо этого сервер поднимается как дочерний процесс:
 *     npx tsx tools/sut-server/server.ts --port <port>
 * Готовность определяется ЧТЕНИЕМ STDOUT (выбранный явно вариант;
 * health-эндпоинта у фикстуры нет по §3.5 — только один эндпоинт):
 * ждём строку '[sut-server] listening on http://127.0.0.1:<port>/...'
 * с таймаутом 20s. Фикстура слушает строго указанный порт (port 0 в
 * CLI не поддерживается), поэтому тест сам выбирает свободный порт
 * (временный net.Server на port 0 → release → reuse) и сверяет его
 * со значением из stdout.
 * Запросы идут через fetch; в afterAll — SIGTERM, затем SIGKILL.
 * Валидная подпись генерируется кошельком, созданным В ТЕСТЕ
 * (private key из env не используется).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

// Детерминированный тестовый ключ (0x...0x1111...) — НЕ из env.
const BUYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SUT_WALLET = '0x0000000000000000000000000000000000000001' as Address;

const DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: 84532,
  verifyingContract: USDC_BASE_SEPOLIA,
} as const;

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ─── child_process harness (вариант D) ──────────────────────────────────────

const SERVER_ENTRY = fileURLToPath(
  new URL('../../../tools/sut-server/server.ts', import.meta.url),
);
const TSX_CLI = fileURLToPath(
  new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
);
const LISTEN_TIMEOUT_MS = 20_000;

let child: ChildProcess | undefined;
let baseUrl = '';
let stderrBuf = '';

/** Временный probe на port 0 → OS выдаёт свободный порт → release → reuse. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no probe address'));
      const port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

/** Ждём в stdout строку 'listening on http://127.0.0.1:<port>/...' с таймаутом. */
function waitForListeningLine(proc: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const marker = `listening on http://127.0.0.1:${port}/`;
    const timer = setTimeout(() => {
      reject(new Error(`sut-server did not report listening within ${LISTEN_TIMEOUT_MS}ms. stderr: ${stderrBuf}`));
    }, LISTEN_TIMEOUT_MS);
    proc.stdout?.setEncoding('utf8');
    let acc = '';
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      acc += chunk.toString();
      if (acc.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sut-server exited prematurely (code=${code}). stderr: ${stderrBuf}`));
    });
  });
}

async function startSutServer(): Promise<void> {
  const port = await pickFreePort();
  // Эквивалент `npx tsx tools/sut-server/server.ts --port <port>` —
  // локальный бинарь tsx напрямую (без npx-оверхеда и сетевых запросов).
  const proc = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY, '--port', String(port)], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUT_WALLET_ADDRESS: SUT_WALLET },
  });
  child = proc;
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuf += chunk.toString();
  });
  await waitForListeningLine(proc, port);
  baseUrl = `http://127.0.0.1:${port}`;
}

function stopSutServer(): Promise<void> {
  const proc = child;
  child = undefined;
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    proc.kill('SIGTERM');
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 3_000);
  });
}

beforeAll(async () => {
  await startSutServer();
}, 30_000);

afterAll(async () => {
  await stopSutServer();
});

/** Собрать корректный x402 V2 PaymentPayload (Base64), подписанный BUYER. */
async function makeSignedPayload(overrides: {
  authorization?: Partial<{ from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }>;
  accepted?: Record<string, unknown>;
  signWith?: typeof BUYER;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: BUYER.address,
    to: SUT_WALLET,
    value: '1000',
    validAfter: String(now - 10),
    validBefore: String(now + 60),
    nonce: ('0x' + 'ab'.repeat(32)) as Hex,
    ...overrides.authorization,
  };
  const signer = overrides.signWith ?? BUYER;
  const signature = await signer.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from as Address,
      to: authorization.to as Address,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as Hex,
    },
  });
  const payload = {
    x402Version: 2,
    accepted: overrides.accepted ?? {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: USDC_BASE_SEPOLIA,
      amount: '1000',
      payTo: SUT_WALLET,
      maxTimeoutSeconds: 60,
    },
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function post(signatureHeader?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signatureHeader !== undefined) headers['payment-signature'] = signatureHeader;
  return fetch(`${baseUrl}/do-something`, { method: 'POST', headers, body: JSON.stringify({ action: 'test' }) });
}

describe('SUT Server fixture (Block C)', () => {
  it('C1 — без payment-signature → 402 + корректный Base64 payment-required', async () => {
    const res = await post();
    expect(res.status).toBe(402);
    const pr = res.headers.get('payment-required');
    expect(pr).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(pr!, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      asset: USDC_BASE_SEPOLIA,
      amount: '1000',
      
      payTo: SUT_WALLET,
      maxTimeoutSeconds: 60,
    });
  });

  it('C2 — с валидной подписью → 200 + payment-response', async () => {
    const payload = await makeSignedPayload();
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(res.headers.get('payment-response')).toBeTruthy();
    const body = await res.json();
    expect(body.result).toBe('ok');
    expect(body.echo).toEqual({ action: 'test' });
  });

  it('C3 — с битым Base64 → 400', async () => {
    const res = await post('not-valid-base64-json{{{');
    expect(res.status).toBe(400);
  });

  it('C4 — с неверной подписью (подписал другой ключ) → 402', async () => {
    // Другой ключ → другой адрес (проверено): подпись восстановится на attacker,
    // а не на authorization.from → verifyTypedData вернёт false.
    const attacker = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002');
    // authorization.from остаётся BUYER, но подпись — от attacker → recover не совпадёт
    const payload = await makeSignedPayload({ signWith: attacker });
    const res = await post(payload);
    expect(res.status).toBe(402);
  });

  it('C5 — accepted не соответствует выданному requirement → 402', async () => {
    const payload = await makeSignedPayload({
      accepted: {
        scheme: 'exact',
        network: 'eip155:1', // чужая сеть
        asset: USDC_BASE_SEPOLIA,
        amount: '1000',
        payTo: SUT_WALLET,
        maxTimeoutSeconds: 60,
      },
    });
    const res = await post(payload);
    expect(res.status).toBe(402);
  });

  it('C6 — authorization.to ≠ SUT wallet → 402', async () => {
    const other = '0x0000000000000000000000000000000000000002' as Address;
    // подпись должна соответствовать своему же message (иначе упадёт на C4-гарде)
    const now = Math.floor(Date.now() / 1000);
    const signature = await BUYER.signTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: BUYER.address,
        to: other,
        value: 1000n,
        validAfter: BigInt(now - 10),
        validBefore: BigInt(now + 60),
        nonce: ('0x' + 'cd'.repeat(32)) as Hex,
      },
    });
    const payload = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'eip155:84532', asset: USDC_BASE_SEPOLIA, amount: '1000', payTo: SUT_WALLET, maxTimeoutSeconds: 60 },
      payload: { signature, authorization: { from: BUYER.address, to: other, value: '1000', validAfter: String(now - 10), validBefore: String(now + 60), nonce: '0x' + 'cd'.repeat(32) } },
    })).toString('base64');
    const res = await post(payload);
    expect(res.status).toBe(402);
  });

  it('payment-required (через HTTP) — детерминирован и декодируется', async () => {
    const res = await post(undefined);
    const pr = res.headers.get('payment-required');
    expect(pr).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(pr!, 'base64').toString('utf8'));
    expect(decoded.accepts[0].payTo).toBe(SUT_WALLET);
  });
});
