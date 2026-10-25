/**
 * Settle orchestration tests — broadcast taxonomy, nonce guard, receipt mapping.
 * Hermetic: ChainRpc is faked; the raw tx signature is verified with viem's
 * transaction recovery (offline crypto).
 */
import { recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RpcUnavailableError } from "../src/rpc.js";
import { NonceGuard, SettleExecutor, encodeSettleCalldata } from "../src/settle.js";
import { toFunctionSelector } from "viem";
import {
  NETWORK,
  SELLER,
  TEST_GAS_KEY,
  TEST_PAYER_KEY,
  buildSignedRequest,
  fakeRpc,
} from "./helpers.js";

function executorWith(rpc: ReturnType<typeof fakeRpc>, receiptTimeoutMs = 5000): SettleExecutor {
  const account = privateKeyToAccount(TEST_GAS_KEY);
  return new SettleExecutor(
    rpc,
    account,
    { id: 196, name: "x-layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } } as never,
    NETWORK,
    receiptTimeoutMs,
  );
}

async function verifiedPayload() {
  const { request, payer } = await buildSignedRequest();
  return {
    payer,
    authorization: {
      from: payer,
      to: SELLER,
      value: 1_000_000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: request.paymentPayload.payload.authorization.nonce as Hex,
    },
    signature: request.paymentPayload.payload.signature as Hex,
  };
}

describe("encodeSettleCalldata", () => {
  it("produces the canonical transferWithAuthorization selector", () => {
    // keccak("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")
    // = 0xe3ee160e — viem derives the selector from the ABI fragment itself.
    expect(toFunctionSelector(
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
    )).toBe("0xe3ee160e");
    const data = encodeSettleCalldata(
      { from: TEST_PAYER_KEY.slice(0, 42) as `0x${string}`, to: SELLER, value: 1n, validAfter: 0n, validBefore: 1n, nonce: ("0x" + "22".repeat(32)) as Hex },
      { v: 27, r: ("0x" + "33".repeat(32)) as Hex, s: ("0x" + "44".repeat(32)) as Hex },
    );
    expect(data.startsWith("0xe3ee160e")).toBe(true);
  });
});

describe("SettleExecutor", () => {
  it("broadcasts once and returns success with both transaction and transactionHash", async () => {
    const rpc = fakeRpc();
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const outcome = await executor.settle(payload.payer, payload.authorization, payload.signature);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body.success).toBe(true);
    if (outcome.body.success) {
      expect(outcome.body.transaction).toBe(outcome.body.transactionHash);
      expect(outcome.body.network).toBe("eip155:196");
      expect(rpc.sentTxs).toHaveLength(1);
    }
  });

  it("refuses a second settle for the same nonce with the broadcast tx hash (409)", async () => {
    const rpc = fakeRpc();
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const first = await executor.settle(payload.payer, payload.authorization, payload.signature);
    const second = await executor.settle(payload.payer, payload.authorization, payload.signature);

    expect(first.body.success).toBe(true);
    expect(second.httpStatus).toBe(409);
    expect(second.body).toMatchObject({ success: false });
    if (!second.body.success) {
      expect(second.body.errorReason).toContain("duplicate_settle_already_broadcast");
    }
    expect(rpc.sentTxs).toHaveLength(1);
  });

  it("refuses a concurrent duplicate settle while the first is in flight", async () => {
    const broadcast: string[] = [];
    const rpc = fakeRpc({
      async sendRawTransaction(signedTx: string) {
        broadcast.push(signedTx);
        await new Promise((r) => setTimeout(r, 50));
        return ("0x" + "aa".repeat(32)) as Hex;
      },
    });
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const [first, second] = await Promise.all([
      executor.settle(payload.payer, payload.authorization, payload.signature),
      executor.settle(payload.payer, payload.authorization, payload.signature),
    ]);

    expect(second.httpStatus).toBe(409);
    if (!second.body.success) {
      expect(second.body.errorReason).toBe("duplicate_settle_inflight");
    }
    expect(first.httpStatus).toBe(200);
    expect(broadcast).toHaveLength(1);
  });

  it("maps a reverted receipt to 200 {success:false, settle_reverted} with the tx hash", async () => {
    const rpc = fakeRpc({
      async waitForReceipt() {
        return { status: "reverted" as const };
      },
    });
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const outcome = await executor.settle(payload.payer, payload.authorization, payload.signature);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body.success).toBe(false);
    if (!outcome.body.success) {
      expect(outcome.body.errorReason).toBe("settle_reverted");
      expect(outcome.body.transaction).toBeDefined();
    }
  });

  it("maps receipt timeout to 504 receipt_timeout (ambiguous — client goes RECONCILING)", async () => {
    const rpc = fakeRpc({
      async waitForReceipt() {
        throw new Error("timeout");
      },
    });
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const outcome = await executor.settle(payload.payer, payload.authorization, payload.signature);
    expect(outcome.httpStatus).toBe(504);
    expect(outcome.body.success).toBe(false);
    if (!outcome.body.success) {
      expect(outcome.body.errorReason).toBe("receipt_timeout");
      expect(outcome.body.transaction).toBeDefined();
    }
  });

  it("maps broadcast RPC failure to 503 broadcast_unavailable and releases the nonce", async () => {
    const rpc = fakeRpc({
      async sendRawTransaction() {
        throw new RpcUnavailableError("all endpoints down");
      },
    });
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const first = await executor.settle(payload.payer, payload.authorization, payload.signature);
    expect(first.httpStatus).toBe(503);
    expect(first.body).toMatchObject({ success: false });

    // Nonce was released: a retry may claim and broadcast again.
    const rpc2 = fakeRpc();
    const executor2 = executorWith(rpc2);
    const second = await executor2.settle(payload.payer, payload.authorization, payload.signature);
    expect(second.body.success).toBe(true);
  });

  it("maps a definitively rejected broadcast (gas estimation revert) to 200 broadcast_rejected", async () => {
    const rpc = fakeRpc({
      async estimateGas() {
        throw new Error("execution reverted");
      },
    });
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();

    const outcome = await executor.settle(payload.payer, payload.authorization, payload.signature);
    expect(outcome.httpStatus).toBe(200);
    if (!outcome.body.success) {
      expect(outcome.body.errorReason.startsWith("broadcast_rejected")).toBe(true);
    }
  });

  it("the signed raw tx is a valid EIP-1559 tx signed by the gas payer", async () => {
    const rpc = fakeRpc();
    const executor = executorWith(rpc);
    const payload = await verifiedPayload();
    await executor.settle(payload.payer, payload.authorization, payload.signature);

    const serialized = rpc.sentTxs[0];
    const recovered = await recoverTransactionAddress({ serializedTransaction: serialized as Hex });
    const gasPayer = privateKeyToAccount(TEST_GAS_KEY).address;
    expect(recovered.toLowerCase()).toBe(gasPayer.toLowerCase());
  });
});

describe("NonceGuard", () => {
  it("claims once, releases only inflight entries", () => {
    const guard = new NonceGuard();
    expect(guard.claim("n1")).toMatchObject({ claimed: true });
    expect(guard.claim("n1")).toMatchObject({ claimed: false });
    guard.release("n1"); // done-state would NOT be released; inflight is
    // released inflight -> claimable again
    expect(guard.claim("n1")).toMatchObject({ claimed: true });
    guard.markDone("n1", ("0x" + "bb".repeat(32)) as Hex);
    const second = guard.claim("n1");
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.existing.txHash).toBe("0x" + "bb".repeat(32));
    }
  });
});
