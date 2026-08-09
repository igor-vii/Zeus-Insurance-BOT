// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./WatcherRegistry.sol";
import "./ZeusReserveV2.sol";
import "./interfaces/IInsuranceContract.sol";

/**
 * @title ZeusStakingInsurance
 * @notice Phase-1 product module: slashing coverage for staking positions.
 *         First product built on the shared WatcherRegistry oracle
 *         (Trust Operating Layer) instead of an embedded oracle.
 *
 * @dev Uses a DEDICATED ZeusReserveV2 instance as its vault (the reserve
 *      supports a single insurance contract; multi-vault Treasury = phase 2).
 *
 *      Flow:
 *        1. buyCover(validatorKey, stakedAmount, termSeconds, premium)
 *        2. consensus-watchers detect slashing → WatcherRegistry quorum
 *        3. claimSlashing(positionId) → reserve.payClaim(...)
 */
contract ZeusStakingInsurance is IInsuranceContract, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ── Errors ───────────────────────────────────────────────────────────────
    error InvalidUSDTAddress();
    error InvalidReserveAddress();
    error InvalidRegistryAddress();
    error InvalidValidatorKey();
    error InvalidAmount();
    error InvalidTerm();
    error InvalidPremium();
    error PositionDoesNotExist();
    error NotPositionOwner();
    error PositionNotActive();
    error NotExpiredYet();
    error CoverageExpired();
    error SlashingNotConfirmed();
    error OnlyReserveCanCall();

    // ── Types ─────────────────────────────────────────────────────────────────
    enum PositionStatus { Active, Claimed, Expired }

    struct StakePosition {
        bytes32 validatorKey;   // keccak256(validator pubkey)
        address owner;
        uint256 stakedAmount;
        uint256 coveredAmount;  // v1: full coverage, cap = stake
        uint256 premium;
        uint256 start;
        uint256 expiry;
        PositionStatus status;
    }

    // ── State ────────────────────────────────────────────────────────────────
    IERC20 public usdt;
    ZeusReserveV2 public reserve;   // dedicated instance
    WatcherRegistry public registry;

    mapping(uint256 => StakePosition) public positions;
    mapping(uint256 => bool) public claimFulfilled;
    uint256 public nextPositionId;

    uint256 public constant MIN_TERM = 1 days;
    uint256 public constant MAX_TERM = 365 days;

    // ── Events ────────────────────────────────────────────────────────────────
    event CoverBought(
        uint256 indexed positionId, bytes32 indexed validatorKey, address indexed owner,
        uint256 coveredAmount, uint256 premium, uint256 expiry
    );
    event SlashingClaimed(uint256 indexed positionId, uint256 amount);
    event CoverExpired(uint256 indexed positionId);

    constructor(address _usdt, address _reserve, address _registry) Ownable(msg.sender) {
        if (_usdt == address(0)) revert InvalidUSDTAddress();
        if (_reserve == address(0)) revert InvalidReserveAddress();
        if (_registry == address(0)) revert InvalidRegistryAddress();
        usdt     = IERC20(_usdt);
        reserve  = ZeusReserveV2(_reserve);
        registry = WatcherRegistry(_registry);
    }

    // ── Buy cover ─────────────────────────────────────────────────────────────
    /// @param validatorKey keccak256(validator pubkey)
    /// @param stakedAmount declared stake (token decimals)
    /// @param termSeconds  [1 days .. 365 days]
    /// @param premium      quoted off-chain by the pricing engine
    function buyCover(
        bytes32 validatorKey,
        uint256 stakedAmount,
        uint256 termSeconds,
        uint256 premium
    ) external nonReentrant whenNotPaused returns (uint256 positionId) {
        if (validatorKey == bytes32(0)) revert InvalidValidatorKey();
        if (stakedAmount == 0) revert InvalidAmount();
        if (termSeconds < MIN_TERM || termSeconds > MAX_TERM) revert InvalidTerm();
        if (premium == 0 || premium > stakedAmount) revert InvalidPremium();

        usdt.safeTransferFrom(msg.sender, address(reserve), premium);

        positionId = nextPositionId++;
        positions[positionId] = StakePosition({
            validatorKey:  validatorKey,
            owner:         msg.sender,
            stakedAmount:  stakedAmount,
            coveredAmount: stakedAmount,
            premium:       premium,
            start:         block.timestamp,
            expiry:        block.timestamp + termSeconds,
            status:        PositionStatus.Active
        });

        emit CoverBought(positionId, validatorKey, msg.sender, stakedAmount, premium, block.timestamp + termSeconds);
    }

    // ── Claim ─────────────────────────────────────────────────────────────────
    function eventIdFor(uint256 positionId) public pure returns (bytes32) {
        return keccak256(abi.encode(positionId));
    }

    function claimSlashing(uint256 positionId) external nonReentrant whenNotPaused {
        StakePosition storage p = positions[positionId];
        if (p.owner == address(0)) revert PositionDoesNotExist();
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.status != PositionStatus.Active) revert PositionNotActive();
        if (block.timestamp > p.expiry) revert CoverageExpired();
        if (!registry.isConfirmed(eventIdFor(positionId), 1)) revert SlashingNotConfirmed();

        p.status = PositionStatus.Claimed;
        // Reserve calls back isClaimApproved(), pays, then markClaimFulfilled()
        reserve.payClaim(positionId, p.owner, p.coveredAmount);
        emit SlashingClaimed(positionId, p.coveredAmount);
    }

    function expirePosition(uint256 positionId) external {
        StakePosition storage p = positions[positionId];
        if (p.status != PositionStatus.Active) revert PositionNotActive();
        if (block.timestamp <= p.expiry) revert NotExpiredYet();
        p.status = PositionStatus.Expired;
        emit CoverExpired(positionId);
    }

    // ── IInsuranceContract (for the dedicated reserve) ────────────────────────
    function isClaimApproved(
        uint256 claimId, address claimant, uint256 amount
    ) external view override returns (bool) {
        StakePosition storage p = positions[claimId];
        return p.status == PositionStatus.Claimed
            && p.owner == claimant
            && p.coveredAmount == amount
            && registry.isConfirmed(eventIdFor(claimId), 1);
    }

    function markClaimFulfilled(uint256 claimId) external override {
        if (msg.sender != address(reserve)) revert OnlyReserveCanCall();
        claimFulfilled[claimId] = true;
    }

    // ── Views ─────────────────────────────────────────────────────────────────
    function getPosition(uint256 positionId) external view returns (StakePosition memory) {
        return positions[positionId];
    }

    function canClaim(uint256 positionId) external view returns (bool) {
        StakePosition storage p = positions[positionId];
        return p.status == PositionStatus.Active
            && block.timestamp <= p.expiry
            && registry.isConfirmed(eventIdFor(positionId), 1);
    }

    // ── Owner ─────────────────────────────────────────────────────────────────
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
