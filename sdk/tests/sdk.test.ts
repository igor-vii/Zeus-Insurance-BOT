import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ZeusSDK,
  ZeusValidationError,
  ZeusNotConnectedError,
  ZeusContractError,
  ZeusError,
  NETWORKS,
  AgreementStatus,
} from "../src/index.js";

const MOCK_ADDRESS = "0x1234567890123456789012345678901234567890";
const MOCK_EXECUTOR = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

/**
 * Creates a mock ethers signer whose provider reports the given chainId.
 * Defaults to 84532 (Base Sepolia) — the most-used network in these tests.
 */
function createMockSigner(chainId = 84532n) {
  return {
    getAddress: async () => MOCK_ADDRESS,
    provider: {
      getNetwork: async () => ({ chainId }),
      send: async () => ({}),
    },
  };
}

// ─── ZeusClient ──────────────────────────────────────────────────────────────

describe("ZeusClient", () => {
  it("should not be ready before connect", () => {
    const sdk = new ZeusSDK();
    assert.equal(sdk.client.isReady(), false);
  });

  it("should throw ZeusNotConnectedError for getAddress when not connected", () => {
    const sdk = new ZeusSDK();
    assert.throws(() => sdk.client.getAddress(), ZeusNotConnectedError);
  });

  it("should throw ZeusNotConnectedError for getNetwork when not connected", () => {
    const sdk = new ZeusSDK();
    assert.throws(() => sdk.client.getNetwork(), ZeusNotConnectedError);
  });

  it("should throw ZeusNotConnectedError for getSigner when not connected", () => {
    const sdk = new ZeusSDK();
    assert.throws(() => sdk.client.getSigner(), ZeusNotConnectedError);
  });

  it("should connect to base-sepolia and be ready", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-sepolia", createMockSigner(84532n) as any);
    assert.equal(sdk.client.isReady(), true);
    assert.equal(sdk.client.getAddress(), MOCK_ADDRESS);
    assert.equal(sdk.client.getNetwork().chainId, 84532);
  });

  it("should connect to base-mainnet and be ready", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-mainnet", createMockSigner(8453n) as any);
    assert.equal(sdk.client.isReady(), true);
    assert.equal(sdk.client.getNetwork().chainId, 8453);
  });

  it("should throw ZeusValidationError for unknown network", async () => {
    const sdk = new ZeusSDK();
    await assert.rejects(
      () => sdk.client.connect("polygon", createMockSigner(137n) as any),
      ZeusValidationError,
    );
  });

  it("should disconnect and become not ready", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-sepolia", createMockSigner(84532n) as any);
    assert.equal(sdk.client.isReady(), true);
    sdk.client.disconnect();
    assert.equal(sdk.client.isReady(), false);
  });

  it("should connect to all supported networks with matching chainIds", async () => {
    const cases = [
      { network: "mainnet",      chainId: 1n        },
      { network: "base-mainnet", chainId: 8453n     },
      { network: "base-sepolia", chainId: 84532n    },
      { network: "sepolia",      chainId: 11155111n },
      { network: "localhost",    chainId: 31337n    },
    ] as const;
    for (const { network, chainId } of cases) {
      const sdk = new ZeusSDK();
      await sdk.client.connect(network, createMockSigner(chainId) as any);
      assert.equal(sdk.client.isReady(), true);
      assert.equal(sdk.client.getNetwork().name, network);
    }
  });

  // ── chainId mismatch tests ──────────────────────────────────────────────────

  it("throws ZeusValidationError when signer is on mainnet but network is base-sepolia", async () => {
    const sdk = new ZeusSDK();
    await assert.rejects(
      () => sdk.client.connect("base-sepolia", createMockSigner(1n) as any),
      (err: unknown) => {
        assert.ok(err instanceof ZeusValidationError, `expected ZeusValidationError, got ${err}`);
        assert.match(err.message, /84532/);
        return true;
      },
    );
  });

  it("throws ZeusValidationError when signer is on base-sepolia but network is base-mainnet", async () => {
    const sdk = new ZeusSDK();
    await assert.rejects(
      () => sdk.client.connect("base-mainnet", createMockSigner(84532n) as any),
      (err: unknown) => {
        assert.ok(err instanceof ZeusValidationError, `expected ZeusValidationError, got ${err}`);
        assert.match(err.message, /8453/);
        return true;
      },
    );
  });

  it("throws ZeusValidationError when signer is on wrong chain for mainnet", async () => {
    const sdk = new ZeusSDK();
    await assert.rejects(
      () => sdk.client.connect("mainnet", createMockSigner(84532n) as any),
      (err: unknown) => {
        assert.ok(err instanceof ZeusValidationError, `expected ZeusValidationError, got ${err}`);
        assert.match(err.message, /1/); // expects chain 1
        return true;
      },
    );
  });
});

// ─── NETWORKS config ─────────────────────────────────────────────────────────

describe("NETWORKS", () => {
  it("should have base-sepolia with correct chainId", () => {
    assert.ok(NETWORKS["base-sepolia"]);
    assert.equal(NETWORKS["base-sepolia"].chainId, 84532);
  });

  it("should have base-mainnet with correct chainId", () => {
    assert.ok(NETWORKS["base-mainnet"]);
    assert.equal(NETWORKS["base-mainnet"].chainId, 8453);
  });

  it("base-mainnet should have the deployed escrow address", () => {
    assert.equal(
      NETWORKS["base-mainnet"].escrowAddress,
      "0x8D10C2c6C92b613C1938fe532f0e391044e76188",
    );
  });

  it("base-mainnet should have mainnet USDC address", () => {
    assert.equal(
      NETWORKS["base-mainnet"].usdcAddress,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  });

  it("base-sepolia should have the deployed escrow address", () => {
    assert.equal(
      NETWORKS["base-sepolia"].escrowAddress,
      "0x87365462353bCBAB2CF0DF57c7Cb15519C5B7c76",
    );
  });

  it("base-sepolia should have testnet USDC address", () => {
    assert.equal(
      NETWORKS["base-sepolia"].usdcAddress,
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
  });

  it("should have mainnet USDC address", () => {
    assert.equal(
      NETWORKS.mainnet.usdcAddress,
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    );
  });
});

// ─── Error classes ────────────────────────────────────────────────────────────

describe("Error Classes", () => {
  it("ZeusError should have correct properties", () => {
    const err = new ZeusError("test message", "TEST_CODE", { detail: "info" });
    assert.equal(err.message, "test message");
    assert.equal(err.code, "TEST_CODE");
    assert.equal(err.name, "ZeusError");
    assert.deepEqual(err.details, { detail: "info" });
    assert.ok(err instanceof Error);
  });

  it("ZeusNotConnectedError has NOT_CONNECTED code", () => {
    const err = new ZeusNotConnectedError();
    assert.equal(err.code, "NOT_CONNECTED");
    assert.ok(err instanceof ZeusError);
  });

  it("ZeusValidationError has VALIDATION_ERROR code", () => {
    const err = new ZeusValidationError("bad input", ["field required"]);
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.deepEqual(err.details, ["field required"]);
  });

  it("ZeusContractError has CONTRACT_ERROR code", () => {
    const err = new ZeusContractError("contract not deployed");
    assert.equal(err.code, "CONTRACT_ERROR");
  });
});

// ─── ZeusEscrow — validation (no RPC needed) ─────────────────────────────────

describe("ZeusEscrow — input validation", () => {
  it("depositAndCreateAgreement rejects invalid executor address", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-sepolia", createMockSigner(84532n) as any);
    await assert.rejects(
      () => sdk.escrow.depositAndCreateAgreement("not-an-address", 1_000_000n, 3600),
      ZeusValidationError,
    );
  });

  it("depositAndCreateAgreement rejects zero amount", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-sepolia", createMockSigner(84532n) as any);
    await assert.rejects(
      () => sdk.escrow.depositAndCreateAgreement(MOCK_EXECUTOR, 0n, 3600),
      ZeusValidationError,
    );
  });

  it("depositAndCreateAgreement rejects negative timeout", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-sepolia", createMockSigner(84532n) as any);
    await assert.rejects(
      () => sdk.escrow.depositAndCreateAgreement(MOCK_EXECUTOR, 1_000_000n, -1),
      ZeusValidationError,
    );
  });

  it("getAgreement rejects negative agreementId", async () => {
    const sdk = new ZeusSDK();
    await sdk.client.connect("base-sepolia", createMockSigner(84532n) as any);
    await assert.rejects(
      () => sdk.escrow.getAgreement(-1),
      ZeusValidationError,
    );
  });
});

// ─── ZeusEscrow — not connected ───────────────────────────────────────────────

describe("ZeusEscrow — not connected", () => {
  it("throws ZeusNotConnectedError when not connected", async () => {
    const sdk = new ZeusSDK();
    await assert.rejects(
      () => sdk.escrow.depositAndCreateAgreement(MOCK_EXECUTOR, 1_000_000n, 3600),
      ZeusNotConnectedError,
    );
  });
});

// ─── ZeusInsurance ────────────────────────────────────────────────────────────

describe("ZeusInsurance — no insuranceAddress on base-mainnet", () => {
  it("throws ZeusContractError when insuranceAddress is not set", async () => {
    const sdk = new ZeusSDK();
    // base-mainnet has insuranceAddress: "" — contract guard should fire
    await sdk.client.connect("base-mainnet", createMockSigner(8453n) as any);
    await assert.rejects(() => sdk.insurance.getPolicy(0), ZeusContractError);
  });
});

// ─── AgreementStatus enum ────────────────────────────────────────────────────

describe("AgreementStatus", () => {
  it("Active is 0", () => assert.equal(AgreementStatus.Active, 0));
  it("Completed is 1", () => assert.equal(AgreementStatus.Completed, 1));
  it("Refunded is 2", () => assert.equal(AgreementStatus.Refunded, 2));
});
