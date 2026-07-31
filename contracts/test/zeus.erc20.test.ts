import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Signer, Contract } from "ethers";

describe("ZeusInsuranceV2 with ERC20", () => {
  let admin: Signer, buyer: Signer, seller: Signer, oracle: Signer;
  let insurance: Contract;
  let mockUSDC: Contract;

  const XLAYER_CHAIN_ID = 196;
  const DEFAULT_HARDHAT_CHAIN_ID = 31337;

  before(async () => {
    [admin, buyer, seller, oracle] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // 1. Деплоим мок-токен
    const TokenFactory = await ethers.getContractFactory("MockERC20");
    mockUSDC = await TokenFactory.deploy();
    await mockUSDC.waitForDeployment();

    // 2. Деплоим страховку с привязкой к ERC20 (вместо ZeroAddress)
    const InsFactory = await ethers.getContractFactory("ZeusInsuranceV2");
    insurance = await InsFactory.deploy(await admin.getAddress(), await mockUSDC.getAddress());
    await insurance.waitForDeployment();

    // 3. Выдаем права оракулу на выплату страховки
    await insurance.grantRole(await insurance.CLAIM_EVALUATOR_ROLE(), await oracle.getAddress());

    // 4. Эмулируем X Layer сеть
    await network.provider.send("hardhat_setChainId", [ethers.toBeHex(XLAYER_CHAIN_ID)]);
  });

  afterEach(async () => {
    // Возвращаем дефолтный chainId, чтобы не сломать другие тесты
    await network.provider.send("hardhat_setChainId", [ethers.toBeHex(DEFAULT_HARDHAT_CHAIN_ID)]);
  });

  it("3.1 should revert when paying with native token (msg.value > 0)", async () => {
    const amount = ethers.parseUnits("1000", 18);
    // Получаем точную премию с контракта
    const premium = await insurance.quote(0x1F, await buyer.getAddress(), amount);
    
    // Даем покупателю токены
    await mockUSDC.mint(await buyer.getAddress(), amount + premium);
    await mockUSDC.connect(buyer).approve(await insurance.getAddress(), premium);

    // Пытаемся купить с нативным value -> должно упасть
    await expect(
      insurance.connect(buyer).buyPolicy(
        await seller.getAddress(),
        amount,
        0x1F, // All-inclusive mask
        3600,
        "",
        { value: premium } // Ошибка: передаем нативный токен
      )
    ).to.be.revertedWith("Zeus: no native expected");
  });

  it("3.2 should buy policy with ERC20 and claim payout", async () => {
    const amount = ethers.parseUnits("1000", 18);
    const premium = await insurance.quote(0x1F, await buyer.getAddress(), amount);

    // 1. Финансирование: даем покупателю токены на премию
    await mockUSDC.mint(await buyer.getAddress(), premium);
    
    // 2. Approve: покупатель разрешает контракту списать премию
    await mockUSDC.connect(buyer).approve(await insurance.getAddress(), premium);

    // 3. Покупка полиса (value: 0!)
    const tx = await insurance.connect(buyer).buyPolicy(
      await seller.getAddress(),
      amount,
      0x1F,
      3600,
      "ipfs://erc20-test"
    );
    await expect(tx).to.emit(insurance, "PolicyCreated");
    
    // Проверяем, что контракт действительно получил премию в ERC20
    const contractBal = await mockUSDC.balanceOf(await insurance.getAddress());
    expect(contractBal).to.equal(premium);

    // 4. Имитируем наличие резерва на контракте для выплаты (например, добавил админ)
    await mockUSDC.mint(await insurance.getAddress(), amount);

    const policyId = await insurance.currentPolicyId();
    const buyerBalBefore = await mockUSDC.balanceOf(await buyer.getAddress());

    // 5. Оракул вызывает claim
    await insurance.connect(oracle).claim(policyId, await buyer.getAddress(), amount);

    const buyerBalAfter = await mockUSDC.balanceOf(await buyer.getAddress());
    
    // Проверяем, что покупатель получил выплату 1000 USDC
    expect(buyerBalAfter - buyerBalBefore).to.equal(amount);
  });

  it("3.3 should revert if no approve before buyPolicy", async () => {
    const amount = ethers.parseUnits("1000", 18);
    const premium = await insurance.quote(0x1F, await buyer.getAddress(), amount);
    
    // Даем покупателю токены, но НЕ делаем approve
    await mockUSDC.mint(await buyer.getAddress(), premium);

    // Покупка должна упасть с ошибкой SafeERC20: insufficient allowance
    await expect(
      insurance.connect(buyer).buyPolicy(
        await seller.getAddress(),
        amount,
        0x1F,
        3600,
        "",
        { value: 0 }
      )
    ).to.be.revertedWith("ERC20: insufficient allowance"); // В SafeERC20 это кастомная ошибка, но текст совпадает
  });
});
