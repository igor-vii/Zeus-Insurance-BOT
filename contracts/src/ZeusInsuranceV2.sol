// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./ZeusReserveV2.sol";
import "./interfaces/IInsuranceContract.sol";

/**
 * @title ZeusInsuranceV2
 * @notice Insurance contract that issues policies, collects USDT premiums into the
 *         reserve, and settles claims in two ways:
 *
 *         1. Timeout-based (buyer calls claimPayout after retryDeadline).
 *         2. Oracle-based (a quorum of registered watchers submit signed
 *            observations; the contract resolves the vote automatically).
 */
contract ZeusInsuranceV2 is IInsuranceContract, ReentrancyGuard, Ownable {

    // ── Custom Errors (Gas optimization) ──────────────────────────────────────

    error InvalidUSDTAddress();
    error InvalidReserveAddress();
    error ZeroAddress();
    error InvalidSeller();
    error InvalidValidator();
    error InvalidAmount();
    error InvalidTimeout();
    error InvalidRetries();
    error PremiumTransferFailed();
    error NotWatcher();
    error PolicyDoesNotExist();
    error PolicyNotActive();
    error NotASlashingPolicy();
    error OnlyBuyerCanClaim();
    error TimeoutNotReached();
    error OnlyReserveCanCall();
    error AlreadyWatcher();
    error RequestAlreadyResolved();
    error TimestampOutOfWindow();
    error InvalidWatcherSignature();
    error WatcherAlreadyVoted();
    error InvalidRequestId();
    error PolicyIdMismatch();
    error VoteAlreadyResolved();

    // ── Enums ─────────────────────────────────────────────────────────────────

    enum PolicyStatus { Active, Claimed, Rejected, Expired }
    enum CoverageType { Standard, SlashingProtection }

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Policy {
        address buyer;
        address seller;
        uint256 amount;         // Coverage amount in USDT (6-decimal units)
        uint256 premium;        // Premium paid in USDT (6-decimal units)
        uint256 retryDeadline;  // Unix timestamp after which claimPayout is valid
        uint256 maxRetries;
        PolicyStatus status;
    }

    struct Observation {
        bytes32 requestId;
        uint256 timestamp;
        uint8   status;
        bytes32 metadataHash;
        uint256 nonce;
        bytes   signature;
    }

    struct VoteTally {
        uint256 policyId;
        uint8[] statuses;
        bool    resolved;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20       public usdt;
    ZeusReserveV2 public reserve;

    mapping(uint256 => Policy)    public policies;
    uint256                       public nextPolicyId;

    address[]                     public watcherList;
    mapping(address => bool)      public isWatcher;

    mapping(uint256 => CoverageType)          public  policyCoverageType;

    uint256 public constant SLASHING_PREMIUM_BPS = 500;

    /// @notice Bitmask representing all coverage types simultaneously.
    uint256 public constant ALL_INCLUSIVE_MASK = type(uint256).max;

    // Coverage mask per policy (bitmask of covered risk types)
    mapping(uint256 => uint256)               public  policyCoverageMask;

    mapping(bytes32 => VoteTally)             public  pendingVotes;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => bool)                  public  usedRequestIds;
    mapping(uint256 => bytes32)               public  policyToRequestId;

    // ── Events ────────────────────────────────────────────────────────────────

    event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline);
    event PayoutExecuted(uint256 indexed policyId, uint256 amount);
    event PolicyExpired(uint256 indexed policyId);
    event WatcherAdded(address indexed watcher);
    event WatcherRemoved(address indexed watcher);
    event SlashingReported(uint256 indexed policyId, address indexed validator, bytes32 indexed evidenceHash);
    event ObservationSubmitted(bytes32 indexed requestId, address indexed watcher, uint8 status);
    event VoteResolved(bytes32 indexed requestId, uint8 decision, uint256 indexed policyId);
    event ClaimRejected(uint256 indexed policyId);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _usdt, address _reserve) Ownable(msg.sender) {
        if (_usdt == address(0)) revert InvalidUSDTAddress();
        if (_reserve == address(0)) revert InvalidReserveAddress();
        usdt    = IERC20(_usdt);
        reserve = ZeusReserveV2(_reserve);
    }

    // ── Policy management ─────────────────────────────────────────────────────

    function buyInsurance(
        address seller,
        uint256 amount,
        uint256 timeoutSeconds,
        uint256 maxRetries
    ) external nonReentrant returns (uint256) {
        if (seller == address(0)) revert InvalidSeller();
        if (amount == 0) revert InvalidAmount();
        if (maxRetries == 0 || maxRetries > 10) revert InvalidRetries();
        if (timeoutSeconds == 0) revert InvalidTimeout();

        uint256 premiumBps    = 700 + (maxRetries - 1) * 200;
        uint256 premium       = (amount * premiumBps) / 10_000;
        uint256 retryDeadline = block.timestamp + timeoutSeconds * maxRetries;

        if (!usdt.transferFrom(msg.sender, address(reserve), premium)) revert PremiumTransferFailed();

        uint256 policyId = nextPolicyId;
        policies[policyId] = Policy({
            buyer:         msg.sender,
            seller:        seller,
            amount:        amount,
            premium:       premium,
            retryDeadline: retryDeadline,
            maxRetries:    maxRetries,
            status:        PolicyStatus.Active
        });

        emit PolicyCreated(policyId, msg.sender, seller, amount, premium, retryDeadline);
        nextPolicyId++;
        return policyId;
    }

    function buyPolicy(
        address seller,
        uint256 amount,
        uint256 coverageMask,
        uint256 timeoutSeconds,
        string calldata metadata
    ) external nonReentrant returns (uint256) {
        require(coverageMask != 0, "Coverage mask must not be zero");
        return _buyInternal(msg.sender, seller, amount, coverageMask, timeoutSeconds, metadata);
    }

    function buyAllInclusivePolicy(
        address seller,
        uint256 amount,
        uint256 timeoutSeconds,
        string calldata metadata
    ) external nonReentrant returns (uint256) {
        return _buyInternal(msg.sender, seller, amount, ALL_INCLUSIVE_MASK, timeoutSeconds, metadata);
    }

    function buySlashingProtection(
        address validator,
        uint256 amount,
        uint256 timeoutSeconds
    ) external nonReentrant {
        if (validator == address(0)) revert InvalidValidator();
        if (amount == 0) revert InvalidAmount();
        if (timeoutSeconds == 0) revert InvalidTimeout();

        uint256 premium       = (amount * SLASHING_PREMIUM_BPS) / 10_000;
        uint256 retryDeadline = block.timestamp + timeoutSeconds;

        if (!usdt.transferFrom(msg.sender, address(reserve), premium)) revert PremiumTransferFailed();

        policies[nextPolicyId] = Policy({
            buyer:         msg.sender,
            seller:        validator,
            amount:        amount,
            premium:       premium,
            retryDeadline: retryDeadline,
            maxRetries:    1,
            status:        PolicyStatus.Active
        });
        policyCoverageType[nextPolicyId] = CoverageType.SlashingProtection;

        emit PolicyCreated(nextPolicyId, msg.sender, validator, amount, premium, retryDeadline);
        nextPolicyId++;
    }

    function reportSlashing(
        uint256 policyId,
        bytes32 evidenceHash
    ) external nonReentrant {
        if (!isWatcher[msg.sender]) revert NotWatcher();
        
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (policyCoverageType[policyId] != CoverageType.SlashingProtection) revert NotASlashingPolicy();

        address validator   = p.seller;
        uint256 payoutAmount = p.amount;
        address buyer        = p.buyer;

        p.status = PolicyStatus.Claimed; // CEI

        emit SlashingReported(policyId, validator, evidenceHash);
        reserve.payClaim(policyId, buyer, payoutAmount);
        emit PayoutExecuted(policyId, payoutAmount);
    }

    function claimPayout(uint256 policyId) external nonReentrant {
        Policy storage p = policies[policyId];
        if (p.buyer != msg.sender) revert OnlyBuyerCanClaim();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp < p.retryDeadline) revert TimeoutNotReached();

        uint256 payoutAmount = p.amount;
        address claimant     = p.buyer;

        p.status = PolicyStatus.Claimed; // CEI

        reserve.payClaim(policyId, claimant, payoutAmount);

        emit PayoutExecuted(policyId, payoutAmount);
    }

    // ── IInsuranceContract — callbacks from ZeusReserveV2 ────────────────────

    function isClaimApproved(
        uint256 claimId,
        address claimant,
        uint256 amount
    ) external view override returns (bool) {
        Policy storage p = policies[claimId];
        return p.status == PolicyStatus.Claimed
            && p.buyer  == claimant
            && p.amount == amount;
    }

    function markClaimFulfilled(uint256 claimId) external override {
        if (msg.sender != address(reserve)) revert OnlyReserveCanCall();
        Policy storage p = policies[claimId];
        emit ClaimApproved(claimId, p.buyer, p.amount);
    }

    // ── Watcher management ────────────────────────────────────────────────────

    function addWatcher(address watcher) external onlyOwner {
        if (watcher == address(0)) revert ZeroAddress();
        if (isWatcher[watcher]) revert AlreadyWatcher();
        
        isWatcher[watcher] = true;
        watcherList.push(watcher);
        emit WatcherAdded(watcher);
    }

    function removeWatcher(address watcher) external onlyOwner {
        if (!isWatcher[watcher]) revert NotWatcher();
        isWatcher[watcher] = false;
        emit WatcherRemoved(watcher);
    }

    function getWatchers() external view returns (address[] memory) {
        return watcherList;
    }

    function renounceOwnership() public override onlyOwner {
        revert("Cannot renounce ownership");
    }

    // ── Oracle observations ───────────────────────────────────────────────────

    function submitObservation(uint256 policyId, Observation calldata obs) external {
        if (usedRequestIds[obs.requestId]) revert RequestAlreadyResolved();
        if (block.timestamp < obs.timestamp - 120 || block.timestamp > obs.timestamp + 120) revert TimestampOutOfWindow();

        address signer = _verifyObservation(obs);
        if (!isWatcher[signer]) revert InvalidWatcherSignature();
        if (hasVoted[obs.requestId][signer]) revert WatcherAlreadyVoted();

        Policy storage policy = policies[policyId];
        if (policy.buyer == address(0)) revert PolicyDoesNotExist();
        if (policy.status != PolicyStatus.Active) revert PolicyNotActive();

        bytes32 expectedId = keccak256(
            abi.encodePacked(policy.buyer, policy.seller, obs.timestamp)
        );
        if (obs.requestId != expectedId) revert InvalidRequestId();

        VoteTally storage vote = pendingVotes[obs.requestId];
        if (vote.policyId == 0) {
            vote.policyId = policyId;
            policyToRequestId[policyId] = obs.requestId;
        } else {
            if (vote.policyId != policyId) revert PolicyIdMismatch();
        }

        hasVoted[obs.requestId][signer] = true;
        vote.statuses.push(obs.status);

        emit ObservationSubmitted(obs.requestId, signer, obs.status);

        if (vote.statuses.length >= 3) {
            _resolveVote(obs.requestId);
        }
    }

    // ── Owner configuration ───────────────────────────────────────────────────

    function setReserve(address _reserve) external onlyOwner {
        if (_reserve == address(0)) revert InvalidReserveAddress();
        reserve = ZeusReserveV2(_reserve);
    }

    function setUsdt(address _usdt) external onlyOwner {
        if (_usdt == address(0)) revert InvalidUSDTAddress();
        usdt = IERC20(_usdt);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function getCoverageType(uint256 policyId) external view returns (CoverageType) {
        return policyCoverageType[policyId];
    }

    function canClaim(uint256 policyId) external view returns (bool) {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) return false; 
        if (p.status != PolicyStatus.Active) return false; 
        if (block.timestamp < p.retryDeadline) return false; 
        if (usdt.balanceOf(address(reserve)) < p.amount) return false; 
        return true;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _buyInternal(
        address buyer,
        address seller,
        uint256 amount,
        uint256 coverageMask,
        uint256 timeoutSeconds,
        string calldata metadata
    ) internal returns (uint256 policyId) {
        if (seller == address(0)) revert InvalidSeller();
        if (amount == 0) revert InvalidAmount();
        if (timeoutSeconds == 0) revert InvalidTimeout();

        uint256 premium       = (amount * 700) / 10_000; // 7 % base rate
        uint256 retryDeadline = block.timestamp + timeoutSeconds;

        if (!usdt.transferFrom(buyer, address(reserve), premium)) revert PremiumTransferFailed();

        policyId = nextPolicyId;
        policies[policyId] = Policy({
            buyer:         buyer,
            seller:        seller,
            amount:        amount,
            premium:       premium,
            retryDeadline: retryDeadline,
            maxRetries:    1,
            status:        PolicyStatus.Active
        });

        policyCoverageMask[policyId] = coverageMask;

        emit PolicyCreated(policyId, buyer, seller, amount, premium, retryDeadline);
        nextPolicyId++;

        // metadata not stored on-chain; suppress unused-variable warning
        metadata;
    }

    function _verifyObservation(Observation calldata obs) internal pure returns (address) {
        bytes32 msgHash = keccak256(abi.encodePacked(
            obs.requestId,
            obs.timestamp,
            obs.status,
            obs.metadataHash,
            obs.nonce
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
        return ECDSA.recover(ethHash, obs.signature);
    }

    function _resolveVote(bytes32 requestId) internal {
        VoteTally storage vote = pendingVotes[requestId];
        if (vote.resolved) revert VoteAlreadyResolved();

        usedRequestIds[requestId] = true;
        vote.resolved = true;

        uint256 timeoutCount = 0;
        for (uint256 i = 0; i < vote.statuses.length; i++) {
            if (vote.statuses[i] == 1) timeoutCount++;
        }

        if (timeoutCount >= 2) {
            emit VoteResolved(requestId, 1, vote.policyId);
            _triggerOraclePayout(vote.policyId);
        } else {
            emit VoteResolved(requestId, 0, vote.policyId);
            _rejectClaim(vote.policyId);
        }
    }

    function _triggerOraclePayout(uint256 policyId) internal {
        Policy storage p = policies[policyId];
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();

        uint256 amount  = p.amount;
        address buyer   = p.buyer;

        p.status = PolicyStatus.Claimed; // CEI

        reserve.payClaim(policyId, buyer, amount);

        emit PayoutExecuted(policyId, amount);
    }

    function _rejectClaim(uint256 policyId) internal {
        Policy storage p = policies[policyId];
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        p.status = PolicyStatus.Rejected;
        emit ClaimRejected(policyId);
    }
}
