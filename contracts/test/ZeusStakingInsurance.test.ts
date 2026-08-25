import { expect } from "chai";
import { ethers } from "hardhat";
import { parseUnits, keccak256, toUtf8Bytes, AbiCoder } from "ethers";

const D = 6;
const usdc = (n: number) => parseUnits(String(n), D);
const VKEY = keccak256(toUtf8Bytes("validator-pubkey-1"));

// First Loss params (default: Proven network)
const FIRST_LOSS_PERCENT = 200n; // 2%
const BASE_PREMIUM_BPS = 4n;     // 0.04%

function computeCovered(stake: bigint) {
  return stake * FIRST_LOSS_PERCENT / 10000n;
}
function computePremium(covered: bigint) {
  return covered * BASE_PREMIUM_BPS / 10000n;
}

async function advanceTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("ZeusStakingInsurance", function () {
  async function deploy() {
    const [owner, staker, w1, w2, other] = await ethers.getSigners();

    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USDC", "USDC", D);
    await token.waitForDeployment();

    const registry = await (await ethers.getContractFactory("WatcherRegistry")).deploy(2);
    await registry.waitForDeployment();
    await registry.addWatcher(w1.address);
    await registry.addWatcher(w2.address);

    const reserve = await (await ethers.getContractFactory("ZeusReserveV2")).deploy(
      await token.getAddress(), owner.address
    );
    await reserve.waitForDeployment();
    await reserve.setMaxDailyPayout(usdc(10_000_000));
    await reserve.setMinReserveThreshold(0n);

    const insurance = await (await ethers.getContractFactory("ZeusStakingInsurance")).deploy(
      await token.getAddress(), await reserve.getAddress(), await registry.getAddress()
    );
    await insurance.waitForDeployment();
    await reserve.setInsuranceContract(await insurance.getAddress());

    await token.mint(owner.address, usdc(1_000_000));
    await token.connect(owner).approve(await reserve.getAddress(), usdc(100_000));
    await reserve.connect(owner).deposit(usdc(100_000));

    await token.mint(staker.address, usdc(10_000));
    await token.connect(staker).approve(await insurance.getAddress(), usdc(10_000));

    return { token, registry, reserve, insurance, owner, staker, w1, w2, other };
  }

  it("buys cover, stores position, transfers premium to reserve", async () => {
    const ctx = await deploy();
    const stake = usdc(1000);
    const covered = computeCovered(stake);
    const premium = computePremium(covered);

    const before = await ctx.token.balanceOf(await ctx.reserve.getAddress());
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, stake, 30 * 86400);
    const after = await ctx.token.balanceOf(await ctx.reserve.getAddress());
    expect(after - before).to.equal(premium);

    const p = await ctx.insurance.getPosition(0n);
    expect(p.staker).to.equal(ctx.staker.address);
    expect(p.coveredAmount).to.equal(covered);
    expect(p.active).to.equal(true);
    expect(p.claimed).to.equal(false);
  });

  it("reverts buyCover on bad inputs", async () => {
    const ctx = await deploy();
    // Zero validator pubkey
    await expect(ctx.insurance.connect(ctx.staker).buyCover(ethers.ZeroHash, usdc(1), 86400))
      .to.be.revertedWith("Invalid validator pubkey");
    // Zero amount
    await expect(ctx.insurance.connect(ctx.staker).buyCover(VKEY, 0n, 86400))
      .to.be.revertedWith("Amount must be positive");
    // Zero duration
    await expect(ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1), 0))
      .to.be.revertedWith("Duration must be positive");
  });

  it("reverts claim without watcher confirmation", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 30 * 86400);
    await expect(ctx.insurance.connect(ctx.staker).claimSlashing(0n))
      .to.be.revertedWith("No quorum slashing report for this validator");
  });

  it("pays out after 2-watchers slashing confirmation", async () => {
    const ctx = await deploy();
    const stake = usdc(1000);
    const covered = computeCovered(stake);

    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, stake, 30 * 86400);

    // Generate eventId = keccak256(abi.encode(positionId))
    const eventId = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256"], [0n]));

    await ctx.registry.connect(ctx.w1).submitObservation(eventId, 1);
    await ctx.registry.connect(ctx.w2).submitObservation(eventId, 1);

    const before = await ctx.token.balanceOf(ctx.staker.address);
    await ctx.insurance.connect(ctx.staker).claimSlashing(0n);
    const after = await ctx.token.balanceOf(ctx.staker.address);
    expect(after - before).to.equal(covered);

    const p = await ctx.insurance.getPosition(0n);
    expect(p.claimed).to.equal(true);
    expect(p.active).to.equal(false);
  });

  it("reverts double claim", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 30 * 86400);
    const eventId = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256"], [0n]));
    await ctx.registry.connect(ctx.w1).submitObservation(eventId, 1);
    await ctx.registry.connect(ctx.w2).submitObservation(eventId, 1);
    await ctx.insurance.connect(ctx.staker).claimSlashing(0n);
    await expect(ctx.insurance.connect(ctx.staker).claimSlashing(0n))
      .to.be.revertedWith("Position not active");
  });

  it("expires coverage after term; claim reverts", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 86400);
    await advanceTime(86401);
    await expect(ctx.insurance.connect(ctx.staker).claimSlashing(0n))
      .to.be.revertedWith("Coverage expired");
  });

  it("previewCover returns correct values", async () => {
    const ctx = await deploy();
    const stake = usdc(1000);
    const covered = computeCovered(stake);
    const premium = computePremium(covered);

    const result = await ctx.insurance.previewCover(stake);
    expect(result.coveredAmount).to.equal(covered);
    expect(result.premium).to.equal(premium);
    expect(result.collateral).to.equal(0n); // Proven network = no collateral
  });

  it("getNetworkConfig returns defaults", async () => {
    const ctx = await deploy();
    const config = await ctx.insurance.getNetworkConfig();
    expect(config._firstLossPercent).to.equal(200n);
    expect(config._basePremiumBps).to.equal(4n);
    expect(config._risk).to.equal(0n); // Proven
    expect(config._collateralRatio).to.equal(0n);
  });
});
