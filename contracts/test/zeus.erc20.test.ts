import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeusInsuranceV2, ZeusReserveV2, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseUnits } from "ethers";

describe("ZeusInsuranceV2 with ERC20", function () {
  let insurance: ZeusInsuranceV2;
  let reserve: ZeusReserveV2;
  let mockUSDC: MockERC20;
  let admin: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seller: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

  beforeEach(async function () {
    [admin, buyer, seller] = await ethers.getSigners();

    // Deploy mock token
    const TokenFactory = await ethers.getContractFactory("MockERC20");
    mockUSDC = await TokenFactory.deploy("Mock USDC", "USDC", 6);
    await mockUSDC.waitForDeployment();

    // Mint tokens to buyer and admin
    await mockUSDC.mint(buyer.address, usdc(10_000));
    await mockUSDC.mint(admin.address, usdc(100_000));

    // Deploy reserve
    const ReserveFactory = await ethers.getContractFactory("ZeusReserveV2");
    reserve = await ReserveFactory.deploy(
      await mockUSDC.getAddress(),
      admin.address
    );
    await reserve.waitForDeployment();

    // Deploy insurance with ERC20
    const InsFactory = await ethers.getContractFactory("ZeusInsuranceV2");
    insurance = await InsFactory.deploy(
      await mockUSDC.getAddress(),
      await reserve.getAddress()
    );
    await insurance.waitForDeployment();

    // Wire reserve → insurance
    await reserve.setInsuranceContract(await insurance.getAddress());

    // Fund reserve
    await mockUSDC.connect(admin).approve(await reserve.getAddress(), usdc(100_000));
    await reserve.connect(admin).deposit(usdc(100_000));

    // Raise daily limit
    await reserve.setMaxDailyPayout(usdc(1_000_000));
    await reserve.setMinReserveThreshold(0n);
  });

  it("should buy policy with ERC20 premium", async function () {
    const amount = usdc(1000);
    const premium = usdc(50);

    // Approve premium
    await mockUSDC.connect(buyer).approve(await insurance.getAddress(), premium);

    // Buy policy
    const tx = await insurance.connect(buyer).buyPolicy(
      seller.address,
      amount,
      3600, // 1 hour timeout
      1,    // 1 retry
      premium
    );

    await expect(tx).to.emit(insurance, "PolicyCreated");

    // Verify policy was created
    const policyId = await insurance.nextPolicyId();
    expect(policyId).to.equal(1n);

    // Verify premium was transferred to reserve
    const reserveBalance = await mockUSDC.balanceOf(await reserve.getAddress());
    expect(reserveBalance).to.equal(usdc(100_050)); // 100_000 initial + 50 premium
  });

  it("should claim payout after timeout with ERC20", async function () {
    const amount = usdc(1000);
    const premium = usdc(50);

    // Approve and buy policy
    await mockUSDC.connect(buyer).approve(await insurance.getAddress(), premium);
    await insurance.connect(buyer).buyPolicy(
      seller.address,
      amount,
      60, // 1 minute timeout
      1,
      premium
    );

    // Advance time past retryDeadline
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);

    // Claim payout
    const buyerBefore = await mockUSDC.balanceOf(buyer.address);
    await insurance.connect(buyer).claimPayout(0n);
    const buyerAfter = await mockUSDC.balanceOf(buyer.address);

    // Buyer should receive the insured amount
    expect(buyerAfter - buyerBefore).to.equal(amount);
  });

  it("should revert buyPolicy without sufficient approve", async function () {
    const amount = usdc(1000);
    const premium = usdc(50);

    // Do NOT approve premium

    // Buy should fail
    await expect(
      insurance.connect(buyer).buyPolicy(
        seller.address,
        amount,
        3600,
        1,
        premium
      )
    ).to.be.revertedWithCustomError(insurance, "PremiumTransferFailed");
  });

  it("should reject native token payment (msg.value > 0)", async function () {
    const amount = usdc(1000);
    const premium = usdc(50);

    await mockUSDC.connect(buyer).approve(await insurance.getAddress(), premium);

    // Try to send ETH with the transaction
    await expect(
      insurance.connect(buyer).buyPolicy(
        seller.address,
        amount,
        3600,
        1,
        premium,
        { value: ethers.parseEther("0.1") } // Send ETH
      )
    ).to.be.revertedWithCustomError(insurance, "NativePaymentNotAccepted");
  });
});
