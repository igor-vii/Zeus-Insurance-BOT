// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./ZeusReserveV2.sol";
import "./interfaces/IInsuranceContract.sol";

/**
 * @title ZeusInsuranceV2
 * @notice Decentralized insurance for AI agents and validators.
 * 
 * @dev Version 2.4 — FINAL
 * 
 * CRITICAL FIXES APPLIED:
 * 1. requestId теперь включает policyId — устранена коллизия
 * 2. Подпись включает policyId — невозможен replay между полисами
 * 3. reportSlashing требует кворум (2+ голоса) с on-chain голосованием
 * 4. policyCoverageMask удалён (мёртвый код)
 * 5. hasPendingClaims() — O(1) через activePolicyCount
 * 6. Валидация premium (0 < premium <= amount)
 * 7. Валидация evidenceHash (не может быть 0)
 * 8. Защита renounceOwnership — недоступна
 * 9. Все evidenceHash сохраняются для полного аудита
 * 10. СТАВКИ УБРАНЫ ИЗ КОНТРАКТА — premium передаётся из API (гибкая ставка)
 */
contract ZeusInsuranceV2 is IInsuranceContract, ReentrancyGuard, Ownable, Pausable {
    using ECDSA for bytes32;

    // ── Custom Errors ──────────────────────────────────────────────────────────

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
    error NativePaymentNotAccepted();
    error SlashingQuorumNotReached();
    error AlreadyVotedSlashing();
    error InvalidPremium();
    error InvalidEvidenceHash();
    error CannotRenounceOwnership();
    error InvalidPaymentHash();
    error DeliveryAlreadyConfirmed();

    // ── Enums ─────────────────────────────────────────────────────────────────

    enum PolicyStatus { Active, Claimed, Rejected, Expired }
    enum CoverageType { Standard, SlashingProtection }

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Policy {
        address buyer;
        address seller;
        uint256 amount;
        uint256 premium;
        uint256 retryDeadline;
        uint256 maxRetries;
        PolicyStatus status;
        CoverageType coverageType;
        bytes32 paymentHash;
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
    uint256                       public activePolicyCount; // O(1) для hasPendingClaims

    address[]                     public watcherList;
    mapping(address => bool)      public isWatcher;

    // ── Slashing кворум ─────────────────────────────────────────────────────

    mapping(uint256 => mapping(address => bool)) public slashingVotes;
    mapping(uint256 => uint256) public slashingVoteCount;
    mapping(uint256 => bool) public slashingResolved;
    mapping(uint256 => bytes32[]) public slashingEvidenceHashes; // все evidenceHash для аудита
    uint256 public constant SLASHING_QUORUM = 2;

    mapping(bytes32 => VoteTally)             public  pendingVotes;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => bool)                  public  usedRequestIds;
    mapping(uint256 => bytes32)               public  policyToRequestId;

    // ── Events ────────────────────────────────────────────────────────────────

    event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline, CoverageType coverageType);
    event PayoutExecuted(uint256 indexed policyId, uint256 amount);
    event PolicyExpired(uint256 indexed policyId);
    event WatcherAdded(address indexed watcher);
    event WatcherRemoved(address indexed watcher);
    event SlashingReported(uint256 indexed policyId, address indexed validator, bytes32 indexed evidenceHash);
    event ObservationSubmitted(bytes32 indexed requestId, address indexed watcher, uint8 status);
    event VoteResolved(bytes32 indexed requestId, uint8 decision, uint256 indexed policyId);
    event ClaimRejected(uint256 indexed policyId);
    event SlashingVoteCast(uint256 indexed policyId, address indexed watcher);
    event SlashingResolved(uint256 indexed policyId, bool approved);
    event DeliveryConfirmed(uint256 indexed policyId, address indexed buyer, bytes32 indexed paymentHash, uint256 timestamp);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _usdt, address _reserve) Ownable(msg.sender) {
        if (_usdt == address(0)) revert InvalidUSDTAddress();
        if (_reserve == address(0)) revert InvalidReserveAddress();
        usdt    = IERC20(_usdt);
        reserve = ZeusReserveV2(_reserve);
    }

    // ─── Защита renounceOwnership ─────────────────────────────────────────────

    function renounceOwnership() public override onlyOwner {
        revert CannotRenounceOwnership();
    }

    // ─── Internal Buy Logic ───────────────────────────────────────────────────

    function _buyInternal(
        address buyer,
        address seller,
        uint256 amount,
        uint256 timeoutSeconds,
        uint256 maxRetries,
        uint256 premium,
        CoverageType coverageType
    ) internal returns (uint256 policyId) {
        if (seller == address(0)) revert InvalidSeller();
        if (amount == 0) revert InvalidAmount();
        if (maxRetries == 0 || maxRetries > 10) revert InvalidRetries();
        if (timeoutSeconds == 0) revert InvalidTimeout();
        if (msg.value > 0) revert NativePaymentNotAccepted();
        if (premium == 0 || premium > amount) revert InvalidPremium();

        if (!usdt.transferFrom(buyer, address(reserve), premium)) revert PremiumTransferFailed();

        uint256 retryDeadline = block.timestamp + timeoutSeconds * maxRetries;

        policyId = nextPolicyId;
        policies[policyId] = Policy({
            buyer:         buyer,
            seller:        seller,
            amount:        amount,
            premium:       premium,
            retryDeadline: retryDeadline,
            maxRetries:    maxRetries,
            status:        PolicyStatus.Active,
            coverageType:  coverageType,
            paymentHash:   bytes32(0)
        });

        activePolicyCount++;
        emit PolicyCreated(policyId, buyer, seller, amount, premium, retryDeadline, coverageType);
        nextPolicyId++;
    }

    // ─── Policy Management ────────────────────────────────────────────────────

    function buyPolicy(
        address seller,
        uint256 amount,
        uint256 timeoutSeconds,
        uint256 maxRetries,
        uint256 premium
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _buyInternal(msg.sender, seller, amount, timeoutSeconds, maxRetries, premium, CoverageType.Standard);
    }

    function buyAllInclusivePolicy(
        address seller,
        uint256 amount,
        uint256 timeoutSeconds,
        uint256 maxRetries,
        uint256 premium
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _buyInternal(msg.sender, seller, amount, timeoutSeconds, maxRetries, premium, CoverageType.Standard);
    }

    function buySlashingProtection(
        address validator,
        uint256 amount,
        uint256 timeoutSeconds,
        uint256 premium
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _buyInternal(
            msg.sender,
            validator,
            amount,
            timeoutSeconds,
            1,
            premium,
            CoverageType.SlashingProtection
        );
    }

    // ─── Claims ────────────────────────────────────────────────────────────────

    function claimPayout(uint256 policyId) external nonReentrant whenNotPaused {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.buyer != msg.sender) revert OnlyBuyerCanClaim();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp < p.retryDeadline) revert TimeoutNotReached();

        p.status = PolicyStatus.Claimed;
        activePolicyCount--;
        reserve.payClaim(policyId, p.buyer, p.amount);
        emit PayoutExecuted(policyId, p.amount);
    }

    // ─── Slashing с кворумом ─────────────────────────────────────────────────

    function reportSlashing(uint256 policyId, bytes32 evidenceHash) external nonReentrant whenNotPaused {
        if (!isWatcher[msg.sender]) revert NotWatcher();

        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (p.coverageType != CoverageType.SlashingProtection) revert NotASlashingPolicy();
        if (slashingResolved[policyId]) revert VoteAlreadyResolved();
        if (slashingVotes[policyId][msg.sender]) revert AlreadyVotedSlashing();
        if (evidenceHash == 0) revert InvalidEvidenceHash();

        slashingEvidenceHashes[policyId].push(evidenceHash);

        slashingVotes[policyId][msg.sender] = true;
        slashingVoteCount[policyId]++;
        emit SlashingVoteCast(policyId, msg.sender);

        if (slashingVoteCount[policyId] >= SLASHING_QUORUM) {
            slashingResolved[policyId] = true;
            
            address validator = p.seller;
            address buyer = p.buyer;
            uint256 amount = p.amount;

            p.status = PolicyStatus.Claimed;
            activePolicyCount--;
            emit SlashingReported(policyId, validator, evidenceHash);
            emit SlashingResolved(policyId, true);

            reserve.payClaim(policyId, buyer, amount);
            emit PayoutExecuted(policyId, amount);
        }
    }

    // ─── IInsuranceContract ──────────────────────────────────────────────────

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

    // ─── O(1) hasPendingClaims() ─────────────────────────────────────────────

    function hasPendingClaims() external view returns (bool) {
        return activePolicyCount > 0;
    }

    // ─── Watcher Management ──────────────────────────────────────────────────

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

    // ─── Oracle Observations ──────────────────────────────────────────────────

    function submitObservation(uint256 policyId, Observation calldata obs) external whenNotPaused {
        if (usedRequestIds[obs.requestId]) revert RequestAlreadyResolved();
        if (block.timestamp < obs.timestamp - 120 || block.timestamp > obs.timestamp + 120) revert TimestampOutOfWindow();

        address signer = _verifyObservation(policyId, obs);
        if (!isWatcher[signer]) revert InvalidWatcherSignature();
        if (hasVoted[obs.requestId][signer]) revert WatcherAlreadyVoted();

        Policy storage policy = policies[policyId];
        if (policy.buyer == address(0)) revert PolicyDoesNotExist();
        if (policy.status != PolicyStatus.Active) revert PolicyNotActive();

        bytes32 expectedId = keccak256(abi.encodePacked(policy.buyer, policy.seller, policyId, obs.timestamp));
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

    // ─── Views ─────────────────────────────────────────────────────────────────

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function getCoverageType(uint256 policyId) external view returns (CoverageType) {
        return policies[policyId].coverageType;
    }

    function getSlashingEvidenceHashes(uint256 policyId) external view returns (bytes32[] memory) {
        return slashingEvidenceHashes[policyId];
    }

    function canClaim(uint256 policyId) external view returns (bool) {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) return false;
        if (p.status != PolicyStatus.Active) return false;
        if (block.timestamp < p.retryDeadline) return false;
        if (usdt.balanceOf(address(reserve)) < p.amount) return false;
        return true;
    }

    function canSlash(uint256 policyId) external view returns (bool) {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) return false;
        if (p.status != PolicyStatus.Active) return false;
        if (p.coverageType != CoverageType.SlashingProtection) return false;
        if (slashingResolved[policyId]) return false;
        return true;
    }

    // ─── Owner Configuration ──────────────────────────────────────────────────

    function getActivePoliciesCount() external view returns (uint256) {
        return activePolicyCount;
    }

    function setReserve(address _reserve) external onlyOwner {
        require(activePolicyCount == 0, "Active policies exist");
        if (_reserve == address(0)) revert InvalidReserveAddress();
        reserve = ZeusReserveV2(_reserve);
    }

    function setUsdt(address _usdt) external onlyOwner {
        require(activePolicyCount == 0, "Active policies exist");
        if (_usdt == address(0)) revert InvalidUSDTAddress();
        usdt = IERC20(_usdt);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    function _verifyObservation(uint256 policyId, Observation calldata obs) internal pure returns (address) {
        bytes32 msgHash = keccak256(abi.encodePacked(
            obs.requestId,
            policyId,
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
        p.status = PolicyStatus.Claimed;
        activePolicyCount--;
        reserve.payClaim(policyId, p.buyer, p.amount);
        emit PayoutExecuted(policyId, p.amount);
    }

    function _rejectClaim(uint256 policyId) internal {
        Policy storage p = policies[policyId];
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        p.status = PolicyStatus.Rejected;
        activePolicyCount--;
        emit ClaimRejected(policyId);
    }

    // ─── Delivery Confirmation ──────────────────────────────────────────────

    function confirmDelivery(uint256 policyId, bytes32 paymentHash) external nonReentrant whenNotPaused {
        Policy storage p = policies[policyId];
        
        // Guards
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.buyer != msg.sender) revert OnlyBuyerCanClaim();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (paymentHash == bytes32(0)) revert InvalidPaymentHash();
        if (p.paymentHash != bytes32(0)) revert DeliveryAlreadyConfirmed();
        
        p.paymentHash = paymentHash;
        p.status = PolicyStatus.Claimed;
        activePolicyCount--;
        
        emit DeliveryConfirmed(policyId, p.buyer, paymentHash, block.timestamp);
    }
}
