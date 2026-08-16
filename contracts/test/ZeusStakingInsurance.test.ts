import { expect } from "chai";
import { ethers } from "hardhat";
import { parseUnits, keccak256, toUtf8Bytes } from "ethers";

const D = 6;
const usdc = (n: number) => parseUnits(String(n), D);
const VKEY = keccak256(toUtf8Bytes("validator-pubkey-1"));

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

  async function buyCover(ctx: Awaited<ReturnType<typeof deploy>>, stake = 1000, term = 30 * 86400) {
    const tx = await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(stake), term);
    const rc = await tx.wait();
    return 0n; // positionId 0 in tests (first position)
  }

  it("buys cover, stores position, transfers premium to reserve", async () => {
    const ctx = await deploy();
    const before = await ctx.token.balanceOf(await ctx.reserve.getAddress());
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 30 * 86400);
    const after = await ctx.token.balanceOf(await ctx.reserve.getAddress());
    expect(after - before).to.equal(usdc(2));

    const p = await ctx.insurance.getPosition(0n);
    expect(p.owner).to.equal(ctx.staker.address);
    expect(p.coveredAmount).to.equal(usdc(1000));
    expect(p.status).to.equal(0);
  });

  it("reverts buyCover on bad inputs", async () => {
    const ctx = await deploy();
    await expect(ctx.insurance.connect(ctx.staker).buyCover(ethers.ZeroHash, usdc(1), 86400))
      .to.be.revertedWithCustomError(ctx.insurance, "InvalidValidatorKey");
    await expect(ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1), 60))
      .to.be.revertedWithCustomError(ctx.insurance, "InvalidTerm");
    await expect(ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1), 86400))
      .to.be.revertedWithCustomError(ctx.insurance, "InvalidPremium");
  });

  it("reverts claim without watcher confirmation", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 30 * 86400);
    await expect(ctx.insurance.connect(ctx.staker).claimSlashing(0n))
      .to.be.revertedWithCustomError(ctx.insurance, "SlashingNotConfirmed");
  });

  it("pays out after 2-watchers slashing confirmation", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 30 * 86400);
    const eventId = await ctx.insurance.eventIdFor(0n);

    await ctx.registry.connect(ctx.w1).submitObservation(eventId, 1);
    await ctx.registry.connect(ctx.w2).submitObservation(eventId, 1);

    const before = await ctx.token.balanceOf(ctx.staker.address);
    await ctx.insurance.connect(ctx.staker).claimSlashing(0n);
    const after = await ctx.token.balanceOf(ctx.staker.address);
    expect(after - before).to.equal(usdc(1000));

    const p = await ctx.insurance.getPosition(0n);
    expect(p.status).to.equal(1); // Claimed
  });

  it("reverts double claim", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 30 * 86400);
    const eventId = await ctx.insurance.eventIdFor(0n);
    await ctx.registry.connect(ctx.w1).submitObservation(eventId, 1);
    await ctx.registry.connect(ctx.w2).submitObservation(eventId, 1);
    await ctx.insurance.connect(ctx.staker).claimSlashing(0n);
    await expect(ctx.insurance.connect(ctx.staker).claimSlashing(0n))
      .to.be.revertedWithCustomError(ctx.insurance, "PositionNotActive");
  });

  it("expires coverage after term; claim reverts", async () => {
    const ctx = await deploy();
    await ctx.insurance.connect(ctx.staker).buyCover(VKEY, usdc(1000), 86400);
    await advanceTime(86401);
    await expect(ctx.insurance.connect(ctx.staker).claimSlashing(0n))
      .to.be.revertedWithCustomError(ctx.insurance, "CoverageExpired");
    await ctx.insurance.expirePosition(0n);
    const p = await ctx.insurance.getPosition(0n);
    expect(p.status).to.equal(2); // Expired
  });
});
