import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ethers } from 'ethers';

// ─── Интерфейс ─────────────────────────────────────────────────────────────

export interface KmsSigner {
  /** Ethereum-адрес подписанта (0x...) */
  getAddress(): Promise<string>;
  /** Подписывает digest (32 bytes), возвращает 0x{r}{s}{v} для Solidity */
  signDigest(digest: Uint8Array): Promise<string>;
}

// ─── AWS KMS Signer ────────────────────────────────────────────────────────

export class AwsKmsSigner implements KmsSigner {
  private kms: KMSClient;
  private address: string | null = null;

  constructor(
    private keyId: string,
    region = process.env.AWS_REGION || 'us-east-1'
  ) {
    this.kms = new KMSClient({ region });
  }

  async getAddress(): Promise<string> {
    if (this.address) return this.address;

    const { PublicKey } = await this.kms.send(
      new GetPublicKeyCommand({ KeyId: this.keyId })
    );

    // PublicKey — uncompressed (0x04 + 32b X + 32b Y)
    const pubKeyHex = ethers.hexlify(PublicKey!);
    this.address = ethers.computeAddress(pubKeyHex);
    return this.address;
  }

  async signDigest(digest: Uint8Array): Promise<string> {
    const command = new SignCommand({
      KeyId: this.keyId,
      Message: digest,
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    });

    const response = await this.kms.send(command);
    const derSig = new Uint8Array(response.Signature!);

    // AWS KMS возвращает DER (ASN.1) — парсим в r, s
    const { r, s } = parseDERSignature(derSig);
    const digestHex = ethers.hexlify(digest);

    // Определяем recovery id (v) перебором 27/28
    for (let recId = 0; recId <= 1; recId++) {
      try {
        const sig = ethers.Signature.from({ r, s, v: recId + 27 });
        const recovered = ethers.recoverAddress(digestHex, sig);
        if (recovered.toLowerCase() === (await this.getAddress()).toLowerCase()) {
          return sig.serialized; // 0x{r}{s}{v}
        }
      } catch {
        continue;
      }
    }
    throw new Error('Failed to determine recovery id from KMS signature');
  }
}

// ─── Local Signer (dev / тесты) ────────────────────────────────────────────

export class LocalSigner implements KmsSigner {
  private wallet: ethers.Wallet;

  constructor(privateKeyHex: string) {
    this.wallet = new ethers.Wallet(privateKeyHex);
  }

  async getAddress(): Promise<string> {
    return this.wallet.address;
  }

  async signDigest(digest: Uint8Array): Promise<string> {
    // ethers.Wallet.signMessage добавляет \x19Ethereum Signed Message:\n32
    // Но нам нужна чистая ECDSA подпись над digest
    const sig = this.wallet.signingKey.sign(ethers.hexlify(digest));
    return sig.serialized;
  }
}

// ─── Фабрика ───────────────────────────────────────────────────────────────

export function createSigner(): KmsSigner {
  const kmsKeyId = process.env.KMS_KEY_ID;
  const localKey = process.env.EXECUTOR_PRIVATE_KEY;

  if (kmsKeyId) {
    console.log('[KMS] Using AWS KMS signer');
    return new AwsKmsSigner(kmsKeyId);
  }

  if (localKey) {
    console.warn('[KMS] Using LOCAL signer — NEVER use in production');
    return new LocalSigner(localKey);
  }

  throw new Error('No signer configured. Set KMS_KEY_ID or EXECUTOR_PRIVATE_KEY');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseDERSignature(sig: Uint8Array): { r: string; s: string } {
  if (sig[0] !== 0x30) throw new Error('Invalid DER: expected 0x30');

  let idx = 2; // skip 0x30 + length (we don't strictly need total length)

  if (sig[idx] !== 0x02) throw new Error('Invalid DER: expected 0x02 for r');
  const rLen = sig[idx + 1];
  const r = ethers.hexlify(sig.slice(idx + 2, idx + 2 + rLen));
  idx += 2 + rLen;

  if (sig[idx] !== 0x02) throw new Error('Invalid DER: expected 0x02 for s');
  const sLen = sig[idx + 1];
  const s = ethers.hexlify(sig.slice(idx + 2, idx + 2 + sLen));

  return { r, s };
}
