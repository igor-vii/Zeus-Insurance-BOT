import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeusInsuranceV2, ZeusReserveV2, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseUnits, ZeroAddress, keccak256, solidityPacked, toUtf8Bytes, getBytes } from "ethers";

// ── Constants ─────────────────────────────────────────────────────────────────

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

// ── Time helpers ──────────────────────────────────────────────────────────────

async function advanceTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function currentTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp;
}

// ── Signature helper ──────────────────────────────────────────────────────────

/**
 * Sign an observation the same way the Solidity contract verifies it.
 * keccak256(requestId, timestamp, status, metadataHash, nonce)  → EIP-191 personal_sign
 */
async function signObservation(
  signer: HardhatEthersSigner,
  obs: {
    policyId: bigint;
    requestId: string;
    timestamp: number;
    status: number;
    metadataHash: string;
    nonce: number;
  }
): Promise<string> {
  const msgHash = keccak256(
    solidityPacked(
      ["bytes32", "uint256", "uint256", "uint8", "bytes32", "uint256"],
      [obs.requestId, obs.policyId, obs.timestamp, obs.status, obs.metadataHash, obs.nonce]
    )
  );
  // personal_sign = EIP-191 prefix + keccak
  return signer.signMessage(getBytes(msgHash));
}

/**
 * Build a valid requestId: keccak256(buyer, seller, policyId, timestamp)
 */
function buildRequestId(buyer: string, seller: string, policyId: number, timestamp: number): string {
  return keccak256(solidityPacked(["address", "address", "uint256", "uint256"], [buyer, seller, policyId, timestamp]));
}

// ── Fixture ───────────────────────────────────────────────────────────────────

async function deploy() {
  const [owner, buyer, seller, w1, w2, w3, other] = await ethers.getSigners();

  // MockERC20 as USDC (6 decimals)
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const token: MockERC20 = await ERC20.deploy("Mock USDC", "USDC", USDC_DECIMALS);
  await token.waitForDeployment();

  // Mint tokens to buyer and provide reserve funding
  await token.mint(buyer!.address, usdc(100_000));
  await token.mint(owner!.address, usdc(1_000_000));

  // Deploy ZeusReserveV2
  const Reserve = await ethers.getContractFactory("ZeusReserveV2");
  const reserve: ZeusReserveV2 = await Reserve.deploy(
    await token.getAddress(),
    owner!.address
  );
  await reserve.waitForDeployment();

  // Raise daily payout cap so tests don't hit the default 10 000 USDC limit
  await reserve.setMaxDailyPayout(usdc(10_000_000));
  await reserve.setMinReserveThreshold(0n);

  // Deploy ZeusInsuranceV2
  const Insurance = await ethers.getContractFactory("ZeusInsuranceV2");
  const insurance: ZeusInsuranceV2 = await Insurance.deploy(
    await token.getAddress(),
    await reserve.getAddress()
  );
  await insurance.waitForDeployment();

  // Wire reserve → insurance
  await reserve.setInsuranceContract(await insurance.getAddress());

  // Fund the reserve
  await token.connect(owner!).approve(await reserve.getAddress(), usdc(100_000));
  await reserve.connect(owner!).deposit(usdc(100_000));

  // Approve premium for buyer
  await token.connect(buyer!).approve(await insurance.getAddress(), usdc(100_000));

  return {
    insurance,
    reserve,
    token,
    owner: owner!,
    buyer: buyer!,
    seller: seller!,
    w1: w1!,
    w2: w2!,
    w3: w3!,
    other: other!,
  };
}

// ── Shared policy helper ──────────────────────────────────────────────────────

async function buyPolicy(
  insurance: ZeusInsuranceV2,
  buyer: HardhatEthersSigner,
  seller: HardhatEthersSigner,
  amount = usdc(100),
  timeoutSeconds = 3600,
  maxRetries = 3,
  premium = usdc(5) // Default 5 USDC premium
) {
  const tx = await insurance.connect(buyer).buyPolicy(
    seller.address, amount, timeoutSeconds, maxRetries, premium
  );
  const receipt = await tx.wait();
  // Policy ID is nextPolicyId before increment; read from event
  const iface = insurance.interface;
  for (const log of receipt!.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "PolicyCreated") {
        return Number(parsed.args[0]); // policyId
      }
    } catch { /* skip */ }
  }
  throw new Error("PolicyCreated event not found");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ZeusInsuranceV2", function () {

  // ── Constructor ─────────────────────────────────────────────────────────────
  describe("constructor", function () {
    it("sets usdt and reserve addresses", async function () {
      const { insurance, token, reserve } = await deploy();
      expect(await insurance.usdt()).to.equal(await token.getAddress());
      expect(await insurance.reserve()).to.equal(await reserve.getAddress());
    });

    it("reverts on zero usdt address", async function () {
      const { reserve } = await deploy();
      const Insurance = await ethers.getContractFactory("ZeusInsuranceV2");
      await expect(
        Insurance.deploy(ZeroAddress, await reserve.getAddress())
      ).to.be.revertedWithCustomError(Insurance, "InvalidUSDTAddress");
    });

    it("reverts on zero reserve address", async function () {
      const { token } = await deploy();
      const Insurance = await ethers.getContractFactory("ZeusInsuranceV2");
      await expect(
        Insurance.deploy(await token.getAddress(), ZeroAddress)
      ).to.be.revertedWithCustomError(Insurance, "InvalidReserveAddress");
    });
  });

  // ── buyPolicy ──────────────────────────────────────────────────────────
  describe("buyPolicy", function () {
    it("creates a policy and emits PolicyCreated", async function () {
      const { insurance, buyer, seller } = await deploy();
      const amount = usdc(100);
      const premium = usdc(5);
      await expect(
        insurance.connect(buyer).buyPolicy(seller.address, amount, 3600, 3, premium)
      )
        .to.emit(insurance, "PolicyCreated")
        .withArgs(0n, buyer.address, seller.address, amount, premium, (v: bigint) => v > 0n, 0);
    });

    it("premium transferred to reserve", async function () {
      const { insurance, reserve, token, buyer, seller } = await deploy();
      const amount     = usdc(100);
      const premium    = usdc(10);

      const reserveBefore = await token.balanceOf(await reserve.getAddress());
      await insurance.connect(buyer).buyPolicy(seller.address, amount, 3600, 3, premium);
      const reserveAfter = await token.balanceOf(await reserve.getAddress());

      expect(reserveAfter - reserveBefore).to.equal(premium);
    });

    it("increments nextPolicyId", async function () {
      const { insurance, buyer, seller } = await deploy();
      await insurance.connect(buyer).buyPolicy(seller.address, usdc(100), 3600, 3, usdc(5));
      await insurance.connect(buyer).buyPolicy(seller.address, usdc(200), 3600, 2, usdc(8));
      expect(await insurance.nextPolicyId()).to.equal(2n);
    });

    it("stores correct policy fields", async function () {
      const { insurance, buyer, seller } = await deploy();
      const ts = await currentTimestamp();
      await insurance.connect(buyer).buyPolicy(seller.address, usdc(100), 3600, 3, usdc(5));
      const p = await insurance.getPolicy(0n);

      expect(p.buyer).to.equal(buyer.address);
      expect(p.seller).to.equal(seller.address);
      expect(p.amount).to.equal(usdc(100));
      expect(p.premium).to.equal(usdc(5));
      expect(p.maxRetries).to.equal(3n);
      expect(p.status).to.equal(0); // Active
      expect(p.retryDeadline).to.be.gt(BigInt(ts));
    });

    it("reverts for zero seller", async function () {
      const { insurance, buyer } = await deploy();
      await expect(
        insurance.connect(buyer).buyPolicy(ZeroAddress, usdc(100), 3600, 3, usdc(5))
      ).to.be.revertedWithCustomError(insurance, "InvalidSeller");
    });

    it("reverts for zero amount", async function () {
      const { insurance, buyer, seller } = await deploy();
      await expect(
        insurance.connect(buyer).buyPolicy(seller.address, 0n, 3600, 3, usdc(5))
      ).to.be.revertedWithCustomError(insurance, "InvalidAmount");
    });

    it("reverts for maxRetries = 0", async function () {
      const { insurance, buyer, seller } = await deploy();
      await expect(
        insurance.connect(buyer).buyPolicy(seller.address, usdc(100), 3600, 0, usdc(5))
      ).to.be.revertedWithCustomError(insurance, "InvalidRetries");
    });

    it("reverts for maxRetries > 10", async function () {
      const { insurance, buyer, seller } = await deploy();
      await expect(
        insurance.connect(buyer).buyPolicy(seller.address, usdc(100), 3600, 11, usdc(5))
      ).to.be.revertedWithCustomError(insurance, "InvalidRetries");
    });
  });

  // ── claimPayout (timeout-based) ───────────────────────────────────────────
  describe("claimPayout", function () {
    it("pays out after retryDeadline and emits PayoutExecuted", async function () {
      const { insurance, token, buyer, seller } = await deploy();
      const amount = usdc(100);
      const policyId = await buyPolicy(insurance, buyer, seller, amount, 3600, 1);

      await advanceTime(3601);

      const balanceBefore = await token.balanceOf(buyer.address);
      await expect(insurance.connect(buyer).claimPayout(policyId))
        .to.emit(insurance, "PayoutExecuted")
        .withArgs(policyId, amount);

      expect(await token.balanceOf(buyer.address)).to.equal(balanceBefore + amount);
    });

    it("marks policy status as Claimed (1)", async function () {
      const { insurance, buyer, seller } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 60, 1);
      await advanceTime(61);
      await insurance.connect(buyer).claimPayout(policyId);
      const p = await insurance.getPolicy(policyId);
      expect(p.status).to.equal(1); // Claimed
    });

    it("reverts if not buyer", async function () {
      const { insurance, buyer, seller, other } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 60, 1);
      await advanceTime(61);
      await expect(
        insurance.connect(other).claimPayout(policyId)
      ).to.be.revertedWithCustomError(insurance, "OnlyBuyerCanClaim");
    });

    it("reverts before retryDeadline", async function () {
      const { insurance, buyer, seller } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 3600, 1);
      await expect(
        insurance.connect(buyer).claimPayout(policyId)
      ).to.be.revertedWithCustomError(insurance, "TimeoutNotReached");
    });

    it("reverts on double-claim", async function () {
      const { insurance, buyer, seller } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 60, 1);
      await advanceTime(61);
      await insurance.connect(buyer).claimPayout(policyId);
      await expect(
        insurance.connect(buyer).claimPayout(policyId)
      ).to.be.revertedWithCustomError(insurance, "PolicyNotActive");
    });
  });

  // ── Watcher management ────────────────────────────────────────────────────
  describe("watcher management", function () {
    it("addWatcher registers a watcher and emits WatcherAdded", async function () {
      const { insurance, owner, w1 } = await deploy();
      await expect(insurance.connect(owner).addWatcher(w1.address))
        .to.emit(insurance, "WatcherAdded")
        .withArgs(w1.address);
      expect(await insurance.isWatcher(w1.address)).to.be.true;
    });

    it("getWatchers returns all registered watchers", async function () {
      const { insurance, owner, w1, w2 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      await insurance.connect(owner).addWatcher(w2.address);
      const list = await insurance.getWatchers();
      expect(list).to.include(w1.address);
      expect(list).to.include(w2.address);
    });

    it("removeWatcher deregisters and emits WatcherRemoved", async function () {
      const { insurance, owner, w1 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      await expect(insurance.connect(owner).removeWatcher(w1.address))
        .to.emit(insurance, "WatcherRemoved")
        .withArgs(w1.address);
      expect(await insurance.isWatcher(w1.address)).to.be.false;
    });

    it("reverts addWatcher for zero address", async function () {
      const { insurance, owner } = await deploy();
      await expect(
        insurance.connect(owner).addWatcher(ZeroAddress)
      ).to.be.revertedWithCustomError(insurance, "ZeroAddress");
    });

    it("reverts addWatcher for duplicate", async function () {
      const { insurance, owner, w1 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      await expect(
        insurance.connect(owner).addWatcher(w1.address)
      ).to.be.revertedWithCustomError(insurance, "AlreadyWatcher");
    });

    it("reverts removeWatcher for non-watcher", async function () {
      const { insurance, owner, w1 } = await deploy();
      await expect(
        insurance.connect(owner).removeWatcher(w1.address)
      ).to.be.revertedWithCustomError(insurance, "NotWatcher");
    });

    it("reverts addWatcher from non-owner", async function () {
      const { insurance, w1, other } = await deploy();
      await expect(
        insurance.connect(other).addWatcher(w1.address)
      ).to.be.revertedWithCustomError(insurance, "OwnableUnauthorizedAccount");
    });
  });

  // ── submitObservation ─────────────────────────────────────────────────────
  describe("submitObservation", function () {

    async function setup() {
      const ctx = await deploy();
      const { insurance, owner, buyer, seller, w1, w2, w3 } = ctx;

      // Register three watchers
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      await insurance.connect(owner).addWatcher(w2.address);
      await insurance.connect(owner).addWatcher(w3.address);

      // Create a policy
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 3600, 3);

      // Build a shared timestamp that is "now" (within the ±120 s window)
      const ts = await currentTimestamp();

      const requestId = buildRequestId(buyer.address, seller.address, policyId, ts);
      const metadataHash = keccak256(toUtf8Bytes("test-metadata"));

      async function makeObs(watcher: HardhatEthersSigner, status: number, nonce: number, policyId: bigint) {
        const sig = await signObservation(watcher, {
          requestId,
        policyId,
          timestamp: ts,
          status,
          metadataHash,
          nonce,
        });
        return { requestId, timestamp: ts, status, metadataHash, nonce, signature: sig };
      }

      return { ...ctx, policyId, requestId, metadataHash, ts, makeObs };
    }

    it("accepts a valid watcher observation and emits ObservationSubmitted", async function () {
      const { insurance, w1, policyId, makeObs } = await setup();
      const obs = await makeObs(w1, 1, 0, policyId);
      await expect(insurance.submitObservation(policyId, obs))
        .to.emit(insurance, "ObservationSubmitted")
        .withArgs(obs.requestId, w1.address, 1);
    });

    it("resolves to PAYOUT when 2+ TIMEOUT votes (status=1)", async function () {
      const { insurance, token, buyer, w1, w2, w3, policyId, requestId, makeObs } = await setup();

      const balanceBefore = await token.balanceOf(buyer.address);

      await insurance.submitObservation(policyId, await makeObs(w1, 1, 0, policyId)); // TIMEOUT
      await insurance.submitObservation(policyId, await makeObs(w2, 1, 1, policyId)); // TIMEOUT
      const tx = insurance.submitObservation(policyId, await makeObs(w3, 0, 2, policyId)); // OK

      await expect(tx)
        .to.emit(insurance, "VoteResolved")
        .withArgs(requestId, 1, policyId)
        .and.to.emit(insurance, "PayoutExecuted")
        .withArgs(policyId, usdc(100));

      expect(await token.balanceOf(buyer.address)).to.equal(balanceBefore + usdc(100));
    });

    it("resolves to REJECTED when < 2 TIMEOUT votes", async function () {
      const { insurance, w1, w2, w3, policyId, requestId, makeObs } = await setup();

      await insurance.submitObservation(policyId, await makeObs(w1, 0, 0, policyId)); // OK
      await insurance.submitObservation(policyId, await makeObs(w2, 0, 1, policyId)); // OK

      await expect(
        insurance.submitObservation(policyId, await makeObs(w3, 1, 2, policyId)) // TIMEOUT
      )
        .to.emit(insurance, "VoteResolved")
        .withArgs(requestId, 0, policyId)
        .and.to.emit(insurance, "ClaimRejected")
        .withArgs(policyId);
    });

    it("reverts if watcher votes twice on same requestId", async function () {
      const { insurance, w1, policyId, makeObs } = await setup();

      await insurance.submitObservation(policyId, await makeObs(w1, 1, 0, policyId));

      // same watcher, same requestId, different nonce — still the same requestId
      const obs2 = await makeObs(w1, 1, 1, policyId);
      await expect(
        insurance.submitObservation(policyId, obs2)
      ).to.be.revertedWithCustomError(insurance, "WatcherAlreadyVoted");
    });

    it("reverts for a signature from a non-watcher", async function () {
      const { insurance, other, policyId, buyer, seller, ts, metadataHash } = await setup();
      const requestId = buildRequestId(buyer.address, seller.address, policyId, ts);
      const sig = await signObservation(other, { requestId, timestamp: ts, status: 1, metadataHash, nonce: 99 });
      await expect(
        insurance.submitObservation(policyId, { requestId, timestamp: ts, status: 1, metadataHash, nonce: 99, signature: sig })
      ).to.be.revertedWithCustomError(insurance, "InvalidWatcherSignature");
    });

    it("reverts for a stale timestamp (> 120 s old)", async function () {
      const { insurance, w1, policyId, buyer, seller, metadataHash } = await setup();

      const staleTs = (await currentTimestamp()) - 200;
      const requestId = buildRequestId(buyer.address, seller.address, policyId, staleTs);
      const sig = await signObservation(w1, { requestId, timestamp: staleTs, status: 1, metadataHash, nonce: 0 });

      await expect(
        insurance.submitObservation(policyId, { requestId, timestamp: staleTs, status: 1, metadataHash, nonce: 0, signature: sig })
      ).to.be.revertedWithCustomError(insurance, "TimestampOutOfWindow");
    });

    it("reverts if requestId doesn't match (buyer/seller/timestamp)", async function () {
      const { insurance, w1, policyId, ts, metadataHash, other } = await setup();
      // Build requestId with a wrong seller address
      const wrongRequestId = buildRequestId(other.address, other.address, policyId, ts);
      const sig = await signObservation(w1, { requestId: wrongRequestId, timestamp: ts, status: 1, metadataHash, nonce: 0 });
      await expect(
        insurance.submitObservation(policyId, { requestId: wrongRequestId, timestamp: ts, status: 1, metadataHash, nonce: 0, signature: sig })
      ).to.be.revertedWithCustomError(insurance, "InvalidRequestId");
    });

    it("reverts after requestId is resolved (used)", async function () {
      const { insurance, w1, w2, w3, policyId, makeObs, requestId, ts, metadataHash } = await setup();

      // Resolve the vote
      await insurance.submitObservation(policyId, await makeObs(w1, 1, 0, policyId));
      await insurance.submitObservation(policyId, await makeObs(w2, 1, 1, policyId));
      await insurance.submitObservation(policyId, await makeObs(w3, 1, 2, policyId));

      // Now the requestId is consumed — any further submission with it reverts
      const { other } = await deploy(); // fresh signer to avoid "already voted"
      const sig = await signObservation(w1, { requestId, timestamp: ts, status: 1, metadataHash, nonce: 10 });
      await expect(
        insurance.submitObservation(policyId, { requestId, timestamp: ts, status: 1, metadataHash, nonce: 10, signature: sig })
      ).to.be.revertedWithCustomError(insurance, "RequestAlreadyResolved");
    });
  });

  // ── buySlashingProtection ─────────────────────────────────────────────────
  describe("buySlashingProtection", function () {
    it("creates a SlashingProtection policy and emits PolicyCreated", async function () {
      const { insurance, buyer, seller } = await deploy();
      const amount = usdc(100);
      const premium = usdc(5);
      await expect(
        insurance.connect(buyer).buySlashingProtection(seller.address, amount, 3600, premium)
      )
        .to.emit(insurance, "PolicyCreated")
        .withArgs(0n, buyer.address, seller.address, amount, premium, (v: bigint) => v > 0n, 1);
    });

    it("sets coverageType to SlashingProtection (1)", async function () {
      const { insurance, buyer, seller } = await deploy();
      await insurance.connect(buyer).buySlashingProtection(seller.address, usdc(100), 3600, usdc(5));
      expect(await insurance.getCoverageType(0n)).to.equal(1n); // SlashingProtection
    });

    it("standard buyPolicy has coverageType Standard (0)", async function () {
      const { insurance, buyer, seller } = await deploy();
      await insurance.connect(buyer).buyPolicy(seller.address, usdc(100), 3600, 1, usdc(5));
      expect(await insurance.getCoverageType(0n)).to.equal(0n); // Standard
    });

    it("premium is transferred to reserve", async function () {
      const { insurance, reserve, token, buyer, seller } = await deploy();
      const amount          = usdc(100);
      const premium         = usdc(5);

      const reserveBefore = await token.balanceOf(await reserve.getAddress());
      await insurance.connect(buyer).buySlashingProtection(seller.address, amount, 3600, premium);
      const reserveAfter = await token.balanceOf(await reserve.getAddress());

      expect(reserveAfter - reserveBefore).to.equal(premium);
    });

    it("stores maxRetries = 1 and correct fields", async function () {
      const { insurance, buyer, seller } = await deploy();
      const ts = await currentTimestamp();
      await insurance.connect(buyer).buySlashingProtection(seller.address, usdc(100), 3600, usdc(5));
      const p = await insurance.getPolicy(0n);

      expect(p.buyer).to.equal(buyer.address);
      expect(p.seller).to.equal(seller.address);
      expect(p.amount).to.equal(usdc(100));
      expect(p.maxRetries).to.equal(1n);
      expect(p.status).to.equal(0); // Active
      expect(p.retryDeadline).to.be.gt(BigInt(ts));
    });

    it("reverts for zero validator address", async function () {
      const { insurance, buyer } = await deploy();
      await expect(
        insurance.connect(buyer).buySlashingProtection(ZeroAddress, usdc(100), 3600, usdc(5))
      ).to.be.revertedWithCustomError(insurance, "InvalidSeller");
    });

    it("reverts for zero amount", async function () {
      const { insurance, buyer, seller } = await deploy();
      await expect(
        insurance.connect(buyer).buySlashingProtection(seller.address, 0n, 3600, usdc(5))
      ).to.be.revertedWithCustomError(insurance, "InvalidAmount");
    });
  });

  // ── reportSlashing ────────────────────────────────────────────────────────
  describe("reportSlashing", function () {
    const EVIDENCE = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    async function buySlashing(
      insurance: ZeusInsuranceV2,
      buyer: HardhatEthersSigner,
      seller: HardhatEthersSigner,
    ) {
      const tx      = await insurance.connect(buyer).buySlashingProtection(seller.address, usdc(100), 3600, usdc(5));
      const receipt = await tx.wait();
      const iface   = insurance.interface;
      for (const log of receipt!.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "PolicyCreated") return Number(parsed.args[0]);
        } catch { /* skip */ }
      }
      throw new Error("PolicyCreated not found");
    }

    it("watcher can reportSlashing and emits SlashingReported + PayoutExecuted", async function () {
      const { insurance, token, owner, buyer, seller, w1 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);

      const policyId     = await buySlashing(insurance, buyer, seller);
      const balanceBefore = await token.balanceOf(buyer.address);

      await expect(insurance.connect(w1).reportSlashing(policyId, EVIDENCE))
        .to.emit(insurance, "SlashingReported")
        .withArgs(policyId, seller.address, EVIDENCE)
        .and.to.emit(insurance, "PayoutExecuted")
        .withArgs(policyId, usdc(100));

      expect(await token.balanceOf(buyer.address)).to.equal(balanceBefore + usdc(100));
    });

    it("sets policy status to Claimed after report", async function () {
      const { insurance, owner, buyer, seller, w1 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      const policyId = await buySlashing(insurance, buyer, seller);
      await insurance.connect(w1).reportSlashing(policyId, EVIDENCE);
      const p = await insurance.getPolicy(policyId);
      expect(p.status).to.equal(1); // Claimed
    });

    it("reverts if caller is not a watcher", async function () {
      const { insurance, buyer, seller, other } = await deploy();
      const policyId = await buySlashing(insurance, buyer, seller);
      await expect(
        insurance.connect(other).reportSlashing(policyId, EVIDENCE)
      ).to.be.revertedWithCustomError(insurance, "NotWatcher");
    });

    it("reverts for a standard (non-slashing) policy", async function () {
      const { insurance, owner, buyer, seller, w1 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 3600, 1);
      await expect(
        insurance.connect(w1).reportSlashing(policyId, EVIDENCE)
      ).to.be.revertedWithCustomError(insurance, "NotASlashingPolicy");
    });

    it("reverts for a non-active policy (already claimed)", async function () {
      const { insurance, owner, buyer, seller, w1 } = await deploy();
      await insurance.connect(owner).addWatcher(w1.address);
      await insurance.connect(owner).addWatcher(w2.address);
      const policyId = await buySlashing(insurance, buyer, seller);
      await insurance.connect(w1).reportSlashing(policyId, EVIDENCE);
      await expect(
        insurance.connect(w1).reportSlashing(policyId, EVIDENCE)
      ).to.be.revertedWithCustomError(insurance, "PolicyNotActive");
    });
  });

  // ── isClaimApproved / markClaimFulfilled ──────────────────────────────────
  describe("IInsuranceContract interface", function () {
    it("isClaimApproved returns false before claim", async function () {
      const { insurance, buyer, seller } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller);
      expect(await insurance.isClaimApproved(policyId, buyer.address, usdc(100))).to.be.false;
    });

    it("isClaimApproved returns true after claimPayout marks status=Claimed", async function () {
      const { insurance, buyer, seller } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 60, 1);
      await advanceTime(61);
      await insurance.connect(buyer).claimPayout(policyId);
      expect(await insurance.isClaimApproved(policyId, buyer.address, usdc(100))).to.be.true;
    });

    it("markClaimFulfilled reverts if not called by reserve", async function () {
      const { insurance, buyer, seller } = await deploy();
      const policyId = await buyPolicy(insurance, buyer, seller, usdc(100), 60, 1);
      await advanceTime(61);
      await insurance.connect(buyer).claimPayout(policyId);
      await expect(
        insurance.markClaimFulfilled(policyId)
      ).to.be.revertedWithCustomError(insurance, "OnlyReserveCanCall");
    });
  });
});
