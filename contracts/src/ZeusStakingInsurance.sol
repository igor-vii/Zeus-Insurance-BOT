// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IInsuranceContract.sol";
import "./WatcherRegistry.sol";
import "./ZeusReserveV2.sol";

/**
 * @title ZeusStakingInsurance v2 — First Loss Model
 * @notice Provides slashing protection for stakers with partial coverage (first-loss),
 *         network-risk-based pricing, and collateral requirements for emerging/unproven networks.
 *
 * Key changes from v1:
 * - coveredAmount = stakedAmount * firstLossPercent / 10000 (not 100%)
 * - Collateral required for Emerging/Unproven networks
 * - claimSlashing pays min(actualLoss, coveredAmount)
 * - Network-specific configuration via configureForNetwork()
 */
contract ZeusStakingInsurance is IInsuranceContract, ReentrancyGuard, Ownable, Pausable {

    // ── Types ─────────────────────────────────────────────────────────────────

    enum NetworkRisk { Proven, Emerging, Unproven }

    struct StakePosition {
        address staker;
        bytes32 validatorPubkey;
        uint256 stakedAmount;
        uint256 coveredAmount;      // stakedAmount * firstLossPercent / 10000
        uint256 premium;
        uint256 collateral;         // only for Emerging/Unproven
        uint256 startTime;
        uint256 duration;
        bool active;
        bool claimed;
    }

    struct NetworkConfig {
        uint256 firstLossPercent;   // basis points (e.g. 200 = 2%)
        uint256 basePremiumBps;     // basis points (e.g. 4 = 0.04%)
        NetworkRisk risk;
        uint256 collateralRatio;    // basis points (e.g. 100 = 1x coveredAmount)
    }

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20 public immutable usdt;
    ZeusReserveV2 public immutable reserve;
    WatcherRegistry public immutable registry;

    uint256 public firstLossPercent;
    uint256 public basePremiumBps;
    NetworkRisk public networkRisk;
    uint256 public collateralRatio;

    uint256 public nextPositionId;
    mapping(uint256 => StakePosition) public positions;
    mapping(address => uint256[]) public stakerPositions;

    // Claim tracking for IInsuranceContract
    mapping(uint256 => bool) public approvedClaims;
    mapping(uint256 => bool) public fulfilledClaims;
    uint256 public nextClaimId;

    // ── Events ────────────────────────────────────────────────────────────────

    event CoverPurchased(
        uint256 indexed positionId,
        address indexed staker,
        address indexed validator,
        uint256 stakedAmount,
        uint256 coveredAmount,
        uint256 premium,
        uint256 collateral
    );

    event SlashingClaimed(
        uint256 indexed positionId,
        address indexed staker,
        uint256 actualLoss,
        uint256 payout
    );

    event CollateralWithdrawn(
        uint256 indexed positionId,
        address indexed staker,
        uint256 amount
    );

    event NetworkConfigured(
        uint256 firstLossPercent,
        uint256 basePremiumBps,
        NetworkRisk risk,
        uint256 collateralRatio
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _usdt, address _reserve, address _registry) Ownable(msg.sender) {
        require(_usdt != address(0), "Invalid USDT");
        require(_reserve != address(0), "Invalid reserve");
        require(_registry != address(0), "Invalid registry");

        usdt = IERC20(_usdt);
        reserve = ZeusReserveV2(_reserve);
        registry = WatcherRegistry(_registry);

        // Default: Proven network (Ethereum-like)
        firstLossPercent = 200;    // 2%
        basePremiumBps = 4;        // 0.04%
        networkRisk = NetworkRisk.Proven;
        collateralRatio = 0;       // no collateral for Proven
    }

    // ── Owner: Network Configuration ──────────────────────────────────────────

    /**
     * @notice Configure parameters for the current network.
     * @param _firstLossPercent  Coverage percentage in bps (e.g. 200 = 2%)
     * @param _basePremiumBps    Base premium in bps (e.g. 4 = 0.04%)
     * @param _risk              Network risk level
     * @param _collateralRatio   Collateral ratio in bps (e.g. 100 = 1x coveredAmount)
     */
    function configureForNetwork(
        uint256 _firstLossPercent,
        uint256 _basePremiumBps,
        NetworkRisk _risk,
        uint256 _collateralRatio
    ) external onlyOwner {
        require(_firstLossPercent > 0 && _firstLossPercent <= 10000, "Invalid firstLossPercent");
        require(_basePremiumBps > 0 && _basePremiumBps <= 10000, "Invalid basePremiumBps");

        firstLossPercent = _firstLossPercent;
        basePremiumBps = _basePremiumBps;
        networkRisk = _risk;
        collateralRatio = _collateralRatio;

        emit NetworkConfigured(_firstLossPercent, _basePremiumBps, _risk, _collateralRatio);
    }

    // ── Core: Buy Cover ───────────────────────────────────────────────────────

    /**
     * @notice Purchase slashing protection for a staked position.
     * @param validator   The validator address being staked on
     * @param stakedAmount The amount staked (in token base units)
     * @param duration     Coverage duration in seconds
     * @return positionId  The ID of the new position
     */
    function buyCover(
        bytes32 validatorPubkey,
        uint256 stakedAmount,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (uint256 positionId) {
        require(validatorPubkey != bytes32(0), "Invalid validator");
        require(stakedAmount > 0, "Amount must be positive");
        require(duration > 0, "Duration must be positive");

        // Calculate coverage (first-loss model)
        uint256 coveredAmount = (stakedAmount * firstLossPercent) / 10000;
        require(coveredAmount > 0, "Coverage too small");

        // Calculate premium
        uint256 premium = (coveredAmount * basePremiumBps) / 10000;
        require(premium > 0, "Premium too small");

        // Calculate collateral (only for Emerging/Unproven)
        uint256 collateral = 0;
        if (networkRisk != NetworkRisk.Proven) {
            collateral = (coveredAmount * collateralRatio) / 100;
        }

        // Transfer premium + collateral from staker
        uint256 totalPayment = premium + collateral;
        require(usdt.transferFrom(msg.sender, address(this), totalPayment), "Payment failed");

        // Forward premium to reserve
        require(usdt.transfer(address(reserve), premium), "Reserve funding failed");

        // Create position
        positionId = nextPositionId++;
        positions[positionId] = StakePosition({
            staker: msg.sender,
            validatorPubkey: validatorPubkey,
            stakedAmount: stakedAmount,
            coveredAmount: coveredAmount,
            premium: premium,
            collateral: collateral,
            startTime: block.timestamp,
            duration: duration,
            active: true,
            claimed: false
        });

        stakerPositions[msg.sender].push(positionId);

        emit CoverPurchased(positionId, msg.sender, validator, stakedAmount, coveredAmount, premium, collateral);
    }

    // ── Core: Claim Slashing ──────────────────────────────────────────────────

    /**
     * @notice Claim payout after a slashing event. Pays min(actualLoss, coveredAmount).
     * @param positionId  The position to claim against
     * @param actualLoss  The actual loss incurred from slashing
     */
    function claimSlashing(uint256 positionId, uint256 actualLoss) external nonReentrant {
        StakePosition storage pos = positions[positionId];
        require(pos.staker == msg.sender, "Not your position");
        require(pos.active, "Position not active");
        require(!pos.claimed, "Already claimed");
        require(block.timestamp <= pos.startTime + pos.duration, "Coverage expired");
        require(actualLoss > 0, "No loss to claim");

        // Verify slashing via WatcherRegistry quorum
        require(
            registry.hasQuorumReport(address(uint160(uint256(pos.validatorPubkey)))),
            "No quorum slashing report for this validator"
        );

        // Payout = min(actualLoss, coveredAmount)
        uint256 payout = actualLoss < pos.coveredAmount ? actualLoss : pos.coveredAmount;

        pos.claimed = true;
        pos.active = false;

        // Register claim with reserve
        uint256 claimId = nextClaimId++;
        approvedClaims[claimId] = true;

        // Pay from reserve
        reserve.payClaim(claimId, msg.sender, payout);

        emit SlashingClaimed(positionId, msg.sender, actualLoss, payout);
    }

    /**
     * @notice Claim slashing with full coveredAmount as loss (backward compatible).
     * @param positionId  The position to claim against
     */
    function claimSlashing(uint256 positionId) external nonReentrant {
        StakePosition storage pos = positions[positionId];
        require(pos.staker == msg.sender, "Not your position");
        require(pos.active, "Position not active");
        require(!pos.claimed, "Already claimed");
        require(block.timestamp <= pos.startTime + pos.duration, "Coverage expired");

        // Verify slashing via WatcherRegistry quorum
        require(
            registry.hasQuorumReport(address(uint160(uint256(pos.validatorPubkey)))),
            "No quorum slashing report for this validator"
        );

        // Full coveredAmount as payout
        uint256 payout = pos.coveredAmount;

        pos.claimed = true;
        pos.active = false;

        // Register claim with reserve
        uint256 claimId = nextClaimId++;
        approvedClaims[claimId] = true;

        // Pay from reserve
        reserve.payClaim(claimId, msg.sender, payout);

        emit SlashingClaimed(positionId, msg.sender, payout, payout);
    }


    // ── Collateral Withdrawal ─────────────────────────────────────────────────

    /**
     * @notice Withdraw collateral after coverage expires or is claimed.
     * @param positionId  The position to withdraw collateral from
     */
    function withdrawCollateral(uint256 positionId) external nonReentrant {
        StakePosition storage pos = positions[positionId];
        require(pos.staker == msg.sender, "Not your position");
        require(pos.collateral > 0, "No collateral");

        uint256 amount = pos.collateral;
        pos.collateral = 0;

        // Can withdraw if: expired OR claimed (coverage resolved)
        require(
            block.timestamp > pos.startTime + pos.duration || pos.claimed,
            "Coverage still active"
        );

        require(usdt.transfer(msg.sender, amount), "Transfer failed");

        emit CollateralWithdrawn(positionId, msg.sender, amount);
    }

    // ── View Functions ────────────────────────────────────────────────────────

    /**
     * @notice Preview coverage details without purchasing.
     * @param stakedAmount  The amount that would be staked
     * @return coveredAmount  The amount that would be covered
     * @return premium        The premium that would be charged
     * @return collateral     The collateral that would be required
     */
    function previewCover(uint256 stakedAmount) external view returns (
        uint256 coveredAmount,
        uint256 premium,
        uint256 collateral
    ) {
        coveredAmount = (stakedAmount * firstLossPercent) / 10000;
        premium = (coveredAmount * basePremiumBps) / 10000;
        collateral = 0;
        if (networkRisk != NetworkRisk.Proven) {
            collateral = (coveredAmount * collateralRatio) / 100;
        }
    }

    /**
     * @notice Get current network configuration.
     */
    function getNetworkConfig() external view returns (
        uint256 _firstLossPercent,
        uint256 _basePremiumBps,
        NetworkRisk _risk,
        uint256 _collateralRatio
    ) {
        return (firstLossPercent, basePremiumBps, networkRisk, collateralRatio);
    }

    /**
     * @notice Get all position IDs for a staker.
     */
    function getStakerPositions(address staker) external view returns (uint256[] memory) {
        return stakerPositions[staker];
    }

    /**
     * @notice Get position details.
     */
    function getPosition(uint256 positionId) external view returns (StakePosition memory) {
        return positions[positionId];
    }

    // ── IInsuranceContract (for the dedicated reserve) ────────────────────────

    function isClaimApproved(
        uint256 claimId,
        address /* claimant */,
        uint256 /* amount */
    ) external view override returns (bool) {
        return approvedClaims[claimId] && !fulfilledClaims[claimId];
    }

    function markClaimFulfilled(uint256 claimId) external override {
        require(msg.sender == address(reserve), "Only reserve");
        fulfilledClaims[claimId] = true;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Emergency withdrawal of excess funds (above reserve obligations).
     */
    function emergencyWithdraw(uint256 amount) external onlyOwner {
        require(usdt.transfer(owner(), amount), "Transfer failed");
    }
}
