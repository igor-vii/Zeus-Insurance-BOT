import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeusEscrowBOT, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseUnits, ZeroAddress } from "ethers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DECIMALS = 18;
const tok = (n: number | string) => parseUnits(String(n), DECIMALS);

/** Advance the Hardhat clock by `seconds`. */
async function advanceTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deploy() {
  const [owner, initiator, executor, other] = await ethers.getSigners();

  const ERC20 = await ethers.getContractFactory("MockERC20");
  const token: MockERC20 = await ERC20.deploy("Mock BOT Token", "BOT", DECIMALS);
  await token.waitForDeployment();

  // Mint tokens to the initiator
  await token.mint(initiator!.address, tok(100_000));

  const Escrow = await ethers.getContractFactory("ZeusEscrowBOT");
  // Pass ZeroAddress as treasury → no protocol fee (test/local mode)
  const escrow: ZeusEscrowBOT = await Escrow.deploy(await token.getAddress(), ZeroAddress);
  await escrow.waitForDeployment();

  return { escrow, token, owner: owner!, initiator: initiator!, executor: executor!, other: other! };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ZeusEscrowBOT", function () {

  // ── Constructor ───────────────────────────────────────────────────────────
  describe("constructor", function () {
    it("sets the token address correctly", async function () {
      const { escrow, token } = await deploy();
      expect(await escrow.token()).to.equal(await token.getAddress());
    });

    it("reverts if token address is zero", async function () {
      const Escrow = await ethers.getContractFactory("ZeusEscrowBOT");
      await expect(Escrow.deploy(ZeroAddress, ZeroAddress)).to.be.revertedWith(
        "ZeusEscrowBOT: zero token address"
      );
    });
  });

  // ── depositAndCreateAgreement ─────────────────────────────────────────────
  describe("depositAndCreateAgreement", function () {
    it("creates an agreement and locks tokens in the contract", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const amount = tok(500);
      const timeout = 3600; // 1 hour

      await token.connect(initiator).approve(await escrow.getAddress(), amount);
      await expect(
        escrow.connect(initiator).depositAndCreateAgreement(executor.address, amount, timeout)
      )
        .to.emit(escrow, "AgreementCreated")
        .withArgs(
          1n,
          initiator.address,
          executor.address,
          amount,
          timeout,
          // createdAt — we don't know the exact value, use anyValue
          (v: bigint) => v > 0n
        );

      // Agreement stored correctly
      const ag = await escrow.getAgreement(1n);
      expect(ag.initiator).to.equal(initiator.address);
      expect(ag.executor).to.equal(executor.address);
      expect(ag.amount).to.equal(amount);
      expect(ag.timeout).to.equal(timeout);
      expect(ag.status).to.equal(0); // Active

      // Tokens locked in escrow
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(amount);
      expect(await token.balanceOf(initiator.address)).to.equal(tok(100_000) - amount);
    });

    it("increments agreementCount", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      await token.connect(initiator).approve(await escrow.getAddress(), tok(1000));

      await escrow.connect(initiator).depositAndCreateAgreement(executor.address, tok(100), 3600);
      await escrow.connect(initiator).depositAndCreateAgreement(executor.address, tok(200), 7200);

      expect(await escrow.agreementCount()).to.equal(2n);
    });

    it("reverts if executor is zero address", async function () {
      const { escrow, token, initiator } = await deploy();
      await token.connect(initiator).approve(await escrow.getAddress(), tok(100));
      await expect(
        escrow.connect(initiator).depositAndCreateAgreement(ZeroAddress, tok(100), 3600)
      ).to.be.revertedWith("ZeusEscrowBOT: zero executor address");
    });

    it("reverts if initiator and executor are the same", async function () {
      const { escrow, token, initiator } = await deploy();
      await token.connect(initiator).approve(await escrow.getAddress(), tok(100));
      await expect(
        escrow.connect(initiator).depositAndCreateAgreement(initiator.address, tok(100), 3600)
      ).to.be.revertedWith("ZeusEscrowBOT: initiator and executor must differ");
    });

    it("reverts if amount is zero", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      await token.connect(initiator).approve(await escrow.getAddress(), tok(100));
      await expect(
        escrow.connect(initiator).depositAndCreateAgreement(executor.address, 0n, 3600)
      ).to.be.revertedWith("ZeusEscrowBOT: amount must be positive");
    });

    it("reverts if timeout is zero", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      await token.connect(initiator).approve(await escrow.getAddress(), tok(100));
      await expect(
        escrow.connect(initiator).depositAndCreateAgreement(executor.address, tok(100), 0)
      ).to.be.revertedWith("ZeusEscrowBOT: timeout must be positive");
    });

    it("reverts if allowance is insufficient", async function () {
      const { escrow, initiator, executor } = await deploy();
      // No approve call
      await expect(
        escrow.connect(initiator).depositAndCreateAgreement(executor.address, tok(100), 3600)
      ).to.be.reverted;
    });
  });

  // ── confirmExecution ──────────────────────────────────────────────────────
  describe("confirmExecution", function () {
    async function createAgreement(
      escrow: ZeusEscrowBOT,
      token: MockERC20,
      initiator: HardhatEthersSigner,
      executor: HardhatEthersSigner,
      amount = tok(500),
      timeout = 3600
    ) {
      await token.connect(initiator).approve(await escrow.getAddress(), amount);
      await escrow.connect(initiator).depositAndCreateAgreement(executor.address, amount, timeout);
      return 1n; // first agreement
    }

    it("releases funds to executor and emits event", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const amount = tok(500);
      const proof = ethers.toUtf8Bytes("ipfs://QmProofCID");

      const id = await createAgreement(escrow, token, initiator, executor, amount);
      const beforeBalance = await token.balanceOf(executor.address);

      await expect(escrow.connect(executor).confirmExecution(id, proof))
        .to.emit(escrow, "ExecutionConfirmed")
        .withArgs(id, executor.address, amount, proof);

      expect(await token.balanceOf(executor.address)).to.equal(beforeBalance + amount);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);

      const ag = await escrow.getAgreement(id);
      expect(ag.status).to.equal(1); // Completed
      // Proof is stored on-chain in the struct (not just emitted)
      expect(ag.proof).to.equal(ethers.hexlify(proof));
    });

    it("accepts empty proof bytes", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const id = await createAgreement(escrow, token, initiator, executor);
      await expect(escrow.connect(executor).confirmExecution(id, "0x")).to.not.be.reverted;
    });

    it("reverts if called by non-executor", async function () {
      const { escrow, token, initiator, executor, other } = await deploy();
      const id = await createAgreement(escrow, token, initiator, executor);
      await expect(
        escrow.connect(other).confirmExecution(id, "0x")
      ).to.be.revertedWith("ZeusEscrowBOT: only executor can confirm");
    });

    it("reverts if called by initiator", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const id = await createAgreement(escrow, token, initiator, executor);
      await expect(
        escrow.connect(initiator).confirmExecution(id, "0x")
      ).to.be.revertedWith("ZeusEscrowBOT: only executor can confirm");
    });

    it("reverts if agreement does not exist", async function () {
      const { escrow, executor } = await deploy();
      await expect(
        escrow.connect(executor).confirmExecution(999n, "0x")
      ).to.be.revertedWith("ZeusEscrowBOT: agreement does not exist");
    });

    it("reverts if agreement is already completed", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const id = await createAgreement(escrow, token, initiator, executor);
      await escrow.connect(executor).confirmExecution(id, "0x");
      await expect(
        escrow.connect(executor).confirmExecution(id, "0x")
      ).to.be.revertedWith("ZeusEscrowBOT: agreement not active");
    });
  });

  // ── requestRefund ─────────────────────────────────────────────────────────
  describe("requestRefund", function () {
    async function createAgreement(
      escrow: ZeusEscrowBOT,
      token: MockERC20,
      initiator: HardhatEthersSigner,
      executor: HardhatEthersSigner,
      timeout = 3600
    ) {
      const amount = tok(500);
      await token.connect(initiator).approve(await escrow.getAddress(), amount);
      await escrow.connect(initiator).depositAndCreateAgreement(executor.address, amount, timeout);
      return { id: 1n, amount };
    }

    it("returns funds to initiator after timeout and emits event", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const timeout = 3600;
      const { id, amount } = await createAgreement(escrow, token, initiator, executor, timeout);
      const beforeBalance = await token.balanceOf(initiator.address);

      await advanceTime(timeout);

      await expect(escrow.connect(initiator).requestRefund(id))
        .to.emit(escrow, "RefundIssued")
        .withArgs(id, initiator.address, amount);

      expect(await token.balanceOf(initiator.address)).to.equal(beforeBalance + amount);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);

      const ag = await escrow.getAgreement(id);
      expect(ag.status).to.equal(2); // Refunded
    });

    it("reverts if timeout has not elapsed", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const { id } = await createAgreement(escrow, token, initiator, executor, 3600);

      await advanceTime(1800); // only half the timeout

      await expect(
        escrow.connect(initiator).requestRefund(id)
      ).to.be.revertedWith("ZeusEscrowBOT: timeout has not elapsed yet");
    });

    it("reverts if called by non-initiator", async function () {
      const { escrow, token, initiator, executor, other } = await deploy();
      const timeout = 3600;
      const { id } = await createAgreement(escrow, token, initiator, executor, timeout);
      await advanceTime(timeout);

      await expect(
        escrow.connect(other).requestRefund(id)
      ).to.be.revertedWith("ZeusEscrowBOT: only initiator can request refund");
    });

    it("reverts if called by executor", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const timeout = 3600;
      const { id } = await createAgreement(escrow, token, initiator, executor, timeout);
      await advanceTime(timeout);

      await expect(
        escrow.connect(executor).requestRefund(id)
      ).to.be.revertedWith("ZeusEscrowBOT: only initiator can request refund");
    });

    it("reverts if agreement does not exist", async function () {
      const { escrow, initiator } = await deploy();
      await expect(
        escrow.connect(initiator).requestRefund(999n)
      ).to.be.revertedWith("ZeusEscrowBOT: agreement does not exist");
    });

    it("reverts if agreement is already refunded", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const timeout = 3600;
      const { id } = await createAgreement(escrow, token, initiator, executor, timeout);
      await advanceTime(timeout);

      await escrow.connect(initiator).requestRefund(id);
      await expect(
        escrow.connect(initiator).requestRefund(id)
      ).to.be.revertedWith("ZeusEscrowBOT: agreement not active");
    });

    it("reverts if executor already confirmed (agreement completed)", async function () {
      const { escrow, token, initiator, executor } = await deploy();
      const timeout = 3600;
      const { id } = await createAgreement(escrow, token, initiator, executor, timeout);

      await escrow.connect(executor).confirmExecution(id, "0x");
      await advanceTime(timeout);

      await expect(
        escrow.connect(initiator).requestRefund(id)
      ).to.be.revertedWith("ZeusEscrowBOT: agreement not active");
    });
  });

  // ── getAgreement ──────────────────────────────────────────────────────────
  describe("getAgreement", function () {
    it("reverts for non-existent agreement", async function () {
      const { escrow } = await deploy();
      await expect(escrow.getAgreement(42n)).to.be.revertedWith(
        "ZeusEscrowBOT: agreement does not exist"
      );
    });
  });
});
