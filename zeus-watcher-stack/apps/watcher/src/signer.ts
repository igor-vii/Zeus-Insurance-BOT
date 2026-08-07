import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodePacked } from 'viem';

export class ObservationSigner {
  private account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKeyHex: string) {
    this.account = privateKeyToAccount(privateKeyHex as `0x${string}`);
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
