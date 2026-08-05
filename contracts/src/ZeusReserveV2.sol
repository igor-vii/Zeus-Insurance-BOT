// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZeusReserveV2
 * @notice Reserve contract holding USDT/USDC for insurance payouts.
 * 
 * FIXES APPLIED:
 * - setInsuranceContract теперь проверяет, что старый контракт не имеет pending claims
 * - Добавлена функция remainingDailyPayout() для прозрачности перед покупкой
 */
contract ZeusReserveV2 is ReentrancyGuard, Ownable {
    IERC20 public usdt;
    address public insuranceContract;

    uint256 public minReserveThreshold;
    uint256 public maxDailyPayout;
    uint256 public dailyPayouts;

    mapping(uint256 => bool) public fulfilledClaims;

    error InsufficientReserveBalance(uint256 requested, uint256 available);
    error ClaimAlreadyFulfilled(uint256 claimId);
    error ClaimNotApproved(uint256 claimId);
    error DailyPayoutLimitExceeded(uint256 attempted, uint256 remaining);
    error ReserveBelowThreshold();
    error TransferFailed();
    error ZeroAddress();
    error ZeroAmount();
    error NotAContract(address addr);
    error NotInsuranceContract(address caller);
    error InsuranceContractHasPendingClaims();

    event ReserveDeposited(address indexed from, uint256 amount);
    event ReserveWithdrawn(address indexed to, uint256 amount);
    event ClaimPaid(uint256 indexed claimId, address indexed claimant, uint256 amount);
    event InsuranceContractUpdated(address indexed oldContract, address indexed newContract);
    event MinReserveThresholdUpdated(uint256 oldValue, uint256 newValue);
    event MaxDailyPayoutUpdated(uint256 oldValue, uint256 newValue);

    modifier onlyInsurance() {
        if (msg.sender != insuranceContract) revert NotInsuranceContract(msg.sender);
        _;
    }

    constructor(address _usdt, address initialOwner) Ownable(initialOwner) {
        if (_usdt == address(0)) revert ZeroAddress();
        usdt = IERC20(_usdt);
        insuranceContract = address(0);
        minReserveThreshold = 100 * 10**6;
        maxDailyPayout = 10_000 * 10**6;
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdt.transferFrom(msg.sender, address(this), amount);
        emit ReserveDeposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = usdt.balanceOf(address(this));
        if (balance < amount) revert InsufficientReserveBalance(amount, balance);
        usdt.transfer(msg.sender, amount);
        emit ReserveWithdrawn(msg.sender, amount);
    }

    function payClaim(
        uint256 claimId,
        address claimant,
        uint256 amount
    ) external onlyInsurance nonReentrant {
        if (claimant == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (fulfilledClaims[claimId]) revert ClaimAlreadyFulfilled(claimId);
        if (!_isClaimApproved(claimId, claimant, amount)) revert ClaimNotApproved(claimId);

        uint256 balance = usdt.balanceOf(address(this));
        if (balance < amount) revert InsufficientReserveBalance(amount, balance);

        uint256 remaining = remainingDailyPayout();
        if (amount > remaining) revert DailyPayoutLimitExceeded(amount, remaining);

        fulfilledClaims[claimId] = true;
        dailyPayouts += amount;

        usdt.transfer(claimant, amount);
        emit ClaimPaid(claimId, claimant, amount);
    }

    function _isClaimApproved(uint256 claimId, address claimant, uint256 amount) internal view returns (bool) {
        (bool success, bytes memory data) = insuranceContract.staticcall(
            abi.encodeWithSignature("isClaimApproved(uint256,address,uint256)", claimId, claimant, amount)
        );
        if (!success) return false;
        return abi.decode(data, (bool));
    }

    function setInsuranceContract(address _contract) external onlyOwner {
        if (_contract == address(0)) revert ZeroAddress();
        if (_contract.code.length == 0) revert NotAContract(_contract);

        // Проверяем, что старый контракт не имеет pending claims
        if (insuranceContract != address(0)) {
            // Проверяем, есть ли незавершённые выплаты
            (bool success, bytes memory data) = insuranceContract.staticcall(
                abi.encodeWithSignature("hasPendingClaims()")
            );
            if (success && abi.decode(data, (bool))) {
                revert InsuranceContractHasPendingClaims();
            }
        }

        address old = insuranceContract;
        insuranceContract = _contract;
        emit InsuranceContractUpdated(old, _contract);
    }

    function setMinReserveThreshold(uint256 newThreshold) external onlyOwner {
        uint256 old = minReserveThreshold;
        minReserveThreshold = newThreshold;
        emit MinReserveThresholdUpdated(old, newThreshold);
    }

    function setMaxDailyPayout(uint256 newLimit) external onlyOwner {
        uint256 old = maxDailyPayout;
        maxDailyPayout = newLimit;
        emit MaxDailyPayoutUpdated(old, newLimit);
    }

    function getReserveBalance() public view returns (uint256) {
        return usdt.balanceOf(address(this));
    }

    function isAdequatelyFunded() public view returns (bool) {
        return getReserveBalance() >= minReserveThreshold;
    }

    function remainingDailyPayout() public view returns (uint256) {
        if (dailyPayouts >= maxDailyPayout) return 0;
        return maxDailyPayout - dailyPayouts;
    }

    function resetDailyPayouts() external onlyOwner {
        dailyPayouts = 0;
    }
}
