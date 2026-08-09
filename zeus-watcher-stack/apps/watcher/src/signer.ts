import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodePacked } from 'viem';

export class ObservationSigner {
  private account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKeyHex: string) {
    const raw = (privateKeyHex ?? "").trim().replace(/^["']+|["']+$/g, "");
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error("WATCHER_PRIVATE_KEY must be 0x + 64 hex chars, got: " + key.slice(0, 6) + "...");
    }
    this.account = privateKeyToAccount(key as `0x${string}`);
  }

  async signObservation(params: {
    policyId: string;
    buyer: string;
    seller: string;
    timestamp: number;
    status: number;
    metadataHash?: string;
    nonce?: number;
  }) {
    const { policyId, buyer, seller, timestamp, status, metadataHash, nonce } = params;

    const policyIdBigInt = BigInt(policyId);
    const timestampBigInt = BigInt(timestamp);
    const n = nonce ?? 0;

    // requestId = keccak256(abi.encodePacked(buyer, seller, policyId, timestamp))
    const packedRequestId = encodePacked(
      ['address', 'address', 'uint256', 'uint256'],
      [buyer as `0x${string}`, seller as `0x${string}`, policyIdBigInt, timestampBigInt]
    );
    const requestId = keccak256(packedRequestId);

    const meta = metadataHash || '0x0000000000000000000000000000000000000000000000000000000000000000';

    // Contract verification expects:
    // msgHash = keccak256(abi.encodePacked(requestId, policyId, timestamp, status, metadataHash, nonce))
    const msgPacked = encodePacked(
      ['bytes32', 'uint256', 'uint256', 'uint8', 'bytes32', 'uint256'],
      [requestId, policyIdBigInt, timestampBigInt, status as unknown as number, meta as `0x${string}`, BigInt(n)]
    );
    const msgHash = keccak256(msgPacked);

    // Sign the message using viem's account.signMessage
    const signature = await this.account.signMessage({
      message: { raw: msgHash },
    });

    return {
      requestId,
      timestamp,
      status,
      metadataHash: meta,
      nonce: n,
      signature,
    };
  }
}
