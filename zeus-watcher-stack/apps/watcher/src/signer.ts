import { keccak256, toUtf8Bytes, SigningKey } from 'ethers';

function hexToBytes(hex: string): Uint8Array {
  hex = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}

export class ObservationSigner {
  private key: SigningKey;

  constructor(privateKeyHex: string) {
    this.key = new SigningKey(privateKeyHex);
  }

  /**
   * Формирует Observation согласно ZeusInsuranceV2.submitObservation
   * requestId = keccak256(abi.encodePacked(buyer, seller, policyId, timestamp))
   */
  async signObservation(params: {
    policyId: string;
    buyer: string;
    seller: string;
    timestamp: number;
    status: number; // 1 = timeout/payout, 0 = reject
    metadataHash?: string;
    nonce?: number;
  }) {
    const { policyId, buyer, seller, timestamp, status, metadataHash, nonce } = params;

    // requestId как в контракте: keccak256(abi.encodePacked(buyer, seller, policyId, timestamp))
    // Packed encoding: addresses are 20 bytes each, uint256 is 32 bytes
    const packed = concatBytes(
      concatBytes(
        concatBytes(
          hexToBytes(buyer),
          hexToBytes(seller)
        ),
        hexToBytes('0x' + BigInt(policyId).toString(16).padStart(64, '0'))
      ),
      hexToBytes('0x' + BigInt(timestamp).toString(16).padStart(64, '0'))
    );
    const requestId = keccak256(packed);

    const meta = metadataHash || '0x0000000000000000000000000000000000000000000000000000000000000000';
    const n = nonce ?? 0;

    // msgHash = keccak256(abi.encodePacked(requestId, timestamp, status, metadataHash, nonce))
    const msgPacked = concatBytes(
      concatBytes(
        concatBytes(
          concatBytes(
            hexToBytes(requestId),
            hexToBytes('0x' + BigInt(timestamp).toString(16).padStart(64, '0'))
          ),
          hexToBytes('0x' + status.toString(16).padStart(2, '0'))
        ),
        hexToBytes(meta)
      ),
      hexToBytes('0x' + BigInt(n).toString(16).padStart(64, '0'))
    );

    const msgHash = keccak256(msgPacked);
    const ethPrefix = toUtf8Bytes('\x19Ethereum Signed Message:\n32');
    const ethMsg = concatBytes(ethPrefix, hexToBytes(msgHash));
    const ethHash = keccak256(ethMsg);

    const sig = this.key.sign(ethHash);
    const r = sig.r.slice(2).padStart(64, '0');
    const s = sig.s.slice(2).padStart(64, '0');
    const v = (sig.v).toString(16).padStart(2, '0');

    return {
      requestId,
      timestamp,
      status,
      metadataHash: meta,
      nonce: n,
      signature: '0x' + r + s + v,
    };
  }
}
